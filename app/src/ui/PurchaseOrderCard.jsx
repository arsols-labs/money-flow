// One expandable purchase order on Data → Receipts.
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Group, Pencil } from 'lucide-react';
import { formatMinor, parseAmountToMinor } from './money';
import { intlLocale } from './language';
import {
  receiptCalendarDate,
  resolveReceiptGroupDate,
  resolveReceiptGroupPlace,
} from '../shared/receipt-groups';
import FiscalReceiptCard from './FiscalReceiptCard';

const COMPONENT_TYPES = ['goods', 'service_fee', 'delivery_fee', 'tip', 'discount', 'refund', 'other'];

function money(minor, currency) {
  if (minor === null || minor === undefined || !currency) return '';
  return formatMinor(minor, currency);
}

export default function PurchaseOrderCard({
  order,
  nestedCards = [],
  linkableGroups = [],
  forceOpen = false,
  busy = false,
  onLink,
  onAddExpected,
  onUnlink,
  onUngroup,
  manualGroup = null,
  onExcludeReceipt,
  onDeleteGroup,
  onRename = null,
  renderNested = null,
}) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const panelId = useId();
  const [open, setOpen] = useState(Boolean(forceOpen));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [renameError, setRenameError] = useState(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [componentType, setComponentType] = useState('goods');
  const [pfr, setPfr] = useState('');
  const [expectedAmount, setExpectedAmount] = useState('');
  const [expectedCurrency, setExpectedCurrency] = useState(order?.order_total_currency || 'RSD');
  const [expectedLabel, setExpectedLabel] = useState('');
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    setEditing(false);
    setRenameError(null);
  }, [manualGroup?.id]);

  if (manualGroup) {
    const title = resolveReceiptGroupPlace(
      nestedCards,
      manualGroup.place ?? manualGroup.name ?? null,
    ) || t('common.emptyDash');
    const calDate = receiptCalendarDate(manualGroup.date)
      || resolveReceiptGroupDate(nestedCards, manualGroup.order_date ?? null);
    const dateLabel = calDate
      ? new Date(`${calDate}T00:00:00Z`).toLocaleDateString(locale, {
        day: 'numeric', month: 'short', timeZone: 'UTC',
      })
      : t('common.emptyDash');
    const missingRates = Array.isArray(manualGroup.missing_rates) ? manualGroup.missing_rates : [];
    const hasUnresolved = manualGroup.receipts.some((receipt) => receipt.resolution !== 'resolved');
    const resolvedTotalMinor = manualGroup.total_minor !== undefined
      ? manualGroup.total_minor
      : (!manualGroup.multi_currency && !manualGroup.incomplete && manualGroup.subtotals?.length === 1
        ? manualGroup.subtotals[0].posted_minor
        : null);
    const resolvedTotalCurrency = manualGroup.total_currency !== undefined
      ? manualGroup.total_currency
      : (!manualGroup.multi_currency && manualGroup.subtotals?.length === 1
        ? manualGroup.subtotals[0].currency
        : null);
    const isIncomplete = Boolean(manualGroup.incomplete)
      || missingRates.length > 0
      || hasUnresolved
      || resolvedTotalMinor === null
      || resolvedTotalMinor === undefined
      || !resolvedTotalCurrency;
    const totalLabel = isIncomplete
      ? t('data.receiptGroups.totalIncomplete')
      : money(resolvedTotalMinor, resolvedTotalCurrency);
    const resolvedMembers = manualGroup.receipts.filter((receipt) => receipt.resolution === 'resolved');
    const baseKnown = resolvedMembers.length > 0
      && resolvedMembers.every((receipt) => typeof receipt.base_minor === 'number');
    const baseSum = baseKnown
      ? resolvedMembers.reduce((sum, receipt) => sum + receipt.base_minor, 0)
      : null;
    const showBase = !isIncomplete
      && baseSum !== null
      && resolvedTotalCurrency
      && manualGroup.base_currency
      && resolvedTotalCurrency !== manualGroup.base_currency;
    const warnings = [];
    if (missingRates.length > 0) {
      warnings.push(t('data.receiptGroups.missingRate', { currencies: missingRates.join(', ') }));
    }
    if (hasUnresolved || (manualGroup.incomplete && missingRates.length === 0)) {
      warnings.push(t('data.receiptGroups.incomplete'));
    }
    const storedTitle = manualGroup.place ?? manualGroup.name ?? '';
    const startEdit = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDraft(storedTitle);
      setRenameError(null);
      setEditing(true);
      setOpen(true);
    };
    const submitRename = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!onRename || renameBusy) return;
      const typed = draft.trim();
      setRenameBusy(true);
      setRenameError(null);
      try {
        await onRename(typed.length > 0 ? typed : null);
        setEditing(false);
      } catch (err) {
        setRenameError(err?.message || t('data.receiptGroups.saveFailed'));
      } finally {
        setRenameBusy(false);
      }
    };
    return (
      <article
        className="order-card"
        data-order-id={manualGroup.id}
        data-group-kind="manual"
        data-group-date={calDate || undefined}
      >
        <div className="receipt-head receipt-group-head">
          <button
            type="button"
            className="receipt-group-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${dateLabel}, ${title}, ${t('data.receiptGroups.kind')}`}
            onClick={() => setOpen((value) => !value)}
          />
          <div className="receipt-date" data-date={calDate || undefined}>{dateLabel}</div>
          <div className="receipt-merchant">
            <div className="receipt-group-title-row">
              {editing ? (
                <form className="receipt-group-rename-form" onSubmit={submitRename}>
                  <input
                    aria-label={t('data.receiptGroups.editTitle')}
                    value={draft}
                    maxLength={120}
                    disabled={renameBusy || busy}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      if (renameError) setRenameError(null);
                    }}
                  />
                  <button type="submit" className="btn-secondary" disabled={renameBusy || busy}>
                    {renameBusy ? t('common.saving') : t('common.save')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={renameBusy || busy}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditing(false);
                      setRenameError(null);
                    }}
                  >
                    {t('data.receiptGroups.cancel')}
                  </button>
                </form>
              ) : (
                <>
                  <span className="receipt-group-title">{title}</span>
                  {open && onRename && (
                    <button
                      type="button"
                      className="receipt-group-rename"
                      aria-label={t('data.receiptGroups.editTitle')}
                      disabled={busy}
                      onClick={startEdit}
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="receipt-group-kind">
              <Group size={12} aria-hidden="true" />
              <span>{t('data.receiptGroups.kind')}</span>
            </div>
            {warnings.map((warning, index) => (
              <div key={index} className="receipt-group-warning">{warning}</div>
            ))}
            {renameError && <p className="form-error" role="alert">{renameError}</p>}
          </div>
          <div className="receipt-total">
            {totalLabel}
            {showBase && <span className="receipt-usd">≈ {money(baseSum, manualGroup.base_currency)}</span>}
          </div>
          <ChevronDown size={15} className={open ? 'chev chev--open' : 'chev'} aria-hidden="true" />
        </div>
        <div id={panelId} className="order-card-body" hidden={!open}>
          {manualGroup.receipts.filter((receipt) => receipt.resolution !== 'resolved').map((receipt) => (
            <p key={receipt.receipt_key} className="order-flag" data-reason={receipt.resolution}>
              {t(`data.receiptGroups.resolution.${receipt.resolution}`)}
            </p>
          ))}
          {renderNested
            ? nestedCards.map((receipt) => renderNested(receipt))
            : nestedCards.map((receipt) => {
              const member = manualGroup.receipts.find((item) => item.receipt_key === receipt.membershipKey);
              return (
                <FiscalReceiptCard
                  key={`manual-${manualGroup.id}-${receipt.membershipKey || receipt.id}`}
                  receipt={receipt}
                  baseCurrency={manualGroup.base_currency || null}
                  baseMinor={member?.base_minor ?? null}
                  excludeDisabled={busy}
                  onExclude={receipt.membershipKey ? () => onExcludeReceipt?.(receipt.membershipKey) : null}
                />
              );
            })}
          {onDeleteGroup && (
            <button type="button" className="btn-danger" disabled={busy} onClick={() => onDeleteGroup()}>
              {t('data.receiptGroups.deleteGroup')}
            </button>
          )}
        </div>
      </article>
    );
  }

  const dateLabel = order.order_date
    ? new Date(`${order.order_date}T00:00:00Z`).toLocaleDateString(locale, {
      day: 'numeric', month: 'short', timeZone: 'UTC',
    })
    : t('common.emptyDash');
  const totalLabel = order.order_total_minor === null
    ? t('data.orders.unknownTotal')
    : t('data.orders.declaredTotal', {
      amount: money(order.order_total_minor, order.order_total_currency),
      source: t(`data.orders.source.${order.order_total_source}`),
    });
  const postedLabel = order.posted.length === 0
    ? t('data.orders.posted', {
      amount: order.order_total_currency ? money(0, order.order_total_currency) : t('common.emptyDash'),
    })
    : order.posted.map((row) => t('data.orders.postedMulti', {
      currency: row.currency,
      amount: money(row.posted_total_minor, row.currency),
    })).join(' · ');
  const difference = order.status !== 'multi_currency' && order.order_total_minor !== null
    ? order.order_total_minor - (order.posted.find((row) => row.currency === order.order_total_currency)?.posted_total_minor ?? 0)
    : null;

  const submitExpected = () => {
    setFormError(null);
    try {
      const amount = parseAmountToMinor(expectedAmount, expectedCurrency);
      if (!amount) throw new Error(t('validation.enterAmount'));
      onAddExpected?.({
        component_type: componentType,
        expected_amount_minor: amount,
        expected_currency: expectedCurrency.trim().toUpperCase(),
        label: expectedLabel.trim() || null,
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('data.orders.saveFailed'));
    }
  };

  return (
    <article className="order-card" data-order-id={order.id} data-conflict={order.conflict ? 'true' : 'false'}>
      <button
        type="button"
        className="receipt-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <div className="receipt-date">{dateLabel}</div>
        <div className="receipt-merchant">
          {t('data.orders.heading', { provider: order.provider, orderId: order.provider_order_id })}
          <span className="receipt-meta">
            {totalLabel}
            {' · '}
            {postedLabel}
            {' · '}
            {t(`data.orders.status.${order.status}`)}
            {order.conflict ? ` · ${t('data.orders.conflict')}` : ''}
          </span>
        </div>
        <ChevronDown size={15} className={open ? 'chev chev--open' : 'chev'} />
      </button>
      <div id={panelId} className="order-card-body" hidden={!open}>
        {difference !== null && difference !== 0 && (
          <p className="order-flag">{t('data.orders.difference', { amount: money(difference, order.order_total_currency) })}</p>
        )}
        {order.expected_missing.map((row) => (
          <p key={row.currency} className="order-flag">
            {t('data.orders.expectedMissing', { amount: money(row.amount_minor, row.currency) })}
          </p>
        ))}
        {order.not_counted.map((row) => (
          <p key={row.operation_id} className="order-flag">
            {t('data.orders.notCounted', { kind: row.kind })}
          </p>
        ))}
        {nestedCards.map((receipt) => (
          <FiscalReceiptCard key={`nested-${order.id}-${receipt.id}`} receipt={receipt} />
        ))}
        {order.components.filter((component) => component.target_kind === 'expected' && !component.reason).map((component) => (
          <p key={component.id} className="order-flag">
            {t('data.orders.expectedNotPosted', {
              label: component.label || t(`data.orders.componentType.${component.component_type}`),
              amount: money(component.expected_amount_minor, component.expected_currency),
            })}
            {' · '}
            {t('data.orders.notPosted')}
            <button type="button" className="link-btn" disabled={busy} onClick={() => onUnlink?.(component.id)}>
              {t('data.orders.unlink')}
            </button>
          </p>
        ))}
        {order.components.filter((component) => component.reason).map((component) => (
          <p key={component.id} className="order-flag" data-reason={component.reason} data-conflict={component.conflict ? 'true' : 'false'}>
            {t(`data.orders.reason.${component.reason}`)}
            {component.conflict ? ` · ${t('data.orders.conflict')}` : ''}
            <button type="button" className="link-btn" disabled={busy} onClick={() => onUnlink?.(component.id)}>
              {t('data.orders.unlink')}
            </button>
          </p>
        ))}
        <div className="order-actions">
          <label>
            {t('data.orders.componentTypeLabel')}
            <select value={componentType} onChange={(event) => setComponentType(event.target.value)}>
              {COMPONENT_TYPES.map((type) => (
                <option key={type} value={type}>{t(`data.orders.componentType.${type}`)}</option>
              ))}
            </select>
          </label>
          <label>
            {t('data.orders.linkDocument')}
            <select value={pfr} onChange={(event) => setPfr(event.target.value)}>
              <option value="">{t('data.orders.pickDocument')}</option>
              {linkableGroups.map((group) => (
                <option key={group.id} value={group.fiscal_receipt_id}>{group.fiscal_receipt_id}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !pfr}
            onClick={() => onLink?.({ fiscal_receipt_id: pfr, component_type: componentType })}
          >
            {t('data.orders.linkAction')}
          </button>
        </div>
        <div className="order-actions">
          <label>
            {t('data.orders.expectedAmount')}
            <input value={expectedAmount} onChange={(event) => setExpectedAmount(event.target.value)} inputMode="decimal" />
          </label>
          <label>
            {t('data.orders.expectedCurrency')}
            <input value={expectedCurrency} onChange={(event) => setExpectedCurrency(event.target.value)} maxLength={3} />
          </label>
          <label>
            {t('data.orders.expectedLabel')}
            <input value={expectedLabel} onChange={(event) => setExpectedLabel(event.target.value)} />
          </label>
          <button type="button" className="btn-secondary" disabled={busy} onClick={submitExpected}>
            {t('data.orders.addExpected')}
          </button>
        </div>
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <button type="button" className="btn-danger" disabled={busy} onClick={() => onUngroup?.()}>
          {t('data.orders.ungroup')}
        </button>
      </div>
    </article>
  );
}
