// Manual receipt groups. One atomic batch per mutation.
// Operations, balances, analytics, and duplicate checks are not updated here.
// Idempotency rows are kept until reset or backup replace: a replay is never
// treated as a new request, and there is no silent expiry.

import { ValidationError } from './api-error';
import { loadForecastSettings, loadRates } from './forecast/load';
import { canonicalizePfr, groupFiscalReceipts, type FiscalReceiptGroup } from '../shared/fiscal-receipts';
import { PURCHASE_ORDERS_EPOCH_KEY, isLedgerEpoch } from '../shared/purchase-orders';
import {
  areReceiptsSameCalendarDate,
  canonicalFromPfrKey,
  operationMembershipKey,
  pageReceiptGroups,
  pfrMembershipKey,
  projectManualGroup,
  receiptCardKey,
  receiptGroupRenameTarget,
  receiptGroupSearchState,
  resolveReceiptGroupPlace,
  tokenFromOperationKey,
  type MembershipClaim,
  type ReceiptGroup,
  type ReceiptIdentityOperation,
} from '../shared/receipt-groups';

const KEY_RE = /^[\x21-\x7e][\x20-\x7e]{6,198}[\x21-\x7e]$/;
const NAME_MAX = 120;

export interface CreateReceiptGroupInput {
  receipt_keys: string[];
  name: string | null;
  idempotency_key: string;
}

export interface RenameReceiptGroupInput {
  group_id: number;
  name: string | null;
  idempotency_key: string;
}

export interface GroupMutationResult {
  status: 200 | 201;
  replay: boolean;
  body: Record<string, unknown>;
}

interface StoredRequest {
  operation: string;
  request_hash: string;
  response_json: string;
}

interface ManualRow {
  id: number;
  display_name: string | null;
  provider_order_id: string;
  order_date: string | null;
  created_at: string;
}

interface LoadedLedger {
  operations: ReceiptIdentityOperation[];
  epoch: string | null;
  claims: MembershipClaim[];
  componentPfrs: Set<string>;
  manual: ManualRow[];
  ratesE9: Map<string, number>;
  baseCurrency: string;
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

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'idempotency_key' });
  const key = value.trim();
  if (!KEY_RE.test(key)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'idempotency_key' });
  return key;
}

export function parseCreateReceiptGroup(body: unknown): CreateReceiptGroupInput {
  const record = asRecord(body);
  const keysRaw = record.receipt_keys;
  if (!Array.isArray(keysRaw)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'receipt_keys' });
  if (keysRaw.length < 2 || keysRaw.length > 100) {
    throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'receipt_keys' });
  }
  const receiptKeys: string[] = [];
  const seen = new Set<string>();
  for (const key of keysRaw) {
    if (typeof key !== 'string' || key.length < 4 || key.length > 170) {
      throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'receipt_keys' });
    }
    if (seen.has(key)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'receipt_keys' });
    seen.add(key);
    receiptKeys.push(key);
  }
  let name: string | null = null;
  if (record.name !== undefined && record.name !== null) {
    if (typeof record.name !== 'string') throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'name' });
    const trimmed = record.name.trim();
    if (trimmed.length > NAME_MAX) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'name' });
    name = trimmed.length > 0 ? trimmed : null;
  }
  return {
    receipt_keys: receiptKeys,
    name,
    idempotency_key: parseIdempotencyKey(record.idempotency_key),
  };
}

export function parseRenameReceiptGroup(groupId: number, body: unknown): RenameReceiptGroupInput {
  const record = asRecord(body);
  for (const key of Object.keys(record)) {
    if (key !== 'name' && key !== 'idempotency_key') {
      throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: key });
    }
  }
  if (!('name' in record)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'name' });
  let name: string | null = null;
  if (record.name !== null) {
    if (typeof record.name !== 'string') throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'name' });
    const trimmed = record.name.trim();
    if (trimmed.length > NAME_MAX) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'name' });
    name = trimmed.length > 0 ? trimmed : null;
  }
  return {
    group_id: groupId,
    name,
    idempotency_key: parseIdempotencyKey(record.idempotency_key),
  };
}

