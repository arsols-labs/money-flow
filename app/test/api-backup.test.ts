// Export/import user-state backup (issue #515).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  USER_TABLES,
  backupFilename,
  insertChunkSize,
  D1_MAX_BOUND_PARAMS,
  parseBackupDocument,
} from '../src/worker/backup';
import { expectErrorCode } from './api-error-helpers';

let cookie: string;

beforeAll(async () => {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM oauth_tokens'),
    env.DB.prepare('DELETE FROM oauth_consents'),
    env.DB.prepare('DELETE FROM oauth_clients'),
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
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES
         ('base_currency', 'USD'),
         ('low_balance_threshold_minor', '100000')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ]);
});

async function api(method: string, path: string, body?: unknown, withCookie = true): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(withCookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env as unknown as Env);
}

async function exportBackup() {
  const res = await api('GET', '/api/v2/backup/export');
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}

describe('backup filename', () => {
  it('uses the UTC date from exported_at', () => {
    expect(backupFilename('2026-09-11T17:03:00Z')).toBe('money-flow-backup-2026-09-11.json');
  });
});

describe('insertChunkSize', () => {
  it('keeps each INSERT under the D1 bound-parameter limit', () => {
    const accountColumns = 12;
    const rowsPerStatement = insertChunkSize(accountColumns);
    expect(rowsPerStatement).toBe(8);
    expect(rowsPerStatement * accountColumns).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    expect(9 * accountColumns).toBeGreaterThan(D1_MAX_BOUND_PARAMS);
  });
});

describe('GET /api/v2/backup/export', () => {
  it('rejects an unauthenticated session', async () => {
    const res = await api('GET', '/api/v2/backup/export', undefined, false);
    expect(res.status).toBe(401);
    await expectErrorCode(res, 'UNAUTHORIZED');
  });

  it('returns a versioned dump of user tables with a download filename', async () => {
    const res = await api('GET', '/api/v2/backup/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="money-flow-backup-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const body = await res.json() as {
      format: string;
      version: number;
      exported_at: string;
      tables: Record<string, unknown[]>;
    };
    expect(body.format).toBe(BACKUP_FORMAT);
    expect(body.version).toBe(BACKUP_VERSION);
    expect(body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Object.keys(body.tables).sort()).toEqual([...USER_TABLES].sort());
    expect(body.tables.settings).toEqual(expect.arrayContaining([
      { key: 'base_currency', value: 'USD' },
      { key: 'low_balance_threshold_minor', value: '100000' },
    ]));
    for (const name of USER_TABLES) {
      if (name === 'settings') continue;
      expect(body.tables[name]).toEqual([]);
    }
  });

  it('includes accounts, operations, and related user rows', async () => {
    const created = await api('POST', '/api/v2/accounts', {
      name: 'Cash',
      currency: 'USD',
      owner: 'Alex',
      country: 'USA',
      balance_minor: 2500,
    });
    expect(created.status).toBe(201);
    const account = (await created.json() as { account: { id: number } }).account;
    const op = await api('POST', '/api/v2/operations', {
      date: '2026-09-01',
      account_id: account.id,
      kind: 'expense',
      item: 'Coffee',
      amount_minor: -350,
    });
    expect(op.status).toBe(201);

    const dump = await exportBackup();
    const tables = dump.tables as Record<string, Array<Record<string, unknown>>>;
    expect(tables.accounts).toHaveLength(1);
    expect(tables.accounts[0]).toMatchObject({
      id: account.id,
      name: 'Cash',
      currency: 'USD',
      balance_minor: 2150,
    });
    expect(tables.operations).toHaveLength(1);
    expect(tables.operations[0]).toMatchObject({
      item: 'Coffee',
      amount_minor: -350,
      account_id: account.id,
    });
  });
});

