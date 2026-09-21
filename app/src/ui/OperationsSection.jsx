// Секция «Операции» на экране «Данные» (S1-5a, issue #200): траты, доходы и
// возвраты, введённые вручную. Устройство — как у «Плановых»: форма со своими
// busy/error, действия без формы идут через runAction с общим баннером, правки
// одной строки выстроены в цепочку через serialize.
//
// Три вещи, которыми секция отличается от плановых, и все три идут от того, что
// операция уже случилась (решение владельца 2026-08-12):
//
//   - валюты в форме нет вовсе. Она равна валюте счёта и не правится: с
//     динарового счёта долларовая покупка списывается в динарах;
//   - сумма правит баланс счёта при сохранении, поэтому форма показывает
//     будущий баланс до нажатия «Сохранить», а не после;
//   - вид выбирается явно (трата / доход / возврат) и задаёт знак: возврат и
//     доход оба увеличивают баланс, но «Аналитике» различать их обязательно.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { api } from './api';
import { SectionSkeleton,  DataSection, useLoadWhenExpanded  } from './components';
import { useRefreshNonce } from './RefreshContext';
import { formatMinor, minorToInputString, parseAmountToMinor } from './money';
import { formatDayMonth, todayDateString } from './recurrence';
import { DATA_BLOCK_DEFS } from './dataLayout';
import { blockTitle } from './i18nLabels';
import { compactComment, ReceiptUrlLink } from './ReceiptUrlLink';

// Сколько операций показывать до нажатия «Показать все». Список растёт без
// границы (в v1 позиций уже больше четырёхсот), а «Данные» — экран ввода:
// разбор по периодам и категориям живёт в «Аналитике».
export const KINDS = [
  { key: 'expense', labelKey: 'data.operations.kind.expense', className: 'data-kind-btn--expense' },
  { key: 'income', labelKey: 'data.operations.kind.income', className: 'data-kind-btn--income' },
  { key: 'refund', labelKey: 'data.operations.kind.refund', className: 'data-kind-btn--income' },
  { key: 'transfer', labelKey: 'data.operations.kind.transfer', className: 'data-kind-btn--transfer' },
];

const KIND_I18N_KEYS = {
  expense: 'data.operations.kind.expense',
  income: 'data.operations.kind.income',
  refund: 'data.operations.kind.refund',
  transfer_out: 'data.operations.kind.transferDebit',
  transfer_in: 'data.operations.kind.transferCredit',
  transfer: 'data.operations.kind.transfer',
};

function findAccount(accounts, id) {
  return accounts.find((a) => String(a.id) === String(id));
}

function accountLabel(account, t) {
  if (!account) return '';
  return account.archived ? `${account.name} ${t('common.archivedSuffix')}` : account.name;
}

function formatTransferAmount(operation) {
  if (!operation) return '';
  return formatMinor(Math.abs(operation.amount_minor), operation.currency);
}

function transferCategory(operation) {
  if (!operation) return '';
  if (operation.category && operation.subcategory) return `${operation.category} / ${operation.subcategory}`;
  return operation.category || operation.subcategory || '';
}

function transferNote(operation) {
  if (!operation) return '';
  return [transferCategory(operation), operation.item, operation.store, compactComment(operation.comment)].filter(Boolean).join(' · ');
}

function optionalTextPayload(form, isEdit, keys) {
  const out = {};
  for (const key of keys) {
    const value = (form[key] ?? '').trim();
    if (isEdit || value) out[key] = value;
  }
  return out;
}

function transferSummaryAmount(out, inn) {
  if (out && inn) {
    const sameCurrency = out.currency === inn.currency;
    const sameMagnitude = Math.abs(out.amount_minor) === Math.abs(inn.amount_minor);
    if (sameCurrency && sameMagnitude) return formatTransferAmount(out);
    return `${formatTransferAmount(out)} → ${formatTransferAmount(inn)}`;
  }
  return formatTransferAmount(out || inn);
}

