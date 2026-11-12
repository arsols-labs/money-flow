import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { PURCHASE_ORDERS_EPOCH_KEY } from '../src/shared/purchase-orders';

const typedEnv = env as unknown as Env;
const clientId = 'client-purchase-orders';

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
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM oauth_tokens'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(PURCHASE_ORDERS_EPOCH_KEY),
  ]);
  await env.DB.prepare(
    `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Purchase orders', datetime('now'))`,
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

function rpc(method: string, params: unknown, id: number, scopes: string[]) {
  return mcpApp.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }), typedEnv, { props: { scopes, clientId } } as any);
}

async function call(name: string, args: Record<string, unknown>, id: number, scopes = ['read', 'write']) {
  const response = await rpc('tools/call', { name, arguments: args }, id, scopes);
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

describe('MCP purchase-order lifecycle', () => {
  it('lists the lifecycle tools and keeps a read token from the write tools', async () => {
    const both = await (await rpc('tools/list', {}, 1, ['read', 'write'])).json() as any;
    const names = both.result.tools.map((tool: { name: string }) => tool.name);
    for (const name of [
      'purchase_orders_list',
      'purchase_order_get',
      'purchase_order_upsert',
      'purchase_order_update',
      'purchase_order_component_link',
      'purchase_order_component_update',
      'purchase_order_component_unlink',
      'purchase_order_delete',
    ]) {
      expect(names, name).toContain(name);
    }
    const listed = both.result.tools.find((tool: { name: string }) => tool.name === 'purchase_orders_list');
    expect(listed.description).toMatch(/shared date does not create a group/i);
    expect(listed.inputSchema.properties.limit).toBeDefined();
    expect(listed.inputSchema.properties.cursor).toBeDefined();
    const inspect = both.result.tools.find((tool: { name: string }) => tool.name === 'purchase_order_get');
    expect(inspect.inputSchema.required).toEqual(['order_id']);
    const readOnly = await (await rpc('tools/list', {}, 2, ['read'])).json() as any;
    const readNames = readOnly.result.tools.map((tool: { name: string }) => tool.name);
    expect(readNames).toContain('purchase_order_get');
    expect(readNames).not.toContain('purchase_order_update');
    expect(readNames).not.toContain('purchase_order_delete');
  });

  it('creates, inspects, edits, adds, removes, and deletes without changing the ledger', async () => {
    const account = await api('POST', '/api/v2/accounts', {
      name: 'Synth RSD', currency: 'RSD', owner: 'Synth', country: 'SRB', balance_minor: 500000,
    });
    const accountId = ((await account.json()) as { account: { id: number } }).account.id;
    const specs = [
      { item: 'Synth goods', store: 'Synth Market', amount_minor: -1250, fiscal_receipt_id: 'SYNTH-PFR-ORDER-0001' },
      { item: 'Synth delivery', store: 'Synth Market', amount_minor: -84, fiscal_receipt_id: 'SYNTH-PFR-ORDER-0002' },
      { item: 'Synth coffee', store: 'Synth Cafe', amount_minor: -300, fiscal_receipt_id: 'SYNTH-PFR-OTHER-0009' },
    ];
    for (const spec of specs) {
      const created = await api('POST', '/api/v2/operations', {
        date: '2026-11-07', account_id: accountId, kind: 'expense', ...spec,
      });
      expect(created.status).toBe(201);
    }
    const beforeOps = await env.DB.prepare('SELECT id, amount_minor, fiscal_receipt_id FROM operations ORDER BY id').all();
    const beforeBalance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();

    const created = await confirm('purchase_order_upsert', {
      provider: 'synth',
      provider_order_id: 'QA-398',
      order_date: '2026-11-07',
      order_total_minor: 1334,
      order_total_currency: 'RSD',
      order_total_source: 'provider_document',
    }, 'idem-po-create', 10);
    const orderId = created.result.structuredContent.order.id as number;
    expect(created.result.structuredContent.created).toBe(true);

    const repeat = await confirm('purchase_order_upsert', {
      provider: 'synth',
      provider_order_id: 'QA-398',
      note: 'must not overwrite',
    }, 'idem-po-repeat', 20);
    expect(repeat.result.structuredContent.created).toBe(false);
    expect(repeat.result.structuredContent.order.note).toBeNull();

    const linked = await confirm('purchase_order_component_link', {
      order_id: orderId,
      component_type: 'goods',
      fiscal_receipt_id: ' synth-pfr-order-0001 ',
    }, 'idem-po-link-1', 30);
    const goodsId = linked.result.structuredContent.component_id as number;
    expect(linked.result.structuredContent.order.posted[0].posted_total_minor).toBe(1250);

    const again = await confirm('purchase_order_component_link', {
      order_id: orderId,
      component_type: 'goods',
      fiscal_receipt_id: 'SYNTH-PFR-ORDER-0001',
    }, 'idem-po-link-1-repeat', 40);
    expect(again.result.structuredContent.created).toBe(false);

    const inspected = await call('purchase_order_get', { order_id: orderId }, 50);
    expect(inspected.result.structuredContent.order.receipts).toEqual([
      expect.objectContaining({
        pfr_canonical: 'SYNTH-PFR-ORDER-0001',
        item: 'Synth goods',
        amount_minor: -1250,
        counted: true,
      }),
    ]);
    expect(inspected.result.structuredContent.order.difference_minor).toBe(84);
    expect(inspected.result.structuredContent.order.receipts.map((row: { item: string }) => row.item)).not.toContain('Synth coffee');

    const edited = await confirm('purchase_order_update', {
      order_id: orderId,
      note: 'Checked against the provider slip',
    }, 'idem-po-edit', 60);
    expect(edited.result.structuredContent.order.note).toBe('Checked against the provider slip');
    expect(edited.result.structuredContent.order.provider_order_id).toBe('QA-398');

    const role = await confirm('purchase_order_component_update', {
      order_id: orderId,
      component_id: goodsId,
      component_type: 'other',
    }, 'idem-po-role', 70);
    expect(role.result.structuredContent.order.components.find((row: { id: number }) => row.id === goodsId).component_type).toBe('other');

    const delivery = await confirm('purchase_order_component_link', {
      order_id: orderId,
      component_type: 'delivery_fee',
      fiscal_receipt_id: 'SYNTH-PFR-ORDER-0002',
    }, 'idem-po-link-2', 80);
    const deliveryId = delivery.result.structuredContent.component_id as number;
    const complete = await call('purchase_order_get', { order_id: orderId }, 90);
    expect(complete.result.structuredContent.order.posted[0].posted_total_minor).toBe(1334);
    expect(complete.result.structuredContent.order.status).toBe('complete');
    expect(complete.result.structuredContent.order.receipts).toHaveLength(2);

    const other = await confirm('purchase_order_upsert', {
      provider: 'synth',
      provider_order_id: 'QA-399',
    }, 'idem-po-other', 96);
    const otherId = other.result.structuredContent.order.id as number;
    const pendingConflict = await call('purchase_order_component_link', {
      order_id: otherId,
      component_type: 'goods',
      fiscal_receipt_id: 'SYNTH-PFR-ORDER-0002',
      idempotency_key: 'idem-po-conflict',
    }, 100);
    const conflict = await call('purchase_order_component_link', {
      order_id: otherId,
      component_type: 'goods',
      fiscal_receipt_id: 'SYNTH-PFR-ORDER-0002',
      idempotency_key: 'idem-po-conflict',
      requestState: pendingConflict.result.structuredContent.requestState,
    }, 101);
    expect(conflict.result.isError, JSON.stringify(conflict.result)).toBe(true);
    expect(JSON.stringify(conflict.result)).toMatch(/DOCUMENT_ALREADY_IN_ORDER/);
    const untouched = await env.DB.prepare(
      'SELECT order_id FROM purchase_order_components WHERE pfr_canonical = ?',
    ).bind('SYNTH-PFR-ORDER-0002').all<{ order_id: number }>();
    expect(untouched.results.map((row) => row.order_id)).toEqual([orderId]);

    const removed = await confirm('purchase_order_component_unlink', {
      order_id: orderId,
      component_id: deliveryId,
    }, 'idem-po-unlink', 110);
    expect(removed.result.structuredContent.order.components.some((row: { id: number }) => row.id === deliveryId)).toBe(false);
    const stillThere = await env.DB.prepare(
      'SELECT id FROM operations WHERE fiscal_receipt_id = ?',
    ).bind('SYNTH-PFR-ORDER-0002').first<{ id: number }>();
    expect(stillThere?.id).toBeTruthy();

    await confirm('purchase_order_delete', { order_id: orderId }, 'idem-po-delete', 120);
    const gone = await call('purchase_order_get', { order_id: orderId }, 130);
    expect(gone.result.isError).toBe(true);
    expect(JSON.stringify(gone.result)).toMatch(/ORDER_NOT_FOUND/);

    const afterOps = await env.DB.prepare('SELECT id, amount_minor, fiscal_receipt_id FROM operations ORDER BY id').all();
    const afterBalance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
    expect(afterOps.results).toEqual(beforeOps.results);
    expect(afterBalance?.balance_minor).toBe(beforeBalance?.balance_minor);
  });

  it('pages search results and does not treat a shared date as one group', async () => {
    for (const providerOrderId of ['A', 'B', 'C']) {
      await confirm('purchase_order_upsert', {
        provider: 'synth',
        provider_order_id: providerOrderId,
        order_date: '2026-11-07',
      }, `idem-po-page-${providerOrderId}`, providerOrderId.charCodeAt(0));
    }
    const page = await call('purchase_orders_list', { q: '2026-11-07', limit: 1 }, 200);
    expect(page.result.structuredContent.orders).toHaveLength(1);
    expect(page.result.structuredContent.next_cursor).toBeTypeOf('number');
    const rest = await call('purchase_orders_list', {
      q: '2026-11-07',
      limit: 10,
      cursor: page.result.structuredContent.next_cursor,
    }, 201);
    const ids = [
      page.result.structuredContent.orders[0].id,
      ...rest.result.structuredContent.orders.map((order: { id: number }) => order.id),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(rest.result.structuredContent.next_cursor).toBeNull();
    const bad = await call('purchase_orders_list', { limit: 0 }, 202);
    expect(bad.result.isError).toBe(true);
  });

  it('rejects a missing order, a read-only write, and an operation-id link', async () => {
    const missing = await call('purchase_order_get', { order_id: 999999 }, 300);
    expect(missing.result.isError).toBe(true);
    expect(JSON.stringify(missing.result)).toMatch(/ORDER_NOT_FOUND/);
    const denied = await call('purchase_order_update', {
      order_id: 1,
      note: 'no',
      idempotency_key: 'idem-po-denied',
    }, 301, ['read']);
    expect(denied.error.code).toBe(-32001);
    const unsupported = await call('purchase_order_component_link', {
      order_id: 1,
      component_type: 'goods',
      operation_id: 1,
      idempotency_key: 'idem-po-opid',
    }, 302);
    expect(unsupported.result.structuredContent.resultType).not.toBe('input_required');
    expect(JSON.stringify(unsupported.result)).toMatch(/OPERATION_LINK_UNSUPPORTED/);
  });
});
