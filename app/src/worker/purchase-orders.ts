// Purchase-order storage. Grouping only: these statements never touch
// operations, accounts, balances, or the duplicate-expense tables.

import { ValidationError } from './api-error';
import { normalizeIso4217CurrencyCode } from '../shared/currency';
import { canonicalizePfr } from '../shared/fiscal-receipts';
import { pfrMembershipKey } from '../shared/receipt-groups';
import {
  abortIfPfrTaken,
  membershipOrderForPfr,
  pfrMembershipDelete,
  pfrMembershipInsert,
} from './receipt-groups';
import {
  COMPONENT_TYPES,
  OPERATION_LINK_UNSUPPORTED_MESSAGE,
  ORDER_TOTAL_SOURCES,
  PURCHASE_ORDERS_EPOCH_KEY,
  isIsoDateOnly,
  isLedgerEpoch,
  isProviderSlug,
  projectOrders,
  type ComponentType,
  type OrderComponentRow,
  type OrderLedgerOp,
  type OrderRow,
  type OrderTotalSource,
  type ProjectedOrder,
} from '../shared/purchase-orders';

export { PURCHASE_ORDERS_EPOCH_KEY, OPERATION_LINK_UNSUPPORTED_MESSAGE };

const COMPONENT_TYPE_SET = new Set<string>(COMPONENT_TYPES);
const SOURCE_SET = new Set<string>(ORDER_TOTAL_SOURCES);

export interface OrderWriteInput {
  provider: string;
  provider_order_id: string;
  order_date: string | null;
  order_total_minor: number | null;
  order_total_currency: string | null;
  order_total_source: OrderTotalSource | null;
  order_total_reference: string | null;
  note: string | null;
}

export interface LedgerProof {
  operation_count_unchanged: boolean;
  balance_unchanged: boolean;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('REQUEST_BODY_INVALID');
  }
  return body as Record<string, unknown>;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('ORDER_FIELD_INVALID', { field });
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new ValidationError('ORDER_FIELD_INVALID', { field });
  return trimmed;
}

function parseTotal(body: Record<string, unknown>): Pick<
  OrderWriteInput,
  'order_total_minor' | 'order_total_currency' | 'order_total_source' | 'order_total_reference'
> {
  const minorRaw = body.order_total_minor;
  const currencyRaw = body.order_total_currency;
  const sourceRaw = body.order_total_source;
  const reference = optionalText(body.order_total_reference, 'order_total_reference', 200);
  if (reference && /:\/\//.test(reference)) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'order_total_reference' });
  }
  const anyTotal = minorRaw !== undefined && minorRaw !== null
    || (typeof currencyRaw === 'string' && currencyRaw.trim() !== '')
    || (typeof sourceRaw === 'string' && sourceRaw.trim() !== '');
  const allMissing = (minorRaw === undefined || minorRaw === null)
    && (currencyRaw === undefined || currencyRaw === null || currencyRaw === '')
    && (sourceRaw === undefined || sourceRaw === null || sourceRaw === '');
  if (allMissing) {
    if (reference) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'order_total_reference' });
    return {
      order_total_minor: null,
      order_total_currency: null,
      order_total_source: null,
      order_total_reference: null,
    };
  }
  if (!anyTotal) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'order_total_minor' });
  if (typeof minorRaw !== 'number' || !Number.isSafeInteger(minorRaw) || minorRaw < 0) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'order_total_minor' });
  }
  const currency = normalizeIso4217CurrencyCode(currencyRaw);
  if (!currency) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'order_total_currency' });
  if (typeof sourceRaw !== 'string' || !SOURCE_SET.has(sourceRaw)) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'order_total_source' });
  }
  return {
    order_total_minor: minorRaw,
    order_total_currency: currency,
    order_total_source: sourceRaw as OrderTotalSource,
    order_total_reference: reference,
  };
}

