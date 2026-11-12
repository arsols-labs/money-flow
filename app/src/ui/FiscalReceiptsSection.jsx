// "Receipts" section of the "Data" screen: fiscal documents via PFR,
// with purchase-order cards and manual receipt groups around linked documents.
// groupFiscalReceipts itself is unchanged. Nesting is presentation only.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { SectionSkeleton, DataSection, useLoadWhenExpanded } from './components';
import { useRefreshNonce } from './RefreshContext';
import { DATA_BLOCK_DEFS } from './dataLayout';
import { blockTitle } from './i18nLabels';
import { fiscalReceiptMatchesQuery, groupFiscalReceipts } from '../shared/fiscal-receipts';
import { partitionReceiptCards } from '../shared/purchase-orders';
import {
  areReceiptsSameCalendarDate,
  buildDatedReceiptFeed,
  receiptCardKey,
  receiptGroupSearchState,
  resolveReceiptGroupDate,
  resolveReceiptGroupPlace,
} from '../shared/receipt-groups';
import FiscalReceiptCard from './FiscalReceiptCard';
import PurchaseOrderCard from './PurchaseOrderCard';

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

function newIdempotencyKey() {
  return crypto.randomUUID();
}

export function ReceiptGroupToolbar({
  selecting = false,
  busy = false,
  uncertain = false,
  groupName = '',
  onGroupNameChange = () => {},
  nameInputRef = null,
  selectedCount = 0,
  selectedHidden = 0,
  actionError = null,
  onStart = () => {},
  onConfirm = () => {},
  onCancel = () => {},
}) {
  const { t } = useTranslation();
  return (
    <div className="receipt-group-toolbar">
      {!selecting && (
        <button type="button" className="btn-secondary" onClick={onStart}>
          {t('data.receiptGroups.group')}
        </button>
      )}
      {selecting && (
        <div className="order-actions">
          <label>
            {t('data.receiptGroups.name')}
            <input
              ref={nameInputRef}
              value={groupName}
              onChange={(event) => onGroupNameChange(event.target.value)}
              placeholder={t('data.receiptGroups.namePlaceholder')}
              disabled={busy || uncertain}
              maxLength={120}
            />
          </label>
          <span className="receipt-group-count">
            {selectedHidden > 0
              ? t('data.receiptGroups.selectedHidden', { count: selectedCount, hidden: selectedHidden })
              : t('data.receiptGroups.selected', { count: selectedCount })}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || selectedCount < 2 || uncertain}
            onClick={onConfirm}
          >
            {busy ? t('data.receiptGroups.saving') : t('data.receiptGroups.confirm')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || uncertain}
            onClick={onCancel}
          >
            {t('data.receiptGroups.cancel')}
          </button>
          {uncertain && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={onConfirm}>
              {t('data.receiptGroups.retry')}
            </button>
          )}
        </div>
      )}
      {uncertain && <p className="form-error" role="alert">{t('data.receiptGroups.uncertain')}</p>}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
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
  const [actionError, setActionError] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [operations, setOperations] = useState([]);
  const [orders, setOrders] = useState([]);
  const [groups, setGroups] = useState([]);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [groupName, setGroupName] = useState('');
  const nameInputRef = useRef(null);
  const createAttempt = useRef(null);
  const actionAttempt = useRef(new Map());

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      await api.listReceiptGroups();
      const [ops, orderRes, groupRes] = await Promise.all([
        api.listOperations(),
        api.listPurchaseOrders(),
        api.listReceiptGroups(),
      ]);
      setOperations(ops.operations);
      setOrders(orderRes.orders ?? []);
      setGroups(groupRes.groups ?? []);
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
    api.listReceiptGroups().then(() => Promise.all([
      api.listOperations(),
      api.listPurchaseOrders(),
      api.listReceiptGroups(),
    ])).then(([ops, orderRes, groupRes]) => {
      if (cancelled) return;
      setOperations(ops.operations);
      setOrders(orderRes.orders ?? []);
      setGroups(groupRes.groups ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [operationsRevision]);

  const cards = useMemo(() => {
    const tagged = operations.map((op) => withAccount(op, accounts));
    const tokenById = new Map(tagged.map((op) => [op.id, op.receipt_identity_token ?? null]));
    return groupFiscalReceipts(tagged).map((card) => ({
      ...card,
      membershipKey: receiptCardKey(card, tokenById),
    }));
  }, [operations, accounts]);

  const view = useMemo(() => {
    const partitioned = partitionReceiptCards(cards, orders);
    const manual = groups.map((group) => {
      const nested = cards.filter((card) => group.receipts.some((receipt) => (
        receipt.resolution === 'resolved' && receipt.receipt_key === card.membershipKey
      )));
      const date = group.date || resolveReceiptGroupDate(nested, group.order_date ?? null);
      const place = resolveReceiptGroupPlace(nested, group.place ?? group.name ?? null);
      const hydrated = {
        ...group,
        date,
        place,
        name: place ?? group.name ?? null,
      };
      return { group: hydrated, nested, ...receiptGroupSearchState(hydrated, nested, search) };
    }).filter((item) => item.visible);
    const hiddenManual = new Set(
      groups.flatMap((group) => group.receipts
        .filter((receipt) => receipt.resolution === 'resolved')
        .map((receipt) => receipt.receipt_key)),
    );
    const claimed = new Set([
      ...groups.flatMap((group) => group.receipts.map((receipt) => receipt.receipt_key)),
      ...orders.flatMap((order) => order.components.map((component) => (
        component.pfr_canonical ? `pfr:${component.pfr_canonical}` : null
      )).filter(Boolean)),
    ]);
    const visibleUngrouped = partitioned.ungrouped
      .filter((group) => !hiddenManual.has(group.membershipKey))
      .filter((group) => fiscalReceiptMatchesQuery(group, search));
    const feed = buildDatedReceiptFeed(manual, visibleUngrouped);
    return { visibleUngrouped, manual, claimed, feed };
  }, [cards, orders, groups, search]);

  const selectedHidden = [...selected].filter((key) => (
    !view.visibleUngrouped.some((card) => card.membershipKey === key)
  )).length;

  const definiteFailure = (err) => typeof err?.status === 'number' && err.status >= 400 && err.status < 500;

  const confirmGroup = async () => {
    const receiptKeys = [...selected].sort();
    if (receiptKeys.length < 2) return;
    const selectedCards = receiptKeys
      .map((key) => cards.find((card) => card.membershipKey === key))
      .filter(Boolean);
    if (selectedCards.length === receiptKeys.length) {
      const dateCheck = areReceiptsSameCalendarDate(selectedCards);
      if (!dateCheck.ok) {
        setActionError(t('data.receiptGroups.differentDates'));
        return;
      }
      const resolvedPlace = resolveReceiptGroupPlace(selectedCards, groupName);
      if (!resolvedPlace) {
        setActionError(t('data.receiptGroups.placeRequired'));
        nameInputRef.current?.focus?.();
        return;
      }
    }
    const payload = { receipt_keys: receiptKeys, name: groupName.trim() || null };
    const previous = createAttempt.current;
    const same = previous && JSON.stringify(previous.payload) === JSON.stringify(payload);
    if (uncertain && !same) return;
    const idempotencyKey = same ? previous.key : newIdempotencyKey();
    createAttempt.current = { key: idempotencyKey, payload };
    setBusy(true);
    setActionError(null);
    try {
      await api.createReceiptGroup({ ...payload, idempotency_key: idempotencyKey });
      await api.listReceiptGroups();
      const [ops, orderRes, groupRes] = await Promise.all([
        api.listOperations(),
        api.listPurchaseOrders(),
        api.listReceiptGroups(),
      ]);
      setOperations(ops.operations);
      setOrders(orderRes.orders ?? []);
      setGroups(groupRes.groups ?? []);
      setSelecting(false);
      setSelected(new Set());
      setGroupName('');
      setUncertain(false);
      createAttempt.current = null;
      setStatus('ready');
    } catch (err) {
      if (definiteFailure(err)) {
        createAttempt.current = null;
        setUncertain(false);
      } else {
        setUncertain(true);
      }
      setActionError(err.message || t('data.receiptGroups.saveFailed'));
      setStatus('ready');
    } finally {
      setBusy(false);
    }
  };

  const renameGroup = async (groupId, name) => {
    const actionKey = `rename:${groupId}:${name ?? ''}`;
    const existing = actionAttempt.current.get(actionKey);
    const idempotencyKey = existing || newIdempotencyKey();
    actionAttempt.current.set(actionKey, idempotencyKey);
    setBusy(true);
    setActionError(null);
    try {
      await api.renameReceiptGroup(groupId, { name, idempotency_key: idempotencyKey });
      await load();
      actionAttempt.current.delete(actionKey);
      setUncertain(false);
    } catch (err) {
      if (definiteFailure(err)) actionAttempt.current.delete(actionKey);
      else setUncertain(true);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const retryAction = async (actionKey, fn) => {
    const existing = actionAttempt.current.get(actionKey);
    const idempotencyKey = existing || newIdempotencyKey();
    actionAttempt.current.set(actionKey, idempotencyKey);
    setBusy(true);
    setActionError(null);
    try {
      await fn(idempotencyKey);
      await load();
      actionAttempt.current.delete(actionKey);
      setUncertain(false);
    } catch (err) {
      if (definiteFailure(err)) actionAttempt.current.delete(actionKey);
      else setUncertain(true);
      setActionError(err.message || t('data.receiptGroups.saveFailed'));
      setStatus('ready');
    } finally {
      setBusy(false);
    }
  };

  const empty = view.visibleUngrouped.length === 0 && view.manual.length === 0;

  return (
    <DataSection
      id="receipts"
      title={blockTitle(DATA_BLOCK_DEFS.receipts, t)}
      expanded={Boolean(expanded)}
      onToggle={onToggle}
    >
      {status === 'loading' && <SectionSkeleton rows={3} />}
      {status === 'error' && <div className="data-error" role="alert">{loadError}</div>}
      {status === 'ready' && (
        <ReceiptGroupToolbar
          selecting={selecting}
          busy={busy}
          uncertain={uncertain}
          groupName={groupName}
          onGroupNameChange={(value) => {
            setGroupName(value);
            if (actionError) setActionError(null);
          }}
          nameInputRef={nameInputRef}
          selectedCount={selected.size}
          selectedHidden={selectedHidden}
          actionError={actionError}
          onStart={() => setSelecting(true)}
          onConfirm={confirmGroup}
          onCancel={() => {
            setSelecting(false);
            setSelected(new Set());
            setGroupName('');
            createAttempt.current = null;
            setActionError(null);
          }}
        />
      )}
      {status === 'ready' && empty && (
        <div className="data-empty">
          <p>{search.trim() ? t('data.searchNoResults', { query: search }) : t('data.receipts.empty')}</p>
        </div>
      )}
      {status === 'ready' && !empty && (
        <div className="receipt-list">
          {view.feed.map((entry) => {
            if (entry.kind === 'group') {
              const item = entry.value;
              return (
                <PurchaseOrderCard
                  key={`manual-${item.group.id}`}
                  manualGroup={item.group}
                  nestedCards={item.nested}
                  forceOpen={item.expand}
                  busy={busy}
                  onExcludeReceipt={(receiptKey) => retryAction(`unlink:${item.group.id}:${receiptKey}`, (idempotencyKey) => (
                    api.unlinkReceiptGroupReceipt(item.group.id, receiptKey, idempotencyKey)
                  ))}
                  onDeleteGroup={() => {
                    if (!window.confirm(t('data.receiptGroups.deleteConfirm'))) return;
                    retryAction(`delete:${item.group.id}`, (idempotencyKey) => (
                      api.deleteReceiptGroup(item.group.id, idempotencyKey)
                    ));
                  }}
                  onRename={(name) => renameGroup(item.group.id, name)}
                />
              );
            }
            const receipt = entry.value;
            const claimed = receipt.membershipKey && view.claimed.has(receipt.membershipKey);
            const selection = selecting ? (
              claimed || !receipt.membershipKey
                ? {
                  disabled: true,
                  reason: claimed
                    ? t('data.receiptGroups.alreadyGrouped')
                    : t('data.receiptGroups.identityNotReady'),
                }
                : {
                  key: receipt.membershipKey,
                  checked: selected.has(receipt.membershipKey),
                  onChange: (checked) => {
                    if (uncertain) return;
                    if (actionError) setActionError(null);
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(receipt.membershipKey);
                      else next.delete(receipt.membershipKey);
                      return next;
                    });
                  },
                }
            ) : null;
            return (
              <FiscalReceiptCard key={receipt.id} receipt={receipt} selection={selection} />
            );
          })}
        </div>
      )}
    </DataSection>
  );
}
