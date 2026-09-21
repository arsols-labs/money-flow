import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie, verifySessionCookie } from '../src/worker/auth';
import { timingSafeEqualString } from '../src/worker/crypto-eq';
import { escapeHtml } from '../src/worker/html';
import { getAnalyticsHtml } from '../src/worker/mcp-analytics-ui';
import { getPulseHtml } from '../src/worker/mcp-pulse-ui';
import { getOAuthHelpers } from '../src/worker/oauth';
import { consumeRateLimit, RATE_LIMITS, resetRateLimitMemoryForTests } from '../src/worker/rate-limit';
import { consumeSetupTokenFromSearch } from '../src/shared/setup-token-query';
import type { Env } from '../src/worker/types';

const TEST_ORIGIN = 'https://auth.example.com';
const TEST_RESOURCE_URI = `${TEST_ORIGIN}/mcp`;

async function generatePkce() {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

describe('security harden (#533)', () => {
  beforeEach(() => {
    resetRateLimitMemoryForTests();
  });

  describe('timingSafeEqualString', () => {
    it('принимает равные строки и отвергает отличающиеся', () => {
      expect(timingSafeEqualString('abc', 'abc')).toBe(true);
      expect(timingSafeEqualString('abc', 'abd')).toBe(false);
      expect(timingSafeEqualString('abc', 'ab')).toBe(false);
      expect(timingSafeEqualString('', '')).toBe(true);
    });
  });

  describe('escapeHtml', () => {
    it('экранирует ledger-строки для innerHTML', () => {
      expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
      );
      expect(escapeHtml(`O'Reilly & "Co"`)).toBe('O&#39;Reilly &amp; &quot;Co&quot;');
    });
  });

  describe('MCP Apps widget sources', () => {
    it('экранирует метки в analytics и pulse UI', () => {
      const analytics = getAnalyticsHtml();
      const pulse = getPulseHtml();
      expect(analytics).toContain('function escapeHtml');
      expect(pulse).toContain('function escapeHtml');
      expect(analytics).toContain('escapeHtml(c.label)');
      expect(analytics).toContain('escapeHtml(m.label)');
      expect(analytics).toContain('escapeHtml(item.label)');
      expect(pulse).toContain('escapeHtml(a.name)');
      expect(pulse).toContain('escapeHtml(w.message)');
      expect(analytics).toContain('event.source !== window.parent');
      expect(pulse).toContain('event.source !== window.parent');
      expect(analytics).toContain('trustedParentOrigin');
      expect(pulse).toContain('trustedParentOrigin');
      expect(analytics).not.toContain("postMessage({ jsonrpc: '2.0', id, method, params }, '*')");
      expect(pulse).not.toContain("postMessage({ jsonrpc: '2.0', id, method, params }, '*')");
    });
  });

  describe('SETUP_TOKEN query', () => {
    it('игнорирует query token и принимает только fragment', () => {
      const discarded = consumeSetupTokenFromSearch(
        'https://example.com/setup/passkey?token=secret-value&x=1#/access',
      );
      expect(discarded.token).toBe('');
      expect(discarded.discardedQueryToken).toBe(true);
      expect(discarded.nextUrl).toBe('/setup/passkey?x=1#/access');
      expect(discarded.nextUrl).not.toContain('token=');

      const fromHash = consumeSetupTokenFromSearch(
        'https://example.com/setup/passkey?x=1#token=secret-value',
      );
      expect(fromHash.token).toBe('secret-value');
      expect(fromHash.discardedQueryToken).toBe(false);
      expect(fromHash.nextUrl).toBe('/setup/passkey?x=1');
    });

    it('не трогает URL без token', () => {
      const { token, nextUrl, discardedQueryToken } = consumeSetupTokenFromSearch('https://example.com/setup/passkey');
      expect(token).toBe('');
      expect(discardedQueryToken).toBe(false);
      expect(nextUrl).toBe('/setup/passkey');
    });
  });

  describe('rate limit', () => {
    it('после лимита возвращает allowed=false', async () => {
      const bucket = `test:${crypto.randomUUID()}`;
      for (let i = 0; i < 3; i++) {
        const ok = await consumeRateLimit(bucket, 3, 60);
        expect(ok.allowed).toBe(true);
      }
      const blocked = await consumeRateLimit(bucket, 3, 60);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    });

    it('режет POST /api/auth/oauth/register', async () => {
      const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      let lastStatus = 0;
      for (let i = 0; i < RATE_LIMITS.oauthRegister.limit + 2; i++) {
        const res = await app.request(
          'https://auth.example.com/api/auth/oauth/register',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': ip,
            },
            body: JSON.stringify({
              client_name: 'Rate Limit Client',
              redirect_uris: ['http://127.0.0.1:8080/callback'],
            }),
          },
          env as unknown as Env,
        );
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    });

    it('режет POST /api/auth/login/options', async () => {
      const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
      let saw429 = false;
      for (let i = 0; i < RATE_LIMITS.authLogin.limit + 2; i++) {
        const res = await app.request(
          'https://auth.example.com/api/auth/login/options',
          {
            method: 'POST',
            headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
            body: '{}',
          },
          env as unknown as Env,
        );
        if (res.status === 429) {
          saw429 = true;
          expect(res.headers.get('Retry-After')).toBeTruthy();
          break;
        }
      }
      expect(saw429).toBe(true);
    });
  });

  describe('logout', () => {
    it('сбрасывает cookie и denylist-ит sid — повторный /me уже не авторизован', async () => {
      const setCookie = await createSessionCookie(env as unknown as Env, false);
      const cookie = setCookie.split(';')[0]!;
      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(true);

      const before = await app.request(
        'https://example.com/api/auth/me',
        { headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect((await before.json<{ authenticated: boolean }>()).authenticated).toBe(true);

      const logout = await app.request(
        'https://example.com/api/auth/logout',
        { method: 'POST', headers: { Cookie: cookie, Origin: 'https://example.com' } },
        env as unknown as Env,
      );
      expect(logout.status).toBe(204);
      const cleared = logout.headers.get('Set-Cookie') || '';
      expect(cleared).toContain('mf_session=');
      expect(cleared).toContain('Max-Age=0');

      expect(await verifySessionCookie(env as unknown as Env, cookie)).toBe(false);
      const after = await app.request(
        'https://example.com/api/auth/me',
        { headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect((await after.json<{ authenticated: boolean }>()).authenticated).toBe(false);
    });
  });

  describe('Access revoke kills /mcp bearer', () => {
    it('после DELETE /access/tokens/:grantId bearer больше не проходит на /mcp', async () => {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM oauth_tokens'),
        env.DB.prepare('DELETE FROM oauth_consents'),
        env.DB.prepare('DELETE FROM oauth_clients'),
      ]);

      const setCookie = await createSessionCookie(env as unknown as Env, false);
      const cookie = setCookie.split(';')[0]!;
      const helpers = getOAuthHelpers(env as unknown as Env, TEST_ORIGIN);
      const client = await helpers.createClient({
        clientName: 'Revoke Probe',
        redirectUris: ['https://cursor.com/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { verifier, challenge } = await generatePkce();
      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://cursor.com/callback',
      )}&scope=read write&state=rev1&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI,
      )}`;

      const getRes = await app.request(
        `${TEST_ORIGIN}/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect(getRes.status).toBe(200);
      const html = await getRes.text();
      const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();

      const postForm = new FormData();
      postForm.append('csrf_token', csrf!);
      postForm.append('client_id', client.clientId);
      postForm.append('redirect_uri', 'https://cursor.com/callback');
      postForm.append('state', 'rev1');
      postForm.append('scope', 'read write');
      postForm.append('action', 'allow');

      const postRes = await app.request(`${TEST_ORIGIN}/api/auth/oauth/authorize?${authQuery}`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: postForm,
      }, env as unknown as Env);
      expect(postRes.status).toBe(302);
      const code = new URL(postRes.headers.get('Location')!).searchParams.get('code');
      expect(code).toBeTruthy();

      const tokenRes = await app.request(
        `${TEST_ORIGIN}/api/auth/oauth/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code!,
            redirect_uri: 'https://cursor.com/callback',
            client_id: client.clientId,
            code_verifier: verifier,
            resource: TEST_RESOURCE_URI,
          }).toString(),
        },
        env as unknown as Env,
      );
      expect(tokenRes.status).toBe(200);
      const accessToken = (await tokenRes.json<{ access_token: string }>()).access_token;

      const mcpOk = await app.request(
        `${TEST_ORIGIN}/mcp`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        env as unknown as Env,
      );
      expect(mcpOk.status).toBe(200);

      const dbToken = await env.DB.prepare(
        'SELECT id FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NULL',
      )
        .bind(client.clientId)
        .first<{ id: string }>();
      expect(dbToken?.id).toBeTruthy();

      const grants = await helpers.listUserGrants('owner');
      expect(grants.items.some((g) => g.id === dbToken!.id)).toBe(true);

      const revoke = await app.request(
        `https://example.com/api/v2/mcp/access/tokens/${encodeURIComponent(dbToken!.id)}`,
        { method: 'DELETE', headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect(revoke.status).toBe(204);

      const mcpDead = await app.request(
        `${TEST_ORIGIN}/mcp`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        env as unknown as Env,
      );
      expect(mcpDead.status).toBe(401);
    });
  });
});
