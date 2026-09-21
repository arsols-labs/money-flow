// «Пульс» — главный экран v2: net worth, прогноз, ближайшие платежи, счета.
// Порт app/src/ui/Pulse.jsx на контракт /api/v2/forecast (issue #198): сервер
// уже отдаёт суммы в базовой валюте (overall_minor, by_country, *_base_minor),
// поэтому в отличие от v1 клиенту не нужно самому пересчитывать по курсам —
// только minor→major для отображения (см. forecast.js).
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceDot, ReferenceLine,
} from 'recharts';
import { AlertTriangle, DatabaseZap, SlidersHorizontal, RotateCcw } from 'lucide-react';
import { api } from './api';
import { selectPayments, paymentDateLabel, paymentRefreshDue, paymentColors, paymentDateColor } from './payments';
import { useRefreshNonce } from './RefreshContext';
import { SectionSkeleton,  MetricCard, CardGrid, CollapsibleSection, FxFooter  } from './components';
import { formatMinor, formatMajor, formatMajorCompact } from './money';
import {
  chartData,
  parseDateOnly,
  resolveForecastGroupMode,
  forecastHasMultiUserSeries,
  forecastSeriesItems,
  forecastYDomain,
  accountsWithForecastSeries,
} from './forecast';
import { balanceColor, relativeColor, moneyScaleColor, emphasis } from './palette';
import {
  WARNING_LIMIT, warningSelection, warningSeverity, warningState, warningRatio,
} from './warnings';
import {
  loadDashboardConfig,
  saveDashboardConfig,
  resetDashboardConfig,
  loadPulseFilters,
  savePulseFilters,
  resetPulseFilters,
  resolveBlockColumn,
  DEFAULT_PULSE_FILTERS,
} from './dashboardLayout';
import DashboardSettingsModal from './DashboardSettingsModal';
import i18n from './i18n';
import { intlLocale } from './language';

// chartData() отдаёт точки уже в МАЙОРНЫХ единицах (toMajor из forecast.js).
// Подписи оси и min-маркер — formatMajorCompact: группировка тысяч обязательна,
// центы можно опустить. Нельзя срезать дробь regex'ом `[.,]\d+` — в en-US это
// съедает разряд тысяч (`$17,521.60` → `$17.60`, issue #582).

const FORECAST_PERIODS = [
  { key: 'month', days: 30 },
  { key: 'quarter', days: 90 },
  { key: 'half', days: 180 },
  { key: 'year', days: 365 },
];

const FORECAST_PERIOD_LABEL_KEYS = {
  month: 'period.month',
  quarter: 'period.quarter',
  half: 'period.halfYear',
  year: 'period.year',
};

/**
 * Единый взаимоисключающий выбор для «Пульса».
 *
 * Варианты остаются видимыми, а на узком экране прокручивается только эта
 * полоса. `aria-pressed` дублирует активную подложку для скринридера; обычные
 * кнопки сохраняют нативную клавиатурную активацию Enter/Space.
 */
