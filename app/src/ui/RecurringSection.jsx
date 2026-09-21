// Секция «Регулярные» на экране «Данные» (S1-3, issue #197, #280): правила
// повторения без конкретной даты каждой операции. Устройство — зеркало
// PlannedSection.jsx: своя форма, свой chain для правок строки, закрытие
// периода и пропуск периода, пауза/возобновление и удаление.
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Plus, Trash2, ChevronDown, ChevronRight, Check, SkipForward } from 'lucide-react';
import { api } from './api';
import { SectionSkeleton,  DataSection, useLoadWhenExpanded  } from './components';
import { useRefreshNonce } from './RefreshContext';
import { formatMinor, minorToInputString, parseAmountToMinor } from './money';
import { describeRecurrence, describeDueDate, FREQUENCY_OPTIONS, formatDayMonth, intervalUnitLabel, todayDateString } from './recurrence';
import { DATA_BLOCK_DEFS } from './dataLayout';
import { blockTitle } from './i18nLabels';


function accountLabel(account, t) {
  if (!account) return '';
  return account.archived ? `${account.name} ${t('common.archivedSuffix')}` : account.name;
}

function findAccount(accounts, id) {
  return accounts.find((a) => String(a.id) === String(id));
}

function PeriodCloseForm({ item, accounts, onSubmit, onCancel }) {
  const { t } = useTranslation();
  const isExpense = item.amount_minor < 0;
  const [form, setForm] = useState(() => ({
    date: item.next_due_date,
    amount: minorToInputString(Math.abs(item.amount_minor), item.currency),
    account_id: item.account_id,
    item: item.title,
    category: item.category ?? '',
    subcategory: '',
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const selectedAccount = findAccount(accounts, form.account_id);
  const operationCurrency = selectedAccount?.currency ?? item.currency;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const itemTitle = form.item.trim();
    if (!itemTitle) { setError(t('data.recurring.closeTitleRequired')); return; }
    if (!form.account_id) { setError(t('data.recurring.closeAccountRequired')); return; }
    if (!form.date) { setError(t('data.recurring.closeDateRequired')); return; }

    let minor;
    try {
      minor = Math.abs(parseAmountToMinor(form.amount, operationCurrency));
    } catch (err) {
      setError(err.message);
      return;
    }
    if (minor === 0) { setError(t('data.recurring.amountNonZero')); return; }

    const payload = {
      date: form.date,
      amount_minor: isExpense ? -minor : minor,
      account_id: Number(form.account_id),
      item: itemTitle,
      category: form.category.trim() || null,
      subcategory: form.subcategory.trim() || null,
    };

    setBusy(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="data-form" onSubmit={handleSubmit} style={{ marginTop: '8px' }}>
      <label className="data-form-field">
        <span>{t('data.recurring.fieldOpDate')}</span>
        <input
          type="date"
          required
          value={form.date}
          onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
          disabled={busy}
        />
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldAmount', { currency: operationCurrency })}</span>
        <input
          value={form.amount}
          onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          placeholder="0.00"
          inputMode="decimal"
          disabled={busy}
        />
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldAccount')}</span>
        <select
          value={form.account_id}
          onChange={(e) => setForm((f) => ({ ...f, account_id: e.target.value }))}
          disabled={busy}
        >
          {accounts
            .filter((a) => !a.archived || String(a.id) === String(item.account_id))
            .map((acc) => (
              <option key={acc.id} value={acc.id}>
                {accountLabel(acc, t)} ({acc.currency})
              </option>
            ))}
        </select>
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldTitle')}</span>
        <input
          value={form.item}
          onChange={(e) => setForm((f) => ({ ...f, item: e.target.value }))}
          disabled={busy}
          placeholder={t('data.recurring.placeholderTitle')}
        />
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldCategory')}</span>
        <input
          value={form.category}
          onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
          disabled={busy}
          placeholder={t('data.recurring.placeholderCategory')}
        />
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldSubcategory')}</span>
        <input
          value={form.subcategory}
          onChange={(e) => setForm((f) => ({ ...f, subcategory: e.target.value }))}
          disabled={busy}
          placeholder={t('data.recurring.placeholderSubcategory')}
        />
      </label>

      {error && <div className="data-form-error">{error}</div>}

      <div className="data-form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          <Check size={14} /> {busy ? t('data.recurring.posting') : t('data.recurring.post')}
        </button>
        <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

export function RecurringItemForm({ initial = null, accounts, onSubmit, onCancel, submitLabel }) {
  const { t } = useTranslation();
  const isEdit = Boolean(initial);
  const [form, setForm] = useState(() => ({
    title: initial?.title ?? '',
    kind: initial ? (initial.amount_minor < 0 ? 'expense' : 'income') : 'expense',
    amount: initial ? minorToInputString(Math.abs(initial.amount_minor), initial.currency) : '',
    account_id: initial?.account_id ?? (accounts[0]?.id ?? ''),
    category: initial?.category ?? '',
    frequency: initial?.frequency ?? 'monthly',
    interval_count: String(initial?.interval_count ?? 1),
    day_of_month: initial?.day_of_month != null ? String(initial.day_of_month) : '',
    next_due_date: initial?.next_due_date ?? todayDateString(),
    end_date: initial?.end_date ?? '',
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const selectedAccount = findAccount(accounts, form.account_id);
  const operationCurrency = isEdit ? initial.currency : (selectedAccount?.currency ?? '');
  const currencyMismatch = isEdit && selectedAccount && selectedAccount.currency !== initial.currency;

  const intervalCountNum = Number(form.interval_count) || 0;
  const intervalPreview = intervalCountNum > 1
    ? t('recurrence.everyN', { count: intervalCountNum, unit: intervalUnitLabel(form.frequency, intervalCountNum) })
    : '';

  const hasDayAnchor = form.frequency === 'monthly' || form.frequency === 'yearly';
  const dayFromNextDue = form.next_due_date ? Number(form.next_due_date.slice(8, 10)) : null;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    const title = form.title.trim();
    if (!title) { setError(t('data.recurring.titleRequired')); return; }
    if (!form.account_id) { setError(t('data.recurring.accountRequired')); return; }
    if (!form.next_due_date) { setError(t('data.recurring.fieldNextDue')); return; }

    const intervalCount = Number(form.interval_count);
    if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 365) {
      setError(t('data.recurring.intervalRange'));
      return;
    }
    if (form.end_date && form.end_date < form.next_due_date) {
      setError(t('data.recurring.endDateAfter'));
      return;
    }

    let dayOfMonth = null;
    if (hasDayAnchor) {
      const raw = form.day_of_month.trim();
      dayOfMonth = raw === '' ? dayFromNextDue : Number(raw);
      if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        setError(t('data.recurring.fieldDayOfMonth'));
        return;
      }
    }

    let minor;
    try {
      minor = Math.abs(parseAmountToMinor(form.amount, operationCurrency));
    } catch (err) {
      setError(err.message);
      return;
    }
    if (minor === 0) { setError(t('data.recurring.amountNonZero')); return; }

    const payload = {
      title,
      amount_minor: form.kind === 'expense' ? -minor : minor,
      account_id: Number(form.account_id),
      frequency: form.frequency,
      interval_count: intervalCount,
      next_due_date: form.next_due_date,
    };
    if (hasDayAnchor) payload.day_of_month = dayOfMonth;
    const category = form.category.trim();
    if (isEdit || category) payload.category = category;
    if (isEdit) {
      payload.end_date = form.end_date ? form.end_date : null;
    } else if (form.end_date) {
      payload.end_date = form.end_date;
    }

    setBusy(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="data-form" onSubmit={submit}>
      <label className="data-form-field">
        <span>{t('data.recurring.fieldTitle')}</span>
        <input
          value={form.title}
          onChange={set('title')}
          disabled={busy}
          autoFocus
          placeholder={t('data.recurring.placeholderTitle')}
        />
      </label>

      <div className="data-form-field">
        <span>{t('data.recurring.fieldType')}</span>
        <div className="data-kind-toggle" role="group" aria-label={t('data.recurring.fieldTypeAria')}>
          <button
            type="button"
            className={`data-kind-btn data-kind-btn--expense ${form.kind === 'expense' ? 'data-kind-btn--active' : ''}`}
            onClick={() => setForm((f) => ({ ...f, kind: 'expense' }))}
            disabled={busy}
            aria-pressed={form.kind === 'expense'}
          >
            {t('data.recurring.expense')}
          </button>
          <button
            type="button"
            className={`data-kind-btn data-kind-btn--income ${form.kind === 'income' ? 'data-kind-btn--active' : ''}`}
            onClick={() => setForm((f) => ({ ...f, kind: 'income' }))}
            disabled={busy}
            aria-pressed={form.kind === 'income'}
          >
            {t('data.recurring.income')}
          </button>
        </div>
      </div>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldAmount', { currency: operationCurrency || t('common.emptyDash') })}</span>
        <input
          value={form.amount}
          onChange={set('amount')}
          placeholder="0.00"
          inputMode="decimal"
          disabled={busy}
        />
        {currencyMismatch && (
          <span className="data-form-hint">
            {t('data.recurring.currencyMismatch', { accCurrency: selectedAccount.currency, opCurrency: initial.currency })}
          </span>
        )}
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldAccount')}</span>
        <select value={form.account_id} onChange={set('account_id')} disabled={busy}>
          {accounts
            .filter((a) => !a.archived || (isEdit && String(a.id) === String(initial.account_id)))
            .map((acc) => (
              <option key={acc.id} value={acc.id}>{accountLabel(acc, t)} ({acc.currency})</option>
            ))}
        </select>
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldFrequency')}</span>
        <select value={form.frequency} onChange={set('frequency')} disabled={busy}>
          {FREQUENCY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldInterval')}</span>
        <input
          type="number"
          min="1"
          max="365"
          value={form.interval_count}
          onChange={set('interval_count')}
          disabled={busy}
        />
        {intervalPreview && <span className="data-form-note">{intervalPreview}</span>}
      </label>

      {hasDayAnchor && (
        <label className="data-form-field">
          <span>{t('data.recurring.fieldDayOfMonth')}</span>
          <input
            type="number"
            min="1"
            max="31"
            value={form.day_of_month}
            onChange={set('day_of_month')}
            placeholder={dayFromNextDue ? String(dayFromNextDue) : t('data.recurring.placeholderDayOfMonth')}
            disabled={busy}
          />
          <span className="data-form-note">
            {t('data.recurring.dayOfMonthHint')}
          </span>
        </label>
      )}

      <label className="data-form-field">
        <span>{t('data.recurring.fieldNextDue')}</span>
        <input
          type="date"
          value={form.next_due_date}
          onChange={set('next_due_date')}
          disabled={busy}
        />
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldEndDate')}</span>
        <input
          type="date"
          value={form.end_date}
          onChange={set('end_date')}
          disabled={busy}
        />
        <span className="data-form-note">
          {t('data.recurring.endDateHint')}
        </span>
      </label>

      <label className="data-form-field">
        <span>{t('data.recurring.fieldCategory')}</span>
        <input
          value={form.category}
          onChange={set('category')}
          placeholder={t('data.recurring.placeholderCategory')}
          disabled={busy}
        />
      </label>

      {error && <div className="data-form-error">{error}</div>}
      <div className="data-form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('common.saving') : submitLabel}
        </button>
        <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function RecurringRow({
  item,
  accounts,
  expanded,
  onToggle,
  onUpdate,
  onClosePeriod,
  onSkipPeriod,
  onPauseToggle,
  onDelete,
}) {
  const { t } = useTranslation();
  const [showCloseForm, setShowCloseForm] = useState(false);
  const account = findAccount(accounts, item.account_id);
  const meta = [describeRecurrence(item), account?.name].filter(Boolean).join(' · ');
  const isExpense = item.amount_minor < 0;
  const due = describeDueDate(item.next_due_date);

  const onRowKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <li className={`data-row ${item.active ? '' : 'data-row--archived'}`}>
      <div
        className="data-row-top"
        onClick={onToggle}
        onKeyDown={onRowKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <div className="data-row-main">
          <div className="data-row-title">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{item.title}</span>
          </div>
          {meta && <div className="data-row-meta">{meta}</div>}
        </div>

        <div className="data-row-value">
          <span className={`data-amount ${isExpense ? 'data-amount--expense' : 'data-amount--income'}`}>
            {formatMinor(item.amount_minor, item.currency)}
          </span>
          <div className={`data-row-sub data-due--${due.tone}`}>
            {due.text}
            {item.end_date && t('data.recurring.until', { date: formatDayMonth(item.end_date) })}
          </div>
          <div className="data-row-quick">
            {item.active ? (
              <button
                type="button"
                className="icon-btn"
                onClick={(e) => { e.stopPropagation(); onPauseToggle(); }}
                aria-label={t('data.recurring.pauseAria', { title: item.title })}
                title={t('data.recurring.pause')}
              >
                <Pause size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn"
                onClick={(e) => { e.stopPropagation(); onPauseToggle(); }}
                aria-label={t('data.recurring.resumeAria', { title: item.title })}
                title={t('data.recurring.resume')}
              >
                <Play size={14} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn icon-btn--danger"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              aria-label={t('data.recurring.deleteAria', { title: item.title })}
              title={t('common.delete')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="data-row-expand" onClick={(e) => e.stopPropagation()}>
          {item.active && (
            <div className="data-form data-form--inline" style={{ background: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <strong style={{ fontSize: '13px' }}>{t('data.recurring.paymentFor', { date: formatDayMonth(item.next_due_date) })}</strong>
                  <div className="data-form-note">
                    {formatMinor(item.amount_minor, item.currency)} · {account?.name}
                  </div>
                </div>
                <div className="data-row-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => setShowCloseForm((v) => !v)}
                  >
                    <Check size={14} /> {showCloseForm ? t('data.recurring.hideCloseForm') : t('data.recurring.closePeriod')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => onSkipPeriod(item)}
                  >
                    <SkipForward size={14} /> {t('data.recurring.skipPeriod')}
                  </button>
                </div>
              </div>

              {showCloseForm && (
                <PeriodCloseForm
                  item={item}
                  accounts={accounts}
                  onSubmit={(payload) => onClosePeriod(payload)}
                  onCancel={() => setShowCloseForm(false)}
                />
              )}
            </div>
          )}

          <RecurringItemForm initial={item} accounts={accounts} submitLabel={t('data.recurring.saveRule')} onSubmit={onUpdate} onCancel={onToggle} />
          <div className="data-row-actions">
            <button type="button" className="btn-secondary" onClick={onPauseToggle}>
              {item.active
                ? <><Pause size={14} /> {t('data.recurring.pause')}</>
                : <><Play size={14} /> {t('data.recurring.resume')}</>}
            </button>
            <button type="button" className="btn-danger" onClick={onDelete}>
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function RecurringSection({
  accounts,
  refreshAccounts,
  refreshRatesQuiet,
  onFactChanged,
  expanded,
  onToggle,
  search = '',
  filter = {},
  pausedOpen: propPausedOpen,
  onTogglePausedOpen,
}) {
  const { t } = useTranslation();
  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [items, setItems] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [internalPausedOpen, setInternalPausedOpen] = useState(false);
  const pausedOpen = propPausedOpen !== undefined ? propPausedOpen : internalPausedOpen;
  const togglePausedOpen = onTogglePausedOpen || (() => setInternalPausedOpen((v) => !v));
  const [showNew, setShowNew] = useState(false);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      const res = await api.listRecurringItems();
      setItems(res.recurring_items);
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message || t('data.recurring.loadFailed'));
      setStatus('error');
    }
  }, [t]);

  useLoadWhenExpanded(expanded, load, refreshNonce);

  const refresh = useCallback(async () => {
    const res = await api.listRecurringItems();
    setItems(res.recurring_items);
    setActionError(null);
  }, []);

  const chainRef = useRef(Promise.resolve());
  const serialize = useCallback((fn) => {
    const next = chainRef.current.then(fn, fn);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);

  const runAction = useCallback(async (fn) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err.message || t('common.actionFailed'));
    }
  }, [t]);

  const handleCreate = (payload) => serialize(async () => {
    await api.createRecurringItem(payload);
    await refresh();
    await refreshRatesQuiet();
    setShowNew(false);
  });

  const handleUpdate = (item, payload) => serialize(async () => {
    await api.updateRecurringItem(item.id, payload);
    await refresh();
    setExpandedId(null);
  });

  const handleClosePeriod = (item, payload) => runAction(() => serialize(async () => {
    await api.closeRecurringItemPeriod(item.id, payload);
    await refresh();
    if (refreshAccounts) await refreshAccounts();
    if (onFactChanged) onFactChanged();
    setExpandedId(null);
  }));

  const handleSkipPeriod = (item) => runAction(() => serialize(async () => {
    await api.skipRecurringItemPeriod(item.id);
    await refresh();
    setExpandedId(null);
  }));

  const handlePauseToggle = (item) => runAction(() => serialize(async () => {
    await api.updateRecurringItem(item.id, { active: !item.active });
    await refresh();
  }));

  const handleDelete = (item) => {
    if (!window.confirm(t('data.recurring.deleteConfirm', { title: item.title }))) return;
    return runAction(() => serialize(async () => {
      await api.deleteRecurringItem(item.id);
      await refresh();
      await refreshRatesQuiet();
      setExpandedId(null);
    }));
  };

  const noAccounts = accounts.length === 0;
  const active = items.filter((i) => i.active).sort((a, b) => (a.next_due_date || '').localeCompare(b.next_due_date || ''));
  const paused = items.filter((i) => !i.active);
  const matchesSearch = (i) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const acc = accounts.find((a) => a.id === i.account_id);
    const hay = [i.title, i.category, acc?.name].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };
  const activeView = active.filter(matchesSearch);
  const pausedView = paused.filter(matchesSearch);

  const rowProps = (item) => ({
    item,
    accounts,
    expanded: expandedId === item.id,
    onToggle: () => setExpandedId((id) => (id === item.id ? null : item.id)),
    onUpdate: (payload) => handleUpdate(item, payload),
    onClosePeriod: (payload) => handleClosePeriod(item, payload),
    onSkipPeriod: () => handleSkipPeriod(item),
    onPauseToggle: () => handlePauseToggle(item),
    onDelete: () => handleDelete(item),
  });

  return (
    filter.recurring !== false && (
    <DataSection
      id="recurring"
      title={blockTitle(DATA_BLOCK_DEFS.recurring, t)}
      expanded={expanded}
      onToggle={onToggle}
      actions={(
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setShowNew((v) => !v)}
          disabled={noAccounts || status !== 'ready'}
        >
          <Plus size={14} /> {t('data.recurring.addShort')}
        </button>
      )}
    >
      {status === 'loading' && <SectionSkeleton />}

      {status === 'error' && (
        <div className="data-error-panel">
          <p>{loadError}</p>
          <button type="button" className="btn-secondary" onClick={load}>{t('common.retry')}</button>
        </div>
      )}

      {status === 'ready' && (
        <>
          {actionError && <div className="data-error" role="alert">{actionError}</div>}

          {noAccounts && (
            <p className="data-hint">{t('data.recurring.needAccount')}</p>
          )}

          {showNew && !noAccounts && (
            <RecurringItemForm accounts={accounts} submitLabel={t('common.create')} onSubmit={handleCreate} onCancel={() => setShowNew(false)} />
          )}

          {active.length === 0 && !showNew && (
            <div className="data-empty">
              <p>{paused.length > 0 ? t('data.recurring.emptyActive') : t('data.recurring.empty')}</p>
              {!noAccounts && (
                <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
                  <Plus size={14} /> {t('data.recurring.add')}
                </button>
              )}
            </div>
          )}

          {activeView.length > 0 && (
            <ul className="data-list">
              {activeView.map((item) => <RecurringRow key={item.id} {...rowProps(item)} />)}
            </ul>
          )}

          {paused.length > 0 && (
            <div className="data-archive">
              <button type="button" className="data-archive-toggle" onClick={togglePausedOpen}>
                {pausedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t('data.recurring.pausedSection', { count: paused.length })}
              </button>
              {pausedOpen && (
                <ul className="data-list data-list--archived">
                  {pausedView.map((item) => <RecurringRow key={item.id} {...rowProps(item)} />)}
                </ul>
              )}
            </div>
          )}

          {search.trim() && activeView.length === 0 && pausedView.length === 0 && (
            <p className="data-hint">{t('data.searchNoResults', { query: search })}</p>
          )}
        </>
      )}
      </DataSection>
    )
  );
}
