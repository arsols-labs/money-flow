// Секция «Чеки» экрана «Данные» (issue #557): фискальные документы по PFR.
//
// Карточки внешне как у «Аналитики / Чеки», но ключ другой: stored
// fiscal_receipt_id, а не store+date+account. Аналитику эта секция не трогает.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { api } from './api';
import { SectionSkeleton, DataSection, useLoadWhenExpanded } from './components';
import { useRefreshNonce } from './RefreshContext';
import { formatMinor } from './money';
import { DATA_BLOCK_DEFS } from './dataLayout';
import { blockTitle } from './i18nLabels';
import { compactComment, ReceiptUrlLink } from './ReceiptUrlLink';
import { intlLocale } from './language';
import { fiscalReceiptMatchesQuery, groupFiscalReceipts } from '../shared/fiscal-receipts';

function findAccount(accounts, id) {
  return accounts.find((a) => String(a.id) === String(id));
}

function withAccount(op, accounts) {
  const account = findAccount(accounts, op.account_id);
  return {
    ...op,
    account_name: account?.name ?? '',
    currency: op.currency || account?.currency || '',
  };
}

function FiscalReceiptCard({ receipt }) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const [open, setOpen] = useState(false);
  const d = new Date(receipt.date);
  const currency = receipt.account_currency || 'USD';
  const totalStr = formatMinor(receipt.total_minor, currency);
  const pfrLabel = receipt.fiscal_receipt_id
    ? t('data.receipts.pfr', { id: receipt.fiscal_receipt_id })
    : t('data.receipts.noPfr');

  return (
    <div className="receipt">
      <button type="button" className="receipt-head" onClick={() => setOpen((v) => !v)}>
        <div className="receipt-date">
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
        <div className="receipt-total">{totalStr}</div>
        <ChevronDown size={15} className={open ? 'chev chev--open' : 'chev'} />
      </button>
      {open && (
        <div className="receipt-lines">
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

export default function FiscalReceiptsSection({
  accounts = [],
  expanded,
  onToggle,
  search = '',
  operationsRevision = 0,
}) {
  const { t } = useTranslation();
  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState('loading');
  const [loadError, setLoadError] = useState(null);
  const [operations, setOperations] = useState([]);

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      const res = await api.listOperations();
      setOperations(res.operations);
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message || t('data.receipts.loadFailed'));
      setStatus('error');
    }
  }, [t]);

  useLoadWhenExpanded(expanded, load, refreshNonce);

  const loadedRef = useRef(false);
  useEffect(() => {
    if (status === 'ready' || status === 'error') loadedRef.current = true;
  }, [status]);
  useEffect(() => {
    if (!operationsRevision || !loadedRef.current) return;
    let cancelled = false;
    api.listOperations().then((res) => {
      if (!cancelled) setOperations(res.operations);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [operationsRevision]);

  const groups = useMemo(() => {
    const tagged = operations.map((op) => withAccount(op, accounts));
    return groupFiscalReceipts(tagged).filter((group) => fiscalReceiptMatchesQuery(group, search));
  }, [operations, accounts, search]);

  return (
    <DataSection
      id="receipts"
      title={blockTitle(DATA_BLOCK_DEFS.receipts, t)}
      expanded={Boolean(expanded)}
      onToggle={onToggle}
    >
      {status === 'loading' && <SectionSkeleton rows={3} />}
      {status === 'error' && <div className="data-error" role="alert">{loadError}</div>}
      {status === 'ready' && groups.length === 0 && (
        <div className="data-empty">
          <p>{search.trim() ? t('data.searchNoResults', { query: search }) : t('data.receipts.empty')}</p>
        </div>
      )}
      {status === 'ready' && groups.length > 0 && (
        <div className="receipt-list">
          {groups.map((receipt) => (
            <FiscalReceiptCard key={receipt.id} receipt={receipt} />
          ))}
        </div>
      )}
    </DataSection>
  );
}
