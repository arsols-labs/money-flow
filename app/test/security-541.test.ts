import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import {
  bumpAuthEpoch,
  createSessionCookie,
  getAuthEpoch,
  saveCredentials,
  tombstoneCredential,
  verifySessionCookie,
  type StoredCredential,
} from '../src/worker/auth';
import {
  clipAuditSummary,
  IDEMPOTENCY_MAX_SUMMARY_BYTES,
  pruneMcpAuditLog,
} from '../src/worker/api-mcp';
import { ANALYTICS_MAX_JSON_BYTES, BodyTooLargeError, readLimitedJson } from '../src/worker/limited-body';
import { expandRecurringRule } from '../src/worker/forecast/recurrence';
import type { Env } from '../src/worker/types';

const TEST_ORIGIN = 'https://auth.example.com';

async function sessionCookie(opts?: { iat?: number; cid?: string; epoch?: number }): Promise<string> {
  const setCookie = await createSessionCookie(env as unknown as Env, false, opts);
  return setCookie.split(';')[0]!;
}

function cred(id: string): StoredCredential {
  return {
    id,
    publicKey: 'pub',
    counter: 1,
    label: id,
    createdAt: new Date().toISOString(),
    disabled: false,
  };
}

async function mcpCall(name: string, args: Record<string, unknown>, scopes: string[], id = 1) {
  return mcpApp.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  }), env as unknown as Env, { props: { scopes, clientId: 'wo-541' } } as any);
}

