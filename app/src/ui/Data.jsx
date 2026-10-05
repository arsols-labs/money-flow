// The "Data" screen: accounts with one-tap balance editing and currency rates beside them.
// The balance is an editable field (not a sum of transactions); see docs/2026-08-09-v2-simple-spec.md.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, Archive, ArchiveRestore, Trash2, ChevronDown, ChevronRight, AlertTriangle, Check,
  Search, SlidersHorizontal, X, RotateCcw,
} from 'lucide-react';
import { api } from './api';
import { SectionSkeleton, InlineEditable, DataSection } from './components';
import { suggestedNameUpdate, findSimilarAccount } from './accounts';
import { sectionFromHash } from './dataSections';
import {
  DATA_BLOCK_DEFS,
  DEFAULT_DATA_CONFIG,
  DEFAULT_DATA_FILTERS,
  loadDataConfig,
  saveDataConfig,
  resetDataConfig,
  loadDataFilters,
  saveDataFilters,
  resetDataFilters,
  toggleBlockVisibility,
} from './dataLayout';
import { blockTitle } from './i18nLabels';
import DashboardSettingsModal from './DashboardSettingsModal';
import BackupSection from './BackupSection';
import ResetSection from './ResetSection';
import {
  formatMinor, minorToInputString, parseAmountToMinor,
  normalizeRateInput, formatRelativeDate, daysSince, STALE_RATE_DAYS,
} from './money';
import PlannedSection from './PlannedSection';
import RecurringSection from './RecurringSection';
import OperationsSection from './OperationsSection';
import FiscalReceiptsSection from './FiscalReceiptsSection';
import { useRefreshNonce } from './RefreshContext';

// The balance-reconciliation threshold follows the rates example, but is half as long, and that is not a matter of taste.
// A rate moves by percents between entries and is edited rarely; a balance
// is moved by salary, rent, and groceries, so in two weeks it has diverged from
// the bank almost for certain, and the forecast (S1-4) starts from it.
// A constant, not a settings control: add a separate knob only on
// an explicit request (issue #223).
const STALE_BALANCE_DAYS = 14;

function accountMeta(acc) {
  return [acc.bank, acc.type, acc.account_number, acc.owner, acc.country].filter(Boolean).join(' · ');
}