export function PulseSegmentedControl({ options, value, onChange, ariaLabel, disabled = false, className = '' }) {
  useTranslation();
  return (
    <div className={`pulse-segmented-scroller ${className}`.trim()}>
      <div className="group-toggle pulse-segmented" role="group" aria-label={ariaLabel}>
        {options.map((option) => {
          const active = option.key === value;
          return (
            <button
              key={option.key}
              type="button"
              className={active ? 'active' : ''}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(option.key)}
            >
              <span>{option.label}</span>
              {option.count !== undefined && (
                <span className="pulse-segmented-count">{option.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Принимает и "YYYY-MM-DD" (даты контракта), и числовой ts из chartData()
// (уже посчитан через parseDateOnly, повторно прогонять через него нельзя —
// нативный конструктор Date от числа миллисекунд ничего не сдвигает).
//
// Год дописывается, когда он не текущий, и это не украшательство: горизонт
// прогноза — 365 дней, поэтому «минимум 12 авг.» сплошь и рядом означает 12
// августа СЛЕДУЮЩЕГО года, а выглядит как сегодня. Ровно на этом владелец и
// споткнулся: строка «уже в минусе · минимум -59,78 $ 12 авг.» на счёте, где
// сегодня -0,38 $, читалась как ошибка расчёта, хотя это верная сумма через
// двенадцать месяцев (issue #256). Условие «не текущий год» — то же, что уже
// применяет formatRelativeDate в money.js.
function shortDate(value) {
  const d = typeof value === 'string' ? parseDateOnly(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return i18n.t('common.unavailablePlaceholder');
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(intlLocale(i18n.resolvedLanguage || i18n.language), opts);
}

function ForecastTooltip({ active, payload, label, baseCurrency, seriesItems }) {
  const { t, i18n: i18nLang } = useTranslation();
  if (!active || !payload || !payload.length) return null;
  const dateLabel = new Date(label).toLocaleDateString(intlLocale(i18nLang.resolvedLanguage || i18nLang.language), { day: 'numeric', month: 'long', year: 'numeric' });
  const labels = {
    overall: t('pulse.forecast.legendTotal'),
    ...Object.fromEntries(seriesItems.map((item) => [item.key, item.label])),
  };
  const order = ['overall', ...seriesItems.map((item) => item.key)];
  const sorted = [...payload].sort((a, b) => order.indexOf(a.dataKey) - order.indexOf(b.dataKey));
  return (
    <div className="chart-tooltip">
      <div className="tooltip-date">{dateLabel}</div>
      {sorted.map((p) => (
        <div key={p.dataKey} className="tooltip-row">
          <span className="dot" style={{ background: p.color }} />
          <span className="tooltip-label">{labels[p.dataKey] ?? p.dataKey}</span>
          <span className="tooltip-value">{formatMajor(p.value, baseCurrency)}</span>
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ seriesItems }) {
  const { t } = useTranslation();
  return (
    <div className="chart-legend">
      <span><i className="dot" style={{ background: 'var(--overall)' }} /> {t('pulse.forecast.legendTotal')}</span>
      {seriesItems.map((item) => (
        <span key={item.key}><i className="dot" style={{ background: item.color }} /> {item.label}</span>
      ))}
    </div>
  );
}

function ForecastChart({ data, baseCurrency, seriesItems }) {
  const { t } = useTranslation();
  const lowest = useMemo(
    () => (data.length ? data.reduce((m, d) => (d.overall < m.overall ? d : m), data[0]) : null),
    [data],
  );
  const extraKeys = useMemo(() => seriesItems.map((item) => item.key), [seriesItems]);
  const yDomain = useMemo(() => forecastYDomain(data, extraKeys), [data, extraKeys]);
  return (
    <div>
      <div className="chart-box">
        <ResponsiveContainer>
          {/* left: 0, а не −20 как в v1: там подпись оси — узкая «$7,500»
              (en-US, символ слева), у нас — «7 500 $» в ru-RU, символ справа и
              неразрывный пробел в разрядах. Отрицательный отступ вместе с
              width: 62 срезал у неё первый знак. Правое поле — под ПОСЛЕДНЮЮ
              подпись оси X: на периоде «Год» она содержит год («12 авг. 2027 г.»,
              issue #256) и при отступе 8 упиралась в край. */}
          <ComposedChart data={data} margin={{ top: 12, right: 48, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="overallFillV2" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--overall)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--overall)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time"
              tickFormatter={(ts) => shortDate(ts)} stroke="var(--text-muted)" fontSize={11}
              tickLine={false} axisLine={false} minTickGap={32}
            />
            <YAxis
              stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false}
              tickFormatter={(v) => formatMajorCompact(v, baseCurrency)}
              width={78}
              domain={yDomain}
            />
            <Tooltip content={<ForecastTooltip baseCurrency={baseCurrency} seriesItems={seriesItems} />} />
            <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="3 3" />
            <Area type="monotone" dataKey="overall" stroke="var(--overall)" fill="url(#overallFillV2)" strokeWidth={2.25} dot={false} isAnimationActive={false} />
            {seriesItems.map((item) => (
              <Line key={item.key} type="monotone" dataKey={item.key} stroke={item.color} strokeWidth={1.75} dot={false} isAnimationActive={false} />
            ))}
            {lowest && (
              <ReferenceDot
                x={lowest.ts} y={lowest.overall} r={5} fill="var(--danger)" stroke="var(--bg-card)" strokeWidth={2}
                label={{ value: t('pulse.forecast.chartMin', { amount: formatMajorCompact(lowest.overall, baseCurrency), date: shortDate(lowest.date) }), position: 'top', fill: 'var(--danger)', fontSize: 11 }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend seriesItems={seriesItems} />
    </div>
  );
}

function ForecastSection({
  fullSeries,
  rawSeries,
  baseCurrency,
  countries,
  accounts = [],
  owners = [],
  period = 'month',
  onPeriodChange = undefined,
  groupMode = 'country',
  onGroupModeChange = undefined,
}) {
  const { t } = useTranslation();
  const [internalPeriod, setInternalPeriod] = useState('month');
  const [internalGroup, setInternalGroup] = useState('country');
  const actualPeriod = onPeriodChange ? period : internalPeriod;
  const handlePeriodChange = onPeriodChange || setInternalPeriod;
  const actualGroup = onGroupModeChange ? groupMode : internalGroup;
  const handleGroupChange = onGroupModeChange || setInternalGroup;

  const periodDef = FORECAST_PERIODS.find((p) => p.key === actualPeriod) || FORECAST_PERIODS[0];
  const forecastPeriodOptions = FORECAST_PERIODS.map((p) => ({
    ...p,
    label: t(FORECAST_PERIOD_LABEL_KEYS[p.key]),
  }));
  const chartAccounts = useMemo(
    () => accountsWithForecastSeries(accounts, rawSeries),
    [accounts, rawSeries],
  );
  const showUserGroup = forecastHasMultiUserSeries(owners);
  const resolvedGroup = resolveForecastGroupMode(actualGroup, { owners, accounts: chartAccounts });
  const seriesItems = useMemo(
    () => forecastSeriesItems(resolvedGroup, { countries, accounts: chartAccounts, owners }),
    [resolvedGroup, countries, chartAccounts, owners],
  );
  const groupOptions = [
    { key: 'country', label: t('pulse.forecast.groupCountry') },
    { key: 'account', label: t('pulse.forecast.groupAccount') },
    ...(showUserGroup ? [{ key: 'user', label: t('pulse.forecast.groupUser') }] : []),
  ];
  // Переключение периода режет уже загруженный ряд на клиенте — период не
  // перезапрашивает сервер (заведомо 365 дней загружены один раз).
  const sliced = useMemo(() => fullSeries.slice(0, periodDef.days), [fullSeries, periodDef]);
  const truncated = sliced.length < periodDef.days && sliced.length === fullSeries.length;

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-head-title-wrap">
          <h2 className="card-title">{t('pulse.forecast.title')}</h2>
          <span className="section-subtitle">{t('pulse.forecast.daysWithCurrency', { count: sliced.length, currency: baseCurrency })}</span>
        </div>
        <div className="card-head-actions">
          <PulseSegmentedControl
            options={forecastPeriodOptions}
            value={actualPeriod}
            onChange={handlePeriodChange}
            ariaLabel={t('pulse.forecast.periodAria')}
          />
          {actualPeriod !== 'month' && (
            <button
              type="button"
              className="filter-reset-icon-btn"
              onClick={() => handlePeriodChange('month')}
              title={t('pulse.forecast.resetPeriod')}
              aria-label={t('pulse.forecast.resetPeriod')}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="pulse-list-toolbar">
        <div className="pulse-list-control">
          <span className="pulse-list-control-label">{t('pulse.forecast.groupLabel')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PulseSegmentedControl
              options={groupOptions}
              value={resolvedGroup}
              onChange={handleGroupChange}
              ariaLabel={t('pulse.forecast.groupAria')}
            />
            {resolvedGroup !== 'country' && (
              <button
                type="button"
                className="filter-reset-icon-btn"
                onClick={() => handleGroupChange('country')}
                title={t('pulse.forecast.resetGroup')}
                aria-label={t('pulse.forecast.resetGroup')}
              >
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
      <ForecastChart data={sliced} baseCurrency={baseCurrency} seriesItems={seriesItems} />
      {truncated && (
        <div className="forecast-note">
          {t('pulse.forecast.truncated', { days: fullSeries.length })}
        </div>
      )}
    </section>
  );
}

function warningLabel(warning, accountsById, t) {
  switch (warning.dimension) {
    case 'overall':
      return t('dimension.overall');
    case 'country':
      return t('pulse.warnings.country', { name: warning.dimension_key });
    case 'currency':
      return t('pulse.warnings.currency', { code: warning.dimension_key });
    default:
      return accountsById.get(Number(warning.dimension_key))?.name ?? t('pulse.warnings.accountFallback', { id: warning.dimension_key });
  }
}

function warningText(warning, baseCurrency, t) {
  const currency = warning.currency_code || baseCurrency;
  const state = warningState(warning);
  const parts = [];

  if (state === 'negative') {
    parts.push(t('pulse.warnings.alreadyNegative'));
  } else if (state === 'zero') {
    parts.push(t('pulse.warnings.atZero'));
  } else if (state === 'below') {
    parts.push(t('pulse.warnings.alreadyBelow'));
    if (warning.earliest_non_positive_date) parts.push(t('pulse.warnings.zeroOn', { date: shortDate(warning.earliest_non_positive_date) }));
  } else if (warning.earliest_non_positive_date) {
    parts.push(t('pulse.warnings.willReachZero', { date: shortDate(warning.earliest_non_positive_date) }));
  } else if (warning.earliest_below_threshold_date) {
    parts.push(t('pulse.warnings.willFallBelow', { date: shortDate(warning.earliest_below_threshold_date) }));
  }

  const formattedMinimum = formatMinor(warning.minimum_projected_minor, currency);
  const minimumWithCode = formattedMinimum.includes(currency) ? formattedMinimum : `${formattedMinimum} ${currency}`;
  parts.push(t('pulse.warnings.minimumOn', { amount: minimumWithCode, date: shortDate(warning.minimum_projected_date) }));
  return parts.join(' · ');
}

function WarningRow({ warning, accountsById, baseCurrency }) {
  const { t } = useTranslation();
  const ratio = warningRatio(warning);
  const color = moneyScaleColor(ratio);
  const severity = warningSeverity(warning);
  return (
    <div
      className={`forecast-warning-row forecast-warning-row--${severity.key}`}
      role="listitem"
      style={{
        // Полоса слева — та же шкала, что у цифр; фон разведён до подсказки,
        // чтобы текст остался на обычных токенах и держал контраст (см. palette.js).
        borderLeftColor: color,
        background: `color-mix(in srgb, ${color} ${(8 - emphasis(ratio, 0) * 6).toFixed(1)}%, transparent)`,
      }}
    >
      <AlertTriangle size={15} className="forecast-warning-icon" style={{ color }} aria-hidden="true" />
      <div className="forecast-warning-body">
        <div className="forecast-warning-heading">
          <span className="forecast-warning-label">{warningLabel(warning, accountsById, t)}</span>
          <span className={`forecast-warning-severity forecast-warning-severity--${severity.key}`}>
            {severity.label}
          </span>
        </div>
        <span className="forecast-warning-text">{warningText(warning, baseCurrency, t)}</span>
      </div>
    </div>
  );
}

function WarningsPanel({ warnings, accounts, baseCurrency, fullWidth = false, filter = 'all', onFilterChange = undefined }) {
  const { t } = useTranslation();
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const [internalFilter, setInternalFilter] = useState('all');
  const actualFilter = onFilterChange ? filter : internalFilter;
  const handleFilterChange = onFilterChange || setInternalFilter;

  const baseLimit = fullWidth ? 6 : WARNING_LIMIT;
  const [visibleLimit, setVisibleLimit] = useState(baseLimit);

  const selection = useMemo(
    () => warningSelection(warnings, actualFilter, visibleLimit),
    [warnings, actualFilter, visibleLimit],
  );

  useEffect(() => {
    if (selection.activeFilter !== actualFilter) handleFilterChange(selection.activeFilter);
  }, [selection.activeFilter, actualFilter, handleFilterChange]);

  useEffect(() => {
    setVisibleLimit(fullWidth ? 6 : WARNING_LIMIT);
  }, [warnings, actualFilter, fullWidth]);

  const countLabel = selection.total > selection.visible.length
    ? t('common.countOfTotal', { visible: selection.visible.length, total: selection.total })
    : String(selection.total);

  return (
    <section className={`card forecast-warnings ${fullWidth ? 'forecast-warnings--full' : ''}`}>
      <div className="card-head">
        <div className="card-head-title-wrap">
          <h2 className="card-title">{t('pulse.warnings.title')}</h2>
          <span className="section-subtitle" aria-live="polite">{countLabel}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <PulseSegmentedControl
          options={selection.availableFilters}
          value={selection.activeFilter}
          onChange={(nextFilter) => {
            handleFilterChange(nextFilter);
            setVisibleLimit(baseLimit);
          }}
          ariaLabel={t('pulse.warnings.categoryAria')}
          disabled={!warnings.length}
          className="warning-filters"
        />
        {actualFilter !== 'all' && (
          <button
            type="button"
            className="filter-reset-icon-btn"
            onClick={() => {
              handleFilterChange('all');
              setVisibleLimit(baseLimit);
            }}
            title={t('pulse.warnings.resetCategory')}
            aria-label={t('pulse.warnings.resetCategory')}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      {selection.visible.length > 0 ? (
        <div className="forecast-warnings-list" role="list" aria-label={t('pulse.warnings.listAria')}>
          {selection.visible.map((w) => (
            <WarningRow key={`${w.dimension}-${w.dimension_key}`} warning={w} accountsById={accountsById} baseCurrency={baseCurrency} />
          ))}
        </div>
      ) : (
        <div className="empty-state">{t('pulse.warnings.empty')}</div>
      )}
      {(selection.hidden > 0 || visibleLimit > baseLimit) && (
        <div className="forecast-warnings-actions">
          {selection.hidden > 0 && (
            <button
              type="button"
              className="link-btn"
              onClick={() => setVisibleLimit((current) => current + baseLimit)}
            >
              {t('common.showMore', { count: selection.hidden })}
            </button>
          )}
          {visibleLimit > baseLimit && selection.total > baseLimit && (
            <button type="button" className="link-btn" onClick={() => setVisibleLimit(baseLimit)}>
              {t('common.collapseTo', { limit: baseLimit })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function UpcomingList({ items, baseCurrency, asOf, colors = paymentColors(items) }) {
  const { t } = useTranslation();
  if (!items.length) return <div className="empty-state">{t('pulse.payments.empty')}</div>;
  return (
    <div className="upcoming-list">
      {items.map((it, idx) => {
        const direction = it.amount_minor === 0 ? t('pulse.payments.zeroAmount') : it.amount_minor > 0 ? t('pulse.payments.income') : t('pulse.payments.expense');
        const overdue = it.date < asOf;
        const eq = it.currency !== baseCurrency && Number.isFinite(it.amount_base_minor)
          ? formatMinor(it.amount_base_minor, baseCurrency)
          : null;
        return (
          <div key={`${it.kind}-${it.source_id}-${idx}`} className={`upcoming-row${overdue ? ' upcoming-row--overdue' : ''}`} style={{ '--payment-color': colors.get(it), '--payment-date-color': paymentDateColor(it.date, asOf) }}>
            <div className="upcoming-date">{paymentDateLabel(it, asOf)}</div>
            <div className="upcoming-desc">
              {it.title}
              {overdue && (
                <div className="upcoming-account">
                  {t('pulse.payments.overdue')}{it.occurrence_count > 1 && t('pulse.payments.overdueCount', { count: it.occurrence_count, unit: t('plural.payment', { count: it.occurrence_count }) })}
                </div>
              )}
              <div className="upcoming-account">{direction} · {it.account_name}</div>
            </div>
            <div className="upcoming-amount">
              {it.amount_minor > 0 ? '+' : ''}{formatMinor(it.amount_minor, it.currency)}
              {eq && <span className="upcoming-eq">≈ {eq}</span>}
              {it.currency !== baseCurrency && !Number.isFinite(it.amount_base_minor) && <span className="upcoming-eq">{t('pulse.payments.noRate', { from: it.currency, to: baseCurrency })}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * @param {{
 *   items: any[],
 *   baseCurrency: string,
 *   asOf: string,
 *   range?: string,
 *   onRangeChange?: ((range: string) => void) | undefined,
 *   filter?: string,
 *   onFilterChange?: ((filter: string) => void) | undefined,
 *   open?: boolean,
 *   onToggle?: ((open: boolean) => void) | undefined,
 * }} props
 */
export function UpcomingSection({
  items,
  baseCurrency,
  asOf,
  range = 'month',
  onRangeChange = undefined,
  filter = 'all',
  onFilterChange = undefined,
  open = true,
  onToggle = undefined,
}) {
  const { t } = useTranslation();
  const colors = useMemo(() => paymentColors(items), [items]);
  const [internalFilter, setInternalFilter] = useState('all');
  const [internalRange, setInternalRange] = useState('month');
  const actualFilter = onFilterChange ? filter : internalFilter;
  const actualRange = onRangeChange ? range : internalRange;
  const handleFilterChange = onFilterChange || setInternalFilter;
  const handleRangeChange = onRangeChange || setInternalRange;

  const [pageSize, setPageSize] = useState('5');
  const [visibleCount, setVisibleCount] = useState(5);
  const filtered = useMemo(
    () => selectPayments(items, asOf, actualRange, actualFilter),
    [items, asOf, actualFilter, actualRange],
  );
  const visible = pageSize === 'all' ? filtered : filtered.slice(0, visibleCount);
  const hidden = filtered.length - visible.length;

  const changePageSize = (nextSize) => {
    setPageSize(nextSize);
    setVisibleCount(nextSize === 'all' ? Number.MAX_SAFE_INTEGER : Number(nextSize));
  };

  useEffect(() => {
    setVisibleCount(pageSize === 'all' ? Number.MAX_SAFE_INTEGER : Number(pageSize));
  }, [actualFilter, actualRange, pageSize]);

  return (
    <CollapsibleSection
      title={t('pulse.payments.title')}
      subtitle={`${filtered.length}`}
      open={open}
      onToggle={onToggle}
      defaultOpen={true}
      actions={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PulseSegmentedControl
            options={[{ key: 'week', label: t('period.week') }, { key: 'month', label: t('period.month') }]}
            value={actualRange}
            onChange={handleRangeChange}
            ariaLabel={t('pulse.payments.periodAria')}
          />
          {actualRange !== 'month' && (
            <button
              type="button"
              className="filter-reset-icon-btn"
              onClick={() => handleRangeChange('month')}
              title={t('pulse.payments.resetPeriod')}
              aria-label={t('pulse.payments.resetPeriod')}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      )}
    >
      <div className="pulse-list-toolbar">
        <div className="pulse-list-control">
          <span className="pulse-list-control-label">{t('filter.type')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PulseSegmentedControl
              options={[
                { key: 'all', label: t('filter.all') },
                { key: 'income', label: t('filter.income') },
                { key: 'expense', label: t('filter.expense') },
              ]}
              value={actualFilter}
              onChange={handleFilterChange}
              ariaLabel={t('pulse.payments.typeAria')}
            />
            {actualFilter !== 'all' && (
              <button
                type="button"
                className="filter-reset-icon-btn"
                onClick={() => handleFilterChange('all')}
                title={t('pulse.payments.resetType')}
                aria-label={t('pulse.payments.resetType')}
              >
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="pulse-list-control pulse-list-control--limit">
          <span className="pulse-list-control-label">{t('filter.batchSize')}</span>
          <PulseSegmentedControl
            options={[
              { key: '5', label: '5' },
              { key: '10', label: '10' },
              { key: '20', label: '20' },
              { key: 'all', label: t('filter.all') },
            ]}
            value={pageSize}
            onChange={changePageSize}
            ariaLabel={t('pulse.payments.countAria')}
          />
        </div>
      </div>
      <UpcomingList items={visible} baseCurrency={baseCurrency} asOf={asOf} colors={colors} />
      {hidden > 0 && pageSize !== 'all' && (
        <button
          type="button"
          className="link-btn pulse-list-more"
          onClick={() => setVisibleCount((current) => current + Number(pageSize))}
        >
          {t('common.showMore', { count: hidden })}
        </button>
      )}
    </CollapsibleSection>
  );
}

// Периоды для блока «Потрачено» (issue #383). Диапазоны считаются от
// локальной полуночи, как и upcomingDayLabel — чтобы «сегодня» не зависел от
// часового пояса сервера. total_spent_minor из analytics_get приходит уже в
// базовой валюте (см. analytics.ts), поэтому клиент только делит minor→major.
const SPENT_PERIODS = [
  { key: 'today' },
  { key: 'yesterday' },
  { key: 'week' },
  { key: 'month' },
];

function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// «Неделя» = последние 7 календарных дней включая сегодня; «Месяц» = с 1-го
// числа текущего месяца по сегодня. «Сегодня»/«Вчера» — одни сутки.
// Все диапазоны в прошлом или сегодня, поэтому analytics_get за них не пуст
// (он пуст только за ещё не заполненные будущие даты — см. skill-предупреждение).
function spentDateRange(period) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (period === 'today') {
    return { start: ymdLocal(today), end: ymdLocal(today) };
  }
  if (period === 'yesterday') {
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    return { start: ymdLocal(y), end: ymdLocal(y) };
  }
  if (period === 'week') {
    const w = new Date(today);
    w.setDate(today.getDate() - 6);
    return { start: ymdLocal(w), end: ymdLocal(today) };
  }
  // month
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  return { start: ymdLocal(first), end: ymdLocal(today) };
}

// Блок «Потрачено» (issue #383): сумма расходов за выбранный период
// (сегодня/вчера/неделя/месяц) во всех валютах, приведённая к базовой.
// Источник — analytics_get (total_spent_minor уже в базовой валюте, конверсия
// идёт сервером через общий BigInt-конвертер, Закон 3 — единый путь FX).
// Переключатель периода — тот же кнопочный контрол, что в остальных блоках
// «Пульса». На узком экране он прокручивается внутри карточки, не раздувая
// headline-grid и не скрывая варианты в меню.
function SpentCard({ baseCurrency, big = false, mobileWide = false, period = 'today', onPeriodChange = undefined }) {
  const { t } = useTranslation();
  const [internalPeriod, setInternalPeriod] = useState('today');
  const actualPeriod = onPeriodChange ? period : internalPeriod;
  const handlePeriodChange = onPeriodChange || setInternalPeriod;
  const [spentMinor, setSpentMinor] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [errorText, setErrorText] = useState(null);

  const load = useCallback(async (p) => {
    setStatus('loading');
    setErrorText(null);
    try {
      const { start, end } = spentDateRange(p);
      const res = await api.getAnalytics({ start_date: start, end_date: end });
      setSpentMinor(res?.stats?.total_spent_minor ?? 0);
      setStatus('ready');
    } catch (err) {
      setSpentMinor(null);
      setErrorText(err.message || t('pulse.metrics.loadSpendingFailed'));
      setStatus('error');
    }
  }, [t]);

  useEffect(() => { load(actualPeriod); }, [load, actualPeriod]);

  return (
    <MetricCard
      label={t('pulse.metrics.spent')}
      big={big}
      // Переключатель периода живёт в одной строке с подписью — так шапка карточки
      // выглядит одинаково во всех разделах (см. MetricCard.control).
      control={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PulseSegmentedControl
            options={SPENT_PERIODS.map((p) => ({ ...p, label: t(`period.${p.key}`) }))}
            value={actualPeriod}
            onChange={handlePeriodChange}
            ariaLabel={t('pulse.spent.periodAria')}
          />
          {actualPeriod !== 'today' && (
            <button
              type="button"
              className="filter-reset-icon-btn"
              onClick={() => handlePeriodChange('today')}
              title={t('pulse.spent.resetPeriod')}
              aria-label={t('pulse.spent.resetPeriod')}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      )}
      value={status === 'loading' ? t('common.loadingPlaceholder') : status === 'error' ? t('common.unavailablePlaceholder') : formatMinor(spentMinor ?? 0, baseCurrency)}
      // Расход красится относительно месячного масштаба того же экрана нельзя —
      // его тут нет; поэтому цвет фиксирован на «тревожной» середине шкалы,
      // а не выдумывается из воздуха.
      color={status === 'ready' ? moneyScaleColor(0.5) : undefined}
      sub={status === 'error' ? errorText : undefined}
    />
  );
}

function GroupToggle({ mode, onChange }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <PulseSegmentedControl
        options={[{ key: 'owner', label: t('groupBy.owner') }, { key: 'country', label: t('groupBy.country') }]}
        value={mode}
        onChange={onChange}
        ariaLabel={t('pulse.accounts.groupingAria')}
      />
      {mode !== 'owner' && (
        <button
          type="button"
          className="filter-reset-icon-btn"
          onClick={() => onChange('owner')}
          title={t('pulse.accounts.resetGrouping')}
          aria-label={t('pulse.accounts.resetGrouping')}
        >
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * Приглушение карточек счетов по доле от самого крупного баланса (в base_minor,
 * глобально по всем счетам — не по группе).
 *
 * Было четыре ступени (порт из v1); стало плавно — требование владельца
 * 2026-08-21. Ступени на реальных данных давали обрыв: счёт с долей 0,49 и счёт
 * с долей 0,51 выглядели как разные классы, хотя разница в деньгах ничтожна.
 *
 * Приглушаются только фон и рамка — обе стороны смешения непрозрачны и лежат
 * между `--bg` и `--bg-card`, то есть цвет карточки не выходит за пределы двух
 * фонов, для которых контраст текста уже проверен в test/palette.test.ts.
 * Текст остаётся на обычных токенах: гасить его прозрачностью значит
 * проваливать AA на мелких суммах — ровно то, что запрещено для архивных строк.
 */
function accountCardStyle(baseMinor, maxBaseMinor) {
  if (baseMinor === null || !maxBaseMinor) return undefined;
  const share = Math.abs(baseMinor) / maxBaseMinor;
  const dim = (1 - emphasis(share, 0)) * 70; // 0 % у крупнейшего счёта, до 70 % у копеечного
  if (dim < 1) return undefined;
  return {
    background: `color-mix(in srgb, var(--bg) ${dim.toFixed(1)}%, var(--bg-card))`,
    borderColor: `color-mix(in srgb, var(--border) ${dim.toFixed(1)}%, var(--bg-card))`,
  };
}

function AccountsGrid({ accounts, groupMode, baseCurrency }) {
  const { t } = useTranslation();
  const otherLabel = t('groupBy.other');
  const groups = useMemo(() => {
    const map = new Map();
    for (const a of accounts) {
      const key = (groupMode === 'owner' ? a.owner : a.country) || otherLabel;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
    return Array.from(map.entries());
  }, [accounts, groupMode, otherLabel]);

  // Счета без курса не входят ни в максимум (масштаб дима), ни в итог группы —
  // их база неизвестна, а не равна нулю.
  const maxBaseMinor = useMemo(
    () => accounts.reduce((m, a) => (a.balance_base_minor === null ? m : Math.max(m, Math.abs(a.balance_base_minor))), 0),
    [accounts],
  );

  return (
    <div className="accounts-groups">
      {groups.map(([key, list]) => {
        const total = list.reduce((s, a) => s + (a.balance_base_minor ?? 0), 0);
        const hasUnrated = list.some((a) => a.balance_base_minor === null);
        return (
          <div key={key} className="account-group">
            <div className="account-group-header">
              <span>{key}</span>
              <span className="account-group-total">
                {formatMinor(total, baseCurrency)}
                {hasUnrated && <span title={t('pulse.accounts.unratedTooltip')}> *</span>}
              </span>
            </div>
            <div className="account-cards">
              {list.map((a) => (
                <div
                  key={a.id}
                  className={`account-card ${a.balance_base_minor === null ? 'account-card--no-rate' : ''}`}
                  style={accountCardStyle(a.balance_base_minor, maxBaseMinor)}
                >
                  <div className="account-name">{a.name}</div>
                  <div className="account-native">{formatMinor(a.balance_minor, a.currency)}</div>
                  {a.currency !== baseCurrency && (
                    a.balance_base_minor !== null
                      ? <div className="account-usd">≈ {formatMinor(a.balance_base_minor, baseCurrency)}</div>
                      : (
                        <div className="account-no-rate">
                          <AlertTriangle size={11} /> {t('pulse.accounts.noRate')}
                        </div>
                      )
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LowestBalanceCard({ lowest, baseCurrency, thresholdMinor, big = false, mobileWide = false }) {
  const { t } = useTranslation();
  return (
    <MetricCard
      label={(
        <span>
          {t('pulse.metrics.lowestAhead')} <span className="metric-sub-inline">· {shortDate(lowest.date)}</span>
        </span>
      )}
      value={formatMinor(lowest.amount_minor, baseCurrency)}
      color={balanceColor(lowest.amount_minor, thresholdMinor)}
      big={big}
    />
  );
}

export default function Pulse({ isCustomizing: externalCustomizing = false, onCustomizingChange }) {
  const { t } = useTranslation();
  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [fxRates, setFxRates] = useState([]);
  const [pulseFilters, setPulseFilters] = useState(loadPulseFilters);
  const [internalCustomizing, setInternalCustomizing] = useState(false);
  const [dashboardConfig, setDashboardConfig] = useState(loadDashboardConfig);
  const lastDayRefresh = useRef(null);

  const isCustomizing = onCustomizingChange ? externalCustomizing : internalCustomizing;
  const setIsCustomizing = onCustomizingChange || setInternalCustomizing;

  const handleConfigChange = useCallback((nextConfig) => {
    setDashboardConfig(nextConfig);
    saveDashboardConfig(nextConfig);
  }, []);

  const handleResetConfig = useCallback(() => {
    const reset = resetDashboardConfig();
    setDashboardConfig(reset);
  }, []);

  const updatePulseFilter = useCallback((key, value) => {
    setPulseFilters((prev) => {
      const next = { ...prev, [key]: value };
      savePulseFilters(next);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      const [forecastRes, fxRes] = await Promise.all([api.getForecast(), api.listFxRates()]);
      setForecast(forecastRes);
      setFxRates(fxRes.rates || []);
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message || t('pulse.error.loadForecast'));
      setStatus('error');
    }
  }, [t]);

  useEffect(() => { load(); }, [load, refreshNonce]);

  useEffect(() => {
    if (!forecast) return undefined;
    const refreshDay = () => {
      if (paymentRefreshDue(forecast.as_of, lastDayRefresh.current)) {
        lastDayRefresh.current = Date.now();
        load();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshDay();
    };
    // A response requested before midnight may arrive after the day changed.
    refreshDay();
    const timer = setInterval(refreshDay, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshDay);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshDay);
    };
  }, [forecast, load]);

  const points = useMemo(
    () => (forecast ? chartData(forecast.series, forecast.base_currency) : []),
    [forecast],
  );

  if (status === 'loading') {
    return (
      <div className="pulse-dashboard">
        <div className="pulse-main-col">
          <SectionSkeleton />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="data-error-panel">
        <p>{loadError}</p>
        <button type="button" className="btn-secondary" onClick={load}>{t('common.retry')}</button>
      </div>
    );
  }

  // Пустота определяется списком счетов, а НЕ полем lowest. Это не
  // придирка: lowest приходит null ещё и когда счета есть, но общий итог
  // неполон (какая-то валюта без курса) — и по lowest экран показывал бы
  // «заведи счёт» человеку, у которого счета заведены, вместо того чтобы
  // попросить недостающий курс.
  if (forecast.accounts.length === 0) {
    return (
      <div className="empty-panel">
        <DatabaseZap size={28} />
        <h2>{t('pulse.empty.title')}</h2>
        <p>{t('pulse.empty.description')}</p>
        <a className="btn-primary" href="#/data/accounts">{t('pulse.empty.goToData')}</a>
      </div>
    );
  }

  return (
    <>
      <PulseDashboard
        forecast={forecast}
        fxRates={fxRates}
        points={points}
        config={dashboardConfig}
        filters={pulseFilters}
        onUpdateFilter={updatePulseFilter}
        onOpenSettings={() => setIsCustomizing(true)}
        onResetConfig={handleResetConfig}
      />
      <DashboardSettingsModal
        open={isCustomizing}
        onClose={() => setIsCustomizing(false)}
        config={dashboardConfig}
        onChange={handleConfigChange}
        onReset={handleResetConfig}
      />
    </>
  );
}

/**
 * @param {{
 *   forecast: any,
 *   fxRates: any[],
 *   points: any[],
 *   groupMode?: string,
 *   setGroupMode?: (mode: string) => void,
 *   config?: any[],
 *   filters?: any,
 *   onUpdateFilter?: (key: string, val: any) => void,
 *   onOpenSettings?: (() => void) | undefined,
 *   onResetConfig?: (() => void) | undefined,
 * }} props
 */
export function PulseDashboard({
  forecast,
  fxRates,
  points,
  groupMode: propGroupMode,
  setGroupMode: propSetGroupMode,
  config = loadDashboardConfig(),
  filters: propFilters,
  onUpdateFilter = undefined,
  onOpenSettings = undefined,
  onResetConfig = undefined,
}) {
  const { t } = useTranslation();
  const { base_currency: baseCurrency } = forecast;
  const visibleBlocks = config.filter((b) => b.visible);

  const [internalFilters, setInternalFilters] = useState(loadPulseFilters);
  const currentFilters = propFilters || internalFilters;

  const handleFilterChange = useCallback((key, val) => {
    if (onUpdateFilter) {
      onUpdateFilter(key, val);
    } else {
      setInternalFilters((prev) => {
        const next = { ...prev, [key]: val };
        savePulseFilters(next);
        return next;
      });
    }
  }, [onUpdateFilter]);

  const effectiveGroupMode = propGroupMode || currentFilters.accountsGroupMode || 'owner';
  const handleGroupModeChange = useCallback((mode) => {
    if (propSetGroupMode) propSetGroupMode(mode);
    handleFilterChange('accountsGroupMode', mode);
  }, [propSetGroupMode, handleFilterChange]);

  if (visibleBlocks.length === 0) {
    return (
      <div className="pulse-empty-dashboard">
        <p>{t('pulse.allBlocksHidden')}</p>
        <div className="pulse-empty-dashboard-actions">
          {onResetConfig && (
            <button type="button" className="btn-secondary" onClick={onResetConfig}>
              <RotateCcw size={14} />
              <span>{t('common.reset')}</span>
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="btn-primary" onClick={onOpenSettings}>
              <SlidersHorizontal size={14} />
              <span>{t('pulse.customize')}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const leftBlocks = visibleBlocks.filter((b) => resolveBlockColumn(b) === 'left');
  const rightBlocks = visibleBlocks.filter((b) => resolveBlockColumn(b) === 'right');
  const fullBlocks = visibleBlocks.filter((b) => resolveBlockColumn(b) === 'full');

  let colModifier = '';
  if (leftBlocks.length > 0 && rightBlocks.length === 0) colModifier = ' pulse-dashboard--only-left';
  else if (leftBlocks.length === 0 && rightBlocks.length > 0) colModifier = ' pulse-dashboard--only-right';

  const renderBlock = (blockId, column) => {
    const orderIndex = visibleBlocks.findIndex((b) => b.id === blockId);
    const orderStyle = orderIndex >= 0 ? { order: orderIndex } : undefined;
    const isFullWidth = column === 'full';

    switch (blockId) {
      case 'metrics':
        return (
          <div key="metrics" className={`pulse-block pulse-block--metrics pulse-block--col-${column}`} style={orderStyle}>
            <CardGrid>
              <MetricCard
                label={t('pulse.metrics.netWorth')}
                value={formatMinor(forecast.net_worth_minor, baseCurrency)}
                color={balanceColor(forecast.net_worth_minor, forecast.low_balance_threshold_minor)}
              />
              <MetricCard
                label={(
                  <span>
                    {t('pulse.metrics.cashFlow')} <span className="metric-sub-inline">· {forecast.cash_flow_days} {t('plural.day', { count: forecast.cash_flow_days })}</span>
                  </span>
                )}
                value={formatMinor(forecast.cash_flow_minor, baseCurrency)}
                color={relativeColor(
                  forecast.cash_flow_minor,
                  forecast.low_balance_threshold_minor || Math.abs(forecast.cash_flow_minor),
                )}
              />
              <SpentCard
                baseCurrency={baseCurrency}
                mobileWide
                period={currentFilters.spentPeriod}
                onPeriodChange={(p) => handleFilterChange('spentPeriod', p)}
              />
              {forecast.lowest && (
                <LowestBalanceCard lowest={forecast.lowest} baseCurrency={baseCurrency} thresholdMinor={forecast.low_balance_threshold_minor} mobileWide />
              )}
            </CardGrid>
          </div>
        );

      case 'warnings': {
        const hasMissingRates = forecast.missing_rates.length > 0;
        const hasWarnings = forecast.warnings && forecast.warnings.length > 0;
        if (!hasMissingRates && !hasWarnings) return null;

        return (
          <div key="warnings" className={`pulse-block pulse-block--warnings pulse-block--col-${column}`} style={orderStyle}>
            {hasMissingRates && (
              <div className="data-warning" role="status">
                <AlertTriangle size={14} className="data-warning-icon" />
                <div className="data-warning-body">
                  <p>
                    {t('pulse.warnings.missingRate', { count: forecast.missing_rates.length })}
                    {': '}
                    {t('pulse.warnings.missingRateExcluded', { currencies: forecast.missing_rates.join(', ') })}
                  </p>
                  <div className="data-warning-actions">
                    <a className="link-btn" href="#/data/rates">{t('pulse.warnings.setRate')}</a>
                  </div>
                </div>
              </div>
            )}
            {hasWarnings && (
              <WarningsPanel
                warnings={forecast.warnings}
                accounts={forecast.accounts}
                baseCurrency={baseCurrency}
                fullWidth={isFullWidth}
                filter={currentFilters.warningsFilter}
                onFilterChange={(f) => handleFilterChange('warningsFilter', f)}
              />
            )}
          </div>
        );
      }

      case 'forecast':
        return (
          <div key="forecast" className={`pulse-block pulse-block--forecast pulse-block--col-${column}`} style={orderStyle}>
            <ForecastSection
              fullSeries={points}
              rawSeries={forecast.series}
              baseCurrency={baseCurrency}
              countries={forecast.countries}
              accounts={forecast.accounts}
              owners={forecast.owners}
              period={currentFilters.forecastPeriod}
              onPeriodChange={(p) => handleFilterChange('forecastPeriod', p)}
              groupMode={currentFilters.forecastGroupMode}
              onGroupModeChange={(mode) => handleFilterChange('forecastGroupMode', mode)}
            />
          </div>
        );

      case 'upcoming':
        return (
          <div key="upcoming" className={`pulse-block pulse-block--upcoming pulse-block--col-${column}`} style={orderStyle}>
            <UpcomingSection
              items={forecast.upcoming}
              baseCurrency={baseCurrency}
              asOf={forecast.as_of}
              range={currentFilters.upcomingRange}
              onRangeChange={(r) => handleFilterChange('upcomingRange', r)}
              filter={currentFilters.upcomingFilter}
              onFilterChange={(f) => handleFilterChange('upcomingFilter', f)}
              open={currentFilters.upcomingOpen ?? true}
              onToggle={(nextOpen) => handleFilterChange('upcomingOpen', nextOpen)}
            />
          </div>
        );

      case 'accounts':
        return (
          <div key="accounts" className={`pulse-block pulse-block--accounts pulse-block--col-${column}`} style={orderStyle}>
            <CollapsibleSection
              title={t('pulse.accounts.title')}
              subtitle={`${forecast.accounts.length}`}
              actions={<GroupToggle mode={effectiveGroupMode} onChange={handleGroupModeChange} />}
              open={currentFilters.accountsOpen ?? true}
              onToggle={(nextOpen) => handleFilterChange('accountsOpen', nextOpen)}
              defaultOpen={true}
            >
              <AccountsGrid accounts={forecast.accounts} groupMode={effectiveGroupMode} baseCurrency={baseCurrency} />
            </CollapsibleSection>
          </div>
        );

      case 'fx_rates':
        return (
          <div key="fx_rates" className={`pulse-block pulse-block--fx pulse-block--col-${column}`} style={orderStyle}>
            <FxFooter rates={fxRates} baseCurrency={baseCurrency} />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <div className={`pulse-dashboard${colModifier}`}>
        {leftBlocks.length > 0 && (
          <div className="pulse-main-col">
            {leftBlocks.map((b) => renderBlock(b.id, resolveBlockColumn(b)))}
          </div>
        )}
        {rightBlocks.length > 0 && (
          <div className="pulse-side-col">
            {rightBlocks.map((b) => renderBlock(b.id, resolveBlockColumn(b)))}
          </div>
        )}
        {fullBlocks.map((b) => {
          const resolvedCol = resolveBlockColumn(b);
          return b.id === 'fx_rates' ? (
            <div key="fx_rates" className="pulse-footer-col" style={{ order: visibleBlocks.findIndex((it) => it.id === 'fx_rates') }}>
              {renderBlock(b.id, resolvedCol)}
            </div>
          ) : (
            <div key={b.id} className="pulse-block--col-full" style={{ order: visibleBlocks.findIndex((it) => it.id === b.id) }}>
              {renderBlock(b.id, resolvedCol)}
            </div>
          );
        })}
      </div>
      {onOpenSettings && (
        <div className="pulse-customize-footer">
          <button
            type="button"
            className="pulse-customize-link"
            onClick={onOpenSettings}
            title={t('pulse.customizeAria')}
          >
            <SlidersHorizontal size={14} />
            <span>{t('pulse.customize')}</span>
          </button>
        </div>
      )}
    </>
  );
}
