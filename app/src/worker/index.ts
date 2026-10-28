import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import {
  registrationOptions,
  registrationVerify,
  authenticationOptions,
  authenticationVerify,
  createSessionCookie,
  clearSessionCookie,
  revokeSessionCookie,
  verifySessionCookie,
  hasCredentials,
  resolveOrigin,
  resolveRpID,
  isAllowedOrigin,
  parseCeremonyId,
  ceremonyCookie,
} from './auth';
import apiV2 from './api';
import mcpApp from './mcp-server';
import {
  createOAuthProvider,
  getOAuthHelpers,
  grantIdFromAuthorizeRedirect,
  isRegisteredRedirectOrLoopbackVariant,
  recordOAuthGrantAtomic,
  revokeOlderGrantsForClient,
  tokenRequestLogFields,
  type TokenErrorLogFields,
  OAUTH_OWNER_USER_ID,
  OAUTH_SCOPES_SUPPORTED,
  AuthorizationError,
  type AuthRequest,
} from './oauth';
import { browserMutationRejection } from './csrf';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import {
  CONSENT_ONCE_TTL_SECONDS,
  consentOnceKey,
  createConsentCsrfToken,
  verifyConsentCsrfToken,
  extractClientHost,
  renderConsentHtml,
} from './oauth-consent';
import { errInfo, logOAuth } from './oauth-log';
import { AppError, fail, failCaught } from './api-error';
import { timingSafeEqualString } from './crypto-eq';
import { clientIpFromHeaders, consumeRateLimit, RATE_LIMITS, type RateLimitBinding } from './rate-limit';
import { consentSecurityHeaders, workerSecurityHeaders } from './security-headers';
import { clearDemoSessionCookie } from './demo-cookie';
import { DEMO_DISCLAIMER, isDemoMode } from './demo-flag';
import { maybeDemoFetch } from './demo-request';
import { DemoSession } from './demo-session';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof AppError) return failCaught(c, err);
  return fail(c, 'OPERATION_FAILED', 500);
});

app.use('*', async (c, next) => {
  await next();
  const extra = workerSecurityHeaders();
  if (!c.res.headers.has('X-Content-Type-Options')) {
    c.res.headers.set('X-Content-Type-Options', extra['X-Content-Type-Options']);
  }
  if (!c.res.headers.has('Referrer-Policy')) {
    c.res.headers.set('Referrer-Policy', extra['Referrer-Policy']);
  }
});

function rateLimitBinding(
  env: Env,
  kind: keyof typeof RATE_LIMITS,
): RateLimitBinding | undefined {
  switch (kind) {
    case 'oauthRegister':
      return env.RATE_LIMIT_OAUTH_REGISTER;
    case 'authSetup':
      return env.RATE_LIMIT_AUTH_SETUP;
    case 'authLogin':
      return env.RATE_LIMIT_AUTH_LOGIN;
    case 'mcpDispatch':
      return env.RATE_LIMIT_MCP_DISPATCH;
    case 'demoSession':
      return env.RATE_LIMIT_DEMO_SESSION;
    default:
      return undefined;
  }
}

async function rejectIfRateLimited(
  c: Context<{ Bindings: Env }>,
  kind: keyof typeof RATE_LIMITS,
) {
  const spec = RATE_LIMITS[kind];
  const ip = clientIpFromHeaders((name) => c.req.header(name));
  const decision = await consumeRateLimit(
    `${kind}:${ip}`,
    spec.limit,
    spec.windowSec,
    rateLimitBinding(c.env, kind),
  );
  if (decision.allowed) return null;
  const res = fail(c, 'RATE_LIMITED', 429);
  res.headers.set('Retry-After', String(decision.retryAfterSec));
  return res;
}

// CORS middleware with origin validation (origin-spoofing protection)
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      if (!origin) return origin;
      return isAllowedOrigin(origin, c) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Money-Flow'],
    credentials: true,
  }),
);

