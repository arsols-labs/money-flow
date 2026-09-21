import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mcpApp from '../src/worker/mcp-server';
import type { Env } from '../src/worker/types';

describe('MCP Server (S2-3 & S2-4)', () => {
  const typedEnv = env as unknown as Env;
  const clientId = 'client-mcp-test';

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mcp_audit_log'),
      env.DB.prepare('DELETE FROM operation_fulfillment_links'),
      env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
      env.DB.prepare('DELETE FROM operations'),
      env.DB.prepare('DELETE FROM planned_items'),
      env.DB.prepare('DELETE FROM recurring_items'),
      env.DB.prepare('DELETE FROM accounts'),
      env.DB.prepare('DELETE FROM oauth_tokens'),
      env.DB.prepare('DELETE FROM oauth_clients'),
      env.DB.prepare('DELETE FROM fx_rates'),
    ]);

    await env.DB.prepare(
      `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Test Client', datetime('now'))`
    ).bind(clientId).run();
  });

  describe('HTTP Endpoints', () => {
    it('returns 404 for GET /', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await mcpApp.fetch(req, typedEnv, {} as any);
      expect(res.status).toBe(404);
    });

    it('returns ok for GET /mcp', async () => {
      const req = new Request('http://localhost/mcp', { method: 'GET' });
      const res = await mcpApp.fetch(req, typedEnv, {} as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.status).toBe('ok');
    });
  });

  describe('Handshake (#321, #457)', () => {
    it('отвечает на initialize с 2026-07-28 согласованным protocolVersion и capabilities', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2026-07-28',
            capabilities: {},
            clientInfo: { name: 'antigravity', version: '1.0.0' },
          },
        }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.protocolVersion).toBe('2026-07-28');
      expect(body.result.serverInfo.name).toBe('money-flow');
      expect(body.result.capabilities.tools).toBeTruthy();
      expect(body.result.capabilities.resources).toBeTruthy();
    });

    it('отвечает на initialize с легаси 2025-11-25 согласованным protocolVersion', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'hermes', version: '0.20.1' },
          },
        }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.protocolVersion).toBe('2025-11-25');
    });

    it('на неизвестный protocolVersion отдаёт дефолтный 2026-07-28, не 32601', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: { protocolVersion: '1999-01-01', capabilities: {} },
        }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any);
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.protocolVersion).toBe('2026-07-28');
    });

    it('принимает notifications/initialized без JSON-RPC ошибки', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      const text = await res.text();
      if (text) {
        const body = JSON.parse(text);
        expect(body.error).toBeUndefined();
      }
    });

    it('отвечает на ping', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any);
      const body: any = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body.result).toEqual({});
    });
  });

  describe('tools/list & Scopes', () => {
    it('возвращает 8 read-инструментов, если есть только scope "read"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.tools.length).toBe(8);
      expect(body.result.tools.map((t: any) => t.name)).toEqual([
        'accounts_list',
        'fx_rates_list',
        'planned_items_list',
        'recurring_items_list',
        'recurring_fulfillments_list',
        'operations_list',
        'forecast_get',
        'analytics_get'
      ]);
    });

    it('публикует полный write-контур recurring/planned только для scope "write"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.tools.length).toBe(19);
      expect(body.result.tools.map((t: any) => t.name)).toEqual([
        'operation_add',
        'operation_update',
        'operation_delete',
        'transfer_add',
        'balance_correct',
        'planned_item_add',
        'planned_item_update',
        'planned_item_fulfill_existing',
        'planned_item_delete',
        'recurring_item_add',
        'recurring_item_update',
        'recurring_item_delete',
        'recurring_item_close_period',
        'recurring_item_fulfill_existing',
        'recurring_item_skip_period',
        'recurring_item_cancel_period_fulfillment',
        'fx_rate_set',
        'fx_rate_delete',
        'data_reset'
      ]);
      const operationUpdate = body.result.tools.find((t: any) => t.name === 'operation_update');
      const operationDelete = body.result.tools.find((t: any) => t.name === 'operation_delete');
      const recurringSkip = body.result.tools.find((t: any) => t.name === 'recurring_item_skip_period');
      const recurringCancel = body.result.tools.find((t: any) => t.name === 'recurring_item_cancel_period_fulfillment');
      expect(operationUpdate.annotations.destructiveHint).toBe(false);
      expect(operationDelete.annotations.destructiveHint).toBe(true);
      expect(recurringCancel.annotations.destructiveHint).toBe(true);
      expect(recurringCancel.outputSchema.properties.operation_count_unchanged).toBeDefined();
      expect(recurringCancel.outputSchema.properties.balance_unchanged).toBeDefined();
      const operationAdd = body.result.tools.find((t: any) => t.name === 'operation_add');
      const transferAdd = body.result.tools.find((t: any) => t.name === 'transfer_add');
      expect(operationAdd.inputSchema.properties.fiscal_receipt_id).toBeDefined();
      expect(operationUpdate.inputSchema.properties.fiscal_receipt_id).toBeDefined();
      expect(transferAdd.inputSchema.properties.fiscal_receipt_id).toBeDefined();
      expect(recurringSkip.outputSchema.properties.operation_count_unchanged).toBeDefined();
      expect(recurringSkip.outputSchema.properties.balance_unchanged).toBeDefined();
    });

    it('возвращает все 27 инструментов, если есть оба scope ["read", "write"]', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
      });

      const ctx = { props: { scopes: ['read', 'write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.tools.length).toBe(27);
    });

    it('возвращает пустой список инструментов, если scopes пустые', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
      });

      const ctx = { props: { scopes: [], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.tools.length).toBe(0);
    });
  });

  it('MF-21 read tool returns durable recurring fulfillment history', async () => {
    const account = await env.DB.prepare(
      `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
       VALUES ('RSD history', 'RSD', 100000, 1, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z') RETURNING id`,
    ).first<{ id: number }>();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
       VALUES ('Analytics', -1000, 'RSD', ?, 'Food', 'daily', 1, NULL, NULL, '2026-09-02', NULL, 1) RETURNING id`,
    ).bind(account!.id).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-09-01', 'skipped', '2026-09-01T12:00:00Z')`,
    ).bind(recurring!.id).run();

    const response = await mcpApp.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 31, method: 'tools/call',
        params: { name: 'recurring_fulfillments_list', arguments: { recurring_item_id: recurring!.id } },
      }),
    }), typedEnv, { props: { scopes: ['read'], clientId } } as any);
    const body: any = await response.json();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.recurring_fulfillments).toEqual([{
      recurring_item_id: recurring!.id,
      period_due_date: '2026-09-01',
      outcome: 'skipped',
      evidence_quantity: 1,
      operation_ids: [],
      fulfilled_at: '2026-09-01T12:00:00Z',
    }]);
  });

  describe('Разграничение доступа к tools/call', () => {
    it('запрещает вызов read-инструмента без scope "read"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'accounts_list', arguments: {} }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain('"read" scope required');
    });

    it('запрещает вызов write-инструмента без scope "write"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              date: '2026-08-15',
              account_id: 1,
              kind: 'expense',
              item: 'Кофе',
              amount_minor: -300,
              idempotency_key: 'key-1'
            }
          }
        })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain('"write" scope required');
    });
  });

  describe('Write Tools: MRTR, Валидация и Идемпотентность', () => {
    let accountId: number;

    beforeEach(async () => {
      const acc = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('Основной', 'EUR', 100000, 100, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z')
         RETURNING id`
      ).first<{ id: number }>();
      accountId = acc!.id;
    });

    it('требует наличие idempotency_key для write-инструментов', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              date: '2026-08-15',
              account_id: accountId,
              kind: 'expense',
              item: 'Обед',
              amount_minor: -1500
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('idempotency_key');
    });

    it('отклоняет некорректные параметры на этапе пре-валидации (до запроса подтверждения)', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              date: '2026-08-15',
              account_id: accountId,
              kind: 'expense',
              item: 'Обед',
              amount_minor: 1500, // Положительная сумма для расхода!
              idempotency_key: 'key-invalid-sign'
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('Сумма расхода (expense) должна быть отрицательной');
      expect(body.result.resultType).toBeUndefined();
    });

    it('operation_add: шаг 1 возвращает input_required и не пишет в БД; шаг 2 выполняет запись с source = "agent"', async () => {
      const idempotencyKey = 'key-op-1';

      // Шаг 1: Первичный вызов без подтверждения (MRTR)
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 30,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              date: '2026-08-15',
              account_id: accountId,
              kind: 'expense',
              item: 'Супермаркет',
              category: 'Продукты',
              amount_minor: -2500,
              idempotency_key: idempotencyKey
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res1 = await mcpApp.fetch(req1, typedEnv, ctx as any);
      const body1: any = await res1.json();

      expect(body1.result.structuredContent.resultType).toBe('input_required');
      expect(body1.result.requestState).toBeUndefined();
      expect(body1.result.structuredContent.requestState).toBeDefined();
      expect(body1.result.content[0].text).toContain('Подтвердите добавление операции');

      // Проверяем, что в БД ничего не записалось
      const countBefore = await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>();
      expect(countBefore?.count).toBe(0);

      // Шаг 2: Повторный вызов с requestState
      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 31,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              idempotency_key: idempotencyKey,
              requestState: body1.result.structuredContent.requestState
            }
          }
        })
      });

      const res2 = await mcpApp.fetch(req2, typedEnv, ctx as any);
      const body2: any = await res2.json();

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent).toBeDefined();
      expect(body2.result.structuredContent.operation).toBeDefined();
      expect(body2.result.structuredContent.operation.item).toBe('Супермаркет');
      expect(body2.result.structuredContent.operation.source).toBe('agent');
      expect(body2.result.structuredContent.operation.amount_minor).toBe(-2500);

      // Проверяем изменение баланса счёта и факт записи в БД
      const opInDb = await env.DB.prepare('SELECT * FROM operations').first<any>();
      expect(opInDb).toBeDefined();
      expect(opInDb.source).toBe('agent');
      expect(opInDb.amount_minor).toBe(-2500);

      const accInDb = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
      expect(accInDb?.balance_minor).toBe(97500); // 100000 - 2500

      // Проверяем запись в журнале аудита
      const auditLog = await env.DB.prepare('SELECT * FROM mcp_audit_log WHERE idempotency_key = ?').bind(idempotencyKey).first<any>();
      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('success');
      expect(auditLog.tool_name).toBe('operation_add');

      // Шаг 3: Повторный вызов с тем же idempotency_key возвращает закэшированный результат и НЕ дублирует запись
      const req3 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 32,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              date: '2026-08-15',
              account_id: accountId,
              kind: 'expense',
              item: 'Супермаркет',
              category: 'Продукты',
              amount_minor: -2500,
              idempotency_key: idempotencyKey
            }
          }
        })
      });

      const res3 = await mcpApp.fetch(req3, typedEnv, ctx as any);
      const body3: any = await res3.json();

      expect(body3.result.structuredContent.operation.id).toBe(body2.result.structuredContent.operation.id);
      expect(body3.result.structuredContent.resultType).toBe('complete');
      expect(body3.result.structuredContent.written).toBe(true);
      expect(body3.result.structuredContent.resultType).toBe('complete');

      const countAfter = await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>();
      expect(countAfter?.count).toBe(1); // Не задвоилось!

      // Тот же ключ нельзя переиспользовать для другого финансового факта.
      const driftedReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 33,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              date: '2026-08-15',
              account_id: accountId,
              kind: 'expense',
              item: 'Супермаркет',
              category: 'Продукты',
              amount_minor: -2600,
              idempotency_key: idempotencyKey
            }
          }
        })
      });
      const drifted: any = await (await mcpApp.fetch(driftedReq, typedEnv, ctx as any)).json();
      expect(drifted.result.isError).toBe(true);
      expect(drifted.result.content[0].text).toMatch(/другими аргументами/i);
      expect((await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>())?.count).toBe(1);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(97500);
    });

    it('balance_correct: корректирует баланс счета после подтверждения MRTR', async () => {
      const idempotencyKey = 'key-balance-1';

      // Шаг 1: MRTR input_required
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 40,
          method: 'tools/call',
          params: {
            name: 'balance_correct',
            arguments: {
              account_id: accountId,
              balance_minor: 125000,
              idempotency_key: idempotencyKey
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res1 = await mcpApp.fetch(req1, typedEnv, ctx as any);
      const body1: any = await res1.json();

      expect(body1.result.structuredContent.resultType).toBe('input_required');
      expect(body1.result.content[0].text).toContain('125000');
      expect(body1.result.content[0].text).not.toContain('текущий:');

      // Шаг 2: Выполнение с requestState
      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 41,
          method: 'tools/call',
          params: {
            name: 'balance_correct',
            arguments: {
              idempotency_key: idempotencyKey,
              requestState: body1.result.structuredContent.requestState
            }
          }
        })
      });

      const res2 = await mcpApp.fetch(req2, typedEnv, ctx as any);
      const body2: any = await res2.json();

      expect(body2.result.structuredContent.account_id).toBe(accountId);
      expect(body2.result.structuredContent.account).toBeUndefined();

      const accInDb = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
      expect(accInDb?.balance_minor).toBe(125000);
    });

    it('planned_item_add: создает плановую операцию после подтверждения MRTR', async () => {
      const idempotencyKey = 'key-planned-1';

      // Шаг 1: MRTR input_required
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 50,
          method: 'tools/call',
          params: {
            name: 'planned_item_add',
            arguments: {
              date: '2026-09-01',
              title: 'Аренда квартиры',
              amount_minor: -60000,
              account_id: accountId,
              category: 'Жилье',
              idempotency_key: idempotencyKey
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res1 = await mcpApp.fetch(req1, typedEnv, ctx as any);
      const body1: any = await res1.json();

      expect(body1.result.structuredContent.resultType).toBe('input_required');
      expect(body1.result.content[0].text).toContain('Аренда квартиры');

      // Шаг 2: Выполнение с requestState
      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 51,
          method: 'tools/call',
          params: {
            name: 'planned_item_add',
            arguments: {
              idempotency_key: idempotencyKey,
              requestState: body1.result.structuredContent.requestState
            }
          }
        })
      });

      const res2 = await mcpApp.fetch(req2, typedEnv, ctx as any);
      const body2: any = await res2.json();

      expect(body2.result.structuredContent.planned_item.title).toBe('Аренда квартиры');
      expect(body2.result.structuredContent.planned_item.amount_minor).toBe(-60000);

      const plannedInDb = await env.DB.prepare('SELECT * FROM planned_items').first<any>();
      expect(plannedInDb).toBeDefined();
      expect(plannedInDb.title).toBe('Аренда квартиры');
      expect(plannedInDb.amount_minor).toBe(-60000);
    });

    it('ALE-7 P0: recurring_item_add создаёт rule Nous -2000 только после MRTR и повтор не дублирует', async () => {
      const idempotencyKey = 'idem-ale-7-nous-recurring';
      const args = {
        title: 'Nous Research Inc. Plus',
        amount_minor: -2000,
        account_id: accountId,
        frequency: 'monthly',
        next_due_date: '2026-09-01',
        active: false,
        idempotency_key: idempotencyKey,
      };
      const ctx = { props: { scopes: ['write'], clientId } };
      const call = async (arguments_: Record<string, unknown>, id: number) => {
        const response = await mcpApp.fetch(new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'recurring_item_add', arguments: arguments_ } }),
        }), typedEnv, ctx as any);
        return response.json() as Promise<any>;
      };

      const first = await call(args, 701);
      expect(first.result.structuredContent.resultType).toBe('input_required');
      expect(first.result.structuredContent.written).toBe(false);
      expect(first.result._meta.ui.resourceUri).toBe('ui://write-confirm');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM planned_items').first<{ count: number }>())?.count).toBe(0);

      const confirmed = await call({ ...args, requestState: first.result.structuredContent.requestState }, 702);
      expect(confirmed.result.isError).toBeUndefined();
      expect(confirmed.result.structuredContent.written).toBe(true);
      expect(confirmed.result.structuredContent.recurring_item.amount_minor).toBe(-2000);
      expect(confirmed.result.structuredContent.recurring_item.frequency).toBe('monthly');
      expect(confirmed.result.structuredContent.recurring_item.active).toBe(false);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items').first<{ count: number }>())?.count).toBe(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM planned_items').first<{ count: number }>())?.count).toBe(0);

      const replay = await call(args, 703);
      expect(replay.result.structuredContent.written).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items').first<{ count: number }>())?.count).toBe(1);
      const audit = await env.DB.prepare('SELECT status, tool_name FROM mcp_audit_log WHERE idempotency_key = ?')
        .bind(idempotencyKey).first<{ status: string; tool_name: string }>();
      expect(audit).toEqual({ status: 'success', tool_name: 'recurring_item_add' });
    });
  });

  describe('ALE-7: P1 recurring/planned write tools через provider API', () => {
    let accountId: number;

    beforeEach(async () => {
      const account = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('EUR для ALE-7', 'EUR', 100000, 200, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z')
         RETURNING id`,
      ).first<{ id: number }>();
      accountId = account!.id;
    });

    async function callWrite(name: string, args: Record<string, unknown>, id: number) {
      const response = await mcpApp.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      }), typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
      return response.json() as Promise<any>;
    }

    async function confirm(name: string, args: Record<string, unknown>, key: string, id: number) {
      const pending = await callWrite(name, { ...args, idempotency_key: key }, id);
      expect(pending.result.structuredContent.resultType).toBe('input_required');
      expect(pending.result.structuredContent.written).toBe(false);
      const complete = await callWrite(name, {
        ...args,
        idempotency_key: key,
        requestState: pending.result.structuredContent.requestState,
      }, id + 1);
      expect(complete.result.isError, JSON.stringify(complete.result)).toBeUndefined();
      expect(complete.result.structuredContent.written).toBe(true);
      return complete;
    }

    it('rejects tampered and expired signed requestState before any write', async () => {
      const args = {
        title: 'Signed state', amount_minor: -2000, account_id: accountId,
        frequency: 'monthly', next_due_date: '2026-09-01',
      };
      const pending = await callWrite('recurring_item_add', {
        ...args, idempotency_key: 'idem-ale-7-tamper',
      }, 704);
      const token = pending.result.structuredContent.requestState as string;
      const [payload, signature] = token.split('.');
      const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
      const tampered = await callWrite('recurring_item_add', {
        ...args,
        idempotency_key: 'idem-ale-7-tamper',
        requestState: `${tamperedPayload}.${signature}`,
      }, 705);
      expect(tampered.result.isError).toBe(true);
      expect(tampered.result.content[0].text).toMatch(/requestState/i);

      const now = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const expiring = await callWrite('recurring_item_add', {
          ...args, idempotency_key: 'idem-ale-7-expired',
        }, 706);
        nowSpy.mockReturnValue(now + 16 * 60 * 1000);
        const expired = await callWrite('recurring_item_add', {
          ...args,
          idempotency_key: 'idem-ale-7-expired',
          requestState: expiring.result.structuredContent.requestState,
        }, 707);
        expect(expired.result.isError).toBe(true);
        expect(expired.result.content[0].text).toMatch(/requestState/i);
      } finally {
        nowSpy.mockRestore();
      }
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items').first<{ count: number }>())?.count).toBe(0);
    });

    it('recurring update, skip, close and delete keep domain effects and idempotency', async () => {
      const seeded = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Подписка', -2000, 'EUR', ?, 'Software', 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const recurringItemId = seeded!.id;

      const updated = await confirm('recurring_item_update', {
        recurring_item_id: recurringItemId, title: 'Nous Research Inc. Plus', amount_minor: -2000,
      }, 'idem-ale-7-recurring-update', 710);
      expect(updated.result.structuredContent.recurring_item.title).toBe('Nous Research Inc. Plus');

      const skipped = await confirm('recurring_item_skip_period', { recurring_item_id: recurringItemId }, 'idem-ale-7-recurring-skip', 720);
      expect(skipped.result.structuredContent.recurring_item.next_due_date).toBe('2026-10-01');
      expect(skipped.result.structuredContent.fulfillment).toMatchObject({
        recurring_item_id: recurringItemId,
        period_due_date: '2026-09-01',
        outcome: 'skipped',
        operation_ids: [],
      });
      expect(skipped.result.structuredContent.operation_count_unchanged).toBe(true);
      expect(skipped.result.structuredContent.balance_unchanged).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(100000);

      const closeArgs = {
        recurring_item_id: recurringItemId,
        date: '2026-10-01',
        amount_minor: -2000,
        account_id: accountId,
        item: 'Nous Research Inc. Plus',
        category: 'Software',
      };
      const closed = await confirm('recurring_item_close_period', closeArgs, 'idem-ale-7-recurring-close', 730);
      expect(closed.result.structuredContent.recurring_item.id).toBe(recurringItemId);
      expect(closed.result.structuredContent.operation.id).toBeTruthy();
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(recurringItemId).first<{ next_due_date: string }>())?.next_due_date).toBe('2026-11-01');
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(98000);

      const replay = await callWrite('recurring_item_close_period', { ...closeArgs, idempotency_key: 'idem-ale-7-recurring-close' }, 732);
      expect(replay.result.structuredContent.written).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(1);

      const deleted = await confirm('recurring_item_delete', { recurring_item_id: recurringItemId }, 'idem-ale-7-recurring-delete', 740);
      expect(deleted.result.structuredContent.success).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items WHERE id = ?').bind(recurringItemId).first<{ count: number }>())?.count).toBe(0);
    });

    it('#565: cancel period fulfillment unlinks evidence and lets operation_delete succeed', async () => {
      const seeded = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Ежедневные', -1000, 'EUR', ?, 'Food', 'daily', 1, NULL, NULL, '2026-09-20', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const recurringItemId = seeded!.id;
      const closeArgs = {
        recurring_item_id: recurringItemId,
        date: '2026-09-20',
        amount_minor: -1000,
        account_id: accountId,
        item: 'Ежедневные',
        category: 'Food',
      };
      const closed = await confirm('recurring_item_close_period', closeArgs, 'idem-565-close-then-cancel', 750);
      const operationId = closed.result.structuredContent.operation.id as number;
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(recurringItemId).first<{ next_due_date: string }>())?.next_due_date).toBe('2026-09-21');

      const blockedPending = await callWrite('operation_delete', {
        operation_id: operationId, idempotency_key: 'idem-565-delete-still-linked',
      }, 762);
      expect(blockedPending.result.structuredContent.resultType).toBe('input_required');
      const blockedComplete = await callWrite('operation_delete', {
        operation_id: operationId,
        idempotency_key: 'idem-565-delete-still-linked',
        requestState: blockedPending.result.structuredContent.requestState,
      }, 763);
      expect(blockedComplete.result.isError).toBe(true);

      const canceled = await confirm('recurring_item_cancel_period_fulfillment', {
        recurring_item_id: recurringItemId,
        period_due_date: '2026-09-20',
      }, 'idem-565-cancel', 770);
      expect(canceled.result.structuredContent.canceled).toMatchObject({
        recurring_item_id: recurringItemId,
        period_due_date: '2026-09-20',
        outcome: 'materialized',
        operation_ids: [operationId],
      });
      expect(canceled.result.structuredContent.recurring_item.next_due_date).toBe('2026-09-20');
      expect(canceled.result.structuredContent.operation_count_unchanged).toBe(true);
      expect(canceled.result.structuredContent.balance_unchanged).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(0);

      const deleted = await confirm('operation_delete', { operation_id: operationId }, 'idem-565-delete-after-cancel', 780);
      expect(deleted.result.structuredContent.success).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE id = ?').bind(operationId).first<{ count: number }>())?.count).toBe(0);
    });

    it('MF-21: links an existing operation to a plan only after MRTR and proves ledger invariants', async () => {
      const planned = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-04', 'Страховка', -2500, 'EUR', ?, 'Insurance', 0) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const operation = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
         VALUES ('2026-09-04', ?, 'expense', 'Страховка', 'Insurance', -2500, 'agent') RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const args = { planned_item_id: planned!.id, operation_id: operation!.id };
      const pending = await callWrite('planned_item_fulfill_existing', {
        ...args, idempotency_key: 'idem-mf-21-planned-existing',
      }, 744);
      expect(pending.result.structuredContent).toMatchObject({ resultType: 'input_required', written: false });
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(0);

      const complete = await callWrite('planned_item_fulfill_existing', {
        ...args,
        idempotency_key: 'idem-mf-21-planned-existing',
        requestState: pending.result.structuredContent.requestState,
      }, 745);
      expect(complete.result.isError, JSON.stringify(complete.result)).toBeUndefined();
      expect(complete.result.structuredContent).toMatchObject({
        written: true,
        operation_count_unchanged: true,
        balance_unchanged: true,
        planned_item: { id: planned!.id, done: true, fulfillment: { type: 'linked', operation_id: operation!.id } },
        operation: { id: operation!.id, source: 'agent', planned_item_id: null },
      });
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(100000);

      const replay = await callWrite('planned_item_fulfill_existing', {
        ...args, idempotency_key: 'idem-mf-21-planned-existing',
      }, 746);
      expect(replay.result.structuredContent.written).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(1);
    });

    it('MF-21: links an exact operation group to one recurring occurrence with durable read-back', async () => {
      const recurring = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Продукты', -1300, 'EUR', ?, 'Продукты', 'daily', 1, NULL, NULL, '2026-09-05', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const first = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
         VALUES ('2026-09-05', ?, 'expense', 'Хлеб', 'Продукты', -600, 'agent') RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const second = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
         VALUES ('2026-09-05', ?, 'expense', 'Молоко', 'Продукты', -700, 'agent') RETURNING id`,
      ).bind(accountId).first<{ id: number }>();

      const completed = await confirm('recurring_item_fulfill_existing', {
        recurring_item_id: recurring!.id,
        period_due_date: '2026-09-05',
        operation_ids: [second!.id, first!.id],
      }, 'idem-mf-21-recurring-existing', 747);
      expect(completed.result.structuredContent).toMatchObject({
        operation_count_unchanged: true,
        balance_unchanged: true,
        recurring_item: { id: recurring!.id, next_due_date: '2026-09-06' },
        fulfillment: {
          recurring_item_id: recurring!.id,
          period_due_date: '2026-09-05',
          outcome: 'linked',
          evidence_quantity: 1,
          operation_ids: [first!.id, second!.id],
        },
      });
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(2);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(100000);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);
    });

    it('MF-21: advertised auto_confirm executes planned link, recurring link, and skip for an authorized agent', async () => {
      const planned = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-10', 'Auto plan', -1000, 'EUR', ?, 'Food', 0) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const plannedOperation = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
         VALUES ('2026-09-10', ?, 'expense', 'Auto plan', 'Food', -1000, 'agent') RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const plannedResult = await callWrite('planned_item_fulfill_existing', {
        planned_item_id: planned!.id,
        operation_id: plannedOperation!.id,
        auto_confirm: true,
        idempotency_key: 'idem-mf-21-auto-planned',
      }, 748);
      expect(plannedResult.result.structuredContent).toMatchObject({
        resultType: 'complete', written: true, operation_count_unchanged: true, balance_unchanged: true,
      });

      const recurring = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Auto recurring', -1000, 'EUR', ?, 'Food', 'daily', 1, NULL, NULL, '2026-09-11', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const recurringOperation = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
         VALUES ('2026-09-11', ?, 'expense', 'Auto food', 'Food', -1000, 'agent') RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const fulfilled = await callWrite('recurring_item_fulfill_existing', {
        recurring_item_id: recurring!.id,
        period_due_date: '2026-09-11',
        operation_ids: [recurringOperation!.id],
        auto_confirm: true,
        idempotency_key: 'idem-mf-21-auto-recurring',
      }, 749);
      expect(fulfilled.result.structuredContent).toMatchObject({
        resultType: 'complete', written: true,
        recurring_item: { next_due_date: '2026-09-12' },
        operation_count_unchanged: true, balance_unchanged: true,
      });

      const skipped = await callWrite('recurring_item_skip_period', {
        recurring_item_id: recurring!.id,
        auto_confirm: true,
        idempotency_key: 'idem-mf-21-auto-skip',
      }, 750);
      expect(skipped.result.structuredContent).toMatchObject({
        resultType: 'complete', written: true,
        recurring_item: { next_due_date: '2026-09-13' },
        operation_count_unchanged: true, balance_unchanged: true,
      });

      const invalidControl = await callWrite('recurring_item_skip_period', {
        recurring_item_id: recurring!.id,
        auto_confirm: 'yes',
        idempotency_key: 'idem-mf-21-auto-invalid',
      }, 751);
      expect(invalidControl.result.isError).toBe(true);
      expect(invalidControl.result.structuredContent.error).toMatch(/auto_confirm.*boolean/);
    });

    it('planned update done materializes fact through domain API; delete is confirmed and destructive', async () => {
      const planned = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-02', 'Лицензия', -5000, 'EUR', ?, 'Software', 0) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const completed = await confirm('planned_item_update', {
        planned_item_id: planned!.id, title: 'Лицензия Nous', done: true,
      }, 'idem-ale-7-planned-done', 750);
      expect(completed.result.structuredContent.planned_item.done).toBe(true);
      expect(completed.result.structuredContent.operation.source).toBe('planned');
      expect(completed.result.structuredContent.operation.planned_item_id).toBe(planned!.id);
      const operation = await env.DB.prepare('SELECT source, planned_item_id, amount_minor FROM operations WHERE planned_item_id = ?')
        .bind(planned!.id).first<{ source: string; planned_item_id: number; amount_minor: number }>();
      expect(operation).toEqual({ source: 'planned', planned_item_id: planned!.id, amount_minor: -5000 });

      const deletable = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-03', 'Черновик', -100, 'EUR', ?, NULL, 0) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const deleted = await confirm('planned_item_delete', { planned_item_id: deletable!.id }, 'idem-ale-7-planned-delete', 760);
      expect(deleted.result.structuredContent.success).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM planned_items WHERE id = ?').bind(deletable!.id).first<{ count: number }>())?.count).toBe(0);
    });

    it('rejects recurring close and planned done when the confirmed financial snapshot changed', async () => {
      const recurring = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Snapshot recurring', -2000, 'EUR', ?, 'Software', 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const snapshotClose = {
        recurring_item_id: recurring!.id,
        date: '2026-09-01',
        amount_minor: -2000,
        account_id: accountId,
        item: 'Snapshot recurring',
        category: 'Software',
      };
      const recurringPending = await callWrite('recurring_item_close_period', {
        ...snapshotClose, idempotency_key: 'idem-ale-7-recurring-snapshot',
      }, 762);
      await env.DB.prepare('UPDATE recurring_items SET amount_minor = -9000 WHERE id = ?').bind(recurring!.id).run();
      const recurringRejected = await callWrite('recurring_item_close_period', {
        ...snapshotClose,
        idempotency_key: 'idem-ale-7-recurring-snapshot',
        requestState: recurringPending.result.structuredContent.requestState,
      }, 763);
      expect(recurringRejected.result.isError).toBe(true);
      expect(recurringRejected.result.content[0].text).toMatch(/изменился после подтверждения/i);

      const skippable = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Snapshot skip', -1000, 'EUR', ?, 'Software', 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const skipPending = await callWrite('recurring_item_skip_period', {
        recurring_item_id: skippable!.id, idempotency_key: 'idem-ale-7-skip-snapshot',
      }, 7631);
      await env.DB.prepare("UPDATE recurring_items SET next_due_date = '2026-10-01' WHERE id = ?").bind(skippable!.id).run();
      const skipRejected = await callWrite('recurring_item_skip_period', {
        recurring_item_id: skippable!.id,
        idempotency_key: 'idem-ale-7-skip-snapshot',
        requestState: skipPending.result.structuredContent.requestState,
      }, 7632);
      expect(skipRejected.result.isError).toBe(true);
      expect(skipRejected.result.content[0].text).toMatch(/изменился после подтверждения/i);
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(skippable!.id).first<{ next_due_date: string }>())?.next_due_date).toBe('2026-10-01');

      const planned = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-10', 'Snapshot planned', -3000, 'EUR', ?, 'Software', 0) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const plannedPending = await callWrite('planned_item_update', {
        planned_item_id: planned!.id, done: true, idempotency_key: 'idem-ale-7-planned-snapshot',
      }, 764);
      await env.DB.prepare('UPDATE planned_items SET amount_minor = -8000 WHERE id = ?').bind(planned!.id).run();
      const plannedRejected = await callWrite('planned_item_update', {
        planned_item_id: planned!.id,
        done: true,
        idempotency_key: 'idem-ale-7-planned-snapshot',
        requestState: plannedPending.result.structuredContent.requestState,
      }, 765);
      expect(plannedRejected.result.isError).toBe(true);
      expect(plannedRejected.result.content[0].text).toMatch(/изменился после подтверждения/i);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(100000);
    });

    it('rejects planned update when the confirmed row changed before execution', async () => {
      const planned = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-11', 'Confirmed planned', -3000, 'EUR', ?, 'Software', 0) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const key = 'idem-ale-7-planned-generic-snapshot';
      const pending = await callWrite('planned_item_update', {
        planned_item_id: planned!.id, title: 'Requested title', idempotency_key: key,
      }, 7651);

      await env.DB.prepare("UPDATE planned_items SET title = 'Concurrent title' WHERE id = ?").bind(planned!.id).run();
      const rejected = await callWrite('planned_item_update', {
        planned_item_id: planned!.id,
        title: 'Requested title',
        idempotency_key: key,
        requestState: pending.result.structuredContent.requestState,
      }, 7652);

      expect(rejected.result.isError).toBe(true);
      expect(rejected.result.content[0].text).toMatch(/изменил/i);
      expect((await env.DB.prepare('SELECT title FROM planned_items WHERE id = ?').bind(planned!.id).first<{ title: string }>())?.title).toBe('Concurrent title');
    });

    it('rejects recurring update when the confirmed row changed before execution', async () => {
      const recurring = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Confirmed recurring', -2000, 'EUR', ?, 'Software', 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const key = 'idem-ale-7-recurring-generic-snapshot';
      const pending = await callWrite('recurring_item_update', {
        recurring_item_id: recurring!.id, title: 'Requested rule', idempotency_key: key,
      }, 7653);

      await env.DB.prepare("UPDATE recurring_items SET title = 'Concurrent rule' WHERE id = ?").bind(recurring!.id).run();
      const rejected = await callWrite('recurring_item_update', {
        recurring_item_id: recurring!.id,
        title: 'Requested rule',
        idempotency_key: key,
        requestState: pending.result.structuredContent.requestState,
      }, 7654);

      expect(rejected.result.isError).toBe(true);
      expect(rejected.result.content[0].text).toMatch(/изменил/i);
      expect((await env.DB.prepare('SELECT title FROM recurring_items WHERE id = ?').bind(recurring!.id).first<{ title: string }>())?.title).toBe('Concurrent rule');
    });

    it('does not delete a replacement planned row that reused the confirmed id', async () => {
      const original = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done, revision)
         VALUES ('2026-09-12', 'Original planned', -100, 'EUR', ?, NULL, 0, 'original-planned') RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const key = 'idem-ale-7-planned-delete-reused-id';
      const pending = await callWrite('planned_item_delete', {
        planned_item_id: original!.id, idempotency_key: key,
      }, 7655);

      await env.DB.prepare('DELETE FROM planned_items WHERE id = ?').bind(original!.id).run();
      const replacement = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done, revision)
         VALUES ('2026-09-12', 'Original planned', -100, 'EUR', ?, NULL, 0, 'replacement-planned') RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      expect(replacement!.id).toBe(original!.id);

      const rejected = await callWrite('planned_item_delete', {
        planned_item_id: original!.id,
        idempotency_key: key,
        requestState: pending.result.structuredContent.requestState,
      }, 7656);

      expect(rejected.result.isError).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM planned_items WHERE id = ?').bind(original!.id).first<{ count: number }>())?.count).toBe(1);
    });

    it('does not delete a replacement recurring row that reused the confirmed id', async () => {
      const original = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active, revision)
         VALUES ('Original recurring', -100, 'EUR', ?, NULL, 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1, 'original-recurring')
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const key = 'idem-ale-7-recurring-delete-reused-id';
      const pending = await callWrite('recurring_item_delete', {
        recurring_item_id: original!.id, idempotency_key: key,
      }, 7657);

      await env.DB.prepare('DELETE FROM recurring_items WHERE id = ?').bind(original!.id).run();
      const replacement = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active, revision)
         VALUES ('Original recurring', -100, 'EUR', ?, NULL, 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1, 'replacement-recurring')
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      expect(replacement!.id).toBe(original!.id);

      const rejected = await callWrite('recurring_item_delete', {
        recurring_item_id: original!.id,
        idempotency_key: key,
        requestState: pending.result.structuredContent.requestState,
      }, 7658);

      expect(rejected.result.isError).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items WHERE id = ?').bind(original!.id).first<{ count: number }>())?.count).toBe(1);
    });

    it('updates an already-done plan without requiring its historical operation to mirror the edited plan', async () => {
      const planned = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-14', 'Old planned title', -500, 'EUR', ?, 'Software', 1) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source, planned_item_id)
         VALUES ('2026-09-14', ?, 'expense', 'Historical fact', 'Software', -500, 'planned', ?)`,
      ).bind(accountId, planned!.id).run();

      const completed = await confirm('planned_item_update', {
        planned_item_id: planned!.id, title: 'Edited planned title', done: true,
      }, 'idem-ale-7-done-edit-independent-fact', 7659);

      expect(completed.result.structuredContent.planned_item.title).toBe('Edited planned title');
      expect(completed.result.structuredContent.operation).toBeUndefined();
      expect((await env.DB.prepare('SELECT item FROM operations WHERE planned_item_id = ?').bind(planned!.id).first<{ item: string }>())?.item).toBe('Historical fact');
    });

    it('accepts repeated done=true after the linked operation was independently corrected', async () => {
      const planned = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-15', 'Stable planned', -600, 'EUR', ?, 'Software', 1) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source, planned_item_id)
         VALUES ('2026-09-16', ?, 'expense', 'Corrected fact', 'Other', -700, 'planned', ?)`,
      ).bind(accountId, planned!.id).run();

      const completed = await confirm('planned_item_update', {
        planned_item_id: planned!.id, done: true,
      }, 'idem-ale-7-done-repeat-independent-fact', 7661);

      expect(completed.result.structuredContent.planned_item.done).toBe(true);
      expect(completed.result.structuredContent.operation).toBeUndefined();
      expect((await env.DB.prepare('SELECT item FROM operations WHERE planned_item_id = ?').bind(planned!.id).first<{ item: string }>())?.item).toBe('Corrected fact');
    });

    it('allows only one close for the same recurring period across different idempotency keys', async () => {
      const recurring = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Concurrent recurring', -2000, 'EUR', ?, 'Software', 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1)
         RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const concurrentClose = {
        recurring_item_id: recurring!.id,
        date: '2026-09-01',
        amount_minor: -2000,
        account_id: accountId,
        item: 'Concurrent recurring',
        category: 'Software',
      };
      const firstPending = await callWrite('recurring_item_close_period', {
        ...concurrentClose, idempotency_key: 'idem-ale-7-concurrent-a',
      }, 766);
      const secondPending = await callWrite('recurring_item_close_period', {
        ...concurrentClose, idempotency_key: 'idem-ale-7-concurrent-b',
      }, 767);
      const [first, second] = await Promise.all([
        callWrite('recurring_item_close_period', {
          ...concurrentClose,
          idempotency_key: 'idem-ale-7-concurrent-a',
          requestState: firstPending.result.structuredContent.requestState,
        }, 768),
        callWrite('recurring_item_close_period', {
          ...concurrentClose,
          idempotency_key: 'idem-ale-7-concurrent-b',
          requestState: secondPending.result.structuredContent.requestState,
        }, 769),
      ]);
      expect([first, second].filter((result) => result.result.isError !== true)).toHaveLength(1);
      expect([first, second].filter((result) => result.result.isError === true)).toHaveLength(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE recurring_item_id = ?').bind(recurring!.id).first<{ count: number }>())?.count).toBe(1);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(98000);
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(recurring!.id).first<{ next_due_date: string }>())?.next_due_date).toBe('2026-10-01');

      // Детерминированно имитируем stale reader с прежним якорем: уникальный
      // closure обязан откатить operation, balance delta и update целиком.
      await env.DB.prepare("UPDATE recurring_items SET next_due_date = '2026-09-01' WHERE id = ?").bind(recurring!.id).run();
      const stalePending = await callWrite('recurring_item_close_period', {
        ...concurrentClose, idempotency_key: 'idem-ale-7-stale-period',
      }, 770);
      const stale = await callWrite('recurring_item_close_period', {
        ...concurrentClose,
        idempotency_key: 'idem-ale-7-stale-period',
        requestState: stalePending.result.structuredContent.requestState,
      }, 771);
      expect(stale.result.isError).toBe(true);
      expect(stale.result.content[0].text).toMatch(/RECURRING_PERIOD_ALREADY_CLOSED|already closed/i);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE recurring_item_id = ?').bind(recurring!.id).first<{ count: number }>())?.count).toBe(1);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(98000);
    });

    it('expires an orphaned write claim into fail-closed UNCERTAIN instead of pretending it is still running', async () => {
      const key = 'idem-ale-7-stale-claim';
      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key, created_at)
         VALUES (?, ?, 'recurring_item_add', 'pending', 'CLAIMED', ?, datetime('now', '-2 minutes'))`,
      ).bind(crypto.randomUUID(), clientId, key).run();
      const result = await callWrite('recurring_item_add', {
        title: 'Must not run', amount_minor: -2000, account_id: accountId,
        frequency: 'monthly', next_due_date: '2026-09-01', idempotency_key: key,
      }, 779);
      expect(result.result.isError).toBe(true);
      expect(result.result.content[0].text).toMatch(/срок claim истёк/i);
      const audit = await env.DB.prepare('SELECT result_summary FROM mcp_audit_log WHERE idempotency_key = ?')
        .bind(key).first<{ result_summary: string }>();
      expect(audit?.result_summary).toMatch(/^UNCERTAIN:/);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items').first<{ count: number }>())?.count).toBe(0);
    });

    it('rejects unknown update field before MRTR and rejects recurring write without scope', async () => {
      const invalid = await callWrite('recurring_item_update', {
        recurring_item_id: 1, title: 'x', source: 'agent', idempotency_key: 'idem-ale-7-invalid',
      }, 770);
      expect(invalid.result.isError).toBe(true);
      expect(invalid.result.structuredContent.requestState).toBeUndefined();

      const req = new Request('http://localhost/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 771, method: 'tools/call', params: {
          name: 'recurring_item_add',
          arguments: { title: 'Denied', amount_minor: -2000, account_id: accountId, frequency: 'monthly', next_due_date: '2026-09-01', idempotency_key: 'idem-ale-7-no-scope' },
        } }),
      });
      const denied: any = await (await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any)).json();
      expect(denied.error.code).toBe(-32001);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items').first<{ count: number }>())?.count).toBe(0);
    });

    it('#565: analytical 16/17 reject close_period and fulfill_existing before MRTR', async () => {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO recurring_items
             (id, title, amount_minor, currency, account_id, category, frequency, interval_count,
              day_of_month, month_of_year, next_due_date, end_date, active)
           VALUES (16, 'Продукты', -1000, 'EUR', ?, 'Продукты', 'daily', 1, NULL, NULL, '2026-09-20', NULL, 1)`,
        ).bind(accountId),
        env.DB.prepare(
          `INSERT INTO recurring_items
             (id, title, amount_minor, currency, account_id, category, frequency, interval_count,
              day_of_month, month_of_year, next_due_date, end_date, active)
           VALUES (17, 'Ежедневные', -1000, 'EUR', ?, 'Food', 'daily', 1, NULL, NULL, '2026-09-20', NULL, 1)`,
        ).bind(accountId),
      ]);
      for (const [name, args, key] of [
        ['recurring_item_close_period', { recurring_item_id: 16 }, 'idem-565-analytical-close-16'],
        ['recurring_item_close_period', { recurring_item_id: 17 }, 'idem-565-analytical-close-17'],
        ['recurring_item_fulfill_existing', {
          recurring_item_id: 16, period_due_date: '2026-09-20', operation_ids: [1],
        }, 'idem-565-analytical-fulfill-16'],
      ] as const) {
        const result = await callWrite(name, { ...args, idempotency_key: key }, 782);
        expect(result.result.isError, name).toBe(true);
        expect(result.result.structuredContent.requestState, name).toBeUndefined();
        expect(result.result.content[0].text).toMatch(/skip_period/i);
      }
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = 16')
        .first<{ next_due_date: string }>())?.next_due_date).toBe('2026-09-20');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(0);
    });

    it('fails before MRTR for nonexistent recurring item on every mutation route', async () => {
      for (const [name, args, key] of [
        ['recurring_item_update', { recurring_item_id: 999999, title: 'missing' }, 'idem-ale-7-missing-update'],
        ['recurring_item_delete', { recurring_item_id: 999999 }, 'idem-ale-7-missing-delete'],
        ['recurring_item_skip_period', { recurring_item_id: 999999 }, 'idem-ale-7-missing-skip'],
        ['recurring_item_close_period', { recurring_item_id: 999999 }, 'idem-ale-7-missing-close'],
        ['recurring_item_cancel_period_fulfillment', { recurring_item_id: 999999, period_due_date: '2026-09-20' }, 'idem-565-missing-cancel'],
      ] as const) {
        const result = await callWrite(name, { ...args, idempotency_key: key }, 780);
        expect(result.result.isError, name).toBe(true);
        expect(result.result.structuredContent.requestState, name).toBeUndefined();
      }
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_items').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(0);
    });

    it('rejects an idempotency key previously completed by another tool', async () => {
      const key = 'idem-ale-7-cross-tool';
      await confirm('recurring_item_add', {
        title: 'First tool wins', amount_minor: -2000, account_id: accountId, frequency: 'monthly', next_due_date: '2026-09-01',
      }, key, 790);
      const collision = await callWrite('planned_item_add', {
        date: '2026-09-02', title: 'Must not be created', amount_minor: -100, account_id: accountId, idempotency_key: key,
      }, 792);
      expect(collision.result.isError).toBe(true);
      expect(collision.result.content[0].text).toContain('recurring_item_add');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM planned_items').first<{ count: number }>())?.count).toBe(0);
    });

    it('keeps plan, operation and balance unchanged when done=true violates account currency', async () => {
      const usdPlan = await env.DB.prepare(
        `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done)
         VALUES ('2026-09-05', 'USD plan', -3000, 'USD', ?, 'Software', 0) RETURNING id`,
      ).bind(accountId).first<{ id: number }>();
      const pending = await callWrite('planned_item_update', {
        planned_item_id: usdPlan!.id, done: true, idempotency_key: 'idem-ale-7-currency-refusal',
      }, 800);
      expect(pending.result.structuredContent.resultType).toBe('input_required');
      const refused = await callWrite('planned_item_update', {
        planned_item_id: usdPlan!.id, done: true, idempotency_key: 'idem-ale-7-currency-refusal',
        requestState: pending.result.structuredContent.requestState,
      }, 801);
      expect(refused.result.isError).toBe(true);
      expect(refused.result.content[0].text).toMatch(/PLANNED_CURRENCY_MISMATCH|currency matches the account currency/i);
      expect((await env.DB.prepare('SELECT done FROM planned_items WHERE id = ?').bind(usdPlan!.id).first<{ done: number }>())?.done).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE planned_item_id = ?').bind(usdPlan!.id).first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>())?.balance_minor).toBe(100000);
    });
  });

  describe('ALE-5: operation_update и operation_delete через MCP write tools', () => {
    let eurAccountId: number;
    let usdAccountId: number;

    beforeEach(async () => {
      const eur = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('EUR счёт', 'EUR', 99000, 100, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z')
         RETURNING id`
      ).first<{ id: number }>();
      eurAccountId = eur!.id;

      const usd = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('USD счёт', 'USD', 50000, 101, 0, 'Alex', 'US', '2026-08-15T12:00:00Z')
         RETURNING id`
      ).first<{ id: number }>();
      usdAccountId = usd!.id;
    });

    async function seedOperation(overrides: Record<string, unknown> = {}) {
      const values = {
        date: '2026-08-15',
        account_id: eurAccountId,
        kind: 'expense',
        store: 'Старый магазин',
        item: 'Старая покупка',
        category: 'Старая категория',
        subcategory: 'Старая подкатегория',
        amount_minor: -1000,
        source: 'manual',
        ...overrides,
      } as any;
      const row = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      ).bind(
        values.date,
        values.account_id,
        values.kind,
        values.store,
        values.item,
        values.category,
        values.subcategory,
        values.amount_minor,
        values.source
      ).first<{ id: number }>();
      return row!.id;
    }

    async function callWrite(name: string, args: Record<string, unknown>, id = 4050) {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args }
        })
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
      return res.json() as Promise<any>;
    }

    it('operation_update: MRTR first call не пишет; second call обновляет через backend API и аудит success', async () => {
      const operationId = await seedOperation();
      const idempotencyKey = 'idem-ale-5-update-happy';

      const body1 = await callWrite('operation_update', {
        operation_id: operationId,
        item: 'Новая покупка',
        store: 'Новый магазин',
        category: 'Новая категория',
        subcategory: 'Новая подкатегория',
        amount_minor: -1500,
        idempotency_key: idempotencyKey
      }, 4051);

      expect(body1.result.structuredContent.resultType).toBe('input_required');
      expect(body1.result.structuredContent.written).toBe(false);
      expect(body1.result.structuredContent.tool).toBe('operation_update');
      expect(body1.result.structuredContent.arguments.operation_id).toBe(operationId);

      const before = await env.DB.prepare('SELECT item, amount_minor FROM operations WHERE id = ?')
        .bind(operationId).first<{ item: string; amount_minor: number }>();
      expect(before?.item).toBe('Старая покупка');
      expect(before?.amount_minor).toBe(-1000);

      const body2 = await callWrite('operation_update', {
        operation_id: operationId,
        idempotency_key: idempotencyKey,
        requestState: body1.result.structuredContent.requestState
      }, 4052);

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.resultType).toBe('complete');
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.operation.id).toBe(operationId);
      expect(body2.result.structuredContent.operation.item).toBe('Новая покупка');
      expect(body2.result.structuredContent.operation.amount_minor).toBe(-1500);
      expect(body2.result.structuredContent.operation.source).toBe('manual');

      const account = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
        .bind(eurAccountId).first<{ balance_minor: number }>();
      expect(account?.balance_minor).toBe(98500);

      const audit = await env.DB.prepare('SELECT status, tool_name FROM mcp_audit_log WHERE idempotency_key = ?')
        .bind(idempotencyKey).first<{ status: string; tool_name: string }>();
      expect(audit?.status).toBe('success');
      expect(audit?.tool_name).toBe('operation_update');
    });

    it('operation_update: happy path на нескольких полях и очистка nullable optional fields', async () => {
      const operationId = await seedOperation();
      const body1 = await callWrite('operation_update', {
        operation_id: operationId,
        date: '2026-08-16',
        store: null,
        category: null,
        subcategory: null,
        idempotency_key: 'idem-ale-5-update-nullable'
      }, 4053);
      const body2 = await callWrite('operation_update', {
        operation_id: operationId,
        idempotency_key: 'idem-ale-5-update-nullable',
        requestState: body1.result.structuredContent.requestState
      }, 4054);

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.operation.date).toBe('2026-08-16');
      expect(body2.result.structuredContent.operation.store).toBeNull();
      expect(body2.result.structuredContent.operation.category).toBeNull();
      expect(body2.result.structuredContent.operation.subcategory).toBeNull();
    });

    it('operation_add и operation_update принимают comment, receipt_url и fiscal_receipt_id', async () => {
      const purs = 'https://suf.purs.gov.rs/v/?vl=abc';
      const add1 = await callWrite('operation_add', {
        date: '2026-08-15',
        account_id: eurAccountId,
        kind: 'expense',
        item: 'Пекарня',
        amount_minor: -500,
        comment: 'QR с чека',
        receipt_url: purs,
        fiscal_receipt_id: 'PFR-BAKERY-1',
        idempotency_key: 'idem-557-add-pfr',
      }, 5571);
      const add2 = await callWrite('operation_add', {
        idempotency_key: 'idem-557-add-pfr',
        requestState: add1.result.structuredContent.requestState,
      }, 5572);
      expect(add2.result.structuredContent.operation.comment).toBe('QR с чека');
      expect(add2.result.structuredContent.operation.receipt_url).toBe(purs);
      expect(add2.result.structuredContent.operation.fiscal_receipt_id).toBe('PFR-BAKERY-1');

      const operationId = add2.result.structuredContent.operation.id;
      const upd1 = await callWrite('operation_update', {
        operation_id: operationId,
        comment: null,
        receipt_url: 'https://example.com/fiscal',
        fiscal_receipt_id: null,
        idempotency_key: 'idem-557-upd-pfr',
      }, 5573);
      const upd2 = await callWrite('operation_update', {
        operation_id: operationId,
        idempotency_key: 'idem-557-upd-pfr',
        requestState: upd1.result.structuredContent.requestState,
      }, 5574);
      expect(upd2.result.structuredContent.operation.comment).toBeNull();
      expect(upd2.result.structuredContent.operation.receipt_url).toBe('https://example.com/fiscal');
      expect(upd2.result.structuredContent.operation.fiscal_receipt_id).toBeNull();

      const rejected = await callWrite('operation_add', {
        date: '2026-08-15',
        account_id: eurAccountId,
        kind: 'expense',
        item: 'Плохой URL',
        amount_minor: -100,
        receipt_url: 'javascript:alert(1)',
        idempotency_key: 'idem-557-bad-url',
      }, 5575);
      expect(rejected.result.isError).toBe(true);
      expect(rejected.result.structuredContent.error).toContain('receipt_url');
    });

    it('issue #574: same-PFR multi-line operation_add succeeds; exact line is 409 ValidationError, not UNCERTAIN', async () => {
      const pfr = 'JDEKKL35-GESE6HO0-136069';
      const receiptUrl = 'https://suf.purs.gov.rs/v/?vl=aroma-multiline';
      const lines = [
        { item: 'Espresso', amount_minor: -25000, key: 'idem-574-line-1' },
        { item: 'Croissant', amount_minor: -18000, key: 'idem-574-line-2' },
        { item: 'Water', amount_minor: -4000, key: 'idem-574-line-3' },
      ];
      const writtenIds: number[] = [];

      for (const [index, line] of lines.entries()) {
        const pending = await callWrite('operation_add', {
          date: '2026-09-20',
          account_id: eurAccountId,
          kind: 'expense',
          item: line.item,
          store: 'Aroma',
          amount_minor: line.amount_minor,
          receipt_url: receiptUrl,
          fiscal_receipt_id: pfr,
          idempotency_key: line.key,
        }, 5740 + index * 2);
        expect(pending.result.structuredContent.resultType, line.item).toBe('input_required');
        const complete = await callWrite('operation_add', {
          date: '2026-09-20',
          account_id: eurAccountId,
          kind: 'expense',
          item: line.item,
          store: 'Aroma',
          amount_minor: line.amount_minor,
          receipt_url: receiptUrl,
          fiscal_receipt_id: pfr,
          idempotency_key: line.key,
          requestState: pending.result.structuredContent.requestState,
        }, 5741 + index * 2);
        expect(complete.result.isError, JSON.stringify(complete.result)).toBeUndefined();
        expect(complete.result.structuredContent.written).toBe(true);
        expect(complete.result.structuredContent.operation.fiscal_receipt_id).toBe(pfr);
        writtenIds.push(complete.result.structuredContent.operation.id);
      }

      expect(writtenIds).toHaveLength(3);
      expect(new Set(writtenIds).size).toBe(3);
      expect((await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM operations WHERE fiscal_receipt_id = ?',
      ).bind(pfr).first<{ count: number }>())?.count).toBe(3);

      const dupPending = await callWrite('operation_add', {
        date: '2026-09-20',
        account_id: eurAccountId,
        kind: 'expense',
        item: 'Espresso',
        store: 'Aroma',
        amount_minor: -25000,
        receipt_url: receiptUrl,
        fiscal_receipt_id: pfr,
        idempotency_key: 'idem-574-dup-espresso',
      }, 5750);
      expect(dupPending.result.structuredContent.resultType).toBe('input_required');
      const duplicate = await callWrite('operation_add', {
        date: '2026-09-20',
        account_id: eurAccountId,
        kind: 'expense',
        item: 'Espresso',
        store: 'Aroma',
        amount_minor: -25000,
        receipt_url: receiptUrl,
        fiscal_receipt_id: pfr,
        idempotency_key: 'idem-574-dup-espresso',
        requestState: dupPending.result.structuredContent.requestState,
      }, 5751);

      expect(duplicate.result.isError).toBe(true);
      expect(duplicate.result.structuredContent.error).toContain('DUPLICATE_EXPENSE');
      expect(duplicate.result.structuredContent.error).toContain(String(writtenIds[0]));
      expect(duplicate.result.structuredContent.error).not.toMatch(/UNCERTAIN/i);

      const claim = await env.DB.prepare(
        'SELECT status, result_summary FROM mcp_audit_log WHERE idempotency_key = ?',
      ).bind('idem-574-dup-espresso').first<{ status: string; result_summary: string | null }>();
      expect(claim).toBeNull();
      expect((await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM mcp_audit_log WHERE result_summary LIKE 'UNCERTAIN:%'`,
      ).first<{ count: number }>())?.count).toBe(0);

      const nextPending = await callWrite('operation_add', {
        date: '2026-09-20',
        account_id: eurAccountId,
        kind: 'expense',
        item: 'Tea',
        store: 'Aroma',
        amount_minor: -6000,
        receipt_url: receiptUrl,
        fiscal_receipt_id: pfr,
        idempotency_key: 'idem-574-line-4',
      }, 5752);
      const nextComplete = await callWrite('operation_add', {
        date: '2026-09-20',
        account_id: eurAccountId,
        kind: 'expense',
        item: 'Tea',
        store: 'Aroma',
        amount_minor: -6000,
        receipt_url: receiptUrl,
        fiscal_receipt_id: pfr,
        idempotency_key: 'idem-574-line-4',
        requestState: nextPending.result.structuredContent.requestState,
      }, 5753);
      expect(nextComplete.result.isError, JSON.stringify(nextComplete.result)).toBeUndefined();
      expect((await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM operations WHERE fiscal_receipt_id = ?',
      ).bind(pfr).first<{ count: number }>())?.count).toBe(4);
    });

    it('operation_update: unknown/system fields отклоняются явной ошибкой до MRTR', async () => {
      const operationId = await seedOperation();
      const body = await callWrite('operation_update', {
        operation_id: operationId,
        item: 'Попытка',
        source: 'agent',
        receipt_id: 123,
        unexpected_field: true,
        idempotency_key: 'idem-ale-5-update-system'
      }, 4055);

      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent.error).toContain('Разрешённые поля');
      expect(body.result.structuredContent.error).toContain('source');
      expect(body.result.structuredContent.requestState).toBeUndefined();
    });

    it('operation_update: not found и validation error возвращают actionable error, не 500', async () => {
      const notFound = await callWrite('operation_update', {
        operation_id: 999999,
        item: 'Нет строки',
        idempotency_key: 'idem-ale-5-update-not-found'
      }, 4056);
      expect(notFound.result.isError).toBe(true);
      expect(notFound.result.structuredContent.error).toMatch(/не найдена|not found/i);

      const operationId = await seedOperation();
      const invalid = await callWrite('operation_update', {
        operation_id: operationId,
        account_id: usdAccountId,
        idempotency_key: 'idem-ale-5-update-validation'
      }, 4057);
      expect(invalid.result.isError).toBe(true);
      expect(invalid.result.structuredContent.error).toContain('amount_minor');
    });

    it('operation_delete: MRTR first call не пишет; second call удаляет через backend API, возвращает snapshot и аудит success', async () => {
      const operationId = await seedOperation();
      const idempotencyKey = 'idem-ale-5-delete-happy';

      const body1 = await callWrite('operation_delete', {
        operation_id: operationId,
        idempotency_key: idempotencyKey
      }, 4058);

      expect(body1.result.structuredContent.resultType).toBe('input_required');
      expect(body1.result.structuredContent.written).toBe(false);
      expect(body1.result.structuredContent.tool).toBe('operation_delete');

      const existsBefore = await env.DB.prepare('SELECT COUNT(*) as count FROM operations WHERE id = ?')
        .bind(operationId).first<{ count: number }>();
      expect(existsBefore?.count).toBe(1);

      const body2 = await callWrite('operation_delete', {
        operation_id: operationId,
        idempotency_key: idempotencyKey,
        requestState: body1.result.structuredContent.requestState
      }, 4059);

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.resultType).toBe('complete');
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.success).toBe(true);
      expect(body2.result.structuredContent.operation_id).toBe(operationId);
      expect(body2.result.structuredContent.deleted_operation.item).toBe('Старая покупка');

      const existsAfter = await env.DB.prepare('SELECT COUNT(*) as count FROM operations WHERE id = ?')
        .bind(operationId).first<{ count: number }>();
      expect(existsAfter?.count).toBe(0);
      const account = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
        .bind(eurAccountId).first<{ balance_minor: number }>();
      expect(account?.balance_minor).toBe(100000);

      const audit = await env.DB.prepare('SELECT status, tool_name FROM mcp_audit_log WHERE idempotency_key = ?')
        .bind(idempotencyKey).first<{ status: string; tool_name: string }>();
      expect(audit?.status).toBe('success');
      expect(audit?.tool_name).toBe('operation_delete');
    });

    it('operation_delete: повторное удаление / отсутствующая operation возвращает стабильную ошибку', async () => {
      const body = await callWrite('operation_delete', {
        operation_id: 999999,
        idempotency_key: 'idem-ale-5-delete-not-found'
      }, 4060);
      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent.error).toMatch(/не найдена|not found/i);
    });

    it('operation_update без write scope отклоняется permission error', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4061,
          method: 'tools/call',
          params: {
            name: 'operation_update',
            arguments: { operation_id: 1, item: 'x', idempotency_key: 'idem-no-write' }
          }
        })
      });
      const body: any = await (await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any)).json();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain('"write" scope required');
    });
  });


  describe('S2-5: MCP Apps & UI Resources (SEP-1865)', () => {
    it('forecast_get tool содержит _meta.ui с ссылкой на ui://pulse', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'tools/list', params: {} })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      const forecastTool = body.result.tools.find((t: any) => t.name === 'forecast_get');
      expect(forecastTool).toBeDefined();
      expect(forecastTool._meta).toBeDefined();
      expect(forecastTool._meta.ui).toBeDefined();
      expect(forecastTool._meta.ui.resourceUri).toBe('ui://pulse');
      expect(forecastTool._meta.ui.visibility).toEqual(['model', 'app']);
      expect(forecastTool._meta.ui.csp.resourceDomains).toBeDefined();
    });

    it('resources/list без scope отклоняет; с write отдаёт confirm, не Пульс', async () => {
      const emptyReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 61, method: 'resources/list', params: {} })
      });
      const denied: any = await (await mcpApp.fetch(emptyReq, typedEnv, { props: { scopes: [], clientId } } as any)).json();
      expect(denied.error).toBeDefined();
      expect(denied.error.code).toBe(-32001);

      const writeReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 61, method: 'resources/list', params: {} })
      });
      const writeOnly: any = await (await mcpApp.fetch(writeReq, typedEnv, { props: { scopes: ['write'], clientId } } as any)).json();
      expect(writeOnly.error).toBeUndefined();
      const uris = writeOnly.result.resources.map((r: any) => r.uri);
      expect(uris).toContain('ui://write-confirm');
      expect(uris).not.toContain('ui://pulse');
    });

    it('resources/list возвращает список UI ресурсов при наличии scope "read"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 62, method: 'resources/list', params: {} })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.resources).toBeDefined();
      expect(body.result.resources.length).toBeGreaterThan(0);
      const pulseResource = body.result.resources.find((r: any) => r.uri === 'ui://pulse');
      expect(pulseResource).toBeDefined();
      expect(pulseResource.mimeType).toBe('text/html;profile=mcp-app');
      expect(pulseResource._meta.ui.prefersBorder).toBe(true);

      const analyticsResource = body.result.resources.find((r: any) => r.uri === 'ui://analytics');
      expect(analyticsResource).toBeDefined();
      expect(analyticsResource.mimeType).toBe('text/html;profile=mcp-app');
      expect(analyticsResource._meta.ui.prefersBorder).toBe(true);
    });

    it('resources/read требует scope "read"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 63,
          method: 'resources/read',
          params: { uri: 'ui://pulse' }
        })
      });

      const ctx = { props: { scopes: [], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);
    });

    it('resources/read возвращает HTML-код Пульса для uri "ui://pulse"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 64,
          method: 'resources/read',
          params: { uri: 'ui://pulse' }
        })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.contents).toBeDefined();
      expect(body.result.contents.length).toBe(1);
      const content = body.result.contents[0];
      expect(content.uri).toBe('ui://pulse');
      expect(content.mimeType).toBe('text/html;profile=mcp-app');
      expect(content.text).toContain('<!DOCTYPE html>');
      expect(content.text).toContain('Пульс');
      expect(content.text).toContain('ui/initialize');
      expect(content.text).toContain('forecast_get');
    });

    it('resources/read возвращает HTML-код Аналитики для uri "ui://analytics"', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 641,
          method: 'resources/read',
          params: { uri: 'ui://analytics' }
        })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.contents).toBeDefined();
      expect(body.result.contents.length).toBe(1);
      const content = body.result.contents[0];
      expect(content.uri).toBe('ui://analytics');
      expect(content.mimeType).toBe('text/html;profile=mcp-app');
      expect(content.text).toContain('<!DOCTYPE html>');
      expect(content.text).toContain('Аналитика');
      expect(content.text).toContain('ui/initialize');
      expect(content.text).toContain('analytics_get');
    });

    it('tools/call analytics_get возвращает данные аналитики', async () => {
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('base_currency', 'EUR') ON CONFLICT(key) DO UPDATE SET value = 'EUR'`
      ).run();
      await env.DB.prepare(
        `INSERT INTO accounts (id, name, owner, country, currency, balance_minor, balance_updated_at) VALUES (1, 'Main EUR', 'Alex', 'MNE', 'EUR', 100000, '2026-08-10T12:00:00Z')`
      ).run();
      await env.DB.prepare(
        `INSERT INTO operations (id, date, account_id, kind, item, amount_minor, category, source) 
         VALUES (1, '2026-08-10', 1, 'expense', 'Coffee', -350, 'Food', 'manual')`
      ).run();

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 642,
          method: 'tools/call',
          params: {
            name: 'analytics_get',
            arguments: {
              start_date: '2026-08-01',
              end_date: '2026-08-31'
            }
          }
        })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.structuredContent).toBeDefined();
      expect(body.result.structuredContent.stats.total_spent_minor).toBe(350);
      expect(body.result.structuredContent.categories[0].label).toBe('Food');
    });

    it('resources/read возвращает ошибку 32602 для неизвестного uri', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 65,
          method: 'resources/read',
          params: { uri: 'ui://unknown-resource' }
        })
      });

      const ctx = { props: { scopes: ['read'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      const body: any = await res.json();

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('Resource not found');
    });
  });

  describe('#324: structuredContent в каждом tools/call ответе', () => {
    let accountId: number;

    beforeEach(async () => {
      const acc = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('Тест', 'EUR', 100000, 100, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z')
         RETURNING id`
      ).first<{ id: number }>();
      accountId = acc!.id;
    });

    it('fx_rate_set без requestState: 200, есть structuredContent, форма совпадает со схемой (MRTR)', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: {
              auto_confirm: false,
              code: 'USD',
              rate: 1.09,
              idempotency_key: 'idem-fx-324-1'
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();

      expect(body.result.structuredContent.resultType).toBe('input_required');
      expect(body.result.requestState).toBeUndefined();
      // structuredContent обязателен по MCP 2025 — без него Gemini закрывает транспорт
      expect(body.result.structuredContent).toBeDefined();
      expect(body.result.structuredContent.resultType).toBe('input_required');
      expect(body.result.structuredContent.requestState).toBeDefined();
      expect(typeof body.result.structuredContent.description).toBe('string');
    });

    it('operation_add без requestState: structuredContent присутствует (MRTR)', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: {
            name: 'operation_add',
            arguments: {
              date: '2026-08-16',
              account_id: accountId,
              kind: 'expense',
              item: 'Кофе',
              amount_minor: -250,
              idempotency_key: 'idem-op-324-1'
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();

      expect(body.result.structuredContent.resultType).toBe('input_required');
      expect(body.result.structuredContent).toBeDefined();
      expect(body.result.structuredContent.resultType).toBe('input_required');
    });

    it('write-инструмент: ошибка валидации содержит structuredContent', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: {
              code: 'TOOLONG',
              rate: 1.09,
              idempotency_key: 'idem-fx-324-err'
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent).toBeDefined();
      expect(typeof body.result.structuredContent.error).toBe('string');
    });

    it('write-инструмент: отсутствие idempotency_key содержит structuredContent', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: { code: 'USD', rate: 1.09 }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent).toBeDefined();
      expect(typeof body.result.structuredContent.error).toBe('string');
      expect(body.result.structuredContent.error).toContain('idempotency_key');
    });

    it('write-инструмент: битый requestState содержит structuredContent', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 104,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: {
              code: 'USD',
              rate: 1.09,
              idempotency_key: 'idem-fx-324-bad-state',
              requestState: 'notvalidbase64!!'
            }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent).toBeDefined();
      expect(typeof body.result.structuredContent.error).toBe('string');
    });

    it('#328: fx_rate_set без requestState не пишет курс; audit без ключа не success', async () => {
      await env.DB.prepare(
        `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('RSD', 9800000, '2026-08-12T14:34:29Z')`
      ).run();

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 120,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: { auto_confirm: false, code: 'RSD', rate: 0.009868, idempotency_key: 'idem-fx-328-pending' }
          }
        })
      });

      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();

      expect(body.result.isError).toBeUndefined();
      expect(body.result.structuredContent.resultType).toBe('input_required');
      expect(body.result.structuredContent.written).toBe(false);
      expect(body.result.structuredContent.rate).toBeUndefined();
      expect(body.result.structuredContent.fx_rate).toBeUndefined();
      expect(body.result.content[0].text).toMatch(/запись не выполнена/i);
      expect(body.result.content[0].text).toMatch(/не сообща/i);

      const row = await env.DB.prepare('SELECT code, rate_e9, updated_at FROM fx_rates WHERE code = ?')
        .bind('RSD')
        .first<{ code: string; rate_e9: number; updated_at: string }>();
      expect(row?.rate_e9).toBe(9_800_000);
      expect(row?.updated_at).toBe('2026-08-12T14:34:29Z');

      const byKey = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM mcp_audit_log WHERE idempotency_key = ?'
      ).bind('idem-fx-328-pending').first<{ count: number }>();
      expect(byKey?.count).toBe(0);

      const audit = await env.DB.prepare(
        'SELECT status FROM mcp_audit_log WHERE tool_name LIKE ?'
      ).bind('fx_rate_%').first<{ status: string }>();
      expect(audit?.status).not.toBe('success');
    });

    it('#328: fx_rate_set после requestState пишет курс и audit success', async () => {
      await env.DB.prepare(
        `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('RSD', 9800000, '2026-08-12T14:34:29Z')`
      ).run();

      const ctx = { props: { scopes: ['read', 'write'], clientId } };
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 121,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: { auto_confirm: false, code: 'RSD', rate: 0.009868, idempotency_key: 'idem-fx-328-confirm' }
          }
        })
      });
      const body1: any = await (await mcpApp.fetch(req1, typedEnv, ctx as any)).json();
      expect(body1.result.structuredContent.requestState).toBeDefined();

      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 122,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: {
              code: 'RSD',
              rate: 0.009868,
              idempotency_key: 'idem-fx-328-confirm',
              requestState: body1.result.structuredContent.requestState
            }
          }
        })
      });
      const res2 = await mcpApp.fetch(req2, typedEnv, ctx as any);
      const body2: any = await res2.json();

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.resultType).toBe('complete');
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.rate.code).toBe('RSD');

      const row = await env.DB.prepare('SELECT code, rate_e9 FROM fx_rates WHERE code = ?')
        .bind('RSD')
        .first<{ code: string; rate_e9: number }>();
      expect(row?.rate_e9).toBe(9_868_000);

      const audit = await env.DB.prepare(
        'SELECT status, tool_name FROM mcp_audit_log WHERE idempotency_key = ?'
      ).bind('idem-fx-328-confirm').first<{ status: string; tool_name: string }>();
      expect(audit?.status).toBe('success');
      expect(audit?.tool_name).toBe('fx_rate_set');
    });

    it('#328: tools/list пишет, что первый вызов без requestState ничего не записывает', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 123, method: 'tools/list', params: {} })
      });
      const ctx = { props: { scopes: ['write'], clientId } };
      const body: any = await (await mcpApp.fetch(req, typedEnv, ctx as any)).json();
      const writeNames = [
        'operation_add', 'operation_update', 'operation_delete', 'balance_correct',
        'planned_item_add', 'planned_item_update', 'planned_item_fulfill_existing', 'planned_item_delete',
        'recurring_item_add', 'recurring_item_update', 'recurring_item_delete',
        'recurring_item_close_period', 'recurring_item_fulfill_existing', 'recurring_item_skip_period',
        'recurring_item_cancel_period_fulfillment',
        'transfer_add', 'fx_rate_set', 'fx_rate_delete', 'data_reset',
      ];
      for (const name of writeNames) {
        const tool = body.result.tools.find((t: any) => t.name === name);
        expect(tool, name).toBeDefined();
        expect(tool.description).toMatch(/первый вызов без requestState ничего не записывает/i);
        expect(tool.outputSchema.properties.written).toEqual({ type: 'boolean' });
      }
    });

    it('fx_rate_set полный цикл: оба шага возвращают structuredContent', async () => {
      const ctx = { props: { scopes: ['read', 'write'], clientId } };

      // Шаг 1: MRTR
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 110,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: { auto_confirm: false, code: 'RSD', rate: 1.09, idempotency_key: 'idem-fx-full' }
          }
        })
      });
      const res1 = await mcpApp.fetch(req1, typedEnv, ctx as any);
      const body1: any = await res1.json();

      expect(body1.result.structuredContent).toBeDefined();
      expect(body1.result.structuredContent.resultType).toBe('input_required');

      // Шаг 2: Подтверждение
      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 111,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: {
              code: 'RSD',
              rate: 1.09,
              idempotency_key: 'idem-fx-full',
              requestState: body1.result.structuredContent.requestState
            }
          }
        })
      });
      const res2 = await mcpApp.fetch(req2, typedEnv, ctx as any);
      const body2: any = await res2.json();

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent).toBeDefined();
      expect(body2.result.structuredContent.rate).toBeDefined();
      expect(body2.result.structuredContent.rate.code).toBe('RSD');
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.resultType).toBe('complete');
    });

    it('#327: fx_rate_delete после requestState удаляет курс и возвращает success (204 без тела не ломает ответ)', async () => {
      await env.DB.prepare(
        `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('USD', 1090000000, '2026-08-12T14:34:29Z')`
      ).run();

      const ctx = { props: { scopes: ['write'], clientId } };

      // Шаг 1: MRTR
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 130,
          method: 'tools/call',
          params: {
            name: 'fx_rate_delete',
            arguments: { code: 'USD', idempotency_key: 'idem-fx-327' }
          }
        })
      });
      const body1: any = await (await mcpApp.fetch(req1, typedEnv, ctx as any)).json();
      expect(body1.result.structuredContent.requestState).toBeDefined();
      expect(body1.result.structuredContent.written).toBe(false);

      // Шаг 2: подтверждение → DELETE /fx-rates/USD отвечает 204 без тела
      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 131,
          method: 'tools/call',
          params: {
            name: 'fx_rate_delete',
            arguments: {
              code: 'USD',
              idempotency_key: 'idem-fx-327',
              requestState: body1.result.structuredContent.requestState
            }
          }
        })
      });
      const res2 = await mcpApp.fetch(req2, typedEnv, ctx as any);
      const body2: any = await res2.json();

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.success).toBe(true);
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.resultType).toBe('complete');

      const row = await env.DB.prepare('SELECT code FROM fx_rates WHERE code = ?').bind('USD').first<{ code: string }>();
      expect(row).toBeNull();

      const audit = await env.DB.prepare(
        'SELECT status FROM mcp_audit_log WHERE idempotency_key = ?'
      ).bind('idem-fx-327').first<{ status: string }>();
      expect(audit?.status).toBe('success');

      // Повторное удаление уже удалённого → ожидаемая ошибка с structuredContent (404), не молчаливый успех
      const req3 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 132,
          method: 'tools/call',
          params: {
            name: 'fx_rate_delete',
            arguments: { code: 'USD', idempotency_key: 'idem-fx-327-repeat' }
          }
        })
      });
      const body3: any = await (await mcpApp.fetch(req3, typedEnv, ctx as any)).json();
      expect(body3.result.structuredContent.requestState).toBeDefined();

      const req4 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 133,
          method: 'tools/call',
          params: {
            name: 'fx_rate_delete',
            arguments: {
              code: 'USD',
              idempotency_key: 'idem-fx-327-repeat',
              requestState: body3.result.structuredContent.requestState
            }
          }
        })
      });
      const res4 = await mcpApp.fetch(req4, typedEnv, ctx as any);
      const body4: any = await res4.json();
      expect(body4.result.isError).toBe(true);
      expect(typeof body4.result.structuredContent.error).toBe('string');
    });
  });

  describe('#579: data_reset wipes the ledger after MRTR + RESET phrase', () => {
    it('rejects a wrong phrase before issuing requestState', async () => {
      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5791,
          method: 'tools/call',
          params: {
            name: 'data_reset',
            arguments: { confirm_phrase: 'wipe', idempotency_key: 'idem-reset-wrong' },
          },
        }),
      }), typedEnv, ctx as any);
      const body: any = await res.json();
      expect(body.result.isError).toBe(true);
      expect(String(body.result.structuredContent?.error ?? body.result.content?.[0]?.text ?? '')).toMatch(/RESET/);
    });

    it('empties accounts after confirmed reset and keeps OAuth client', async () => {
      await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('Demo cash', 'USD', 1000, 1, 0, 'Owner', 'US', '2026-09-20T12:00:00Z')`,
      ).run();
      const ctx = { props: { scopes: ['read', 'write'], clientId } };
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5792,
          method: 'tools/call',
          params: {
            name: 'data_reset',
            arguments: { confirm_phrase: 'RESET', idempotency_key: 'idem-reset-579' },
          },
        }),
      });
      const body1: any = await (await mcpApp.fetch(req1, typedEnv, ctx as any)).json();
      expect(body1.result.structuredContent.written).toBe(false);
      expect(body1.result.structuredContent.requestState).toBeDefined();

      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5793,
          method: 'tools/call',
          params: {
            name: 'data_reset',
            arguments: {
              confirm_phrase: 'RESET',
              idempotency_key: 'idem-reset-579',
              requestState: body1.result.structuredContent.requestState,
            },
          },
        }),
      });
      const body2: any = await (await mcpApp.fetch(req2, typedEnv, ctx as any)).json();
      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.reset).toBe(true);

      const account = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
      expect(account?.n).toBe(0);
      const oauth = await env.DB.prepare('SELECT id FROM oauth_clients WHERE id = ?')
        .bind(clientId).first<{ id: string }>();
      expect(oauth?.id).toBe(clientId);
    });
  });

  describe('#331: resultType в structuredContent, класс write и MCP App confirm', () => {
    let accountId: number;

    beforeEach(async () => {
      const acc = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('Тест', 'EUR', 100000, 100, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z')
         RETURNING id`
      ).first<{ id: number }>();
      accountId = acc!.id;
    });

    async function callWrite(name: string, args: Record<string, unknown>, extra?: Record<string, unknown>) {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: extra?.id ?? 200,
          method: 'tools/call',
          params: { name, arguments: args }
        })
      });
      const ctx = { props: { scopes: ['write'], clientId } };
      const res = await mcpApp.fetch(req, typedEnv, ctx as any);
      return res.json() as Promise<any>;
    }

    it('confirm кладёт resultType=complete в structuredContent', async () => {
      const body1 = await callWrite('fx_rate_set', { auto_confirm: false, code: 'RSD', rate: 0.009868, idempotency_key: 'idem-331-sc' }, { id: 201 });
      const body2 = await callWrite('fx_rate_set', {
        code: 'RSD',
        rate: 0.009868,
        idempotency_key: 'idem-331-sc',
        requestState: body1.result.structuredContent.requestState
      }, { id: 202 });
      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.resultType).toBe('complete');
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.resultType).toBe('complete');
    });

    it('каждый write без requestState не пишет в D1 и не пишет audit', async () => {
      await env.DB.prepare(
        `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('RSD', 9800000, '2026-08-12T14:34:29Z')`
      ).run();

      const cases: Array<{ name: string; args: Record<string, unknown>; check: () => Promise<void> }> = [
        {
          name: 'operation_add',
          args: {
            date: '2026-08-16',
            account_id: accountId,
            kind: 'expense',
            item: 'Кофе',
            amount_minor: -250,
            idempotency_key: 'idem-331-op'
          },
          check: async () => {
            const n = await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>();
            expect(n?.count).toBe(0);
          }
        },
        {
          name: 'balance_correct',
          args: { account_id: accountId, balance_minor: 1, idempotency_key: 'idem-331-bal' },
          check: async () => {
            const row = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
              .bind(accountId).first<{ balance_minor: number }>();
            expect(row?.balance_minor).toBe(100000);
          }
        },
        {
          name: 'planned_item_add',
          args: {
            date: '2026-09-01',
            title: 'Аренда',
            amount_minor: -60000,
            account_id: accountId,
            idempotency_key: 'idem-331-pl'
          },
          check: async () => {
            const n = await env.DB.prepare('SELECT COUNT(*) as count FROM planned_items').first<{ count: number }>();
            expect(n?.count).toBe(0);
          }
        },
        {
          name: 'fx_rate_set',
          args: { auto_confirm: false, code: 'RSD', rate: 0.009868, idempotency_key: 'idem-331-fxs' },
          check: async () => {
            const row = await env.DB.prepare('SELECT rate_e9 FROM fx_rates WHERE code = ?')
              .bind('RSD').first<{ rate_e9: number }>();
            expect(row?.rate_e9).toBe(9_800_000);
          }
        },
        {
          name: 'fx_rate_delete',
          args: { auto_confirm: false, code: 'RSD', idempotency_key: 'idem-331-fxd' },
          check: async () => {
            const row = await env.DB.prepare('SELECT code FROM fx_rates WHERE code = ?')
              .bind('RSD').first<{ code: string }>();
            expect(row?.code).toBe('RSD');
          }
        }
      ];

      for (const c of cases) {
        const body = await callWrite(c.name, c.args);
        expect(body.result.resultType, c.name).toBeUndefined();
        expect(body.result.structuredContent.resultType, c.name).toBe('input_required');
        expect(body.result.structuredContent.written, c.name).toBe(false);
        expect(body.result.structuredContent.tool, c.name).toBe(c.name);
        expect(body.result.structuredContent.idempotency_key, c.name).toBe(c.args.idempotency_key);
        expect(body.result.structuredContent.arguments, c.name).toBeDefined();
        expect(body.result._meta?.ui?.resourceUri, c.name).toBe('ui://write-confirm');
        await c.check();
        const audit = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM mcp_audit_log WHERE idempotency_key = ?'
        ).bind(c.args.idempotency_key as string).first<{ count: number }>();
        expect(audit?.count, c.name).toBe(0);
      }
    });

    it('write-инструменты в tools/list ссылаются на ui://write-confirm', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 210, method: 'tools/list', params: {} })
      });
      const body: any = await (await mcpApp.fetch(req, typedEnv, { props: { scopes: ['write'], clientId } } as any)).json();
      for (const name of ['operation_add', 'balance_correct', 'planned_item_add', 'transfer_add', 'fx_rate_set', 'fx_rate_delete']) {
        const tool = body.result.tools.find((t: any) => t.name === name);
        expect(tool._meta.ui.resourceUri, name).toBe('ui://write-confirm');
      }
    });

    it('resources/list с write отдаёт ui://write-confirm; resources/read — HTML confirm', async () => {
      const listReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 211, method: 'resources/list', params: {} })
      });
      const listBody: any = await (await mcpApp.fetch(listReq, typedEnv, { props: { scopes: ['write'], clientId } } as any)).json();
      const resource = listBody.result.resources.find((r: any) => r.uri === 'ui://write-confirm');
      expect(resource).toBeDefined();
      expect(resource.mimeType).toBe('text/html;profile=mcp-app');

      const readReq = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 212, method: 'resources/read', params: { uri: 'ui://write-confirm' } })
      });
      const readBody: any = await (await mcpApp.fetch(readReq, typedEnv, { props: { scopes: ['write'], clientId } } as any)).json();
      const html = readBody.result.contents[0].text as string;
      expect(html).toContain('write-confirm');
      expect(html).toContain('Подтвердить');
      expect(html).toContain('requestState');
      expect(html).toContain("sendRequest('tools/call'");
      expect(html).toContain("sendNotification('ui/notifications/initialized'");
      expect(html).toContain("ui/notifications/tool-result");
    });
  });

  describe('#325: журнал tools/call (read + MRTR)', () => {
    it('accounts_list пишет audit success без idempotency_key', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3251,
          method: 'tools/call',
          params: { name: 'accounts_list', arguments: {} }
        })
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.result.isError).toBeUndefined();

      const row = await env.DB.prepare(
        'SELECT tool_name, status, idempotency_key, result_summary FROM mcp_audit_log WHERE tool_name = ?'
      ).bind('accounts_list').first<{
        tool_name: string;
        status: string;
        idempotency_key: string | null;
        result_summary: string | null;
      }>();
      expect(row?.status).toBe('success');
      expect(row?.idempotency_key).toBeNull();
      expect(row?.result_summary).toBeTruthy();
    });

    it('read без scope пишет audit error', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3252,
          method: 'tools/call',
          params: { name: 'accounts_list', arguments: {} }
        })
      });
      await mcpApp.fetch(req, typedEnv, { props: { scopes: ['write'], clientId } } as any);

      const row = await env.DB.prepare(
        'SELECT status, idempotency_key FROM mcp_audit_log WHERE tool_name = ?'
      ).bind('accounts_list').first<{ status: string; idempotency_key: string | null }>();
      expect(row?.status).toBe('error');
      expect(row?.idempotency_key).toBeNull();
    });

    it('fx_rate_set без requestState пишет audit pending без ключа и не трогает курс', async () => {
      await env.DB.prepare(
        `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('RSD', 9800000, '2026-08-12T14:34:29Z')`
      ).run();

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3253,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: { auto_confirm: false, code: 'RSD', rate: 0.009868, idempotency_key: 'idem-325-pending' }
          }
        })
      });
      const body: any = await (await mcpApp.fetch(req, typedEnv, { props: { scopes: ['write'], clientId } } as any)).json();
      expect(body.result.structuredContent.resultType).toBe('input_required');

      const fx = await env.DB.prepare('SELECT rate_e9 FROM fx_rates WHERE code = ?')
        .bind('RSD')
        .first<{ rate_e9: number }>();
      expect(fx?.rate_e9).toBe(9_800_000);

      const byKey = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM mcp_audit_log WHERE idempotency_key = ?'
      ).bind('idem-325-pending').first<{ count: number }>();
      expect(byKey?.count).toBe(0);

      const pending = await env.DB.prepare(
        'SELECT status, idempotency_key, result_summary FROM mcp_audit_log WHERE tool_name = ?'
      ).bind('fx_rate_set').first<{
        status: string;
        idempotency_key: string | null;
        result_summary: string | null;
      }>();
      expect(pending?.status).toBe('pending');
      expect(pending?.idempotency_key).toBeNull();
      expect(pending?.result_summary).toMatch(/запись не выполнена/i);
    });
  });

  describe('#334: CallToolResult 2025-11-25 и annotations', () => {
    it('первый write: сверху только ключи CallToolResult, MRTR в structuredContent', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3341,
          method: 'tools/call',
          params: {
            name: 'fx_rate_set',
            arguments: { auto_confirm: false, code: 'RSD', rate: 0.009868, idempotency_key: 'idem-334-shape' }
          }
        })
      });
      const body: any = await (await mcpApp.fetch(req, typedEnv, { props: { scopes: ['write'], clientId } } as any)).json();
      expect(Object.keys(body.result).sort()).toEqual(['_meta', 'content', 'structuredContent'].sort());
      expect(body.result.resultType).toBeUndefined();
      expect(body.result.requestState).toBeUndefined();
      expect(body.result.structuredContent.resultType).toBe('input_required');
      expect(body.result.structuredContent.requestState).toBeDefined();
      expect(body.result.structuredContent.written).toBe(false);
    });

    it('tools/list: у каждого инструмента явные annotations', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3342, method: 'tools/list', params: {} })
      });
      const body: any = await (await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any)).json();
      expect(body.result.tools.length).toBe(27);
      for (const tool of body.result.tools) {
        expect(tool.annotations, tool.name).toBeDefined();
        expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
        expect(typeof tool.annotations.destructiveHint, tool.name).toBe('boolean');
        expect(typeof tool.annotations.idempotentHint, tool.name).toBe('boolean');
        expect(typeof tool.annotations.openWorldHint, tool.name).toBe('boolean');
      }
      const read = body.result.tools.find((t: any) => t.name === 'fx_rates_list');
      expect(read.annotations.readOnlyHint).toBe(true);
      expect(read.annotations.destructiveHint).toBe(false);
      const set = body.result.tools.find((t: any) => t.name === 'fx_rate_set');
      expect(set.annotations.readOnlyHint).toBe(false);
      expect(set.annotations.destructiveHint).toBe(false);
      expect(set.description).toMatch(/не перевод денег/i);
      const del = body.result.tools.find((t: any) => t.name === 'fx_rate_delete');
      expect(del.annotations.destructiveHint).toBe(true);
      const reset = body.result.tools.find((t: any) => t.name === 'data_reset');
      expect(reset.annotations.destructiveHint).toBe(true);
    });
  });

  describe('#338: transfer_add (MCP переводы между счетами, MRTR)', () => {
    let fromId: number;
    let toId: number;

    beforeEach(async () => {
      const from = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('Основной EUR', 'EUR', 100000, 100, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z')
         RETURNING id`
      ).first<{ id: number }>();
      fromId = from!.id;
      const to = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('Наличные RSD', 'RSD', 20000, 101, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z')
         RETURNING id`
      ).first<{ id: number }>();
      toId = to!.id;
    });

    it('требует idempotency_key', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3380,
          method: 'tools/call',
          params: {
            name: 'transfer_add',
            arguments: {
              date: '2026-08-15',
              from_account_id: fromId,
              to_account_id: toId,
              from_amount_minor: 5000,
              to_amount_minor: 5000,
              item: 'Перевод'
            }
          }
        })
      });
      const ctx = { props: { scopes: ['write'], clientId } };
      const body: any = await (await mcpApp.fetch(req, typedEnv, ctx as any)).json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('idempotency_key');
    });

    it('отклоняет некорректные параметры до запроса подтверждения (MRTR шаг 1)', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3381,
          method: 'tools/call',
          params: {
            name: 'transfer_add',
            arguments: {
              date: '2026-08-15',
              from_account_id: fromId,
              to_account_id: fromId, // тот же счёт!
              from_amount_minor: 5000,
              to_amount_minor: 5000,
              item: 'Перевод',
              idempotency_key: 'idem-338-same'
            }
          }
        })
      });
      const ctx = { props: { scopes: ['write'], clientId } };
      const body: any = await (await mcpApp.fetch(req, typedEnv, ctx as any)).json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('должны отличаться');
      expect(body.result.resultType).toBeUndefined();
    });

    it('шаг 1 input_required не пишет в БД; шаг 2 создаёт transfer + 2 операции source=agent; каскад при удалении', async () => {
      const idempotencyKey = 'idem-338-transfer-1';

      // Шаг 1: MRTR input_required
      const req1 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3382,
          method: 'tools/call',
          params: {
            name: 'transfer_add',
            arguments: {
              date: '2026-08-15',
              from_account_id: fromId,
              to_account_id: toId,
              from_amount_minor: 5000,
              to_amount_minor: 5000,
              item: 'Перевод на наличные',
              category: 'Переводы',
              idempotency_key: idempotencyKey
            }
          }
        })
      });
      const ctx = { props: { scopes: ['read', 'write'], clientId } };
      const res1 = await mcpApp.fetch(req1, typedEnv, ctx as any);
      const body1: any = await res1.json();

      expect(body1.result.structuredContent.resultType).toBe('input_required');
      expect(body1.result.structuredContent.written).toBe(false);
      expect(body1.result.structuredContent.requestState).toBeDefined();
      expect(body1.result.content[0].text).toContain('Подтвердите перевод');

      // БД ещё пуста
      const countBefore = await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>();
      expect(countBefore?.count).toBe(0);
      const transferBefore = await env.DB.prepare('SELECT COUNT(*) as count FROM transfers').first<{ count: number }>();
      expect(transferBefore?.count).toBe(0);

      // Шаг 2: подтверждение
      const req2 = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3383,
          method: 'tools/call',
          params: {
            name: 'transfer_add',
            arguments: {
              idempotency_key: idempotencyKey,
              requestState: body1.result.structuredContent.requestState
            }
          }
        })
      });
      const res2 = await mcpApp.fetch(req2, typedEnv, ctx as any);
      const body2: any = await res2.json();

      expect(body2.result.isError).toBeUndefined();
      expect(body2.result.structuredContent.resultType).toBe('complete');
      expect(body2.result.structuredContent.written).toBe(true);
      expect(body2.result.structuredContent.transfer).toBeDefined();
      const transfer = body2.result.structuredContent.transfer;
      expect(transfer.from_operation.kind).toBe('transfer_out');
      expect(transfer.from_operation.amount_minor).toBe(-5000);
      expect(transfer.from_operation.source).toBe('agent');
      expect(transfer.to_operation.kind).toBe('transfer_in');
      expect(transfer.to_operation.amount_minor).toBe(5000);
      expect(transfer.to_operation.source).toBe('agent');

      // В БД: 1 transfer + 2 операции
      const tCount = await env.DB.prepare('SELECT COUNT(*) as count FROM transfers').first<{ count: number }>();
      expect(tCount?.count).toBe(1);
      const ops = await env.DB.prepare('SELECT * FROM operations ORDER BY kind').all<any>();
      expect(ops.results.length).toBe(2);
      const outOp = ops.results.find((o: any) => o.kind === 'transfer_out');
      const inOp = ops.results.find((o: any) => o.kind === 'transfer_in');
      expect(outOp.source).toBe('agent');
      expect(inOp.source).toBe('agent');
      expect(outOp.transfer_id).toBe(inOp.transfer_id);
      expect(outOp.transfer_id).toBe(transfer.id);

      // Балансы изменились
      const fromBal = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(fromId).first<{ balance_minor: number }>();
      const toBal = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(toId).first<{ balance_minor: number }>();
      expect(fromBal?.balance_minor).toBe(95000); // 100000 - 5000
      expect(toBal?.balance_minor).toBe(25000); // 20000 + 5000

      // Аудит success
      const audit = await env.DB.prepare('SELECT status, tool_name FROM mcp_audit_log WHERE idempotency_key = ?')
        .bind(idempotencyKey).first<{ status: string; tool_name: string }>();
      expect(audit?.status).toBe('success');
      expect(audit?.tool_name).toBe('transfer_add');

      // Каскад: удаление transfer удаляет обе операции
      await env.DB.prepare('DELETE FROM transfers WHERE id = ?').bind(transfer.id).run();
      const opsAfter = await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>();
      expect(opsAfter?.count).toBe(0);
    });

    it('повторный вызов с тем же idempotency_key не дублирует запись (идемпотентность)', async () => {
      const idempotencyKey = 'idem-338-transfer-idem';

      const buildCall = (withState?: string) => new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3384,
          method: 'tools/call',
          params: {
            name: 'transfer_add',
            arguments: withState
              ? { idempotency_key: idempotencyKey, requestState: withState }
              : {
                  date: '2026-08-15',
                  from_account_id: fromId,
                  to_account_id: toId,
                  from_amount_minor: 3000,
                  to_amount_minor: 3000,
                  item: 'Перевод повтор',
                  idempotency_key: idempotencyKey
                }
          }
        })
      });

      const ctx = { props: { scopes: ['read', 'write'], clientId } };
      const body1: any = await (await mcpApp.fetch(buildCall(), typedEnv, ctx as any)).json();
      const body2: any = await (await mcpApp.fetch(buildCall(body1.result.structuredContent.requestState), typedEnv, ctx as any)).json();
      expect(body2.result.structuredContent.written).toBe(true);

      // Третий вызов без state — должен вернуть закэшированный success, не создавать новых
      const body3: any = await (await mcpApp.fetch(buildCall(), typedEnv, ctx as any)).json();
      expect(body3.result.structuredContent.written).toBe(true);
      expect(body3.result.structuredContent.resultType).toBe('complete');

      const tCount = await env.DB.prepare('SELECT COUNT(*) as count FROM transfers').first<{ count: number }>();
      expect(tCount?.count).toBe(1);
      const opCount = await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>();
      expect(opCount?.count).toBe(2);
    });
  });

  describe('#458: Mcp-Method и Mcp-Name HTTP routing headers (MCP 2026-07-28)', () => {
    it('обрабатывает tools/list через заголовок Mcp-Method', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4581 }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
      expect(res.status).toBe(200);
      expect(res.headers.get('Mcp-Method')).toBe('tools/list');
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.result.tools)).toBe(true);
      expect(body.result.tools.length).toBeGreaterThan(0);
    });

    it('обрабатывает resources/list через заголовок Mcp-Method', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'resources/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4582 }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
      expect(res.status).toBe(200);
      expect(res.headers.get('Mcp-Method')).toBe('resources/list');
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.result.resources)).toBe(true);
      expect(body.result.resources.some((r: any) => r.uri === 'ui://pulse')).toBe(true);
    });

    it('обрабатывает resources/read через заголовки Mcp-Method и Mcp-Name', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'resources/read',
          'Mcp-Name': 'ui://pulse',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4583 }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any);
      expect(res.status).toBe(200);
      expect(res.headers.get('Mcp-Method')).toBe('resources/read');
      expect(res.headers.get('Mcp-Name')).toBe('ui://pulse');
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.contents[0].uri).toBe('ui://pulse');
    });

    it('обрабатывает tools/call чтения через Mcp-Method и Mcp-Name', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'accounts_list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4584,
          params: { arguments: {} },
        }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read'], clientId } } as any);
      expect(res.status).toBe(200);
      expect(res.headers.get('Mcp-Method')).toBe('tools/call');
      expect(res.headers.get('Mcp-Name')).toBe('accounts_list');
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.content[0].text).toBeTruthy();
    });

    it('обрабатывает tools/call записи с auto_confirm через Mcp-Method и Mcp-Name', async () => {
      const accountRes = await env.DB.prepare(
        "INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at) VALUES ('Header Acc', 'EUR', 10000, 1, 0, 'Alex', 'ES', '2026-09-02T12:00:00Z') RETURNING id"
      ).first<{ id: number }>();
      const accountId = accountRes!.id;

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'operation_add',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4585,
          params: {
            arguments: {
              account_id: accountId,
              date: '2026-09-02',
              kind: 'expense',
              amount_minor: -1500,
              store: 'Header Shop',
              item: 'Header Item',
              category: 'Other',
              auto_confirm: true,
              idempotency_key: 'idem-458-header-write',
            },
          },
        }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['write'], clientId } } as any);
      expect(res.status).toBe(200);
      expect(res.headers.get('Mcp-Method')).toBe('tools/call');
      expect(res.headers.get('Mcp-Name')).toBe('operation_add');
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.structuredContent.written).toBe(true);

      const audit = await env.DB.prepare('SELECT status, tool_name FROM mcp_audit_log WHERE idempotency_key = ?')
        .bind('idem-458-header-write').first<{ status: string; tool_name: string }>();
      expect(audit?.status).toBe('success');
      expect(audit?.tool_name).toBe('operation_add');
    });

    it('отдаёт ошибку -32601 при неизвестном инструменте через Mcp-Name', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'non_existent_tool',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4586 }),
      });
      const res = await mcpApp.fetch(req, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
    });
  });
});