export function parseOrderWrite(body: unknown, partial: boolean): OrderWriteInput {
  const record = asRecord(body);
  if ('provider' in record && partial) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'provider' });
  }
  if ('provider_order_id' in record && partial) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'provider_order_id' });
  }
  let provider = '';
  let providerOrderId = '';
  if (!partial) {
    if (typeof record.provider !== 'string' || !isProviderSlug(record.provider)) {
      throw new ValidationError('ORDER_FIELD_INVALID', { field: 'provider' });
    }
    provider = record.provider;
    providerOrderId = optionalText(record.provider_order_id, 'provider_order_id', 128) ?? '';
    if (!providerOrderId || providerOrderId.length > 128) {
      throw new ValidationError('ORDER_FIELD_INVALID', { field: 'provider_order_id' });
    }
  }
  let orderDate: string | null = null;
  if (record.order_date !== undefined && record.order_date !== null) {
    if (typeof record.order_date !== 'string' || !isIsoDateOnly(record.order_date)) {
      throw new ValidationError('ORDER_FIELD_INVALID', { field: 'order_date' });
    }
    orderDate = record.order_date;
  }
  const note = optionalText(record.note, 'note', 500);
  return {
    provider,
    provider_order_id: providerOrderId,
    order_date: orderDate,
    note,
    ...parseTotal(record),
  };
}

export function parseOrderPatch(body: unknown, current: OrderRow): OrderWriteInput {
  const record = asRecord(body);
  if ('provider' in record) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'provider' });
  if ('provider_order_id' in record) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'provider_order_id' });
  }
  const next: Record<string, unknown> = {
    order_date: 'order_date' in record ? record.order_date : current.order_date,
    order_total_minor: 'order_total_minor' in record ? record.order_total_minor : current.order_total_minor,
    order_total_currency: 'order_total_currency' in record ? record.order_total_currency : current.order_total_currency,
    order_total_source: 'order_total_source' in record ? record.order_total_source : current.order_total_source,
    order_total_reference: 'order_total_reference' in record ? record.order_total_reference : current.order_total_reference,
    note: 'note' in record ? record.note : current.note,
  };
  const parsed = parseOrderWrite(next, true);
  return {
    ...parsed,
    provider: current.provider,
    provider_order_id: current.provider_order_id,
  };
}

export interface ComponentWrite {
  component_type: ComponentType;
  target_kind: 'pfr' | 'expected' | 'operation';
  fiscal_receipt_id: string | null;
  operation_id: number | null;
  expected_amount_minor: number | null;
  expected_currency: string | null;
  label: string | null;
}

export function parseComponentWrite(body: unknown): ComponentWrite {
  const record = asRecord(body);
  if (typeof record.component_type !== 'string' || !COMPONENT_TYPE_SET.has(record.component_type)) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'component_type' });
  }
  const label = optionalText(record.label, 'label', 120);
  const operationId = record.operation_id;
  const hasOperation = operationId !== undefined && operationId !== null
    || record.target_kind === 'operation';
  if (hasOperation) {
    throw new ValidationError('OPERATION_LINK_UNSUPPORTED', undefined, 422);
  }
  const hasExpected = record.expected_amount_minor !== undefined && record.expected_amount_minor !== null
    || (typeof record.expected_currency === 'string' && record.expected_currency.trim() !== '');
  const fiscal = record.fiscal_receipt_id;
  const hasPfr = fiscal !== undefined && fiscal !== null && fiscal !== '';
  const kind = record.target_kind;
  if (kind !== undefined && kind !== 'pfr' && kind !== 'expected') {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'target_kind' });
  }
  if (hasPfr || kind === 'pfr') {
    if (hasExpected) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'expected_amount_minor' });
    return {
      component_type: record.component_type as ComponentType,
      target_kind: 'pfr',
      fiscal_receipt_id: typeof fiscal === 'string' ? fiscal : null,
      operation_id: null,
      expected_amount_minor: null,
      expected_currency: null,
      label,
    };
  }
  if (typeof record.expected_amount_minor !== 'number' || !Number.isSafeInteger(record.expected_amount_minor) || record.expected_amount_minor === 0) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'expected_amount_minor' });
  }
  const currency = normalizeIso4217CurrencyCode(record.expected_currency);
  if (!currency) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'expected_currency' });
  return {
    component_type: record.component_type as ComponentType,
    target_kind: 'expected',
    fiscal_receipt_id: null,
    operation_id: null,
    expected_amount_minor: record.expected_amount_minor,
    expected_currency: currency,
    label,
  };
}

async function ledgerStamp(db: D1Database): Promise<string> {
  const [count, balances] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>(),
    db.prepare('SELECT id, balance_minor FROM accounts ORDER BY id').all<{ id: number; balance_minor: number }>(),
  ]);
  return JSON.stringify({ n: count?.n ?? 0, b: balances.results ?? [] });
}

