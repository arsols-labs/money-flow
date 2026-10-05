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

// Language choice in the header and on auth screens (issues #511, #586). The same pattern as ThemeDropdown:
// an icon button plus a list, a click outside closes it, a check mark on the active one.
// Language names in the menu are native and do not follow the current locale — otherwise, in
// an unfamiliar language, there is no way to tell which item to pick.
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

// Base-currency choice in the header (issue #382 / #403). The same pattern as
// ThemeDropdown: an icon button plus a dropdown, a click outside closes it,
// a check mark on the active currency. buildCurrencyOptions builds the currency list:
// unique account currencies (the requirement is only those actually
// used on accounts) plus the current baseCurrency if it is not among the accounts.
//
// The button shows the currency sign ($, €, ₽); the list shows the country flag and the code (USD, EUR).
// The different presentations are deliberate: the button sits in the header's icon row, where
// there is room for exactly one glyph, while the open list needs an unambiguous code —
// a dozen and a half currencies share the `$` sign, and none uses `¤`.
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

  // Stable order: unique codes, sorted alphabetically.
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

// A metric card in the "Pulse" header (Net Worth, Cash Flow, minimum balance).
//
// `color` is a color from the continuous money scale (palette.js). It is the ordinary
// way to color an amount: fixed `tone-*` classes are left only where
// the number is not money (a section title, a service caption).
//
// `control` is a control on the same line as the label (the period on
// "Spent"). It sits in the card header, not under the value: the label
// and its switch are one thought, and splitting them onto different lines
// makes the eye go back.
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
 * A card grid without "holes".
 *
 * Requirement: there should be no row where one short
 * card stands and the space beside it is empty — better to stretch it to the full width. Two columns of
 * CSS are not enough for that: `:last-child:nth-child(odd)` counts every child
 * in order and breaks as soon as one of them is wide (`big`) — it takes
 * a whole row and shifts the parity of the rest.
 *
 * So the layout is computed here: a pass over the children that accounts for which of them
 * is wide. A card left alone in a row stretches — both at the end of the list
 * and before a wide card, which will move to a new row anyway. Exactly the
 * same calculation the eye would make, without manual markup in every section.
 *
 * A wrapper on each element, not `cloneElement`: the grid must not know which
 * prop of the child controls width, and it works with any content.
 */
