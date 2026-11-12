// Purchase-order projection. Read-only: no ledger writes.
// posted_total is positive spend net of refunds. Expected amounts are display only.

import { canonicalizePfr, fiscalReceiptMatchesQuery, type FiscalReceiptGroup } from './fiscal-receipts';
import { minorBigIntToNumber } from './money';

export const PURCHASE_ORDERS_EPOCH_KEY = 'purchase_orders_epoch';

export const COMPONENT_TYPES = [
  'goods',
  'service_fee',
  'delivery_fee',
  'tip',
  'discount',
  'refund',
  'other',
] as const;

export const ORDER_TOTAL_SOURCES = ['provider_document', 'fiscal_document'] as const;

export const ORDER_STATUSES = [
  'complete',
  'partial',
  'mismatch',
  'unknown',
  'multi_currency',
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];
export type OrderTotalSource = (typeof ORDER_TOTAL_SOURCES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type ComponentReason = 'epoch_changed' | 'pfr_missing' | 'conflict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_RE = /^[a-z0-9_-]{1,40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isLedgerEpoch(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isProviderSlug(value: string): boolean {
  return PROVIDER_RE.test(value);
}

export function isIsoDateOnly(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(year!, month! - 1, day!));
  return dt.getUTCFullYear() === year
    && dt.getUTCMonth() === month! - 1
    && dt.getUTCDate() === day
    && year! >= 1;
}

export interface OrderComponentRow {
  id: number;
  order_id: number;
  component_type: string;
  target_kind: 'pfr' | 'expected';
  pfr_canonical: string | null;
  ledger_epoch: string;
  expected_amount_minor: number | null;
  expected_currency: string | null;
  label: string | null;
}

export interface OrderRow {
  id: number;
  provider: string;
  provider_order_id: string;
  order_date: string | null;
  order_total_minor: number | null;
  order_total_currency: string | null;
  order_total_source: string | null;
  order_total_reference: string | null;
  note: string | null;
}

export interface OrderLedgerOp {
  id: number;
  kind: string;
  amount_minor: number;
  currency: string;
  fiscal_receipt_id: string | null;
}

export interface ProjectedComponent {
  id: number;
  component_type: string;
  target_kind: 'pfr' | 'expected';
  pfr_canonical: string | null;
  label: string | null;
  expected_amount_minor: number | null;
  expected_currency: string | null;
  resolved: boolean;
  conflict: boolean;
  reason: ComponentReason | null;
  operation_ids: number[];
}

export interface PostedTotal {
  currency: string;
  posted_total_minor: number;
  operation_ids: number[];
}

export interface ExpectedMissing {
  currency: string;
  amount_minor: number;
}

export interface NotCountedOp {
  operation_id: number;
  kind: string;
  currency: string;
  reason: 'kind_not_counted';
}

export interface ProjectedOrder {
  id: number;
  provider: string;
  provider_order_id: string;
  order_date: string | null;
  order_total_minor: number | null;
  order_total_currency: string | null;
  order_total_source: string | null;
  order_total_reference: string | null;
  note: string | null;
  components: ProjectedComponent[];
  posted: PostedTotal[];
  expected_missing: ExpectedMissing[];
  not_counted: NotCountedOp[];
  status: OrderStatus;
  conflict: boolean;
}

interface Member {
  id: number;
  kind: string;
  amount_minor: number;
  currency: string;
}

function isTransfer(kind: string): boolean {
  return kind === 'transfer_out' || kind === 'transfer_in';
}

function canonicalOf(op: OrderLedgerOp): string | null {
  const parsed = canonicalizePfr(op.fiscal_receipt_id);
  return parsed.ok ? parsed.value : null;
}

function addMinor(left: number, right: number, field: string): number {
  return minorBigIntToNumber(BigInt(left) + BigInt(right), field);
}

function spendContribution(amountMinor: number): number {
  return minorBigIntToNumber(-BigInt(amountMinor), 'posted_total_minor');
}

interface Draft {
  orderId: number;
  component: OrderComponentRow;
  reason: ComponentReason | null;
  members: Member[];
  allOps: OrderLedgerOp[];
}

/**
 * Build order cards from stored rows and the current ledger.
 * Conflict is its own flag. It stays set when status is partial or multi_currency.
 * Expected amounts are never added to posted_total.
 */