app.use(
  '/mcp',
  cors({
    origin: (origin, c) => {
      if (!origin) return origin;
      return isAllowedOrigin(origin, c) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(
  '/mcp/*',
  cors({
    origin: (origin, c) => {
      if (!origin) return origin;
      return isAllowedOrigin(origin, c) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

function validSetupToken(env: Env, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || !env.SETUP_TOKEN) return false;
  return timingSafeEqualString(token, env.SETUP_TOKEN);
}

// ---------- WebAuthn ----------

app.get('/api/config', (c) => {
  if (!isDemoMode(c.env)) return c.json({ demoMode: false });
  return c.json({ demoMode: true, disclaimer: DEMO_DISCLAIMER });
});

async function setupPasskeyDocument(c: Context<{ Bindings: Env }>) {
  if (isDemoMode(c.env)) return fail(c, 'DEMO_PASSKEY_DISABLED', 403);
  return c.env.ASSETS.fetch(c.req.raw);
}

app.all('/setup/passkey', setupPasskeyDocument);
app.all('/setup/passkey/', setupPasskeyDocument);

app.post('/api/auth/register/options', async (c) => {
  const limited = await rejectIfRateLimited(c, 'authSetup');
  if (limited) return limited;
  if (isDemoMode(c.env)) return fail(c, 'DEMO_PASSKEY_DISABLED', 403);
  const body = await c.req.json().catch(() => ({}));
  if (!validSetupToken(c.env, body.token)) return fail(c, 'FORBIDDEN', 403);
  const options = await registrationOptions(c.env, resolveRpID(c));
  c.header('Set-Cookie', ceremonyCookie(options.ceremonyId, resolveOrigin(c).startsWith('https')));
  return c.json(options);
});

app.post('/api/auth/register/verify', async (c) => {
  const limited = await rejectIfRateLimited(c, 'authSetup');
  if (limited) return limited;
  if (isDemoMode(c.env)) return fail(c, 'DEMO_PASSKEY_DISABLED', 403);
  const body = await c.req.json().catch(() => ({}));
  if (!validSetupToken(c.env, body.token)) return fail(c, 'FORBIDDEN', 403);
  const currentOrigin = resolveOrigin(c);
  const verified = await registrationVerify(
    c.env,
    resolveRpID(c),
    currentOrigin,
    body.response,
    body.label ?? '',
    parseCeremonyId(c.req.header('Cookie')),
  );
  if (!verified) return fail(c, 'INVALID_CREDENTIALS', 400);
  // Sign in the device that just registered the passkey.
  c.header('Set-Cookie', await createSessionCookie(c.env, currentOrigin.startsWith('https')));
  return c.json({ verified: true });
});

app.post('/api/auth/login/options', async (c) => {
  const limited = await rejectIfRateLimited(c, 'authLogin');
  if (limited) return limited;
  const options = await authenticationOptions(c.env, resolveRpID(c));
  c.header('Set-Cookie', ceremonyCookie(options.ceremonyId, resolveOrigin(c).startsWith('https')));
  return c.json(options);
});

app.post('/api/auth/login/verify', async (c) => {
  const limited = await rejectIfRateLimited(c, 'authLogin');
  if (limited) return limited;
  const body = await c.req.json().catch(() => ({}));
  const currentOrigin = resolveOrigin(c);
  const verified = await authenticationVerify(
    c.env,
    resolveRpID(c),
    currentOrigin,
    body.response,
    parseCeremonyId(c.req.header('Cookie')),
  );
  if (!verified) return fail(c, 'INVALID_CREDENTIALS', 400);
  c.header('Set-Cookie', await createSessionCookie(c.env, currentOrigin.startsWith('https'), { cid: verified }));
  return c.json({ verified: true });
});

app.get('/api/auth/me', async (c) => {
  const demoMode = isDemoMode(c.env);
  const authenticated = await verifySessionCookie(c.env, c.req.header('Cookie'));
  return c.json({
    authenticated,
    hasPasskeys: demoMode ? false : await hasCredentials(c.env),
    demoMode,
  });
});

app.post('/api/auth/logout', async (c) => {
  const csrf = browserMutationRejection(c.req.method, c.req.url, {
    origin: c.req.header('Origin'),
    secFetchSite: c.req.header('Sec-Fetch-Site'),
    contentType: c.req.header('Content-Type'),
    requestedWith: c.req.header('X-Money-Flow'),
  });
  if (csrf) {
    return fail(c, csrf, csrf === 'CONTENT_TYPE_INVALID' ? 415 : 403);
  }
  const cookieHeader = c.req.header('Cookie');
  try {
    await revokeSessionCookie(c.env, cookieHeader);
  } catch {
    return fail(c, 'LOGOUT_REVOKE_FAILED', 503);
  }
  const currentOrigin = resolveOrigin(c);
  const secure = currentOrigin.startsWith('https');
  c.header('Set-Cookie', clearSessionCookie(secure));
  if (isDemoMode(c.env)) {
    c.header('Set-Cookie', clearDemoSessionCookie(secure), { append: true });
  }
  return c.body(null, 204);
});

// ---------- OAuth 2.1 Provider & Consent (S2-1, issue #261) ----------

function oauthRequestId(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  return c.req.header('cf-ray') || undefined;
}

function oauthRedirectHost(redirectUri: string): string | undefined {
  try {
    const host = new URL(redirectUri).host;
    return host || undefined;
  } catch {
    return undefined;
  }
}

function oauthKv(env: Env): KVNamespace {
  return env.OAUTH_KV || env.KV;
}

const CONSENT_ALREADY_CONFIRMING_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Already confirming</title></head><body><p>Already confirming. Return to the app.</p></body></html>';

async function getTrustedOAuthHelpers(env: Env, rawRequest: Request): Promise<OAuthHelpers> {
  let clientId: string | null = null;
  let redirectUri: string | null = null;

  try {
    const url = new URL(rawRequest.url);
    clientId = url.searchParams.get('client_id');
    redirectUri = url.searchParams.get('redirect_uri');

    if (!clientId || !redirectUri) {
      const cloned = rawRequest.clone();
      const contentType = cloned.headers.get('content-type') || '';
      if (
        contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('multipart/form-data') ||
        contentType.includes('application/json')
      ) {
        let body: any = {};
        if (contentType.includes('application/json')) {
          body = await cloned.json().catch(() => ({}));
        } else {
          const formData = await cloned.formData().catch(() => null);
          if (formData) {
            body = Object.fromEntries(formData.entries());
          }
        }
        clientId = clientId || (typeof body.client_id === 'string' ? body.client_id : null);
        redirectUri = redirectUri || (typeof body.redirect_uri === 'string' ? body.redirect_uri : null);
      }
    }
  } catch (e) {
    console.error('getTrustedOAuthHelpers parse error:', e);
  }

  const kv = env.OAUTH_KV || env.KV;
  const requestOrigin = resolveOrigin({ req: rawRequest, env });

  if (!clientId || !redirectUri) {
    return env.OAUTH_PROVIDER || getOAuthHelpers(env, requestOrigin);
  }

  // Never persist redirect URIs from an authorization request. RFC 8252 allows
  // only an in-memory port variation of an already-registered loopback URI.
  const proxyKv = new Proxy(kv, {
    get: (target, prop) => {
      if (prop === 'get') {
        return async (key: string, options?: any) => {
          const res = await target.get(key, options);
          if (res && key === `client:${clientId}`) {
            const isJson = options && typeof options === 'object' && options.type === 'json';
            try {
              let obj = isJson ? res : JSON.parse(res as string);
              if (
                Array.isArray(obj.redirectUris)
                && isRegisteredRedirectOrLoopbackVariant(obj.redirectUris, redirectUri)
                && !obj.redirectUris.includes(redirectUri)
              ) {
                obj = { ...obj, redirectUris: [...obj.redirectUris, redirectUri] };
              }
              return isJson ? obj : JSON.stringify(obj);
            } catch {
              return res;
            }
          }
          return res;
        };
      }
      const val = (target as any)[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });

  const proxyEnv = new Proxy(env, {
    get: (target, prop) => {
      if (prop === 'OAUTH_KV' || prop === 'KV') return proxyKv;
      const val = (target as any)[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });

  return env.OAUTH_PROVIDER || getOAuthHelpers(proxyEnv, requestOrigin);
}

const OAUTH_AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
const OAUTH_PR_METADATA_PREFIX = '/.well-known/oauth-protected-resource';

function normalizeWellKnownPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/** Paths that workers-oauth-provider handles itself, without defaultHandler. */
function providerHandlesWellKnown(pathname: string): boolean {
  return (
    pathname === OAUTH_AS_METADATA_PATH ||
    pathname === OAUTH_PR_METADATA_PREFIX ||
    pathname.startsWith(`${OAUTH_PR_METADATA_PREFIX}/`)
  );
}

/**
 * Clients such as Gemini request OIDC / path-aware authorization-server
 * metadata. The provider only knows the exact RFC 8414 path. Anything else
 * through defaultHandler = app.fetch recurses and returns 500. These aliases
 * return the same authorization-server JSON.
 */
function isAuthorizationServerMetadataAlias(pathname: string): boolean {
  const path = normalizeWellKnownPath(pathname);
  return (
    path === '/.well-known/openid-configuration' ||
    path === '/.well-known/openid-configuration/mcp' ||
    path === '/.well-known/oauth-authorization-server/mcp' ||
    path === OAUTH_AS_METADATA_PATH
  );
}

app.get('/api/auth/oauth/authorize', async (c) => {
  const reqToParse = c.req.raw;
  const oauthHelpers = await getTrustedOAuthHelpers(c.env, reqToParse);

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await oauthHelpers.parseAuthRequest(reqToParse);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (!error.redirectUri) {
        return new Response(error.description, {
          status: 400,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...consentSecurityHeaders(),
          },
        });
      }
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set('error', error.code);
      redirect.searchParams.set('error_description', error.description);
      if (error.state) redirect.searchParams.set('state', error.state);
      if (error.issuer) redirect.searchParams.set('iss', error.issuer);
      return c.redirect(redirect.toString(), 302);
    }
    throw error;
  }

  const authenticated = await verifySessionCookie(c.env, c.req.header('Cookie'));
  if (!authenticated) {
    const returnUrl = encodeURIComponent(c.req.url);
    return c.redirect(`/login?return_to=${returnUrl}`, 302);
  }

  const client = await oauthHelpers.lookupClient(oauthRequest.clientId);
  if (!client) {
    return new Response('Unknown OAuth client', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...consentSecurityHeaders(),
      },
    });
  }

  const clientHost = extractClientHost(oauthRequest.clientId);
  const csrfToken = await createConsentCsrfToken(c.env.SESSION_SECRET, {
    clientId: oauthRequest.clientId,
    redirectUri: oauthRequest.redirectUri,
    state: oauthRequest.state,
  });

  const html = renderConsentHtml({
    clientId: oauthRequest.clientId,
    clientName: client.clientName || oauthRequest.clientId,
    clientHost,
    redirectUri: oauthRequest.redirectUri,
    scope: oauthRequest.scope.length > 0 ? oauthRequest.scope : ['read', 'write'],
    state: oauthRequest.state,
    csrfToken,
    resource: oauthRequest.resource,
    responseType: oauthRequest.responseType,
    codeChallenge: oauthRequest.codeChallenge,
    codeChallengeMethod: oauthRequest.codeChallengeMethod,
    actionUrl: c.req.url,
  }, {
    cookieHeader: c.req.header('Cookie'),
    acceptLanguage: c.req.header('Accept-Language'),
  });

  logOAuth('info', 'oauth.consent_shown', {
    clientId: oauthRequest.clientId,
    redirectHost: oauthRedirectHost(oauthRequest.redirectUri),
    reqId: oauthRequestId(c),
  });

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Document CSP must allow navigating to redirect_uri after form POST (#561).
      ...consentSecurityHeaders(oauthRequest.redirectUri),
    },
  });
});

app.post('/api/auth/oauth/authorize', async (c) => {
  const reqToParseInitial = c.req.raw;
  const oauthHelpers = await getTrustedOAuthHelpers(c.env, reqToParseInitial);

  const authenticated = await verifySessionCookie(c.env, c.req.header('Cookie'));
  if (!authenticated) {
    return fail(c, 'UNAUTHORIZED', 401);
  }

  const contentType = c.req.header('content-type') || '';
  let body: Record<string, any> = {};
  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    body = await c.req.parseBody({ all: true });
  } else {
    body = await c.req.json().catch(() => ({}));
  }

  let reqToParse = reqToParseInitial;
  const currentUrl = new URL(reqToParseInitial.url);
  if (!currentUrl.searchParams.has('client_id') && body.client_id) {
    const authUrl = new URL(reqToParseInitial.url);
    for (const [k, v] of Object.entries(body)) {
      if (k === 'csrf_token' || k === 'action') continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          authUrl.searchParams.append(k, String(item));
        }
      } else if (v !== undefined && v !== null && v !== '') {
        authUrl.searchParams.set(k, String(v));
      }
    }
    reqToParse = new Request(authUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
    });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await oauthHelpers.parseAuthRequest(reqToParse);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (!error.redirectUri) {
        return new Response(error.description, {
          status: 400,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...consentSecurityHeaders(),
          },
        });
      }
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set('error', error.code);
      redirect.searchParams.set('error_description', error.description);
      if (error.state) redirect.searchParams.set('state', error.state);
      if (error.issuer) redirect.searchParams.set('iss', error.issuer);
      return c.redirect(redirect.toString(), 302);
    }
    throw error;
  }

  const clientId = String(body.client_id || oauthRequest.clientId);
  const redirectUri = String(body.redirect_uri || oauthRequest.redirectUri);
  const state = String(body.state || oauthRequest.state);
  const csrfToken = String(body.csrf_token || '');
  const action = String(body.action || 'allow');

  const validCsrf = await verifyConsentCsrfToken(
    c.env.SESSION_SECRET,
    csrfToken,
    { clientId, redirectUri, state }
  );

  if (!validCsrf) {
    return new Response('Invalid or expired CSRF token', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...consentSecurityHeaders(),
      },
    });
  }

  logOAuth('info', 'oauth.consent_submit', {
    action,
    clientId,
    redirectHost: oauthRedirectHost(redirectUri),
    reqId: oauthRequestId(c),
  });

  if (action === 'deny') {
    const redirect = new URL(oauthRequest.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', 'User denied access');
    if (oauthRequest.state) redirect.searchParams.set('state', oauthRequest.state);
    if (oauthRequest.issuer) redirect.searchParams.set('iss', oauthRequest.issuer);
    return c.redirect(redirect.toString(), 302);
  }

  const client = await oauthHelpers.lookupClient(oauthRequest.clientId);
  if (!client) {
    return new Response('Unknown OAuth client', { status: 400 });
  }

  const rawScopes = body.scope;
  let selectedScopes: string[] = [];
  if (Array.isArray(rawScopes)) {
    selectedScopes = rawScopes.flatMap((s) => String(s).split(/\s+/)).filter(Boolean);
  } else if (typeof rawScopes === 'string') {
    selectedScopes = rawScopes.split(/\s+/).filter(Boolean);
  }

  const grantedScopes = selectedScopes.filter((s) => OAUTH_SCOPES_SUPPORTED.includes(s));
  if (grantedScopes.length === 0) {
    const redirect = new URL(oauthRequest.redirectUri);
    redirect.searchParams.set('error', 'invalid_scope');
    redirect.searchParams.set('error_description', 'No scopes granted');
    if (oauthRequest.state) redirect.searchParams.set('state', oauthRequest.state);
    if (oauthRequest.issuer) redirect.searchParams.set('iss', oauthRequest.issuer);
    return c.redirect(redirect.toString(), 302);
  }

  const onceKey = consentOnceKey(csrfToken);
  if (!onceKey) {
    return new Response('Invalid or expired CSRF token', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...consentSecurityHeaders(),
      },
    });
  }
  const seen = await oauthKv(c.env).get(onceKey);
  if (seen) {
    logOAuth('warn', 'oauth.duplicate_submit', {
      clientId: client.clientId,
      redirectHost: oauthRedirectHost(oauthRequest.redirectUri),
      reqId: oauthRequestId(c),
    });
    return new Response(CONSENT_ALREADY_CONFIRMING_HTML, {
      status: 409,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...consentSecurityHeaders(),
      },
    });
  }
  await oauthKv(c.env).put(onceKey, '1', { expirationTtl: CONSENT_ONCE_TTL_SECONDS });

  let grantId: string | null = null;
  try {
    const { redirectTo } = await oauthHelpers.completeAuthorization({
      request: oauthRequest,
      userId: OAUTH_OWNER_USER_ID,
      // Do not revoke a working grant before the new one is recorded.
      revokeExistingGrants: false,
      metadata: {
        clientName: client.clientName || client.clientId,
        clientHost: extractClientHost(client.clientId),
      },
      scope: grantedScopes,
      props: {
        userId: OAUTH_OWNER_USER_ID,
        scopes: grantedScopes,
        clientId: client.clientId,
      },
    });

    grantId = grantIdFromAuthorizeRedirect(redirectTo);
    if (!grantId) throw new Error('auth code has no grant id');
    logOAuth('info', 'oauth.grant_created', {
      reqId: oauthRequestId(c),
      clientId: client.clientId,
      grantId,
    });

    const isUrl = client.clientId.startsWith('https://');
    await recordOAuthGrantAtomic(c.env.DB, {
      grantId,
      clientId: client.clientId,
      clientName: client.clientName || client.clientId,
      metadataUrl: isUrl ? client.clientId : undefined,
      scopes: grantedScopes,
      redirectUri: oauthRequest.redirectUri,
      ip: c.req.header('cf-connecting-ip') ?? undefined,
      country: c.req.header('cf-ipcountry') ?? undefined,
    });
    logOAuth('info', 'oauth.grant_recorded', {
      reqId: oauthRequestId(c),
      clientId: client.clientId,
      grantId,
    });

    // RFC 9207: set iss unconditionally, byte-for-byte equal to the issuer
    // from AS metadata (no trailing slash). The library sets it only sometimes
    // and resolves it from the request origin. Also send Authorization-Response-Iss;
    // some MCP clients read the header rather than the query.
    const currentOrigin = resolveOrigin(c);
    const authorizeRedirect = new URL(redirectTo);
    authorizeRedirect.searchParams.set('iss', currentOrigin);
    const authorizeResponse = c.redirect(authorizeRedirect.toString(), 302);
    authorizeResponse.headers.set('Authorization-Response-Iss', currentOrigin);
    logOAuth('info', 'oauth.redirect_sent', {
      status: 302,
      redirectHost: oauthRedirectHost(oauthRequest.redirectUri),
      reqId: oauthRequestId(c),
    });
    const recordedGrantId = grantId;
    safeExecutionCtx(c).waitUntil(
      revokeOlderGrantsForClient(
        oauthHelpers,
        c.env.DB,
        client.clientId,
        oauthRequest.redirectUri,
        recordedGrantId,
      ).catch((revokeError) => {
        logOAuth('warn', 'oauth.old_grant_revoke_failed', {
          reqId: oauthRequestId(c),
          clientId: client.clientId,
          err: errInfo(revokeError),
        });
      }),
    );
    return authorizeResponse;
  } catch (e) {
    logOAuth('error', 'oauth.grant_record_failed', {
      reqId: oauthRequestId(c),
      clientId: client.clientId,
      grantId,
      err: errInfo(e),
    });
    if (grantId) {
      await oauthHelpers.revokeGrant(grantId, OAUTH_OWNER_USER_ID).catch((re) => {
        logOAuth('error', 'oauth.grant_revoke_after_fail_failed', {
          reqId: oauthRequestId(c),
          grantId,
          err: errInfo(re),
        });
      });
    }
    // The marker was taken before completeAuthorization. Release it so the same
    // form can be submitted again. A successful allow keeps the marker.
    await oauthKv(c.env).delete(onceKey).catch((deleteError) => {
      logOAuth('warn', 'oauth.consent_once_release_failed', {
        reqId: oauthRequestId(c),
        clientId: client.clientId,
        err: errInfo(deleteError),
      });
    });
    return fail(c, 'OAUTH_GRANT_RECORD_FAILED', 503);
  }
});

