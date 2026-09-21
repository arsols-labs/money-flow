// Секция «Плановые» на экране «Данные» (S1-3, issue #197): разовые операции
// с известной датой. Стиль и приёмы — как у секции счетов в Data.jsx: форма
// со своими busy/error, действия без формы (отметка «выполнено», удаление)
// идут через runAction с общим баннером ошибки, все правки одной строки
// выстроены в цепочку через serialize.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from './api';
import { SectionSkeleton,  DataSection, useLoadWhenExpanded  } from './components';
import { useRefreshNonce } from './RefreshContext';
import { formatMinor, minorToInputString, parseAmountToMinor } from './money';
import { formatDayMonth, todayDateString } from './recurrence';
import { DATA_BLOCK_DEFS } from './dataLayout';
import { blockTitle } from './i18nLabels';

function accountLabel(account, t) {
  if (!account) return '';
  return account.archived ? `${account.name} ${t('common.archivedSuffix')}` : account.name;
}

function findAccount(accounts, id) {
  return accounts.find((a) => String(a.id) === String(id));
}

export function PlannedItemForm({ initial = null, accounts, onSubmit, onCancel, submitLabel }) {
  const { t } = useTranslation();
  const isEdit = Boolean(initial);
  const isDone = isEdit && Boolean(initial.done);
  const [form, setForm] = useState(() => ({
    date: initial?.date ?? todayDateString(),
    title: initial?.title ?? '',
    kind: initial ? (initial.amount_minor < 0 ? 'expense' : 'income') : 'expense',
    amount: initial ? minorToInputString(Math.abs(initial.amount_minor), initial.currency) : '',
    account_id: initial?.account_id ?? (accounts[0]?.id ?? ''),
    category: initial?.category ?? '',
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const selectedAccount = findAccount(accounts, form.account_id);
  // Валюта операции: у существующей строки — её собственная (счёт можно
  // сменить, сервер валюту операции при этом молча не пересчитывает), у новой
  // — валюта выбранного счёта, потому что currency в payload не шлём вовсе.
  const operationCurrency = isEdit ? initial.currency : (selectedAccount?.currency ?? '');
  const currencyMismatch = isEdit && selectedAccount && selectedAccount.currency !== initial.currency;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    const title = form.title.trim();
    if (!title) { setError(t('data.planned.titleRequired')); return; }
    if (!form.date) { setError(t('data.planned.dateRequired')); return; }
    if (!form.account_id) { setError(t('data.planned.accountRequired')); return; }

    let minor;
    try {
      // Модуль берём всегда: сумма в поле вводится положительной, знак даёт
      // переключатель «Расход/Доход» — если владелец всё же набрал минус, он
      // не должен превратить доход в расход втихую или наоборот.
      minor = Math.abs(parseAmountToMinor(form.amount, operationCurrency));
    } catch (err) {
      setError(err.message);
      return;
    }
    if (minor === 0) { setError(t('data.planned.amountNonZero')); return; }

    const payload = {
      date: form.date,
      title,
      amount_minor: form.kind === 'expense' ? -minor : minor,
      account_id: Number(form.account_id),
    };
    // Категория необязательна: при правке шлётся явно (даже пустой — это
    // очистка), при создании — только если заполнена.
    const category = form.category.trim();
    if (isEdit || category) payload.category = category;

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
        <span>{t('data.planned.fieldDate')}</span>
        <input type="date" value={form.date} onChange={set('date')} disabled={busy} />
      </label>
      <label className="data-form-field">
        <span>{t('data.planned.fieldTitle')}</span>
        <input
          value={form.title}
          onChange={set('title')}
          disabled={busy}
          autoFocus
          placeholder={form.kind === 'income' ? t('data.planned.placeholderTitleIncome') : t('data.planned.placeholderTitleExpense')}
        />
      </label>

      <div className="data-form-field">
        <span>{t('data.planned.fieldType')}</span>
        <div className="data-kind-toggle" role="group" aria-label={t('data.planned.fieldTypeAria')}>
          <button
            type="button"
            className={`data-kind-btn data-kind-btn--expense ${form.kind === 'expense' ? 'data-kind-btn--active' : ''}`}
            onClick={() => setForm((f) => ({ ...f, kind: 'expense' }))}
            disabled={busy || isDone}
            aria-pressed={form.kind === 'expense'}
          >
            {t('data.planned.expense')}
          </button>
          <button
            type="button"
            className={`data-kind-btn data-kind-btn--income ${form.kind === 'income' ? 'data-kind-btn--active' : ''}`}
            onClick={() => setForm((f) => ({ ...f, kind: 'income' }))}
            disabled={busy || isDone}
            aria-pressed={form.kind === 'income'}
          >
            {t('data.planned.income')}
          </button>
        </div>
      </div>

      <label className="data-form-field">
        <span>{t('data.planned.fieldAmount', { currency: operationCurrency || '*' })}</span>
        <input value={form.amount} onChange={set('amount')} disabled={busy || isDone} inputMode="decimal" placeholder="0.00" />
      </label>

      <label className="data-form-field">
        <span>{t('data.planned.fieldAccount')}</span>
        <select value={form.account_id} onChange={set('account_id')} disabled={busy || isDone}>
          {accounts.length === 0 && <option value="">{t('common.noAccountsOption')}</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{accountLabel(a, t)}</option>
          ))}
        </select>
        {currencyMismatch && (
          <small className="data-form-hint">
            {t('data.planned.currencyMismatch', { opCurrency: initial.currency, accCurrency: selectedAccount.currency })}
          </small>
        )}
      </label>

      <label className="data-form-field">
        <span>{t('data.planned.fieldCategory')}</span>
        <input
          value={form.category}
          onChange={set('category')}
          disabled={busy}
          placeholder={t('data.planned.placeholderCategory')}
        />
      </label>

      {isDone && (
        <small className="data-form-hint">
          {t('data.planned.doneLocked')}
        </small>
      )}

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

function PlannedRow({ item, accounts, expanded, onToggle, onToggleDone, onUpdate, onDelete }) {
  const { t } = useTranslation();
  const account = findAccount(accounts, item.account_id);
  const meta = [account?.name, item.category].filter(Boolean).join(' · ');
  const isExpense = item.amount_minor < 0;

  const onRowKeyDown = (e) => {
    // Только когда фокус на самой строке — иначе Enter/пробел на вложенном
    // чекбоксе или кнопке разворачивал бы строку вместо своего действия
    // (тот же баг, что уже ловили на строке счёта в Data.jsx).
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <li className="data-row">
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
            <input
              type="checkbox"
              className="data-row-check"
              checked={Boolean(item.done)}
              onChange={onToggleDone}
              onClick={(e) => e.stopPropagation()}
              aria-label={item.done ? t('data.planned.uncheckAria', { title: item.title }) : t('data.planned.checkAria', { title: item.title })}
            />
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="data-row-date">{formatDayMonth(item.date)}</span>
            <span>{item.title}</span>
          </div>
          {meta && <div className="data-row-meta">{meta}</div>}
        </div>

        <div className="data-row-value">
          <span className={`data-amount ${isExpense ? 'data-amount--expense' : 'data-amount--income'}`}>
            {formatMinor(item.amount_minor, item.currency)}
          </span>
          <div className="data-row-quick">
            <button
              type="button"
              className="icon-btn icon-btn--danger"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              aria-label={t('data.planned.deleteAria', { title: item.title })}
              title={t('common.delete')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="data-row-expand" onClick={(e) => e.stopPropagation()}>
          <PlannedItemForm initial={item} accounts={accounts} submitLabel={t('common.save')} onSubmit={onUpdate} onCancel={onToggle} />
          <div className="data-row-actions">
            <button type="button" className="btn-danger" onClick={onDelete}>
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function PlannedSection({
  accounts, refreshAccounts, refreshRatesQuiet, onFactChanged, operationsRevision = 0, expanded, onToggle, search = '', filter = {},
  doneOpen: propDoneOpen, onToggleDoneOpen,
}) {
  const { t } = useTranslation();
  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [items, setItems] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [internalDoneOpen, setInternalDoneOpen] = useState(false);
  const doneOpen = propDoneOpen !== undefined ? propDoneOpen : internalDoneOpen;
  const toggleDoneOpen = onToggleDoneOpen || (() => setInternalDoneOpen((v) => !v));
  const [showNew, setShowNew] = useState(false);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      const res = await api.listPlannedItems();
      setItems(res.planned_items);
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message || t('data.planned.loadFailed'));
      setStatus('error');
    }
  }, [t]);

  useLoadWhenExpanded(expanded, load, refreshNonce);

  // Удаление или правка операции в блоке «Операции» может сбросить done у
  // плановой (#282). Хук useLoadWhenExpanded грузит список один раз при
  // разворачивании; ревизия операций обновляет уже загруженный список тихо,
  // без сброса статуса в loading (тот же приём, что в OperationsSection).
  const loadedRef = useRef(false);
  useEffect(() => {
    if (status === 'ready' || status === 'error') loadedRef.current = true;
  }, [status]);
  useEffect(() => {
    if (!operationsRevision || !loadedRef.current) return;
    let cancelled = false;
    api.listPlannedItems().then((res) => {
      if (!cancelled) setItems(res.planned_items);
    }).catch(() => {
      // Игнорируем ошибку фонового обновления, чтобы не портить уже показанный список.
    });
    return () => { cancelled = true; };
  }, [operationsRevision]);

  const refresh = useCallback(async () => {
    const res = await api.listPlannedItems();
    setItems(res.planned_items);
    setActionError(null);
  }, []);

  // Правки одной строки (чекбокс, форма правки, удаление) выстраиваются в
  // цепочку — тот же приём, что chainRef/serialize в Data.jsx, и по той же
  // причине: параллельные PATCH к одной строке применились бы в
  // непредсказуемом порядке.
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
    await api.createPlannedItem(payload);
    await refresh();
    await refreshRatesQuiet();
    setShowNew(false);
  });

  const handleUpdate = (item, payload) => serialize(async () => {
    await api.updatePlannedItem(item.id, payload);
    await refresh();
    setExpandedId(null);
  });

  const handleToggleDone = (item) => runAction(() => serialize(async () => {
    await api.updatePlannedItem(item.id, { done: !item.done });
    await refresh();
    await refreshAccounts();
    onFactChanged?.();
  }));

  const handleDelete = (item) => {
    if (!window.confirm(t('data.planned.deleteConfirm', { title: item.title }))) return;
    return runAction(() => serialize(async () => {
      await api.deletePlannedItem(item.id);
      await refresh();
      await refreshRatesQuiet();
      onFactChanged?.();
      setExpandedId(null);
    }));
  };

  const noAccounts = accounts.length === 0;
  const pending = items.filter((i) => !i.done).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const done = items.filter((i) => i.done).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const matchesSearch = (i) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const acc = accounts.find((a) => a.id === i.account_id);
    const hay = [i.title, i.category, acc?.name].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };
  const pendingView = pending.filter(matchesSearch);
  const doneView = done.filter(matchesSearch);

  const rowProps = (item) => ({
    item,
    accounts,
    expanded: expandedId === item.id,
    onToggle: () => setExpandedId((id) => (id === item.id ? null : item.id)),
    onToggleDone: () => handleToggleDone(item),
    onUpdate: (payload) => handleUpdate(item, payload),
    onDelete: () => handleDelete(item),
  });

  return (
    filter.planned !== false && (
    <DataSection
      id="planned"
      title={blockTitle(DATA_BLOCK_DEFS.planned, t)}
      expanded={expanded}
      onToggle={onToggle}
      actions={(
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setShowNew((v) => !v)}
          disabled={noAccounts || status !== 'ready'}
        >
          <Plus size={14} /> {t('data.planned.addShort')}
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
            <p className="data-hint">{t('data.planned.needAccount')}</p>
          )}

          {showNew && !noAccounts && (
            <PlannedItemForm accounts={accounts} submitLabel={t('common.create')} onSubmit={handleCreate} onCancel={() => setShowNew(false)} />
          )}

          {pending.length === 0 && !showNew && (
            <div className="data-empty">
              {/* «Пока нет» врало бы, когда выполненные операции есть и видны
                  тут же строкой ниже — состояние другое, и подпись другая. */}
              <p>{done.length > 0 ? t('data.planned.emptyPending') : t('data.planned.empty')}</p>
              {!noAccounts && (
                <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
                  <Plus size={14} /> {t('data.planned.add')}
                </button>
              )}
            </div>
          )}

          {pendingView.length > 0 && (
            <ul className="data-list">
              {pendingView.map((item) => <PlannedRow key={item.id} {...rowProps(item)} />)}
            </ul>
          )}

          {done.length > 0 && (
            <div className="data-archive">
              <button type="button" className="data-archive-toggle" onClick={toggleDoneOpen}>
                {doneOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t('data.planned.completedSection', { count: done.length })}
              </button>
              {doneOpen && (
                <ul className="data-list">
                  {doneView.map((item) => <PlannedRow key={item.id} {...rowProps(item)} />)}
                </ul>
              )}
            </div>
          )}

          {search.trim() && pendingView.length === 0 && doneView.length === 0 && (
            <p className="data-hint">{t('data.searchNoResults', { query: search })}</p>
          )}
        </>
      )}
      </DataSection>
    )
  );
}
