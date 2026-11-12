import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import mcpApp, { BACKUP_EXPORT_MAX_BYTES } from '../src/worker/mcp-server';
import type { Env } from '../src/worker/types';

const typedEnv = env as unknown as Env;
const clientId = 'client-mcp-settings-test';
let rpcId = 1;
const ASCII_ONLY = /^[\x20-\x7E\u2014]*$/;

async function call(name: string, args: Record<string, unknown>, scopes: string[] = ['read', 'write']) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApp.fetch(req, typedEnv, { props: { scopes, clientId } } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const setting = async (key: string) =>
  (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value;
const accountCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>())!.n;

async function insertAccount(name: string) {
  await env.DB.prepare(
    `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
     VALUES (?, 'EUR', 1000, 1, 0, 'Alex', 'RS', '2026-10-01T00:00:00Z')`,
  ).bind(name).run();
}

async function exportDoc() {
  const res = await call('backup_export', {});
  expect(res.result.structuredContent.truncated).toBe(false);
  return res.result.structuredContent.backup;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM purchase_order_components'),
    env.DB.prepare('DELETE FROM purchase_orders'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare(`DELETE FROM settings WHERE key = 'purchase_orders_epoch'`),
    env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('base_currency', 'USD') ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('low_balance_threshold_minor', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  ]);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Settings Test Client', datetime('now'))`)
    .bind(clientId).run();
});

