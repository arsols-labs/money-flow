import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import mcpApp from '../src/worker/mcp-server';
import type { Env } from '../src/worker/types';

const typedEnv = env as unknown as Env;
const clientId = 'client-mcp-no-auto-confirm';
let rpcId = 1;

const REFUSING_TOOLS = [
  'account_delete',
  'account_alias_delete',
  'transfer_delete',
  'backup_import',
  'operation_delete',
  'planned_item_delete',
  'recurring_item_delete',
  'fx_rate_delete',
  'data_reset',
  'template_delete',
  'statement_import_undo',
  'purchase_order_component_unlink',
  'purchase_order_delete',
  'receipt_group_receipt_unlink',
  'receipt_group_delete',
  'receipt_group_rename',
] as const;

const NEWLY_REFUSING = [
  'operation_delete',
  'planned_item_delete',
  'recurring_item_delete',
  'fx_rate_delete',
  'data_reset',
] as const;

const REFUSAL_CATALOG =
  'auto_confirm is not accepted for account_delete, account_alias_delete, transfer_delete, backup_import, operation_delete, planned_item_delete, recurring_item_delete, fx_rate_delete, data_reset, template_delete, statement_import_undo, purchase_order_component_unlink, purchase_order_delete, receipt_group_receipt_unlink, receipt_group_delete, receipt_group_rename, and for setting_set when the key is base_currency; a human confirmation is always required.';

function refusalError(name: string) {
  return `Error executing tool: auto_confirm is not accepted for ${name}; a destructive change always needs a human confirmation through requestState`;
}

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

async function confirm(name: string, args: Record<string, unknown>) {
  const first = await call(name, args);
  expect(first.result.isError).toBeFalsy();
  expect(first.result.structuredContent.resultType).toBe('input_required');
  expect(first.result.structuredContent.written).toBe(false);
  const second = await call(name, { ...args, requestState: first.result.structuredContent.requestState });
  expect(second.result.isError).toBeFalsy();
  expect(second.result.structuredContent.resultType).toBe('complete');
  expect(second.result.structuredContent.written).toBe(true);
  return second;
}

async function insertAccount(): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
     VALUES ('Main EUR', 'EUR', 99000, 1, 0, 'Alex', 'RS', '2026-10-01T00:00:00Z') RETURNING id`,
  ).first<{ id: number }>();
  return row!.id;
}

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM account_aliases'),
    env.DB.prepare('DELETE FROM pending_account_strings'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM oauth_tokens'),
    env.DB.prepare('DELETE FROM oauth_clients'),
  ]);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'No Auto Confirm', datetime('now'))`)
    .bind(clientId).run();
});

