import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { parseBackupDocument } from '../src/worker/backup';
import { PURCHASE_ORDERS_EPOCH_KEY } from '../src/shared/purchase-orders';
import { expectErrorCode } from './api-error-helpers';

let cookie: string;

beforeAll(async () => {
  cookie = (await createSessionCookie(env as unknown as Env, false)).split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM receipt_group_requests'),
    env.DB.prepare('DELETE FROM receipt_membership'),
    env.DB.prepare('DELETE FROM purchase_order_components'),
    env.DB.prepare('DELETE FROM purchase_orders'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM imported_receipt_items'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM account_aliases'),
    env.DB.prepare('DELETE FROM pending_account_strings'),
    env.DB.prepare('DELETE FROM receipts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(PURCHASE_ORDERS_EPOCH_KEY),
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('base_currency', 'USD'), ('low_balance_threshold_minor', '100000')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ]);
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      Cookie: cookie,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env as unknown as Env);
}

async function account() {
  const res = await api('POST', '/api/v2/accounts', {
    name: 'Synth RSD', currency: 'RSD', owner: 'Synth', country: 'SRB', balance_minor: 500000,
  });
  expect(res.status).toBe(201);
  return (await res.json() as { account: { id: number; balance_minor: number } }).account;
}

async function operation(accountId: number, body: Record<string, unknown>) {
  const res = await api('POST', '/api/v2/operations', {
    date: '2026-11-01', account_id: accountId, kind: 'expense', store: 'Synth shop', item: 'Goods', amount_minor: -1250,
    ...body,
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await res.json() as { operation: { id: number; balance_minor?: number } }).operation;
}

async function createOrder(body: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/purchase-orders', {
    provider: 'wolt',
    provider_order_id: 'synthorder0001',
    order_date: '2026-11-01',
    order_total_minor: 1334,
    order_total_currency: 'RSD',
    order_total_source: 'provider_document',
    ...body,
  });
  expect(res.status).toBe(201);
  return (await res.json() as { order: { id: number } }).order;
}

const V235_TABLES = [
  'settings', 'accounts', 'fx_rates', 'receipts', 'pending_account_strings', 'account_aliases',
  'planned_items', 'recurring_items', 'transfers', 'operations', 'recurring_period_fulfillments',
  'imported_receipt_items', 'operation_fulfillment_links', 'import_batches', 'category_rules',
  'statement_templates',
];

function v235TableGate(doc: { format?: unknown; version?: unknown; tables?: Record<string, unknown> }): boolean {
  if (doc.format !== 'money-flow-v2-backup') return false;
  if (doc.version !== 1 && doc.version !== 2) return false;
  const tables = doc.tables ?? {};
  if (Object.keys(tables).some((name) => !V235_TABLES.includes(name))) return false;
  for (const name of V235_TABLES) {
    if (!Array.isArray(tables[name])) {
      if (name === 'statement_templates' && doc.version === 1) continue;
      if (name === 'import_batches' || name === 'category_rules') continue;
      return false;
    }
  }
  return true;
}