export async function hashReceiptGroupRequest(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createHashPayload(input: CreateReceiptGroupInput): unknown {
  return {
    operation: 'create',
    receipt_keys: [...input.receipt_keys].sort(),
    name: input.name,
  };
}

async function readStored(db: D1Database, key: string): Promise<StoredRequest | null> {
  return db.prepare(
    `SELECT operation, request_hash, response_json
       FROM receipt_group_requests WHERE idempotency_key = ?`,
  ).bind(key).first<StoredRequest>();
}

function replayOrConflict(stored: StoredRequest, operation: string, hash: string): GroupMutationResult {
  if (stored.operation !== operation || stored.request_hash !== hash) {
    throw new ValidationError('IDEMPOTENCY_CONFLICT', undefined, 409);
  }
  return { status: 200, replay: true, body: JSON.parse(stored.response_json) as Record<string, unknown> };
}

export async function ensureReceiptIdentityTokens(db: D1Database): Promise<void> {
  const { results } = await db.prepare(
    `SELECT id FROM operations
      WHERE receipt_identity_token IS NULL
        AND kind NOT IN ('transfer_out', 'transfer_in')
        AND receipt_url IS NOT NULL
        AND length(trim(receipt_url)) > 0
        AND (fiscal_receipt_id IS NULL OR length(trim(fiscal_receipt_id)) = 0)`,
  ).all<{ id: number }>();
  const missing = results ?? [];
  if (missing.length === 0) return;
  await db.batch(missing.map((row) => db.prepare(
    `UPDATE operations
        SET receipt_identity_token = ?
      WHERE id = ? AND receipt_identity_token IS NULL`,
  ).bind(crypto.randomUUID(), row.id)));
}

async function loadLedger(db: D1Database): Promise<LoadedLedger> {
  const [operations, epochRow, claims, components, manual, ratesE9, settings] = await Promise.all([
    db.prepare(
      `SELECT o.id, o.date, o.account_id, o.kind, o.store, o.item, o.category, o.subcategory,
              o.amount_minor, o.comment, o.receipt_url, o.fiscal_receipt_id, o.receipt_identity_token,
              a.currency AS currency, a.name AS account_name
         FROM operations o
         JOIN accounts a ON a.id = o.account_id`,
    ).all<ReceiptIdentityOperation>(),
    db.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first<{ value: string }>(),
    db.prepare(
      'SELECT order_id, receipt_key, ledger_epoch FROM receipt_membership',
    ).all<MembershipClaim>(),
    db.prepare(
      'SELECT pfr_canonical FROM purchase_order_components WHERE pfr_canonical IS NOT NULL',
    ).all<{ pfr_canonical: string }>(),
    db.prepare(
      `SELECT id, display_name, provider_order_id, order_date, created_at
         FROM purchase_orders WHERE kind = 'manual'`,
    ).all<ManualRow>(),
    loadRates(db),
    loadForecastSettings(db),
  ]);
  return {
    operations: operations.results ?? [],
    epoch: epochRow && isLedgerEpoch(epochRow.value) ? epochRow.value : null,
    claims: claims.results ?? [],
    componentPfrs: new Set((components.results ?? []).map((row) => row.pfr_canonical)),
    manual: manual.results ?? [],
    ratesE9,
    baseCurrency: settings.baseCurrency,
  };
}

function cardsByKey(operations: ReceiptIdentityOperation[]): Map<string, FiscalReceiptGroup[]> {
  const tokenById = new Map<number, string | null>();
  for (const op of operations) tokenById.set(op.id, op.receipt_identity_token ?? null);
  const map = new Map<string, FiscalReceiptGroup[]>();
  for (const card of groupFiscalReceipts(operations)) {
    const key = receiptCardKey(card, tokenById);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(card);
    map.set(key, list);
  }
  return map;
}

function resolveKeysForCreate(keys: string[], loaded: LoadedLedger): FiscalReceiptGroup[] {
  const taken = new Set(loaded.claims.map((claim) => claim.receipt_key));
  const cards = cardsByKey(loaded.operations);
  const matched: FiscalReceiptGroup[] = [];
  for (const key of keys) {
    const canonical = canonicalFromPfrKey(key);
    const token = tokenFromOperationKey(key);
    if (!canonical && !token) throw new ValidationError('STALE_RECEIPT', undefined, 409);
    if (canonical && key !== pfrMembershipKey(canonical)) {
      throw new ValidationError('STALE_RECEIPT', undefined, 409);
    }
    if (taken.has(key) || (canonical !== null && loaded.componentPfrs.has(canonical))) {
      throw new ValidationError('RECEIPT_ALREADY_GROUPED', undefined, 409);
    }
    const matches = cards.get(key) ?? [];
    if (matches.length !== 1) throw new ValidationError('STALE_RECEIPT', undefined, 409);
    matched.push(matches[0]!);
  }
  return matched;
}

function projectOne(
  order: ManualRow,
  loaded: LoadedLedger,
): { group: ReceiptGroup; cards: FiscalReceiptGroup[] } {
  const group = projectManualGroup(
    {
      id: order.id,
      display_name: order.display_name,
      order_date: order.order_date,
      created_at: order.created_at,
    },
    loaded.claims,
    loaded.operations,
    loaded.epoch,
    { ratesE9: loaded.ratesE9, baseCurrency: loaded.baseCurrency },
  );
  const wanted = new Set(group.receipts.filter((receipt) => receipt.resolution === 'resolved').map((receipt) => receipt.receipt_key));
  const tokenById = new Map<number, string | null>();
  for (const op of loaded.operations) tokenById.set(op.id, op.receipt_identity_token ?? null);
  const cards = groupFiscalReceipts(loaded.operations).filter((card) => {
    const key = receiptCardKey(card, tokenById);
    return key !== null && wanted.has(key);
  });
  return { group, cards };
}

function abortUnlessCount(
  db: D1Database,
  publicId: string,
  expectedMembers: number,
  idempotencyKey: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO receipt_group_requests (
       idempotency_key, operation, request_hash, status_code, response_json, created_at
     )
     SELECT 'pfr-conflict-guard-key', 'create',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            201, '{}', 'bad'
      WHERE (
        SELECT COUNT(*)
          FROM receipt_membership m
          JOIN purchase_orders po ON po.id = m.order_id
         WHERE po.provider = 'manual' AND po.provider_order_id = ?
      ) <> ?
         OR NOT EXISTS (
           SELECT 1 FROM receipt_group_requests WHERE idempotency_key = ?
         )`,
  ).bind(publicId, expectedMembers, idempotencyKey);
}

async function runBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  failAt?: number,
): Promise<void> {
  const stmts = statements.slice();
  if (failAt !== undefined) {
    if (!Number.isInteger(failAt) || failAt < 0 || failAt > stmts.length) {
      throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'failAt' });
    }
    stmts.splice(failAt, 0, db.prepare('SELECT probe FROM receipt_group_failure_probe'));
  }
  await db.batch(stmts);
}

function isMembershipRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE') || message.includes('CONSTRAINT') || message.includes('CHECK');
}

export async function createReceiptGroup(
  db: D1Database,
  input: CreateReceiptGroupInput,
  createdVia: 'api' | 'mcp',
  options: { failAt?: number } = {},
): Promise<GroupMutationResult> {
  const hash = await hashReceiptGroupRequest(createHashPayload(input));
  const existing = await readStored(db, input.idempotency_key);
  if (existing) return replayOrConflict(existing, 'create', hash);

  await ensureReceiptIdentityTokens(db);
  const loaded = await loadLedger(db);
  const matchedCards = resolveKeysForCreate(input.receipt_keys, loaded);
  const matchedOpIds = new Set(matchedCards.flatMap((card) => card.lines.map((line) => line.id)));
  const matchedOps = loaded.operations.filter((op) => matchedOpIds.has(op.id));
  const dateCheck = areReceiptsSameCalendarDate([
    ...matchedCards,
    ...matchedOps.map((op) => ({ date: op.date })),
  ]);
  if (!dateCheck.ok || !dateCheck.date) {
    throw new ValidationError('RECEIPT_GROUP_DATE_MISMATCH');
  }
  const place = resolveReceiptGroupPlace(matchedCards, input.name);
  if (!place) {
    throw new ValidationError('RECEIPT_GROUP_PLACE_REQUIRED');
  }

  const epoch = loaded.epoch ?? crypto.randomUUID();
  const publicId = crypto.randomUUID();
  const now = nowIso();
  const preview = projectManualGroup(
    { id: 0, display_name: place, order_date: dateCheck.date, created_at: now },
    input.receipt_keys.map((receipt_key) => ({ order_id: 0, receipt_key, ledger_epoch: epoch })),
    loaded.operations,
    epoch,
    { ratesE9: loaded.ratesE9, baseCurrency: loaded.baseCurrency },
  );
  const snapshot = {
    receipts: preview.receipts,
    subtotals: preview.subtotals,
    base_currency: preview.base_currency,
    total_minor: preview.total_minor,
    total_currency: preview.total_currency,
    missing_rates: preview.missing_rates,
    incomplete: preview.incomplete,
    multi_currency: preview.multi_currency,
  };
  const statements: D1PreparedStatement[] = [];
  if (!loaded.epoch) {
    statements.push(db.prepare(
      `INSERT INTO settings (key, value)
       SELECT ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)`,
    ).bind(PURCHASE_ORDERS_EPOCH_KEY, epoch, PURCHASE_ORDERS_EPOCH_KEY));
  }
  statements.push(db.prepare(
    `INSERT INTO purchase_orders (
       provider, provider_order_id, order_date, note, created_via, created_at, updated_at, kind, display_name
     ) VALUES ('manual', ?, ?, NULL, ?, ?, ?, 'manual', ?)`,
  ).bind(publicId, dateCheck.date, createdVia, now, now, place));
  for (const key of input.receipt_keys) {
    const canonical = canonicalFromPfrKey(key);
    statements.push(db.prepare(
      `INSERT INTO receipt_membership (order_id, receipt_key, ledger_epoch, created_at)
       SELECT po.id, ?, s.value, ?
         FROM purchase_orders po
         JOIN settings s ON s.key = ?
        WHERE po.provider = 'manual' AND po.provider_order_id = ?
          AND NOT EXISTS (SELECT 1 FROM receipt_membership WHERE receipt_key = ?)
          AND (? IS NULL OR NOT EXISTS (
            SELECT 1 FROM purchase_order_components WHERE pfr_canonical = ?
          ))`,
    ).bind(key, now, PURCHASE_ORDERS_EPOCH_KEY, publicId, key, canonical, canonical));
  }
  statements.push(db.prepare(
    `INSERT INTO receipt_group_requests (
       idempotency_key, operation, request_hash, status_code, response_json, created_at
     )
     SELECT ?, 'create', ?, 201,
            json_object(
              'group', json_object(
                'id', po.id,
                'kind', 'manual',
                'name', json(?),
                'place', json(?),
                'date', json(?),
                'number', po.id,
                'receipts', json(?),
                'subtotals', json(?),
                'base_currency', json(?),
                'total_minor', json(?),
                'total_currency', json(?),
                'missing_rates', json(?),
                'incomplete', json(?),
                'multi_currency', json(?)
              )
            ),
            ?
       FROM purchase_orders po
      WHERE po.provider = 'manual' AND po.provider_order_id = ?`,
  ).bind(
    input.idempotency_key,
    hash,
    JSON.stringify(place),
    JSON.stringify(place),
    JSON.stringify(dateCheck.date),
    JSON.stringify(snapshot.receipts),
    JSON.stringify(snapshot.subtotals),
    JSON.stringify(snapshot.base_currency),
    JSON.stringify(snapshot.total_minor),
    JSON.stringify(snapshot.total_currency),
    JSON.stringify(snapshot.missing_rates),
    JSON.stringify(snapshot.incomplete),
    JSON.stringify(snapshot.multi_currency),
    now,
    publicId,
  ));
  statements.push(abortUnlessCount(db, publicId, input.receipt_keys.length, input.idempotency_key));

  try {
    await runBatch(db, statements, options.failAt);
  } catch (error) {
    if (options.failAt !== undefined) throw error;
    const stored = await readStored(db, input.idempotency_key);
    if (stored) return replayOrConflict(stored, 'create', hash);
    if (isMembershipRace(error)) throw new ValidationError('RECEIPT_ALREADY_GROUPED', undefined, 409);
    throw error;
  }
  const stored = await readStored(db, input.idempotency_key);
  if (!stored) throw new ValidationError('RECEIPT_ALREADY_GROUPED', undefined, 409);
  return { status: 201, replay: false, body: JSON.parse(stored.response_json) as Record<string, unknown> };
}

export async function listReceiptGroups(
  db: D1Database,
  query: { q: string; limit: number | null; cursor: number | null },
): Promise<{ groups: ReceiptGroup[]; next_cursor: number | null; limit: number | null }> {
  await ensureReceiptIdentityTokens(db);
  const loaded = await loadLedger(db);
  const matched = loaded.manual
    .map((order) => projectOne(order, loaded))
    .filter((item) => receiptGroupSearchState(item.group, item.cards, query.q).visible)
    .map((item) => item.group);
  return pageReceiptGroups(matched, query);
}

export async function getReceiptGroup(db: D1Database, id: number): Promise<ReceiptGroup> {
  await ensureReceiptIdentityTokens(db);
  const loaded = await loadLedger(db);
  const order = loaded.manual.find((item) => item.id === id);
  if (!order) throw new ValidationError('RECEIPT_GROUP_NOT_FOUND', undefined, 404);
  return projectOne(order, loaded).group;
}

async function requireManual(db: D1Database, id: number): Promise<ManualRow> {
  const row = await db.prepare(
    `SELECT id, display_name, provider_order_id, order_date, created_at
       FROM purchase_orders WHERE id = ? AND kind = 'manual'`,
  ).bind(id).first<ManualRow>();
  if (!row) throw new ValidationError('RECEIPT_GROUP_NOT_FOUND', undefined, 404);
  return row;
}

export async function unlinkReceiptGroupMember(
  db: D1Database,
  groupId: number,
  receiptKey: string,
  idempotencyKey: string,
  options: { failAt?: number } = {},
): Promise<GroupMutationResult> {
  const hash = await hashReceiptGroupRequest({ operation: 'unlink', group_id: groupId, receipt_key: receiptKey });
  const existing = await readStored(db, idempotencyKey);
  if (existing) return replayOrConflict(existing, 'unlink', hash);
  const order = await requireManual(db, groupId);
  const loaded = await loadLedger(db);
  const member = loaded.claims.find((claim) => claim.order_id === order.id && claim.receipt_key === receiptKey);
  if (!member) throw new ValidationError('RECEIPT_NOT_IN_GROUP', undefined, 404);
  const remaining = loaded.claims.filter((claim) => !(claim.order_id === order.id && claim.receipt_key === receiptKey));
  const still = remaining.filter((claim) => claim.order_id === order.id);
  const body: Record<string, unknown> = still.length === 0
    ? { group: null, unlinked: true }
    : {
      group: projectManualGroup(order, remaining, loaded.operations, loaded.epoch, {
        ratesE9: loaded.ratesE9,
        baseCurrency: loaded.baseCurrency,
      }),
      unlinked: true,
    };
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM receipt_membership WHERE order_id = ? AND receipt_key = ?').bind(order.id, receiptKey),
  ];
  if (still.length === 0) {
    statements.push(db.prepare('DELETE FROM purchase_orders WHERE id = ? AND kind = \'manual\'').bind(order.id));
  }
  statements.push(db.prepare(
    `INSERT INTO receipt_group_requests (
       idempotency_key, operation, request_hash, status_code, response_json, created_at
     ) VALUES (?, 'unlink', ?, 200, ?, ?)`,
  ).bind(idempotencyKey, hash, JSON.stringify(body), now));
  try {
    await runBatch(db, statements, options.failAt);
  } catch (error) {
    if (options.failAt !== undefined) throw error;
    const stored = await readStored(db, idempotencyKey);
    if (stored) return replayOrConflict(stored, 'unlink', hash);
    throw error;
  }
  return { status: 200, replay: false, body };
}

export async function deleteReceiptGroup(
  db: D1Database,
  groupId: number,
  idempotencyKey: string,
  options: { failAt?: number } = {},
): Promise<GroupMutationResult> {
  const hash = await hashReceiptGroupRequest({ operation: 'delete', group_id: groupId });
  const existing = await readStored(db, idempotencyKey);
  if (existing) return replayOrConflict(existing, 'delete', hash);
  const order = await requireManual(db, groupId);
  const body = { deleted: true };
  const now = nowIso();
  const statements = [
    db.prepare('DELETE FROM receipt_membership WHERE order_id = ?').bind(order.id),
    db.prepare('DELETE FROM purchase_orders WHERE id = ? AND kind = \'manual\'').bind(order.id),
    db.prepare(
      `INSERT INTO receipt_group_requests (
         idempotency_key, operation, request_hash, status_code, response_json, created_at
       ) VALUES (?, 'delete', ?, 200, ?, ?)`,
    ).bind(idempotencyKey, hash, JSON.stringify(body), now),
  ];
  try {
    await runBatch(db, statements, options.failAt);
  } catch (error) {
    if (options.failAt !== undefined) throw error;
    const stored = await readStored(db, idempotencyKey);
    if (stored) return replayOrConflict(stored, 'delete', hash);
    throw error;
  }
  return { status: 200, replay: false, body };
}

export async function renameReceiptGroup(
  db: D1Database,
  input: RenameReceiptGroupInput,
  options: { failAt?: number } = {},
): Promise<GroupMutationResult> {
  const hash = await hashReceiptGroupRequest({
    operation: 'rename',
    group_id: input.group_id,
    name: input.name,
  });
  const existing = await readStored(db, input.idempotency_key);
  if (existing) return replayOrConflict(existing, 'rename', hash);

  const order = await requireManual(db, input.group_id);
  const loaded = await loadLedger(db);
  const projected = projectOne(order, loaded);
  const target = receiptGroupRenameTarget(projected.cards, input.name);
  if (!target) throw new ValidationError('RECEIPT_GROUP_PLACE_REQUIRED');

  const renamed = projectOne({ ...order, display_name: target.displayName }, loaded).group;
  const body = { group: renamed };
  const now = nowIso();
  const statements = [
    db.prepare(
      `UPDATE purchase_orders
          SET display_name = ?, updated_at = ?
        WHERE id = ? AND kind = 'manual'`,
    ).bind(target.displayName, now, order.id),
    db.prepare(
      `INSERT INTO receipt_group_requests (
         idempotency_key, operation, request_hash, status_code, response_json, created_at
       ) VALUES (?, 'rename', ?, 200, ?, ?)`,
    ).bind(input.idempotency_key, hash, JSON.stringify(body), now),
  ];
  try {
    await runBatch(db, statements, options.failAt);
  } catch (error) {
    if (options.failAt !== undefined) throw error;
    const stored = await readStored(db, input.idempotency_key);
    if (stored) return replayOrConflict(stored, 'rename', hash);
    throw error;
  }
  return { status: 200, replay: false, body };
}

/** Shared-claim statements for the provider-order PFR path. */
export function pfrMembershipInsert(
  db: D1Database,
  orderId: number,
  canonical: string,
  now: string,
): D1PreparedStatement {
  const key = pfrMembershipKey(canonical);
  return db.prepare(
    `INSERT INTO receipt_membership (order_id, receipt_key, ledger_epoch, created_at)
     SELECT ?, ?, s.value, ?
       FROM settings s
      WHERE s.key = ?
        AND EXISTS (
          SELECT 1 FROM purchase_order_components
           WHERE order_id = ? AND pfr_canonical = ?
        )
        AND NOT EXISTS (SELECT 1 FROM receipt_membership WHERE receipt_key = ?)`,
  ).bind(orderId, key, now, PURCHASE_ORDERS_EPOCH_KEY, orderId, canonical, key);
}

export function pfrMembershipDelete(
  db: D1Database,
  orderId: number,
  canonical: string,
): D1PreparedStatement {
  return db.prepare(
    'DELETE FROM receipt_membership WHERE order_id = ? AND receipt_key = ?',
  ).bind(orderId, pfrMembershipKey(canonical));
}

export function abortIfPfrTaken(
  db: D1Database,
  canonical: string,
  exceptOrderId: number,
  exceptComponentId: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO receipt_group_requests (
       idempotency_key, operation, request_hash, status_code, response_json, created_at
     )
     SELECT 'pfr-conflict-guard-key', 'create',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            201, '{}', 'bad'
      WHERE EXISTS (
        SELECT 1 FROM receipt_membership
         WHERE receipt_key = ? AND order_id <> ?
      ) OR EXISTS (
        SELECT 1 FROM purchase_order_components
         WHERE pfr_canonical = ? AND id <> ?
      )`,
  ).bind(pfrMembershipKey(canonical), exceptOrderId, canonical, exceptComponentId);
}

export async function membershipOrderForPfr(db: D1Database, canonical: string): Promise<number | null> {
  const row = await db.prepare(
    'SELECT order_id FROM receipt_membership WHERE receipt_key = ?',
  ).bind(pfrMembershipKey(canonical)).first<{ order_id: number }>();
  return row?.order_id ?? null;
}

export { operationMembershipKey };