export function OperationForm({ initial = null, accounts, onSubmit, onCancel, submitLabel }) {
  const { t } = useTranslation();
  const isEdit = Boolean(initial);
  const isTransferEdit = isEdit && Boolean(initial.transfer_id);

  const [form, setForm] = useState(() => {
    if (initial) {
      return {
        date: initial.date,
        account_id: initial.account_id,
        from_account_id: initial.account_id,
        to_account_id: accounts.find((a) => a.id !== initial.account_id)?.id ?? initial.account_id,
        kind: initial.kind,
        item: initial.item ?? '',
        store: initial.store ?? '',
        category: initial.category ?? '',
        subcategory: initial.subcategory ?? '',
        comment: initial.comment ?? '',
        receipt_url: initial.receipt_url ?? '',
        fiscal_receipt_id: initial.fiscal_receipt_id ?? '',
        amount: minorToInputString(Math.abs(initial.amount_minor), initial.currency),
        from_amount: minorToInputString(Math.abs(initial.amount_minor), initial.currency),
        to_amount: minorToInputString(Math.abs(initial.amount_minor), initial.currency),
      };
    }
    const defaultFrom = accounts[0]?.id ?? '';
    const defaultTo = accounts.find((a) => a.id !== defaultFrom)?.id ?? defaultFrom;
    return {
      date: todayDateString(),
      account_id: defaultFrom,
      from_account_id: defaultFrom,
      to_account_id: defaultTo,
      kind: 'expense',
      item: '',
      store: '',
      category: '',
      subcategory: '',
      comment: '',
      receipt_url: '',
      fiscal_receipt_id: '',
      amount: '',
      from_amount: '',
      to_amount: '',
    };
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isTransfer = form.kind === 'transfer';

  const set = (key) => (e) => {
    const val = e.target.value;
    setForm((f) => {
      const next = { ...f, [key]: val };
      if (key === 'from_amount') {
        const fromAcc = findAccount(accounts, next.from_account_id);
        const toAcc = findAccount(accounts, next.to_account_id);
        if (fromAcc && toAcc && fromAcc.currency === toAcc.currency) {
          next.to_amount = val;
        }
      }
      return next;
    });
  };

  const account = findAccount(accounts, form.account_id);
  const fromAccount = findAccount(accounts, form.from_account_id);
  const toAccount = findAccount(accounts, form.to_account_id);

  const currency = account?.currency ?? '';
  const fromCurrency = fromAccount?.currency ?? '';
  const toCurrency = toAccount?.currency ?? '';

  // Знак задаёт вид, а не минус в поле: набранный минус берётся по модулю,
  // чтобы он не мог втихую перевернуть трату в доход (тот же приём у плановых).
  const signedMinor = useMemo(() => {
    if (isTransfer) return null;
    if (!currency) return null;
    try {
      const magnitude = Math.abs(parseAmountToMinor(form.amount, currency));
      if (magnitude === 0) return null;
      return (form.kind === 'expense' || form.kind === 'transfer_out') ? -magnitude : magnitude;
    } catch {
      return null;
    }
  }, [form.amount, form.kind, currency, isTransfer]);

  // Главная подсказка формы: операция правит баланс при сохранении, и увидеть
  // это владелец должен ДО нажатия, а не по факту.
  const balancePreview = useMemo(() => {
    if (isTransfer) {
      if (!fromAccount || !toAccount || fromAccount.id === toAccount.id) return null;
      try {
        const fromMag = Math.abs(parseAmountToMinor(form.from_amount, fromCurrency));
        const toMag = Math.abs(parseAmountToMinor(form.to_amount, toCurrency));
        if (fromMag === 0 || toMag === 0) return null;
        return {
          isTransfer: true,
          from: { name: fromAccount.name, currency: fromCurrency, before: fromAccount.balance_minor, after: fromAccount.balance_minor - fromMag },
          to: { name: toAccount.name, currency: toCurrency, before: toAccount.balance_minor, after: toAccount.balance_minor + toMag },
        };
      } catch {
        return null;
      }
    }

    if (!account || signedMinor === null) return null;
    const staysOnSameAccount = isEdit && String(account.id) === String(initial.account_id);
    const wasMinor = staysOnSameAccount ? account.balance_minor - initial.amount_minor : account.balance_minor;
    const movedFrom = isEdit && !staysOnSameAccount ? findAccount(accounts, initial.account_id) : null;
    return { from: wasMinor, to: wasMinor + signedMinor, movedFrom };
  }, [account, accounts, signedMinor, isEdit, initial, isTransfer, fromAccount, toAccount, form.from_amount, form.to_amount, fromCurrency, toCurrency]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!form.date) { setError(t('data.operations.dateRequired')); return; }

    if (isTransfer) {
      if (!form.from_account_id || !form.to_account_id) {
        setError(t('data.operations.bothAccounts')); return;
      }
      if (String(form.from_account_id) === String(form.to_account_id)) {
        setError(t('data.operations.accountsMustDiffer')); return;
      }

      let fromMag, toMag;
      try {
        fromMag = Math.abs(parseAmountToMinor(form.from_amount, fromCurrency));
        toMag = Math.abs(parseAmountToMinor(form.to_amount, toCurrency));
      } catch (err) {
        setError(err.message);
        return;
      }
      if (fromMag === 0 || toMag === 0) { setError(t('data.operations.transferAmountNonZero')); return; }

      const category = form.category.trim();
      const subcategory = form.subcategory.trim();
      if (subcategory && !category) { setError(t('data.operations.subcategoryNeedsCategory')); return; }

      const payload = {
        isTransfer: true,
        date: form.date,
        from_account_id: Number(form.from_account_id),
        to_account_id: Number(form.to_account_id),
        from_amount_minor: fromMag,
        to_amount_minor: toMag,
        ...(form.item.trim() ? { item: form.item.trim() } : {}),
        ...optionalTextPayload(form, isEdit, ['store', 'category', 'subcategory', 'comment', 'receipt_url', 'fiscal_receipt_id']),
      };

      setBusy(true);
      try {
        await onSubmit(payload);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    const item = form.item.trim();
    if (!item) {
      setError(form.kind === 'income' ? t('data.operations.itemIncomeRequired') : isTransferEdit ? t('data.operations.itemRequired') : t('data.operations.itemExpenseRequired'));
      return;
    }
    if (!form.account_id) { setError(t('data.operations.accountRequired')); return; }

    let magnitude;
    try {
      magnitude = Math.abs(parseAmountToMinor(form.amount, currency));
    } catch (err) {
      setError(err.message);
      return;
    }
    if (magnitude === 0) { setError(t('data.operations.amountNonZero')); return; }

    const category = form.category.trim();
    const subcategory = form.subcategory.trim();
    if (subcategory && !category) { setError(t('data.operations.subcategoryNeedsCategory')); return; }

    const sign = (form.kind === 'expense' || form.kind === 'transfer_out') ? -1 : 1;

    const payload = {
      date: form.date,
      account_id: Number(form.account_id),
      kind: form.kind,
      item,
      amount_minor: sign * magnitude,
      ...optionalTextPayload(form, isEdit, ['store', 'category', 'subcategory', 'comment', 'receipt_url', 'fiscal_receipt_id']),
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
    <form className="data-form" onSubmit={submit}>
      <label className="data-form-field">
        <span>{t('data.operations.fieldDate')}</span>
        <input type="date" value={form.date} onChange={set('date')} disabled={busy} />
      </label>

      {!isTransferEdit && (
        <div className="data-form-field">
          <span>{t('data.operations.fieldKind')}</span>
          <div className="data-kind-toggle" role="group" aria-label={t('data.operations.fieldKindAria')}>
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                className={`data-kind-btn ${k.className} ${form.kind === k.key ? 'data-kind-btn--active' : ''}`}
                onClick={() => setForm((f) => ({ ...f, kind: k.key }))}
                disabled={busy || isEdit}
                aria-pressed={form.kind === k.key}
              >
                {t(k.labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      {isTransfer ? (
        <>
          <label className="data-form-field">
            <span>{t('data.operations.fieldFromAccount')}</span>
            <select value={form.from_account_id} onChange={set('from_account_id')} disabled={busy}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a, t)} · {a.currency}</option>
              ))}
            </select>
          </label>

          <label className="data-form-field">
            <span>{t('data.operations.fieldToAccount')}</span>
            <select value={form.to_account_id} onChange={set('to_account_id')} disabled={busy}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a, t)} · {a.currency}</option>
              ))}
            </select>
          </label>

          <label className="data-form-field">
            <span>{t('data.operations.fieldDebitAmount', { currency: fromCurrency || '*' })}</span>
            <input value={form.from_amount} onChange={set('from_amount')} disabled={busy} inputMode="decimal" placeholder="0.00" />
          </label>

          <label className="data-form-field">
            <span>{t('data.operations.fieldCreditAmount', { currency: toCurrency || '*' })}</span>
            <input value={form.to_amount} onChange={set('to_amount')} disabled={busy} inputMode="decimal" placeholder="0.00" />
          </label>

          <label className="data-form-field">
            <span>{t('data.operations.fieldTransferDescription')}</span>
            <input value={form.item} onChange={set('item')} disabled={busy} placeholder={t('data.operations.placeholderTransferDescription')} />
          </label>
        </>
      ) : (
        <>
          <label className="data-form-field">
            <span>{form.kind === 'income' ? t('data.operations.fieldItemIncome') : isTransferEdit ? t('data.operations.fieldItemTransfer') : t('data.operations.fieldItemExpense')}</span>
            <input
              value={form.item}
              onChange={set('item')}
              disabled={busy}
              placeholder={form.kind === 'income' ? t('data.operations.placeholderItemIncome') : isTransferEdit ? t('data.operations.placeholderItemTransfer') : t('data.operations.placeholderItemExpense')}
              autoFocus
            />
          </label>

          <label className="data-form-field">
            <span>{t('data.operations.fieldAccount')}</span>
            <select value={form.account_id} onChange={set('account_id')} disabled={busy || isTransferEdit}>
              {accounts.length === 0 && <option value="">{t('common.noAccountsOption')}</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a, t)} · {a.currency}</option>
              ))}
            </select>
          </label>

          <label className="data-form-field">
            <span>{form.kind === 'income' ? t('data.operations.fieldPayer') : t('data.operations.fieldMerchant')}</span>
            <input
              value={form.store}
              onChange={set('store')}
              disabled={busy}
              placeholder={form.kind === 'income' ? t('data.operations.placeholderPayer') : t('data.operations.placeholderMerchant')}
            />
          </label>
        </>
      )}

      <label className="data-form-field">
        <span>{t('data.operations.fieldCategory')}</span>
        <input value={form.category} onChange={set('category')} disabled={busy} placeholder={t('data.operations.placeholderCategory')} />
      </label>

      <label className="data-form-field">
        <span>{t('data.operations.fieldSubcategory')}</span>
        <input value={form.subcategory} onChange={set('subcategory')} disabled={busy} placeholder={t('data.operations.placeholderSubcategory')} />
      </label>

      {!isTransfer && (
        <label className="data-form-field">
          <span>{t('data.operations.fieldAmount', { currency: currency || '*' })}</span>
          <input value={form.amount} onChange={set('amount')} disabled={busy || isTransferEdit} inputMode="decimal" placeholder="0.00" />
          {balancePreview && !balancePreview.isTransfer && (
            <small className="data-form-hint">
              {t('data.operations.balancePreview', {
                from: formatMinor(balancePreview.from, currency),
                to: formatMinor(balancePreview.to, currency),
              })}
              {balancePreview.movedFrom && t('data.operations.balanceRevert', {
                name: balancePreview.movedFrom.name,
                amount: formatMinor(Math.abs(initial.amount_minor), balancePreview.movedFrom.currency),
              })}
            </small>
          )}
        </label>
      )}

      {balancePreview?.isTransfer && (
        <div className="data-form-hint" style={{ marginTop: 6, marginBottom: 6 }}>
          <span>{t('data.operations.transferDebitPreview', {
            from: balancePreview.from.name,
            fromBefore: formatMinor(balancePreview.from.before, balancePreview.from.currency),
            fromAfter: formatMinor(balancePreview.from.after, balancePreview.from.currency),
          })}</span>
          <br />
          <span>{t('data.operations.transferCreditPreview', {
            to: balancePreview.to.name,
            toBefore: formatMinor(balancePreview.to.before, balancePreview.to.currency),
            toAfter: formatMinor(balancePreview.to.after, balancePreview.to.currency),
          })}</span>
        </div>
      )}

      <label className="data-form-field">
        <span>{t('data.operations.fieldComment')}</span>
        <input value={form.comment} onChange={set('comment')} disabled={busy} placeholder={t('data.operations.placeholderComment')} />
      </label>

      <label className="data-form-field">
        <span>{t('data.operations.fieldFiscalReceiptId')}</span>
        <input value={form.fiscal_receipt_id} onChange={set('fiscal_receipt_id')} disabled={busy} placeholder={t('data.operations.placeholderFiscalReceiptId')} autoComplete="off" />
      </label>

      <label className="data-form-field">
        <span>{t('data.operations.fieldReceiptUrl')}</span>
        <input value={form.receipt_url} onChange={set('receipt_url')} disabled={busy} placeholder={t('data.operations.placeholderReceiptUrl')} inputMode="url" autoComplete="off" />
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