describe('purchase orders API', () => {
  it('refuses a no-PFR link because a reused id can match the fingerprint', async () => {
    const acc = await account();
    const created = await operation(acc.id, {
      item: 'Original goods', store: 'Store A', amount_minor: -1250, fiscal_receipt_id: null,
    });
    const before = await env.DB.prepare(
      'SELECT id, date, account_id, kind, amount_minor, item, store FROM operations WHERE id = ?',
    ).bind(created.id).first<{ id: number; date: string; account_id: number; kind: string; amount_minor: number; item: string; store: string }>();
    await env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(created.id).run();
    await env.DB.prepare(
      `INSERT INTO operations (id, date, account_id, kind, item, store, amount_minor, source)
       VALUES (?, ?, ?, ?, 'Replacement goods', 'Store B', ?, 'manual')`,
    ).bind(before!.id, before!.date, before!.account_id, before!.kind, before!.amount_minor).run();
    const after = await env.DB.prepare(
      'SELECT id, date, account_id, kind, amount_minor, item, store FROM operations WHERE id = ?',
    ).bind(created.id).first<{ id: number; item: string; store: string; date: string; account_id: number; kind: string; amount_minor: number }>();
    expect(after?.id).toBe(before?.id);
    expect(after?.item).not.toBe(before?.item);
    const fingerprint = ['date', 'account_id', 'kind', 'amount_minor'] as const;
    expect(fingerprint.every((field) => before?.[field] === after?.[field])).toBe(true);
    const epochBefore = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first();
    expect(epochBefore).toBeNull();
    const order = await createOrder();
    const rejected = await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'operation',
      operation_id: created.id,
      component_type: 'goods',
    });
    expect(rejected.status).toBe(422);
    await expectErrorCode(rejected, 'OPERATION_LINK_UNSUPPORTED');
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_order_components').first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const epochAfter = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first();
    expect(epochAfter).toBeNull();
    const schema = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'purchase_order_components'",
    ).first<{ sql: string }>();
    expect(schema?.sql ?? '').not.toMatch(/operation_id/i);
    expect(schema?.sql ?? '').not.toMatch(/REFERENCES operations/i);
  });

  it('canonicalizes a PFR before the unique link and nets spend', async () => {
    const acc = await account();
    const balanceBefore = acc.balance_minor;
    await operation(acc.id, { item: 'Goods A', amount_minor: -1000, fiscal_receipt_id: 'aaaaaaaa-bbbbbbbb-1' });
    await operation(acc.id, { item: 'Goods B', amount_minor: -250, fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' });
    await operation(acc.id, { item: 'Fee', amount_minor: -84, store: 'Courier', fiscal_receipt_id: 'CCCCCCCC-DDDDDDDD-2' });
    const order = await createOrder();
    const repeat = await api('POST', '/api/v2/purchase-orders', {
      provider: 'wolt', provider_order_id: 'synthorder0001',
    });
    expect(repeat.status).toBe(200);
    expect((await repeat.json() as { created: boolean }).created).toBe(false);
    const goods = await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'aaaaaaaa-bbbbbbbb-1',
    });
    expect(goods.status).toBe(201);
    const fee = await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'service_fee', fiscal_receipt_id: 'cccccccc-dddddddd-2',
    });
    expect(fee.status).toBe(201);
    const listed = await api('GET', '/api/v2/purchase-orders');
    const body = await listed.json() as { orders: Array<{ posted: Array<{ posted_total_minor: number }>; status: string; conflict: boolean }> };
    expect(body.orders[0]?.posted[0]?.posted_total_minor).toBe(1334);
    expect(body.orders[0]?.status).toBe('complete');
    expect(body.orders[0]?.conflict).toBe(false);
    const other = await createOrder({ provider_order_id: 'synthorder0002', order_total_minor: null, order_total_currency: null, order_total_source: null });
    const duplicate = await api('POST', `/api/v2/purchase-orders/${other.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: '  AAAAAAAA-BBBBBBBB-1  ',
    });
    expect(duplicate.status).toBe(409);
    await expectErrorCode(duplicate, 'DOCUMENT_ALREADY_IN_ORDER');
    const nbsp = await api('POST', `/api/v2/purchase-orders/${other.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: '\u00A0AAAAAAAA-BBBBBBBB-1',
    });
    expect(nbsp.status).toBe(409);
    const refund = await operation(acc.id, {
      kind: 'refund', item: 'Refund', amount_minor: 100, fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    expect(refund.id).toBeGreaterThan(0);
    const afterRefund = await api('GET', '/api/v2/purchase-orders');
    const refunded = await afterRefund.json() as { orders: Array<{ provider_order_id: string; posted: Array<{ posted_total_minor: number }>; status: string }> };
    expect(refunded.orders.find((item) => item.provider_order_id === 'synthorder0001')?.posted[0]?.posted_total_minor).toBe(1234);
    const balance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(acc.id).first<{ balance_minor: number }>();
    const opCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    const deleted = await api('DELETE', `/api/v2/purchase-orders/${order.id}`);
    expect(deleted.status).toBe(200);
    expect((await deleted.json() as { operation_count_unchanged: boolean; balance_unchanged: boolean }).operation_count_unchanged).toBe(true);
    const balanceAfter = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(acc.id).first<{ balance_minor: number }>();
    const opCountAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(balanceAfter?.balance_minor).toBe(balance?.balance_minor);
    expect(opCountAfter?.n).toBe(opCount?.n);
    expect(balanceBefore).not.toBe(balanceAfter?.balance_minor);
  });

  it('creates one epoch for concurrent links and hides it from settings writes', async () => {
    const acc = await account();
    const ids = ['AAAAAAAA-BBBBBBBB-1', 'CCCCCCCC-DDDDDDDD-2', 'EEEEEEEE-FFFFFFFF-3', 'GGGGGGGG-HHHHHHHH-4'];
    for (const [index, pfr] of ids.entries()) {
      await operation(acc.id, { item: pfr, fiscal_receipt_id: pfr, amount_minor: -100 * (index + 1) });
    }
    const orders = await Promise.all(ids.map((pfr, index) => createOrder({ provider_order_id: `synthorder000${index + 1}` })));
    await Promise.all(orders.map((order, index) => api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: ids[index],
    })));
    const epochs = await env.DB.prepare(
      'SELECT ledger_epoch FROM purchase_order_components',
    ).all<{ ledger_epoch: string }>();
    const values = new Set((epochs.results ?? []).map((row) => row.ledger_epoch));
    expect(values.size).toBe(1);
    const setting = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first<{ value: string }>();
    expect(setting?.value).toBe([...values][0]);
    const visible = await api('GET', '/api/v2/settings');
    const settings = (await visible.json() as { settings: Record<string, string> }).settings;
    expect(settings[PURCHASE_ORDERS_EPOCH_KEY]).toBeUndefined();
    const blocked = await api('PUT', `/api/v2/settings/${PURCHASE_ORDERS_EPOCH_KEY}`, { value: '22222222-2222-4222-8222-222222222222' });
    expect(blocked.status).toBe(403);
    await expectErrorCode(blocked, 'SETTING_KEY_RESERVED');
    const still = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first<{ value: string }>();
    expect(still?.value).toBe(setting?.value);
  });

  it('keeps a full backup consistent and makes the v2.35 export explicit', async () => {
    const acc = await account();
    await operation(acc.id, { fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1', amount_minor: -1250 });
    const order = await createOrder();
    await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    const full = await api('GET', '/api/v2/backup/export');
    const fullBody = await full.json() as { tables: Record<string, Array<Record<string, unknown>>>; omitted?: unknown };
    expect(fullBody.tables.purchase_orders).toHaveLength(1);
    expect(fullBody.tables.purchase_order_components).toHaveLength(1);
    expect(fullBody.tables.settings.some((row) => row.key === PURCHASE_ORDERS_EPOCH_KEY)).toBe(true);
    expect(v235TableGate(fullBody)).toBe(false);
    expect(parseBackupDocument({ confirm: true, backup: fullBody }).tables.purchase_orders).toHaveLength(1);

    const empty = await api('GET', '/api/v2/backup/export');
    await api('DELETE', `/api/v2/purchase-orders/${order.id}`);
    const emptyRes = await api('GET', '/api/v2/backup/export');
    const emptyBody = await emptyRes.json() as { tables: Record<string, unknown> };
    expect(emptyBody.tables.purchase_orders).toBeUndefined();
    expect(v235TableGate(emptyBody)).toBe(true);
    expect(empty.status).toBe(200);

    await api('POST', '/api/v2/purchase-orders', {
      provider: 'wolt', provider_order_id: 'synthorder0001', order_total_minor: 1334,
      order_total_currency: 'RSD', order_total_source: 'provider_document',
    });
    const again = await api('POST', `/api/v2/purchase-orders/${(await (await api('GET', '/api/v2/purchase-orders')).json() as { orders: Array<{ id: number }> }).orders[0]!.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    expect(again.status).toBe(201);
    const compat = await api('GET', '/api/v2/backup/export?compat=v2.35');
    const compatBody = await compat.json() as {
      tables: Record<string, Array<Record<string, unknown>>>;
      omitted: { purchase_orders: number; purchase_order_components: number };
      warning: string;
    };
    expect(compatBody.tables.purchase_orders).toBeUndefined();
    expect(compatBody.tables.settings.some((row) => row.key === PURCHASE_ORDERS_EPOCH_KEY)).toBe(false);
    expect(compatBody.omitted).toEqual({ purchase_orders: 1, purchase_order_components: 1 });
    expect(compatBody.warning).toMatch(/not included/i);
    expect(v235TableGate(compatBody)).toBe(true);

    const unconfirmed = await api('POST', '/api/v2/backup/import', { confirm: true, backup: compatBody });
    expect(unconfirmed.status).toBe(409);
    await expectErrorCode(unconfirmed, 'ORDER_GROUPINGS_REMOVAL_UNCONFIRMED');
    const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_orders').first<{ n: number }>();
    expect(stillThere?.n).toBe(1);
    const confirmed = await api('POST', '/api/v2/backup/import', {
      confirm: true, backup: compatBody, acknowledge_order_removal: true,
    });
    expect(confirmed.status).toBe(200);
    const gone = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_orders').first<{ n: number }>();
    expect(gone?.n).toBe(0);

    const round = await api('GET', '/api/v2/backup/export');
    const roundBody = await round.json() as { tables: Record<string, unknown[]> };
    const restoredOrder = await api('POST', '/api/v2/purchase-orders', {
      provider: 'wolt', provider_order_id: 'synthorder0009',
    });
    expect(restoredOrder.status).toBe(201);
    const restoredId = (await restoredOrder.json() as { order: { id: number } }).order.id;
    const relink = await api('POST', `/api/v2/purchase-orders/${restoredId}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    expect(relink.status).toBe(201);
    const withOrders = await api('GET', '/api/v2/backup/export');
    const withBody = await withOrders.json() as { tables: { purchase_order_components: Array<Record<string, unknown>> } };
    expect(withBody.tables.purchase_order_components[0]).toBeTruthy();
    withBody.tables.purchase_order_components = [{ ...withBody.tables.purchase_order_components[0], order_id: 999999 }];
    const badRef = await api('POST', '/api/v2/backup/import', { confirm: true, backup: withBody });
    expect(badRef.status).toBe(400);
    await expectErrorCode(badRef, 'BACKUP_REFERENCE_INVALID');
    expect(roundBody.tables).toBeTruthy();
  });

  it('leaves v2.35 reset SQL able to run and marks stale links unresolved', async () => {
    const acc = await account();
    await operation(acc.id, { fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' });
    const order = await createOrder();
    await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM operation_fulfillment_links'),
      env.DB.prepare('DELETE FROM imported_receipt_items'),
      env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
      env.DB.prepare('DELETE FROM operations'),
      env.DB.prepare('DELETE FROM import_batches'),
      env.DB.prepare('DELETE FROM category_rules'),
      env.DB.prepare('DELETE FROM statement_templates'),
      env.DB.prepare('DELETE FROM transfers'),
      env.DB.prepare('DELETE FROM planned_items'),
      env.DB.prepare('DELETE FROM recurring_items'),
      env.DB.prepare('DELETE FROM account_aliases'),
      env.DB.prepare('DELETE FROM pending_account_strings'),
      env.DB.prepare('DELETE FROM receipts'),
      env.DB.prepare('DELETE FROM fx_rates'),
      env.DB.prepare('DELETE FROM accounts'),
      env.DB.prepare(`DELETE FROM settings WHERE key != 'auth_epoch' AND key NOT LIKE 'session_revoked:%' AND key NOT LIKE 'passkey_revoked:%' AND key NOT LIKE 'passkey_disabled:%'`),
    ]);
    const leftover = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_order_components').first<{ n: number }>();
    expect(leftover?.n).toBe(1);
    const epoch = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first();
    expect(epoch).toBeNull();
    const listed = await api('GET', '/api/v2/purchase-orders');
    const body = await listed.json() as { orders: Array<{ status: string; conflict: boolean; components: Array<{ reason: string }>; posted: Array<{ posted_total_minor: number }> }> };
    expect(body.orders[0]?.components[0]?.reason).toBe('epoch_changed');
    expect(body.orders[0]?.posted[0]?.posted_total_minor).toBe(0);
    expect(body.orders[0]?.status).toBe('partial');
    expect(body.orders[0]?.conflict).toBe(false);
  });

  it('does not change analytics or the duplicate decision', async () => {
    const acc = await account();
    const seller = {
      date: '2026-10-06', account_id: acc.id, kind: 'expense', store: 'Apoteka Synth',
      comment: 'Delivery order SYNTH77', fiscal_receipt_id: 'SYNTH-PFR-SELLER-001',
    };
    expect((await api('POST', '/api/v2/operations', { ...seller, item: 'Goods A', amount_minor: -18900 })).status).toBe(201);
    const order = await createOrder({ provider_order_id: 'synth77order', order_total_minor: 107198, order_date: '2026-10-06' });
    await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'SYNTH-PFR-SELLER-001',
    });
    const fee = await api('POST', '/api/v2/operations', {
      ...seller, item: 'Service fee', amount_minor: -8398, store: 'Wolt Synth',
      fiscal_receipt_id: 'SYNTH-PFR-FEE-002',
    });
    expect(fee.status).toBe(201);
    const duplicate = await api('POST', '/api/v2/operations', {
      ...seller, item: 'Goods A', amount_minor: -18900,
    });
    expect(duplicate.status).toBe(409);
    const beforeLink = await (await api('POST', '/api/v2/analytics', {})).json();
    const linked = await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'service_fee', fiscal_receipt_id: 'SYNTH-PFR-FEE-002',
    });
    expect(linked.status).toBe(201);
    const afterLink = await (await api('POST', '/api/v2/analytics', {})).json();
    expect(afterLink).toEqual(beforeLink);
  });

  it('exports a missing epoch and restores stale links without healing them', async () => {
    const acc = await account();
    await operation(acc.id, { fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1', amount_minor: -1250 });
    const order = await createOrder();
    const linked = await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    expect(linked.status).toBe(201);
    const stored = await env.DB.prepare(
      'SELECT ledger_epoch FROM purchase_order_components',
    ).first<{ ledger_epoch: string }>();
    await legacyReset();
    const full = await api('GET', '/api/v2/backup/export');
    expect(full.status).toBe(200);
    const fullBody = await full.json() as {
      tables: { settings: Array<{ key: string; value: string }>; purchase_order_components: Array<{ ledger_epoch: string }> };
    };
    expect(fullBody.tables.purchase_order_components[0]?.ledger_epoch).toBe(stored?.ledger_epoch);
    expect(fullBody.tables.settings.some((row) => row.key === PURCHASE_ORDERS_EPOCH_KEY)).toBe(false);
    const compat = await api('GET', '/api/v2/backup/export?compat=v2.35');
    expect(compat.status).toBe(200);
    const compatBody = await compat.json() as { tables: Record<string, unknown>; omitted: { purchase_orders: number } };
    expect(compatBody.tables.purchase_orders).toBeUndefined();
    expect(compatBody.omitted.purchase_orders).toBe(1);

    const imported = await api('POST', '/api/v2/backup/import', { confirm: true, backup: fullBody });
    expect(imported.status).toBe(200);
    const epoch = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first();
    expect(epoch).toBeNull();
    const kept = await env.DB.prepare('SELECT ledger_epoch FROM purchase_order_components').first<{ ledger_epoch: string }>();
    expect(kept?.ledger_epoch).toBe(stored?.ledger_epoch);
    const fresh = await account();
    const added = await operation(fresh.id, { fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1', amount_minor: -500, item: 'Later goods' });
    const listed = await api('GET', '/api/v2/purchase-orders');
    const body = await listed.json() as { orders: Array<{ components: Array<{ reason: string | null; resolved: boolean; operation_ids: number[] }>; posted: Array<{ posted_total_minor: number; operation_ids: number[] }> }> };
    expect(body.orders[0]?.components[0]?.reason).toBe('epoch_changed');
    expect(body.orders[0]?.components[0]?.resolved).toBe(false);
    expect(body.orders[0]?.components[0]?.operation_ids).not.toContain(added.id);
    expect(body.orders[0]?.posted[0]?.posted_total_minor).toBe(0);
    expect(body.orders[0]?.posted[0]?.operation_ids).not.toContain(added.id);
    const again = await api('GET', '/api/v2/backup/export');
    expect(again.status).toBe(200);
    const againBody = await again.json() as { tables: { settings: Array<{ key: string }>; purchase_order_components: Array<{ ledger_epoch: string }> } };
    expect(againBody.tables.purchase_order_components[0]?.ledger_epoch).toBe(stored?.ledger_epoch);
    expect(againBody.tables.settings.some((row) => row.key === PURCHASE_ORDERS_EPOCH_KEY)).toBe(false);
  });

  it('writes nothing for a no-op link or a cross-order 409, and one epoch wins a race', async () => {
    const acc = await account();
    await operation(acc.id, { item: 'Goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1', amount_minor: -1250 });
    await operation(acc.id, { item: 'Fee', fiscal_receipt_id: 'EEEEEEEE-FFFFFFFF-3', amount_minor: -300, store: 'Courier' });
    const first = await createOrder();
    const second = await createOrder({ provider_order_id: 'synthorder0002' });
    const linked = await api('POST', `/api/v2/purchase-orders/${first.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    expect(linked.status).toBe(201);
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).run();
    const before = await groupingRows();
    const repeat = await api('POST', `/api/v2/purchase-orders/${first.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    expect(repeat.status).toBe(200);
    expect((await repeat.json() as { created: boolean }).created).toBe(false);
    expect(await groupingRows()).toEqual(before);
    const cross = await api('POST', `/api/v2/purchase-orders/${second.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    });
    expect(cross.status).toBe(409);
    await expectErrorCode(cross, 'DOCUMENT_ALREADY_IN_ORDER');
    expect(await groupingRows()).toEqual(before);
    const expected = await api('POST', `/api/v2/purchase-orders/${first.id}/components`, {
      target_kind: 'expected', component_type: 'service_fee', expected_amount_minor: 84, expected_currency: 'RSD', label: 'service fee',
    });
    expect(expected.status).toBe(201);
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).run();
    const afterExpected = await groupingRows();
    const duplicateExpected = await api('POST', `/api/v2/purchase-orders/${first.id}/components`, {
      target_kind: 'expected', component_type: 'service_fee', expected_amount_minor: 84, expected_currency: 'RSD', label: 'service fee',
    });
    expect(duplicateExpected.status).toBe(409);
    await expectErrorCode(duplicateExpected, 'COMPONENT_DUPLICATE');
    expect(await groupingRows()).toEqual(afterExpected);

    const [valid, rejected] = await Promise.all([
      api('POST', `/api/v2/purchase-orders/${first.id}/components`, {
        target_kind: 'pfr', component_type: 'delivery_fee', fiscal_receipt_id: 'EEEEEEEE-FFFFFFFF-3',
      }),
      api('POST', `/api/v2/purchase-orders/${second.id}/components`, {
        target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
      }),
    ]);
    expect([valid.status, rejected.status].sort()).toEqual([201, 409]);
    const epochs = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?',
    ).bind(PURCHASE_ORDERS_EPOCH_KEY).all<{ value: string }>();
    expect(epochs.results).toHaveLength(1);
    const winner = epochs.results?.[0]?.value;
    const freshLink = await env.DB.prepare(
      'SELECT ledger_epoch FROM purchase_order_components WHERE pfr_canonical = ?',
    ).bind('EEEEEEEE-FFFFFFFF-3').first<{ ledger_epoch: string }>();
    expect(freshLink?.ledger_epoch).toBe(winner);
    const stale = await env.DB.prepare(
      'SELECT ledger_epoch FROM purchase_order_components WHERE pfr_canonical = ?',
    ).bind('AAAAAAAA-BBBBBBBB-1').first<{ ledger_epoch: string }>();
    expect(stale?.ledger_epoch).not.toBe(winner);
    const view = await api('GET', '/api/v2/purchase-orders');
    const orders = (await view.json() as { orders: Array<{ id: number; components: Array<{ pfr_canonical: string | null; resolved: boolean; reason: string | null }>; posted: Array<{ posted_total_minor: number; operation_ids: number[] }> }> }).orders;
    const home = orders.find((item) => item.id === first.id);
    expect(home?.components.find((component) => component.pfr_canonical === 'EEEEEEEE-FFFFFFFF-3')?.resolved).toBe(true);
    expect(home?.components.find((component) => component.pfr_canonical === 'AAAAAAAA-BBBBBBBB-1')?.reason).toBe('epoch_changed');
    expect(home?.posted.reduce((sum, row) => sum + row.posted_total_minor, 0)).toBe(300);
  });

  it('hides purchase_orders_epoch from every settings response but keeps it in a full backup', async () => {
    const acc = await account();
    await operation(acc.id, { fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' });
    const order = await createOrder();
    expect((await api('POST', `/api/v2/purchase-orders/${order.id}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
    })).status).toBe(201);
    const epoch = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY).first<{ value: string }>();
    expect(epoch?.value).toBeTruthy();
    const read = await api('GET', '/api/v2/settings');
    const readBody = await read.json() as { settings: Record<string, string> };
    expect(readBody.settings[PURCHASE_ORDERS_EPOCH_KEY]).toBeUndefined();
    expect(JSON.stringify(readBody)).not.toContain(epoch!.value);
    for (const [key, value] of [['base_currency', 'EUR'], ['low_balance_threshold_minor', 50]] as const) {
      const written = await api('PUT', `/api/v2/settings/${key}`, { value });
      expect(written.status).toBe(200);
      const body = await written.json() as { settings: Record<string, string> };
      expect(body.settings[PURCHASE_ORDERS_EPOCH_KEY]).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(epoch!.value);
    }
    const reserved = await api('PUT', `/api/v2/settings/${PURCHASE_ORDERS_EPOCH_KEY}`, { value: '22222222-2222-4222-8222-222222222222' });
    expect(reserved.status).toBe(403);
    const reservedBody = await reserved.json();
    expect(JSON.stringify(reservedBody)).not.toContain(epoch!.value);
    expect(JSON.stringify(reservedBody)).not.toContain('22222222-2222-4222-8222-222222222222');
    const missing = await api('PUT', '/api/v2/settings/not_a_setting', { value: '1' });
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).not.toContain(epoch!.value);
    const backup = await api('GET', '/api/v2/backup/export');
    const dump = await backup.json() as { tables: { settings: Array<{ key: string; value: string }> } };
    expect(dump.tables.settings).toContainEqual({ key: PURCHASE_ORDERS_EPOCH_KEY, value: epoch!.value });
  });
});

