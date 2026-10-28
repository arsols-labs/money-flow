// OAuth 2.1 integration tests for machine clients.
//
// The tests check:
// - Discovery RFC 9728 (Protected Resource Metadata) and RFC 8414 (Authorization Server Metadata)
// - PKCE (S256), and validation of client_id, state, and redirect_uri
// - Protection of the consent page (anti-framing headers, CSRF tokens)
// - Issuing an authorization code and exchanging it for an access_token + refresh_token
// - Protection against reuse of an authorization code
// - Writing the audit rows to D1 (oauth_clients, oauth_consents, oauth_tokens)
// - Protection of the /mcp endpoint: 401 without a token, 200 with a valid token, 401 after revocation

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import {
  getOAuthHelpers,
  getOAuthProviderOptions,
  grantIdFromAuthorizeRedirect,
  grantIdPrefixFromCredential,
  isTrustedOAuthRedirectUri,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_OWNER_USER_ID,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  oauthConsentId,
  revokeOAuthTokenInDb,
} from '../src/worker/oauth';
import { logOAuth } from '../src/worker/oauth-log';
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

describe('grant id and token lifetime', () => {
  it('reads the grant id from the authorization code and ignores the secret', () => {
    expect(
      grantIdFromAuthorizeRedirect('https://example.com/cb?code=owner:abcDEF12:secret&state=s'),
    ).toBe('abcDEF12');
    expect(grantIdFromAuthorizeRedirect('https://example.com/cb?state=s')).toBeNull();
    expect(grantIdFromAuthorizeRedirect('https://example.com/cb?code=only-one-part')).toBeNull();
    expect(grantIdFromAuthorizeRedirect('https://example.com/cb?code=a:b:c:d')).toBeNull();
    expect(grantIdPrefixFromCredential('owner:abcd1234WXYZ5678:secret')).toBe('abcd1234');
    expect(grantIdPrefixFromCredential('not-a-token')).toBeUndefined();
  });

  it('omits tokens, state, and redirect queries from OAuth logs', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    try {
      logOAuth('warn', 'oauth.token_error', {
        code: 'invalid_grant',
        state: 'hidden-state',
        refresh_token: 'owner:abcd1234WXYZ5678:do-not-log',
        description:
          'see https://chat.openai.com/connector_platform_oauth_redirect?code=owner:abcd1234WXYZ5678:do-not-log',
      });
    } finally {
      spy.mockRestore();
    }
    const line = lines.join('\n');
    expect(line).toContain('invalid_grant');
    expect(line).not.toContain('hidden-state');
    expect(line).not.toContain('abcd1234WXYZ5678');
    expect(line).not.toContain('do-not-log');
    expect(line).not.toContain('?code=');
    expect(line).toContain('https://chat.openai.com/connector_platform_oauth_redirect');
  });

  it('sets a 90 day refresh TTL and keeps the 1 hour access TTL', () => {
    const options = getOAuthProviderOptions({ fetch: () => new Response('no') });
    expect(options.accessTokenTTL).toBe(OAUTH_ACCESS_TOKEN_TTL_SECONDS);
    expect(options.accessTokenTTL).toBe(3600);
    expect(options.refreshTokenTTL).toBe(OAUTH_REFRESH_TOKEN_TTL_SECONDS);
    expect(options.refreshTokenTTL).toBe(90 * 24 * 3600);
    expect(options.refreshTokenTTL).toBe(7776000);
  });
});