async function withProof<T extends Record<string, unknown>>(
  db: D1Database,
  fn: () => Promise<T>,
): Promise<T & LedgerProof> {
  const before = await ledgerStamp(db);
  const result = await fn();
  const after = await ledgerStamp(db);
  return {
    ...result,
    operation_count_unchanged: before === after,
    balance_unchanged: before === after,
  };
}

async function loadRows(db: D1Database): Promise<{
  orders: OrderRow[];
  components: OrderComponentRow[];
  operations: OrderLedgerOp[];
  epoch: string | null;
}> {
  const [orders, components, operations, epoch] = await Promise.all([
    db.prepare(
      `SELECT id, provider, provider_order_id, order_date, order_total_minor, order_total_currency,
              order_total_source, order_total_reference, note
         FROM purchase_orders
        WHERE kind = 'provider'`,
    ).all<OrderRow>(),
    db.prepare(
      `SELECT id, order_id, component_type, target_kind, pfr_canonical, ledger_epoch,
              expected_amount_minor, expected_currency, label
         FROM purchase_order_components`,
    ).all<OrderComponentRow>(),
    db.prepare(
      `SELECT o.id, o.kind, o.amount_minor, o.fiscal_receipt_id, a.currency AS currency
         FROM operations o
         JOIN accounts a ON a.id = o.account_id`,
    ).all<OrderLedgerOp>(),
    db.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first<{ value: string }>(),
  ]);
  return {
    orders: orders.results ?? [],
    components: (components.results ?? []).map((row) => ({
      ...row,
      target_kind: row.target_kind === 'expected' ? 'expected' : 'pfr',
    })),
    operations: operations.results ?? [],
    epoch: epoch && isLedgerEpoch(epoch.value) ? epoch.value : null,
  };
}

export async function listProjectedOrders(db: D1Database): Promise<ProjectedOrder[]> {
  const loaded = await loadRows(db);
  return projectOrders(loaded.orders, loaded.components, loaded.operations, loaded.epoch);
}

async function requireOrder(db: D1Database, id: number): Promise<OrderRow> {
  const row = await db.prepare(
    `SELECT id, provider, provider_order_id, order_date, order_total_minor, order_total_currency,
            order_total_source, order_total_reference, note, kind
       FROM purchase_orders WHERE id = ?`,
  ).bind(id).first<OrderRow & { kind: string }>();
  if (!row || row.kind !== 'provider') throw new ValidationError('ORDER_NOT_FOUND', undefined, 404);
  return row;
}

function orderOf(orders: ProjectedOrder[], id: number): ProjectedOrder {
  const order = orders.find((item) => item.id === id);
  if (!order) throw new ValidationError('ORDER_NOT_FOUND', undefined, 404);
  return order;
}

export async function upsertOrder(
  db: D1Database,
  input: OrderWriteInput,
  createdVia: 'api' | 'mcp',
): Promise<{ created: boolean; order: ProjectedOrder } & LedgerProof> {
  return withProof(db, async () => {
    const now = nowIso();
    const inserted = await db.prepare(
      `INSERT INTO purchase_orders (
         provider, provider_order_id, order_date, order_total_minor, order_total_currency,
         order_total_source, order_total_reference, note, created_via, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_order_id) DO NOTHING`,
    ).bind(
      input.provider,
      input.provider_order_id,
      input.order_date,
      input.order_total_minor,
      input.order_total_currency,
      input.order_total_source,
      input.order_total_reference,
      input.note,
      createdVia,
      now,
      now,
    ).run();
    const created = (inserted.meta.changes ?? 0) > 0;
    const row = await db.prepare(
      'SELECT id FROM purchase_orders WHERE provider = ? AND provider_order_id = ?',
    ).bind(input.provider, input.provider_order_id).first<{ id: number }>();
    if (!row) throw new ValidationError('ORDER_NOT_FOUND', undefined, 404);
    const orders = await listProjectedOrders(db);
    return { created, order: orderOf(orders, row.id) };
  });
}

