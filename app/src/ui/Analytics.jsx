// «Аналитика» — траты по операциям D1 (S1-5b, issue #250, S1-5c, issue #251).
// Поиск и фильтры сверху действуют на все блоки страницы одновременно.
// Агрегация считается на сервере отдельным роутом (POST /api/v2/analytics).
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Search, SlidersHorizontal, X, AlertTriangle, ChevronDown, RotateCcw } from 'lucide-react';
import { api } from './api';
import {
  MetricCard, CardGrid, CollapsibleSection, BarRows, StatPair, IncomeExpenseBars, FxFooter,
} from './components';
import { useRefreshNonce } from './RefreshContext';
import { formatMinor, formatMajor, fractionDigits } from './money';
import { splitTrendPoint, trendHasRefunds, TREND_EXPENSE_COLOR, TREND_REFUND_COLOR } from './analyticsTrend';
import { compactComment, ReceiptUrlLink } from './ReceiptUrlLink';
import { emphasisTint, emphasisBorder, emphasisText, relativeColor, spendColor } from './palette';
import {
  loadAnalyticsConfig,
  saveAnalyticsConfig,
  resetAnalyticsConfig,
  loadAnalyticsFilters,
  saveAnalyticsFilters,
  resetAnalyticsFilters,
  resolveAnalyticsBlockColumn,
  DEFAULT_ANALYTICS_FILTERS,
  ANALYTICS_BLOCK_DEFS,
} from './analyticsLayout';
import DashboardSettingsModal from './DashboardSettingsModal';
import { intlLocale } from './language';
import { blockTitle } from './i18nLabels';

export const PERIODS = [
  { key: 'd7', labelKey: 'analytics.period.d7' },
  { key: 'd30', labelKey: 'analytics.period.d30' },
  { key: 'm0', labelKey: 'analytics.period.m0' },
  { key: 'm1', labelKey: 'analytics.period.m1' },
  { key: 'all', labelKey: 'analytics.period.all' },
];

const GRANULARITY_KEYS = ['day', 'week', 'month'];

function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function periodToDateRange(key, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = new Date(y, m, now.getDate());

  switch (key) {
    case 'd7': {
      const start = new Date(today);
      start.setDate(today.getDate() - 6);
      return { start_date: formatYMD(start), end_date: formatYMD(today) };
    }
    case 'd30': {
      const start = new Date(today);
      start.setDate(today.getDate() - 29);
      return { start_date: formatYMD(start), end_date: formatYMD(today) };
    }
    case 'm0': {
      const start = new Date(y, m, 1);
      return { start_date: formatYMD(start), end_date: formatYMD(today) };
    }
    case 'm1': {
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0);
      return { start_date: formatYMD(start), end_date: formatYMD(end) };
    }
    case 'all':
    default:
      return { start_date: null, end_date: null };
  }
}


// ---------- фильтры ----------

/**
 * Подсветка чипа по числу операций (требование владельца 2026-08-21):
 * категория с сотней операций должна бросаться в глаза, категория с одной —
 * оставаться доступной, но тихой. Градация плавная (кубический корень в
 * palette.js), а не тремя ступенями: у реальных данных длинный хвост, и на
 * ступенях он схлопывается в одну неразличимую массу.
 *
 * Подсвечиваются фон, рамка и цвет подписи. Выбранный чип не подсвечивается
 * долей: у него своя, более сильная заливка, и смешивать два сигнала в одном
 * элементе значит потерять оба.
 */
function countEmphasisStyle(count, maxCount, active) {
  if (active || !maxCount) return undefined;
  const share = count / maxCount;
  return {
    background: emphasisTint(share, '--text', 0.1),
    borderColor: emphasisBorder(share),
    color: emphasisText(share),
  };
}

function maxCount(list) {
  return list.reduce((m, it) => Math.max(m, it.count ?? 0), 0);
}

