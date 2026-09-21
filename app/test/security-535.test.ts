import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import {
  createSessionCookie,
  isAllowedOrigin,
  isAllowedHost,
  isCredentialActive,
  saveCredentials,
  tombstoneCredential,
  verifySessionCookie,
} from '../src/worker/auth';
import { browserMutationRejection, originMatchesRequest } from '../src/worker/csrf';
import { isLoopbackPortVariant, isRegisteredRedirectOrLoopbackVariant } from '../src/worker/oauth';
import { getOAuthHelpers } from '../src/worker/oauth';
import { consumeRateLimit, resetRateLimitMemoryForTests } from '../src/worker/rate-limit';
import { getAnalyticsHtml } from '../src/worker/mcp-analytics-ui';
import { getPulseHtml } from '../src/worker/mcp-pulse-ui';
import { getWriteConfirmHtml } from '../src/worker/mcp-write-confirm-ui';
import { consumeSetupTokenFromSearch } from '../src/shared/setup-token-query';
import type { Env } from '../src/worker/types';

const TEST_ORIGIN = 'https://auth.example.com';

async function sessionCookie(): Promise<string> {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  return setCookie.split(';')[0]!;
}

describe('security #535', () => {
  beforeEach(async () => {
    resetRateLimitMemoryForTests();
    const listed = await env.KV.list({ prefix: 'webauthn_cred' });
    await Promise.all(listed.keys.map((key) => env.KV.delete(key.name)));
  });

  describe('1. transfer delete exactly-once', () => {
    it('second concurrent delete is 404 and does not reverse balances twice', async () => {
      const cookie = await sessionCookie();
      const api = (method: string, path: string, body?: unknown) =>
        app.request(path, {
          method,
          headers: {
            Cookie: cookie,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }, env as unknown as Env);

      await env.DB.batch([
        env.DB.prepare('DELETE FROM operations'),
        env.DB.prepare('DELETE FROM transfers'),
        env.DB.prepare('DELETE FROM accounts'),
      ]);

      const from = await api('POST', '/api/v2/accounts', {
        name: 'From', currency: 'USD', owner: 'Alex', country: 'SRB', balance_minor: 10_000,
      });
      const to = await api('POST', '/api/v2/accounts', {
        name: 'To', currency: 'USD', owner: 'Alex', country: 'SRB', balance_minor: 1_000,
      });
      const fromId = ((await from.json()) as { account: { id: number } }).account.id;
      const toId = ((await to.json()) as { account: { id: number } }).account.id;

      expect(from.status).toBe(201);
      expect(to.status).toBe(201);
      const created = await api('POST', '/api/v2/transfers', {
        date: '2026-09-01',
        from_account_id: fromId,
        to_account_id: toId,
        from_amount_minor: 2500,
        to_amount_minor: 2500,
      });
      if (created.status !== 201) {
        throw new Error(`transfer create ${created.status}: ${await created.text()}`);
      }
      const transferId = ((await created.json()) as { transfer: { id: number } }).transfer.id;

      const [first, second] = await Promise.all([
        api('DELETE', `/api/v2/transfers/${transferId}`),
        api('DELETE', `/api/v2/transfers/${transferId}`),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([204, 404]);

      const accounts = await api('GET', '/api/v2/accounts');
      const list = ((await accounts.json()) as { accounts: Array<{ id: number; balance_minor: number }> }).accounts;
      expect(list.find((a) => a.id === fromId)?.balance_minor).toBe(10_000);
      expect(list.find((a) => a.id === toId)?.balance_minor).toBe(1_000);
    });
  });

  describe('2. MCP widget RPC', () => {
    it('requires parent source, pins origin, and does not postMessage to *', () => {
      for (const html of [getAnalyticsHtml(), getPulseHtml(), getWriteConfirmHtml()]) {
        expect(html).toContain('event.source !== window.parent');
        expect(html).toContain('trustedParentOrigin');
        expect(html).toContain('parentTargetOrigin');
        expect(html).toContain('crypto.randomUUID');
        expect(html).not.toContain("postMessage({ jsonrpc: '2.0', id, method, params }, '*')");
      }
    });
  });

  describe('5. CSRF / origin', () => {
    it('rejects cross-site and foreign Origin mutations', () => {
      expect(originMatchesRequest('https://app.example/x', 'https://app.example/api')).toBe(true);
      expect(originMatchesRequest('http://localhost:9999', 'http://localhost:8787/api')).toBe(false);
      expect(browserMutationRejection('POST', 'https://app.example/api/v2/backup/import', {
        origin: 'https://evil.example',
        contentType: 'application/json',
      })).toBe('CSRF_ORIGIN_INVALID');
      expect(browserMutationRejection('POST', 'https://app.example/api/v2/backup/import', {
        secFetchSite: 'cross-site',
        contentType: 'application/json',
      })).toBe('CSRF_REQUEST_REJECTED');
      expect(browserMutationRejection('POST', 'https://app.example/api/v2/backup/import', {
        origin: 'https://app.example',
        contentType: 'text/plain',
      })).toBe('CONTENT_TYPE_INVALID');
      expect(browserMutationRejection('POST', 'https://app.example/api/v2/data/reset', {
        origin: 'https://evil.example',
        contentType: 'application/json',
      })).toBe('CSRF_ORIGIN_INVALID');
    });

    it('rejects backup import from a foreign Origin', async () => {
      const cookie = await sessionCookie();
      const res = await app.request('https://auth.example.com/api/v2/backup/import', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirm: true, tables: {} }),
      }, env as unknown as Env);
      expect(res.status).toBe(403);
    });
  });

  describe('6. OAuth redirect rebinding', () => {
    it('does not persist an unauthenticated loopback callback onto another client', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env, TEST_ORIGIN);
      const client = await helpers.createClient({
        clientName: 'Victim',
        redirectUris: ['http://127.0.0.1:8080/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const attacker = 'http://127.0.0.1:9999/steal';
      const res = await app.request(
        `${TEST_ORIGIN}/api/auth/oauth/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(attacker)}&scope=read&state=x&code_challenge=abc&code_challenge_method=S256`,
        {},
        env as unknown as Env,
      );
      expect([302, 400]).toContain(res.status);
      const stored = JSON.parse((await env.KV.get(`client:${client.clientId}`)) || '{}') as { redirectUris?: string[] };
      expect(stored.redirectUris || []).not.toContain(attacker);
      expect(isLoopbackPortVariant('http://127.0.0.1:8080/callback', 'http://127.0.0.1:9999/callback')).toBe(true);
      expect(isLoopbackPortVariant('http://localhost/callback', 'http://127.0.0.1:54321/callback')).toBe(false);
      expect(isLoopbackPortVariant('http://127.0.0.1:8080/callback', attacker)).toBe(false);
      expect(isRegisteredRedirectOrLoopbackVariant(['http://127.0.0.1:8080/callback'], attacker)).toBe(false);
    });
  });

  describe('11. localhost CORS', () => {
    it('does not trust localhost Origin on a production edge host', () => {
      expect(isAllowedHost('localhost', 'app.example.com')).toBe(false);
      expect(isAllowedOrigin('http://localhost:9999', {
        req: { url: 'https://app.example.com/api/auth/me' },
        env: env as unknown as Env,
      })).toBe(false);
      expect(isAllowedOrigin('http://localhost:8787', {
        req: { url: 'http://localhost:8787/api/auth/me' },
        env: env as unknown as Env,
      })).toBe(true);
    });
  });

  describe('12. setup token fragment', () => {
    it('never copies a query token into the field', () => {
      const parsed = consumeSetupTokenFromSearch('https://example.com/setup/passkey?token=reusable-secret');
      expect(parsed.token).toBe('');
      expect(parsed.discardedQueryToken).toBe(true);
    });
  });

  describe('13. logout fail-closed', () => {
    it('revokes the session so a copied cookie cannot authenticate', async () => {
      const cookie = await sessionCookie();
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(true);
      const logout = await app.request('https://example.com/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://example.com' },
      }, env as unknown as Env);
      expect(logout.status).toBe(204);
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(false);
    });
  });

  describe('10. rate limit does not use KV get-then-put', () => {
    it('serial memory admits exactly the limit', async () => {
      const bucket = `535:${crypto.randomUUID()}`;
      let allowed = 0;
      for (let i = 0; i < 8; i++) {
        if ((await consumeRateLimit(bucket, 5, 60)).allowed) allowed += 1;
      }
      expect(allowed).toBe(5);
    });

    it('uses the Rate Limit binding and never increments KV', async () => {
      let calls = 0;
      const limiter = {
        limit: async () => {
          calls += 1;
          return { success: calls <= 2 };
        },
      };
      expect((await consumeRateLimit('bound', 2, 60, limiter)).allowed).toBe(true);
      expect((await consumeRateLimit('bound', 2, 60, limiter)).allowed).toBe(true);
      expect((await consumeRateLimit('bound', 2, 60, limiter)).allowed).toBe(false);
      expect(calls).toBe(3);
    });

    it('fails closed when the Rate Limit binding throws', async () => {
      const limiter = {
        limit: async () => {
          throw new Error('unavailable');
        },
      };
      const decision = await consumeRateLimit('bound-error', 10, 60, limiter);
      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterSec).toBeGreaterThan(0);
    });
  });

  describe('9. passkey tombstones stay authoritative', () => {
    it('stale saveCredentials cannot resurrect a deleted credential', async () => {
      const stale = [
        {
          id: 'cred-revoked',
          publicKey: 'abc',
          counter: 0,
          label: 'gone',
          createdAt: '2026-01-01T00:00:00Z',
          disabled: false,
        },
        {
          id: 'cred-kept',
          publicKey: 'def',
          counter: 0,
          label: 'kept',
          createdAt: '2026-01-01T00:00:00Z',
          disabled: false,
        },
      ];
      await saveCredentials(env as unknown as Env, stale);
      await tombstoneCredential(env as unknown as Env, 'cred-revoked');
      await saveCredentials(env as unknown as Env, stale);

      const listed = await env.KV.get('webauthn_credentials', 'json') as Array<{ id: string }> | null;
      expect(listed?.map((c) => c.id)).toEqual(['cred-kept']);
      expect(await isCredentialActive(env as unknown as Env, 'cred-revoked')).toBe(false);
      expect(await isCredentialActive(env as unknown as Env, 'cred-kept')).toBe(true);
    });
  });

  describe('14. login ceremonies are isolated', () => {
    it('a second options request does not expire the first ceremony', async () => {
      await env.KV.put('webauthn_credentials', JSON.stringify([{
        id: 'cred-1',
        publicKey: 'abc',
        counter: 0,
        label: 'x',
        createdAt: '2026-01-01T00:00:00Z',
        disabled: false,
      }]));
      const first = await app.request(`${TEST_ORIGIN}/api/auth/login/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, env as unknown as Env);
      expect(first.status).toBe(200);
      const firstJson = await first.json() as { ceremonyId: string; challenge: string };
      const second = await app.request(`${TEST_ORIGIN}/api/auth/login/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, env as unknown as Env);
      expect(second.status).toBe(200);
      const kept = await env.KV.get(`webauthn_challenge_auth:${firstJson.ceremonyId}`);
      expect(kept).toBe(firstJson.challenge);
    });
  });
});