function OperationRow({ operation, accounts, expanded, onToggle, onUpdate, onDelete }) {
  const { t } = useTranslation();
  const account = findAccount(accounts, operation.account_id);
  const isTransfer = Boolean(operation.transfer_id);
  const kindTag = KIND_I18N_KEYS[operation.kind] ? t(KIND_I18N_KEYS[operation.kind]) : '';
  const meta = [
    account?.name,
    isTransfer ? kindTag : operation.store,
    operation.category,
    operation.subcategory,
    compactComment(operation.comment),
  ]
    .filter(Boolean)
    .join(' · ');
  const isExpense = operation.amount_minor < 0;

  const onRowKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <li className={expanded ? 'data-row data-row--selected' : 'data-row'}>
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
            <span className="data-row-date">{formatDayMonth(operation.date)}</span>
            <span>{operation.item}</span>
          </div>
          {meta && (
            <div className="data-row-meta">
              {meta}
              {operation.receipt_url ? <> · <ReceiptUrlLink url={operation.receipt_url} /></> : null}
            </div>
          )}
          {!meta && operation.receipt_url ? (
            <div className="data-row-meta"><ReceiptUrlLink url={operation.receipt_url} /></div>
          ) : null}
        </div>

        <div className="data-row-value">
          <span className={`data-amount ${isExpense ? 'data-amount--expense' : 'data-amount--income'}`}>
            {formatMinor(operation.amount_minor, operation.currency)}
          </span>
          {operation.kind === 'refund' && <div className="data-row-meta">{t('data.operations.kind.refund')}</div>}
          {isTransfer && <div className="data-row-meta">🔄 {operation.kind === 'transfer_out' ? t('data.operations.debit') : t('data.operations.credit')}</div>}
        </div>
      </div>

      {expanded && (
        <div className="data-row-expand ops-inline-expand" onClick={(e) => e.stopPropagation()}>
          <OperationForm
            initial={operation}
            accounts={accounts}
            submitLabel={t('common.save')}
            onSubmit={onUpdate}
            onCancel={onToggle}
          />
          <div className="data-row-actions">
            <button type="button" className="btn-danger" onClick={onDelete}>
              <Trash2 size={14} /> {isTransfer ? t('common.deleteTransfer') : t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// Перевод показываем одной строкой (#378): дата, «Перевод», счёт-источник →
// счёт-назначение и суммы обеих сторон. Раскрытие показывает обе операции
// (списание и зачисление) вместе с кнопкой удаления всей пары.
export function TransferRow({ out, inn, accounts, expanded, onToggle, onDelete, onUpdate = () => {} }) {
  const { t } = useTranslation();
  const fromAcc = findAccount(accounts, out?.account_id);
  const toAcc = findAccount(accounts, inn?.account_id);
  const date = out?.date || inn?.date || '';
  const route = `${fromAcc ? accountLabel(fromAcc, t) : t('common.emptyDash')} → ${toAcc ? accountLabel(toAcc, t) : t('common.emptyDash')}`;
  const summary = transferSummaryAmount(out, inn);
  const transferUrl = out?.receipt_url || inn?.receipt_url || '';
  const onRowKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  const [editing, setEditing] = useState(false);
  const [fromAmount, setFromAmount] = useState(minorToInputString(Math.abs(out?.amount_minor ?? 0), fromAcc?.currency ?? ''));
  const [toAmount, setToAmount] = useState(minorToInputString(Math.abs(inn?.amount_minor ?? 0), toAcc?.currency ?? ''));
  const [item, setItem] = useState(out?.item ?? inn?.item ?? '');
  const [comment, setComment] = useState(out?.comment ?? inn?.comment ?? '');
  const [receiptUrl, setReceiptUrl] = useState(out?.receipt_url ?? inn?.receipt_url ?? '');
  const [fiscalReceiptId, setFiscalReceiptId] = useState(out?.fiscal_receipt_id ?? inn?.fiscal_receipt_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const startEdit = () => {
    setFromAmount(minorToInputString(Math.abs(out?.amount_minor ?? 0), fromAcc?.currency ?? ''));
    setToAmount(minorToInputString(Math.abs(inn?.amount_minor ?? 0), toAcc?.currency ?? ''));
    setItem(out?.item ?? inn?.item ?? '');
    setComment(out?.comment ?? inn?.comment ?? '');
    setReceiptUrl(out?.receipt_url ?? inn?.receipt_url ?? '');
    setFiscalReceiptId(out?.fiscal_receipt_id ?? inn?.fiscal_receipt_id ?? '');
    setError(null);
    setEditing(true);
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    setError(null);
    let fromMag, toMag;
    try {
      fromMag = Math.abs(parseAmountToMinor(fromAmount, fromAcc?.currency));
      toMag = Math.abs(parseAmountToMinor(toAmount, toAcc?.currency));
    } catch (err) {
      setError(err.message);
      return;
    }
    if (fromMag === 0 || toMag === 0) { setError(t('data.operations.transferAmountNonZero')); return; }
    setBusy(true);
    try {
      await onUpdate({
        date,
        from_account_id: out?.account_id,
        to_account_id: inn?.account_id,
        from_amount_minor: fromMag,
        to_amount_minor: toMag,
        ...(item.trim() ? { item: item.trim() } : {}),
        ...(out?.store ? { store: out.store } : {}),
        ...(out?.category ? { category: out.category } : {}),
        ...(out?.subcategory ? { subcategory: out.subcategory } : {}),
        comment: comment.trim(),
        receipt_url: receiptUrl.trim(),
        fiscal_receipt_id: fiscalReceiptId.trim(),
      });
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={expanded ? 'data-row data-row--transfer data-row--selected' : 'data-row data-row--transfer'}>
      <div
        className="data-row-top"
        onClick={editing ? undefined : onToggle}
        onKeyDown={editing ? undefined : onRowKeyDown}
        role={editing ? undefined : 'button'}
        tabIndex={editing ? undefined : 0}
        aria-expanded={expanded}
      >
        <div className="data-row-main">
          <div className="data-row-title">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="data-row-date">{date}</span>
            <span>{t('data.operations.kind.transfer')}</span>
          </div>
          <div className="data-row-meta">
            {route}
            {transferUrl ? <> · <ReceiptUrlLink url={transferUrl} /></> : null}
          </div>
        </div>
        <div className="data-row-value">
          <span className="data-amount data-amount--transfer">{summary}</span>
        </div>
      </div>

      {editing ? (
        <div className="data-row-expand ops-inline-expand" onClick={(e) => e.stopPropagation()}>
          <form className="data-form" onSubmit={submitEdit}>
            <label className="data-form-field">
              <span>{t('data.operations.fieldDebitAmount', { currency: fromAcc?.currency || '*' })}</span>
              <input value={fromAmount} onChange={(e) => setFromAmount(e.target.value)} disabled={busy} inputMode="decimal" placeholder="0.00" />
            </label>
            <label className="data-form-field">
              <span>{t('data.operations.fieldCreditAmount', { currency: toAcc?.currency || '*' })}</span>
              <input value={toAmount} onChange={(e) => setToAmount(e.target.value)} disabled={busy} inputMode="decimal" placeholder="0.00" />
            </label>
            <label className="data-form-field">
              <span>{t('data.operations.fieldTransferDescription')}</span>
              <input value={item} onChange={(e) => setItem(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderTransferDescription')} />
            </label>
            <label className="data-form-field">
              <span>{t('data.operations.fieldComment')}</span>
              <input value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderComment')} />
            </label>
            <label className="data-form-field">
              <span>{t('data.operations.fieldFiscalReceiptId')}</span>
              <input value={fiscalReceiptId} onChange={(e) => setFiscalReceiptId(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderFiscalReceiptId')} autoComplete="off" />
            </label>
            <label className="data-form-field">
              <span>{t('data.operations.fieldReceiptUrl')}</span>
              <input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderReceiptUrl')} inputMode="url" autoComplete="off" />
            </label>
            {error && <div className="data-form-error">{error}</div>}
            <div className="data-form-actions">
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? t('common.saving') : t('common.save')}</button>
              <button type="button" className="link-btn" onClick={() => setEditing(false)} disabled={busy}>{t('common.cancel')}</button>
            </div>
          </form>
        </div>
      ) : expanded && (
        <div className="data-row-expand ops-inline-expand">
          {out && (
            <div className="transfer-detail-card">
              <div className="data-row-main">
                <div className="data-row-title">
                  <span>{t('data.operations.debitAccount', { account: accountLabel(fromAcc, t) })}</span>
                </div>
                {transferNote(out) && <div className="data-row-meta">{transferNote(out)}</div>}
                {out.receipt_url ? <div className="data-row-meta"><ReceiptUrlLink url={out.receipt_url} /></div> : null}
              </div>
              <div className="data-row-value">
                <span className="data-amount data-amount--expense">{formatTransferAmount(out)}</span>
              </div>
            </div>
          )}
          {inn && (
            <div className="transfer-detail-card">
              <div className="data-row-main">
                <div className="data-row-title">
                  <span>{t('data.operations.creditAccount', { account: accountLabel(toAcc, t) })}</span>
                </div>
                {transferNote(inn) && <div className="data-row-meta">{transferNote(inn)}</div>}
                {inn.receipt_url ? <div className="data-row-meta"><ReceiptUrlLink url={inn.receipt_url} /></div> : null}
              </div>
              <div className="data-row-value">
                <span className="data-amount data-amount--income">{formatTransferAmount(inn)}</span>
              </div>
            </div>
          )}
          <div className="data-row-actions">
            <button type="button" className="link-btn" onClick={startEdit}>{t('common.edit')}</button>
            <button type="button" className="btn-danger" onClick={onDelete}>
              <Trash2 size={14} /> {t('common.deleteTransfer')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function TransferDetailView({ out, inn, accounts, onUpdate, onDelete, onClose }) {
  const { t } = useTranslation();
  const fromAcc = findAccount(accounts, out?.account_id);
  const toAcc = findAccount(accounts, inn?.account_id);
  const date = out?.date || inn?.date || '';
  const [editing, setEditing] = useState(false);
  const [fromAmount, setFromAmount] = useState(minorToInputString(Math.abs(out?.amount_minor ?? 0), fromAcc?.currency ?? ''));
  const [toAmount, setToAmount] = useState(minorToInputString(Math.abs(inn?.amount_minor ?? 0), toAcc?.currency ?? ''));
  const [item, setItem] = useState(out?.item ?? inn?.item ?? '');
  const [comment, setComment] = useState(out?.comment ?? inn?.comment ?? '');
  const [receiptUrl, setReceiptUrl] = useState(out?.receipt_url ?? inn?.receipt_url ?? '');
  const [fiscalReceiptId, setFiscalReceiptId] = useState(out?.fiscal_receipt_id ?? inn?.fiscal_receipt_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const startEdit = () => {
    setFromAmount(minorToInputString(Math.abs(out?.amount_minor ?? 0), fromAcc?.currency ?? ''));
    setToAmount(minorToInputString(Math.abs(inn?.amount_minor ?? 0), toAcc?.currency ?? ''));
    setItem(out?.item ?? inn?.item ?? '');
    setComment(out?.comment ?? inn?.comment ?? '');
    setReceiptUrl(out?.receipt_url ?? inn?.receipt_url ?? '');
    setFiscalReceiptId(out?.fiscal_receipt_id ?? inn?.fiscal_receipt_id ?? '');
    setError(null);
    setEditing(true);
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    setError(null);
    let fromMag, toMag;
    try {
      fromMag = Math.abs(parseAmountToMinor(fromAmount, fromAcc?.currency));
      toMag = Math.abs(parseAmountToMinor(toAmount, toAcc?.currency));
    } catch (err) {
      setError(err.message);
      return;
    }
    if (fromMag === 0 || toMag === 0) { setError(t('data.operations.transferAmountNonZero')); return; }
    setBusy(true);
    try {
      await onUpdate({
        date,
        from_account_id: out?.account_id,
        to_account_id: inn?.account_id,
        from_amount_minor: fromMag,
        to_amount_minor: toMag,
        ...(item.trim() ? { item: item.trim() } : {}),
        ...(out?.store ? { store: out.store } : {}),
        ...(out?.category ? { category: out.category } : {}),
        ...(out?.subcategory ? { subcategory: out.subcategory } : {}),
        comment: comment.trim(),
        receipt_url: receiptUrl.trim(),
        fiscal_receipt_id: fiscalReceiptId.trim(),
      });
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form className="data-form" onSubmit={submitEdit}>
        <label className="data-form-field">
          <span>{t('data.operations.fieldDebitAmount', { currency: fromAcc?.currency || '*' })}</span>
          <input value={fromAmount} onChange={(e) => setFromAmount(e.target.value)} disabled={busy} inputMode="decimal" placeholder="0.00" />
        </label>
        <label className="data-form-field">
          <span>{t('data.operations.fieldCreditAmount', { currency: toAcc?.currency || '*' })}</span>
          <input value={toAmount} onChange={(e) => setToAmount(e.target.value)} disabled={busy} inputMode="decimal" placeholder="0.00" />
        </label>
        <label className="data-form-field">
          <span>{t('data.operations.fieldTransferDescription')}</span>
          <input value={item} onChange={(e) => setItem(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderTransferDescription')} />
        </label>
        <label className="data-form-field">
          <span>{t('data.operations.fieldComment')}</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderComment')} />
        </label>
        <label className="data-form-field">
          <span>{t('data.operations.fieldFiscalReceiptId')}</span>
          <input value={fiscalReceiptId} onChange={(e) => setFiscalReceiptId(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderFiscalReceiptId')} autoComplete="off" />
        </label>
        <label className="data-form-field">
          <span>{t('data.operations.fieldReceiptUrl')}</span>
          <input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} disabled={busy} placeholder={t('data.operations.placeholderReceiptUrl')} inputMode="url" autoComplete="off" />
        </label>
        {error && <div className="data-form-error">{error}</div>}
        <div className="data-form-actions">
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? t('common.saving') : t('common.save')}</button>
          <button type="button" className="link-btn" onClick={() => setEditing(false)} disabled={busy}>{t('common.cancel')}</button>
        </div>
      </form>
    );
  }

  return (
    <div className="transfer-detail-wrap">
      {out && (
        <div className="transfer-detail-card" style={{ marginBottom: 8 }}>
          <div className="data-row-main">
            <div className="data-row-title">
              <span>{t('data.operations.debitAccount', { account: accountLabel(fromAcc, t) })}</span>
            </div>
            {transferNote(out) && <div className="data-row-meta">{transferNote(out)}</div>}
            {out.receipt_url ? <div className="data-row-meta"><ReceiptUrlLink url={out.receipt_url} /></div> : null}
          </div>
          <div className="data-row-value">
            <span className="data-amount data-amount--expense">{formatTransferAmount(out)}</span>
          </div>
        </div>
      )}
      {inn && (
        <div className="transfer-detail-card" style={{ marginBottom: 12 }}>
          <div className="data-row-main">
            <div className="data-row-title">
              <span>{t('data.operations.creditAccount', { account: accountLabel(toAcc, t) })}</span>
            </div>
            {transferNote(inn) && <div className="data-row-meta">{transferNote(inn)}</div>}
            {inn.receipt_url ? <div className="data-row-meta"><ReceiptUrlLink url={inn.receipt_url} /></div> : null}
          </div>
          <div className="data-row-value">
            <span className="data-amount data-amount--income">{formatTransferAmount(inn)}</span>
          </div>
        </div>
      )}
      <div className="data-row-actions">
        <button type="button" className="link-btn" onClick={startEdit}>{t('common.edit')}</button>
        <button type="button" className="btn-danger" onClick={onDelete}>
          <Trash2 size={14} /> {t('common.deleteTransfer')}
        </button>
        {onClose && <button type="button" className="link-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>{t('common.close')}</button>}
      </div>
    </div>
  );
}

export default function OperationsSection({
  accounts, refreshAccounts, factsRevision = 0, onOperationsChanged, expanded, onToggle, search = '', filter = {},
  limit: propLimit, onLimitChange: propOnLimitChange,
}) {
  const { t } = useTranslation();
  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [operations, setOperations] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  // Пагинация (issue #379): по умолчанию 10 последних; лимит-селект
  // 10/20/50/100/все; «Показать ещё» добавляет по 10 к видимому.
  const [internalLimit, setInternalLimit] = useState(10);
  const limit = propLimit !== undefined ? propLimit : internalLimit;
  const [visibleCount, setVisibleCount] = useState(limit === 'all' ? Number.MAX_SAFE_INTEGER : (typeof limit === 'number' ? limit : 10));
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    setVisibleCount(limit === 'all' ? Number.MAX_SAFE_INTEGER : (typeof limit === 'number' ? limit : 10));
  }, [limit]);

  // Сброс видимого числа при смене лимита, чтобы «все» сразу раскрывал список,
  // а возврат к 10 не оставлял старые 50 на экране.
  const changeLimit = (n) => {
    if (propOnLimitChange) propOnLimitChange(n);
    else setInternalLimit(n);
    setVisibleCount(n === 'all' ? Number.MAX_SAFE_INTEGER : n);
  };

  // Список для отображения (issue #377 #378 #379):
  // 1) фильтр по поиску (item/store/category/счёт) — client-side поверх
  //    уже загруженного списка;
  // 2) группировка пар transfer_out/transfer_in в одну карточку перевода;
  // 3) пагинация поверх сгруппированного списка.
  const matchesSearch = (op) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const acc = findAccount(accounts, op.account_id);
    const hay = [op.item, op.store, op.category, op.subcategory, op.comment, op.receipt_url, op.fiscal_receipt_id, acc?.name].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };

  const displayList = useMemo(() => {
    const filtered = operations.filter(matchesSearch);
    // Группируем переводы: transfer_id одинаков у списания и зачисления.
    const items = [];
    const seen = new Set();
    for (const op of filtered) {
      if (op.transfer_id && !seen.has(op.transfer_id)) {
        seen.add(op.transfer_id);
        const pair = filtered.filter((o) => o.transfer_id === op.transfer_id);
        const out = pair.find((o) => o.kind === 'transfer_out') ?? pair[0];
        const inn = pair.find((o) => o.kind === 'transfer_in') ?? pair[1];
        items.push({ type: 'transfer', transferId: op.transfer_id, out, inn });
      } else if (!op.transfer_id) {
        items.push({ type: 'op', op });
      }
    }
    return items;
  }, [operations, search, accounts]);

  const visible = displayList.slice(0, visibleCount);
  const hidden = displayList.length - visible.length;

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      const res = await api.listOperations();
      setOperations(res.operations);
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message || t('data.operations.loadFailed'));
      setStatus('error');
    }
  }, [t]);

  useLoadWhenExpanded(expanded, load, refreshNonce);

  // Плановая галочка создаёт или удаляет факт в другом блоке (#267). Хук выше
  // грузит список один раз; без этого ревизия оставила бы открытый блок со
  // старым списком до перезагрузки. Тихий refresh, без «загрузка…»: мигание
  // чужой секции хуже слегка устаревшего кадра на один кадр сети.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (status === 'ready' || status === 'error') loadedRef.current = true;
  }, [status]);
  useEffect(() => {
    if (!factsRevision || !loadedRef.current) return;
    let cancelled = false;
    api.listOperations().then((res) => {
      if (!cancelled) setOperations(res.operations);
    }).catch(() => {
      // Список, который уже на экране, лучше оставить, чем погасить его ошибкой
      // соседнего блока.
    });
    return () => { cancelled = true; };
  }, [factsRevision]);

  // Счета перечитываются после каждого действия, и это не перестраховка: их
  // балансы только что изменились на сервере. Без этого форма показывала бы
  // будущий баланс от устаревшего значения, а строка счёта выше — старую сумму.
  const refresh = useCallback(async () => {
    const res = await api.listOperations();
    setOperations(res.operations);
    setActionError(null);
    await refreshAccounts();
  }, [refreshAccounts]);

  // Цепочка правок одной строки — тот же приём и та же причина, что у плановых:
  // параллельные PATCH применились бы в непредсказуемом порядке, а здесь это
  // ещё и разъехавшийся баланс.
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
    if (payload.isTransfer) {
      const { isTransfer, ...transferPayload } = payload;
      await api.createTransfer(transferPayload);
    } else {
      await api.createOperation(payload);
    }
    await refresh();
    onOperationsChanged?.();
    setShowNew(false);
  });

  const handleUpdate = (operation, payload) => serialize(async () => {
    await api.updateOperation(operation.id, payload);
    await refresh();
    onOperationsChanged?.();
    setExpandedId(null);
  });

  const handleUpdateTransfer = (transferId, payload) => serialize(async () => {
    await api.updateTransfer(transferId, payload);
    await refresh();
    onOperationsChanged?.();
    setExpandedId(null);
  });

  const handleDelete = (operation) => {
    const isTransfer = Boolean(operation.transfer_id);
    const msg = isTransfer
      ? t('data.operations.deleteTransferConfirm')
      : t('data.operations.deleteConfirm', { item: operation.item });
    if (!window.confirm(msg)) return;
    return runAction(() => serialize(async () => {
      if (isTransfer) {
        await api.deleteTransfer(operation.transfer_id);
      } else {
        await api.deleteOperation(operation.id);
      }
      await refresh();
      onOperationsChanged?.();
      setExpandedId(null);
    }));
  };

  const noAccounts = accounts.length === 0;

  const selectedEntry = useMemo(() => {
    if (!expandedId) return null;
    return displayList.find((e) => {
      if (e.type === 'transfer') return `t-${e.transferId}` === expandedId;
      return e.op.id === expandedId;
    }) ?? null;
  }, [expandedId, displayList]);

  return (
    filter.operations !== false && (
    <DataSection
      id="operations"
      title={blockTitle(DATA_BLOCK_DEFS.operations, t)}
      expanded={expanded}
      onToggle={onToggle}
      actions={(
        <button
          type="button"
          className="btn-secondary"
          onClick={() => { setShowNew((v) => !v); setExpandedId(null); }}
          disabled={noAccounts || status !== 'ready'}
        >
          <Plus size={14} /> {t('data.operations.addShort')}
        </button>
      )}
    >
      <div className="ops-adaptive-container">
        <p className="data-hint">
          {t('data.operations.hint')}
        </p>

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
            <p className="data-hint">{t('data.operations.needAccount')}</p>
          )}

          {showNew && !noAccounts && (
            <div className="ops-new-inline">
              <OperationForm
                accounts={accounts}
                submitLabel={t('common.create')}
                onSubmit={handleCreate}
                onCancel={() => setShowNew(false)}
              />
            </div>
          )}

          {operations.length === 0 && !showNew && (
            <div className="data-empty">
              <p>{t('data.operations.empty')}</p>
              {!noAccounts && (
                <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
                  <Plus size={14} /> {t('data.operations.add')}
                </button>
              )}
            </div>
          )}

          {displayList.length > 0 && (
            <div className="ops-adaptive-layout">
              <div className="ops-master-pane">
                <div className="ops-toolbar">
                  <label className="ops-limit">
                    <span>{t('data.operations.showLimit')}</span>
                    <select value={limit} onChange={(e) => changeLimit(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value="all">{t('common.all')}</option>
                    </select>
                    {limit !== 10 && (
                      <button
                        type="button"
                        className="filter-reset-icon-btn"
                        onClick={() => changeLimit(10)}
                        title={t('data.operations.resetLimit')}
                        aria-label={t('data.operations.resetLimit')}
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                  </label>
                  <span className="ops-count">{t('data.operations.recordCount', { count: displayList.length, unit: t('plural.record', { count: displayList.length }) })}</span>
                </div>

                <ul className="data-list">
                  {visible.map((entry) => (
                    entry.type === 'transfer' ? (
                      <TransferRow
                        key={`t-${entry.transferId}`}
                        out={entry.out}
                        inn={entry.inn}
                        accounts={accounts}
                        expanded={expandedId === `t-${entry.transferId}`}
                        onToggle={() => {
                          setShowNew(false);
                          setExpandedId((id) => (id === `t-${entry.transferId}` ? null : `t-${entry.transferId}`));
                        }}
                        onDelete={() => handleDelete({ transfer_id: entry.transferId, kind: 'transfer', id: entry.out?.id })}
                        onUpdate={(payload) => handleUpdateTransfer(entry.transferId, payload)}
                      />
                    ) : (
                      <OperationRow
                        key={entry.op.id}
                        operation={entry.op}
                        accounts={accounts}
                        expanded={expandedId === entry.op.id}
                        onToggle={() => {
                          setShowNew(false);
                          setExpandedId((id) => (id === entry.op.id ? null : entry.op.id));
                        }}
                        onUpdate={(payload) => handleUpdate(entry.op, payload)}
                        onDelete={() => handleDelete(entry.op)}
                      />
                    )
                  ))}
                </ul>

                {hidden > 0 && limit !== 'all' && (
                  <button type="button" className="link-btn" onClick={() => setVisibleCount((c) => c + 10)}>
                    {t('common.showMore', { count: hidden })}
                  </button>
                )}
              </div>

              {/* Правая панель (Detail pane) для широких экранов */}
              <div className="ops-detail-pane">
                {showNew && !noAccounts ? (
                  <div className="card ops-detail-card">
                    <div className="card-head">
                      <span className="card-title">{t('data.operations.newTitle')}</span>
                    </div>
                    <OperationForm
                      accounts={accounts}
                      submitLabel={t('common.create')}
                      onSubmit={handleCreate}
                      onCancel={() => setShowNew(false)}
                    />
                  </div>
                ) : selectedEntry ? (
                  selectedEntry.type === 'transfer' ? (
                    <div className="card ops-detail-card">
                      <div className="card-head">
                        <span className="card-title">{t('data.operations.kind.transfer')}</span>
                      </div>
                      <TransferDetailView
                        out={selectedEntry.out}
                        inn={selectedEntry.inn}
                        accounts={accounts}
                        onUpdate={(payload) => handleUpdateTransfer(selectedEntry.transferId, payload)}
                        onDelete={() => handleDelete({ transfer_id: selectedEntry.transferId, kind: 'transfer', id: selectedEntry.out?.id })}
                        onClose={() => setExpandedId(null)}
                      />
                    </div>
                  ) : (
                    <div className="card ops-detail-card">
                      <div className="card-head">
                        <span className="card-title">{t('data.operations.editTitle')}</span>
                      </div>
                      <OperationForm
                        initial={selectedEntry.op}
                        accounts={accounts}
                        submitLabel={t('common.save')}
                        onSubmit={(payload) => handleUpdate(selectedEntry.op, payload)}
                        onCancel={() => setExpandedId(null)}
                      />
                      <div className="data-row-actions" style={{ marginTop: 12 }}>
                        <button type="button" className="btn-danger" onClick={() => handleDelete(selectedEntry.op)}>
                          <Trash2 size={14} /> {selectedEntry.op.transfer_id ? t('common.deleteTransfer') : t('common.delete')}
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="card ops-detail-card ops-detail-empty">
                    <p className="data-hint">{t('data.operations.selectHint')}</p>
                    {!noAccounts && (
                      <button type="button" className="btn-secondary" onClick={() => { setShowNew(true); setExpandedId(null); }}>
                        <Plus size={14} /> {t('data.operations.newTitle')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {displayList.length === 0 && operations.length > 0 && (
            <p className="data-hint">{t('data.searchNoResults', { query: search })}</p>
          )}
          </>
        )}
      </div>
    </DataSection>
    )
  );
}
