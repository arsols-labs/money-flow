import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import mcpApp from '../src/worker/mcp-server';
import type { Env } from '../src/worker/types';

const typedEnv = env as unknown as Env;
const clientId = 'client-mcp-transfer-test';
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

async function confirmed(name: string, args: Record<string, unknown>) {
  const first = await call(name, args);
  expect(first.result.structuredContent.resultType).toBe('input_required');
  return call(name, { ...args, requestState: first.result.structuredContent.requestState });
}

async function insertAccount(name: string, currency: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
     VALUES (?, ?, 100000, 1, 0, 'Alex', 'RS', '2026-10-01T00:00:00Z') RETURNING id`,
  ).bind(name, currency).first<{ id: number }>();
  return row!.id;
}

const balance = async (id: number) =>
  (await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(id).first<{ balance_minor: number }>())!.balance_minor;
const transferCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM transfers').first<{ n: number }>())!.n;

async function makeTransfer() {
  const from = await insertAccount('EUR main', 'EUR');
  const to = await insertAccount('RSD cash', 'RSD');
  const res = await confirmed('transfer_add', {
    date: '2026-10-20', from_account_id: from, to_account_id: to,
    from_amount_minor: 1000, to_amount_minor: 117000, item: 'Exchange',
    idempotency_key: `seed-${rpcId}`,
  });
  expect(res.result.isError).toBeFalsy();
  const row = await env.DB.prepare('SELECT id FROM transfers ORDER BY id DESC LIMIT 1').first<{ id: number }>();
  const legs = await env.DB.prepare('SELECT id, kind FROM operations WHERE transfer_id = ? ORDER BY kind').bind(row!.id).all<any>();
  return { from, to, transferId: row!.id, outLegId: legs.results.find((l: any) => l.kind === 'transfer_out').id };
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
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM oauth_clients'),
  ]);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Transfer Test Client', datetime('now'))`)
    .bind(clientId).run();
});

type Case = {
  tool: string;
  args: (t: Awaited<ReturnType<typeof makeTransfer>>) => Record<string, unknown>;
  alt: (a: Record<string, unknown>) => Record<string, unknown>;
  unchanged: (t: Awaited<ReturnType<typeof makeTransfer>>) => Promise<void>;
  check: (t: Awaited<ReturnType<typeof makeTransfer>>, r: any) => Promise<void>;
};

const cases: Case[] = [
  {
    tool: 'transfer_update',
    args: (t) => ({ transfer_id: t.transferId, from_amount_minor: 2000, to_amount_minor: 234000 }),
    alt: (a) => ({ ...a, from_amount_minor: 3000 }),
    unchanged: async (t) => {
      expect(await balance(t.from)).toBe(99000);
      expect(await balance(t.to)).toBe(217000);
    },
    check: async (t, r) => {
      expect(r.transfer.id).toBe(t.transferId);
      expect(r.transfer.from_operation.date).toBe('2026-10-20');
      expect(r.transfer.to_operation.date).toBe('2026-10-20');
      expect(r.arguments?.date).toBeUndefined();
      expect(await balance(t.from)).toBe(98000);
      expect(await balance(t.to)).toBe(334000);
    },
  },
  {
    tool: 'transfer_delete',
    args: (t) => ({ transfer_id: t.transferId }),
    alt: () => ({ transfer_id: 999999 }),
    unchanged: async (t) => {
      expect(await transferCount()).toBe(1);
      expect(await balance(t.from)).toBe(99000);
    },
    check: async (t, r) => {
      expect(r.success).toBe(true);
      expect(r.deleted_legs).toHaveLength(2);
      expect(await transferCount()).toBe(0);
      expect(await balance(t.from)).toBe(100000);
      expect(await balance(t.to)).toBe(100000);
    },
  },
];