describe('isTrustedOAuthRedirectUri', () => {
  it('accepts an RFC 8252 loopback and Google Account Linking on the exact host', () => {
    expect(isTrustedOAuthRedirectUri('http://127.0.0.1:8080/callback')).toBe(true);
    expect(isTrustedOAuthRedirectUri('http://localhost:3000/callback')).toBe(true);
    expect(isTrustedOAuthRedirectUri('http://127.0.0.1/callback')).toBe(true);
    expect(isTrustedOAuthRedirectUri('https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1')).toBe(true);
    expect(isTrustedOAuthRedirectUri('https://developers.google.com/oauthredirect')).toBe(true);
    expect(isTrustedOAuthRedirectUri('https://gemini.google.com/oauth/callback')).toBe(true);
  });

  it('rejects userinfo, a foreign host, and a prefix-lookalike', () => {
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
    // Clear the D1 tables before each test
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_tokens'),
      env.DB.prepare('DELETE FROM oauth_consents'),
      env.DB.prepare('DELETE FROM oauth_clients'),
    ]);

    const setCookie = await createSessionCookie(env as unknown as Env, false);
    cookie = setCookie.split(';')[0]!;
  });

  describe('Discovery (RFC 9728 and RFC 8414)', () => {
    it('returns RFC 9728 Protected Resource Metadata at /.well-known/oauth-protected-resource', async () => {
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

    it('returns RFC 8414 Authorization Server Metadata at /.well-known/oauth-authorization-server', async () => {
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

    it('returns the same AS metadata at the OIDC and path-aware URLs; an unknown well-known is 404', async () => {
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

    it('returns path-aware Protected Resource Metadata at …/oauth-protected-resource/mcp', async () => {
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

  describe('Consent page and CSRF', () => {
    it('requires session-cookie authentication to open consent', async () => {
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

      // Without a session cookie — redirect to login
      const resUnauth = await app.request(authorizeUrl, undefined, env as unknown as Env);
      expect(resUnauth.status).toBe(302);
      expect(resUnauth.headers.get('Location')).toContain('/login?return_to=');

      // With a session cookie — 200 OK with the consent page
      const resAuth = await app.request(
        authorizeUrl,
        { headers: { Cookie: cookie } },
        env as unknown as Env
      );
      expect(resAuth.status).toBe(200);
      expect(resAuth.headers.get('X-Frame-Options')).toBe('DENY');
      const csp = resAuth.headers.get('Content-Security-Policy') || '';
      expect(csp).toContain("frame-ancestors 'none'");
      // form-action uses the https: scheme so a later https hop is not blocked.
      expect(csp).toContain("form-action 'self' https: http://localhost:* http://127.0.0.1:*");
      expect(csp).not.toContain('https://claude.ai');

      const html = await resAuth.text();
      expect(html).toContain('Claude Desktop');
      expect(html).toContain('https://claude.ai/oauth/callback');
      expect(html).toContain('read');
      expect(html).toContain('write');
      expect(html).toContain('name="csrf_token"');
    });

    it('does not trust a loopback redirect_uri that carries userinfo (open-redirect / theft of auth code)', async () => {
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

    it('rejects an invalid redirect_uri locally, with no redirect (protection against an open redirect)', async () => {
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

    it('accepts the exact registered Google Account Linking redirect_uri', async () => {
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

    it('successfully handles a consent-form POST with no query string in the URL', async () => {
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

      // The POST is sent to a clean URL with no query string
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

    it('checks that the CSRF token is valid and has not expired', async () => {
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

  describe('Full OAuth 2.1 flow (Code + PKCE + Token + Revoke)', () => {
    it('successfully issues a token, writes the audit to D1, and revokes access', async () => {
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

      // 1. GET request for the consent page
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

      // 2. POST confirming consent (Allow)
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

      // Check the D1 rows: oauth_clients, oauth_consents, oauth_tokens
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

      // 3. Exchange the authorization code for a token (POST /api/auth/oauth/token)
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
      expect(tokenJson.expires_in).toBe(3600);
      expect(tokenJson.scope).toBe('read write');
      const accessToken = tokenJson.access_token;

      // 4. Call the protected MCP route
      // Without a token -> 401
      const mcpUnauth = await app.request('https://auth.example.com/mcp', undefined, env as unknown as Env);
      expect(mcpUnauth.status).toBe(401);
      expect(mcpUnauth.headers.get('WWW-Authenticate')).toContain('Bearer');

      // With a valid token -> 200
      const mcpAuth = await app.request(
        'https://auth.example.com/mcp',
        { headers: { Authorization: `Bearer ${accessToken}` } },
        env as unknown as Env
      );
      expect(mcpAuth.status).toBe(200);

      // ALE-13: Check that the OAuth client ID is forwarded into the MCP context and the audit log
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
      // If the client is forwarded correctly, we get past the claim idempotency_key step
      // and do not fail with Error executing tool: Unable to claim idempotency_key.
      expect(writeResult.error).toBeUndefined();
      expect(writeResult.result).toBeDefined();
      
      const auditLog = await env.DB.prepare('SELECT client_id FROM mcp_audit_log WHERE client_id = ? AND tool_name = ? ORDER BY created_at DESC LIMIT 1')
        .bind(client.clientId, 'operation_add')
        .first<{ client_id: string }>();
      
      expect(auditLog).toBeDefined();
      expect(auditLog?.client_id).toBe(client.clientId);

      // 5. Reusing the code is forbidden (replay attack)
      // Per RFC 6749 §4.1.2, on a replay attempt the authorization server
      // rejects the request AND revokes the issued grant / tokens.
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

      // 6. After the replay is detected the token is revoked -> 401 on /mcp
      const mcpRevoked = await app.request(
        'https://auth.example.com/mcp',
        { headers: { Authorization: `Bearer ${accessToken}` } },
        env as unknown as Env
      );
      expect(mcpRevoked.status).toBe(401);

      // Revoke it in D1
      await revokeOAuthTokenInDb(env.DB, dbTokens.results[0].id);
      const revokedToken = await env.DB.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?')
        .bind(dbTokens.results[0].id)
        .first<{ revoked_at: string | null }>();
      expect(revokedToken?.revoked_at).not.toBeNull();
    });

    it('rejects the request when Deny is pressed (action=deny)', async () => {
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

    it('rejects a request with an invalid CSRF token', async () => {
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

    it('rejects an authorization request whose resource does not match (RFC 8707)', async () => {
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

      // On a resource mismatch there must be a redirect with error=invalid_target
      expect(res.status).toBe(302);
      const redirectUrl = new URL(res.headers.get('Location')!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_target');
    });

    it('issues a token only with the approved scopes (scope narrowing)', async () => {
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
      postForm.append('scope', 'read'); // read only
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
      // RFC 9207: a successful authorization response contains iss, byte for byte
      // equal to the issuer from the AS metadata (no trailing slash).
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
      expect(tokenJson.scope).toBe('read'); // only read was issued
    });

    it('rejects Allow when no scope is selected, instead of issuing the requested scopes', async () => {
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

    it('a second POST with the same CSRF returns 409 and creates a single grant', async () => {
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
      expect(second.status).toBe(409);
      expect(await second.text()).toContain('Already confirming. Return to the app.');
      const grants = await helpers.listUserGrants(OAUTH_OWNER_USER_ID);
      expect(grants.items.filter((grant) => grant.clientId === client.clientId)).toHaveLength(1);
      const tokens = await env.DB.prepare(
        'SELECT id, revoked_at FROM oauth_tokens WHERE client_id = ?',
      )
        .bind(client.clientId)
        .all<{ id: string; revoked_at: string | null }>();
      expect(tokens.results).toHaveLength(1);
      expect(tokens.results[0]!.revoked_at).toBeNull();
    });
  });

  describe('Loopback redirect URIs (Gemini CLI)', () => {
    it('keeps the localhost hostname in Location and accepts the original localhost at the token endpoint', async () => {
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

  describe('grant record when KV list lags', () => {
    function collectWaitUntil(): { ctx: ExecutionContext; done: () => Promise<void> } {
      const jobs: Promise<unknown>[] = [];
      const ctx = {
        waitUntil(promise: Promise<unknown>) {
          jobs.push(promise);
        },
        passThroughOnException() {},
      } as ExecutionContext;
      return {
        ctx,
        done: () => Promise.all(jobs).then(() => undefined),
      };
    }

    function envWithDb(db: D1Database): Env {
      return new Proxy(env as unknown as Env, {
        get(target, prop, receiver) {
          if (prop === 'DB') return db;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }

    function failBatchDb(real: D1Database, times = 1): D1Database {
      let left = times;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'batch') {
            return async (statements: D1PreparedStatement[]) => {
              if (left > 0) {
                left -= 1;
                throw new Error('simulated D1 batch failure');
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as D1Database;
    }

    async function allow(args: {
      clientId: string;
      redirectUri: string;
      state: string;
      challenge: string;
      scopes?: string[];
      testEnv?: Env;
      ctx?: ExecutionContext;
    }): Promise<Response> {
      const testEnv = args.testEnv ?? (env as unknown as Env);
      const authQuery = `response_type=code&client_id=${args.clientId}&redirect_uri=${encodeURIComponent(
        args.redirectUri,
      )}&scope=read%20write&state=${encodeURIComponent(args.state)}&code_challenge=${args.challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI,
      )}`;
      const getRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        testEnv,
      );
      expect(getRes.status, args.state).toBe(200);
      const csrf = (await getRes.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
      expect(csrf, args.state).toBeTruthy();
      const form = new FormData();
      form.append('csrf_token', csrf!);
      form.append('client_id', args.clientId);
      form.append('redirect_uri', args.redirectUri);
      form.append('state', args.state);
      for (const scope of args.scopes ?? ['read', 'write']) form.append('scope', scope);
      form.append('action', 'allow');
      return app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { method: 'POST', headers: { Cookie: cookie }, body: form },
        testEnv,
        args.ctx,
      );
    }

    it('still records the grant when KV list() cannot see the put()', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect?from=codex';
      const client = await helpers.createClient({
        clientName: 'ChatGPT',
        redirectUris: [redirectUri],
        tokenEndpointAuthMethod: 'none',
      });
      const hidden = new Set<string>();
      let listCalls = 0;
      const laggingKv = new Proxy(env.OAUTH_KV, {
        get(target, prop, receiver) {
          if (prop === 'put') {
            return async (key: string, value: string, options?: KVNamespacePutOptions) => {
              if (typeof key === 'string' && key.startsWith('grant:')) hidden.add(key);
              return target.put(key, value, options);
            };
          }
          if (prop === 'list') {
            return async (options?: KVNamespaceListOptions) => {
              listCalls += 1;
              const page = await target.list(options);
              return { ...page, keys: page.keys.filter((key) => !hidden.has(key.name)) };
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const laggingEnv = new Proxy(env as unknown as Env, {
        get(target, prop, receiver) {
          // Earlier provider requests stamp OAUTH_PROVIDER onto the shared env.
          // Hide it so this request builds helpers on the lagging KV.
          if (prop === 'OAUTH_PROVIDER') return undefined;
          if (prop === 'OAUTH_KV' || prop === 'KV') return laggingKv;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Env;
      const { challenge } = await generatePkce();
      const postRes = await allow({
        clientId: client.clientId,
        redirectUri,
        state: 'state-must-not-be-logged',
        challenge,
        testEnv: laggingEnv,
      });
      expect(postRes.status).toBe(302);
      const location = postRes.headers.get('Location')!;
      const grantId = grantIdFromAuthorizeRedirect(location);
      expect(grantId).toBeTruthy();
      expect(hidden.has(`grant:${OAUTH_OWNER_USER_ID}:${grantId}`)).toBe(true);

      const listed = await getOAuthHelpers(laggingEnv).listUserGrants(OAUTH_OWNER_USER_ID);
      expect(listCalls).toBeGreaterThan(0);
      expect(listed.items.some((grant) => grant.id === grantId)).toBe(false);
      const stored = await env.OAUTH_KV.get(`grant:${OAUTH_OWNER_USER_ID}:${grantId}`);
      expect(stored).toBeTruthy();

      const token = await env.DB.prepare('SELECT id, revoked_at FROM oauth_tokens WHERE client_id = ?')
        .bind(client.clientId)
        .first<{ id: string; revoked_at: string | null }>();
      expect(token?.id).toBe(grantId);
      expect(token?.revoked_at).toBeNull();
      const consent = await env.DB.prepare('SELECT id FROM oauth_consents WHERE client_id = ?')
        .bind(client.clientId)
        .first<{ id: string }>();
      expect(consent?.id).toBe(await oauthConsentId(client.clientId, redirectUri));
    });

    it('revokes only the new grant when the D1 batch fails', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const redirectUri = 'https://oauth-redirect.googleusercontent.com/r/money-flow';
      const client = await helpers.createClient({
        clientName: 'Google',
        redirectUris: [redirectUri],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();
      const first = await allow({
        clientId: client.clientId,
        redirectUri,
        state: 'old-grant',
        challenge,
      });
      expect(first.status).toBe(302);
      const oldGrantId = grantIdFromAuthorizeRedirect(first.headers.get('Location')!)!;
      expect(oldGrantId).toBeTruthy();

      const failed = await allow({
        clientId: client.clientId,
        redirectUri,
        state: 'new-grant-fails',
        challenge,
        testEnv: envWithDb(failBatchDb(env.DB)),
      });
      expect(failed.status).toBe(503);
      const body = await failed.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('OAUTH_GRANT_RECORD_FAILED');

      const grants = await helpers.listUserGrants(OAUTH_OWNER_USER_ID);
      const mine = grants.items.filter((grant) => grant.clientId === client.clientId);
      expect(mine.map((grant) => grant.id)).toEqual([oldGrantId]);
      const tokens = await env.DB.prepare(
        'SELECT id, revoked_at FROM oauth_tokens WHERE client_id = ?',
      )
        .bind(client.clientId)
        .all<{ id: string; revoked_at: string | null }>();
      expect(tokens.results).toEqual([{ id: oldGrantId, revoked_at: null }]);
    });

    it('retries after a failed batch and keeps one consent row', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const client = await helpers.createClient({
        clientName: 'Claude',
        redirectUris: [redirectUri],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();
      const first = await allow({
        clientId: client.clientId,
        redirectUri,
        state: 'retry-first',
        challenge,
      });
      expect(first.status).toBe(302);
      const oldGrantId = grantIdFromAuthorizeRedirect(first.headers.get('Location')!)!;
      const consentId = await oauthConsentId(client.clientId, redirectUri);

      const db = failBatchDb(env.DB, 1);
      const failed = await allow({
        clientId: client.clientId,
        redirectUri,
        state: 'retry-fail',
        challenge,
        testEnv: envWithDb(db),
      });
      expect(failed.status).toBe(503);

      const waiter = collectWaitUntil();
      const retried = await allow({
        clientId: client.clientId,
        redirectUri,
        state: 'retry-ok',
        challenge,
        scopes: ['read'],
        testEnv: envWithDb(db),
        ctx: waiter.ctx,
      });
      expect(retried.status).toBe(302);
      const newGrantId = grantIdFromAuthorizeRedirect(retried.headers.get('Location')!)!;
      expect(newGrantId).not.toBe(oldGrantId);
      await waiter.done();

      const consents = await env.DB.prepare(
        'SELECT id, scopes FROM oauth_consents WHERE client_id = ?',
      )
        .bind(client.clientId)
        .all<{ id: string; scopes: string }>();
      expect(consents.results).toEqual([{ id: consentId, scopes: JSON.stringify(['read']) }]);
      const clients = await env.DB.prepare('SELECT id FROM oauth_clients WHERE id = ?')
        .bind(client.clientId)
        .all();
      expect(clients.results).toHaveLength(1);

      const grants = await helpers.listUserGrants(OAUTH_OWNER_USER_ID);
      const mine = grants.items.filter((grant) => grant.clientId === client.clientId);
      expect(mine.map((grant) => grant.id)).toEqual([newGrantId]);
      const oldRow = await env.DB.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?')
        .bind(oldGrantId)
        .first<{ revoked_at: string | null }>();
      expect(oldRow?.revoked_at).not.toBeNull();
      const newRow = await env.DB.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?')
        .bind(newGrantId)
        .first<{ revoked_at: string | null }>();
      expect(newRow?.revoked_at).toBeNull();
    });

    it('does not log the authorization code, state, or redirect query', async () => {
      const lines: string[] = [];
      const spies = (['info', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((message?: unknown) => {
          lines.push(String(message));
        }),
      );
      try {
        const helpers = getOAuthHelpers(env as unknown as Env);
        const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect?from=codex';
        const client = await helpers.createClient({
          clientName: 'ChatGPT logs',
          redirectUris: [redirectUri],
          tokenEndpointAuthMethod: 'none',
        });
        const { challenge } = await generatePkce();
        const state = 'state-must-not-be-logged';
        const postRes = await allow({
          clientId: client.clientId,
          redirectUri,
          state,
          challenge,
        });
        expect(postRes.status).toBe(302);
        const location = postRes.headers.get('Location')!;
        const code = new URL(location).searchParams.get('code')!;
        const blob = lines.join('\n');
        expect(blob).toContain('oauth.consent_shown');
        expect(blob).toContain('oauth.redirect_sent');
        expect(blob).not.toContain(code);
        expect(blob).not.toContain(code.split(':')[2]!);
        expect(blob).not.toContain(state);
        expect(blob).not.toContain(redirectUri);
        expect(blob).not.toContain('from=codex');
        expect(blob).not.toContain('access_token');
        expect(blob).not.toContain('refresh_token');
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('releases the CSRF marker when the grant record fails', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const redirectUri = 'https://example.com/oauth/callback';
      const client = await helpers.createClient({
        clientName: 'Retry same form',
        redirectUris: [redirectUri],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();
      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=read%20write&state=retry-same&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI,
      )}`;
      const getRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect(getRes.status).toBe(200);
      const csrf = (await getRes.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();
      // The first batch throws. The same database then accepts the retry.
      const db = failBatchDb(env.DB, 1);
      const formFor = () => {
        const form = new FormData();
        form.append('csrf_token', csrf!);
        form.append('client_id', client.clientId);
        form.append('redirect_uri', redirectUri);
        form.append('state', 'retry-same');
        form.append('scope', 'read');
        form.append('action', 'allow');
        return form;
      };
      const failed = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { method: 'POST', headers: { Cookie: cookie }, body: formFor() },
        envWithDb(db),
      );
      expect(failed.status).toBe(503);
      const retried = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { method: 'POST', headers: { Cookie: cookie }, body: formFor() },
        envWithDb(db),
      );
      expect(retried.status).toBe(302);
      expect(new URL(retried.headers.get('Location')!).searchParams.get('code')).toBeTruthy();
    });

    it('retires only older grants for the same client and redirect URI', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const chatgpt = 'https://chatgpt.com/connector_platform_oauth_redirect';
      const google = 'https://oauth-redirect.googleusercontent.com/r/money-flow';
      const claude = 'https://claude.ai/api/mcp/auth_callback';
      const clientA = await helpers.createClient({
        clientName: 'ChatGPT and Google',
        redirectUris: [chatgpt, google],
        tokenEndpointAuthMethod: 'none',
      });
      const clientB = await helpers.createClient({
        clientName: 'Claude',
        redirectUris: [claude],
        tokenEndpointAuthMethod: 'none',
      });
      const { challenge } = await generatePkce();
      const first = await allow({
        clientId: clientA.clientId,
        redirectUri: chatgpt,
        state: 'chatgpt-old',
        challenge,
      });
      expect(first.status).toBe(302);
      const chatgptGrantId = grantIdFromAuthorizeRedirect(first.headers.get('Location')!)!;
      const googleRes = await allow({
        clientId: clientA.clientId,
        redirectUri: google,
        state: 'google',
        challenge,
      });
      expect(googleRes.status).toBe(302);
      expect(googleRes.headers.get('Location')).toMatch(
        /^https:\/\/oauth-redirect\.googleusercontent\.com\//,
      );
      const googleGrantId = grantIdFromAuthorizeRedirect(googleRes.headers.get('Location')!)!;
      const otherClient = await allow({
        clientId: clientB.clientId,
        redirectUri: claude,
        state: 'claude',
        challenge,
      });
      expect(otherClient.status).toBe(302);
      const claudeGrantId = grantIdFromAuthorizeRedirect(otherClient.headers.get('Location')!)!;

      const waiter = collectWaitUntil();
      const again = await allow({
        clientId: clientA.clientId,
        redirectUri: chatgpt,
        state: 'chatgpt-new',
        challenge,
        ctx: waiter.ctx,
      });
      expect(again.status).toBe(302);
      expect(again.headers.get('Location')).toMatch(/^https:\/\/chatgpt\.com\//);
      const newChatgptGrantId = grantIdFromAuthorizeRedirect(again.headers.get('Location')!)!;
      await waiter.done();

      const grants = await helpers.listUserGrants(OAUTH_OWNER_USER_ID);
      const idsFor = (clientId: string) =>
        grants.items.filter((grant) => grant.clientId === clientId).map((grant) => grant.id);
      expect(idsFor(clientA.clientId)).toHaveLength(2);
      expect(idsFor(clientA.clientId)).toEqual(
        expect.arrayContaining([googleGrantId, newChatgptGrantId]),
      );
      expect(idsFor(clientA.clientId)).not.toContain(chatgptGrantId);
      expect(idsFor(clientB.clientId)).toEqual([claudeGrantId]);

      const revoked = async (id: string) =>
        (
          await env.DB.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?')
            .bind(id)
            .first<{ revoked_at: string | null }>()
        )?.revoked_at;
      expect(await revoked(chatgptGrantId)).not.toBeNull();
      expect(await revoked(googleGrantId)).toBeNull();
      expect(await revoked(claudeGrantId)).toBeNull();
      expect(await revoked(newChatgptGrantId)).toBeNull();
    });
  });

  describe('token endpoint errors', () => {
    it('logs refresh_token invalid_grant with a grant-id prefix and not the token', async () => {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const client = await helpers.createClient({
        clientName: 'codex-mcp-client',
        redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        tokenEndpointAuthMethod: 'none',
      });
      const grantId = 'abcd1234WXYZ5678';
      const refreshToken = `owner:${grantId}:do-not-log-this-secret`;
      const lines: string[] = [];
      const spies = (['info', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((message?: unknown) => {
          lines.push(String(message));
        }),
      );
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: client.clientId,
        });
        const res = await app.request(
          'https://auth.example.com/api/auth/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          },
          env as unknown as Env,
        );
        expect(res.status).toBe(400);
        const json = await res.json<{ error: string; error_description: string }>();
        expect(json.error).toBe('invalid_grant');
        expect(json.error_description).toBe('Grant not found');
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const parsed = lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const tokenLogs = parsed.filter((entry) => entry.event === 'oauth.token_error');
      expect(tokenLogs.length).toBeGreaterThan(0);
      const log = tokenLogs[0]!;
      expect(log.grantType).toBe('refresh_token');
      expect(log.clientId).toBe(client.clientId);
      expect(log.grantIdPrefix).toBe('abcd1234');
      expect(log.reason).toBe('grant_not_found');
      expect(log.code).toBe('invalid_grant');
      const blob = lines.join('\n');
      expect(blob).not.toContain(refreshToken);
      expect(blob).not.toContain(grantId);
      expect(blob).not.toContain('do-not-log-this-secret');
    });
  });

  // workers-oauth-provider 1.2.4 (https://github.com/cloudflare/workers-oauth-provider/pull/415): a refresh of a grant bound to a resource
  // this server no longer serves is invalid_grant (re-authorize), not invalid_target.
  describe('refresh and resource binding (workers-oauth-provider 1.2.4)', () => {
    async function issueTokens(state: string) {
      const helpers = getOAuthHelpers(env as unknown as Env);
      const redirectUri = 'https://cursor.com/callback';
      const client = await helpers.createClient({
        clientName: 'Cursor',
        redirectUris: [redirectUri],
        tokenEndpointAuthMethod: 'none',
      });
      const { verifier, challenge } = await generatePkce();
      const authQuery = `response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=read%20write&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(
        TEST_RESOURCE_URI,
      )}`;
      const getRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { headers: { Cookie: cookie } },
        env as unknown as Env,
      );
      expect(getRes.status).toBe(200);
      const csrf = (await getRes.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();
      const form = new FormData();
      form.append('csrf_token', csrf!);
      form.append('client_id', client.clientId);
      form.append('redirect_uri', redirectUri);
      form.append('state', state);
      form.append('scope', 'read write');
      form.append('action', 'allow');
      const postRes = await app.request(
        `https://auth.example.com/api/auth/oauth/authorize?${authQuery}`,
        { method: 'POST', headers: { Cookie: cookie }, body: form },
        env as unknown as Env,
      );
      expect(postRes.status).toBe(302);
      const code = new URL(postRes.headers.get('Location')!).searchParams.get('code');
      expect(code).toBeTruthy();
      const tokenRes = await token('https://auth.example.com', {
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
        resource: TEST_RESOURCE_URI,
      });
      expect(tokenRes.status).toBe(200);
      const json = await tokenRes.json<{ access_token: string; refresh_token: string }>();
      expect(json.refresh_token).toBeTruthy();
      return { clientId: client.clientId, refreshToken: json.refresh_token };
    }

    function token(origin: string, params: Record<string, string>) {
      return app.request(
        `${origin}/api/auth/oauth/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        },
        env as unknown as Env,
      );
    }

    it('refreshes a grant that names its own resource, then rotates the refresh token', async () => {
      const { clientId, refreshToken } = await issueTokens('refresh-ok');
      const res = await token('https://auth.example.com', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource: TEST_RESOURCE_URI,
      });
      expect(res.status).toBe(200);
      const json = await res.json<{ access_token: string; refresh_token: string }>();
      expect(json.access_token).toBeTruthy();
      expect(json.refresh_token).toBeTruthy();
      expect(json.refresh_token).not.toBe(refreshToken);

      const mcp = await app.request(
        'https://auth.example.com/mcp',
        { headers: { Authorization: `Bearer ${json.access_token}` } },
        env as unknown as Env,
      );
      expect(mcp.status).toBe(200);

      const again = await token('https://auth.example.com', {
        grant_type: 'refresh_token',
        refresh_token: json.refresh_token,
        client_id: clientId,
      });
      expect(again.status).toBe(200);
    });

    it('keeps invalid_target when a valid grant names a resource the server does not host', async () => {
      const { clientId, refreshToken } = await issueTokens('refresh-foreign');
      const res = await token('https://auth.example.com', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource: 'https://foreign-resource.example.com/mcp',
      });
      expect(res.status).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe('invalid_target');

      // Nothing was written: the same refresh token still works.
      const ok = await token('https://auth.example.com', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      expect(ok.status).toBe(200);
    });

    it('returns invalid_grant when the grant is bound to a resource this origin no longer serves', async () => {
      // The resource is derived from the request origin. A grant issued on one
      // origin and refreshed on another is bound to a resource the second origin
      // does not serve, which is how a dropped resource looks to the provider.
      const { clientId, refreshToken } = await issueTokens('refresh-dropped');
      const res = await token('https://moved.example.com', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource: TEST_RESOURCE_URI,
      });
      expect(res.status).toBe(400);
      const json = await res.json<{ error: string; error_description: string }>();
      expect(json.error).toBe('invalid_grant');
      expect(json.error_description).toContain('no longer serves');
    });
  });
});