export function projectOrders(
  orders: OrderRow[],
  components: OrderComponentRow[],
  operations: OrderLedgerOp[],
  currentEpoch: string | null,
): ProjectedOrder[] {
  const opsByPfr = new Map<string, OrderLedgerOp[]>();
  for (const op of operations) {
    const pfr = canonicalOf(op);
    if (!pfr) continue;
    const bucket = opsByPfr.get(pfr);
    if (bucket) bucket.push(op);
    else opsByPfr.set(pfr, [op]);
  }

  const drafts: Draft[] = [];
  for (const component of components) {
    if (component.ledger_epoch !== currentEpoch) {
      drafts.push({
        orderId: component.order_id,
        component,
        reason: 'epoch_changed',
        members: [],
        allOps: [],
      });
      continue;
    }
    if (component.target_kind === 'expected') {
      drafts.push({
        orderId: component.order_id,
        component,
        reason: null,
        members: [],
        allOps: [],
      });
      continue;
    }
    const matched = component.pfr_canonical ? (opsByPfr.get(component.pfr_canonical) ?? []) : [];
    const nonTransfer = matched.filter((op) => !isTransfer(op.kind));
    if (nonTransfer.length === 0) {
      drafts.push({
        orderId: component.order_id,
        component,
        reason: 'pfr_missing',
        members: [],
        allOps: [],
      });
      continue;
    }
    drafts.push({
      orderId: component.order_id,
      component,
      reason: null,
      members: nonTransfer.map((op) => ({
        id: op.id,
        kind: op.kind,
        amount_minor: op.amount_minor,
        currency: op.currency,
      })),
      allOps: matched,
    });
  }

  const ordersByOp = new Map<number, Set<number>>();
  for (const draft of drafts) {
    if (draft.reason !== null || draft.component.target_kind !== 'pfr') continue;
    for (const op of draft.allOps) {
      const set = ordersByOp.get(op.id) ?? new Set<number>();
      set.add(draft.orderId);
      ordersByOp.set(op.id, set);
    }
  }
  const conflictComponentIds = new Set<number>();
  for (const draft of drafts) {
    if (draft.reason !== null || draft.component.target_kind !== 'pfr') continue;
    if (draft.allOps.some((op) => (ordersByOp.get(op.id)?.size ?? 0) > 1)) {
      draft.reason = 'conflict';
      conflictComponentIds.add(draft.component.id);
    }
  }

  const byOrder = new Map<number, Draft[]>();
  for (const draft of drafts) {
    const list = byOrder.get(draft.orderId) ?? [];
    list.push(draft);
    byOrder.set(draft.orderId, list);
  }

  return orders
    .map((order) => projectOne(order, byOrder.get(order.id) ?? []))
    .sort((a, b) => {
      const aDate = a.order_date ?? '';
      const bDate = b.order_date ?? '';
      if (aDate !== bDate) return aDate < bDate ? 1 : -1;
      return b.id - a.id;
    });
}