// Before the catch-all routes: delegate to OAuthProvider for RFC 9728, RFC 8414, token, register, and mcp
function getOAuthProviderForRequest(req: Request, env?: Env, tokenLog?: TokenErrorLogFields) {
  const origin = resolveOrigin({ req, env });
  return createOAuthProvider(
    { fetch: (r, e, ctx) => app.fetch(r, e, ctx) },
    mcpApp,
    origin,
    env,
    tokenLog,
  );
}

function safeExecutionCtx(c: any): ExecutionContext {
  try {
    return c.executionCtx ?? ({ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
  } catch {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  }
}

app.all('/.well-known/*', async (c) => {
  const pathname = new URL(c.req.url).pathname;
  // workers-oauth-provider 1.2 publishes RFC 9728 only at the resource path
  // (`/.well-known/oauth-protected-resource/mcp`). The bare prefix stays an alias
  // so existing clients and the documented discovery URL keep working.
  if (pathname === OAUTH_PR_METADATA_PREFIX) {
    const canonical = new URL(c.req.url);
    canonical.pathname = `${OAUTH_PR_METADATA_PREFIX}/mcp`;
    return getOAuthProviderForRequest(c.req.raw, c.env).fetch(
      new Request(canonical.toString(), c.req.raw),
      c.env,
      safeExecutionCtx(c) as any
    );
  }
  if (providerHandlesWellKnown(pathname)) {
    return getOAuthProviderForRequest(c.req.raw, c.env).fetch(c.req.raw, c.env, safeExecutionCtx(c) as any);
  }
  if (isAuthorizationServerMetadataAlias(pathname)) {
    const canonical = new URL(c.req.url);
    canonical.pathname = OAUTH_AS_METADATA_PATH;
    return getOAuthProviderForRequest(c.req.raw, c.env).fetch(
      new Request(canonical.toString(), c.req.raw),
      c.env,
      safeExecutionCtx(c) as any
    );
  }
  return fail(c, 'NOT_FOUND', 404);
});

app.all('/api/auth/oauth/token', async (c) => {
  // Clone before the provider reads the body. onError does not receive the request.
  const tokenLog = await tokenRequestLogFields(c.req.raw.clone());
  return getOAuthProviderForRequest(c.req.raw, c.env, tokenLog).fetch(
    c.req.raw,
    c.env,
    safeExecutionCtx(c) as any,
  );
});

app.all('/api/auth/oauth/register', async (c) => {
  const limited = await rejectIfRateLimited(c, 'oauthRegister');
  if (limited) return limited;
  return getOAuthProviderForRequest(c.req.raw, c.env).fetch(c.req.raw, c.env, safeExecutionCtx(c) as any);
});

app.all('/mcp', async (c) => {
  const limited = await rejectIfRateLimited(c, 'mcpDispatch');
  if (limited) return limited;
  return getOAuthProviderForRequest(c.req.raw, c.env).fetch(c.req.raw, c.env, safeExecutionCtx(c) as any);
});

app.all('/mcp/*', async (c) => {
  const limited = await rejectIfRateLimited(c, 'mcpDispatch');
  if (limited) return limited;
  return getOAuthProviderForRequest(c.req.raw, c.env).fetch(c.req.raw, c.env, safeExecutionCtx(c) as any);
});

// Before the catch-all: otherwise every /api/v2/* route would hit the shared 404 below.
app.route('/api/v2', apiV2);

app.all('/api/*', (c) => fail(c, 'NOT_FOUND', 404));

const rawFetch = app.fetch.bind(app);
app.fetch = ((request: Request, env?: Env, ctx?: ExecutionContext) =>
  maybeDemoFetch(request, env, ctx, rawFetch)) as typeof app.fetch;

export { app, DemoSession };
export default app;
