import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sun, Moon, Monitor, Check, SunMoon, Languages, ChevronDown, ChevronRight,
} from 'lucide-react';
import { chooseLanguage, isSupportedLanguage, SUPPORTED_LANGUAGES } from './language';
import { formatRelativeDate, daysSince, STALE_RATE_DAYS } from './money';
import { currencySymbol, currencyFlag } from './currency-sign';
import { relativeColor, spendColor } from './palette';

export function ThemeDropdown({ theme, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const options = [
    { key: 'light', label: t('theme.light'), icon: Sun },
    { key: 'dark', label: t('theme.dark'), icon: Moon },
    { key: 'system', label: t('theme.system'), icon: Monitor },
  ];

  return (
    <div className="dropdown-container" ref={ref}>
      <button
        type="button"
        className="topbar-btn topbar-btn--icon"
        onClick={() => setOpen(v => !v)}
        title={t('theme.label')}
        aria-expanded={open}
      >
        <SunMoon size={16} />
      </button>

      {open && (
        <div className="dropdown-menu">
          {options.map(opt => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.key}
                type="button"
                className={`dropdown-item ${theme === opt.key ? 'dropdown-item--active' : ''}`}
                onClick={() => {
                  onChange(opt.key);
                  setOpen(false);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon size={14} />
                  <span>{opt.label}</span>
                </div>
                {theme === opt.key && <Check size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Выбор языка в шапке и на auth-экранах (issues #511, #586). Тот же паттерн, что ThemeDropdown:
// кнопка-иконка + список, клик вне закрывает, галочка у активного.
// Имена языков в меню нативные и не следуют текущей локали — иначе в
// незнакомом языке нельзя узнать, какой пункт выбрать.
const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((key) => ({
  key,
  nameKey: `language.${key}`,
}));

export function AuthScreen({ children }) {
  return (
    <div className="auth-screen">
      <div className="auth-lang">
        <LanguageDropdown />
      </div>
      <div className="auth-card">{children}</div>
    </div>
  );
}

export function LanguageDropdown() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = isSupportedLanguage(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : (isSupportedLanguage(i18n.language) ? i18n.language : 'en');

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="dropdown-container" ref={ref}>
      <button
        type="button"
        className="topbar-btn topbar-btn--icon"
        onClick={() => setOpen((v) => !v)}
        title={t('language.label')}
        aria-label={t('language.label')}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Languages size={16} />
      </button>

      {open && (
        <div className="dropdown-menu" role="listbox" aria-label={t('language.label')}>
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="option"
              aria-selected={current === opt.key}
              className={`dropdown-item ${current === opt.key ? 'dropdown-item--active' : ''}`}
              onClick={() => {
                if (opt.key !== current) {
                  chooseLanguage(opt.key);
                  void i18n.changeLanguage(opt.key);
                }
                setOpen(false);
              }}
            >
              <span>{t(opt.nameKey)}</span>
              {current === opt.key && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Выбор базовой валюты в шапке (issue #382 / #403). Тот же паттерн, что
// ThemeDropdown: кнопка-иконка + выпадающий список, клик вне закрывает,
// галочка у активной валюты. Список валют формирует buildCurrencyOptions:
// уникальные валюты счетов (требование владельца — только реально
// используемые на счетах) + текущая baseCurrency, если её нет среди счетов.
//
// На кнопке — знак валюты ($, €, ₽), в списке — флаг страны и код (USD, EUR).
// Разные представления не прихоть: кнопка стоит в ряду иконок шапки, где
// место есть ровно под глиф, а в раскрытом списке нужен однозначный код —
// знак `$` носят полтора десятка валют, а `¤` не носит ни одна.
export function buildCurrencyOptions(accounts, currentBase) {
  const set = new Set((accounts || []).map((a) => a.currency).filter(Boolean));
  if (currentBase) set.add(currentBase);
  return [...set].sort();
}

export function BaseCurrencyDropdown({ currencies, value, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Стабильный порядок: уникальные коды, отсортированные по алфавиту.
  const ordered = [...new Set(currencies)];
  ordered.sort();

  return (
    <div className="dropdown-container" ref={ref}>
      <button
        type="button"
        className="topbar-btn topbar-btn--icon topbar-btn--currency"
        onClick={() => setOpen(v => !v)}
        title={value ? t('currency.baseWithCode', { code: value }) : t('currency.base')}
        aria-label={value ? t('currency.baseWithCode', { code: value }) : t('currency.base')}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span className="currency-glyph" aria-hidden="true">{currencySymbol(value)}</span>
      </button>

      {open && (
        <div className="dropdown-menu">
          {ordered.map((code) => (
            <button
              key={code}
              type="button"
              className={`dropdown-item ${value === code ? 'dropdown-item--active' : ''}`}
              onClick={() => {
                if (code !== value) onChange(code);
                setOpen(false);
              }}
            >
              <span className="dropdown-item-main">
                <span className="currency-flag" aria-hidden="true">{currencyFlag(code)}</span>
                <span className="currency-code">{code}</span>
              </span>
              {value === code && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Карточка метрики на шапке «Пульса» (Net Worth, Cash Flow, минимум баланса).
//
// `color` — цвет с непрерывной денежной шкалы (palette.js). Он и есть штатный
// способ покрасить сумму: фиксированные `tone-*` оставлены только там, где
// число не деньги (заголовок раздела, служебная подпись).
//
// `control` — управляющий элемент в одной строке с подписью (период у
// «Потрачено»). Он стоит именно в шапке карточки, а не под значением: подпись
// и её переключатель — одна мысль, и разносить их по разным строкам значит
// заставлять глаз возвращаться.
export function MetricCard({ label, value, sub, tone = 'neutral', big, valueStyle, color, control }) {
  const style = color ? { ...valueStyle, color } : valueStyle;
  return (
    <div className={`metric-card ${big ? 'metric-card--big' : ''}`}>
      <div className="metric-card-head">
        <div className="metric-label">{label}</div>
        {control}
      </div>
      <div className={`metric-value tone-${tone}`} style={style}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

/**
 * Сетка карточек без «дырок».
 *
 * Требование владельца: не должно быть строки, где стоит одна короткая
 * карточка, а рядом пусто, — лучше растянуть её на всю ширину. Двух колонок
 * CSS для этого не хватает: `:last-child:nth-child(odd)` считает всех детей
 * подряд и ломается, как только среди них есть широкая (`big`) — она занимает
 * целую строку и сдвигает чётность остальных.
 *
 * Поэтому раскладка считается здесь: проход по детям с учётом того, кто из них
 * широкий. Карточка, оставшаяся одна в строке, растягивается — и в конце списка,
 * и перед широкой карточкой, которая всё равно уедет на новую строку. Ровно тот
 * же расчёт, что сделал бы глаз, но без ручной разметки в каждом разделе.
 *
 * Обёртка на каждый элемент, а не `cloneElement`: сетка не должна знать, какой
 * проп у ребёнка отвечает за ширину, и работает с любым содержимым.
 */
export function CardGrid({ children, className = 'headline-grid' }) {
  const items = React.Children.toArray(children).filter(Boolean);
  const wide = items.map(() => false);
  let pending = -1; // индекс карточки, которая пока стоит в строке одна
  items.forEach((child, i) => {
    if (child.props?.big) {
      if (pending >= 0) wide[pending] = true; // соседа у неё уже не будет
      wide[i] = true;
      pending = -1;
      return;
    }
    if (pending < 0) pending = i;
    else pending = -1; // строка заполнилась
  });
  if (pending >= 0) wide[pending] = true;
  return (
    <section className={className}>
      {items.map((child, i) => {
        const classes = ['card-cell'];
        if (wide[i]) classes.push('card-cell--wide');
        if (child.props?.mobileWide) classes.push('card-cell--mobile-wide');
        return (
          <div key={child.key ?? i} className={classes.join(' ')}>
            {child}
          </div>
        );
      })}
    </section>
  );
}

// Сворачиваемая секция карточки («Ближайшие платежи», «Счета»).
//
// `actions` — контрол в одной строке с заголовком (переключатель группировки,
// период). Он вынесен ИЗ кнопки-заголовка: вложенная кнопка невалидна, и клик
// по переключателю сворачивал бы секцию.
//
// Заголовок обёрнут в h2 снаружи button — валидный паттерн WAI-ARIA Accordion
// (см. DataSection): h2 остаётся в дереве заголовков, button — интерактивным.
// Обратный порядок (h2 внутри button) невалиден — button допускает только
// phrasing content, к которому h2 не относится.
export function CollapsibleSection({
  title,
  subtitle,
  actions,
  collapsedActions = undefined,
  defaultOpen = false,
  open: controlledOpen = undefined,
  onToggle = undefined,
  children,
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const handleToggle = () => {
    const next = !open;
    if (onToggle) onToggle(next);
    if (!isControlled) setInternalOpen(next);
  };

  const currentActions = open ? actions : collapsedActions;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="collapsible-heading">
          <button className="collapsible-head" onClick={handleToggle} aria-expanded={open}>
            <ChevronDown size={16} className={open ? 'chev chev--open' : 'chev'} />
            <span className="collapsible-head-text">
              <span className="card-title">{title}</span>
              {subtitle && <span className="section-subtitle">{subtitle}</span>}
            </span>
          </button>
        </h2>
        {currentActions ? <div className="card-head-actions">{currentActions}</div> : null}
      </div>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}

// Горизонтальные бары «метка · полоса · значение». items: [{label, value_minor or value, sub?}].
// onClickRow + activeSet превращают строки в переключатели фильтра.
//
// Полоса красится денежной шкалой относительно максимума списка (palette.js):
// «Категории», «Магазины» и «Подкатегории» сравнимы только внутри себя, и
// именно доля от крупнейшей строки здесь и есть смысл цвета. `scale='signed'`
// — для списков, где встречаются оба знака: там цвет несёт знак, а не размер.
export function BarRows({ items, fmt, onClickRow, activeSet, limit, scale = 'spend' }) {
  const { t } = useTranslation();
  const shown = limit && limit > 0 ? items.slice(0, limit) : items;
  const max = Math.max(...shown.map((i) => Math.abs(i.value_minor ?? i.value ?? 0)), 1);
  if (!shown.length) return <div className="empty-state">{t('components.barRowsEmpty')}</div>;
  return (
    <div className="category-bars">
      {shown.map((it) => {
        const val = it.value_minor ?? it.value ?? 0;
        const active = activeSet ? activeSet.has(it.label) : false;
        const color = scale === 'signed' ? relativeColor(val, max) : spendColor(val, max);
        const Row = (
          <>
            <div className="category-label" title={it.label}>{it.label}</div>
            <div className="category-track">
              <div className="category-fill" style={{ width: `${(Math.abs(val) / max) * 100}%`, background: color }} />
            </div>
            <div className="category-value" style={{ color }}>
              {fmt ? fmt(val) : val}
              {it.sub && <span className="bar-sub">{it.sub}</span>}
            </div>
          </>
        );
        return onClickRow ? (
          <button
            key={it.label}
            type="button"
            className={`category-row bar-btn ${active ? 'bar-btn--active' : ''}`}
            onClick={() => onClickRow(it.label)}
          >
            {Row}
          </button>
        ) : (
          <div key={it.label} className="category-row">{Row}</div>
        );
      })}
    </div>
  );
}

export function StatPair({ items, fmt }) {
  return (
    <div className="stat-pair">
      {items.map((it) => (
        <div key={it.label} className="stat-block">
          <div className="stat-label">{it.label}</div>
          <div className="stat-value">{fmt ? fmt(it.value) : it.value}</div>
        </div>
      ))}
    </div>
  );
}

export function IncomeExpenseBars({ income, expenses, fmt }) {
  const { t } = useTranslation();
  const max = Math.max(Math.abs(income), Math.abs(expenses), 1);
  return (
    <div className="income-expense">
      <div className="ie-row">
        <div className="ie-label">{t('components.income')}</div>
        <div className="ie-track"><div className="ie-fill ie-fill--income" style={{ width: `${(Math.abs(income) / max) * 100}%` }} /></div>
        <div className="ie-value tone-safe">{fmt ? fmt(income) : income}</div>
      </div>
      <div className="ie-row">
        <div className="ie-label">{t('components.expenses')}</div>
        <div className="ie-track"><div className="ie-fill ie-fill--expense" style={{ width: `${(Math.abs(expenses) / max) * 100}%` }} /></div>
        <div className="ie-value tone-danger">{fmt ? fmt(expenses) : expenses}</div>
      </div>
    </div>
  );
}

/**
 * Загрузка данных блока откладывается до первого разворачивания (issue #260).
 *
 * Все пять блоков «Данных» свёрнуты по умолчанию, и грузить содержимое того,
 * чего не видно, значит платить тремя запросами за открытие экрана. Отсюда
 * выбор из двух названных в задаче: не «грузить всегда и прятать разметку», а
 * «грузить при первом разворачивании». Счётчика в заголовке это лишает — но
 * его в требовании и нет («если он появится»), а он и был единственной ценой.
 *
 * Загрузка ровно одна: свернуть и развернуть блок заново не перечитывает
 * список. Повторное чтение здесь было бы не свежестью, а миганием — данные
 * обновляют сами действия секции, каждое своим refresh. Отказ загрузки
 * отметку не снимает: у неудачи есть своя кнопка «Повторить».
 */
export function useLoadWhenExpanded(expanded, load, refreshNonce = 0) {
  const startedRef = useRef(false);
  // Глобальное «Обновить» (issue #381): сбрасываем отметку «уже загружено»,
  // чтобы свёрнутый-и-развёрнутый блок «Данных» перечитал данные вместо
  // показа закэшированного списка. При смене nonce блок, который сейчас
  // развёрнут, грузится заново; свёрнутый встанет в исходное «не начат»
  // состояние и перечитается при следующем разворачивании.
  useEffect(() => {
    if (refreshNonce > 0) startedRef.current = false;
  }, [refreshNonce]);
  useEffect(() => {
    if (!expanded || startedRef.current) return;
    startedRef.current = true;
    load();
    // refreshNonce в зависимостях: когда счётчик «Обновить» меняется, а
    // expanded и load стабильны (блок уже развёрнут), эффект перезапускается
    // и перечитывает данные — иначе развёрнутый блок «Данных» показывал бы
    // устаревший список (operations/recurring/planned) при глобальном рефреше.
  }, [expanded, load, refreshNonce]);
}

/**
 * Блок экрана «Данные» со сворачиваемым заголовком (issue #260).
 *
 * Отдельно от CollapsibleSection выше, а не вместо неё: та живёт на «Пульсе»,
 * на карточке `.card`, с подзаголовком и своим состоянием внутри себя. Здесь
 * состояние поднято в Data.jsx — оно общее на экран и переживает перезагрузку
 * (dataSections.js), а разметка своя, под `.data-section`.
 *
 * `actions` — кнопка справа от заголовка («+ Счёт», «+ Операция»). Показывается
 * только у развёрнутого блока: у свёрнутого форма создания раскрылась бы в
 * скрытое тело, то есть кнопка выглядела бы сломанной.
 *
 * `collapsedActions` — действие в шапке свёрнутого блока (например, заметный CTA
 * «+ Добавить счёт» на пустой базе, issue #278).
 */
export function DataSection({ id, title, expanded, onToggle, actions, collapsedActions, children }) {
  const bodyId = `data-section-${id}`;
  return (
    <section className="data-section">
      <div className="data-section-header">
        {/* Кнопка ВНУТРИ заголовка, а не наоборот — образец WAI-ARIA
            Accordion. Обратный порядок невалиден: содержимое button — phrasing
            content, а h2 к нему не относится. Заодно заголовок остаётся
            заголовком для скринридера, а не превращается в кнопку. */}
        <h2>
          <button
            type="button"
            className="data-section-toggle"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={bodyId}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{title}</span>
          </button>
        </h2>
        {expanded ? actions : collapsedActions}
      </div>
      {/* Тело не размонтируется, а прячется атрибутом `hidden`: секции держат
          своё состояние (открытая форма, «показать все», уже загруженный
          список), и размонтирование теряло бы его при каждом сворачивании.
          Экономия запросов при этом никуда не девается — секции откладывают
          загрузку до первого разворачивания, см. `expanded` в них самих. */}
      <div id={bodyId} className="data-section-body" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}

/**
 * Курсы валют в подвале — одной компактной строкой.
 *
 * Раньше здесь стояло полное «1 EUR ≈ 1.1699 USD · сегодня» на каждую валюту
 * в ряд, и при трёх-четырёх валютах подвал занимал больше места, чем блок,
 * ради которого страницу открыли (замечание владельца). Теперь свёрнутый вид
 * — знак валюты и курс без хвоста: «€ 1.1699 · ₽ 0.0104 · ¤ 0.0092», а полный
 * вид с кодом, датой и пометкой «устарел» открывается по клику.
 *
 * Отметка «когда обновлён» не выброшена, а поднята в свёрнутую строку одним
 * знаком: если хоть один курс старше STALE_RATE_DAYS дней, рядом с кнопкой
 * горит точка предупреждения. Смысл строки — «курсам можно верить» — так
 * остаётся на виду, а место она занимает одно.
 */

/** Сколько курсов видно в свёрнутом подвале; остальные — счётчиком «+N». */
const FX_PREVIEW = 3;

export function FxFooter({ rates, baseCurrency }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = baseCurrency ? rates.filter((r) => r.code !== baseCurrency) : rates;
  if (!shown.length) return null;
  const stale = shown.filter((r) => daysSince(r.updated_at) > STALE_RATE_DAYS);
  // В свёрнутом виде показываются первые FX_PREVIEW курсов, остальные — счётчиком.
  // Без потолка подвал рос вместе со списком валют и на десятке курсов занимал
  // строку в полтора экрана — ровно то, что владелец просил убрать.
  const preview = shown.slice(0, FX_PREVIEW);
  const hidden = shown.length - preview.length;
  // Доступное имя кнопки включает коды валют и курсы, чтобы скринридер не
  // зачитывал только числа без контекста (знаки скрыты через aria-hidden).
  const ariaLabel = [
    stale.length > 0 ? `${t('fx.stalePresent')}; ` : '',
    shown.map((r) => `${r.code} ${r.rate}`).join(', '),
    `; ${t('fx.toBase', { base: baseCurrency })}`,
  ].join('');
  return (
    <footer className="footer">
      <button
        type="button"
        className="fx-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {stale.length > 0 && <span className="fx-stale-dot" aria-label={t('fx.stalePresent')} />}
        {preview.map((r) => (
          <span key={r.code} className="fx-chip">
            <span aria-hidden="true">{currencySymbol(r.code)}</span> {r.rate}
          </span>
        ))}
        {hidden > 0 && <span className="fx-chip fx-chip--more">+{hidden}</span>}
        <ChevronDown size={12} className={open ? 'chev chev--open' : 'chev'} />
      </button>
      {open && (
        <div className="fx-details">
          {shown.map((r) => (
            <div key={r.code} className="fx-detail-row">
              <span className="fx-detail-pair">
                <span aria-hidden="true">{currencyFlag(r.code)}</span> {t('fx.ratePair', { code: r.code, rate: r.rate, base: baseCurrency })}
              </span>
              <span className={daysSince(r.updated_at) > STALE_RATE_DAYS ? 'fx-detail-age is-stale' : 'fx-detail-age'}>
                {formatRelativeDate(r.updated_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </footer>
  );
}

/**
 * Правка значения в одно касание: клик по значению превращает его в поле
 * ввода с выделенным текстом; Enter/уход фокуса сохраняют, Escape отменяет.
 * Никакой модалки — используется для баланса счёта и курса валюты.
 */
export function InlineEditable({
  value,
  formatDisplay,
  toEditString,
  parseValue,
  onSave,
  ariaLabel,
  inputMode,
  className = '',
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const { t } = useTranslation();
  const inputRef = useRef(null);
  // Снятие фокуса при закрытии поля (Escape или после удачного save) — не
  // повод сохранять ещё раз: без флага удаление сфокусированного input из DOM
  // само по себе шлёт blur, который иначе повторно вызвал бы save().
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = (e) => {
    e.stopPropagation();
    // Флаг обязательно гасится на входе. Он взводится в конце удачного
    // сохранения — на случай, если input уйдёт из DOM сфокусированным, — но
    // фокус к тому моменту обычно уже снят самим `disabled`, blur не приходит
    // и флаг остаётся взведённым. Тогда следующая правка, завершённая уходом
    // фокуса, была бы молча проглочена: поле закрывается, значение не
    // сохранено, ошибки нет. Проверено на живом компоненте — терялась каждая
    // вторая правка баланса.
    skipBlurRef.current = false;
    setDraft(toEditString ? toEditString(value) : String(value ?? ''));
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    skipBlurRef.current = true;
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    // Сохранение уже идёт — второй заход запрещён. Это не теоретическая
    // гонка: на Enter мы ставим saving=true, input становится disabled,
    // браузер снимает с него фокус и шлёт blur — то есть без этой проверки
    // каждое сохранение по Enter уходило бы на сервер дважды.
    if (saving) return;
    // Ничего не набрали — закрываем поле молча, без запроса. Сервер трактует
    // присланный баланс как «я проверил» и переставляет отметку обновления,
    // так что случайный клик мимо превращал бы трёхмесячной давности баланс в
    // «обновлён сегодня». Эта отметка — единственный признак, по которому
    // видно, какие балансы пора актуализировать.
    const original = toEditString ? toEditString(value) : String(value ?? '');
    if (draft === original) { cancel(); return; }
    let parsed;
    try {
      parsed = parseValue(draft);
    } catch (err) {
      setError((err && err.message) || t('components.invalidValue'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed);
      // Убираем input из DOM: браузер при этом сам шлёт blur на удаляемый
      // сфокусированный элемент — без флага это вызвало бы save() повторно.
      skipBlurRef.current = true;
      setEditing(false);
    } catch (err) {
      setError((err && err.message) || t('components.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    // Поле живёт внутри кликабельной строки счёта, которая сама слушает
    // Enter и пробел. Без остановки всплытия Enter сохранял бы значение и тут
    // же разворачивал строку, а пробел вообще не набирался бы — родитель
    // гасит его своим preventDefault.
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  const onBlur = () => {
    if (skipBlurRef.current) { skipBlurRef.current = false; return; }
    save();
  };

  if (!editing) {
    return (
      <button type="button" className={`inline-editable ${className}`} onClick={startEdit} aria-label={ariaLabel}>
        {formatDisplay(value)}
      </button>
    );
  }

  return (
    <span className="inline-editable-edit" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="inline-editable-input"
        value={draft}
        disabled={saving}
        inputMode={inputMode}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {error && <div className="inline-editable-error">{error}</div>}
    </span>
  );
}

export function LoadingSkeleton({ lines = 3 }) {
  return (
    <div className="skeleton-wrap">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton-line" style={{ height: '40px' }} />
      ))}
    </div>
  );
}

export function SectionSkeleton() {
  return (
    <div className="skeleton-wrap">
      <div className="skeleton-line" style={{ height: '40px', width: '30%' }} />
      <div className="skeleton-line" style={{ height: '80px' }} />
      <div className="skeleton-line" style={{ height: '80px' }} />
    </div>
  );
}