function projectOne(order: OrderRow, drafts: Draft[]): ProjectedOrder {
  const counted = new Map<number, Member>();
  const notCounted = new Map<number, NotCountedOp>();
  const components: ProjectedComponent[] = drafts
    .slice()
    .sort((a, b) => a.component.id - b.component.id)
    .map((draft) => {
      const conflict = draft.reason === 'conflict';
      const resolved = draft.component.target_kind === 'pfr' && draft.reason === null;
      if (resolved) {
        for (const member of draft.members) {
          if (member.kind === 'expense' || member.kind === 'refund') {
            if (!counted.has(member.id)) counted.set(member.id, member);
          }
        }
      }
      if (resolved || conflict) {
        for (const op of draft.allOps) {
          if (op.kind === 'expense' || op.kind === 'refund') continue;
          if (!notCounted.has(op.id)) {
            notCounted.set(op.id, {
              operation_id: op.id,
              kind: op.kind,
              currency: op.currency,
              reason: 'kind_not_counted',
            });
          }
        }
      }
      return {
        id: draft.component.id,
        component_type: draft.component.component_type,
        target_kind: draft.component.target_kind,
        pfr_canonical: draft.component.pfr_canonical,
        label: draft.component.label,
        expected_amount_minor: draft.component.expected_amount_minor,
        expected_currency: draft.component.expected_currency,
        resolved,
        conflict,
        reason: draft.reason,
        operation_ids: resolved || conflict ? draft.allOps.map((op) => op.id).sort((a, b) => a - b) : [],
      };
    });

  const postedByCurrency = new Map<string, { total: number; ids: number[] }>();
  for (const member of counted.values()) {
    const bucket = postedByCurrency.get(member.currency) ?? { total: 0, ids: [] };
    bucket.total = addMinor(bucket.total, spendContribution(member.amount_minor), 'posted_total_minor');
    bucket.ids.push(member.id);
    postedByCurrency.set(member.currency, bucket);
  }
  if (
    order.order_total_currency
    && !postedByCurrency.has(order.order_total_currency)
    && components.some((component) => component.target_kind === 'pfr')
  ) {
    postedByCurrency.set(order.order_total_currency, { total: 0, ids: [] });
  }

  const expectedByCurrency = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.component.target_kind !== 'expected' || draft.reason !== null) continue;
    const currency = draft.component.expected_currency;
    const amount = draft.component.expected_amount_minor;
    if (!currency || amount === null) continue;
    expectedByCurrency.set(
      currency,
      addMinor(expectedByCurrency.get(currency) ?? 0, amount, 'expected_missing_minor'),
    );
  }

  const posted: PostedTotal[] = [...postedByCurrency.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, bucket]) => ({
      currency,
      posted_total_minor: bucket.total,
      operation_ids: bucket.ids.sort((a, b) => a - b),
    }));
  const expected_missing: ExpectedMissing[] = [...expectedByCurrency.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, amount_minor]) => ({ currency, amount_minor }));

  const currencies = new Set<string>();
  if (order.order_total_currency) currencies.add(order.order_total_currency);
  for (const row of posted) currencies.add(row.currency);
  for (const row of expected_missing) currencies.add(row.currency);

  const hasExpected = expected_missing.length > 0;
  const hasUnresolved = components.some((component) => component.reason !== null);
  const conflict = components.some((component) => component.conflict);
  let status: OrderStatus;
  if (currencies.size > 1) status = 'multi_currency';
  else if (hasUnresolved || hasExpected) status = 'partial';
  else if (order.order_total_minor === null) status = 'unknown';
  else {
    const postedMinor = posted.length === 1
      ? posted[0]!.posted_total_minor
      : (posted.find((row) => row.currency === order.order_total_currency)?.posted_total_minor ?? 0);
    status = postedMinor === order.order_total_minor ? 'complete' : 'mismatch';
  }

  return {
    id: order.id,
    provider: order.provider,
    provider_order_id: order.provider_order_id,
    order_date: order.order_date,
    order_total_minor: order.order_total_minor,
    order_total_currency: order.order_total_currency,
    order_total_source: order.order_total_source,
    order_total_reference: order.order_total_reference,
    note: order.note,
    components,
    posted,
    expected_missing,
    not_counted: [...notCounted.values()].sort((a, b) => a.operation_id - b.operation_id),
    status,
    conflict,
  };
}

export function partitionReceiptCards(groups: FiscalReceiptGroup[], orders: ProjectedOrder[]): {
  nested: Array<{ order: ProjectedOrder; cards: FiscalReceiptGroup[] }>;
  ungrouped: FiscalReceiptGroup[];
} {
  const hidden = new Set<string>();
  const nested = orders.map((order) => {
    const cards: FiscalReceiptGroup[] = [];
    for (const component of order.components) {
      if (component.target_kind !== 'pfr' || !component.pfr_canonical) continue;
      if (!component.resolved || component.conflict) continue;
      const matches = groups.filter((group) => {
        const parsed = canonicalizePfr(group.fiscal_receipt_id);
        return parsed.ok && parsed.value === component.pfr_canonical;
      });
      for (const group of matches) {
        cards.push(group);
        hidden.add(group.id);
      }
    }
    return { order, cards };
  });
  return { nested, ungrouped: groups.filter((group) => !hidden.has(group.id)) };
}

export function orderSearchState(
  order: ProjectedOrder,
  cards: FiscalReceiptGroup[],
  query: string,
): { visible: boolean; expand: boolean } {
  const q = query.trim().toLowerCase();
  if (!q) return { visible: true, expand: false };
  const header = [order.provider, order.provider_order_id, order.note ?? '', order.order_date ?? '']
    .join(' ')
    .toLowerCase();
  const headerHit = header.includes(q);
  const innerHit = cards.some((group) => fiscalReceiptMatchesQuery(group, query))
    || order.components.some((component) => (
      (component.pfr_canonical ?? '').toLowerCase().includes(q)
      || (component.label ?? '').toLowerCase().includes(q)
    ));
  return { visible: headerHit || innerHit, expand: innerHit };
}

export const OPERATION_LINK_UNSUPPORTED_MESSAGE =
  'OPERATION_LINK_UNSUPPORTED: Linking an operation without a fiscal receipt id is not supported. Operation ids are reused after the newest row is deleted, and a fingerprint of date, account, kind, amount, and currency does not identify the replacement row. Link the fiscal receipt id (PFR) instead.';