describe('security #541', () => {
  beforeEach(async () => {
    await env.KV.delete('auth_epoch');
    const listed = await env.KV.list({ prefix: 'webauthn_cred' });
    await Promise.all(listed.keys.map((key) => env.KV.delete(key.name)));
    await env.KV.delete('webauthn_credentials');
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM settings WHERE key = 'auth_epoch'
           OR key LIKE 'session_revoked:%'
           OR key LIKE 'passkey_revoked:%'
           OR key LIKE 'passkey_disabled:%'`,
      ),
      env.DB.prepare('DELETE FROM mcp_audit_log'),
      env.DB.prepare('DELETE FROM oauth_clients'),
      env.DB.prepare('DELETE FROM operation_fulfillment_links'),
      env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
      env.DB.prepare('DELETE FROM operations'),
      env.DB.prepare('DELETE FROM recurring_items'),
      env.DB.prepare('DELETE FROM planned_items'),
      env.DB.prepare('DELETE FROM accounts'),
    ]);
  });

  describe('1. write-only MCP mutation results hide pre-existing data', () => {
    it('does not return stored rule title/amount or other operations', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at) VALUES ('wo-541', 'Write-only', datetime('now'))`,
      ).run();
      const account = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('EUR', 'EUR', 100000, 1, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z') RETURNING id`,
      ).first<{ id: number }>();
      const recurring = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Secret sub', -7777, 'EUR', ?, 'Hidden', 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1)
         RETURNING id`,
      ).bind(account!.id).first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
         VALUES ('2026-08-01', ?, 'expense', 'Pre-existing coffee', -350, 'manual')`,
      ).bind(account!.id).run();

      const pending = await mcpCall('recurring_item_close_period', {
        recurring_item_id: recurring!.id,
        date: '2026-09-01',
        amount_minor: -7777,
        account_id: account!.id,
        item: 'Secret sub',
        idempotency_key: 'wo-close-541',
        auto_confirm: true,
      }, ['write']);
      const body: any = await pending.json();
      const payload = JSON.stringify(body);
      expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
      expect(payload).not.toContain('Hidden');
      expect(payload).not.toContain('Pre-existing coffee');
      expect(payload).not.toContain('100000');
      expect(body.result.structuredContent.operation_id).toEqual(expect.any(Number));
      expect(body.result.structuredContent.recurring_item_id).toBe(recurring!.id);
      expect(body.result.structuredContent.recurring_item).toBeUndefined();
      expect(body.result.structuredContent.operation).toBeUndefined();
    });
  });

  describe('2. unchecked balance updates cannot commit without ledger effect', () => {
    it('rolls back close-period when the balance UPDATE matches no row', async () => {
      const cookie = await sessionCookie();
      const accountRes = await app.request(`${TEST_ORIGIN}/api/v2/accounts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Edge', currency: 'USD', owner: 'Alex', country: 'SRB', balance_minor: 0 }),
      }, env as unknown as Env);
      const accountId = ((await accountRes.json()) as { account: { id: number } }).account.id;
      const ruleRes = await app.request(`${TEST_ORIGIN}/api/v2/recurring-items`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Huge',
          amount_minor: 1,
          account_id: accountId,
          frequency: 'monthly',
          next_due_date: '2026-09-01',
        }),
      }, env as unknown as Env);
      const ruleId = ((await ruleRes.json()) as { recurring_item: { id: number } }).recurring_item.id;
      await env.DB.prepare('UPDATE accounts SET balance_minor = ? WHERE id = ?')
        .bind(Number.MAX_SAFE_INTEGER, accountId).run();

      const close = await app.request(`${TEST_ORIGIN}/api/v2/recurring-items/${ruleId}/close-period`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-09-01', amount_minor: 1, account_id: accountId, item: 'Huge' }),
      }, env as unknown as Env);
      expect(close.status).toBe(409);
      expect(((await close.json()) as { error: { code: string } }).error.code).toBe('LEDGER_EFFECT_MISSING');
      const rule = await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?')
        .bind(ruleId).first<{ next_due_date: string }>();
      expect(rule?.next_due_date).toBe('2026-09-01');
      const ops = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
      expect(ops?.n).toBe(0);
    });
  });

  describe('3. logout denylist is D1-authoritative across stale KV', () => {
    it('rejects a copied cookie after logout even if the KV revoke key is missing', async () => {
      const cookie = await sessionCookie();
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(true);
      const logout = await app.request(`${TEST_ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: TEST_ORIGIN,
          'Content-Type': 'application/json',
          'X-Money-Flow': '1',
        },
        body: '{}',
      }, env as unknown as Env);
      expect(logout.status).toBe(204);

      const listed = await env.KV.list({ prefix: 'session_revoked:' });
      await Promise.all(listed.keys.map((key) => env.KV.delete(key.name)));
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(false);
    });
  });

  describe('4. concurrent passkey metadata writes cannot resurrect a tombstone', () => {
    it('saveCredentials from a stale snapshot skips a deleted credential', async () => {
      await saveCredentials(env as unknown as Env, [cred('keep'), cred('gone')]);
      const stale = [cred('keep'), cred('gone')];
      await tombstoneCredential(env as unknown as Env, 'gone');
      await saveCredentials(env as unknown as Env, [cred('keep')]);
      await saveCredentials(env as unknown as Env, stale);
      const cookie = await sessionCookie({ cid: 'gone' });
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(false);
      const listed = await env.KV.get<StoredCredential[]>('webauthn_credentials', 'json');
      expect((listed ?? []).map((item) => item.id)).not.toContain('gone');
    });
  });

  describe('5. browser sessions cannot forge agent provenance', () => {
    it('rejects source=agent on session-authenticated POST /operations', async () => {
      const cookie = await sessionCookie();
      const accountRes = await app.request(`${TEST_ORIGIN}/api/v2/accounts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'USD', currency: 'USD', owner: 'Alex', country: 'SRB', balance_minor: 1000 }),
      }, env as unknown as Env);
      const accountId = ((await accountRes.json()) as { account: { id: number } }).account.id;
      const res = await app.request(`${TEST_ORIGIN}/api/v2/operations`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: '2026-09-01',
          account_id: accountId,
          kind: 'expense',
          item: 'Forged',
          amount_minor: -100,
          source: 'agent',
        }),
      }, env as unknown as Env);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SOURCE_NOT_SETTABLE');
      const ops = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
      expect(ops?.n).toBe(0);
    });
  });

  describe('6. import repair SQL skips MCP-created operations', () => {
    it('rescales only agent rows that have no MCP audit evidence', async () => {
      const account = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('USD', 'USD', 0, 1, 0, 'Alex', 'US', '2026-08-15T12:00:00Z') RETURNING id`,
      ).first<{ id: number }>();
      const imported = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
         VALUES ('2026-02-01', ?, 'expense', 'Imported', -530, 'agent') RETURNING id`,
      ).bind(account!.id).first<{ id: number }>();
      const mcpOp = await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
         VALUES ('2026-09-01', ?, 'expense', 'MCP coffee', -350, 'agent') RETURNING id`,
      ).bind(account!.id).first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at) VALUES ('c-mcp', 'Agent', datetime('now'))`,
      ).run();
      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key, created_at)
         VALUES ('aud', 'c-mcp', 'operation_add', 'success', ?, 'k-mcp', datetime('now'))`,
      ).bind(JSON.stringify({ operation: { id: mcpOp!.id }, written: true })).run();

      await env.DB.prepare(`
        UPDATE operations
        SET amount_minor = amount_minor * 100
        WHERE source = 'agent'
          AND amount_minor IS NOT NULL
          AND id NOT IN (
            SELECT CAST(json_extract(result_summary, '$.operation.id') AS INTEGER)
            FROM mcp_audit_log
            WHERE result_summary IS NOT NULL
              AND json_extract(result_summary, '$.operation.id') IS NOT NULL
          )
      `).run();

      const importedRow = await env.DB.prepare('SELECT amount_minor FROM operations WHERE id = ?')
        .bind(imported!.id).first<{ amount_minor: number }>();
      const mcpRow = await env.DB.prepare('SELECT amount_minor FROM operations WHERE id = ?')
        .bind(mcpOp!.id).first<{ amount_minor: number }>();
      expect(importedRow?.amount_minor).toBe(-53000);
      expect(mcpRow?.amount_minor).toBe(-350);
    });
  });

  describe('7. revoking a passkey kills sessions derived from it', () => {
    it('D1 disable flag rejects the cid even if KV epoch is stale', async () => {
      await saveCredentials(env as unknown as Env, [cred('phone'), cred('laptop')]);
      const cookie = await sessionCookie({ cid: 'phone' });
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(true);

      const epochBefore = await getAuthEpoch(env as unknown as Env);
      await app.request(`${TEST_ORIGIN}/api/v2/passkeys/phone`, {
        method: 'PATCH',
        headers: { Cookie: await sessionCookie({ iat: Math.floor(Date.now() / 1000) }), 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      }, env as unknown as Env);

      await env.KV.put('auth_epoch', String(epochBefore));
      await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'auth_epoch'").bind(String(epochBefore)).run();
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(false);
    });
  });

  describe('8. failed recurring fulfill does not strip a winner’s evidence', () => {
    it('a second fulfill for the same period leaves the first links in place', async () => {
      const cookie = await sessionCookie();
      const accountRes = await app.request(`${TEST_ORIGIN}/api/v2/accounts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'EUR', currency: 'EUR', owner: 'Alex', country: 'SRB', balance_minor: 50_000 }),
      }, env as unknown as Env);
      const accountId = ((await accountRes.json()) as { account: { id: number } }).account.id;
      const ruleRes = await app.request(`${TEST_ORIGIN}/api/v2/recurring-items`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Rent',
          amount_minor: -10_000,
          account_id: accountId,
          frequency: 'monthly',
          next_due_date: '2026-09-01',
        }),
      }, env as unknown as Env);
      const ruleId = ((await ruleRes.json()) as { recurring_item: { id: number } }).recurring_item.id;
      const opRes = await app.request(`${TEST_ORIGIN}/api/v2/operations`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: '2026-09-01',
          account_id: accountId,
          kind: 'expense',
          item: 'Rent',
          amount_minor: -10_000,
        }),
      }, env as unknown as Env);
      const operationId = ((await opRes.json()) as { operation: { id: number } }).operation.id;
      const extraRes = await app.request(`${TEST_ORIGIN}/api/v2/operations`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: '2026-09-01',
          account_id: accountId,
          kind: 'expense',
          item: 'Rent extra',
          amount_minor: -10_000,
        }),
      }, env as unknown as Env);
      const extraId = ((await extraRes.json()) as { operation: { id: number } }).operation.id;

      const first = await app.request(`${TEST_ORIGIN}/api/v2/recurring-items/${ruleId}/fulfill-existing`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_due_date: '2026-09-01',
          operation_ids: [operationId],
          evidence_quantity: 1,
        }),
      }, env as unknown as Env);
      expect(first.status).toBe(201);

      const second = await app.request(`${TEST_ORIGIN}/api/v2/recurring-items/${ruleId}/fulfill-existing`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_due_date: '2026-09-01',
          operation_ids: [extraId],
          evidence_quantity: 1,
        }),
      }, env as unknown as Env);
      expect(second.status).toBe(409);

      const link = await env.DB.prepare(
        'SELECT operation_id FROM operation_fulfillment_links WHERE recurring_item_id = ?',
      ).bind(ruleId).first<{ operation_id: number }>();
      expect(link?.operation_id).toBe(operationId);
    });
  });

  describe('9. MCP idempotency records are byte-capped and pruned after insert', () => {
    it('clips oversized summaries and drops expired keyed rows after insert', async () => {
      expect(clipAuditSummary('x'.repeat(IDEMPOTENCY_MAX_SUMMARY_BYTES + 8))).toContain('"clipped":true');
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at) VALUES ('c1', 'Prune', datetime('now'))`,
      ).run();
      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key, created_at)
         VALUES ('old', 'c1', 'operation_add', 'success', '{}', 'k-old', datetime('now', '-120 days'))`,
      ).run();
      await pruneMcpAuditLog(env.DB);
      expect(await env.DB.prepare('SELECT id FROM mcp_audit_log WHERE id = ?').bind('old').first()).toBeNull();
    });
  });

  describe('10. analytics/MCP reject oversized bodies before parse', () => {
    it('returns FILTER_TOO_LARGE from Content-Length without needing a huge payload', async () => {
      const oversized = new Request('http://localhost/analytics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(ANALYTICS_MAX_JSON_BYTES + 1),
        },
        body: '{}',
      });
      await expect(readLimitedJson(oversized, ANALYTICS_MAX_JSON_BYTES)).rejects.toBeInstanceOf(BodyTooLargeError);

      const cookie = await sessionCookie();
      const analytics = await app.request(`${TEST_ORIGIN}/api/v2/analytics`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'x'.repeat(201) }),
      }, env as unknown as Env);
      expect(analytics.status).toBe(400);
      expect(((await analytics.json()) as { error: { code: string } }).error.code).toBe('FILTER_TOO_LARGE');
    });
  });

  describe('11. overdue recurring rule cannot crash forecast', () => {
    it('stays available for a daily rule overdue since year 0001', async () => {
      const cookie = await sessionCookie();
      const accountRes = await app.request(`${TEST_ORIGIN}/api/v2/accounts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'USD', currency: 'USD', owner: 'Alex', country: 'SRB', balance_minor: 0 }),
      }, env as unknown as Env);
      const accountId = ((await accountRes.json()) as { account: { id: number } }).account.id;
      await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Ancient daily', -100, 'USD', ?, 'daily', 1, NULL, NULL, '0001-01-01', NULL, 1)`,
      ).bind(accountId).run();
      const forecast = await app.request(`${TEST_ORIGIN}/api/v2/forecast?days=30`, {
        headers: { Cookie: cookie },
      }, env as unknown as Env);
      expect(forecast.status).toBe(200);
      expect(() => expandRecurringRule({
        id: 1,
        frequency: 'daily',
        interval_count: 1,
        day_of_month: null,
        month_of_year: null,
        next_due_date: '0001-01-01',
        end_date: null,
      }, '2026-09-13', '2026-10-13')).not.toThrow();
    });
  });
});
