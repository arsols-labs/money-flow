import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { formatMinor } from './money';
import { compactComment, ReceiptUrlLink } from './ReceiptUrlLink';
import { intlLocale } from './language';
import { receiptCalendarDate } from '../shared/receipt-groups';

export default function FiscalReceiptCard({
  receipt,
  selection = null,
  onExclude = null,
  excludeDisabled = false,
  baseCurrency = null,
  baseMinor = null,
}) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const calDate = receiptCalendarDate(receipt.date);
  const d = calDate ? new Date(`${calDate}T00:00:00Z`) : new Date(receipt.date);
  const currency = receipt.account_currency || 'USD';
  const totalStr = formatMinor(receipt.total_minor, currency);
  const baseStr = baseMinor !== null && baseMinor !== undefined && baseCurrency
    ? formatMinor(baseMinor, baseCurrency)
    : null;
  const amountLabel = baseStr ? `${totalStr} (${baseStr})` : totalStr;
  const pfrLabel = receipt.fiscal_receipt_id
    ? t('data.receipts.pfr', { id: receipt.fiscal_receipt_id })
    : t('data.receipts.noPfr');
  const selectLabel = t('data.receiptGroups.select', {
    label: [receipt.store, pfrLabel].filter(Boolean).join(' '),
  });

  return (
    <div
      className="receipt"
      data-receipt-key={selection?.key || receipt.membershipKey || undefined}
      data-receipt-date={calDate || receipt.date || undefined}
    >
      {selection && (
        selection.disabled ? (
          <p className="receipt-select receipt-select--locked">{selection.reason}</p>
        ) : (
          <label className="receipt-select">
            <input
              type="checkbox"
              checked={selection.checked}
              aria-label={selectLabel}
              onChange={(event) => selection.onChange(event.target.checked)}
            />
          </label>
        )
      )}
      <button
        type="button"
        className="receipt-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="receipt-date" data-date={calDate || receipt.date || undefined}>
          {d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })}
        </div>
        <div className="receipt-merchant">
          {receipt.store || t('common.emptyDash')}
          <span className="receipt-meta">
            {receipt.account_name ? `${receipt.account_name} · ` : ''}
            {t('analytics.receipt.lineItems', { count: receipt.positions_count })}
            {' · '}
            {pfrLabel}
          </span>
        </div>
        <div className="receipt-total">{amountLabel}</div>
        <ChevronDown size={15} className={open ? 'chev chev--open' : 'chev'} />
      </button>
      {onExclude && (
        <div className="receipt-exclude-row">
          <button type="button" className="link-btn" disabled={excludeDisabled} onClick={onExclude}>
            {t('data.receiptGroups.exclude')}
          </button>
        </div>
      )}
      {open && (
        <div id={panelId} className="receipt-lines">
          {receipt.receipt_url ? (
            <div className="receipt-line">
              <div className="receipt-line-name">
                <ReceiptUrlLink url={receipt.receipt_url} />
              </div>
            </div>
          ) : null}
          {receipt.lines.map((l) => {
            const lineTotal = formatMinor(l.amount_minor, currency);
            const subText = [l.subcategory, l.category, compactComment(l.comment)].filter(Boolean).join(' · ');
            return (
              <div key={l.id} className="receipt-line">
                <div className="receipt-line-name">
                  {l.item}
                  {subText && <span className="receipt-line-sub">{subText}</span>}
                  {l.receipt_url ? <ReceiptUrlLink url={l.receipt_url} /> : null}
                </div>
                <div className="receipt-line-total">
                  {l.kind === 'income' || l.kind === 'refund' ? `+${formatMinor(Math.abs(l.amount_minor), currency)}` : lineTotal}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