// existingAccounts is the list for the similar-account warning; only the
// create form needs it, the edit form does not have it (and has no warning either).
//
// Aliases (issue #339) are attached to an account that already exists, so
// the editor is shown only on the edit form (initial is set). The API calls
// themselves come from the imported `api` — a separate prop is not needed.
function AccountForm({ initial, onSubmit, onCancel, submitLabel, existingAccounts = [] }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(() => ({
    name: initial?.name ?? '',
    currency: initial?.currency ?? 'USD',
    bank: initial?.bank ?? '',
    type: initial?.type ?? '',
    account_number: initial?.account_number ?? '',
    owner: initial?.owner ?? '',
    country: initial?.country ?? 'Global',
    balance: initial ? minorToInputString(initial.balance_minor, initial.currency || 'USD') : '0',
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The alias editor lives inside the edit form and keeps a local copy of the account's
  // list — so a deletion/addition does not re-read the whole "Data" screen,
  // and updates only itself. The form mounts again when the
  // row expands, so local state is initialized from the current initial.
  const aliasEditor = useAliasEditor(initial?.id, initial?.aliases ?? []);

  // The balance in the form is taken from initial once, at mount, and the form
  // lives the whole time the row is expanded. During that time the balance can be
  // corrected inline in the header of the same row — and then the form would hold
  // a stale number, and a save that changes currency would roll back the fresh
  // edit, marking it as just confirmed. So the field
  // is pulled again when a different balance arrives from the server; everything
  // else the user has typed is left alone.
  const syncedBalanceRef = useRef(initial?.balance_minor);
  // What was typed by hand is never overwritten: an explicit entry is a signal of intent
  // stronger than a filled-in value. Otherwise an inline balance edit
  // would wipe an amount already entered in the new currency, and also format it by the
  // old one: a typed $34.00 would become 5100 (¥) and go out as $5100.
  const balanceTouchedRef = useRef(false);
  useEffect(() => {
    if (!initial || syncedBalanceRef.current === initial.balance_minor) return;
    syncedBalanceRef.current = initial.balance_minor;
    if (balanceTouchedRef.current) return;
    setForm((f) => ({ ...f, balance: minorToInputString(initial.balance_minor, initial.currency) }));
  }, [initial]);

  // The currency returned to the original — the balance field hid, and its contents
  // no longer mean anything. Clear the "touched" mark so that on the
  // next currency change the current server number is filled in, not
  // leftovers of the previous attempt.
  const currencyMatchesInitial = Boolean(initial) && form.currency.trim().toUpperCase() === initial.currency;
  useEffect(() => {
    if (currencyMatchesInitial) balanceTouchedRef.current = false;
  }, [currencyMatchesInitial]);

  // The default name is "Type · Currency · Country", as soon as the triple is filled in
  // (issue #235). Only on create: an existing account already has a name, and
  // substituting over it would wipe data rather than suggest. So on
  // the edit form the "touched" mark is set from the start.
  const nameTouchedRef = useRef(Boolean(initial));
  useEffect(() => {
    const suggested = suggestedNameUpdate(form, { touched: nameTouchedRef.current });
    if (suggested !== null) setForm((f) => ({ ...f, name: suggested }));
  }, [form]);

  const set = (key) => (e) => {
    if (key === 'balance') balanceTouchedRef.current = true;
    if (key === 'name') nameTouchedRef.current = true;
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  // A similar account is a warning, not a ban: the rule explicitly calls two
  // accounts with one triple (owner, currency, country) legitimate — a "wallet" and
  // "cash at home in the safe" of one person. So the "Create" button stays
  // active, and the warning simply stands in front of it. The name is not part of
  // the comparison: identical names are allowed by the same rule.
  const similarAccount = initial ? null : findSimilarAccount(existingAccounts, form);

  // Changing the currency of an existing account opens the balance field: the amount must
  // be stated in the new currency explicitly (see the comment in submit).
  const currencyChanged = Boolean(initial) && form.currency.trim().toUpperCase() !== initial.currency;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    const name = form.name.trim();
    const currency = (form.currency.trim() || 'USD').toUpperCase();
    const owner = form.owner.trim();
    let country = form.country.trim();
    if (!country) {
      country = 'Global';
    }
    if (!name) { setError(t('data.accounts.nameRequired')); return; }
    if (!currency) { setError(t('data.accounts.currencyRequired')); return; }
    // The owner is required — the server will not accept it empty
    if (!owner) { setError(t('data.accounts.ownerRequired')); return; }

    const payload = { name, currency, owner, country };
    // Optional fields: in edit mode they are sent explicitly (even empty — that is
    // a clear); on create, empty ones are simply not sent.
    for (const key of ['bank', 'type', 'account_number']) {
      const v = form[key].trim();
      if (initial || v) payload[key] = v;
    }

    // The balance goes into the payload when an account is created and when the currency changes. The second case
    // is not a convenience, it is a server requirement: balance_minor is stored in the minor
    // units of its currency, and USD and JPY have different scales, so
    // the amount must be stated again, not inherited silently.
    if (!initial || currency !== initial.currency) {
      try {
        // An empty field counts as zero only when creating an account. When the
        // currency changes this is a confirmation of the amount, and emptiness there means "not entered",
        // not "zero": a filled-in zero would zero the balance silently and with the mark
        // "updated just now".
        payload.balance_minor = parseAmountToMinor(initial ? form.balance : form.balance || '0', currency);
      } catch (err) {
        setError(err.message);
        return;
      }
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
        <span>{t('data.accounts.fieldName')}</span>
        <input value={form.name} onChange={set('name')} disabled={busy} placeholder={t('data.accounts.placeholderName')} autoFocus />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldCurrency')}</span>
        <input value={form.currency} onChange={set('currency')} disabled={busy} placeholder={t('data.accounts.placeholderCurrency')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldBank')}</span>
        <input value={form.bank} onChange={set('bank')} disabled={busy} placeholder={t('data.accounts.placeholderBank')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldType')}</span>
        <input value={form.type} onChange={set('type')} disabled={busy} placeholder={t('data.accounts.placeholderType')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldAccountNumber')}</span>
        <input value={form.account_number} onChange={set('account_number')} disabled={busy} placeholder={t('data.accounts.placeholderAccountNumber')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldOwner')}</span>
        <input value={form.owner} onChange={set('owner')} disabled={busy} placeholder={t('data.accounts.placeholderOwner')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldCountry')}</span>
        <input value={form.country} onChange={set('country')} disabled={busy} placeholder={t('data.accounts.placeholderCountry')} />
      </label>
      {(!initial || currencyChanged) && (
        <label className="data-form-field">
          <span>{initial ? t('data.accounts.fieldBalanceIn', { currency: form.currency.trim().toUpperCase() }) : t('data.accounts.fieldStartingBalance')}</span>
          <input value={form.balance} onChange={set('balance')} disabled={busy} inputMode="decimal" placeholder="0.00" />
          {currencyChanged && (
            <small className="data-form-hint">
              {t('data.accounts.currencyChangedHint')}
            </small>
          )}
        </label>
      )}
      {similarAccount && (
        <div className="data-warning" role="status">
          <AlertTriangle size={14} className="data-warning-icon" />
          <div className="data-warning-body">
            <p>
              {t('data.accounts.similarAccount', { name: similarAccount.name })}
            </p>
          </div>
        </div>
      )}
      {/* The alias editor is only on the edit form of an existing account
          (initial is set): aliases attach to an account that has already been created. The create
          form has no initial, and an empty block there is pointless. */}
      {initial && aliasEditor}
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

// Account alias editor (issue #339): binding virtual cards to a real
// account. Lives inside the edit form of an existing account (`initial` is set) —
// aliases only make sense on an account that has already been created.
//
// It keeps a LOCAL copy of the account's alias list and edits it itself, without
// re-reading the whole "Data" screen: adding/removing an alias on an account does not
// change its balance or the set of accounts, so there is no point in firing GET /accounts for that.
// A fresh list is picked up only when the form mounts
// again (the row expands) — the `initialAliases` argument.
//
// Returns a finished JSX block so AccountForm does not have to carry its state.
function useAliasEditor(accountId, initialAliases) {
  const { t } = useTranslation();
  const [aliases, setAliases] = useState(() => (initialAliases || []).slice());
  const [newAlias, setNewAlias] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Aliases can change from outside (accounts re-read after a balance
  // edit, and so on) — but the form lives inside an expanded row and is usually
  // remounted on such actions. Pick up a fresh list only
  // when it has actually changed by reference, so manual input is not wiped.
  const incoming = initialAliases || [];
  useEffect(() => {
    setAliases((cur) => (cur === incoming ? cur : incoming.slice()));
  }, [incoming]);

  const add = async (e) => {
    e.preventDefault();
    setErr(null);
    const text = newAlias.trim();
    if (!text) {
      setErr(t('data.accounts.aliasesRequired'));
      return;
    }
    setBusy(true);
    try {
      const res = await api.addAccountAlias(accountId, text);
      setAliases((cur) => [...cur, res.alias]);
      setNewAlias('');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (aliasId) => {
    setErr(null);
    setBusy(true);
    try {
      await api.deleteAccountAlias(accountId, aliasId);
      setAliases((cur) => cur.filter((a) => a.id !== aliasId));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="alias-editor">
      <div className="alias-editor-title">{t('data.accounts.aliasesTitle')}</div>
      <p className="data-form-note">
        {t('data.accounts.aliasesDescription')}
      </p>
      {aliases.length === 0 ? (
        <p className="alias-empty">{t('data.accounts.aliasesEmpty')}</p>
      ) : (
        <ul className="alias-list">
          {aliases.map((a) => (
            <li key={a.id} className="alias-item">
              <span className="alias-text">{a.alias_text}</span>
              <button
                type="button"
                className="icon-btn alias-remove"
                onClick={() => remove(a.id)}
                disabled={busy}
                aria-label={t('data.accounts.aliasesDeleteAria', { alias: a.alias_text })}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="alias-add" onSubmit={add}>
        <input
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          disabled={busy}
          placeholder={t('data.accounts.aliasesPlaceholder')}
        />
        <button type="submit" className="btn-secondary" disabled={busy || !newAlias.trim()}>
          {busy ? t('data.accounts.aliasesAdding') : t('data.accounts.aliasesAdd')}
        </button>
      </form>
      {err && <div className="data-form-error">{err}</div>}
    </div>
  );
}

function AccountRow({
  account, expanded, onToggle, onSaveBalance, onConfirmBalance, onUpdate, onArchiveToggle, onDelete,
}) {
  const { t } = useTranslation();
  const meta = accountMeta(account);
  const stale = daysSince(account.balance_updated_at) > STALE_BALANCE_DAYS;

  const onRowKeyDown = (e) => {
    // Only when focus is on the row itself. Otherwise `preventDefault` would swallow
    // activation of the nested balance button: Enter on it from the keyboard would not
    // open the edit, it would expand the row — the balance could be edited only with the mouse.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <li className={`data-row ${account.archived ? 'data-row--archived' : ''} ${stale ? 'data-row--stale' : ''}`}>
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
            <span>{account.name}</span>
          </div>
          {meta && <div className="data-row-meta">{meta}</div>}
        </div>

        <div className="data-row-value">
          <InlineEditable
            className="data-row-balance"
            value={account.balance_minor}
            formatDisplay={(v) => formatMinor(v, account.currency)}
            toEditString={(v) => minorToInputString(v, account.currency)}
            parseValue={(s) => parseAmountToMinor(s, account.currency)}
            onSave={onSaveBalance}
            ariaLabel={t('data.accounts.balanceAria', { name: account.name })}
            inputMode="decimal"
          />
          <div className="data-row-sub">
            {stale && <AlertTriangle size={11} className="data-stale-icon" />}
            {t('data.accounts.updated', { date: formatRelativeDate(account.balance_updated_at) })}{stale ? t('data.accounts.reconcileSoon') : ''}
          </div>
          {/* One-tap confirmation: "checked with the bank, the amount is the same".
              Without it the freshness mark could be moved only by changing
              the amount, that is by lying to oneself (issue #223). The button stands on every
              account, not only a stale one: reconciliation is an ordinary action,
              and hiding it until the threshold would punish
              care. stopPropagation — because the whole row header
              is clickable and without it confirmation would also expand
              the edit form.

              The aria-label STARTS with the visible label, it does not replace it:
              voice control matches the command "click Same amount" to the
              accessible name, and a name without that substring makes the button
              unreachable by voice (WCAG 2.5.3 Label in Name). After that —
              which account it is: there are as many buttons with one label on the screen
              as there are accounts. */}
          <button
            type="button"
            className="link-btn data-confirm-balance"
            onClick={(e) => { e.stopPropagation(); onConfirmBalance(); }}
            aria-label={t('data.accounts.confirmBalanceAria', { name: account.name })}
            title={t('data.accounts.confirmBalanceTitle')}
          >
            <Check size={12} /> {t('data.accounts.confirmBalance')}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="data-row-expand" onClick={(e) => e.stopPropagation()}>
          <AccountForm initial={account} submitLabel={t('common.save')} onSubmit={onUpdate} onCancel={onToggle} />
          <div className="data-row-actions">
            <button type="button" className="btn-secondary" onClick={onArchiveToggle}>
              {account.archived
                ? <><ArchiveRestore size={14} /> {t('data.accounts.unarchive')}</>
                : <><Archive size={14} /> {t('data.accounts.archive')}</>}
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

// initialCode is a prefill from the "currency with no rate" warning: the owner arrived
// here via the button next to a specific code, and there is no point in retyping it by hand.
function RateForm({ baseCurrency, initialCode = '', onSubmit, onCancel }) {
  const { t } = useTranslation();
  const [code, setCode] = useState(initialCode);
  const [rate, setRate] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    const codeNorm = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(codeNorm)) {
      setError(t('data.rates.codeFormat'));
      return;
    }
    // The client check does not replace the server check (#228, the PUT will reject it
    // anyway) — it just saves a round trip on an obvious error.
    if (baseCurrency && codeNorm === baseCurrency) {
      setError(t('data.rates.baseSelf', { code: codeNorm }));
      return;
    }

    let rateNorm;
    try {
      rateNorm = normalizeRateInput(rate);
    } catch (err) {
      setError(err.message);
      return;
    }

    setBusy(true);
    try {
      await onSubmit(codeNorm, rateNorm);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="data-form data-form--inline" onSubmit={submit}>
      <label className="data-form-field">
        <span>{t('data.rates.fieldCode')}</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} placeholder={t('data.rates.placeholderCode')} maxLength={3} autoFocus={!initialCode} />
      </label>
      <label className="data-form-field">
        <span>{baseCurrency ? t('data.rates.fieldRateToBase', { base: baseCurrency }) : t('data.rates.fieldRateToBaseFallback')}</span>
        {/* The code is already filled in — the cursor goes straight to the field that is left to fill. */}
        <input value={rate} onChange={(e) => setRate(e.target.value)} disabled={busy} placeholder={t('data.rates.placeholderRate')} inputMode="decimal" autoFocus={Boolean(initialCode)} />
      </label>
      {error && <div className="data-form-error">{error}</div>}
      <div className="data-form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? t('common.saving') : t('common.add')}</button>
        <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function RateRow({ rate, baseCurrency, onSave, onDelete }) {
  const { t } = useTranslation();
  // A USD rate row is an input error (USD is now the absolute anchor): conversion
  // does not use it, editing it is pointless, and a save will hit 400 anyway.
  // The only meaningful action is to delete it, so the value here is plain
  // text, not InlineEditable.
  const isAnchorCurrency = rate.code === 'USD';
  const stale = !isAnchorCurrency && daysSince(rate.updated_at) > STALE_RATE_DAYS;
  const flagged = stale || isAnchorCurrency;

  return (
    <li className={`data-row data-row--rate ${stale ? 'data-row--stale' : ''} ${isAnchorCurrency ? 'data-row--rate-invalid' : ''}`}>
      <div className="data-row-main">
        <div className="data-row-title">
          {flagged && <AlertTriangle size={13} className="data-stale-icon" />}
          <span className="data-rate-expr">
            {t('data.rates.expression', { code: rate.code })}
            {' '}
            {isAnchorCurrency ? (
              // The currency code is not hidden: "1 USD = 2 USD" shows the nonsense
              // in full and explains the row by itself, while "= 2" would read as a fragment.
              <span className="data-rate-value">{rate.rate} USD</span>
            ) : (
              <InlineEditable
                value={rate.rate}
                formatDisplay={(v) => `${v} USD`}
                toEditString={(v) => v}
                parseValue={normalizeRateInput}
                onSave={onSave}
                ariaLabel={t('data.rates.editAria', { code: rate.code, base: baseCurrency || 'USD' })}
                inputMode="decimal"
              />
            )}
          </span>
        </div>
        <div className="data-row-meta">
          {isAnchorCurrency
            ? t('data.rates.anchorHint')
            : <>{t('data.accounts.updated', { date: formatRelativeDate(rate.updated_at) })}{stale && t('data.rates.staleSuffix')}</>}
        </div>
      </div>
      <button type="button" className="icon-btn" onClick={onDelete} aria-label={t('data.rates.deleteAria', { code: rate.code })}>
        <Trash2 size={14} />
      </button>
    </li>
  );
}

export function DataDashboard({
  config = loadDataConfig(),
  filters = DEFAULT_DATA_FILTERS,
  onUpdateFilter = () => {},
  onToggleSection = () => {},
  onOpenSettings = undefined,
  onResetConfig = undefined,
  accounts = [],
  refreshAccounts = () => {},
  factsRevision = 0,
  bumpFacts = () => {},
  operationsRevision = 0,
  bumpOperations = () => {},
  search = '',
  refreshRatesQuiet = () => {},
  rates = [],
  visibleRates = [],
  missingRates = [],
  baseCurrency = null,
  rateError = null,
  newRateCode = null,
  openRateForm = () => {},
  setNewRateCode = () => {},
  handleCreateRate = () => {},
  handleSaveRate = () => {},
  handleDeleteRate = () => {},
  actionError = null,
  showNewAccount = false,
  setShowNewAccount = () => {},
  handleCreateAccount = () => {},
  matchesAccount = () => true,
  expandedAccountId = null,
  setExpandedAccountId = () => {},
  handleSaveBalance = () => {},
  handleConfirmBalance = () => {},
  handleUpdateAccount = () => {},
  handleArchiveToggle = () => {},
  handleDeleteAccount = () => {},
  thresholdMinor = null,
  handleSaveThreshold = () => {},
}) {
  const { t } = useTranslation();
  const visibleBlocks = config.filter((b) => b.visible);

  if (visibleBlocks.length === 0) {
    return (
      <div className="data-empty-dashboard">
        <p>{t('data.allSectionsHidden')}</p>
        <div className="data-empty-dashboard-actions">
          {onResetConfig && (
            <button type="button" className="btn-secondary" onClick={onResetConfig}>
              <RotateCcw size={14} />
              <span>{t('common.reset')}</span>
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="btn-primary" onClick={onOpenSettings}>
              <SlidersHorizontal size={14} />
              <span>{t('data.configureSections')}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const activeAccounts = accounts.filter((a) => !a.archived);
  const archivedAccounts = accounts.filter((a) => a.archived);

  const renderBlock = (blockId) => {
    switch (blockId) {
      case 'operations':
        return (
          <div key="operations" className="data-block data-block--operations">
            <OperationsSection
              accounts={accounts}
              refreshAccounts={refreshAccounts}
              factsRevision={factsRevision}
              onOperationsChanged={bumpOperations}
              expanded={Boolean(filters.operationsOpen)}
              onToggle={() => onToggleSection('operations')}
              search={search}
              limit={filters.operationsLimit}
              onLimitChange={(l) => onUpdateFilter('operationsLimit', l)}
            />
          </div>
        );

      case 'receipts':
        return (
          <div key="receipts" className="data-block data-block--receipts">
            <FiscalReceiptsSection
              accounts={accounts}
              expanded={Boolean(filters.receiptsOpen)}
              onToggle={() => onToggleSection('receipts')}
              search={search}
              operationsRevision={operationsRevision}
            />
          </div>
        );

      case 'accounts':
        return (
          <div key="accounts" className="data-block data-block--accounts">
            <DataSection
              id="accounts"
              title={blockTitle(DATA_BLOCK_DEFS.accounts, t)}
              expanded={Boolean(filters.accountsOpen)}
              onToggle={() => onToggleSection('accounts')}
              actions={(
                <button type="button" className="btn-secondary" onClick={() => setShowNewAccount((v) => !v)}>
                  <Plus size={14} /> {t('data.accounts.addShort')}
                </button>
              )}
              collapsedActions={activeAccounts.length === 0 ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!filters.accountsOpen) onToggleSection('accounts');
                    setShowNewAccount(true);
                  }}
                >
                  <Plus size={14} /> {t('data.accounts.add')}
                </button>
              ) : null}
            >
              {actionError && <div className="data-error" role="alert">{actionError}</div>}

              {showNewAccount && (
                <AccountForm
                  submitLabel={t('common.create')}
                  onSubmit={handleCreateAccount}
                  onCancel={() => setShowNewAccount(false)}
                  existingAccounts={accounts}
                />
              )}

              {activeAccounts.length === 0 && !showNewAccount && (
                <div className="data-empty">
                  <p>{t('data.accounts.empty')}</p>
                  <button type="button" className="btn-primary" onClick={() => setShowNewAccount(true)}>
                    <Plus size={14} /> {t('data.accounts.add')}
                  </button>
                </div>
              )}

              {activeAccounts.length > 0 && (
                <ul className="data-list">
                  {activeAccounts.filter(matchesAccount).map((acc) => (
                    <AccountRow
                      key={acc.id}
                      account={acc}
                      expanded={expandedAccountId === acc.id}
                      onToggle={() => setExpandedAccountId((id) => (id === acc.id ? null : acc.id))}
                      onSaveBalance={(minor) => handleSaveBalance(acc, minor)}
                      onConfirmBalance={() => handleConfirmBalance(acc)}
                      onUpdate={(payload) => handleUpdateAccount(acc, payload)}
                      onArchiveToggle={() => handleArchiveToggle(acc)}
                      onDelete={() => handleDeleteAccount(acc)}
                    />
                  ))}
                </ul>
              )}

              {archivedAccounts.length > 0 && (
                <div className="data-archive">
                  <button
                    type="button"
                    className="data-archive-toggle"
                    onClick={() => onUpdateFilter('archivedAccountsOpen', !filters.archivedAccountsOpen)}
                  >
                    {filters.archivedAccountsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {t('data.accounts.archiveSection', { count: archivedAccounts.length })}
                  </button>
                  {filters.archivedAccountsOpen && (
                    <ul className="data-list data-list--archived">
                      {archivedAccounts.filter(matchesAccount).map((acc) => (
                        <AccountRow
                          key={acc.id}
                          account={acc}
                          expanded={expandedAccountId === acc.id}
                          onToggle={() => setExpandedAccountId((id) => (id === acc.id ? null : acc.id))}
                          onSaveBalance={(minor) => handleSaveBalance(acc, minor)}
                          onConfirmBalance={() => handleConfirmBalance(acc)}
                          onUpdate={(payload) => handleUpdateAccount(acc, payload)}
                          onArchiveToggle={() => handleArchiveToggle(acc)}
                          onDelete={() => handleDeleteAccount(acc)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {search.trim() && activeAccounts.filter(matchesAccount).length === 0 && archivedAccounts.filter(matchesAccount).length === 0 && !showNewAccount && (
                <p className="data-filter-note">{t('data.searchNoResults', { query: search })}</p>
              )}
            </DataSection>
          </div>
        );

      case 'planned':
        return (
          <div key="planned" className="data-block data-block--planned">
            <PlannedSection
              accounts={accounts}
              refreshAccounts={refreshAccounts}
              refreshRatesQuiet={refreshRatesQuiet}
              onFactChanged={bumpFacts}
              operationsRevision={operationsRevision}
              expanded={Boolean(filters.plannedOpen)}
              onToggle={() => onToggleSection('planned')}
              search={search}
              doneOpen={filters.donePlannedOpen}
              onToggleDoneOpen={() => onUpdateFilter('donePlannedOpen', !filters.donePlannedOpen)}
            />
          </div>
        );

      case 'recurring':
        return (
          <div key="recurring" className="data-block data-block--recurring">
            <RecurringSection
              accounts={accounts}
              refreshAccounts={refreshAccounts}
              refreshRatesQuiet={refreshRatesQuiet}
              onFactChanged={bumpFacts}
              expanded={Boolean(filters.recurringOpen)}
              onToggle={() => onToggleSection('recurring')}
              search={search}
              pausedOpen={filters.pausedRecurringOpen}
              onTogglePausedOpen={() => onUpdateFilter('pausedRecurringOpen', !filters.pausedRecurringOpen)}
            />
          </div>
        );

      case 'rates':
        return (
          <div key="rates" className="data-block data-block--rates">
            <DataSection
              id="rates"
              title={blockTitle(DATA_BLOCK_DEFS.rates, t)}
              expanded={Boolean(filters.ratesOpen)}
              onToggle={() => onToggleSection('rates')}
              actions={(
                <button type="button" className="btn-secondary" onClick={() => (newRateCode === '' ? setNewRateCode(null) : openRateForm(''))}>
                  <Plus size={14} /> {t('data.rates.addShort')}
                </button>
              )}
            >
              <p className="data-hint">{t('data.rates.manualHint')}</p>
              {rateError && <div className="data-error" role="alert">{rateError}</div>}
              {baseCurrency === null && (
                <div className="data-warning" role="status">
                  <AlertTriangle size={14} className="data-warning-icon" />
                  <div className="data-warning-body">
                    <p>{t('data.rates.noBase')}</p>
                  </div>
                </div>
              )}
              {missingRates.length > 0 && (
                <div className="data-warning" role="status">
                  <AlertTriangle size={14} className="data-warning-icon" />
                  <div className="data-warning-body">
                    <p>
                      {t('data.rates.missingRate', {
                        count: missingRates.length,
                        codes: missingRates.join(', '),
                        base: baseCurrency,
                      })}
                    </p>
                    <div className="data-warning-actions">
                      {missingRates.map((code) => (
                        <button key={code} type="button" className="link-btn" onClick={() => openRateForm(code)}>
                          {t('data.rates.addForCode', { code })}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {newRateCode !== null && (
                <RateForm
                  key={newRateCode}
                  baseCurrency={baseCurrency}
                  initialCode={newRateCode}
                  onSubmit={handleCreateRate}
                  onCancel={() => setNewRateCode(null)}
                />
              )}
              {rates.length === 0 && newRateCode === null && (
                <div className="data-empty">
                  <p>{t('data.rates.empty')}</p>
                  <button type="button" className="btn-primary" onClick={() => openRateForm('')}>
                    <Plus size={14} /> {t('data.rates.add')}
                  </button>
                </div>
              )}
              {rates.length > 0 && (
                <ul className="data-list">
                  {visibleRates.map((r) => (
                    <RateRow
                      key={r.code}
                      rate={r}
                      baseCurrency={baseCurrency}
                      onSave={(rateStr) => handleSaveRate(r.code, rateStr)}
                      onDelete={() => handleDeleteRate(r)}
                    />
                  ))}
                </ul>
              )}
              {rates.length > 0 && search.trim() && visibleRates.length === 0 && (
                <p className="data-filter-note">{t('data.searchNoResults', { query: search })}</p>
              )}
            </DataSection>
          </div>
        );

      case 'forecast':
        return (
          <div key="forecast" className="data-block data-block--forecast">
            <section className="data-section">
              <div className="data-section-header">
                <h2>{blockTitle(DATA_BLOCK_DEFS.forecast, t)}</h2>
              </div>
              <p className="data-hint">
                {t('data.forecast.thresholdHint', { currency: baseCurrency })}
              </p>
              {thresholdMinor !== null && (
                <ul className="data-list">
                  <li className="data-row">
                    <div className="data-row-top">
                      <div className="data-row-main">
                        <div className="data-row-title"><span>{t('data.forecast.thresholdLabel')}</span></div>
                      </div>
                      <div className="data-row-value">
                        <InlineEditable
                          className="data-row-balance"
                          value={thresholdMinor}
                          formatDisplay={(v) => formatMinor(v, baseCurrency || 'USD')}
                          toEditString={(v) => minorToInputString(v, baseCurrency || 'USD')}
                          parseValue={(s) => parseAmountToMinor(s, baseCurrency || 'USD')}
                          onSave={handleSaveThreshold}
                          ariaLabel={t('data.forecast.thresholdLabel')}
                          inputMode="decimal"
                        />
                      </div>
                    </div>
                  </li>
                </ul>
              )}
            </section>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="data-dashboard">
      {visibleBlocks.map((block) => renderBlock(block.id))}
    </div>
  );
}

export default function Data({
  isCustomizing: controlledIsCustomizing = undefined,
  onCustomizingChange = undefined,
}) {
  const { t } = useTranslation();
  const [internalCustomizing, setInternalCustomizing] = useState(false);
  const isCustomizing = controlledIsCustomizing !== undefined ? controlledIsCustomizing : internalCustomizing;
  const setIsCustomizing = onCustomizingChange || setInternalCustomizing;

  const [dataConfig, setDataConfig] = useState(loadDataConfig);
  const [dataFilters, setDataFilters] = useState(loadDataFilters);

  const handleConfigChange = useCallback((nextConfig) => {
    setDataConfig(nextConfig);
    saveDataConfig(nextConfig);
  }, []);

  const handleResetConfig = useCallback(() => {
    const reset = resetDataConfig();
    setDataConfig(reset);
  }, []);

  const handleUpdateFilter = useCallback((key, value) => {
    setDataFilters((prev) => {
      const next = { ...prev, [key]: value };
      saveDataFilters(next);
      return next;
    });
  }, []);

  const handleToggleSection = useCallback((key) => {
    const field = `${key}Open`;
    setDataFilters((prev) => {
      const next = { ...prev, [field]: !prev[field] };
      saveDataFilters(next);
      return next;
    });
  }, []);

  const handleResetFilters = useCallback(() => {
    setDataFilters((prev) => {
      const next = {
        ...prev,
        search: '',
      };
      saveDataFilters(next);
      return next;
    });
  }, []);

  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [rates, setRates] = useState([]);
  // Currencies in use that have no rate (issue #193). The server counts them: it
  // alone sees every table that references a currency, not only accounts.
  const [missingRates, setMissingRates] = useState([]);
  // null — the base currency is not configured (`settings.base_currency` is unset or
  // unusable). A default of 'USD' here would be a lie: the screen would show
  // "USD" even when the server itself does not know which currency is base (#228).
  const [baseCurrency, setBaseCurrency] = useState(null);

  // The low-balance warning threshold (issue #198) is read together with
  // the rest of the screen's data. null means "not loaded yet" (distinct from
  // a legitimate 0, which the parser of valid input can also return).
  const [thresholdMinor, setThresholdMinor] = useState(null);

  const [expandedAccountId, setExpandedAccountId] = useState(null);

  const [factsRevision, setFactsRevision] = useState(0);
  const bumpFacts = useCallback(() => setFactsRevision((n) => n + 1), []);
  const [operationsRevision, setOperationsRevision] = useState(0);
  const bumpOperations = useCallback(() => setOperationsRevision((n) => n + 1), []);

  const search = dataFilters.search || '';
  const setSearch = (val) => handleUpdateFilter('search', val);

  const toggleBlock = (key) => {
    const next = toggleBlockVisibility(dataConfig, key);
    handleConfigChange(next);
  };

  const q = search.trim().toLowerCase();
  const matchesAccount = (acc) => {
    if (!q) return true;
    return [acc.name, acc.bank, acc.type, acc.account_number, acc.owner, acc.country]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  };
  const matchesRate = (r) => !q || r.code.toLowerCase().includes(q);
  const visibleAccounts = accounts.filter(matchesAccount);
  const visibleRates = rates.filter(matchesRate);

  // Deep links to screen blocks when the hash changes live (issue #278).
  useEffect(() => {
    const handleHash = () => {
      const section = sectionFromHash(window.location.hash);
      if (section) {
        handleUpdateFilter(`${section}Open`, true);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [handleUpdateFilter]);
  const [showNewAccount, setShowNewAccount] = useState(false);
  // null — the rate form is hidden; a string means it is open with that code in the field (an empty
  // string = the ordinary "Rate" button, a code = a jump from the warning).
  const [newRateCode, setNewRateCode] = useState(null);
  // The form's open count. Comparing by code is not enough: two empty forms opened in a row
  // are indistinguishable, and a response for the first would close the second together with what was typed.
  const rateFormSeq = useRef(0);
  const [actionError, setActionError] = useState(null);
  const [rateError, setRateError] = useState(null);

  // The /fx-rates response is parsed in one place: its three fields are always
  // set together, and they must not drift apart (new rates, an old `missing`).
  const applyRates = useCallback((res) => {
    setRates(res.rates);
    setMissingRates(res.missing || []);
    setBaseCurrency(res.base_currency ?? null);
    // The data has been re-read — the previous complaint about it no longer deserves trust.
    // Without this a 409 "currency in use" would keep hanging after
    // exactly what the banner asked for was done: the account in that currency was removed.
    // The action that produced the error does not clear it itself — that action failed.
    setRateError(null);
  }, []);

  const loadAll = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      // The base currency comes from /fx-rates, not from /settings: `missing`
      // is computed by the server against that same value, and a second source of the same fact
      // would diverge from the first — the server normalizes the value, /settings returns
      // it as stored. One fewer request as well: this screen does not need anything else from settings
      // yet.
      const [accRes, rateRes, settingsRes] = await Promise.all([
        api.listAccounts(), api.listFxRates(), api.getSettings(),
      ]);
      setAccounts(accRes.accounts);
      applyRates(rateRes);
      // The key may be missing entirely (a fresh database) — then the threshold is unset, 0.
      // An unusable value is reduced to the same thing, not shown as NaN:
      // settings are key/value with no types in the schema, and PUT validates only what
      // passed through it; a string written by a database edit that bypassed the API arrives here
      // as-is (the server does exactly the same for the forecast itself — see
      // normalizeThresholdMinor in worker/forecast/load.ts).
      const rawThreshold = Number(settingsRes.settings.low_balance_threshold_minor);
      setThresholdMinor(Number.isSafeInteger(rawThreshold) && rawThreshold >= 0 ? rawThreshold : 0);
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message || t('common.loadFailed'));
      setStatus('error');
    }
  }, [applyRates, t]);

  useEffect(() => { loadAll(); }, [loadAll, refreshNonce]);

  const refreshRates = useCallback(async () => {
    applyRates(await api.listFxRates());
  }, [applyRates]);

  // A variant of refreshRates that never throws. Creating/deleting
  // a planned or recurring operation changes the set of currencies "in use", which
  // the "currency with no rate" warning (missingRates) depends on — sections call
  // this after such actions so the warning does not lag. The same
  // approach already used in refreshAccountsAndRates below: a failure to refresh
  // rates must not look like a failure of the main action, which has already
  // succeeded on the server.
  const refreshRatesQuiet = useCallback(async () => {
    await refreshRates().catch(() => {});
  }, [refreshRates]);

  const refreshAccounts = useCallback(async () => {
    const res = await api.listAccounts();
    setAccounts(res.accounts);
    setActionError(null); // the same as in applyRates, but for account actions
  }, []);

  // Only creating, editing, and deleting an account change the set of currencies "in use" —
  // `missing` depends on them, so rates are re-read as well. A balance
  // edit and archiving do not belong here: an amount does not change the currency, and archived
  // accounts are counted by the server on a par with active ones.
  //
  // A rates failure is swallowed on purpose. The user's action was about
  // an account and has already succeeded — if this error were allowed to surface, the form would say
  // creation failed, and pressing again would create a duplicate (there is no UNIQUE on name in
  // the schema). The cost of swallowing it is that the warning about currencies with no rate stays
  // as it was until the next refresh, and that warning is a hint, not a guarantee.
  const refreshAccountsAndRates = useCallback(async () => {
    const quiet = refreshRates().catch(() => {});
    await refreshAccounts();
    await quiet;
  }, [refreshAccounts, refreshRates]);

  const openRateForm = useCallback((code) => {
    // The counter moves only when the form is actually recreated: its reset
    // is held by key={newRateCode}, and the same code will not remount it.
    // An unconditional increment would mean "opened again" where nothing was
    // opened — and a second click on the same button during submit
    // would leave the form hanging after a successful save.
    if (newRateCode !== code) rateFormSeq.current += 1;
    setNewRateCode(code);
  }, [newRateCode]);

  // Actions with no place of their own for an error in the form (archive/delete)
  // show it here, not only in the console.
  const runAction = useCallback(async (fn) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err.message || t('common.actionFailed'));
    }
  }, [t]);

  // Errors from rate actions live in their own section, not in the shared banner
  // at the top of the screen: with a dozen accounts that banner is off
  // screen, and a refusal to delete a rate that is in use (409) would go unnoticed.
  const runRateAction = useCallback(async (fn) => {
    setRateError(null);
    try {
      await fn();
    } catch (err) {
      setRateError(err.message || t('common.actionFailed'));
    }
  }, [t]);

  // Account edits are lined up in a chain, not sent in parallel. The inline
  // balance editor in the row header and the edit form under it are open
  // at the same time, and a click on "Save" first removes focus from the inline field
  // (that is, commits it) and then submits the form. Two PATCHes to one
  // row would apply in an unpredictable order, and the account could be left
  // with the new currency and the old amount. In the queue, what lands last is what
  // was confirmed last.
  const chainRef = useRef(Promise.resolve());
  const serialize = useCallback((fn) => {
    const next = chainRef.current.then(fn, fn);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);

  const handleSaveBalance = (account, minor) => serialize(async () => {
    await api.updateAccount(account.id, { balance_minor: minor });
    await refreshAccounts();
  });

  // Confirmation goes into the same queue as a balance edit: both actions
  // write balance_updated_at, and an order that drifted apart would leave the mark from
  // the earlier of the two. The error is shown in a banner — the button has no place of its own for it,
  // just like archive and delete.
  const handleConfirmBalance = (account) => runAction(() => serialize(async () => {
    await api.confirmAccountBalance(account.id);
    await refreshAccounts();
  }));

  const handleCreateAccount = (payload) => serialize(async () => {
    await api.createAccount(payload);
    await refreshAccountsAndRates();
    setShowNewAccount(false);
  });

  const handleUpdateAccount = (account, payload) => serialize(async () => {
    await api.updateAccount(account.id, payload);
    await refreshAccountsAndRates();
    setExpandedAccountId(null);
  });

  const handleArchiveToggle = (account) => runAction(() => serialize(async () => {
    await api.updateAccount(account.id, { archived: !account.archived });
    await refreshAccounts();
  }));

  const handleDeleteAccount = (account) => {
    if (!window.confirm(t('data.accounts.deleteConfirm', { name: account.name }))) return;
    return runAction(() => serialize(async () => {
      await api.deleteAccount(account.id);
      await refreshAccountsAndRates();
      setExpandedAccountId(null);
    }));
  };

  // The same write chaining as for an account balance: editing the threshold is a separate
  // settings key, races with other writes do not threaten it, but a shared queue
  // is cheaper than starting a second one for one field.
  const handleSaveThreshold = (minor) => serialize(async () => {
    if (minor < 0) throw new Error(t('data.forecast.thresholdNegative'));
    await api.putSetting('low_balance_threshold_minor', minor);
    setThresholdMinor(minor);
  });

  const handleSaveRate = async (code, rateStr) => {
    await api.putFxRate(code, rateStr);
    await refreshRates();
  };

  const handleCreateRate = async (code, rateStr) => {
    const seq = rateFormSeq.current;
    await api.putFxRate(code, rateStr);
    await refreshRates();
    // Close exactly the form the submit came from. While the PUT was in
    // flight, another form may have been opened — it already has its own code and a typed
    // rate, and it must not be dismissed.
    if (rateFormSeq.current === seq) setNewRateCode(null);
  };

  const handleDeleteRate = (rate) => {
    if (!window.confirm(t('data.rates.deleteConfirm', { code: rate.code }))) return;
    return runRateAction(async () => {
      await api.deleteFxRate(rate.code);
      await refreshRates();
    });
  };

  if (status === 'loading') {
    return <SectionSkeleton />;
  }

  if (status === 'error') {
    return (
      <div className="data-error-panel">
        <p>{loadError}</p>
        <button type="button" className="btn-secondary" onClick={loadAll}>{t('common.retry')}</button>
      </div>
    );
  }

  const hiddenBlockCount = dataConfig.filter((b) => !b.visible).length;
  const activeFilterCount = (search.trim() ? 1 : 0) + hiddenBlockCount;

  const filterBar = (
    <div className="filter-bar data-filter-bar">
      <div className="filter-row">
        <div className="search-box">
          <Search size={15} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('data.searchPlaceholder')}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')} aria-label={t('common.clear')}>
              <X size={14} />
            </button>
          )}
        </div>
        <button
          className={`filter-btn ${activeFilterCount > 0 || isCustomizing ? 'filter-btn--active' : ''}`}
          onClick={() => setIsCustomizing(true)}
          aria-label={t('data.configureSections')}
          title={t('data.configureSections')}
        >
          <SlidersHorizontal size={16} />
          {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}
        </button>
        {activeFilterCount > 0 && (
          <button
            className="filter-btn filter-clear"
            onClick={() => {
              setSearch('');
              handleConfigChange(dataConfig.map((b) => ({ ...b, visible: true })));
            }}
            aria-label={t('data.resetFilters')}
            title={t('data.resetFilters')}
          >
            <RotateCcw size={15} />
          </button>
        )}
      </div>

      <div className="data-block-chips">
        {dataConfig.map((block) => {
          const def = DATA_BLOCK_DEFS[block.id];
          if (!def) return null;
          return (
            <button
              key={block.id}
              className={`chip ${block.visible ? 'chip--active' : ''}`}
              onClick={() => toggleBlock(block.id)}
              aria-pressed={block.visible}
            >
              {blockTitle(def, t)}
            </button>
          );
        })}
      </div>
    </div>
  );

  const effectiveFilters = {
    ...dataFilters,
    operationsOpen: Boolean(dataFilters.operationsOpen) || Boolean(search.trim()),
    receiptsOpen: Boolean(dataFilters.receiptsOpen) || Boolean(search.trim()),
    accountsOpen: Boolean(dataFilters.accountsOpen) || Boolean(search.trim()),
    plannedOpen: Boolean(dataFilters.plannedOpen) || Boolean(search.trim()),
    recurringOpen: Boolean(dataFilters.recurringOpen) || Boolean(search.trim()),
    ratesOpen: Boolean(dataFilters.ratesOpen) || Boolean(search.trim()),
  };

  return (
    <div className="data-screen">
      {filterBar}
      <DataDashboard
        config={dataConfig}
        filters={effectiveFilters}
        onUpdateFilter={handleUpdateFilter}
        onToggleSection={handleToggleSection}
        onOpenSettings={() => setIsCustomizing(true)}
        onResetConfig={handleResetConfig}
        accounts={accounts}
        refreshAccounts={refreshAccounts}
        factsRevision={factsRevision}
        bumpFacts={bumpFacts}
        operationsRevision={operationsRevision}
        bumpOperations={bumpOperations}
        search={search}
        refreshRatesQuiet={refreshRatesQuiet}
        rates={rates}
        visibleRates={visibleRates}
        missingRates={missingRates}
        baseCurrency={baseCurrency}
        rateError={rateError}
        newRateCode={newRateCode}
        openRateForm={openRateForm}
        setNewRateCode={setNewRateCode}
        handleCreateRate={handleCreateRate}
        handleSaveRate={handleSaveRate}
        handleDeleteRate={handleDeleteRate}
        actionError={actionError}
        showNewAccount={showNewAccount}
        setShowNewAccount={setShowNewAccount}
        handleCreateAccount={handleCreateAccount}
        matchesAccount={matchesAccount}
        expandedAccountId={expandedAccountId}
        setExpandedAccountId={setExpandedAccountId}
        handleSaveBalance={handleSaveBalance}
        handleConfirmBalance={handleConfirmBalance}
        handleUpdateAccount={handleUpdateAccount}
        handleArchiveToggle={handleArchiveToggle}
        handleDeleteAccount={handleDeleteAccount}
        thresholdMinor={thresholdMinor}
        handleSaveThreshold={handleSaveThreshold}
      />
      <BackupSection />
      <ResetSection />
      <div className="data-customize-footer">
        <button
          type="button"
          className="data-customize-link"
          onClick={() => setIsCustomizing(true)}
        >
          <SlidersHorizontal size={14} />
          <span>{t('data.configureOrderVisibility')}</span>
        </button>
      </div>

      {isCustomizing && (
        <DashboardSettingsModal
          open={isCustomizing}
          config={dataConfig}
          onChange={handleConfigChange}
          onReset={handleResetConfig}
          onClose={() => setIsCustomizing(false)}
          title={t('data.settingsTitle')}
          description={t('data.settingsDescription')}
          blockDefs={DATA_BLOCK_DEFS}
        />
      )}
    </div>
  );
}
