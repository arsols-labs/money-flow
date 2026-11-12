import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';

const typedEnv = env as unknown as Env;
const clientId = 'client-receipt-groups';
let cookie = '';

beforeAll(async () => {
  cookie = (await createSessionCookie(typedEnv, false)).split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM receipt_group_requests'),
    env.DB.prepare('DELETE FROM receipt_membership'),
    env.DB.prepare('DELETE FROM purchase_order_components'),
    env.DB.prepare('DELETE FROM purchase_orders'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM oauth_tokens'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare(`DELETE FROM settings WHERE key = 'purchase_orders_epoch'`),
  ]);
  await env.DB.prepare(
    `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Receipt groups', datetime('now'))`,
  ).bind(clientId).run();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      Cookie: cookie,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, typedEnv);
}

function rpc(method: string, params: unknown, id: number) {
  return mcpApp.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }), typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
}

async function call(name: string, args: Record<string, unknown>, id: number) {
  const response = await rpc('tools/call', { name, arguments: args }, id);
  return response.json() as Promise<any>;
}

async function confirm(name: string, args: Record<string, unknown>, key: string, id: number) {
  const pending = await call(name, { ...args, idempotency_key: key }, id);
  expect(pending.result?.structuredContent?.resultType, JSON.stringify(pending)).toBe('input_required');
  expect(pending.result.structuredContent.written).toBe(false);
  const complete = await call(name, {
    ...args,
    idempotency_key: key,
    requestState: pending.result.structuredContent.requestState,
  }, id + 1);
  expect(complete.result?.isError, JSON.stringify(complete.result)).toBeUndefined();
  expect(complete.result.structuredContent.written).toBe(true);
  expect(complete.result.structuredContent.operation_count_unchanged).toBe(true);
  expect(complete.result.structuredContent.balance_unchanged).toBe(true);
  return complete;
}