describe('settings_get and backup_export', () => {
  it('reads settings and requires read scope', async () => {
    const res = await call('settings_get', {});
    expect(res.result.structuredContent.settings.base_currency).toBe('USD');
    const denied = await call('settings_get', {}, ['write']);
    expect(denied.error.message).toBe('Insufficient permissions. "read" scope required.');
  });

  it('returns the full backup inline under the cap', async () => {
    await insertAccount('Inline');
    const res = await call('backup_export', {});
    const s = res.result.structuredContent;
    expect(s.truncated).toBe(false);
    expect(s.backup.format).toBe('money-flow-v2-backup');
    expect(s.backup.tables.accounts).toHaveLength(1);
    expect(s.size_bytes).toBeLessThanOrEqual(BACKUP_EXPORT_MAX_BYTES);
  });

  it('returns a counts summary above the 512 KiB cap', async () => {
    expect(BACKUP_EXPORT_MAX_BYTES).toBe(524288);
    await insertAccount('Big');
    const pad = 'x'.repeat(400);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1600)
       INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source, comment)
       SELECT '2026-10-01', (SELECT id FROM accounts LIMIT 1), 'expense', 'Row ' || i, 'Food', -1, 'manual', ? FROM n`,
    ).bind(pad).run();
    const res = await call('backup_export', {});
    const s = res.result.structuredContent;
    expect(s.truncated).toBe(true);
    expect(s.backup).toBeUndefined();
    expect(s.cap_bytes).toBe(524288);
    expect(s.size_bytes).toBeGreaterThan(524288);
    expect(s.counts.operations).toBe(1600);
    expect(s.counts.accounts).toBe(1);
    expect(s.message).toMatch(/Export backup in the Money Flow app settings/);
  });
});

describe('setting_set', () => {
  it('requires the write scope', async () => {
    const res = await call('setting_set', { key: 'low_balance_threshold_minor', value: 500, idempotency_key: 'scope' }, ['read']);
    expect(res.error.message).toBe('Insufficient permissions. "write" scope required.');
    expect(await setting('low_balance_threshold_minor')).toBe('0');
  });

  it('writes nothing first, writes on confirm, replays, rejects a conflict and audits the client id', async () => {
    const args = { key: 'low_balance_threshold_minor', value: 500, idempotency_key: 'ok' };
    const first = await call('setting_set', args);
    expect(first.result.structuredContent.resultType).toBe('input_required');
    expect(first.result.structuredContent.description).toContain('Confirm changing low_balance_threshold_minor from 0 to 500');
    expect(await setting('low_balance_threshold_minor')).toBe('0');

    const second = await call('setting_set', { ...args, requestState: first.result.structuredContent.requestState });
    expect(second.result.structuredContent.error).toBeUndefined();
    expect(second.result.structuredContent.settings.low_balance_threshold_minor).toBe('500');
    expect(await setting('low_balance_threshold_minor')).toBe('500');

    const audit = await env.DB.prepare('SELECT client_id FROM mcp_audit_log WHERE idempotency_key = ? AND status = ?').bind('ok', 'success').first<any>();
    expect(audit.client_id).toBe(clientId);

    const replay = await call('setting_set', args);
    expect(replay.result.isError).toBeFalsy();
    expect(replay.result.structuredContent.resultType).not.toBe('input_required');

    const conflict = await call('setting_set', { ...args, value: 900 });
    expect(conflict.result.structuredContent.error).toMatch(/idempotency_key was already used with different arguments/);
    expect(await setting('low_balance_threshold_minor')).toBe('500');
  });

  it('base_currency: preview shows old and new value with the recalculation warning, and auto_confirm is refused', async () => {
    const first = await call('setting_set', { key: 'base_currency', value: 'eur', idempotency_key: 'base' });
    const d = first.result.structuredContent.description;
    expect(d).toContain('Confirm changing the base currency from USD to EUR');
    expect(d).toContain('WARNING: all conversions and reports');
    expect(d).toMatch(ASCII_ONLY);
    expect(await setting('base_currency')).toBe('USD');

    for (const flag of [true, false]) {
      const auto = await call('setting_set', { key: 'base_currency', value: 'EUR', auto_confirm: flag, idempotency_key: `auto-${flag}` });
      expect(auto.result.structuredContent.error).toMatch(/auto_confirm is not accepted for setting_set with key base_currency/);
    }
    expect(await setting('base_currency')).toBe('USD');

    const second = await call('setting_set', { key: 'base_currency', value: 'eur', idempotency_key: 'base', requestState: first.result.structuredContent.requestState });
    expect(second.result.structuredContent.error).toBeUndefined();
    expect(await setting('base_currency')).toBe('EUR');
  });

  it('auto_confirm still works for low_balance_threshold_minor', async () => {
    const res = await call('setting_set', { key: 'low_balance_threshold_minor', value: 7, auto_confirm: true, idempotency_key: 'auto-thr' });
    expect(res.result.structuredContent.error).toBeUndefined();
    expect(await setting('low_balance_threshold_minor')).toBe('7');
  });

  it('returns English errors for unknown keys, extra fields and invalid values', async () => {
    const unknown = await call('setting_set', { key: 'auth_epoch', value: '1', idempotency_key: 'e1' });
    expect(unknown.result.structuredContent.error).toBe('Error executing tool: key must be one of: base_currency, low_balance_threshold_minor');
    const reserved = await call('setting_set', { key: 'purchase_orders_epoch', value: '11111111-1111-4111-8111-111111111111', idempotency_key: 'epoch' });
    expect(reserved.result.structuredContent.error).toBe('Error executing tool: purchase_orders_epoch is reserved and cannot be changed through setting_set');
    const extra = await call('setting_set', { key: 'base_currency', value: 'EUR', force: true, idempotency_key: 'e2' });
    expect(extra.result.structuredContent.error).toMatch(/^Error executing tool: Fields not allowed for setting_set: force/);
    const first = await call('setting_set', { key: 'base_currency', value: 'EURO', idempotency_key: 'e3' });
    const bad = await call('setting_set', { key: 'base_currency', value: 'EURO', idempotency_key: 'e3', requestState: first.result.structuredContent.requestState });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.structuredContent.error).toMatch(ASCII_ONLY);
    expect(await setting('base_currency')).toBe('USD');
  });

  it('omits purchase_orders_epoch from settings_get, setting_set, and error payloads', async () => {
    const epoch = '33333333-3333-4333-8333-333333333333';
    await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).bind('purchase_orders_epoch', epoch).run();
    const read = await call('settings_get', {});
    expect(read.result.structuredContent.settings.purchase_orders_epoch).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain(epoch);
    const written = await call('setting_set', {
      key: 'low_balance_threshold_minor', value: 42, auto_confirm: true, idempotency_key: 'hide-epoch',
    });
    expect(written.result.structuredContent.settings.purchase_orders_epoch).toBeUndefined();
    expect(JSON.stringify(written)).not.toContain(epoch);
    const first = await call('setting_set', { key: 'base_currency', value: 'EUR', idempotency_key: 'hide-base' });
    expect(JSON.stringify(first)).not.toContain(epoch);
    const confirmed = await call('setting_set', {
      key: 'base_currency', value: 'EUR', idempotency_key: 'hide-base',
      requestState: first.result.structuredContent.requestState,
    });
    expect(confirmed.result.structuredContent.settings.purchase_orders_epoch).toBeUndefined();
    expect(JSON.stringify(confirmed)).not.toContain(epoch);
    const reserved = await call('setting_set', {
      key: 'purchase_orders_epoch', value: epoch, idempotency_key: 'hide-reserved',
    });
    expect(JSON.stringify(reserved)).not.toContain(epoch);
    expect(reserved.result.structuredContent.settings).toBeUndefined();
    await env.DB.prepare(
      `INSERT INTO purchase_orders (provider, provider_order_id, created_via, created_at, updated_at)
       VALUES ('wolt', 'synthorder0001', 'api', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z')`,
    ).run();
    const order = await env.DB.prepare('SELECT id FROM purchase_orders').first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO purchase_order_components (
         order_id, component_type, target_kind, pfr_canonical, ledger_epoch, created_at
       ) VALUES (?, 'goods', 'pfr', 'AAAAAAAA-BBBBBBBB-1', ?, '2026-11-07T00:00:00Z')`,
    ).bind(order!.id, epoch).run();
    const backup = await call('backup_export', {});
    expect(backup.result.structuredContent.backup.tables.settings).toContainEqual({
      key: 'purchase_orders_epoch', value: epoch,
    });
  });
});

describe('backup_import', () => {
  it('requires the write scope', async () => {
    await insertAccount('Keep');
    const doc = await exportDoc();
    const res = await call('backup_import', { backup: doc, dry_run: true, idempotency_key: 'scope' }, ['read']);
    expect(res.error.message).toBe('Insufficient permissions. "write" scope required.');
  });

  it('dry run validates, returns counts and writes nothing', async () => {
    await insertAccount('A');
    const doc = await exportDoc();
    await insertAccount('B');
    const res = await call('backup_import', { backup: doc, dry_run: true, idempotency_key: 'dry' });
    const s = res.result.structuredContent;
    expect(s.dry_run).toBe(true);
    expect(s.written).toBe(false);
    expect(s.requestState).toBeUndefined();
    expect(s.counts.accounts).toBe(1);
    expect(s.current_counts.accounts).toBe(2);
    expect(await accountCount()).toBe(2);
    const executions = await env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_audit_log WHERE idempotency_key = ?').bind('dry').first<{ n: number }>();
    expect(executions!.n).toBe(0);

    const invalid = await call('backup_import', { backup: { format: 'nope' }, dry_run: true, idempotency_key: 'dry-bad' });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.structuredContent.error).toMatch(/^Error executing tool: The backup document is invalid: BACKUP_FORMAT_INVALID/);
  });

  it('rejects a missing or wrong phrase', async () => {
    const doc = await exportDoc();
    for (const phrase of [undefined, 'import', 'RESET']) {
      const res = await call('backup_import', { backup: doc, ...(phrase ? { confirm_phrase: phrase } : {}), idempotency_key: `p-${phrase}` });
      expect(res.result.structuredContent.error).toMatch(/confirm_phrase must be exactly IMPORT/);
    }
  });

  it('refuses auto_confirm and is not advertised with it', async () => {
    const doc = await exportDoc();
    const res = await call('backup_import', { backup: doc, confirm_phrase: 'IMPORT', auto_confirm: true, idempotency_key: 'auto' });
    expect(res.result.structuredContent.error).toMatch(/auto_confirm is not accepted for backup_import/);
    const dryAuto = await call('backup_import', { backup: doc, dry_run: true, auto_confirm: true, idempotency_key: 'auto-dry' });
    expect(dryAuto.result.structuredContent.error).toMatch(/auto_confirm is not accepted for backup_import/);
    const list: any = await (await mcpApp.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any)).json();
    const tool = list.result.tools.find((t: any) => t.name === 'backup_import');
    expect(tool.inputSchema.properties.auto_confirm).toBeUndefined();
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('writes nothing first, imports on confirm, replays, rejects a conflict and audits the client id', async () => {
    await insertAccount('From backup');
    const doc = await exportDoc();
    await insertAccount('Added later');
    const args = { backup: doc, confirm_phrase: 'IMPORT', idempotency_key: 'imp' };
    const first = await call('backup_import', args);
    expect(first.result.structuredContent.resultType).toBe('input_required');
    expect(first.result.structuredContent.description).toContain('Confirm replacing ALL ledger data');
    expect(first.result.structuredContent.description).toContain('accounts: 1');
    expect(await accountCount()).toBe(2);

    const second = await call('backup_import', { ...args, requestState: first.result.structuredContent.requestState });
    expect(second.result.structuredContent.error).toBeUndefined();
    expect(second.result.structuredContent.imported.accounts).toBe(1);
    expect(await accountCount()).toBe(1);

    const audit = await env.DB.prepare('SELECT client_id FROM mcp_audit_log WHERE idempotency_key = ? AND status = ?').bind('imp', 'success').first<any>();
    expect(audit.client_id).toBe(clientId);

    await insertAccount('After import');
    const replay = await call('backup_import', args);
    expect(replay.result.isError).toBeFalsy();
    expect(await accountCount()).toBe(2);

    const conflict = await call('backup_import', { ...args, backup: { ...doc, exported_at: '2026-01-01T00:00:00Z' } });
    expect(conflict.result.structuredContent.error).toMatch(/idempotency_key was already used with different arguments/);
  });

  it('returns English errors for fields outside the allow-list', async () => {
    const res = await call('backup_import', { backup: {}, confirm_phrase: 'IMPORT', wipe: true, idempotency_key: 'x' });
    expect(res.result.structuredContent.error).toMatch(/^Error executing tool: Fields not allowed for backup_import: wipe/);
  });
});
