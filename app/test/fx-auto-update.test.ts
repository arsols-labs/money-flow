import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleScheduled } from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import { createSessionCookie } from '../src/worker/auth';
import { BACKUP_VERSION, parseBackupDocument, USER_TABLES } from '../src/worker/backup';
import {
  FX_AUTO_UPDATE_SETTING_KEY,
  FX_PROVIDER_ATTRIBUTION_URL,
  FX_PROVIDER_ENDPOINT_BASE,
  FX_PROVIDER_NAME,
  handleScheduledFxRefresh,
  invertProviderRateToE9,
} from '../src/worker/fx-auto-update';
import type { Env } from '../src/worker/types';
import { seedAllTestRules, seedTestCurrencyRules, TEST_CURRENCY_STANDARDS } from './seed-test-rules';

const typedEnv = env as unknown as Env;
const clientId = 'client-fx-auto-update-test';
let cookie: string;
let rpcId = 1;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Cookie: cookie,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  return worker.request(path, init, typedEnv);
}

async function callMcp(name: string, args: Record<string, unknown>, scopes: string[] = ['read', 'write']) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApp.fetch(req, typedEnv, { props: { scopes, clientId } } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

beforeAll(async () => {
  const setCookie = await createSessionCookie(typedEnv, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
  await Promise.all([
    typedEnv.KV.delete('fx_refresh:meta'),
    typedEnv.KV.delete('fx_refresh:cooldown'),
  ]);
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
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare('DELETE FROM rule_entries'),
    env.DB.prepare('DELETE FROM rule_sets'),
    env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(FX_AUTO_UPDATE_SETTING_KEY),
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES
         ('base_currency', 'USD'),
         ('low_balance_threshold_minor', '100000')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ]);
  await seedAllTestRules(env.DB);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'FX Auto Test Client', datetime('now'))`)
    .bind(clientId)
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('invertProviderRateToE9', () => {
  it('inverts integer, decimal, and scientific quotes with deterministic BigInt half-to-even rounding', () => {
    expect(invertProviderRateToE9(0.5)).toBe(2_000_000_000n);
    expect(invertProviderRateToE9(2)).toBe(500_000_000n);
    expect(invertProviderRateToE9(0.8)).toBe(1_250_000_000n);
    expect(invertProviderRateToE9(100)).toBe(10_000_000n);
    expect(invertProviderRateToE9(3)).toBe(333_333_333n);
    expect(invertProviderRateToE9('1e-5')).toBe(100_000_000_000_000n);
    // 1 USD = 8 RSD => 1 USD per unit = 0.125, integer / 8 => 125_000_000
    expect(invertProviderRateToE9('8.00')).toBe(125_000_000n);
  });

  it('rejects non-positive, non-finite, malformed, and overflowing values', () => {
    for (const bad of [0, -1.5, NaN, Infinity, -Infinity, '', '0', '-0.5', 'abc', null, undefined, 1e-8, 1e12]) {
      expect(invertProviderRateToE9(bad), String(bad)).toBeNull();
    }
  });
});

describe('fx_auto_update setting & backup validation', () => {
  it('defaults to disabled in GET /fx-rates and accepts boolean/flag updates via PUT /settings/fx_auto_update', async () => {
    const initial = await (await api('GET', '/api/v2/fx-rates')).json() as any;
    expect(initial.auto_update).toEqual({
      enabled: false,
      provider: 'exchangerate-api',
      provider_name: FX_PROVIDER_NAME,
      provider_url: FX_PROVIDER_ATTRIBUTION_URL,
      schedule_utc: '02:00',
      schedule_hour: 2,
      schedule_timezone: 'UTC',
      schedule_time: '02:00',
      last_run_at: null,
      last_status: null,
      last_error: null,
      last_trigger: null,
    });

    for (const [input, expected] of [
      ['1', '1'],
      ['0', '0'],
      [true, '1'],
      [false, '0'],
      [1, '1'],
      [0, '0'],
      ['true', '1'],
      ['false', '0'],
    ] as const) {
      const putRes = await api('PUT', `/api/v2/settings/${FX_AUTO_UPDATE_SETTING_KEY}`, { value: input });
      expect(putRes.status).toBe(200);
      const body = await putRes.json() as any;
      expect(body.settings[FX_AUTO_UPDATE_SETTING_KEY]).toBe(expected);
      const list = await (await api('GET', '/api/v2/fx-rates')).json() as any;
      expect(list.auto_update.enabled).toBe(expected === '1');
    }

    for (const bad of ['yes', '2', -1, '']) {
      const badRes = await api('PUT', `/api/v2/settings/${FX_AUTO_UPDATE_SETTING_KEY}`, { value: bad });
      expect(badRes.status).toBe(400);
      const errBody = await badRes.json() as any;
      expect(errBody.error.code).toBe('SETTING_BOOLEAN_INVALID');
    }
  });

  it('validates fx_auto_update strictly during backup import parsing', () => {
    const emptyTables = Object.fromEntries(USER_TABLES.map((name) => [name, []]));
    expect(() =>
      parseBackupDocument({
        confirm: true,
        backup: {
          format: 'money-flow-v2-backup',
          version: BACKUP_VERSION,
          exported_at: '2026-11-21T00:00:00Z',
          tables: {
            ...emptyTables,
            settings: [
              { key: 'low_balance_threshold_minor', value: '0' },
              { key: FX_AUTO_UPDATE_SETTING_KEY, value: '1' },
            ],
          },
        },
      }),
    ).not.toThrow();

    expect(() =>
      parseBackupDocument({
        confirm: true,
        backup: {
          format: 'money-flow-v2-backup',
          version: BACKUP_VERSION,
          exported_at: '2026-11-21T00:00:00Z',
          tables: {
            ...emptyTables,
            settings: [
              { key: 'low_balance_threshold_minor', value: '0' },
              { key: FX_AUTO_UPDATE_SETTING_KEY, value: 'invalid' },
            ],
          },
        },
      }),
    ).toThrow(/BACKUP_ROW_INVALID|row/i);
  });
});

describe('POST /api/v2/fx-rates/refresh & scheduled() execution', () => {
  it('returns 422 MISSING_CONFIGURATION when currency_standards or anchor is absent', async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM rule_entries'),
      env.DB.prepare('DELETE FROM rule_sets'),
    ]);
    const { invalidateRulesCache } = await import('../src/worker/rules-store');
    invalidateRulesCache(env.DB);

    const res = await api('POST', '/api/v2/fx-rates/refresh');
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error.code).toBe('MISSING_CONFIGURATION');

    // A 422 configuration error must not start the 60s refresh cooldown.
    await seedTestCurrencyRules(env.DB);
    const afterSeed = await api('POST', '/api/v2/fx-rates/refresh');
    expect(afterSeed.status).toBe(200);
  });

  it('short-circuits without network fetch when there are no non-anchor tracked/in-use currencies', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await api('POST', '/api/v2/fx-rates/refresh');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.updated).toEqual([]);
    expect(body.skipped).toEqual([]);
    expect(body.auto_update.last_status).toBe('ok');
    expect(body.auto_update.last_trigger).toBe('manual');
  });

  it('refreshes tracked & in-use currencies, preserves unsupported custom rates, and enforces 60s cooldown', async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM rule_entries'),
      env.DB.prepare('DELETE FROM rule_sets'),
    ]);
    await seedTestCurrencyRules(env.DB, [
      ...TEST_CURRENCY_STANDARDS,
      { code: 'BTC', minor_digits: 8, symbol: '₿', is_fx_anchor: false },
    ]);
    await env.DB.batch([
      // EUR in fx_rates, RSD via account, BTC custom rate not in ExchangeRate-API
      env.DB.prepare(`INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1000000000, '2026-10-01T00:00:00Z')`),
      env.DB.prepare(`INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('BTC', 95000000000000, '2026-10-01T00:00:00Z')`),
      env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('Card RSD', 'RSD', 500000, 1, 0, 'Alex', 'RS', '2026-10-01T00:00:00Z')`,
      ),
    ]);

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${FX_PROVIDER_ENDPOINT_BASE}/USD`);
      return new Response(
        JSON.stringify({
          result: 'success',
          base_code: 'USD',
          time_last_update_utc: 'Sat, 21 Nov 2026 00:02:01 +0000',
          rates: {
            USD: 1,
            EUR: 0.8,
            RSD: 100,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await api('POST', '/api/v2/fx-rates/refresh');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.anchor_currency).toBe('USD');
    expect(body.updated).toEqual([
      expect.objectContaining({ code: 'EUR', rate_e9: 1250000000, rate: '1.25' }),
      expect.objectContaining({ code: 'RSD', rate_e9: 10000000, rate: '0.01' }),
    ]);
    expect(body.skipped).toEqual([{ code: 'BTC', reason: 'provider_unsupported' }]);
    expect(body.auto_update.last_status).toBe('partial');

    const btcRow = await env.DB.prepare(`SELECT rate_e9, updated_at FROM fx_rates WHERE code = 'BTC'`).first<any>();
    expect(btcRow).toEqual({ rate_e9: 95000000000000, updated_at: '2026-10-01T00:00:00Z' });

    // Second immediate request hits the 60s cooldown
    const blocked = await api('POST', '/api/v2/fx-rates/refresh');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    const blockedBody = await blocked.json() as any;
    expect(blockedBody.error.code).toBe('RATE_LIMITED');
    expect(blockedBody.error.params.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves existing rates and returns 502 FX_PROVIDER_UNAVAILABLE when provider fails, and 422 on unsupported anchor', async () => {
    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1100000000, '2026-10-01T00:00:00Z')`,
    ).run();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })));
    const errRes = await api('POST', '/api/v2/fx-rates/refresh');
    expect(errRes.status).toBe(502);
    expect((await errRes.json() as any).error.code).toBe('FX_PROVIDER_UNAVAILABLE');

    const eurAfter = await env.DB.prepare(`SELECT rate_e9 FROM fx_rates WHERE code = 'EUR'`).first<{ rate_e9: number }>();
    expect(eurAfter?.rate_e9).toBe(1100000000);

    const listAfter = await (await api('GET', '/api/v2/fx-rates')).json() as any;
    expect(listAfter.auto_update.last_status).toBe('error');

    // Clear cooldown to verify unsupported-code 422 mapping
    await typedEnv.KV.delete('fx_refresh:cooldown');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ result: 'error', 'error-type': 'unsupported-code' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const unsupRes = await api('POST', '/api/v2/fx-rates/refresh');
    expect(unsupRes.status).toBe(422);
    expect((await unsupRes.json() as any).error.code).toBe('FX_PROVIDER_UNSUPPORTED_ANCHOR');
  });

  it('handleScheduledFxRefresh is a strict no-op in DEMO_MODE and when disabled, and refreshes when enabled', async () => {
    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1100000000, '2026-10-01T00:00:00Z')`,
    ).run();
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ result: 'success', base_code: 'USD', rates: { EUR: 0.9 } }), { status: 200 }),
    );

    // 1. Disabled by default (setting absent)
    expect(await handleScheduledFxRefresh(typedEnv, { fetcher })).toEqual({ ran: false, reason: 'disabled' });
    expect(fetcher).not.toHaveBeenCalled();

    // 2. DEMO_MODE=1 forces no-op even if fx_auto_update = '1'
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(FX_AUTO_UPDATE_SETTING_KEY).run();
    expect(await handleScheduledFxRefresh({ ...typedEnv, DEMO_MODE: '1' }, { fetcher })).toEqual({
      ran: false,
      reason: 'demo_mode',
    });
    expect(fetcher).not.toHaveBeenCalled();

    // 3. Enabled in non-demo mode -> runs via worker.scheduled waitUntil
    vi.stubGlobal('fetch', fetcher);
    const pending: Promise<unknown>[] = [];
    const mockCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    await handleScheduled({ scheduledTime: Date.UTC(2026, 10, 22, 2, 0, 0), cron: '0 * * * *' } as ScheduledController, typedEnv, mockCtx);
    await Promise.all(pending);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const eur = await env.DB.prepare(`SELECT rate_e9 FROM fx_rates WHERE code = 'EUR'`).first<{ rate_e9: number }>();
    // 10^9 / 0.9 = 1111111111.11... -> 1111111111
    expect(eur?.rate_e9).toBe(1_111_111_111);

    const listAfter = await (await api('GET', '/api/v2/fx-rates')).json() as any;
    expect(listAfter.auto_update.last_status).toBe('ok');
    expect(listAfter.auto_update.last_trigger).toBe('cron');

    // 4. Errors during scheduled run (upstream or D1) are caught cleanly and never throw
    const badFetcher = vi.fn(async () => {
      throw new Error('network down');
    });
    const outcome = await handleScheduledFxRefresh(typedEnv, { fetcher: badFetcher });
    expect(outcome).toMatchObject({ ran: true, ok: false });

    const brokenDb = {
      prepare: () => {
        throw new Error('D1 transient failure');
      },
    } as unknown as D1Database;
    const dbOutcome = await handleScheduledFxRefresh({ ...typedEnv, DB: brokenDb });
    expect(dbOutcome).toMatchObject({ ran: true, ok: false, error: 'D1 transient failure' });
  });

  it('isolates DEMO_MODE KV cooldown and metadata per mf_demo_sid session', async () => {
    const { DEMO_SESSION_COOKIE } = await import('../src/worker/demo-cookie');
    const { buildFxAutoUpdateState, enforceFxRefreshCooldown, refreshFxRatesFromProvider } = await import(
      '../src/worker/fx-auto-update'
    );
    const sidA = 'demo-session-a';
    const sidB = 'demo-session-b';
    await Promise.all([
      typedEnv.KV.delete(`fx_refresh:demo:${sidA}:meta`),
      typedEnv.KV.delete(`fx_refresh:demo:${sidA}:cooldown`),
      typedEnv.KV.delete(`fx_refresh:demo:${sidB}:meta`),
      typedEnv.KV.delete(`fx_refresh:demo:${sidB}:cooldown`),
    ]);

    expect(DEMO_SESSION_COOKIE).toBe('mf_demo_sid');
    expect(await enforceFxRefreshCooldown(typedEnv.KV, sidA)).toEqual({ allowed: true });
    expect(await enforceFxRefreshCooldown(typedEnv.KV, sidA)).toMatchObject({ allowed: false });
    expect(await enforceFxRefreshCooldown(typedEnv.KV, sidB)).toEqual({ allowed: true });

    await refreshFxRatesFromProvider(env.DB, {
      kv: typedEnv.KV,
      demoScopeKey: sidA,
      trigger: 'manual',
    });
    const stateA = await buildFxAutoUpdateState(env.DB, typedEnv.KV, sidA);
    const stateB = await buildFxAutoUpdateState(env.DB, typedEnv.KV, sidB);
    expect(stateA.last_status).toBe('ok');
    expect(stateB.last_status).toBeNull();
  });
});

describe('MCP parity for fx_auto_update and fx_rates_refresh', () => {
  it('supports setting_set for fx_auto_update and returns auto_update in fx_rates_list', async () => {
    const invalidAuto = await callMcp('setting_set', {
      key: FX_AUTO_UPDATE_SETTING_KEY,
      value: 'yes',
      idempotency_key: 'mcp-fx-auto-bad',
    });
    expect(invalidAuto.result.isError).toBe(true);
    expect(invalidAuto.result.structuredContent.error).toContain('fx_auto_update');
    const autoSet = await callMcp('setting_set', {
      key: FX_AUTO_UPDATE_SETTING_KEY,
      value: '1',
      auto_confirm: true,
      idempotency_key: 'mcp-fx-auto-1',
    });
    expect(autoSet.result.isError).not.toBe(true);
    expect(autoSet.result.structuredContent.written).toBe(true);
    expect(autoSet.result.structuredContent.settings[FX_AUTO_UPDATE_SETTING_KEY]).toBe('1');

    const listed = await callMcp('fx_rates_list', {}, ['read']);
    expect(listed.result.structuredContent.auto_update.enabled).toBe(true);
  });

  it('supports two-step MRTR, auto_confirm, read-only refusal, and write-only redaction for fx_rates_refresh', async () => {
    const denied = await callMcp('fx_rates_refresh', { idempotency_key: 'mcp-fx-refresh-ro' }, ['read']);
    expect(denied.error.code).toBe(-32001);

    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1000000000, '2026-10-01T00:00:00Z')`,
    ).run();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ result: 'success', base_code: 'USD', rates: { EUR: 0.85 } }), { status: 200 }),
      ),
    );

    const preview = await callMcp('fx_rates_refresh', { idempotency_key: 'mcp-fx-refresh-mrtr' });
    expect(preview.result.structuredContent.resultType).toBe('input_required');
    expect(preview.result.structuredContent.written).toBe(false);
    expect(preview.result.structuredContent.description).toContain('EUR');

    const confirmed = await callMcp('fx_rates_refresh', {
      idempotency_key: 'mcp-fx-refresh-mrtr',
      requestState: preview.result.structuredContent.requestState,
    });
    expect(confirmed.result.structuredContent.resultType).toBe('complete');
    expect(confirmed.result.structuredContent.written).toBe(true);
    expect(confirmed.result.structuredContent.updated).toHaveLength(1);
    expect(confirmed.result.structuredContent.auto_update.last_trigger).toBe('manual');

    // Clear cooldown to verify write-only redaction + auto_confirm
    await typedEnv.KV.delete('fx_refresh:cooldown');
    const writeOnly = await callMcp(
      'fx_rates_refresh',
      { idempotency_key: 'mcp-fx-refresh-wo', auto_confirm: true },
      ['write'],
    );
    expect(writeOnly.result.structuredContent.written).toBe(true);
    expect(writeOnly.result.structuredContent.updated_count).toBe(1);
    expect(writeOnly.result.structuredContent.rates).toBeUndefined();
  });
});