async function legacyReset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM imported_receipt_items'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM import_batches'),
    env.DB.prepare('DELETE FROM category_rules'),
    env.DB.prepare('DELETE FROM statement_templates'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM account_aliases'),
    env.DB.prepare('DELETE FROM pending_account_strings'),
    env.DB.prepare('DELETE FROM receipts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare(`DELETE FROM settings WHERE key != 'auth_epoch' AND key NOT LIKE 'session_revoked:%' AND key NOT LIKE 'passkey_revoked:%' AND key NOT LIKE 'passkey_disabled:%'`),
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('base_currency', 'USD'), ('low_balance_threshold_minor', '100000')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ]);
}

async function groupingRows(): Promise<unknown> {
  const [settings, orders, components] = await Promise.all([
    env.DB.prepare('SELECT key, value FROM settings ORDER BY key').all(),
    env.DB.prepare(
      `SELECT id, provider, provider_order_id, order_date, order_total_minor, order_total_currency,
              order_total_source, order_total_reference, note, created_via, created_at, updated_at
         FROM purchase_orders ORDER BY id`,
    ).all(),
    env.DB.prepare(
      `SELECT id, order_id, component_type, target_kind, pfr_canonical, ledger_epoch,
              expected_amount_minor, expected_currency, label, created_at
         FROM purchase_order_components ORDER BY id`,
    ).all(),
  ]);
  return {
    settings: settings.results,
    orders: orders.results,
    components: components.results,
  };
}