describe('MCP receipt groups', () => {
  it('creates with confirmation, refuses auto_confirm on unlink and delete, and reads the group back', async () => {
    const account = await api('POST', '/api/v2/accounts', {
      name: 'Synth RSD', currency: 'RSD', owner: 'Synth', country: 'SRB', balance_minor: 500000,
    });
    const accountId = ((await account.json()) as { account: { id: number } }).account.id;
    for (const spec of [
      { item: 'Synth goods', fiscal_receipt_id: 'SYNTH-PFR-GROUP-1', amount_minor: -1000 },
      { item: 'Synth fee', fiscal_receipt_id: 'SYNTH-PFR-GROUP-2', amount_minor: -80 },
    ]) {
      const created = await api('POST', '/api/v2/operations', {
        date: '2026-11-07', account_id: accountId, kind: 'expense', store: 'Synth', ...spec,
      });
      expect(created.status).toBe(201);
    }
    const created = await confirm('receipt_group_create', {
      receipt_keys: ['pfr:SYNTH-PFR-GROUP-1', 'pfr:SYNTH-PFR-GROUP-2'],
      name: 'Synth group',
    }, 'idem-receipt-group-create', 10);
    const groupId = created.result.structuredContent.group.id as number;
    expect(created.result.structuredContent.group.date).toBe('2026-11-07');
    expect(created.result.structuredContent.group.place).toBe('Synth group');
    const listed = await call('receipt_groups_list', {}, 30);
    expect(listed.result.structuredContent.groups).toHaveLength(1);
    expect(listed.result.structuredContent.groups[0].date).toBe('2026-11-07');
    const refused = await call('receipt_group_receipt_unlink', {
      group_id: groupId,
      receipt_key: 'pfr:SYNTH-PFR-GROUP-1',
      idempotency_key: 'idem-receipt-group-unlink',
      auto_confirm: true,
    }, 40);
    expect(refused.result.isError).toBe(true);
    expect(String(refused.result.structuredContent.error)).toMatch(/auto_confirm is not accepted/);
    const deleteRefused = await call('receipt_group_delete', {
      group_id: groupId,
      idempotency_key: 'idem-receipt-group-delete',
      auto_confirm: true,
    }, 50);
    expect(deleteRefused.result.isError).toBe(true);
    await confirm('receipt_group_receipt_unlink', {
      group_id: groupId,
      receipt_key: 'pfr:SYNTH-PFR-GROUP-1',
    }, 'idem-receipt-group-unlink-ok', 60);
    const still = await call('receipt_group_get', { group_id: groupId }, 80);
    expect(still.result.structuredContent.group.receipts).toHaveLength(1);
    await confirm('receipt_group_delete', { group_id: groupId }, 'idem-receipt-group-delete-ok', 90);
    const gone = await call('receipt_groups_list', {}, 110);
    expect(gone.result.structuredContent.groups).toEqual([]);
    const opCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(opCount?.n).toBe(2);
  });

  it('refuses MCP receipt_group_create when receipts have different calendar dates or an unknown place without a name', async () => {
    const account = await api('POST', '/api/v2/accounts', {
      name: 'Synth RSD', currency: 'RSD', owner: 'Synth', country: 'SRB', balance_minor: 500000,
    });
    const accountId = ((await account.json()) as { account: { id: number } }).account.id;
    await api('POST', '/api/v2/operations', {
      date: '2026-11-08', account_id: accountId, kind: 'expense', store: 'Synth A', item: 'Item 1', fiscal_receipt_id: 'SYNTH-MCP-DATE-1', amount_minor: -1000,
    });
    await api('POST', '/api/v2/operations', {
      date: '2026-11-09', account_id: accountId, kind: 'expense', store: 'Synth A', item: 'Item 2', fiscal_receipt_id: 'SYNTH-MCP-DATE-2', amount_minor: -1000,
    });
    const dateMismatch = await confirmToResult('receipt_group_create', {
      receipt_keys: ['pfr:SYNTH-MCP-DATE-1', 'pfr:SYNTH-MCP-DATE-2'],
    }, 'idem-mcp-date-mismatch', 200);
    expect(dateMismatch.result.isError).toBe(true);
    expect(String(dateMismatch.result.structuredContent.error)).toMatch(/RECEIPT_GROUP_DATE_MISMATCH/);

    await api('POST', '/api/v2/operations', {
      date: '2026-11-08', account_id: accountId, kind: 'expense', store: 'Wolt', item: 'Fee 1', fiscal_receipt_id: 'SYNTH-MCP-WOLT-1', amount_minor: -200,
    });
    await api('POST', '/api/v2/operations', {
      date: '2026-11-08', account_id: accountId, kind: 'expense', store: 'Wolt', item: 'Fee 2', fiscal_receipt_id: 'SYNTH-MCP-WOLT-2', amount_minor: -100,
    });
    const placeRequired = await confirmToResult('receipt_group_create', {
      receipt_keys: ['pfr:SYNTH-MCP-WOLT-1', 'pfr:SYNTH-MCP-WOLT-2'],
    }, 'idem-mcp-place-required', 210);
    expect(placeRequired.result.isError).toBe(true);
    expect(String(placeRequired.result.structuredContent.error)).toMatch(/RECEIPT_GROUP_PLACE_REQUIRED/);
  });

  it('asks before a rename, refuses auto_confirm, and leaves membership and analytics unchanged', async () => {
    const account = await api('POST', '/api/v2/accounts', {
      name: 'Synth RSD', currency: 'RSD', owner: 'Synth', country: 'SRB', balance_minor: 500000,
    });
    const accountId = ((await account.json()) as { account: { id: number; balance_minor: number } }).account;
    for (const spec of [
      { item: 'Synth goods', fiscal_receipt_id: 'SYNTH-PFR-RENAME-1', amount_minor: -1000 },
      { item: 'Synth fee', fiscal_receipt_id: 'SYNTH-PFR-RENAME-2', amount_minor: -80 },
    ]) {
      const created = await api('POST', '/api/v2/operations', {
        date: '2026-11-07', account_id: accountId.id, kind: 'expense', store: 'Synth', ...spec,
      });
      expect(created.status).toBe(201);
    }
    const created = await confirm('receipt_group_create', {
      receipt_keys: ['pfr:SYNTH-PFR-RENAME-1', 'pfr:SYNTH-PFR-RENAME-2'],
      name: 'Synth group',
    }, 'idem-receipt-group-rename-create', 300);
    const groupId = created.result.structuredContent.group.id as number;
    const beforeAnalytics = await api('POST', '/api/v2/analytics', {});
    expect(beforeAnalytics.status).toBe(200);
    const beforeStats = (await beforeAnalytics.json() as { stats: unknown }).stats;
    const balanceBefore = await env.DB.prepare(
      'SELECT balance_minor FROM accounts WHERE id = ?',
    ).bind(accountId.id).first<{ balance_minor: number }>();
    const refused = await call('receipt_group_rename', {
      group_id: groupId,
      name: 'Should not save',
      idempotency_key: 'idem-receipt-group-rename-auto',
      auto_confirm: true,
    }, 320);
    expect(refused.result.isError).toBe(true);
    expect(String(refused.result.structuredContent.error)).toMatch(/auto_confirm is not accepted/);
    const unchanged = await env.DB.prepare(
      'SELECT display_name FROM purchase_orders WHERE id = ?',
    ).bind(groupId).first<{ display_name: string | null }>();
    expect(unchanged?.display_name).toBe('Synth group');

    const renamed = await confirm('receipt_group_rename', {
      group_id: groupId,
      name: 'Renamed synth',
    }, 'idem-receipt-group-rename-ok', 340);
    expect(renamed.result.structuredContent.group.place).toBe('Renamed synth');
    expect(renamed.result.structuredContent.group.receipts).toHaveLength(2);
    expect(renamed.result.structuredContent.group.date).toBe('2026-11-07');
    expect(renamed.result.structuredContent.group.total_minor).toBe(created.result.structuredContent.group.total_minor);

    const cleared = await confirm('receipt_group_rename', {
      group_id: groupId,
      name: null,
    }, 'idem-receipt-group-rename-clear', 360);
    expect(cleared.result.structuredContent.group.place).toBe('Synth');
    expect(cleared.result.structuredContent.group.receipts).toHaveLength(2);
    const clearedRow = await env.DB.prepare(
      'SELECT display_name FROM purchase_orders WHERE id = ?',
    ).bind(groupId).first<{ display_name: string | null }>();
    expect(clearedRow?.display_name).toBeNull();

    const afterAnalytics = await api('POST', '/api/v2/analytics', {});
    expect((await afterAnalytics.json() as { stats: unknown }).stats).toEqual(beforeStats);
    const balance = await env.DB.prepare(
      'SELECT balance_minor FROM accounts WHERE id = ?',
    ).bind(accountId.id).first<{ balance_minor: number }>();
    expect(balance?.balance_minor).toBe(balanceBefore?.balance_minor);
    const opCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(opCount?.n).toBe(2);
  });
});

async function confirmToResult(name: string, args: Record<string, unknown>, key: string, id: number) {
  const pending = await call(name, { ...args, idempotency_key: key }, id);
  expect(pending.result?.structuredContent?.resultType, JSON.stringify(pending)).toBe('input_required');
  return call(name, {
    ...args,
    idempotency_key: key,
    requestState: pending.result.structuredContent.requestState,
  }, id + 1);
}