describe.each(cases)('MCP write tool $tool', ({ tool, args, alt, unchanged, check }) => {
  it('requires the write scope', async () => {
    const t = await makeTransfer();
    const res = await call(tool, { ...args(t), idempotency_key: `scope-${tool}` }, ['read']);
    expect(res.error.message).toBe('Insufficient permissions. "write" scope required.');
    await unchanged(t);
  });

  it('writes nothing first, writes once on confirm, replays, rejects a key conflict and audits the client id', async () => {
    const t = await makeTransfer();
    const a = { ...args(t), idempotency_key: `ok-${tool}` };
    const first = await call(tool, a);
    expect(first.result.structuredContent.resultType).toBe('input_required');
    expect(first.result.structuredContent.description).toMatch(ASCII_ONLY);
    await unchanged(t);

    const second = await call(tool, { ...a, requestState: first.result.structuredContent.requestState });
    expect(second.result.structuredContent.error).toBeUndefined();
    expect(second.result.structuredContent.resultType).toBe('complete');
    await check(t, second.result.structuredContent);

    const audit = await env.DB.prepare('SELECT client_id, tool_name FROM mcp_audit_log WHERE idempotency_key = ? AND status = ?')
      .bind(a.idempotency_key, 'success').first<any>();
    expect(audit).toMatchObject({ client_id: clientId, tool_name: tool });

    const replay = await call(tool, a);
    expect(replay.result.isError).toBeFalsy();
    expect(replay.result.structuredContent.resultType).not.toBe('input_required');
    await check(t, second.result.structuredContent);

    const conflict = await call(tool, { ...alt(a), idempotency_key: a.idempotency_key });
    expect(conflict.result.isError).toBe(true);
    expect(conflict.result.structuredContent.error).toMatch(/idempotency_key was already used with different arguments/);
  });

  it('returns English errors for fields outside the allow-list and unknown transfers', async () => {
    const bad = await call(tool, { transfer_id: 1, kind: 'x', idempotency_key: `bad-${tool}` });
    expect(bad.result.structuredContent.error).toMatch(/^Error executing tool: Fields not allowed for /);
    const missing = await call(tool, { ...(tool === 'transfer_update' ? { date: '2026-10-21' } : {}), transfer_id: 424242, idempotency_key: `missing-${tool}` });
    expect(missing.result.structuredContent.error).toBe('Error executing tool: Transfer not found');
  });
});

describe('transfer_delete and operation_delete on a leg', () => {
  it('transfer_delete preview lists both legs and refuses auto_confirm', async () => {
    const t = await makeTransfer();
    const first = await call('transfer_delete', { transfer_id: t.transferId, idempotency_key: 'preview' });
    const d = first.result.structuredContent.description;
    expect(d).toContain(`transfer ID ${t.transferId} with both legs`);
    expect(d).toContain(`out leg operation ID ${t.outLegId}: -1000 EUR on account ID ${t.from} "EUR main", date 2026-10-20`);
    expect(d).toContain(`117000 RSD on account ID ${t.to} "RSD cash", date 2026-10-20`);

    const auto = await call('transfer_delete', { transfer_id: t.transferId, auto_confirm: true, idempotency_key: 'auto' });
    expect(auto.result.structuredContent.error).toMatch(/auto_confirm is not accepted for transfer_delete/);
    expect(await transferCount()).toBe(1);

    const list: any = await (await mcpApp.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any)).json();
    const tool = list.result.tools.find((x: any) => x.name === 'transfer_delete');
    expect(tool.inputSchema.properties.auto_confirm).toBeUndefined();
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('operation_delete on a transfer leg warns that the whole transfer goes and points to transfer_delete', async () => {
    const t = await makeTransfer();
    const first = await call('operation_delete', { operation_id: t.outLegId, idempotency_key: 'leg' });
    const d = first.result.structuredContent.description;
    expect(d).toContain(`WARNING: this operation is a leg of transfer_id=${t.transferId}, so the WHOLE transfer (both legs) will be deleted`);
    expect(d).toContain(`Prefer transfer_delete with transfer_id=${t.transferId}`);
    expect(d).toContain('RSD cash');
    const second = await call('operation_delete', { operation_id: t.outLegId, idempotency_key: 'leg', requestState: first.result.structuredContent.requestState });
    expect(second.result.isError).toBeFalsy();
    expect(await transferCount()).toBe(0);
  });
});