describe('MCP delete tools and data_reset refuse auto_confirm', () => {
  it('advertises the exact refusal catalog and hides auto_confirm on those tools', async () => {
    const listReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const list: any = await (await mcpApp.fetch(listReq, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any)).json();
    const byName = new Map(list.result.tools.map((tool: any) => [tool.name, tool]));

    for (const name of REFUSING_TOOLS) {
      const tool: any = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool.inputSchema.properties.auto_confirm, name).toBeUndefined();
      expect(tool.description, name).toContain(REFUSAL_CATALOG);
    }
    expect((byName.get('setting_set') as any).description).toContain(REFUSAL_CATALOG);
    expect((byName.get('setting_set') as any).inputSchema.properties.auto_confirm).toBeDefined();
    const fxSet: any = byName.get('fx_rate_set');
    expect(fxSet.inputSchema.properties.auto_confirm).toBeDefined();
    expect(fxSet.description).not.toContain('auto_confirm is not accepted');
  });

  it('operation_delete rejects auto_confirm and still deletes through MRTR', async () => {
    const accountId = await insertAccount();
    const operation = await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
       VALUES ('2026-10-01', ?, 'expense', 'Coffee', 'Food', -1000, 'manual') RETURNING id`,
    ).bind(accountId).first<{ id: number }>();
    for (const flag of [true, false]) {
      const refused = await call('operation_delete', {
        operation_id: operation!.id, auto_confirm: flag, idempotency_key: `op-del-auto-${flag}`,
      });
      expect(refused.result.isError).toBe(true);
      expect(refused.result.content[0].text).toBe(refusalError('operation_delete'));
      expect(refused.result.structuredContent.error).toBe(refusalError('operation_delete'));
    }
    expect(await count('SELECT COUNT(*) AS n FROM operations WHERE id = ?', operation!.id)).toBe(1);

    const done = await confirm('operation_delete', { operation_id: operation!.id, idempotency_key: 'op-del-mrtr' });
    expect(done.result.structuredContent.success).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM operations WHERE id = ?', operation!.id)).toBe(0);
  });

  it('planned_item_delete rejects auto_confirm and still deletes through MRTR', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
       VALUES ('2026-10-20', 'Rent', -5000, 'EUR', ?, 'Home', 0) RETURNING id`,
    ).bind(accountId).first<{ id: number }>();
    const refused = await call('planned_item_delete', {
      planned_item_id: planned!.id, auto_confirm: true, idempotency_key: 'plan-del-auto',
    });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error).toBe(refusalError('planned_item_delete'));
    expect(await count('SELECT COUNT(*) AS n FROM planned_items WHERE id = ?', planned!.id)).toBe(1);

    const done = await confirm('planned_item_delete', { planned_item_id: planned!.id, idempotency_key: 'plan-del-mrtr' });
    expect(done.result.structuredContent.success).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM planned_items WHERE id = ?', planned!.id)).toBe(0);
  });

  it('recurring_item_delete rejects auto_confirm and still deletes through MRTR', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
       VALUES ('Subscription', -2000, 'EUR', ?, 'Software', 'monthly', 1, 1, NULL, '2026-10-01', NULL, 1) RETURNING id`,
    ).bind(accountId).first<{ id: number }>();
    const refused = await call('recurring_item_delete', {
      recurring_item_id: recurring!.id, auto_confirm: true, idempotency_key: 'rec-del-auto',
    });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error).toBe(refusalError('recurring_item_delete'));
    expect(await count('SELECT COUNT(*) AS n FROM recurring_items WHERE id = ?', recurring!.id)).toBe(1);

    const done = await confirm('recurring_item_delete', { recurring_item_id: recurring!.id, idempotency_key: 'rec-del-mrtr' });
    expect(done.result.structuredContent.success).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM recurring_items WHERE id = ?', recurring!.id)).toBe(0);
  });

  it('fx_rate_delete rejects auto_confirm and still deletes through MRTR', async () => {
    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('USD', 1090000000, '2026-10-01T00:00:00Z')`,
    ).run();
    const refused = await call('fx_rate_delete', { code: 'USD', auto_confirm: true, idempotency_key: 'fx-del-auto' });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error).toBe(refusalError('fx_rate_delete'));
    expect(await count('SELECT COUNT(*) AS n FROM fx_rates WHERE code = ?', 'USD')).toBe(1);

    const done = await confirm('fx_rate_delete', { code: 'USD', idempotency_key: 'fx-del-mrtr' });
    expect(done.result.structuredContent.success).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM fx_rates WHERE code = ?', 'USD')).toBe(0);
  });

  it('data_reset rejects auto_confirm and still resets through MRTR', async () => {
    await insertAccount();
    const refused = await call('data_reset', { confirm_phrase: 'RESET', auto_confirm: true, idempotency_key: 'reset-auto' });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error).toBe(refusalError('data_reset'));
    expect(await count('SELECT COUNT(*) AS n FROM accounts')).toBe(1);

    const done = await confirm('data_reset', { confirm_phrase: 'RESET', idempotency_key: 'reset-mrtr' });
    expect(done.result.structuredContent.reset).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM accounts')).toBe(0);
    const oauth = await env.DB.prepare('SELECT id FROM oauth_clients WHERE id = ?').bind(clientId).first<{ id: string }>();
    expect(oauth?.id).toBe(clientId);
  });

  it('fx_rate_set still defaults auto_confirm to true and can opt into MRTR', async () => {
    const direct = await call('fx_rate_set', { code: 'RSD', rate: 0.009868, idempotency_key: 'fx-set-default' });
    expect(direct.result.isError, JSON.stringify(direct.result)).toBeFalsy();
    expect(direct.result.structuredContent.resultType).toBe('complete');
    expect(direct.result.structuredContent.written).toBe(true);
    expect(direct.result.structuredContent.rate.code).toBe('RSD');
    expect(await count('SELECT COUNT(*) AS n FROM fx_rates WHERE code = ?', 'RSD')).toBe(1);

    const explicit = await call('fx_rate_set', { code: 'GBP', rate: 1.25, auto_confirm: true, idempotency_key: 'fx-set-explicit' });
    expect(explicit.result.structuredContent.written).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM fx_rates WHERE code = ?', 'GBP')).toBe(1);

    const held = await call('fx_rate_set', { code: 'EUR', rate: 1.2, auto_confirm: false, idempotency_key: 'fx-set-held' });
    expect(held.result.isError).toBeFalsy();
    expect(held.result.structuredContent.resultType).toBe('input_required');
    expect(held.result.structuredContent.written).toBe(false);
    expect(await count('SELECT COUNT(*) AS n FROM fx_rates WHERE code = ?', 'EUR')).toBe(0);
  });
});

describe('newly refusing tool names stay in the catalog', () => {
  it('covers each newly refusing tool', () => {
    for (const name of NEWLY_REFUSING) {
      expect(REFUSING_TOOLS).toContain(name);
      expect(REFUSAL_CATALOG).toContain(name);
    }
  });
});