export async function patchOrder(
  db: D1Database,
  id: number,
  input: OrderWriteInput,
): Promise<{ order: ProjectedOrder } & LedgerProof> {
  return withProof(db, async () => {
    await requireOrder(db, id);
    const updated = await db.prepare(
      `UPDATE purchase_orders
          SET order_date = ?, order_total_minor = ?, order_total_currency = ?,
              order_total_source = ?, order_total_reference = ?, note = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(
      input.order_date,
      input.order_total_minor,
      input.order_total_currency,
      input.order_total_source,
      input.order_total_reference,
      input.note,
      nowIso(),
      id,
    ).run();
    if ((updated.meta.changes ?? 0) < 1) throw new ValidationError('ORDER_NOT_FOUND', undefined, 404);
    return { order: orderOf(await listProjectedOrders(db), id) };
  });
}

export async function deleteOrder(
  db: D1Database,
  id: number,
): Promise<{ ok: true } & LedgerProof> {
  return withProof(db, async () => {
    await requireOrder(db, id);
    await db.batch([
      db.prepare('DELETE FROM receipt_membership WHERE order_id = ?').bind(id),
      db.prepare('DELETE FROM purchase_order_components WHERE order_id = ?').bind(id),
      db.prepare('DELETE FROM purchase_orders WHERE id = ?').bind(id),
    ]);
    return { ok: true as const };
  });
}

async function pfrIsLinked(db: D1Database, pfr: string): Promise<void> {
  const { results } = await db.prepare(
    `SELECT o.id, o.kind, o.fiscal_receipt_id
       FROM operations o
      WHERE o.fiscal_receipt_id IS NOT NULL`,
  ).all<{ id: number; kind: string; fiscal_receipt_id: string }>();
  const found = (results ?? []).some((row) => {
    if (row.kind === 'transfer_out' || row.kind === 'transfer_in') return false;
    const parsed = canonicalizePfr(row.fiscal_receipt_id);
    return parsed.ok && parsed.value === pfr;
  });
  if (!found) throw new ValidationError('LINK_TARGET_NOT_FOUND', undefined, 404);
}

export async function linkComponent(
  db: D1Database,
  orderId: number,
  input: ComponentWrite,
): Promise<{ created: boolean; component_id: number; order: ProjectedOrder } & LedgerProof> {
  if (input.target_kind === 'operation') {
    throw new ValidationError('OPERATION_LINK_UNSUPPORTED', undefined, 422);
  }
  return withProof(db, async () => {
    await requireOrder(db, orderId);
    const now = nowIso();
    const epoch = crypto.randomUUID();
    if (input.target_kind === 'pfr') {
      const parsed = canonicalizePfr(input.fiscal_receipt_id);
      if (!parsed.ok) throw new ValidationError('INVALID_FISCAL_RECEIPT_ID');
      if (!parsed.value) throw new ValidationError('LINK_TARGET_NOT_FOUND', undefined, 404);
      await pfrIsLinked(db, parsed.value);
      const batch = await db.batch([
        db.prepare(
          `INSERT INTO settings (key, value)
           SELECT ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)
             AND NOT EXISTS (
               SELECT 1 FROM purchase_order_components WHERE pfr_canonical = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM receipt_membership WHERE receipt_key = ?
             )`,
        ).bind(
          PURCHASE_ORDERS_EPOCH_KEY,
          epoch,
          PURCHASE_ORDERS_EPOCH_KEY,
          parsed.value,
          pfrMembershipKey(parsed.value),
        ),
        db.prepare(
          `INSERT INTO purchase_order_components (
             order_id, component_type, target_kind, pfr_canonical, ledger_epoch, label, created_at
           )
           SELECT ?, ?, 'pfr', ?, s.value, ?, ?
             FROM settings s
            WHERE s.key = ?
              AND NOT EXISTS (
                SELECT 1 FROM purchase_order_components WHERE pfr_canonical = ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM receipt_membership WHERE receipt_key = ?
              )`,
        ).bind(
          orderId,
          input.component_type,
          parsed.value,
          input.label,
          now,
          PURCHASE_ORDERS_EPOCH_KEY,
          parsed.value,
          pfrMembershipKey(parsed.value),
        ),
        pfrMembershipInsert(db, orderId, parsed.value, now),
      ]);
      const created = (batch[1]?.meta.changes ?? 0) > 0;
      const existing = await db.prepare(
        'SELECT id, order_id FROM purchase_order_components WHERE pfr_canonical = ?',
      ).bind(parsed.value).first<{ id: number; order_id: number }>();
      if (!existing) {
        const holder = await membershipOrderForPfr(db, parsed.value);
        if (holder !== null) throw new ValidationError('RECEIPT_ALREADY_GROUPED', undefined, 409);
        throw new ValidationError('LINK_TARGET_NOT_FOUND', undefined, 404);
      }
      if (existing.order_id !== orderId) {
        throw new ValidationError('DOCUMENT_ALREADY_IN_ORDER', undefined, 409);
      }
      return {
        created,
        component_id: existing.id,
        order: orderOf(await listProjectedOrders(db), orderId),
      };
    }
    const batch = await db.batch([
      db.prepare(
        `INSERT INTO settings (key, value)
         SELECT ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)
           AND NOT EXISTS (
             SELECT 1 FROM purchase_order_components
              WHERE order_id = ? AND target_kind = 'expected' AND component_type = ?
                AND expected_amount_minor = ? AND expected_currency = ?
                AND ifnull(label, '') = ifnull(?, '')
           )`,
      ).bind(
        PURCHASE_ORDERS_EPOCH_KEY,
        epoch,
        PURCHASE_ORDERS_EPOCH_KEY,
        orderId,
        input.component_type,
        input.expected_amount_minor,
        input.expected_currency,
        input.label,
      ),
      db.prepare(
        `INSERT INTO purchase_order_components (
           order_id, component_type, target_kind, ledger_epoch, expected_amount_minor,
           expected_currency, label, created_at
         )
         SELECT ?, ?, 'expected', s.value, ?, ?, ?, ?
           FROM settings s
          WHERE s.key = ?
            AND NOT EXISTS (
              SELECT 1 FROM purchase_order_components
               WHERE order_id = ? AND target_kind = 'expected' AND component_type = ?
                 AND expected_amount_minor = ? AND expected_currency = ?
                 AND ifnull(label, '') = ifnull(?, '')
            )`,
      ).bind(
        orderId,
        input.component_type,
        input.expected_amount_minor,
        input.expected_currency,
        input.label,
        now,
        PURCHASE_ORDERS_EPOCH_KEY,
        orderId,
        input.component_type,
        input.expected_amount_minor,
        input.expected_currency,
        input.label,
      ),
    ]);
    if ((batch[1]?.meta.changes ?? 0) < 1) {
      throw new ValidationError('COMPONENT_DUPLICATE', undefined, 409);
    }
    const id = Number(batch[1]?.meta.last_row_id ?? 0);
    return {
      created: true,
      component_id: id,
      order: orderOf(await listProjectedOrders(db), orderId),
    };
  });
}

export interface OrderListQuery {
  q: string;
  limit: number | null;
  cursor: number | null;
}

export interface OrderListPage {
  orders: ProjectedOrder[];
  next_cursor: number | null;
  limit: number | null;
}

function orderSearchText(order: ProjectedOrder): string {
  return [
    order.provider,
    order.provider_order_id,
    order.note ?? '',
    order.order_date ?? '',
    ...order.components.flatMap((component) => [component.pfr_canonical ?? '', component.label ?? '']),
  ].join('\n').toLowerCase();
}

/** Filter and page already-projected orders. A date in `q` only filters text. */
export function pageProjectedOrders(orders: ProjectedOrder[], query: OrderListQuery): OrderListPage {
  const needle = query.q.trim().toLowerCase();
  const matched = needle.length === 0
    ? orders
    : orders.filter((order) => orderSearchText(order).includes(needle));
  const sorted = [...matched].sort((left, right) => left.id - right.id);
  const after = query.cursor === null ? sorted : sorted.filter((order) => order.id > query.cursor!);
  if (query.limit === null) return { orders: after, next_cursor: null, limit: null };
  const page = after.slice(0, query.limit);
  const next = after.length > query.limit ? page[page.length - 1]?.id ?? null : null;
  return { orders: page, next_cursor: next, limit: query.limit };
}

export async function listProjectedOrdersPage(db: D1Database, query: OrderListQuery): Promise<OrderListPage> {
  return pageProjectedOrders(await listProjectedOrders(db), query);
}

export interface OrderReceipt {
  operation_id: number;
  date: string;
  account_id: number;
  kind: string;
  store: string | null;
  item: string | null;
  amount_minor: number;
  currency: string;
  fiscal_receipt_id: string | null;
  pfr_canonical: string;
  component_ids: number[];
  counted: boolean;
}

export interface InspectedOrder extends ProjectedOrder {
  receipts: OrderReceipt[];
  difference_minor: number | null;
}

export async function getProjectedOrder(db: D1Database, id: number): Promise<InspectedOrder> {
  const order = orderOf(await listProjectedOrders(db), id);
  const rows = await db.prepare(
    `SELECT o.id, o.date, o.account_id, o.kind, o.store, o.item, o.amount_minor,
            o.fiscal_receipt_id, a.currency AS currency
       FROM operations o
       JOIN accounts a ON a.id = o.account_id
      WHERE o.fiscal_receipt_id IS NOT NULL`,
  ).all<{
    id: number;
    date: string;
    account_id: number;
    kind: string;
    store: string | null;
    item: string | null;
    amount_minor: number;
    fiscal_receipt_id: string | null;
    currency: string;
  }>();
  const linked = new Set(
    order.components.map((component) => component.pfr_canonical).filter((value): value is string => Boolean(value)),
  );
  const counted = new Set(order.posted.flatMap((row) => row.operation_ids));
  const receipts: OrderReceipt[] = [];
  for (const row of rows.results ?? []) {
    const parsed = canonicalizePfr(row.fiscal_receipt_id);
    if (!parsed.ok || !parsed.value || !linked.has(parsed.value)) continue;
    receipts.push({
      operation_id: row.id,
      date: row.date,
      account_id: row.account_id,
      kind: row.kind,
      store: row.store,
      item: row.item,
      amount_minor: row.amount_minor,
      currency: row.currency,
      fiscal_receipt_id: row.fiscal_receipt_id,
      pfr_canonical: parsed.value,
      component_ids: order.components
        .filter((component) => component.pfr_canonical === parsed.value)
        .map((component) => component.id),
      counted: counted.has(row.id),
    });
  }
  receipts.sort((left, right) => left.operation_id - right.operation_id);
  const postedForDeclared = order.order_total_currency
    ? (order.posted.find((row) => row.currency === order.order_total_currency)?.posted_total_minor ?? 0)
    : null;
  const difference = order.status === 'multi_currency' || order.order_total_minor === null || postedForDeclared === null
    ? null
    : order.order_total_minor - postedForDeclared;
  return { ...order, receipts, difference_minor: difference };
}

interface StoredComponent {
  id: number;
  component_type: string;
  target_kind: 'pfr' | 'expected';
  pfr_canonical: string | null;
  expected_amount_minor: number | null;
  expected_currency: string | null;
  label: string | null;
}

export interface ComponentPatch {
  component_type: ComponentType;
  label: string | null;
  pfr_canonical: string | null;
  expected_amount_minor: number | null;
  expected_currency: string | null;
}

export function parseComponentPatch(body: unknown, current: StoredComponent): ComponentPatch {
  const record = asRecord(body);
  const allowed = ['component_type', 'label', 'fiscal_receipt_id', 'expected_amount_minor', 'expected_currency'];
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new ValidationError('ORDER_FIELD_INVALID', { field: unknown[0]! });
  if (record.target_kind !== undefined || record.operation_id !== undefined) {
    throw new ValidationError('OPERATION_LINK_UNSUPPORTED', undefined, 422);
  }
  if (Object.keys(record).length === 0) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'body' });
  let componentType = current.component_type;
  if ('component_type' in record) {
    if (typeof record.component_type !== 'string' || !COMPONENT_TYPE_SET.has(record.component_type)) {
      throw new ValidationError('ORDER_FIELD_INVALID', { field: 'component_type' });
    }
    componentType = record.component_type;
  }
  const label = 'label' in record ? optionalText(record.label, 'label', 120) : current.label;
  if (current.target_kind === 'pfr') {
    if ('expected_amount_minor' in record || 'expected_currency' in record) {
      throw new ValidationError('ORDER_FIELD_INVALID', { field: 'expected_amount_minor' });
    }
    let pfr = current.pfr_canonical;
    if ('fiscal_receipt_id' in record) {
      if (typeof record.fiscal_receipt_id !== 'string' || record.fiscal_receipt_id.trim() === '') {
        throw new ValidationError('ORDER_FIELD_INVALID', { field: 'fiscal_receipt_id' });
      }
      const parsed = canonicalizePfr(record.fiscal_receipt_id);
      if (!parsed.ok || !parsed.value) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'fiscal_receipt_id' });
      pfr = parsed.value;
    }
    return {
      component_type: componentType as ComponentType,
      label,
      pfr_canonical: pfr,
      expected_amount_minor: null,
      expected_currency: null,
    };
  }
  if ('fiscal_receipt_id' in record) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'fiscal_receipt_id' });
  }
  let amount = current.expected_amount_minor;
  let currency = current.expected_currency;
  if ('expected_amount_minor' in record) {
    if (typeof record.expected_amount_minor !== 'number' || !Number.isSafeInteger(record.expected_amount_minor) || record.expected_amount_minor === 0) {
      throw new ValidationError('ORDER_FIELD_INVALID', { field: 'expected_amount_minor' });
    }
    amount = record.expected_amount_minor;
  }
  if ('expected_currency' in record) {
    const next = normalizeIso4217CurrencyCode(record.expected_currency);
    if (!next) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'expected_currency' });
    currency = next;
  }
  return {
    component_type: componentType as ComponentType,
    label,
    pfr_canonical: null,
    expected_amount_minor: amount,
    expected_currency: currency,
  };
}

export async function updateComponent(
  db: D1Database,
  orderId: number,
  componentId: number,
  patch: ComponentPatch,
): Promise<{ component_id: number; order: ProjectedOrder } & LedgerProof> {
  return withProof(db, async () => {
    await requireOrder(db, orderId);
    const current = await db.prepare(
      'SELECT pfr_canonical FROM purchase_order_components WHERE id = ? AND order_id = ?',
    ).bind(componentId, orderId).first<{ pfr_canonical: string | null }>();
    if (!current) throw new ValidationError('COMPONENT_NOT_FOUND', undefined, 404);
    if (patch.pfr_canonical) {
      const taken = await db.prepare(
        'SELECT id FROM purchase_order_components WHERE pfr_canonical = ? AND id <> ?',
      ).bind(patch.pfr_canonical, componentId).first<{ id: number }>();
      if (taken) throw new ValidationError('DOCUMENT_ALREADY_IN_ORDER', undefined, 409);
      const holder = await membershipOrderForPfr(db, patch.pfr_canonical);
      if (holder !== null && holder !== orderId) {
        throw new ValidationError('RECEIPT_ALREADY_GROUPED', undefined, 409);
      }
    }
    const now = nowIso();
    const statements = [];
    if (patch.pfr_canonical) {
      statements.push(abortIfPfrTaken(db, patch.pfr_canonical, orderId, componentId));
    }
    if (current.pfr_canonical && current.pfr_canonical !== patch.pfr_canonical) {
      statements.push(pfrMembershipDelete(db, orderId, current.pfr_canonical));
    }
    statements.push(db.prepare(
      `UPDATE purchase_order_components
          SET component_type = ?, label = ?, pfr_canonical = ?,
              expected_amount_minor = ?, expected_currency = ?
        WHERE id = ? AND order_id = ?`,
    ).bind(
      patch.component_type,
      patch.label,
      patch.pfr_canonical,
      patch.expected_amount_minor,
      patch.expected_currency,
      componentId,
      orderId,
    ));
    if (patch.pfr_canonical) {
      statements.push(pfrMembershipInsert(db, orderId, patch.pfr_canonical, now));
    }
    try {
      await db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE') || message.includes('CONSTRAINT') || message.includes('CHECK')) {
        throw new ValidationError('RECEIPT_ALREADY_GROUPED', undefined, 409);
      }
      throw error;
    }
    return { component_id: componentId, order: orderOf(await listProjectedOrders(db), orderId) };
  });
}

export async function unlinkComponent(
  db: D1Database,
  orderId: number,
  componentId: number,
): Promise<{ ok: true; order: ProjectedOrder } & LedgerProof> {
  return withProof(db, async () => {
    await requireOrder(db, orderId);
    const current = await db.prepare(
      'SELECT pfr_canonical FROM purchase_order_components WHERE id = ? AND order_id = ?',
    ).bind(componentId, orderId).first<{ pfr_canonical: string | null }>();
    if (!current) throw new ValidationError('COMPONENT_NOT_FOUND', undefined, 404);
    const statements = [];
    if (current.pfr_canonical) statements.push(pfrMembershipDelete(db, orderId, current.pfr_canonical));
    statements.push(db.prepare(
      'DELETE FROM purchase_order_components WHERE id = ? AND order_id = ?',
    ).bind(componentId, orderId));
    await db.batch(statements);
    return { ok: true as const, order: orderOf(await listProjectedOrders(db), orderId) };
  });
}
