import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { createReceiptGroup } from '../src/worker/receipt-groups';
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
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare(`DELETE FROM settings WHERE key = 'purchase_orders_epoch'`),
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

async function account(currency = 'RSD') {
  const res = await api('POST', '/api/v2/accounts', {
    name: `Synth ${currency}`, currency, owner: 'Synth', country: 'SRB', balance_minor: 500000,
  });
  expect(res.status).toBe(201);
  return (await res.json() as { account: { id: number; balance_minor: number } }).account;
}

async function operation(accountId: number, body: Record<string, unknown>) {
  const res = await api('POST', '/api/v2/operations', {
    date: '2026-11-01', account_id: accountId, kind: 'expense', store: 'Synth shop', item: 'Goods', amount_minor: -1000,
    ...body,
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await res.json() as { operation: { id: number; receipt_identity_token: string | null } }).operation;
}

async function keysFor(ids: number[]): Promise<string[]> {
  const listed = await api('GET', '/api/v2/receipt-groups');
  expect(listed.status).toBe(200);
  const ops = await api('GET', '/api/v2/operations');
  const rows = (await ops.json() as { operations: Array<{ id: number; receipt_identity_token: string | null; fiscal_receipt_id: string | null }> }).operations;
  return ids.map((id) => {
    const row = rows.find((item) => item.id === id);
    if (row?.fiscal_receipt_id) return `pfr:${row.fiscal_receipt_id.trim().toUpperCase()}`;
    if (!row?.receipt_identity_token) throw new Error(`missing token for ${id}`);
    return `op:${row.receipt_identity_token}`;
  });
}

async function ledger() {
  const ops = await env.DB.prepare(
    `SELECT id, date, account_id, kind, amount_minor, item, store, fiscal_receipt_id, receipt_url, receipt_identity_token
       FROM operations ORDER BY id`,
  ).all();
  const balances = await env.DB.prepare('SELECT id, balance_minor FROM accounts ORDER BY id').all();
  const analytics = await api('POST', '/api/v2/analytics', {});
  expect(analytics.status).toBe(200);
  return { ops: ops.results, balances: balances.results, analytics: await analytics.json() };
}

async function counts() {
  const orders = await env.DB.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE kind = 'manual'`).first<{ n: number }>();
  const members = await env.DB.prepare('SELECT COUNT(*) AS n FROM receipt_membership').first<{ n: number }>();
  const requests = await env.DB.prepare('SELECT COUNT(*) AS n FROM receipt_group_requests').first<{ n: number }>();
  return { orders: orders?.n ?? 0, members: members?.n ?? 0, requests: requests?.n ?? 0 };
}

describe('receipt groups API', () => {
  it('groups two receipts atomically, replays, and leaves the ledger unchanged', async () => {
    const acc = await account();
    const first = await operation(acc.id, { receipt_url: 'https://receipts.example/one', fiscal_receipt_id: null, amount_minor: -1000 });
    const second = await operation(acc.id, {
      receipt_url: 'https://receipts.example/two', fiscal_receipt_id: null, amount_minor: 250, kind: 'refund', item: 'Refund',
    });
    const [left, right] = await keysFor([first.id, second.id]);
    const before = await ledger();
    const created = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [left, right],
      name: 'Market run',
      idempotency_key: 'idem-group-create-01',
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { group: { id: number; name: string; subtotals: Array<{ posted_minor: number; document_minor: null; document_known: false }>; multi_currency: boolean } };
    expect(body.group.name).toBe('Market run');
    expect(body.group.subtotals[0]?.posted_minor).toBe(-750);
    expect(body.group.subtotals[0]?.document_known).toBe(false);
    expect(body.group.subtotals[0]?.document_minor).toBeNull();
    const replay = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [right, left],
      name: 'Market run',
      idempotency_key: 'idem-group-create-01',
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { group: { id: number } }).group.id).toBe(body.group.id);
    expect(await counts()).toMatchObject({ orders: 1, members: 2, requests: 1 });
    const conflict = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [left, right],
      name: 'Other name',
      idempotency_key: 'idem-group-create-01',
    });
    expect(conflict.status).toBe(409);
    await expectErrorCode(conflict, 'IDEMPOTENCY_CONFLICT');
    expect(await ledger()).toEqual(before);
    const hidden = await api('GET', `/api/v2/purchase-orders/${body.group.id}`);
    expect(hidden.status).toBe(404);
  });

  it('rejects fewer than two keys, duplicates, and a receipt that is already grouped', async () => {
    const acc = await account();
    const first = await operation(acc.id, { fiscal_receipt_id: 'synth-pfr-1', receipt_url: null, item: 'Goods A', amount_minor: -1000 });
    const second = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-2', receipt_url: null, item: 'Goods B', amount_minor: -250 });
    const [left, right] = await keysFor([first.id, second.id]);
    const one = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [left], idempotency_key: 'idem-group-one-key',
    });
    expect(one.status).toBe(400);
    const duplicate = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [left, left], idempotency_key: 'idem-group-duplicate',
    });
    expect(duplicate.status).toBe(400);
    const order = await api('POST', '/api/v2/purchase-orders', {
      provider: 'wolt', provider_order_id: 'synthorder0001',
    });
    expect(order.status).toBe(201);
    const orderId = (await order.json() as { order: { id: number } }).order.id;
    const linked = await api('POST', `/api/v2/purchase-orders/${orderId}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'synth-pfr-1',
    });
    expect(linked.status).toBe(201);
    const taken = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [left, right], idempotency_key: 'idem-group-taken',
    });
    expect(taken.status).toBe(409);
    await expectErrorCode(taken, 'RECEIPT_ALREADY_GROUPED');
    expect((await counts()).orders).toBe(0);
  });

  it('blocks a provider link to a manual member and keeps one remaining member', async () => {
    const acc = await account();
    const first = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-A', receipt_url: null, amount_minor: -400 });
    const second = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-B', receipt_url: null, amount_minor: -50 });
    const [left, right] = await keysFor([first.id, second.id]);
    const created = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [left, right], idempotency_key: 'idem-group-manual-first',
    });
    expect(created.status).toBe(201);
    const groupId = (await created.json() as { group: { id: number } }).group.id;
    const order = await api('POST', '/api/v2/purchase-orders', {
      provider: 'wolt', provider_order_id: 'synthorder0002',
    });
    const orderId = (await order.json() as { order: { id: number } }).order.id;
    const blocked = await api('POST', `/api/v2/purchase-orders/${orderId}/components`, {
      target_kind: 'pfr', component_type: 'goods', fiscal_receipt_id: 'synth-pfr-a',
    });
    expect(blocked.status).toBe(409);
    await expectErrorCode(blocked, 'RECEIPT_ALREADY_GROUPED');
    const unlinked = await api('DELETE', `/api/v2/receipt-groups/${groupId}/receipts/${encodeURIComponent(left)}?idempotency_key=idem-group-unlink-one`);
    expect(unlinked.status).toBe(200);
    const remaining = await unlinked.json() as { group: { receipts: unknown[] } | null };
    expect(remaining.group?.receipts).toHaveLength(1);
    const again = await api('DELETE', `/api/v2/receipt-groups/${groupId}/receipts/${encodeURIComponent(left)}?idempotency_key=idem-group-unlink-one`);
    expect(again.status).toBe(200);
    const last = await api('DELETE', `/api/v2/receipt-groups/${groupId}/receipts/${encodeURIComponent(right)}?idempotency_key=idem-group-unlink-last`);
    expect(last.status).toBe(200);
    expect((await last.json() as { group: unknown }).group).toBeNull();
    expect((await counts()).orders).toBe(0);
    const providerRows = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_order_components').first<{ n: number }>();
    expect(providerRows?.n).toBe(0);
  });

  it('drops a reused operation id because the token is not copied onto the new row', async () => {
    const acc = await account();
    const first = await operation(acc.id, { receipt_url: 'https://receipts.example/old', fiscal_receipt_id: null, item: 'Original', amount_minor: -1000 });
    const second = await operation(acc.id, { receipt_url: 'https://receipts.example/keep', fiscal_receipt_id: null, item: 'Kept', amount_minor: -250 });
    const [oldKey, keepKey] = await keysFor([first.id, second.id]);
    await env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(first.id).run();
    await env.DB.prepare(
      `INSERT INTO operations (id, date, account_id, kind, item, store, amount_minor, source, receipt_url)
       VALUES (?, '2026-11-01', ?, 'expense', 'Replacement', 'Other shop', -1000, 'manual', 'https://receipts.example/new')`,
    ).bind(first.id, acc.id).run();
    const bare = await env.DB.prepare('SELECT receipt_identity_token FROM operations WHERE id = ?').bind(first.id).first<{ receipt_identity_token: string | null }>();
    expect(bare?.receipt_identity_token).toBeNull();
    const stale = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [oldKey, keepKey], idempotency_key: 'idem-group-stale-token',
    });
    expect(stale.status).toBe(409);
    await expectErrorCode(stale, 'STALE_RECEIPT');
    const [fresh] = await keysFor([first.id]);
    expect(fresh).not.toBe(oldKey);
    const unnamed = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [fresh, keepKey], idempotency_key: 'idem-group-fresh-unnamed',
    });
    expect(unnamed.status).toBe(400);
    await expectErrorCode(unnamed, 'RECEIPT_GROUP_PLACE_REQUIRED');
    const created = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [fresh, keepKey], name: 'Combined visit', idempotency_key: 'idem-group-fresh-token',
    });
    expect(created.status).toBe(201);
  });

  it('rolls back every prefix of the create batch', async () => {
    const acc = await account();
    const first = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-ROLL-1', receipt_url: null, item: 'Roll A', amount_minor: -1000 });
    const second = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-ROLL-2', receipt_url: null, item: 'Roll B', amount_minor: -250 });
    const [left, right] = await keysFor([first.id, second.id]);
    for (const failAt of [0, 1, 2, 3, 4, 5]) {
      await expect(createReceiptGroup(env.DB, {
        receipt_keys: [left, right],
        name: null,
        idempotency_key: 'idem-group-failat',
      }, 'api', { failAt })).rejects.toThrow();
      expect(await counts(), `failAt ${failAt}`).toEqual({ orders: 0, members: 0, requests: 0 });
    }
    const created = await createReceiptGroup(env.DB, {
      receipt_keys: [left, right],
      name: null,
      idempotency_key: 'idem-group-failat',
    }, 'api');
    expect(created.status).toBe(201);
    expect((await counts()).orders).toBe(1);
  });

  it('reports mixed currencies, converts with saved rates, omits empty grouping tables, and round-trips a full backup', async () => {
    const rsd = await account('RSD');
    const usd = await account('USD');
    const first = await operation(rsd.id, { fiscal_receipt_id: 'SYNTH-PFR-RSD', receipt_url: null, amount_minor: -1000 });
    const second = await operation(usd.id, { fiscal_receipt_id: 'SYNTH-PFR-USD', receipt_url: null, amount_minor: -20 });
    const [left, right] = await keysFor([first.id, second.id]);
    const created = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [left, right], idempotency_key: 'idem-group-fx',
    });
    const group = (await created.json() as {
      group: {
        id: number;
        multi_currency: boolean;
        incomplete: boolean;
        missing_rates: string[];
        total_minor: number | null;
        total_currency: string | null;
        subtotals: Array<{ currency: string }>;
      };
    }).group;
    expect(group.multi_currency).toBe(true);
    expect(group.incomplete).toBe(true);
    expect(group.missing_rates).toEqual(['RSD']);
    expect(group.total_minor).toBeNull();
    expect(group.total_currency).toBe('USD');
    expect(group.subtotals.map((row) => row.currency).sort()).toEqual(['RSD', 'USD']);
    const rateSaved = await api('PUT', '/api/v2/fx-rates/RSD', { rate: '0.01' });
    expect(rateSaved.status).toBe(200);
    const convertedRes = await api('GET', `/api/v2/receipt-groups/${group.id}`);
    expect(convertedRes.status).toBe(200);
    const converted = (await convertedRes.json() as {
      group: {
        incomplete: boolean;
        missing_rates: string[];
        total_minor: number | null;
        total_currency: string | null;
        receipts: Array<{ receipt_key: string; posted_minor: number | null; base_minor: number | null }>;
      };
    }).group;
    expect(converted.incomplete).toBe(false);
    expect(converted.missing_rates).toEqual([]);
    expect(converted.total_currency).toBe('USD');
    expect(converted.total_minor).toBe(-30);
    expect(converted.receipts.map((r) => r.base_minor).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([-20, -10]);
    const full = await api('GET', '/api/v2/backup/export');
    const dump = await full.json() as { tables: Record<string, unknown[]> };
    expect(dump.tables.receipt_membership.length).toBe(2);
    expect(dump.tables.receipt_group_requests.length).toBe(1);
    expect(dump.tables.operations.some((row) => (row as { receipt_identity_token?: string | null }).receipt_identity_token)).toBe(false);
    const compat = await api('GET', '/api/v2/backup/export?compat=v2.35');
    const old = await compat.json() as { tables: Record<string, unknown>; omitted: { purchase_orders: number } };
    expect(old.tables.receipt_membership).toBeUndefined();
    expect(old.tables.receipt_group_requests).toBeUndefined();
    expect(old.tables.purchase_orders).toBeUndefined();
    expect(old.omitted.purchase_orders).toBeGreaterThan(0);
    const imported = await api('POST', '/api/v2/backup/import', { ...dump, confirm: true });
    expect(imported.status).toBe(200);
    const listed = await api('GET', '/api/v2/receipt-groups');
    expect((await listed.json() as { groups: unknown[] }).groups).toHaveLength(1);
    const reset = await api('POST', '/api/v2/data/reset', { confirm: true, phrase: 'RESET' });
    expect(reset.status).toBe(200);
    expect(await counts()).toEqual({ orders: 0, members: 0, requests: 0 });
  });

  it('deletes a group without deleting its operations', async () => {
    const acc = await account();
    const first = await operation(acc.id, { receipt_url: 'https://receipts.example/a', fiscal_receipt_id: null, item: 'Delete A', amount_minor: -1000 });
    const second = await operation(acc.id, { receipt_url: 'https://receipts.example/b', fiscal_receipt_id: null, item: 'Delete B', amount_minor: -250 });
    const receiptKeys = await keysFor([first.id, second.id]);
    const before = await ledger();
    const created = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: receiptKeys, idempotency_key: 'idem-group-delete',
    });
    const groupId = (await created.json() as { group: { id: number } }).group.id;
    const deleted = await api('DELETE', `/api/v2/receipt-groups/${groupId}?idempotency_key=idem-group-delete-key`);
    expect(deleted.status).toBe(200);
    expect((await deleted.json() as { deleted: boolean }).deleted).toBe(true);
    const replay = await api('DELETE', `/api/v2/receipt-groups/${groupId}?idempotency_key=idem-group-delete-key`);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ deleted: true });
    const missing = await api('DELETE', `/api/v2/receipt-groups/${groupId}?idempotency_key=idem-group-delete-new`);
    expect(missing.status).toBe(404);
    await expectErrorCode(missing, 'RECEIPT_GROUP_NOT_FOUND');
    expect(await counts()).toMatchObject({ orders: 0, members: 0 });
    expect(await ledger()).toEqual(before);
  });

  it('lets only one of two overlapping creates commit', async () => {
    const acc = await account();
    const first = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-RACE-1', receipt_url: null, item: 'Race A', amount_minor: -100 });
    const second = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-RACE-2', receipt_url: null, item: 'Race B', amount_minor: -200 });
    const third = await operation(acc.id, { fiscal_receipt_id: 'SYNTH-PFR-RACE-3', receipt_url: null, item: 'Race C', amount_minor: -300 });
    const [left, mid, right] = await keysFor([first.id, second.id, third.id]);
    const [one, two] = await Promise.all([
      api('POST', '/api/v2/receipt-groups', { receipt_keys: [left, mid], idempotency_key: 'idem-group-race-one' }),
      api('POST', '/api/v2/receipt-groups', { receipt_keys: [mid, right], idempotency_key: 'idem-group-race-two' }),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([201, 409]);
    const failed = one.status === 409 ? one : two;
    await expectErrorCode(failed, 'RECEIPT_ALREADY_GROUPED');
    expect((await counts()).orders).toBe(1);
    expect((await counts()).members).toBe(2);
  });

  it('resolves restaurant visits and pharmacy + Wolt delivery, refuses different dates or unknown places, and keeps older multi-date groups on the latest date', async () => {
    const acc = await account();
    const kitchen = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Restoran Synth Kitchen',
      item: 'Dinner',
      fiscal_receipt_id: 'SYNTH-REST-1',
      receipt_url: null,
      amount_minor: -2400,
    });
    const bar = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Restoran Synth Bar',
      item: 'Drinks',
      fiscal_receipt_id: 'SYNTH-REST-2',
      receipt_url: null,
      amount_minor: -800,
    });
    const pharmacy = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Apoteka Synth',
      item: 'Medicine',
      fiscal_receipt_id: 'SYNTH-PHARM-1',
      receipt_url: null,
      amount_minor: -1500,
    });
    const wolt = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Wolt d.o.o.',
      item: 'Delivery fee',
      fiscal_receipt_id: 'SYNTH-WOLT-1',
      receipt_url: null,
      amount_minor: -300,
    });
    const otherDay = await operation(acc.id, {
      date: '2026-11-08',
      store: 'Apoteka Synth',
      item: 'Bandages',
      fiscal_receipt_id: 'SYNTH-PHARM-NEXT',
      receipt_url: null,
      amount_minor: -400,
    });
    const [kKey, bKey, pKey, wKey, nextDayKey] = await keysFor([
      kitchen.id,
      bar.id,
      pharmacy.id,
      wolt.id,
      otherDay.id,
    ]);

    const diffDate = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [pKey, nextDayKey],
      idempotency_key: 'idem-diff-date',
    });
    expect(diffDate.status).toBe(400);
    await expectErrorCode(diffDate, 'RECEIPT_GROUP_DATE_MISMATCH');
    expect(await counts()).toEqual({ orders: 0, members: 0, requests: 0 });

    const restRes = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [kKey, bKey],
      idempotency_key: 'idem-rest-visit',
    });
    expect(restRes.status).toBe(201);
    const restGroup = (await restRes.json() as { group: { name: string; place: string; date: string; total_minor: number } }).group;
    expect(restGroup.name).toBe('Restoran Synth');
    expect(restGroup.place).toBe('Restoran Synth');
    expect(restGroup.date).toBe('2026-11-07');
    expect(restGroup.total_minor).toBe(-3200);

    const pharmRes = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [wKey, pKey],
      idempotency_key: 'idem-pharm-wolt',
    });
    expect(pharmRes.status).toBe(201);
    const pharmGroup = (await pharmRes.json() as { group: { name: string; place: string; date: string; total_minor: number } }).group;
    expect(pharmGroup.name).toBe('Apoteka Synth');
    expect(pharmGroup.place).toBe('Apoteka Synth');
    expect(pharmGroup.date).toBe('2026-11-07');
    expect(pharmGroup.total_minor).toBe(-1800);

    // Seed an older group whose receipts already span dates (2026-11-02 and 2026-11-05)
    const oldEarly = await operation(acc.id, {
      date: '2026-11-02',
      store: 'Legacy Synth Store',
      item: 'Part 1',
      fiscal_receipt_id: 'SYNTH-LEGACY-1',
      receipt_url: null,
      amount_minor: -500,
    });
    const oldLate = await operation(acc.id, {
      date: '2026-11-05',
      store: 'Legacy Synth Store',
      item: 'Part 2',
      fiscal_receipt_id: 'SYNTH-LEGACY-2',
      receipt_url: null,
      amount_minor: -700,
    });
    const [legacyKey1, legacyKey2] = await keysFor([oldEarly.id, oldLate.id]);
    const epochRow = await env.DB.prepare(
      `SELECT value FROM settings WHERE key = 'purchase_orders_epoch'`,
    ).first<{ value: string }>();
    await env.DB.prepare(
      `INSERT INTO purchase_orders (id, provider, provider_order_id, order_date, created_via, created_at, updated_at, kind, display_name)
       VALUES (99, 'manual', 'legacy-span-group', NULL, 'api', '2026-11-02T10:00:00Z', '2026-11-02T10:00:00Z', 'manual', NULL)`,
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO receipt_membership (order_id, receipt_key, ledger_epoch, created_at) VALUES (99, ?, ?, '2026-11-02T10:00:00Z')`,
      ).bind(legacyKey1, epochRow!.value),
      env.DB.prepare(
        `INSERT INTO receipt_membership (order_id, receipt_key, ledger_epoch, created_at) VALUES (99, ?, ?, '2026-11-05T10:00:00Z')`,
      ).bind(legacyKey2, epochRow!.value),
    ]);

    const legacyGet = await api('GET', '/api/v2/receipt-groups/99');
    expect(legacyGet.status).toBe(200);
    const legacyGroup = (await legacyGet.json() as { group: { id: number; date: string; place: string; total_minor: number } }).group;
    expect(legacyGroup.id).toBe(99);
    expect(legacyGroup.date).toBe('2026-11-05');
    expect(legacyGroup.place).toBe('Legacy Synth Store');
    expect(legacyGroup.total_minor).toBe(-1200);
  });

  it('renames only the title, replays, and refuses an empty name when the place cannot be resolved', async () => {
    const acc = await account();
    const pharmacy = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Apoteka Synth',
      item: 'Medicine',
      fiscal_receipt_id: 'SYNTH-RENAME-PHARM',
      receipt_url: null,
      amount_minor: -1500,
    });
    const wolt = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Wolt',
      item: 'Delivery',
      fiscal_receipt_id: 'SYNTH-RENAME-WOLT',
      receipt_url: null,
      amount_minor: -300,
    });
    const onlyDeliveryA = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Wolt',
      item: 'Fee A',
      fiscal_receipt_id: 'SYNTH-RENAME-WOLT-A',
      receipt_url: null,
      amount_minor: -100,
    });
    const onlyDeliveryB = await operation(acc.id, {
      date: '2026-11-07',
      store: 'Glovo',
      item: 'Fee B',
      fiscal_receipt_id: 'SYNTH-RENAME-GLOVO',
      receipt_url: null,
      amount_minor: -80,
    });
    const [pharmKey, woltKey, deliveryA, deliveryB] = await keysFor([
      pharmacy.id, wolt.id, onlyDeliveryA.id, onlyDeliveryB.id,
    ]);
    const before = await ledger();
    const created = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [pharmKey, woltKey],
      idempotency_key: 'idem-rename-create',
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { group: { id: number; place: string; date: string; total_minor: number; receipts: Array<{ receipt_key: string }> } };
    const groupId = createdBody.group.id;
    expect(createdBody.group.place).toBe('Apoteka Synth');
    expect(createdBody.group.date).toBe('2026-11-07');
    expect(createdBody.group.total_minor).toBe(-1800);
    const memberKeys = createdBody.group.receipts.map((item) => item.receipt_key).sort();

    const unknown = await api('PATCH', `/api/v2/receipt-groups/${groupId}`, {
      name: 'Weekend market',
      extra: true,
      idempotency_key: 'idem-rename-unknown',
    });
    expect(unknown.status).toBe(400);
    expect((await counts()).requests).toBe(1);

    const renamed = await api('PATCH', `/api/v2/receipt-groups/${groupId}`, {
      name: '  Weekend market  ',
      idempotency_key: 'idem-rename-typed',
    });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json() as { group: { place: string; date: string; total_minor: number; receipts: Array<{ receipt_key: string }> } };
    expect(renamedBody.group.place).toBe('Weekend market');
    expect(renamedBody.group.date).toBe('2026-11-07');
    expect(renamedBody.group.total_minor).toBe(-1800);
    expect(renamedBody.group.receipts.map((item) => item.receipt_key).sort()).toEqual(memberKeys);
    const stored = await env.DB.prepare(
      'SELECT display_name, order_date FROM purchase_orders WHERE id = ?',
    ).bind(groupId).first<{ display_name: string | null; order_date: string | null }>();
    expect(stored?.display_name).toBe('Weekend market');

    const replay = await api('PATCH', `/api/v2/receipt-groups/${groupId}`, {
      name: 'Weekend market',
      idempotency_key: 'idem-rename-typed',
    });
    expect(replay.status).toBe(200);
    const conflict = await api('PATCH', `/api/v2/receipt-groups/${groupId}`, {
      name: 'Other name',
      idempotency_key: 'idem-rename-typed',
    });
    expect(conflict.status).toBe(409);
    await expectErrorCode(conflict, 'IDEMPOTENCY_CONFLICT');
    expect((await counts()).requests).toBe(2);

    const cleared = await api('PATCH', `/api/v2/receipt-groups/${groupId}`, {
      name: '   ',
      idempotency_key: 'idem-rename-clear',
    });
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json() as { group: { place: string; total_minor: number; receipts: Array<{ receipt_key: string }> } };
    expect(clearedBody.group.place).toBe('Apoteka Synth');
    expect(clearedBody.group.total_minor).toBe(-1800);
    expect(clearedBody.group.receipts.map((item) => item.receipt_key).sort()).toEqual(memberKeys);
    const clearedRow = await env.DB.prepare(
      'SELECT display_name, order_date FROM purchase_orders WHERE id = ?',
    ).bind(groupId).first<{ display_name: string | null; order_date: string | null }>();
    expect(clearedRow?.display_name).toBeNull();
    expect(clearedRow?.order_date).toBe(stored?.order_date ?? null);

    const delivery = await api('POST', '/api/v2/receipt-groups', {
      receipt_keys: [deliveryA, deliveryB],
      name: 'Delivery only',
      idempotency_key: 'idem-rename-delivery',
    });
    expect(delivery.status).toBe(201);
    const deliveryId = (await delivery.json() as { group: { id: number } }).group.id;
    const requestsBeforeRefuse = (await counts()).requests;
    const refused = await api('PATCH', `/api/v2/receipt-groups/${deliveryId}`, {
      name: null,
      idempotency_key: 'idem-rename-refuse',
    });
    expect(refused.status).toBe(400);
    await expectErrorCode(refused, 'RECEIPT_GROUP_PLACE_REQUIRED');
    expect((await counts()).requests).toBe(requestsBeforeRefuse);
    const deliveryRow = await env.DB.prepare(
      'SELECT display_name FROM purchase_orders WHERE id = ?',
    ).bind(deliveryId).first<{ display_name: string | null }>();
    expect(deliveryRow?.display_name).toBe('Delivery only');
    expect(await ledger()).toEqual(before);
  });
});
