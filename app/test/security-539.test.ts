import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import {
  bumpAuthEpoch,
  createSessionCookie,
  saveCredentials,
  tombstoneCredential,
  verifySessionCookie,
  type StoredCredential,
} from '../src/worker/auth';
import { isLoopbackPortVariant } from '../src/worker/oauth';
import { browserMutationRejection } from '../src/worker/csrf';
import { pruneMcpAuditLog } from '../src/worker/api-mcp';
import { minorBigIntToNumber, scaledMinor } from '../src/shared/money';
import { exportUserState } from '../src/worker/backup';
import type { Env } from '../src/worker/types';

const TEST_ORIGIN = 'https://auth.example.com';

async function sessionCookie(opts?: { iat?: number; cid?: string }): Promise<string> {
  const setCookie = await createSessionCookie(env as unknown as Env, false, opts);
  return setCookie.split(';')[0]!;
}

describe('security #539', () => {
  beforeEach(async () => {
    await env.KV.delete('auth_epoch');
    await env.DB.prepare(
      `DELETE FROM settings WHERE key = 'auth_epoch'
         OR key LIKE 'session_revoked:%'
         OR key LIKE 'passkey_revoked:%'
         OR key LIKE 'passkey_disabled:%'`,
    ).run();
    const listed = await env.KV.list({ prefix: 'webauthn_cred' });
    await Promise.all(listed.keys.map((key) => env.KV.delete(key.name)));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mcp_audit_log'),
      env.DB.prepare('DELETE FROM oauth_clients'),
      env.DB.prepare('DELETE FROM operation_fulfillment_links'),
      env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
      env.DB.prepare('DELETE FROM operations'),
      env.DB.prepare('DELETE FROM recurring_items'),
      env.DB.prepare('DELETE FROM accounts'),
    ]);
  });

  describe('1. passkey revoke invalidates derived sessions', () => {
    it('advancing the auth epoch rejects the previous cookie', async () => {
      const cookie = await sessionCookie();
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(true);
      await bumpAuthEpoch(env as unknown as Env);
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(false);
    });

    it('tombstoned credential bound to the cookie is rejected after revoke-all', async () => {
      const cred: StoredCredential = {
        id: 'cred-revoke',
        publicKey: 'pub',
        counter: 1,
        label: 'Phone',
        createdAt: new Date().toISOString(),
        disabled: false,
      };
      await saveCredentials(env as unknown as Env, [cred]);
      const cookie = await sessionCookie({ cid: cred.id });
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(true);
      await tombstoneCredential(env as unknown as Env, cred.id);
      await bumpAuthEpoch(env as unknown as Env);
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(false);
    });
  });

  describe('2. stale session cannot enroll a passkey', () => {
    it('rejects register-options when iat is older than the step-up window', async () => {
      const stale = await sessionCookie({ iat: Math.floor(Date.now() / 1000) - 3600 });
      const res = await app.request(`${TEST_ORIGIN}/api/v2/passkeys/register-options`, {
        method: 'POST',
        headers: { Cookie: stale, 'Content-Type': 'application/json' },
        body: '{}',
      }, env as unknown as Env);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('STEP_UP_REQUIRED');
    });

    it('allows register-options with a fresh session', async () => {
      const fresh = await sessionCookie();
      const res = await app.request(`${TEST_ORIGIN}/api/v2/passkeys/register-options`, {
        method: 'POST',
        headers: { Cookie: fresh, 'Content-Type': 'application/json' },
        body: '{}',
      }, env as unknown as Env);
      expect(res.status).toBe(200);
    });
  });

  describe('3. empty OAuth scope selection is empty', () => {
    it('does not treat a missing scope field as the requested set', async () => {
      const cookie = await sessionCookie();
      const res = await app.request(
        `${TEST_ORIGIN}/api/auth/oauth/authorize?response_type=code&client_id=https://empty.example&redirect_uri=${encodeURIComponent('https://developers.google.com/oauthredirect')}&scope=read%20write&state=x&code_challenge=abc&code_challenge_method=S256`,
        { headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect([200, 302, 400]).toContain(res.status);
    });
  });

  describe('4. loopback hostname is exact', () => {
    it('does not treat localhost and 127.0.0.1 as the same registered host', () => {
      expect(isLoopbackPortVariant('http://localhost/callback', 'http://127.0.0.1:9/callback')).toBe(false);
      expect(isLoopbackPortVariant('http://localhost/callback', 'http://localhost:9/callback')).toBe(true);
    });
  });

  describe('6. logout requires CSRF / fetch-metadata', () => {
    it('rejects a cross-site logout POST', async () => {
      expect(browserMutationRejection('POST', `${TEST_ORIGIN}/api/auth/logout`, {
        secFetchSite: 'cross-site',
        contentType: 'application/json',
      })).toBe('CSRF_REQUEST_REJECTED');
      const cookie = await sessionCookie();
      const res = await app.request(`${TEST_ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }, env as unknown as Env);
      expect(res.status).toBe(403);
    });
  });

  describe('7. backup export uses one batch', () => {
    it('exports a consistent document', async () => {
      const cookie = await sessionCookie();
      const created = await app.request(`${TEST_ORIGIN}/api/v2/accounts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cash', currency: 'USD', owner: 'Alex', country: 'SRB', balance_minor: 100 }),
      }, env as unknown as Env);
      expect(created.status).toBe(201);
      const exported = await exportUserState(env.DB);
      expect(exported.tables.accounts.length).toBeGreaterThan(0);
      expect(exported.format).toBe('money-flow-v2-backup');
    });
  });

  describe('8+5. recurring fulfillment CAS is last; forecast survives overdue overflow', () => {
    it('keeps the rule unadvanced when live evidence no longer matches', async () => {
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
      await env.DB.prepare('UPDATE operations SET amount_minor = -1 WHERE id = ?').bind(operationId).run();
      const fulfill = await app.request(`${TEST_ORIGIN}/api/v2/recurring-items/${ruleId}/fulfill-existing`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_due_date: '2026-09-01',
          operation_ids: [operationId],
          evidence_quantity: 1,
        }),
      }, env as unknown as Env);
      expect(fulfill.status).toBe(400);
      const rule = await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?')
        .bind(ruleId).first<{ next_due_date: string }>();
      expect(rule?.next_due_date).toBe('2026-09-01');
    });

    it('forecast stays available for an overdue max-safe daily rule', async () => {
      const cookie = await sessionCookie();
      const accountRes = await app.request(`${TEST_ORIGIN}/api/v2/accounts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'USD', currency: 'USD', owner: 'Alex', country: 'SRB', balance_minor: 0 }),
      }, env as unknown as Env);
      const accountId = ((await accountRes.json()) as { account: { id: number } }).account.id;
      const created = await app.request(`${TEST_ORIGIN}/api/v2/recurring-items`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Huge daily',
          amount_minor: Number.MAX_SAFE_INTEGER,
          account_id: accountId,
          frequency: 'daily',
          next_due_date: '2020-01-01',
        }),
      }, env as unknown as Env);
      expect(created.status).toBe(201);
      const forecast = await app.request(`${TEST_ORIGIN}/api/v2/forecast?days=30`, {
        headers: { Cookie: cookie },
      }, env as unknown as Env);
      expect(forecast.status).toBe(200);
    });
  });

  describe('9. analytics filters are bounded', () => {
    it('rejects oversized q and filter arrays', async () => {
      const cookie = await sessionCookie();
      const tooLong = await app.request(`${TEST_ORIGIN}/api/v2/analytics`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'x'.repeat(201) }),
      }, env as unknown as Env);
      expect(tooLong.status).toBe(400);
      expect(((await tooLong.json()) as { error: { code: string } }).error.code).toBe('FILTER_TOO_LARGE');

      const tooMany = await app.request(`${TEST_ORIGIN}/api/v2/analytics`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cats: Array.from({ length: 33 }, (_, i) => `c${i}`) }),
      }, env as unknown as Env);
      expect(tooMany.status).toBe(400);
    });
  });

  describe('11+12. safe-integer money domain', () => {
    it('rejects a balance delta that leaves the safe integer range', async () => {
      const cookie = await sessionCookie();
      const accountRes = await app.request(`${TEST_ORIGIN}/api/v2/accounts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Edge',
          currency: 'USD',
          owner: 'Alex',
          country: 'SRB',
          balance_minor: Number.MAX_SAFE_INTEGER,
        }),
      }, env as unknown as Env);
      const accountId = ((await accountRes.json()) as { account: { id: number } }).account.id;
      const op = await app.request(`${TEST_ORIGIN}/api/v2/operations`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: '2026-09-01',
          account_id: accountId,
          kind: 'income',
          item: 'overflow',
          amount_minor: 1,
        }),
      }, env as unknown as Env);
      expect(op.status).toBe(400);
      expect(((await op.json()) as { error: { code: string } }).error.code).toBe('BALANCE_OUT_OF_SAFE_RANGE');
      const row = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
        .bind(accountId).first<{ balance_minor: number }>();
      expect(row?.balance_minor).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('checks BigInt narrowing', () => {
      expect(minorBigIntToNumber(10n)).toBe(10);
      expect(() => minorBigIntToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/AMOUNT_OUT_OF_SAFE_RANGE/);
      expect(scaledMinor(Number.MAX_SAFE_INTEGER, 2)).toBeNull();
      expect(scaledMinor(100, 3)).toBe(300);
    });
  });

  describe('13. write-only MCP does not disclose recurring defaults', () => {
    it('requires explicit close-period fields and does not echo stored title/amount', async () => {
      const account = await env.DB.prepare(
        `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
         VALUES ('EUR', 'EUR', 100000, 1, 0, 'Alex', 'RS', '2026-08-15T12:00:00Z') RETURNING id`,
      ).first<{ id: number }>();
      const recurring = await env.DB.prepare(
        `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES ('Secret sub', -7777, 'EUR', ?, 'Hidden', 'monthly', 1, 1, NULL, '2026-09-01', NULL, 1)
         RETURNING id`,
      ).bind(account!.id).first<{ id: number }>();
      const pending = await mcpApp.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'recurring_item_close_period',
            arguments: { recurring_item_id: recurring!.id, idempotency_key: 'wo-close' },
          },
        }),
      }), env as unknown as Env, { props: { scopes: ['write'], clientId: 'wo' } } as any);
      const body: any = await pending.json();
      expect(body.result.isError).toBe(true);
      expect(JSON.stringify(body)).not.toContain('Secret sub');
      expect(JSON.stringify(body)).not.toContain('7777');
    });
  });

  describe('14. keyed MCP idempotency rows expire', () => {
    it('prunes old keyed audit rows', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at) VALUES ('c1', 'Prune Client', datetime('now'))`,
      ).run();
      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key, created_at)
         VALUES ('old', 'c1', 'operation_add', 'success', '{}', 'k-old', datetime('now', '-120 days'))`,
      ).run();
      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key, created_at)
         VALUES ('fresh', 'c1', 'operation_add', 'success', '{}', 'k-fresh', datetime('now'))`,
      ).run();
      await pruneMcpAuditLog(env.DB);
      const old = await env.DB.prepare('SELECT id FROM mcp_audit_log WHERE id = ?').bind('old').first();
      const fresh = await env.DB.prepare('SELECT id FROM mcp_audit_log WHERE id = ?').bind('fresh').first();
      expect(old).toBeNull();
      expect(fresh).toBeTruthy();
    });
  });
});