export function CardGrid({ children, className = 'headline-grid' }) {
  const items = React.Children.toArray(children).filter(Boolean);
  const wide = items.map(() => false);
  let pending = -1; // index of the card that so far stands alone in the row
  items.forEach((child, i) => {
    if (child.props?.big) {
      if (pending >= 0) wide[pending] = true; // it will have no neighbor
      wide[i] = true;
      pending = -1;
      return;
    }
    if (pending < 0) pending = i;
    else pending = -1; // the row filled up
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

// A collapsible card section ("Upcoming payments", "Accounts").
//
// `actions` is a control on the same line as the title (a grouping switch,
// a period). It is taken OUT of the title button: a nested button is invalid, and a click
// on the switch would collapse the section.
//
// The title is wrapped in an h2 outside the button — a valid WAI-ARIA Accordion pattern
// (see DataSection): the h2 stays in the heading tree, the button stays interactive.
// The reverse order (h2 inside button) is invalid — a button allows only
// phrasing content, which an h2 is not.
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

// Horizontal bars "label · bar · value". items: [{label, value_minor or value, sub?}].
// onClickRow + activeSet turn rows into filter toggles.
//
// The bar is colored on the money scale relative to the list maximum (palette.js):
// "Categories", "Stores", and "Subcategories" are comparable only within themselves, and
// the share of the largest row is exactly what the color means here. `scale='signed'`
// is for lists where both signs occur: there the color carries the sign, not the size.
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
 * Loading a block's data is deferred until the first expand (issue #260).
 *
 * All five "Data" blocks are collapsed by default, and loading the contents of what
 * is not visible means paying three requests to open the screen. Hence
 * the choice of the two options named in the task: not "always load and hide the markup", but
 * "load on the first expand". That takes a counter out of the title — but
 * the requirement does not have one ("if it appears"), and that counter was the only cost.
 *
 * The load happens exactly once: collapsing and expanding the block again does not re-read
 * the list. Reading again here would not be freshness, it would be a flicker — the data
 * is updated by the section's own actions, each with its own refresh. A failed load
 * does not clear the mark: a failure has its own "Retry" button.
 */
export function useLoadWhenExpanded(expanded, load, refreshNonce = 0) {
  const startedRef = useRef(false);
  // Global "Refresh" (issue #381): clear the "already loaded" mark
  // so a collapsed-then-expanded "Data" block re-reads data instead of
  // showing the cached list. When nonce changes, a block that is currently
  // expanded loads again; a collapsed one returns to the initial "not started"
  // state and is re-read on the next expand.
  useEffect(() => {
    if (refreshNonce > 0) startedRef.current = false;
  }, [refreshNonce]);
  useEffect(() => {
    if (!expanded || startedRef.current) return;
    startedRef.current = true;
    load();
    // refreshNonce is in the dependencies: when the "Refresh" counter changes while
    // expanded and load stay stable (the block is already expanded), the effect restarts
    // and re-reads the data — otherwise an expanded "Data" block would show
    // a stale list (operations/recurring/planned) on a global refresh.
  }, [expanded, load, refreshNonce]);
}

/**
 * A "Data" screen block with a collapsible title (issue #260).
 *
 * Separate from CollapsibleSection above, not a replacement for it: that one lives on "Pulse",
 * on a `.card`, with a subtitle and its own state inside itself. Here
 * the state is lifted into Data.jsx — it is shared for the screen and survives a reload
 * (dataSections.js), and the markup is its own, under `.data-section`.
 *
 * `actions` is a button to the right of the title ("+ Account", "+ Operation"). It is shown
 * only on an expanded block: on a collapsed one the create form would open into
 * a hidden body, so the button would look broken.
 *
 * `collapsedActions` is an action in the header of a collapsed block (for example, a visible CTA
 * "+ Add account" on an empty database, issue #278).
 */
export function DataSection({ id, title, expanded, onToggle, actions, collapsedActions, children }) {
  const bodyId = `data-section-${id}`;
  return (
    <section className="data-section">
      <div className="data-section-header">
        {/* The button is INSIDE the heading, not the other way around — the WAI-ARIA
            Accordion pattern. The reverse order is invalid: a button's content is phrasing
            content, which an h2 is not. The heading also stays
            a heading for a screen reader, instead of turning into a button. */}
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
      {/* The body is not unmounted; it is hidden with the `hidden` attribute: sections keep
          their state (an open form, "show all", an already loaded
          list), and unmounting would lose it on every collapse.
          The request savings stay — sections defer
          loading until the first expand, see `expanded` in the sections themselves. */}
      <div id={bodyId} className="data-section-body" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}

/**
 * Currency rates in the footer — as one compact line.
 *
 * This used to be the full "1 EUR ≈ 1.1699 USD · today" for every currency
 * in a row, and with three or four currencies the footer took more room than the block
 * the page was opened for. The collapsed view is now
 * the currency sign and the rate with no tail: "€ 1.1699 · ₽ 0.0104 · ¤ 0.0092", and the full
 * view with the code, the date, and the "stale" mark opens on click.
 *
 * The "when updated" mark is not thrown away; it is lifted into the collapsed line as one
 * sign: if any rate is older than STALE_RATE_DAYS days, a warning
 * dot lights up next to the button. The line's meaning — "the rates can be trusted" —
 * stays in view, and it takes one slot.
 */

/** How many rates are visible in the collapsed footer; the rest are a "+N" counter. */
const FX_PREVIEW = 3;

export function FxFooter({ rates, baseCurrency }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = baseCurrency ? rates.filter((r) => r.code !== baseCurrency) : rates;
  if (!shown.length) return null;
  const stale = shown.filter((r) => daysSince(r.updated_at) > STALE_RATE_DAYS);
  // The collapsed view shows the first FX_PREVIEW rates; the rest are a counter.
  // Without a cap the footer grew with the currency list and, at a dozen rates, took
  // a line a screen and a half long — exactly what was asked to be removed.
  const preview = shown.slice(0, FX_PREVIEW);
  const hidden = shown.length - preview.length;
  // The button's accessible name includes currency codes and rates so a screen reader does not
  // read bare numbers with no context (the signs are hidden via aria-hidden).
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
 * One-tap editing of a value: a click on the value turns it into an input
 * with the text selected; Enter/blur save, Escape cancels.
 * No modal — used for an account balance and a currency rate.
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
  // Losing focus while the field closes (Escape or after a successful save) is not
  // a reason to save again: without the flag, removing a focused input from the DOM
  // itself sends blur, which would otherwise call save() a second time.
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = (e) => {
    e.stopPropagation();
    // The flag must be cleared on entry. It is set at the end of a successful
    // save — in case the input leaves the DOM while focused — but
    // by then focus has usually already been removed by `disabled` itself, blur does not arrive,
    // and the flag stays set. Then the next edit, finished by leaving
    // focus, would be swallowed silently: the field closes, the value is not
    // saved, and there is no error. Checked on the live component — every
    // second balance edit was lost.
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
    // A save is already in progress — a second entry is forbidden. This is not a theoretical
    // race: on Enter we set saving=true, the input becomes disabled,
    // the browser removes focus and sends blur — so without this check
    // every Enter save would go to the server twice.
    if (saving) return;
    // Nothing was typed — close the field silently, with no request. The server treats
    // a submitted balance as "I checked" and moves the update mark,
    // so an accidental click away would turn a three-month-old balance into
    // "updated today". That mark is the only sign by which
    // it is visible which balances need updating.
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
      // Remove the input from the DOM: the browser then sends blur on the removed
      // focused element itself — without the flag that would call save() again.
      skipBlurRef.current = true;
      setEditing(false);
    } catch (err) {
      setError((err && err.message) || t('components.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    // The field lives inside a clickable account row, which itself listens for
    // Enter and Space. Without stopping bubbling, Enter would save the value and
    // immediately expand the row, and Space would not be typed at all — the parent
    // swallows it with its own preventDefault.
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
