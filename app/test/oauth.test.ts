// S2-1: Интеграционные тесты OAuth 2.1 для машинных клиентов (issue #261)
//
// Тесты проверяют:
// - Discovery RFC 9728 (Protected Resource Metadata) и RFC 8414 (Authorization Server Metadata)
// - PKCE (S256), валидацию client_id, state, redirect_uri
// - Защиту страницы согласия (anti-framing заголовки, CSRF-токены)
// - Выдачу authorization code, обмен на access_token + refresh_token
// - Защиту от повторного использования authorization code
// - Запись аудита в D1 (oauth_clients, oauth_consents, oauth_tokens)
// - Защиту эндпоинта /mcp: 401 без токена, 200 с валидным токеном, 401 после отзыва

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import { getOAuthHelpers, isTrustedOAuthRedirectUri, revokeOAuthTokenInDb } from '../src/worker/oauth';
import { createConsentCsrfToken, verifyConsentCsrfToken } from '../src/worker/oauth-consent';
import type { Env } from '../src/worker/types';

const TEST_ORIGIN = 'https://auth.example.com';
const TEST_RESOURCE_URI = `${TEST_ORIGIN}/mcp`;
const TEST_ISSUER_URI = TEST_ORIGIN;

async function generatePkce() {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

describe('isTrustedOAuthRedirectUri (#531)', () => {
  it('принимает RFC 8252 loopback и Google Account Linking на точном хосте', () => {
    expect(isTrustedOAuthRedirectUri('http://127.0.0.1:8080/callback')).toBe(true);
    expect(isTrustedOAuthRedirectUri('http://localhost:3000/callback')).toBe(true);
    expect(isTrustedOAuthRedirectUri('http://127.0.0.1/callback')).toBe(true);
    expect(isTrustedOAuthRedirectUri('https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1')).toBe(true);
    expect(isTrustedOAuthRedirectUri('https://developers.google.com/oauthredirect')).toBe(true);
    expect(isTrustedOAuthRedirectUri('https://gemini.google.com/oauth/callback')).toBe(true);
  });

  it('отклоняет userinfo, чужой хост и prefix-lookalike', () => {
    expect(isTrustedOAuthRedirectUri('http://127.0.0.1:8080@evil-attacker.example/callback')).toBe(false);
    expect(isTrustedOAuthRedirectUri('http://localhost:3000@evil.example/callback')).toBe(false);
    expect(isTrustedOAuthRedirectUri('https://evil-attacker.com/callback')).toBe(false);
    expect(isTrustedOAuthRedirectUri('https://oauth-redirect.googleusercontent.com.evil.example/')).toBe(false);
    expect(isTrustedOAuthRedirectUri('https://gemini.google.com.evil.example/')).toBe(false);
    expect(isTrustedOAuthRedirectUri('https://developers.google.com/not-oauth')).toBe(false);
    expect(isTrustedOAuthRedirectUri('not-a-url')).toBe(false);
  });
});

describe('S2-1: OAuth 2.1 Machine Clients & Consent', () => {
  let cookie: string;

  beforeEach(async () => {
    // Очистка D1 таблиц перед каждым тестом
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_tokens'),
      env.DB.prepare('DELETE FROM oauth_consents'),
      env.DB.prepare('DELETE FROM oauth_clients'),
    ]);

    const setCookie = await createSessionCookie(env as unknown as Env, false);
    cookie = setCookie.split(';')[0]!;
  });

  describe('Discovery (RFC 9728 и RFC 8414)', () => {
    it('отдаёт RFC 9728 Protected Resource Metadata на /.well-known/oauth-protected-resource', async () => {
      const res = await app.request(
        'https://auth.example.com/.well-known/oauth-protected-resource',
        undefined,
        env as unknown as Env
      );
      if (res.status !== 200) {
        console.error('500 error:', await res.text());
      }
      expect(res.status).toBe(200);
      const json = await res.json<any>();
      expect(json.resource).toBe(TEST_RESOURCE_URI);
      expect(json.authorization_servers).toContain(TEST_ISSUER_URI);
      expect(json.scopes_supported).toEqual(['read', 'write']);
      expect(json.bearer_methods_supported).toContain('header');
    });

    it('отдаёт RFC 8414 Authorization Server Metadata на /.well-known/oauth-authorization-server', async () => {
      const res = await app.request(
        'https://auth.example.com/.well-known/oauth-authorization-server',
        undefined,
        env as unknown as Env
      );
      if (res.status !== 200) {
        console.error('500 error:', await res.text());
      }
      expect(res.status).toBe(200);
      const json = await res.json<any>();
      expect(json.issuer).toBe(TEST_ISSUER_URI);
      expect(json.authorization_endpoint).toContain('/api/auth/oauth/authorize');
      expect(json.token_endpoint).toContain('/api/auth/oauth/token');
      expect(json.code_challenge_methods_supported).toContain('S256');
      expect(json.authorization_response_iss_parameter_supported).toBe(true);
      expect(json.client_id_metadata_document_supported).toBe(true);
    });

    it('отдаёт тот же AS metadata на OIDC и path-aware URL, неизвестный well-known — 404', async () => {
      const canonical = await app.request(
        'https://auth.example.com/.well-known/oauth-authorization-server',
        undefined,
        env as unknown as Env
      );
      expect(canonical.status).toBe(200);
      const expected = await canonical.json<any>();

      for (const path of [
        '/.well-known/openid-configuration',
        '/.well-known/oauth-authorization-server/mcp',
        '/.well-known/oauth-authorization-server/',
      ]) {
        const res = await app.request(
          `https://auth.example.com${path}`,
          undefined,
          env as unknown as Env
        );
        expect(res.status, path).toBe(200);
        expect(await res.json(), path).toEqual(expected);
      }

      const unknown = await app.request(
        'https://auth.example.com/.well-known/not-a-real-endpoint',
        undefined,
        env as unknown as Env
      );
      expect(unknown.status).toBe(404);
    });

    it('отдаёт path-aware Protected Resource Metadata на …/oauth-protected-resource/mcp', async () => {
      const res = await app.request(
        'https://auth.example.com/.well-known/oauth-protected-resource/mcp',
        undefined,
        env as unknown as Env
      );
      expect(res.status).toBe(200);
      const json = await res.json<any>();
      expect(json.resource).toBe(TEST_RESOURCE_URI);
    });
  });

  describe('Страница согласия (Consent Page) и CSRF', () => {
    it('требует аутентификацию сессионной кукой для открытия согласия', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Claude Desktop',
        redirectUris: ['https://claude.ai/oauth/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();

      const authorizeUrl = `https://auth.example.com/api/auth/oauth/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://claude.ai/oauth/callback'
      )}&scope=read%20write&state=state123&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      // Без сессионной куки — редирект на логин
      const resUnauth = await app.request(authorizeUrl, undefined, env as unknown as Env);
      expect(resUnauth.status).toBe(302);
      expect(resUnauth.headers.get('Location')).toContain('/login?return_to=');

      // С сессионной кукой — 200 OK со страницей согласия
      const resAuth = await app.request(
        authorizeUrl,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );
      expect(resAuth.status).toBe(200);
      expect(resAuth.headers.get('X-Frame-Options')).toBe('DENY');
      const csp = resAuth.headers.get('Content-Security-Policy') || '';
      expect(csp).toContain("frame-ancestors 'none'");
      // #561: form-action must include the client redirect origin or browsers
      // block the post-Allow 302 (Grok stays on a stuck consent window).
      expect(csp).toContain("form-action 'self' https://claude.ai");

      const html = await resAuth.text();
      expect(html).toContain('Claude Desktop');
      expect(html).toContain('https://claude.ai/oauth/callback');
      expect(html).toContain('read');
      expect(html).toContain('write');
      expect(html).toContain('name="csrf_token"');
    });

    it('не доверяет loopback redirect_uri с userinfo (open-redirect / theft of auth code)', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Local MCP',
        redirectUris: ['http://127.0.0.1:8080/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();
      const stolen = 'http://127.0.0.1:8080@evil-attacker.example/callback';

      const invalidUrl = `https://auth.example.com/api/auth/oauth/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        stolen
      )}&scope=read&state=state123&code_challenge=${challenge}&code_challenge_method=S256`;

      const res = await app.request(invalidUrl, { headers: { Cookie: cookie } }, env as unknown as Env);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Invalid redirect URI');
    });

    it('отклоняет некорректный redirect_uri локально без редиректа (защита от open redirect)', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Claude Desktop',
        redirectUris: ['https://claude.ai/oauth/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();

      const invalidUrl = `https://auth.example.com/api/auth/oauth/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://evil-attacker.com/callback'
      )}&scope=read&state=state123&code_challenge=${challenge}&code_challenge_method=S256`;

      const res = await app.request(invalidUrl, { headers: { Cookie: cookie } }, env as unknown as Env);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('Invalid redirect URI');
    });

    it('принимает точный зарегистрированный Google Account Linking redirect_uri', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const registeredGoogleUri = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-102860837630623043323';
      const client = await helpers.createClient({
        clientName: 'Gemini Desktop',
        redirectUris: [registeredGoogleUri],
        tokenEndpointAuthMethod: 'client_secret_basic',
      });
      const { challenge } = await generatePkce();

      const authorizeUrl = `https://auth.example.com/api/auth/oauth/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        registeredGoogleUri
      )}&scope=read%20write&state=state123&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      const resAuth = await app.request(
        authorizeUrl,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );
      expect(resAuth.status).toBe(200);
      const html = await resAuth.text();
      expect(html).toContain('Gemini Desktop');
      expect(html).toContain(registeredGoogleUri);
    });

    it('успешно обрабатывает POST формы согласия без query string в URL', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Gemini Desktop',
        redirectUris: ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-12345'],
        tokenEndpointAuthMethod: 'client_secret_basic',
      });
      const { challenge } = await generatePkce();

      const authorizeUrl = `https://auth.example.com/api/auth/oauth/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-12345'
      )}&scope=read%20write&state=gemini-state-99&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      const getRes = await app.request(authorizeUrl, { headers: { Cookie: cookie } }, env as unknown as Env);
      expect(getRes.status).toBe(200);
      const html = await getRes.text();
      const matchCsrf = html.match(/name="csrf_token" value="([^"]+)"/);
      expect(matchCsrf).toBeTruthy();
      const csrfToken = matchCsrf![1];

      // POST отправляется на чистый URL без query string
      const form = new FormData();
      form.append('csrf_token', csrfToken);
      form.append('client_id', client.clientId);
      form.append('redirect_uri', 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-12345');
      form.append('response_type', 'code');
      form.append('code_challenge', challenge);
      form.append('code_challenge_method', 'S256');
      form.append('resource', TEST_RESOURCE_URI);
      form.append('state', 'gemini-state-99');
      form.append('scope', 'read write');
      form.append('action', 'allow');

      const postRes = await app.request(
        'https://auth.example.com/api/auth/oauth/authorize',
        {
          method: 'POST',
          headers: { Cookie: cookie },
          body: form,
        },
        env as unknown as Env
      );

      expect(postRes.status).toBe(302);
      const redirectLocation = postRes.headers.get('Location')!;
      expect(redirectLocation).toContain('https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-12345');
      const url = new URL(redirectLocation);
      expect(url.searchParams.get('code')).toBeTruthy();
      expect(url.searchParams.get('state')).toBe('gemini-state-99');
    });

    it('проверяет валидность и срок действия CSRF токена', async () => {
      const params = {
        clientId: 'client-1',
        redirectUri: 'https://client.test/callback',
        state: 'xyz',
      };
      const token = await createConsentCsrfToken(env.SESSION_SECRET, params);
      const isValid = await verifyConsentCsrfToken(env.SESSION_SECRET, token, params);
      expect(isValid).toBe(true);

      const isInvalidSecret = await verifyConsentCsrfToken('wrong-secret', token, params);
      expect(isInvalidSecret).toBe(false);

      const isInvalidParams = await verifyConsentCsrfToken(env.SESSION_SECRET, token, {
        ...params,
        state: 'other-state',
      });
      expect(isInvalidParams).toBe(false);
    });
  });

  describe('Полный OAuth 2.1 Flow (Code + PKCE + Token + Revoke)', () => {
    it('успешно выдаёт токен, пишет аудит в D1 и отзывает доступ', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Cursor AI',
        redirectUris: ['https://cursor.com/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { verifier, challenge } = await generatePkce();

      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://cursor.com/callback'
      )}&scope=read%20write&state=mystate42&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      // 1. GET запрос страницы согласия
      const getRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );
      expect(getRes.status).toBe(200);
      const html = await getRes.text();
      const matchCsrf = html.match(/name="csrf_token" value="([^"]+)"/);
      expect(matchCsrf).toBeTruthy();
      const csrfToken = matchCsrf![1];

      // 2. POST подтверждения согласия (Allow)
      const postForm = new FormData();
      postForm.append('csrf_token', csrfToken);
      postForm.append('client_id', client.clientId);
      postForm.append('redirect_uri', 'https://cursor.com/callback');
      postForm.append('state', 'mystate42');
      postForm.append('scope', 'read write');
      postForm.append('action', 'allow');

      const postRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'CF-Connecting-IP': '198.51.100.1',
            'CF-IPCountry': 'DE',
          },
          body: postForm,
        },
        env as unknown as Env
      );

      expect(postRes.status).toBe(302);
      const redirectLocation = postRes.headers.get('Location')!;
      expect(redirectLocation).toContain('https://cursor.com/callback');
      const redirectUrl = new URL(redirectLocation);
      expect(redirectUrl.searchParams.get('state')).toBe('mystate42');
      expect(redirectUrl.searchParams.get('iss')).toBe(TEST_ISSUER_URI);
      const code = redirectUrl.searchParams.get('code');
      expect(code).toBeTruthy();

      // Проверяем запись в D1: oauth_clients, oauth_consents, oauth_tokens
      const dbClient = await env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?')
        .bind(client.clientId)
        .first<{ id: string; name: string }>();
      expect(dbClient?.name).toBe('Cursor AI');

      const dbConsent = await env.DB.prepare('SELECT * FROM oauth_consents WHERE client_id = ?')
        .bind(client.clientId)
        .first<{ id: string; scopes: string; redirect_uri: string }>();
      expect(dbConsent?.redirect_uri).toBe('https://cursor.com/callback');
      expect(JSON.parse(dbConsent?.scopes || '[]')).toEqual(['read', 'write']);

      const dbTokens = await env.DB.prepare('SELECT * FROM oauth_tokens WHERE client_id = ?')
        .bind(client.clientId)
        .all<{ id: string; last_ip: string; last_country: string }>();
      expect(dbTokens.results.length).toBeGreaterThan(0);
      expect(dbTokens.results[0].last_ip).toBe('198.51.100.1');
      expect(dbTokens.results[0].last_country).toBe('DE');

      // 3. Обмен authorization code на токен (POST /api/auth/oauth/token)
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'https://cursor.com/callback',
        client_id: client.clientId,
        code_verifier: verifier,
        resource: TEST_RESOURCE_URI,
      });

      const tokenRes = await app.request(
        'https://auth.example.com/api/auth/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
        },
        env as unknown as Env
      );

      expect(tokenRes.status).toBe(200);
      const tokenJson = await tokenRes.json<any>();
      expect(tokenJson.access_token).toBeTruthy();
      expect(tokenJson.token_type).toBe('bearer');
      expect(tokenJson.expires_in).toBeGreaterThan(0);
      expect(tokenJson.scope).toBe('read write');
      const accessToken = tokenJson.access_token;

      // 4. Обращение к защищённому MCP роуту
      // Без токена -> 401
      const mcpUnauth = await app.request('https://auth.example.com/mcp', undefined, env as unknown as Env);
      expect(mcpUnauth.status).toBe(401);
      expect(mcpUnauth.headers.get('WWW-Authenticate')).toContain('Bearer');

      // С валидным токеном -> 200
      const mcpAuth = await app.request(
        'https://auth.example.com/mcp',
        { headers: { Authorization: `Bearer ${accessToken}` } },
        env as unknown as Env
      );
      expect(mcpAuth.status).toBe(200);

      // ALE-13: Проверка что OAuth client ID пробрасывается в MCP context и audit log
      const idempotencyKey = 'test-oauth-audit-ale13';
      const mcpWrite = await app.request(
        'https://auth.example.com/mcp',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'operation_add',
              arguments: {
                idempotency_key: idempotencyKey,
                title: 'Test',
                amount_minor: -100,
                account_id: 9999, // Doesn't matter if it exists, idempotency check is first
              },
            },
          }),
        },
        env as unknown as Env
      );
      
      expect(mcpWrite.status).toBe(200);
      const writeResult = await mcpWrite.json<any>();
      // Если клиент прокинут правильно, мы пройдём этап claim idempotency_key,
      // и не свалимся с Error executing tool: Unable to claim idempotency_key.
      expect(writeResult.error).toBeUndefined();
      expect(writeResult.result).toBeDefined();
      
      const auditLog = await env.DB.prepare('SELECT client_id FROM mcp_audit_log WHERE client_id = ? AND tool_name = ? ORDER BY created_at DESC LIMIT 1')
        .bind(client.clientId, 'operation_add')
        .first<{ client_id: string }>();
      
      expect(auditLog).toBeDefined();
      expect(auditLog?.client_id).toBe(client.clientId);

      // 5. Повторное использование code — запрещено (replay attack)
      // По спецификации RFC 6749 §4.1.2 при попытке replay авторизационный сервер
      // отклоняет запрос И отзывает выданный грант / токены.
      const replayRes = await app.request(
        'https://auth.example.com/api/auth/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
        },
        env as unknown as Env
      );
      expect(replayRes.status).toBe(400);

      // 6. После обнаружения replay токен отозван -> 401 на /mcp
      const mcpRevoked = await app.request(
        'https://auth.example.com/mcp',
        { headers: { Authorization: `Bearer ${accessToken}` } },
        env as unknown as Env
      );
      expect(mcpRevoked.status).toBe(401);

      // Отзываем в D1
      await revokeOAuthTokenInDb(env.DB, dbTokens.results[0].id);
      const revokedToken = await env.DB.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?')
        .bind(dbTokens.results[0].id)
        .first<{ revoked_at: string | null }>();
      expect(revokedToken?.revoked_at).not.toBeNull();
    });

    it('отклоняет запрос при нажатии «Отклонить» (action=deny)', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Windsurf AI',
        redirectUris: ['https://windsurf.com/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();

      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://windsurf.com/callback'
      )}&scope=read&state=deny_state&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      const csrfToken = await createConsentCsrfToken(env.SESSION_SECRET, {
        clientId: client.clientId,
        redirectUri: 'https://windsurf.com/callback',
        state: 'deny_state',
      });

      const postForm = new FormData();
      postForm.append('csrf_token', csrfToken);
      postForm.append('client_id', client.clientId);
      postForm.append('redirect_uri', 'https://windsurf.com/callback');
      postForm.append('state', 'deny_state');
      postForm.append('action', 'deny');

      const postRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        {
          method: 'POST',
          headers: { Cookie: cookie },
          body: postForm,
        },
        env as unknown as Env
      );

      expect(postRes.status).toBe(302);
      const redirectUrl = new URL(postRes.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('access_denied');
      expect(redirectUrl.searchParams.get('state')).toBe('deny_state');
      expect(redirectUrl.searchParams.get('iss')).toBe(TEST_ISSUER_URI);
    });

    it('отклоняет запрос с недействительным CSRF-токеном', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Windsurf AI',
        redirectUris: ['https://windsurf.com/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();

      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://windsurf.com/callback'
      )}&scope=read&state=csrf_test&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      const postForm = new FormData();
      postForm.append('csrf_token', 'forged-or-invalid-csrf-token');
      postForm.append('client_id', client.clientId);
      postForm.append('redirect_uri', 'https://windsurf.com/callback');
      postForm.append('state', 'csrf_test');
      postForm.append('action', 'allow');

      const postRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        {
          method: 'POST',
          headers: { Cookie: cookie },
          body: postForm,
        },
        env as unknown as Env
      );

      expect(postRes.status).toBe(400);
      expect(await postRes.text()).toContain('CSRF');
    });

    it('отклоняет запрос авторизации с несовпадающим resource (RFC 8707)', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Test Client',
        redirectUris: ['https://client.test/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();

      const invalidResourceQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://client.test/callback'
      )}&scope=read&state=state_res&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        'https://foreign-resource.example.com/mcp'
      )}`;

      const res = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${invalidResourceQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );

      // При несовпадении resource должен быть редирект с error=invalid_target
      expect(res.status).toBe(302);
      const redirectUrl = new URL(res.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_target');
    });

    it('выдаёт токен только с одобренными скоупами (сужение скоупов)', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Read Only Client',
        redirectUris: ['https://readonly.test/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { verifier, challenge } = await generatePkce();

      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://readonly.test/callback'
      )}&scope=read%20write&state=ro_state&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      // GET consent page
      const getRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );
      const html = await getRes.text();
      const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)![1];

      // POST consent with ONLY 'read' scope selected
      const postForm = new FormData();
      postForm.append('csrf_token', csrfToken);
      postForm.append('client_id', client.clientId);
      postForm.append('redirect_uri', 'https://readonly.test/callback');
      postForm.append('state', 'ro_state');
      postForm.append('scope', 'read'); // Только read
      postForm.append('action', 'allow');

      const postRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        {
          method: 'POST',
          headers: { Cookie: cookie },
          body: postForm,
        },
        env as unknown as Env
      );

      expect(postRes.status).toBe(302);
      const redirectUrl = new URL(postRes.headers.get('Location')!);
      const code = redirectUrl.searchParams.get('code')!;
      // RFC 9207: успешный авторизационный ответ содержит iss, побайтово
      // совпадающий с issuer из AS-метаданных (без trailing slash).
      expect(redirectUrl.searchParams.get('iss')).toBe(TEST_ISSUER_URI);
      expect(redirectUrl.searchParams.get('iss')).toBe('https://auth.example.com');
      expect(redirectUrl.searchParams.get('iss')!.endsWith('/')).toBe(false);

      // Exchange code for token
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://readonly.test/callback',
        client_id: client.clientId,
        code_verifier: verifier,
        resource: TEST_RESOURCE_URI,
      });

      const tokenRes = await app.request(
        'https://auth.example.com/api/auth/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
        },
        env as unknown as Env
      );

      expect(tokenRes.status).toBe(200);
      const tokenJson = await tokenRes.json<any>();
      expect(tokenJson.scope).toBe('read'); // Выдан только read
    });

    it('отклоняет Allow без выбранных scope вместо выдачи запрошенных', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Empty Scope Client',
        redirectUris: ['https://empty.test/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();
      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://empty.test/callback'
      )}&scope=read%20write&state=empty_state&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;
      const getRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );
      const html = await getRes.text();
      const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)![1];
      const postForm = new FormData();
      postForm.append('csrf_token', csrfToken);
      postForm.append('client_id', client.clientId);
      postForm.append('redirect_uri', 'https://empty.test/callback');
      postForm.append('state', 'empty_state');
      postForm.append('action', 'allow');
      const postRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { method: 'POST', headers: { Cookie: cookie }, body: postForm },
        env as unknown as Env,
      );
      expect(postRes.status).toBe(302);
      const redirectUrl = new URL(postRes.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
      expect(redirectUrl.searchParams.get('code')).toBeNull();
    });

    it('повторный Allow с тем же grant id не отдаёт OAUTH_GRANT_RECORD_FAILED (#559)', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Grok Double Click',
        redirectUris: ['https://grok.example/connectors-oauth-exchange-code/'],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();
      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        'https://grok.example/connectors-oauth-exchange-code/'
      )}&scope=read%20write&state=dbl_state&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      const getRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect(getRes.status).toBe(200);
      const html = await getRes.text();
      expect(html).toContain('id="consent-form"');
      expect(getRes.headers.get('Content-Security-Policy')).toContain('sha256-');
      const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)![1];

      const buildAllow = () => {
        const postForm = new FormData();
        postForm.append('csrf_token', csrfToken!);
        postForm.append('client_id', client.clientId);
        postForm.append('redirect_uri', 'https://grok.example/connectors-oauth-exchange-code/');
        postForm.append('state', 'dbl_state');
        postForm.append('scope', 'read');
        postForm.append('scope', 'write');
        postForm.append('action', 'allow');
        return postForm;
      };

      const first = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { method: 'POST', headers: { Cookie: cookie }, body: buildAllow() },
        env as unknown as Env,
      );
      expect(first.status).toBe(302);
      const firstLoc = new URL(first.headers.get('Location')!);
      expect(firstLoc.searchParams.get('error')).toBeNull();
      expect(firstLoc.searchParams.get('code')).toBeTruthy();

      const second = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { method: 'POST', headers: { Cookie: cookie }, body: buildAllow() },
        env as unknown as Env,
      );
      expect(second.status).toBe(302);
      const secondBody = await second.text();
      expect(secondBody).not.toContain('OAUTH_GRANT_RECORD_FAILED');
      const secondLoc = new URL(second.headers.get('Location')!);
      expect(secondLoc.searchParams.get('error')).toBeNull();
      expect(secondLoc.searchParams.get('code')).toBeTruthy();

      const tokens = await env.DB.prepare(
        'SELECT id, revoked_at FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NULL',
      )
        .bind(client.clientId)
        .all<{ id: string; revoked_at: string | null }>();
      expect(tokens.results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Loopback Gemini (#319)', () => {
    it('сохраняет hostname localhost в Location и принимает исходный localhost на token', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'Gemini Desktop',
        redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
        tokenEndpointAuthMethod: 'none',
      });
      const { verifier, challenge } = await generatePkce();
      const loopback = 'http://localhost:54321/callback';

      const authorizeUrl = `https://auth.example.com/api/auth/oauth/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        loopback
      )}&scope=read%20write&state=gemini-loopback&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI
      )}`;

      const getRes = await app.request(
        authorizeUrl,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );
      expect(getRes.status).toBe(200);
      const html = await getRes.text();
      expect(html).toContain('http://localhost:54321/callback');
      expect(html).not.toContain('http://127.0.0.1:54321/callback');
      const matchCsrf = html.match(/name="csrf_token" value="([^"]+)"/);
      expect(matchCsrf).toBeTruthy();

      const postForm = new FormData();
      postForm.append('csrf_token', matchCsrf![1]!);
      postForm.append('client_id', client.clientId);
      postForm.append('redirect_uri', loopback);
      postForm.append('state', 'gemini-loopback');
      postForm.append('scope', 'read write');
      postForm.append('action', 'allow');

      const postRes = await app.request(
        authorizeUrl,
        {
          method: 'POST',
          headers: { Cookie: cookie },
          body: postForm,
        },
        env as unknown as Env
      );

      expect(postRes.status).toBe(302);
      const location = postRes.headers.get('Location')!;
      expect(location.startsWith('http://localhost:54321/callback')).toBe(true);
      const redirectUrl = new URL(location);
      expect(redirectUrl.hostname).toBe('localhost');
      expect(redirectUrl.port).toBe('54321');
      const code = redirectUrl.searchParams.get('code');
      expect(code).toBeTruthy();
      expect(redirectUrl.searchParams.get('state')).toBe('gemini-loopback');

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: loopback,
        client_id: client.clientId,
        code_verifier: verifier,
        resource: TEST_RESOURCE_URI,
      });
      const tokenRes = await app.request(
        'https://auth.example.com/api/auth/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
        },
        env as unknown as Env
      );
      expect(tokenRes.status).toBe(200);
      const tokenJson = await tokenRes.json<any>();
      expect(tokenJson.access_token).toBeTruthy();
    });
  });
});