describe('POST /api/v2/backup/import', () => {
  it('rejects an unauthenticated session', async () => {
    const res = await api('POST', '/api/v2/backup/import', { confirm: true }, false);
    expect(res.status).toBe(401);
    await expectErrorCode(res, 'UNAUTHORIZED');
  });

  it('requires confirm: true before replacing data', async () => {
    const dump = await exportBackup();
    const res = await api('POST', '/api/v2/backup/import', dump);
    expect(res.status).toBe(400);
    await expectErrorCode(res, 'BACKUP_CONFIRM_REQUIRED');
  });

  it('rejects a document that is not a backup', async () => {
    const res = await api('POST', '/api/v2/backup/import', { confirm: true, hello: true });
    expect(res.status).toBe(400);
    await expectErrorCode(res, 'BACKUP_FORMAT_INVALID');
  });

  it('rejects an unsupported version', async () => {
    const dump = await exportBackup();
    const res = await api('POST', '/api/v2/backup/import', { ...dump, confirm: true, version: 99 });
    expect(res.status).toBe(400);
    await expectErrorCode(res, 'BACKUP_VERSION_UNSUPPORTED');
  });

  it('rejects invalid row types before writing', async () => {
    const dump = await exportBackup() as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    dump.tables.accounts = [{
      id: 1,
      name: 'Cash',
      bank: null,
      type: null,
      owner: 'Alex',
      country: 'USA',
      currency: 'USD',
      balance_minor: 'not-a-number',
      balance_updated_at: '2026-09-01T00:00:00Z',
      sort: 0,
      archived: 0,
      account_number: null,
    }];
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    const res = await api('POST', '/api/v2/backup/import', { ...dump, confirm: true });
    expect(res.status).toBe(400);
    await expectErrorCode(res, 'BACKUP_ROW_INVALID');
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('rejects a broken foreign key', async () => {
    const dump = await exportBackup() as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    dump.tables.planned_items = [{
      id: 1,
      date: '2026-10-01',
      title: 'Rent',
      amount_minor: -1000,
      currency: 'USD',
      account_id: 999,
      category: null,
      done: 0,
      revision: 'abc',
    }];
    const res = await api('POST', '/api/v2/backup/import', { ...dump, confirm: true });
    expect(res.status).toBe(400);
    await expectErrorCode(res, 'BACKUP_REFERENCE_INVALID');
  });

  it('replaces user tables and leaves oauth clients untouched', async () => {
    await env.DB.prepare(
      `INSERT INTO oauth_clients (id, name, created_at) VALUES ('client-keep', 'Keep me', '2026-09-01T00:00:00Z')`,
    ).run();

    const sourceAcc = await api('POST', '/api/v2/accounts', {
      name: 'Source',
      currency: 'USD',
      owner: 'Alex',
      country: 'USA',
      balance_minor: 10_000,
    });
    const sourceId = (await sourceAcc.json() as { account: { id: number } }).account.id;
    await api('POST', '/api/v2/operations', {
      date: '2026-09-02',
      account_id: sourceId,
      kind: 'income',
      item: 'Salary',
      amount_minor: 5000,
    });
    await api('PUT', '/api/v2/settings/base_currency', { value: 'EUR' });
    const snapshot = await exportBackup();

    await api('POST', '/api/v2/accounts', {
      name: 'Live extra',
      currency: 'USD',
      owner: 'Alex',
      country: 'USA',
    });
    await api('PUT', '/api/v2/settings/base_currency', { value: 'USD' });

    const imported = await api('POST', '/api/v2/backup/import', { ...snapshot, confirm: true });
    expect(imported.status).toBe(200);
    const body = await imported.json() as { ok: boolean; imported: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.imported.accounts).toBe(1);
    expect(body.imported.operations).toBe(1);

    const accounts = await env.DB.prepare('SELECT name FROM accounts ORDER BY name').all<{ name: string }>();
    expect(accounts.results.map((r) => r.name)).toEqual(['Source']);
    const settings = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'base_currency'",
    ).first<{ value: string }>();
    expect(settings?.value).toBe('EUR');
    const ops = await env.DB.prepare('SELECT item FROM operations').all<{ item: string }>();
    expect(ops.results.map((r) => r.item)).toEqual(['Salary']);
    const oauth = await env.DB.prepare('SELECT id FROM oauth_clients').all<{ id: string }>();
    expect(oauth.results.map((r) => r.id)).toEqual(['client-keep']);
  });

  it('round-trips a transfer and a recurring rule', async () => {
    const from = await api('POST', '/api/v2/accounts', {
      name: 'From',
      currency: 'USD',
      owner: 'Alex',
      country: 'USA',
      balance_minor: 20_000,
    });
    const to = await api('POST', '/api/v2/accounts', {
      name: 'To',
      currency: 'USD',
      owner: 'Alex',
      country: 'USA',
      balance_minor: 1000,
    });
    const fromId = (await from.json() as { account: { id: number } }).account.id;
    const toId = (await to.json() as { account: { id: number } }).account.id;
    const transfer = await api('POST', '/api/v2/transfers', {
      date: '2026-09-03',
      from_account_id: fromId,
      to_account_id: toId,
      from_amount_minor: 4000,
      to_amount_minor: 4000,
      item: 'Move',
    });
    expect(transfer.status).toBe(201);
    const recurring = await api('POST', '/api/v2/recurring-items', {
      title: 'Rent',
      amount_minor: -120000,
      account_id: fromId,
      frequency: 'monthly',
      day_of_month: 1,
      next_due_date: '2026-10-01',
    });
    expect(recurring.status).toBe(201);

    const snapshot = await exportBackup();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM operations'),
      env.DB.prepare('DELETE FROM transfers'),
      env.DB.prepare('DELETE FROM recurring_items'),
      env.DB.prepare('DELETE FROM accounts'),
    ]);

    const imported = await api('POST', '/api/v2/backup/import', { ...snapshot, confirm: true });
    expect(imported.status).toBe(200);
    const names = await env.DB.prepare('SELECT name FROM accounts ORDER BY name').all<{ name: string }>();
    expect(names.results.map((r) => r.name)).toEqual(['From', 'To']);
    const rules = await env.DB.prepare('SELECT title, frequency FROM recurring_items').all<{ title: string; frequency: string }>();
    expect(rules.results).toEqual([{ title: 'Rent', frequency: 'monthly' }]);
    const transferOps = await env.DB.prepare(
      "SELECT kind FROM operations WHERE kind LIKE 'transfer%' ORDER BY kind",
    ).all<{ kind: string }>();
    expect(transferOps.results.map((r) => r.kind)).toEqual(['transfer_in', 'transfer_out']);
  });

  it('imports 9 full account rows — more binds than one D1 statement allows', async () => {
    const accountColumns = 12;
    expect(9 * accountColumns).toBeGreaterThan(D1_MAX_BOUND_PARAMS);
    const dump = await exportBackup() as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    dump.tables.accounts = Array.from({ length: 9 }, (_, i) => ({
      id: i + 1,
      name: `Account ${i + 1}`,
      bank: 'Bank',
      type: 'Checking',
      owner: 'Alex',
      country: 'USA',
      currency: 'USD',
      balance_minor: 1000 * (i + 1),
      balance_updated_at: '2026-09-01T00:00:00Z',
      sort: i,
      archived: 0,
      account_number: null,
    }));
    const res = await api('POST', '/api/v2/backup/import', { ...dump, confirm: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; imported: { accounts: number } };
    expect(body.ok).toBe(true);
    expect(body.imported.accounts).toBe(9);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    expect(count?.n).toBe(9);
  });
});

describe('parseBackupDocument', () => {
  it('accepts the exported envelope wrapped with confirm', async () => {
    const dump = await exportBackup();
    const parsed = parseBackupDocument({ ...dump, confirm: true });
    expect(parsed.format).toBe(BACKUP_FORMAT);
    expect(parsed.tables.settings.length).toBeGreaterThan(0);
  });

  it('accepts { confirm, backup } from the UI', async () => {
    const dump = await exportBackup();
    const parsed = parseBackupDocument({ confirm: true, backup: dump });
    expect(parsed.version).toBe(BACKUP_VERSION);
  });
});