function FilterBar({ state, setState, options, activeCount }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggleIn = (key, value) => {
    setState((s) => {
      const next = new Set(s[key]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...s, [key]: next };
    });
  };
  const reset = () => setState((s) => ({ ...s, q: '', cats: new Set(), merchants: new Set(), accounts: new Set(), currencies: new Set() }));

  const categories = options?.categories ?? [];
  const merchants = options?.merchants ?? [];
  const accounts = options?.accounts ?? [];
  const currencies = options?.currencies ?? [];
  const catMax = maxCount(categories);
  const merchantMax = maxCount(merchants);

  return (
    <div className="filter-bar">
      <div className="filter-row">
        <div className="search-box">
          <Search size={15} />
          <input
            value={state.q}
            onChange={(e) => setState((s) => ({ ...s, q: e.target.value }))}
            placeholder={t('analytics.filter.searchPlaceholder')}
          />
          {state.q && (
            <button className="search-clear" onClick={() => setState((s) => ({ ...s, q: '' }))} aria-label={t('analytics.filter.clearSearch')}>
              <X size={14} />
            </button>
          )}
        </div>
        <button
          className={`filter-btn ${open || activeCount ? 'filter-btn--active' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-label={t('analytics.filter.openFilters')}
        >
          <SlidersHorizontal size={16} />
          {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
        </button>
        {(activeCount > 0 || state.q) && (
          <button className="filter-btn filter-clear" onClick={reset} aria-label={t('analytics.filter.resetAll')} title={t('analytics.filter.resetAll')}>
            <RotateCcw size={15} />
          </button>
        )}
      </div>

      <div className="period-chips">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            className={`chip ${state.period === p.key ? 'chip--active' : ''}`}
            onClick={() => setState((s) => ({ ...s, period: p.key }))}
          >
            {t(p.labelKey)}
          </button>
        ))}
        {state.period !== 'd30' && (
          <button
            type="button"
            className="filter-reset-icon-btn"
            onClick={() => setState((s) => ({ ...s, period: 'd30' }))}
            title={t('analytics.filter.resetPeriod')}
            aria-label={t('analytics.filter.resetPeriod')}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>

      {open && (
        <div className="filter-panel">
          {categories.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-label">{t('analytics.filter.categories')}</div>
              <div className="chip-wrap">
                {categories.map((c) => (
                  <button
                    key={c.label}
                    className={`chip ${state.cats.has(c.label) ? 'chip--active' : ''}`}
                    style={countEmphasisStyle(c.count, catMax, state.cats.has(c.label))}
                    onClick={() => toggleIn('cats', c.label)}
                  >
                    {c.label} <span className="chip-count">{c.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {merchants.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-label">{t('analytics.filter.merchants')}</div>
              <div className="chip-wrap">
                {merchants.map((m) => (
                  <button
                    key={m.label}
                    className={`chip ${state.merchants.has(m.label) ? 'chip--active' : ''}`}
                    style={countEmphasisStyle(m.count, merchantMax, state.merchants.has(m.label))}
                    onClick={() => toggleIn('merchants', m.label)}
                  >
                    {m.label} <span className="chip-count">{m.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {accounts.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-label">{t('analytics.filter.accounts')}</div>
              <div className="chip-wrap">
                {accounts.map((a) => (
                  <button
                    key={a}
                    className={`chip ${state.accounts.has(a) ? 'chip--active' : ''}`}
                    onClick={() => toggleIn('accounts', a)}
                  >
                    {a || t('analytics.filter.noAccount')}
                  </button>
                ))}
              </div>
            </div>
          )}
          {currencies.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-label">{t('analytics.filter.currencies')}</div>
              <div className="chip-wrap">
                {currencies.map((c) => (
                  <button
                    key={c}
                    className={`chip ${state.currencies.has(c) ? 'chip--active' : ''}`}
                    onClick={() => toggleIn('currencies', c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(activeCount > 0 || state.q) && (
            <button className="btn-ghost filter-reset" onClick={reset}>
              <RotateCcw size={13} /> {t('analytics.filter.reset')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- график динамики ----------

function trendLabel(ts, granularity, locale) {
  const d = new Date(ts);
  if (granularity === 'month') return d.toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' });
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function TrendTooltip({ active, payload, baseCurrency, showRefunds }) {
  const { t, i18n } = useTranslation();
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const rows = [
    { key: 'expense', color: TREND_EXPENSE_COLOR, label: t('analytics.trend.legendExpense'), value: p.expenseMajor },
  ];
  if (showRefunds) {
    rows.push({ key: 'refund', color: TREND_REFUND_COLOR, label: t('analytics.trend.legendRefund'), value: p.refundMajor });
    rows.push({ key: 'net', color: 'var(--overall)', label: t('analytics.trend.legendNet'), value: p.totalMajor });
  }
  return (
    <div className="chart-tooltip">
      <div className="tooltip-date">{p.tipLabel}</div>
      {rows.map((row) => (
        <div key={row.key} className="tooltip-row">
          <span className="dot" style={{ background: row.color }} />
          <span className="tooltip-label">{row.label}</span>
          <span className="tooltip-value">{formatMajor(row.value, baseCurrency, locale)}</span>
        </div>
      ))}
    </div>
  );
}

function TrendSection({
  series,
  baseCurrency,
  granularity: propGranularity = 'day',
  onGranularityChange = undefined,
}) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const granularities = GRANULARITY_KEYS.map((key) => ({
    key,
    label: t(`analytics.granularity.${key}`),
  }));
  const [internalGranularity, setInternalGranularity] = useState('day');
  const granularity = onGranularityChange ? propGranularity : internalGranularity;
  const setGranularity = onGranularityChange || setInternalGranularity;
  const digits = fractionDigits(baseCurrency);

  const rawPoints = series?.[granularity] ?? [];

  const data = useMemo(
    () => rawPoints.map((p) => {
      const d = new Date(p.ts);
      let tipLabel = '';
      if (granularity === 'week') {
        tipLabel = t('analytics.trend.weekOf', { date: trendLabel(p.ts, 'day', locale) });
      } else if (granularity === 'month') {
        tipLabel = d.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
      } else {
        tipLabel = d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      }
      return {
        ts: p.ts,
        ...splitTrendPoint(p, digits),
        label: trendLabel(p.ts, granularity, locale),
        tipLabel,
      };
    }),
    [rawPoints, granularity, digits, locale, t],
  );
  const showRefunds = useMemo(() => trendHasRefunds(data), [data]);

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-head-title-wrap">
          <h2 className="card-title">{t('analytics.trend.title')}</h2>
          <span className="section-subtitle">
            {data.length ? t('analytics.trend.pointsCount', { count: data.length, currency: baseCurrency }) : t('analytics.trend.noData')}
          </span>
        </div>
        <div className="card-head-actions">
          <div className="group-toggle">
            {granularities.map((g) => (
              <button
                key={g.key}
                type="button"
                className={granularity === g.key ? 'active' : ''}
                onClick={() => setGranularity(g.key)}
              >
                {g.label}
              </button>
            ))}
          </div>
          {granularity !== 'day' && (
            <button
              type="button"
              className="filter-reset-icon-btn"
              onClick={() => setGranularity('day')}
              title={t('analytics.trend.resetGranularity')}
              aria-label={t('analytics.trend.resetGranularity')}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      </div>
      {data.length > 0 && (
        <div className="chart-box chart-box--short">
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis
                stroke="var(--text-muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => (Math.abs(v) >= 1000 ? t('analytics.trend.thousands', { value: Math.round(v / 1000) }) : v)}
                width={44}
              />
              <Tooltip content={<TrendTooltip baseCurrency={baseCurrency} showRefunds={showRefunds} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="expenseMajor" fill={TREND_EXPENSE_COLOR} radius={[3, 3, 0, 0]} isAnimationActive={false} name={t('analytics.trend.legendExpense')} />
              {showRefunds && (
                <Bar dataKey="refundMajor" fill={TREND_REFUND_COLOR} radius={[3, 3, 0, 0]} isAnimationActive={false} name={t('analytics.trend.legendRefund')} />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {data.length > 0 && (
        <div className="chart-legend">
          <span><i className="dot" style={{ background: TREND_EXPENSE_COLOR }} /> {t('analytics.trend.legendExpense')}</span>
          {showRefunds && (
            <span><i className="dot" style={{ background: TREND_REFUND_COLOR }} /> {t('analytics.trend.legendRefund')}</span>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- топ позиций ----------

function TopItemsSection({
  topItems,
  baseCurrency,
  activeKind: propKind = 'expense',
  onKindChange = undefined,
  limit: propLimit = 10,
  onLimitChange = undefined,
  open = undefined,
  onToggle = undefined,
}) {
  const { t } = useTranslation();
  const [internalKind, setInternalKind] = useState('expense');
  const [internalLimit, setInternalLimit] = useState(10);

  const activeKind = onKindChange ? propKind : internalKind;
  const setActiveKind = onKindChange || setInternalKind;

  const limit = onLimitChange !== undefined ? propLimit : internalLimit;
  const setLimit = onLimitChange || setInternalLimit;

  const expenseItems = topItems?.expense ?? [];
  const incomeItems = topItems?.income ?? [];
  const refundItems = topItems?.refund ?? [];

  const tabs = [];
  if (expenseItems.length > 0) tabs.push({ key: 'expense', label: t('analytics.topItems.expense'), count: expenseItems.length });
  if (incomeItems.length > 0) tabs.push({ key: 'income', label: t('analytics.topItems.income'), count: incomeItems.length });
  if (refundItems.length > 0) tabs.push({ key: 'refund', label: t('analytics.topItems.refund'), count: refundItems.length });

  const effectiveKind = tabs.some((t) => t.key === activeKind)
    ? activeKind
    : (tabs[0]?.key ?? 'expense');

  const currentItems = effectiveKind === 'income'
    ? incomeItems
    : effectiveKind === 'refund'
      ? refundItems
      : expenseItems;

  const limits = [10, 20, 50, 0];
  const hasNonDefaultFilter = effectiveKind !== 'expense' || limit !== 10;

  return (
    <CollapsibleSection
      title={t('analytics.topItems.title')}
      subtitle={t('analytics.topItems.subtitle')}
      defaultOpen
      open={open}
      onToggle={onToggle}
      actions={(
        <div className="card-head-actions">
          {tabs.length > 1 && (
            <div className="group-toggle">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={effectiveKind === tab.key ? 'active' : ''}
                  onClick={() => setActiveKind(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          {hasNonDefaultFilter && (
            <button
              type="button"
              className="filter-reset-icon-btn"
              onClick={() => {
                setActiveKind('expense');
                setLimit(10);
              }}
              title={t('analytics.topItems.resetFilters')}
              aria-label={t('analytics.topItems.resetFilters')}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      )}
    >
      <div className="limit-chips">
        {limits.map((l) => (
          <button
            key={l}
            type="button"
            className={`limit-chip ${limit === l ? 'limit-chip--active' : ''}`}
            onClick={() => setLimit(l)}
          >
            {l === 0 ? t('analytics.topItems.limitAll') : l}
          </button>
        ))}
      </div>

      <BarRows
        items={currentItems}
        fmt={(v) => formatMinor(v, baseCurrency)}
        limit={limit}
      />
    </CollapsibleSection>
  );
}

// ---------- чеки ----------

function ReceiptCard({ receipt, baseCurrency }) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const [open, setOpen] = useState(false);
  const d = new Date(receipt.date);
  const currency = receipt.account_currency || baseCurrency;

  const totalStr = formatMinor(receipt.receipt_total_minor, currency);
  const eqStr = currency !== baseCurrency && receipt.receipt_total_base_minor !== null
    ? `≈ ${formatMinor(receipt.receipt_total_base_minor, baseCurrency)}`
    : null;

  return (
    <div className="receipt">
      <button type="button" className="receipt-head" onClick={() => setOpen((v) => !v)}>
        <div className="receipt-date">
          {d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })}
        </div>
        <div className="receipt-merchant">
          {receipt.merchant}
          <span className="receipt-meta">
            {receipt.account_name ? `${receipt.account_name} · ` : ''}{t('analytics.receipt.lineItems', { count: receipt.positions_count })}
          </span>
        </div>
        <div className="receipt-total">
          {totalStr}
          {eqStr && <span className="receipt-usd">{eqStr}</span>}
        </div>
        <ChevronDown size={15} className={open ? 'chev chev--open' : 'chev'} />
      </button>
      {open && (
        <div className="receipt-lines">
          {receipt.lines.map((l) => {
            const lineTotal = formatMinor(Math.abs(l.amount_minor), currency);
            const lineEq = currency !== baseCurrency && l.converted_minor !== null
              ? `≈ ${formatMinor(Math.abs(l.converted_minor), baseCurrency)}`
              : null;
            const subText = [l.subcategory, l.category, compactComment(l.comment)].filter(Boolean).join(' · ');
            return (
              <div key={l.id} className="receipt-line">
                <div className="receipt-line-name">
                  {l.item}
                  {subText && <span className="receipt-line-sub">{subText}</span>}
                  {l.receipt_url ? <ReceiptUrlLink url={l.receipt_url} /> : null}
                </div>
                <div className="receipt-line-total">
                  {l.kind === 'income' || l.kind === 'refund' ? `+${lineTotal}` : lineTotal}
                  {lineEq && <span className="receipt-line-usd">{lineEq}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- регулярные операции и планы (issue #290) ----------

function frequencyLabels(t) {
  return {
    daily: t('analytics.recurring.frequency.daily'),
    weekly: t('analytics.recurring.frequency.weekly'),
    monthly: t('analytics.recurring.frequency.monthly'),
    yearly: t('analytics.recurring.frequency.yearly'),
  };
}

function RecurringPlansSection({
  plans,
  recurringDetails = [],
  recurringOps = [],
  baseCurrency,
  view: propView = 'categories',
  onViewChange = undefined,
  selectedCat: propSelectedCat = '',
  onSelectedCatChange = undefined,
  selectedSubcat: propSelectedSubcat = '',
  onSelectedSubcatChange = undefined,
  open = undefined,
  onToggle = undefined,
}) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const freqLabels = frequencyLabels(t);
  const uncategorized = t('analytics.recurring.uncategorized');
  const [internalView, setInternalView] = useState('categories');
  const [internalCat, setInternalCat] = useState('');
  const [internalSubcat, setInternalSubcat] = useState('');
  const [openCats, setOpenCats] = useState(() => new Set());

  const view = onViewChange ? propView : internalView;
  const setView = onViewChange || setInternalView;

  const selectedCat = onSelectedCatChange !== undefined ? propSelectedCat : internalCat;
  const setSelectedCat = onSelectedCatChange || setInternalCat;

  const selectedSubcat = onSelectedSubcatChange !== undefined ? propSelectedSubcat : internalSubcat;
  const setSelectedSubcat = onSelectedSubcatChange || setInternalSubcat;

  const planItems = plans?.items ?? [];

  // Собираем все уникальные категории из правил и фактических операций
  const allCategories = useMemo(() => {
    const set = new Set();
    planItems.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    recurringDetails.forEach((r) => {
      if (r.category) set.add(r.category);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, locale));
  }, [planItems, recurringDetails, locale]);

  // Собираем доступные подкатегории (для выбранной категории или вообще)
  const availableSubcategories = useMemo(() => {
    const set = new Set();
    recurringDetails.forEach((r) => {
      if ((!selectedCat || r.category === selectedCat) && r.subcategory) {
        set.add(r.subcategory);
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, locale));
  }, [recurringDetails, selectedCat, locale]);

  const toggleCategory = (cat) => {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // Фильтрация правил (plans) по выбранной категории
  const filteredPlans = useMemo(() => {
    return planItems.filter((p) => {
      if (selectedCat && p.category !== selectedCat) return false;
      if (selectedSubcat) return false; // в правилах нет подкатегорий
      return true;
    });
  }, [planItems, selectedCat, selectedSubcat]);

  // Фильтрация фактических операций (recurringDetails) по категории и подкатегории
  const filteredRecurringOps = useMemo(() => {
    return recurringDetails.filter((r) => {
      if (selectedCat && r.category !== selectedCat) return false;
      if (selectedSubcat && r.subcategory !== selectedSubcat) return false;
      return true;
    });
  }, [recurringDetails, selectedCat, selectedSubcat]);

  // Агрегация по категориям для вкладки "По категориям"
  const categoryGroups = useMemo(() => {
    const map = new Map();

    filteredPlans.forEach((p) => {
      const cat = p.category || uncategorized;
      let entry = map.get(cat);
      if (!entry) {
        entry = { category: cat, planMonthly: 0, planCount: 0, actualTotal: 0, actualCount: 0, rules: [], operations: [] };
        map.set(cat, entry);
      }
      entry.planMonthly += p.monthly_eq_minor;
      entry.planCount += 1;
      entry.rules.push(p);
    });

    filteredRecurringOps.forEach((op) => {
      const cat = op.category || uncategorized;
      let entry = map.get(cat);
      if (!entry) {
        entry = { category: cat, planMonthly: 0, planCount: 0, actualTotal: 0, actualCount: 0, rules: [], operations: [] };
        map.set(cat, entry);
      }
      entry.actualTotal += Math.abs(op.converted_minor);
      entry.actualCount += 1;
      entry.operations.push(op);
    });

    return Array.from(map.values()).sort((a, b) => {
      const totalA = Math.abs(a.planMonthly) + a.actualTotal;
      const totalB = Math.abs(b.planMonthly) + b.actualTotal;
      return totalB - totalA || a.category.localeCompare(b.category, locale);
    });
  }, [filteredPlans, filteredRecurringOps, uncategorized, locale]);

  // Расчёты для вкладки "Ежедневные"
  const dailyData = useMemo(() => {
    const dailyRules = filteredPlans.filter((p) => p.frequency === 'daily');
    const dailyPlanPerDay = dailyRules.reduce((sum, p) => sum + Math.abs(p.converted_amount_minor), 0);
    const dailyPlanPerMonth = dailyPlanPerDay * 30;

    const actualDailyTotal = filteredRecurringOps.reduce((sum, op) => sum + Math.abs(op.converted_minor), 0);

    return {
      dailyRules,
      dailyPlanPerDay,
      dailyPlanPerMonth,
      actualDailyTotal,
      actualCount: filteredRecurringOps.length,
    };
  }, [filteredPlans, filteredRecurringOps]);

  // Расчёты для вкладки "Доходы/Расходы"
  const incomeExpenseData = useMemo(() => {
    let planIncomeMonthly = 0;
    let planExpenseMonthly = 0;

    filteredPlans.forEach((p) => {
      if (p.monthly_eq_minor > 0) {
        planIncomeMonthly += p.monthly_eq_minor;
      } else {
        planExpenseMonthly += Math.abs(p.monthly_eq_minor);
      }
    });

    let actualIncome = 0;
    let actualExpense = 0;
    filteredRecurringOps.forEach((op) => {
      if (op.amount_minor > 0) {
        actualIncome += Math.abs(op.converted_minor);
      } else {
        actualExpense += Math.abs(op.converted_minor);
      }
    });

    return {
      planIncomeMonthly,
      planExpenseMonthly,
      actualIncome,
      actualExpense,
      totalIncome: planIncomeMonthly || actualIncome,
      totalExpense: planExpenseMonthly || actualExpense,
    };
  }, [filteredPlans, filteredRecurringOps]);

  const hasAnyData = (plans && (planItems.length > 0 || (plans.categories && plans.categories.length > 0))) || recurringDetails.length > 0 || recurringOps.length > 0;

  if (!hasAnyData) {
    return (
      <CollapsibleSection
        title={t('analytics.recurring.title')}
        subtitle={t('analytics.recurring.subtitle')}
        defaultOpen
        open={open}
        onToggle={onToggle}
      >
        <div className="empty-state" style={{ padding: '10px 0', color: 'var(--text-faint)' }}>
          {t('analytics.recurring.empty')}
        </div>
      </CollapsibleSection>
    );
  }

  const views = [
    { key: 'categories', label: t('analytics.recurring.viewCategories') },
    { key: 'daily', label: t('analytics.recurring.viewDaily') },
    { key: 'income', label: t('analytics.recurring.viewIncomeExpense') },
  ];

  const hasNonDefaultRecurring = view !== 'categories' || selectedCat !== '' || selectedSubcat !== '';
  const resetRecurringFilters = () => {
    setView('categories');
    setSelectedCat('');
    setSelectedSubcat('');
  };

  return (
    <CollapsibleSection
      title={t('analytics.recurring.title')}
      subtitle={t('analytics.recurring.subtitle')}
      defaultOpen
      open={open}
      onToggle={onToggle}
      actions={hasNonDefaultRecurring ? (
        <button
          type="button"
          className="filter-reset-icon-btn"
          onClick={resetRecurringFilters}
          title={t('analytics.recurring.resetFilters')}
          aria-label={t('analytics.recurring.resetFilters')}
        >
          <RotateCcw size={13} />
        </button>
      ) : null}
    >
      <div className="recurring-controls">
        <div className="group-toggle">
          {views.map((v) => (
            <button
              key={v.key}
              type="button"
              className={view === v.key ? 'active' : ''}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="recurring-filter-wrap">
          <select
            className="recurring-select"
            value={selectedCat}
            onChange={(e) => {
              setSelectedCat(e.target.value);
              setSelectedSubcat('');
            }}
            aria-label={t('analytics.recurring.filterByCategory')}
          >
            <option value="">{t('analytics.recurring.allCategories')}</option>
            {allCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {availableSubcategories.length > 0 && (
            <select
              className="recurring-select"
              value={selectedSubcat}
              onChange={(e) => setSelectedSubcat(e.target.value)}
              aria-label={t('analytics.recurring.filterBySubcategory')}
            >
              <option value="">{t('analytics.recurring.allSubcategories')}</option>
              {availableSubcategories.map((sc) => (
                <option key={sc} value={sc}>
                  {sc}
                </option>
              ))}
            </select>
          )}

          {hasNonDefaultRecurring && (
            <button
              type="button"
              className="filter-reset-icon-btn recurring-reset-btn"
              onClick={resetRecurringFilters}
              title={t('analytics.recurring.resetFilters')}
              aria-label={t('analytics.recurring.resetFilters')}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="analytics-body" style={{ marginTop: 14 }}>
        {view === 'categories' && (
          <div className="recurring-categories-list">
            {categoryGroups.length === 0 ? (
              <div className="empty-state">{t('analytics.recurring.noMatch')}</div>
            ) : (
              categoryGroups.map((group) => {
                const isOpen = openCats.has(group.category);
                const hasRules = group.rules.length > 0;
                const hasOps = group.operations.length > 0;
                const badges = [];
                if (group.planCount > 0) badges.push(t('analytics.recurring.rulesCount', { count: group.planCount }));
                if (group.actualCount > 0) badges.push(t('analytics.recurring.chargesCount', { count: group.actualCount }));

                return (
                  <div key={group.category} className={`recurring-card ${isOpen ? 'recurring-card--open' : ''}`}>
                    <button
                      type="button"
                      className="recurring-card-head"
                      onClick={() => toggleCategory(group.category)}
                    >
                      <div className="recurring-head-info">
                        <span className="recurring-cat-name">{group.category}</span>
                        {badges.length > 0 && (
                          <span className="recurring-cat-badges">{badges.join(' · ')}</span>
                        )}
                      </div>
                      <div className="recurring-head-amounts">
                        {group.planMonthly !== 0 && (
                          <span className="recurring-plan-amount">
                            {formatMinor(Math.abs(group.planMonthly), baseCurrency)}{t('analytics.recurring.perMonth')}
                          </span>
                        )}
                        {group.actualTotal !== 0 && (
                          <span className="recurring-actual-amount">
                            {t('analytics.recurring.actualAmount', { amount: formatMinor(group.actualTotal, baseCurrency) })}
                          </span>
                        )}
                      </div>
                      <ChevronDown size={16} className={`chev ${isOpen ? 'chev--open' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="recurring-card-body">
                        {hasRules && (
                          <div className="recurring-subblock">
                            <div className="recurring-subblock-title">{t('analytics.recurring.rulesAndSubscriptions')}</div>
                            <div className="recurring-sublist">
                              {group.rules.map((rule) => {
                                const freq = freqLabels[rule.frequency] || rule.frequency;
                                const origStr = `${formatMinor(Math.abs(rule.amount_minor), rule.currency)} / ${freq.toLowerCase()}`;
                                const isDiffCurrency = rule.currency !== baseCurrency;
                                return (
                                  <div key={`rule-${rule.id}`} className="recurring-subitem">
                                    <div className="recurring-subitem-main">
                                      <span className="recurring-item-title">{rule.title}</span>
                                      <span className="recurring-item-badge">{freq}</span>
                                    </div>
                                    <div className="recurring-subitem-val">
                                      <span className="recurring-item-orig">{origStr}</span>
                                      {isDiffCurrency && (
                                        <span className="recurring-item-eq">
                                          {t('analytics.recurring.monthlyEquivalent', { amount: formatMinor(Math.abs(rule.monthly_eq_minor), baseCurrency) })}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {hasOps && (
                          <div className="recurring-subblock">
                            <div className="recurring-subblock-title">{t('analytics.recurring.actualChargesInPeriod')}</div>
                            <div className="recurring-sublist">
                              {group.operations.map((op) => {
                                const d = new Date(op.date);
                                const dateStr = d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
                                const isDiffCurrency = op.account_currency !== baseCurrency;
                                return (
                                  <div key={`op-${op.id}`} className="recurring-subitem">
                                    <div className="recurring-subitem-main">
                                      <span className="recurring-item-title">{op.item}</span>
                                      <span className="recurring-item-date">{dateStr}</span>
                                      {op.subcategory && (
                                        <span className="recurring-item-subcat">{op.subcategory}</span>
                                      )}
                                    </div>
                                    <div className="recurring-subitem-val">
                                      <span className="recurring-item-orig">
                                        {formatMinor(Math.abs(op.amount_minor), op.account_currency)}
                                      </span>
                                      {isDiffCurrency && (
                                        <span className="recurring-item-eq">
                                          ≈ {formatMinor(Math.abs(op.converted_minor), baseCurrency)}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {view === 'daily' && (
          <div className="recurring-daily-wrap">
            <StatPair
              items={[
                { label: t('analytics.recurring.dailyPlanPerDay'), value: dailyData.dailyPlanPerDay },
                { label: t('analytics.recurring.dailyPlanPerMonth'), value: dailyData.dailyPlanPerMonth },
              ]}
              fmt={(v) => formatMinor(v, baseCurrency)}
            />
            {dailyData.actualDailyTotal > 0 && (
              <div style={{ marginTop: 10 }}>
                <StatPair
                  items={[
                    { label: t('analytics.recurring.actualInPeriod'), value: dailyData.actualDailyTotal },
                    { label: t('analytics.recurring.chargesInPeriod'), value: t('analytics.recurring.chargeCount', { count: dailyData.actualCount }) },
                  ]}
                  fmt={(v) => (typeof v === 'number' ? formatMinor(v, baseCurrency) : v)}
                />
              </div>
            )}
            {dailyData.dailyRules.length > 0 && (
              <div className="recurring-subblock" style={{ marginTop: 14 }}>
                <div className="recurring-subblock-title">{t('analytics.recurring.dailyRules')}</div>
                <div className="recurring-sublist">
                  {dailyData.dailyRules.map((rule) => (
                    <div key={`daily-rule-${rule.id}`} className="recurring-subitem">
                      <div className="recurring-subitem-main">
                        <span className="recurring-item-title">{rule.title}</span>
                        {rule.category && <span className="recurring-item-subcat">{rule.category}</span>}
                      </div>
                      <div className="recurring-subitem-val">
                        <span className="recurring-item-orig">
                          {formatMinor(Math.abs(rule.amount_minor), rule.currency)} {t('analytics.recurring.perDay')}
                        </span>
                        {rule.currency !== baseCurrency && (
                          <span className="recurring-item-eq">
                            {t('analytics.recurring.dailyEquivalent', { amount: formatMinor(Math.abs(rule.converted_amount_minor), baseCurrency) })}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'income' && (
          <div className="recurring-income-wrap">
            <StatPair
              items={[
                { label: t('analytics.recurring.regularIncomeMonthly'), value: incomeExpenseData.planIncomeMonthly || incomeExpenseData.actualIncome },
                { label: t('analytics.recurring.regularExpenseMonthly'), value: incomeExpenseData.planExpenseMonthly || incomeExpenseData.actualExpense },
              ]}
              fmt={(v) => formatMinor(v, baseCurrency)}
            />
            <div style={{ marginTop: 14 }}>
              <IncomeExpenseBars
                income={incomeExpenseData.planIncomeMonthly || incomeExpenseData.actualIncome}
                expenses={incomeExpenseData.planExpenseMonthly || incomeExpenseData.actualExpense}
                fmt={(v) => formatMinor(v, baseCurrency)}
              />
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ---------- доска аналитики ----------

/**
 * @param {{
 *   data: any,
 *   fxRates: any[],
 *   baseCurrency: string,
 *   stats?: any,
 *   categories?: any[],
 *   subcategories?: any[],
 *   merchants?: any[],
 *   recurringOps?: any[],
 *   recurringDetails?: any[],
 *   receipts?: any[],
 *   config?: any[],
 *   blockFilters?: any,
 *   onUpdateFilter?: (key: string, val: any) => void,
 *   onCategoryClick?: (label: string) => void,
 *   onMerchantClick?: (label: string) => void,
 *   activeCats?: Set<string>,
 *   activeMerchants?: Set<string>,
 *   onOpenSettings?: (() => void) | undefined,
 *   onResetConfig?: (() => void) | undefined,
 * }} props
 */
export function AnalyticsDashboard({
  data,
  fxRates,
  baseCurrency,
  stats,
  categories = [],
  subcategories = [],
  merchants = [],
  recurringOps = [],
  recurringDetails = [],
  receipts = [],
  config = loadAnalyticsConfig(),
  blockFilters = DEFAULT_ANALYTICS_FILTERS,
  onUpdateFilter = () => {},
  onCategoryClick = () => {},
  onMerchantClick = () => {},
  activeCats = new Set(),
  activeMerchants = new Set(),
  onOpenSettings = undefined,
  onResetConfig = undefined,
}) {
  const { t } = useTranslation();
  const visibleBlocks = config.filter((b) => b.visible);

  if (visibleBlocks.length === 0) {
    return (
      <div className="analytics-empty-dashboard">
        <p>{t('analytics.dashboard.allBlocksHidden')}</p>
        <div className="analytics-empty-dashboard-actions">
          {onResetConfig && (
            <button type="button" className="btn-secondary" onClick={onResetConfig}>
              <RotateCcw size={14} />
              <span>{t('common.reset')}</span>
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="btn-primary" onClick={onOpenSettings}>
              <SlidersHorizontal size={14} />
              <span>{t('analytics.dashboard.customize')}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const hasLeft = visibleBlocks.some((b) => resolveAnalyticsBlockColumn(b) === 'left');
  const hasRight = visibleBlocks.some((b) => resolveAnalyticsBlockColumn(b) === 'right');

  let colModifier = '';
  if (hasLeft && !hasRight) colModifier = ' analytics-dashboard--only-left';
  else if (!hasLeft && hasRight) colModifier = ' analytics-dashboard--only-right';

  const renderBlock = (blockId, column) => {
    const orderIndex = visibleBlocks.findIndex((b) => b.id === blockId);
    const orderStyle = orderIndex >= 0 ? { order: orderIndex } : undefined;

    switch (blockId) {
      case 'metrics':
        if (!stats) return null;
        return (
          <div key="metrics" className={`analytics-block analytics-block--metrics analytics-block--col-${column}`} style={orderStyle}>
            <CardGrid>
              <MetricCard
                label={t('analytics.metrics.spent')}
                value={formatMinor(stats.total_spent_minor, baseCurrency)}
                color={spendColor(stats.total_spent_minor, Math.max(Math.abs(stats.total_spent_minor), Math.abs(stats.total_income_minor)))}
              />
              <MetricCard
                label={t('analytics.metrics.earned')}
                value={formatMinor(stats.total_income_minor, baseCurrency)}
                color={relativeColor(stats.total_income_minor, Math.max(Math.abs(stats.total_spent_minor), Math.abs(stats.total_income_minor)))}
              />
              <MetricCard
                label={t('analytics.metrics.avgReceipt')}
                value={formatMinor(stats.avg_receipt_minor, baseCurrency)}
                sub={`${stats.receipts_count} ${t('plural.receipt', { count: stats.receipts_count })}`}
              />
              <MetricCard
                label={t('analytics.metrics.perDay')}
                value={formatMinor(stats.per_day_minor, baseCurrency)}
                sub={`${stats.positions_count} ${t('plural.purchase', { count: stats.positions_count })}`}
              />
            </CardGrid>
          </div>
        );

      case 'trend':
        return (
          <div key="trend" className={`analytics-block analytics-block--trend analytics-block--col-${column}`} style={orderStyle}>
            <TrendSection
              series={data?.series}
              baseCurrency={baseCurrency}
              granularity={blockFilters.trendGranularity}
              onGranularityChange={(g) => onUpdateFilter('trendGranularity', g)}
            />
          </div>
        );

      case 'top_items':
        return (
          <div key="top_items" className={`analytics-block analytics-block--top-items analytics-block--col-${column}`} style={orderStyle}>
            <TopItemsSection
              topItems={data?.top_items}
              baseCurrency={baseCurrency}
              activeKind={blockFilters.topItemsKind}
              onKindChange={(k) => onUpdateFilter('topItemsKind', k)}
              limit={blockFilters.topItemsLimit}
              onLimitChange={(l) => onUpdateFilter('topItemsLimit', l)}
              open={blockFilters.topItemsOpen ?? true}
              onToggle={(nextOpen) => onUpdateFilter('topItemsOpen', nextOpen)}
            />
          </div>
        );

      case 'categories':
        return (
          <div key="categories" className={`analytics-block analytics-block--categories analytics-block--col-${column}`} style={orderStyle}>
            <CollapsibleSection
              title={blockTitle(ANALYTICS_BLOCK_DEFS.categories, t)}
              subtitle={t('analytics.section.rowToFilter')}
              defaultOpen
              open={blockFilters.categoriesOpen ?? true}
              onToggle={(nextOpen) => onUpdateFilter('categoriesOpen', nextOpen)}
            >
              <BarRows
                items={categories.map((c) => ({
                  ...c,
                  sub: c.receipts_count ? `${c.receipts_count} ${t('plural.receipt', { count: c.receipts_count })}` : undefined,
                }))}
                fmt={(v) => formatMinor(v, baseCurrency)}
                onClickRow={onCategoryClick}
                activeSet={activeCats}
              />
            </CollapsibleSection>
          </div>
        );

      case 'subcategories':
        return (
          <div key="subcategories" className={`analytics-block analytics-block--subcategories analytics-block--col-${column}`} style={orderStyle}>
            <CollapsibleSection
              title={blockTitle(ANALYTICS_BLOCK_DEFS.subcategories, t)}
              subtitle={`${subcategories.length} ${t('plural.row', { count: subcategories.length })}`}
              defaultOpen
              open={blockFilters.subcategoriesOpen ?? true}
              onToggle={(nextOpen) => onUpdateFilter('subcategoriesOpen', nextOpen)}
            >
              <BarRows
                items={subcategories}
                fmt={(v) => formatMinor(v, baseCurrency)}
                limit={14}
              />
            </CollapsibleSection>
          </div>
        );

      case 'merchants':
        return (
          <div key="merchants" className={`analytics-block analytics-block--merchants analytics-block--col-${column}`} style={orderStyle}>
            <CollapsibleSection
              title={blockTitle(ANALYTICS_BLOCK_DEFS.merchants, t)}
              subtitle={t('analytics.section.rowToFilter')}
              defaultOpen
              open={blockFilters.merchantsOpen ?? true}
              onToggle={(nextOpen) => onUpdateFilter('merchantsOpen', nextOpen)}
            >
              <BarRows
                items={merchants.map((m) => ({
                  ...m,
                  sub: m.receipts_count ? `${m.receipts_count} ${t('plural.receipt', { count: m.receipts_count })}` : undefined,
                }))}
                fmt={(v) => formatMinor(v, baseCurrency)}
                onClickRow={onMerchantClick}
                activeSet={activeMerchants}
              />
            </CollapsibleSection>
          </div>
        );

      case 'recurring':
        return (
          <div key="recurring" className={`analytics-block analytics-block--recurring analytics-block--col-${column}`} style={orderStyle}>
            <RecurringPlansSection
              plans={data?.plans}
              recurringDetails={recurringDetails}
              recurringOps={recurringOps}
              baseCurrency={baseCurrency}
              view={blockFilters.recurringView}
              onViewChange={(v) => onUpdateFilter('recurringView', v)}
              selectedCat={blockFilters.recurringCat}
              onSelectedCatChange={(c) => onUpdateFilter('recurringCat', c)}
              selectedSubcat={blockFilters.recurringSubcat}
              onSelectedSubcatChange={(sc) => onUpdateFilter('recurringSubcat', sc)}
              open={blockFilters.recurringOpen ?? true}
              onToggle={(nextOpen) => onUpdateFilter('recurringOpen', nextOpen)}
            />
          </div>
        );

      case 'receipts':
        return (
          <div key="receipts" className={`analytics-block analytics-block--receipts analytics-block--col-${column}`} style={orderStyle}>
            <CollapsibleSection
              title={blockTitle(ANALYTICS_BLOCK_DEFS.receipts, t)}
              subtitle={`${receipts.length} ${t('plural.receipt', { count: receipts.length })}`}
              defaultOpen
              open={blockFilters.receiptsOpen ?? true}
              onToggle={(nextOpen) => onUpdateFilter('receiptsOpen', nextOpen)}
            >
              {receipts.length === 0 ? (
                <div className="empty-state">{t('analytics.section.receiptsEmpty')}</div>
              ) : (
                <div className="receipt-list">
                  {receipts.map((r) => (
                    <ReceiptCard key={r.id} receipt={r} baseCurrency={baseCurrency} />
                  ))}
                </div>
              )}
            </CollapsibleSection>
          </div>
        );

      case 'fx_rates':
        return (
          <div key="fx_rates" className={`analytics-block analytics-block--fx analytics-block--col-${column}`} style={orderStyle}>
            <FxFooter rates={fxRates} baseCurrency={baseCurrency} />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <div className={`analytics-dashboard${colModifier}`}>
        {visibleBlocks.map((b) => renderBlock(b.id, resolveAnalyticsBlockColumn(b)))}
      </div>
      {onOpenSettings && (
        <div className="analytics-customize-footer">
          <button
            type="button"
            className="analytics-customize-link"
            onClick={onOpenSettings}
            title={t('analytics.dashboard.customizeAria')}
          >
            <SlidersHorizontal size={14} />
            <span>{t('analytics.dashboard.customize')}</span>
          </button>
        </div>
      )}
    </>
  );
}

// ---------- главный экран ----------

export default function Analytics({ isCustomizing: externalCustomizing = false, onCustomizingChange }) {
  const { t } = useTranslation();
  const refreshNonce = useRefreshNonce();
  const [internalCustomizing, setInternalCustomizing] = useState(false);
  const isCustomizing = onCustomizingChange ? externalCustomizing : internalCustomizing;
  const setIsCustomizing = onCustomizingChange || setInternalCustomizing;

  const [analyticsConfig, setAnalyticsConfig] = useState(loadAnalyticsConfig);
  const [analyticsFilters, setAnalyticsFilters] = useState(loadAnalyticsFilters);

  const [state, setState] = useState(() => ({
    q: analyticsFilters.q,
    period: analyticsFilters.period,
    cats: new Set(analyticsFilters.cats),
    merchants: new Set(analyticsFilters.merchants),
    accounts: new Set(analyticsFilters.accounts),
    currencies: new Set(analyticsFilters.currencies),
  }));

  const [debouncedQ, setDebouncedQ] = useState(analyticsFilters.q);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fxRates, setFxRates] = useState([]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQ(state.q);
    }, 250);
    return () => clearTimeout(handle);
  }, [state.q]);

  useEffect(() => {
    api.listFxRates().then((res) => setFxRates(res.rates ?? [])).catch(() => {});
  }, []);

  const handleConfigChange = useCallback((nextConfig) => {
    setAnalyticsConfig(nextConfig);
    saveAnalyticsConfig(nextConfig);
  }, []);

  const handleResetConfig = useCallback(() => {
    const reset = resetAnalyticsConfig();
    setAnalyticsConfig(reset);
  }, []);

  const handleUpdateBlockFilter = useCallback((key, value) => {
    setAnalyticsFilters((prev) => {
      const next = { ...prev, [key]: value };
      saveAnalyticsFilters(next);
      return next;
    });
  }, []);

  const handleSetState = useCallback((updater) => {
    setState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setAnalyticsFilters((f) => {
        const synced = {
          ...f,
          q: next.q,
          period: next.period,
          cats: Array.from(next.cats),
          merchants: Array.from(next.merchants),
          accounts: Array.from(next.accounts),
          currencies: Array.from(next.currencies),
        };
        saveAnalyticsFilters(synced);
        return synced;
      });
      return next;
    });
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const range = periodToDateRange(state.period);
    try {
      const res = await api.getAnalytics({
        start_date: range.start_date,
        end_date: range.end_date,
        q: debouncedQ.trim() || null,
        cats: Array.from(state.cats),
        merchants: Array.from(state.merchants),
        accounts: Array.from(state.accounts),
        currencies: Array.from(state.currencies),
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [state.period, debouncedQ, state.cats, state.merchants, state.accounts, state.currencies]);

  useEffect(() => {
    loadData();
  }, [loadData, refreshNonce]);

  const activeCount = state.cats.size + state.merchants.size + state.accounts.size + state.currencies.size;
  const baseCurrency = data?.base_currency || 'USD';
  const stats = data?.stats;

  const categories = data?.categories ?? [];
  const subcategories = data?.subcategories ?? [];
  const merchants = data?.merchants ?? [];
  const recurringOps = data?.recurring_operations ?? [];
  const recurringDetails = data?.recurring_details ?? [];
  const receipts = data?.receipts ?? [];

  const handleCategoryClick = useCallback((label) => {
    handleSetState((s) => {
      const next = new Set(s.cats);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return { ...s, cats: next };
    });
  }, [handleSetState]);

  const handleMerchantClick = useCallback((label) => {
    handleSetState((s) => {
      const next = new Set(s.merchants);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return { ...s, merchants: next };
    });
  }, [handleSetState]);

  return (
    <div className="screen">
      <FilterBar
        state={state}
        setState={handleSetState}
        options={data?.options}
        activeCount={activeCount}
      />

      {error && <div className="data-error">{error}</div>}

      {data?.missing_rates?.length > 0 && (
        <div className="data-warning" role="status">
          <AlertTriangle size={14} className="data-warning-icon" />
          <div className="data-warning-body">
            <p>{t('analytics.warning.missingRate', { currencies: data.missing_rates.join(', ') })}</p>
            <div className="data-warning-actions">
              <a className="link-btn" href="#/data/rates">{t('analytics.warning.setRate')}</a>
            </div>
          </div>
        </div>
      )}

      <AnalyticsDashboard
        data={data}
        fxRates={fxRates}
        baseCurrency={baseCurrency}
        stats={stats}
        categories={categories}
        subcategories={subcategories}
        merchants={merchants}
        recurringOps={recurringOps}
        recurringDetails={recurringDetails}
        receipts={receipts}
        config={analyticsConfig}
        blockFilters={analyticsFilters}
        onUpdateFilter={handleUpdateBlockFilter}
        onCategoryClick={handleCategoryClick}
        onMerchantClick={handleMerchantClick}
        activeCats={state.cats}
        activeMerchants={state.merchants}
        onOpenSettings={() => setIsCustomizing(true)}
        onResetConfig={handleResetConfig}
      />

      <DashboardSettingsModal
        open={isCustomizing}
        onClose={() => setIsCustomizing(false)}
        config={analyticsConfig}
        onChange={handleConfigChange}
        onReset={handleResetConfig}
        title={t('analytics.settings.title')}
        description={t('analytics.settings.description')}
        blockDefs={ANALYTICS_BLOCK_DEFS}
      />
    </div>
  );
}
