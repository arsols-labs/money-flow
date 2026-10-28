// S2-1: OAuth 2.1 provider and D1 storage of consents/tokens (issue #261)

import OAuthProvider, {
  AuthorizationError,
  getOAuthApi,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import { logOAuth } from './oauth-log';
import type { Env } from './types';

export const DEFAULT_APP_ORIGIN = 'https://localhost';
export const OAUTH_RESOURCE_URI = `${DEFAULT_APP_ORIGIN}/mcp`;
export const OAUTH_ISSUER_URI = DEFAULT_APP_ORIGIN;
export const OAUTH_SCOPES_SUPPORTED = ['read', 'write'];

/** User id written into every workers-oauth-provider grant (single-user app). */
export const OAUTH_OWNER_USER_ID = 'owner';

/** Access tokens stay at the provider default of one hour. */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Explicit refresh lifetime (workers-oauth-provider 1.2.1 default is 30 days).
 * `expiresAt` is set at authorization-code exchange to now + this value.
 * `refreshTokenIdleTTL` is left unset, so a refresh does not move that expiry.
 * Rotation stays the library default: the current refresh token and the single
 * previous one (`previousRefreshTokenId`) are both accepted. Presenting either
 * rotates again and keeps the presented token as the previous one. It does not
 * revoke the grant. Any older refresh token is `invalid_grant`.
 */
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Logged length of a grant id. The rest of the id, and the token secret, stay off the log. */
export const OAUTH_GRANT_ID_LOG_PREFIX_LENGTH = 8;

const LOOPBACK_REDIRECT_HOSTS = new Set(['127.0.0.1', 'localhost']);
const GOOGLE_ACCOUNT_LINKING_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'developers.google.com',
  'gemini.google.com',
]);

/**
 * Gemini / Google Account Linking and RFC 8252 loopback clients may present a
 * redirect_uri that was not in the client's original registration. Only exact
 * parsed hosts are trusted — never a raw string prefix. `http://127.0.0.1:80@evil`
 * must not be treated as loopback (userinfo / open-redirect).
 */
/** RFC 8252: only the loopback port may vary; scheme, hostname, path, and query stay fixed. */
export function isLoopbackPortVariant(registered: string, requested: string): boolean {
  let want: URL;
  let have: URL;
  try {
    want = new URL(requested);
    have = new URL(registered);
  } catch {
    return false;
  }
  if (want.username || want.password || have.username || have.password) return false;
  if (want.protocol !== 'http:' || have.protocol !== 'http:') return false;
  if (!LOOPBACK_REDIRECT_HOSTS.has(want.hostname.toLowerCase())) return false;
  if (!LOOPBACK_REDIRECT_HOSTS.has(have.hostname.toLowerCase())) return false;
  if (want.hostname.toLowerCase() !== have.hostname.toLowerCase()) return false;
  return want.pathname === have.pathname && want.search === have.search;
}

export function isRegisteredRedirectOrLoopbackVariant(
  registeredUris: string[],
  requested: string,
): boolean {
  if (registeredUris.includes(requested)) return true;
  return registeredUris.some((registered) => isLoopbackPortVariant(registered, requested));
}

export function isTrustedOAuthRedirectUri(redirectUri: string): boolean {
  if (typeof redirectUri !== 'string' || redirectUri.length === 0) return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:') {
    return LOOPBACK_REDIRECT_HOSTS.has(host);
  }
  if (url.protocol === 'https:') {
    if (host === 'developers.google.com') {
      return url.pathname === '/oauthredirect' || url.pathname.startsWith('/oauthredirect/');
    }
    return GOOGLE_ACCOUNT_LINKING_HOSTS.has(host);
  }
  return false;
}

/**
 * Returns the canonical issuer URI (Issuer URI) without a trailing slash.
 */
export function getOAuthIssuerUri(origin?: string, env?: Env): string {
  if (origin && origin !== 'null') {
    return origin.replace(/\/$/, '');
  }
  if (env?.APP_DOMAIN) {
    const domain = env.APP_DOMAIN.trim();
    return domain.startsWith('http://') || domain.startsWith('https://')
      ? domain.replace(/\/$/, '')
      : `https://${domain}`;
  }
  return DEFAULT_APP_ORIGIN;
}

/**
 * Returns the Resource URI for the MCP server.
 */
export function getOAuthResourceUri(origin?: string, env?: Env): string {
  const issuer = getOAuthIssuerUri(origin, env);
  return `${issuer}/mcp`;
}

/**
 * Builds the OAuthProviderOptions configuration.
 */
export function getOAuthProviderOptions(
  defaultHandler: ExportedHandler<Env>,
  apiHandler?: any,
  origin?: string,
  env?: Env,
  tokenLog?: TokenErrorLogFields,
): OAuthProviderOptions<Env> {
  const issuerUri = getOAuthIssuerUri(origin, env);
  const resourceUri = getOAuthResourceUri(origin, env);

  return {
    apiRoute: '/mcp',
    apiHandler: apiHandler || {
      fetch: async (_request: Request, _env: Env) => {
        return new Response(JSON.stringify({ status: 'ok', message: 'MCP API endpoint' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
    defaultHandler,
    authorizeEndpoint: '/api/auth/oauth/authorize',
    tokenEndpoint: '/api/auth/oauth/token',
    clientRegistrationEndpoint: '/api/auth/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    tokenExchangeCallback: (options) => {
      if (options.grantType !== 'refresh_token') return;
      logOAuth('info', 'oauth.token_refreshed', {
        clientId: options.clientId,
        grantIdPrefix: options.grantId.slice(0, OAUTH_GRANT_ID_LOG_PREFIX_LENGTH),
      });
    },
    onError: ({ status, code, description, internal }) => {
      logOAuth('warn', 'oauth.token_error', {
        status,
        code,
        description,
        reason: internal?.reason,
        grantType: tokenLog?.grantType,
        clientId: tokenLog?.clientId,
        grantIdPrefix: tokenLog?.grantIdPrefix,
      });
    },
    scopesSupported: OAUTH_SCOPES_SUPPORTED,
    resourceMetadata: {
      resource: resourceUri,
      authorization_servers: [issuerUri],
      scopes_supported: OAUTH_SCOPES_SUPPORTED,
      resource_name: 'Money Flow v2 MCP server',
    },
  };
}

/**
 * Initializes OAuthProvider for Cloudflare Workers.
 */
export function createOAuthProvider(
  defaultHandler: ExportedHandler<Env>,
  apiHandler?: any,
  origin?: string,
  env?: Env,
  tokenLog?: TokenErrorLogFields,
) {
  const options = getOAuthProviderOptions(defaultHandler, apiHandler, origin, env, tokenLog);
  return new OAuthProvider<Env>(options);
}

/**
 * Gets an OAuthHelpers instance outside the OAuthProvider handler.
 */
export function getOAuthHelpers(env: Env, origin?: string): OAuthHelpers {
  const options = getOAuthProviderOptions(
    {
      fetch: () => new Response('Not found', { status: 404 }),
    },
    undefined,
    origin,
    env
  );
  return getOAuthApi(options, env);
}

type GrantSummary = {
  id: string;
  clientId: string;
  createdAt?: number;
  /** Present on grants written by workers-oauth-provider 1.x. Absent on older rows. */
  redirectUri?: string;
};

/** workers-oauth-provider auth code = `${userId}:${grantId}:${secret}` (see completeAuthorization). */
export function grantIdFromAuthorizeRedirect(redirectTo: string): string | null {
  const code = new URL(redirectTo).searchParams.get('code');
  const parts = code?.split(':') ?? [];
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/**
 * Fields safe to log for a token-endpoint error.
 * The provider's `onError` hook does not receive the request body, so the token
 * route parses these before forwarding. The credential itself is never returned.
 */
export type TokenErrorLogFields = {
  grantType?: string;
  clientId?: string;
  grantIdPrefix?: string;
};

/** First characters of the grant id inside `userId:grantId:secret`, when the shape matches. */
export function grantIdPrefixFromCredential(credential: string | null | undefined): string | undefined {
  if (!credential) return undefined;
  const parts = credential.split(':');
  if (parts.length !== 3 || !parts[1]) return undefined;
  return parts[1].slice(0, OAUTH_GRANT_ID_LOG_PREFIX_LENGTH);
}

export async function tokenRequestLogFields(request: Request): Promise<TokenErrorLogFields> {
  const contentType = (request.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  let params = new URLSearchParams();
  try {
    if (
      contentType === 'application/x-www-form-urlencoded' ||
      contentType === 'multipart/form-data'
    ) {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string' && !params.has(key)) params.set(key, value);
      }
    } else if (contentType === 'application/json') {
      const body = (await request.json()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params.set(key, value);
      }
    }
  } catch {
    params = new URLSearchParams();
  }

  const grantType = params.get('grant_type') || undefined;
  const clientId = params.get('client_id') || clientIdFromBasicAuth(request.headers.get('authorization'));
  const credential =
    grantType === 'refresh_token'
      ? params.get('refresh_token')
      : grantType === 'authorization_code'
        ? params.get('code')
        : params.get('refresh_token') || params.get('code') || params.get('token');
  return {
    grantType,
    clientId,
    grantIdPrefix: grantIdPrefixFromCredential(credential),
  };
}

function clientIdFromBasicAuth(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) return undefined;
  try {
    const clientId = atob(match[1]).split(':')[0];
    return clientId ? decodeURIComponent(clientId) : undefined;
  } catch {
    return undefined;
  }
}

export async function listAllUserGrants(
  helpers: OAuthHelpers,
  userId: string = OAUTH_OWNER_USER_ID,
): Promise<GrantSummary[]> {
  const items: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, { limit: 100, cursor });
    for (const grant of page.items) {
      items.push({
        id: grant.id,
        clientId: grant.clientId,
        createdAt: grant.createdAt,
        redirectUri: grant.redirectUri,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return items;
}

/**
 * After a confirmed grant, retire older provider grants for the same client and
 * redirect URI. A different redirect URI on the same client id is left alone.
 * The D1 audit row is marked revoked only after that grant's KV revoke succeeds.
 */
export async function revokeOlderGrantsForClient(
  helpers: OAuthHelpers,
  db: D1Database,
  clientId: string,
  redirectUri: string,
  keepGrantId: string,
  userId: string = OAUTH_OWNER_USER_ID,
): Promise<void> {
  const grants = await listAllUserGrants(helpers, userId);
  for (const grant of grants) {
    if (grant.clientId !== clientId) continue;
    if (grant.redirectUri !== redirectUri) continue;
    if (grant.id === keepGrantId) continue;
    await helpers.revokeGrant(grant.id, userId);
    await revokeOAuthTokenInDb(db, grant.id);
  }
}

export type OAuthGrantRecord = {
  grantId: string;
  clientId: string;
  clientName: string;
  metadataUrl?: string;
  scopes: string[];
  redirectUri: string;
  ip?: string;
  country?: string;
};

/** Deterministic consent id so a retry upserts the same row. */
export async function oauthConsentId(clientId: string, redirectUri: string): Promise<string> {
  return sha256Hex(`${clientId}|${redirectUri}`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Client, consent, and grant audit rows in one D1 batch (one implicit transaction).
 * Upserts are idempotent for a retry of the same client, redirect URI, and grant id.
 */
export async function recordOAuthGrantAtomic(db: D1Database, a: OAuthGrantRecord): Promise<void> {
  const consentId = await oauthConsentId(a.clientId, a.redirectUri);
  await db.batch([
    db.prepare(
      `INSERT INTO oauth_clients (id, name, metadata_document_url, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         metadata_document_url = excluded.metadata_document_url`,
    ).bind(a.clientId, a.clientName, a.metadataUrl ?? null),
    db.prepare(
      `INSERT INTO oauth_consents (id, client_id, scopes, redirect_uri, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         scopes = excluded.scopes,
         updated_at = datetime('now')`,
    ).bind(consentId, a.clientId, JSON.stringify(a.scopes), a.redirectUri),
    db.prepare(
      `INSERT INTO oauth_tokens (id, client_id, scopes, created_at, last_ip, last_country)
       VALUES (?, ?, ?, datetime('now'), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         scopes = excluded.scopes,
         revoked_at = NULL,
         last_ip = COALESCE(excluded.last_ip, oauth_tokens.last_ip),
         last_country = COALESCE(excluded.last_country, oauth_tokens.last_country)`,
    ).bind(a.grantId, a.clientId, JSON.stringify(a.scopes), a.ip ?? null, a.country ?? null),
  ]);
}

/**
 * Invalidate the real workers-oauth-provider grant(s) for a D1 Access row.
 * Throws on KV/provider errors so callers can fail closed (no D1-only revoke).
 * If the D1 id is not a grant id (legacy UUID), all grants for that client
 * are revoked — one live grant per client is the provider default.
 */
export async function revokeProviderGrantForD1Token(
  helpers: OAuthHelpers,
  tokenId: string,
  clientId: string,
  userId: string = OAUTH_OWNER_USER_ID,
): Promise<void> {
  const grants = await listAllUserGrants(helpers, userId);
  const exact = grants.find((g) => g.id === tokenId);
  if (exact) {
    await helpers.revokeGrant(exact.id, userId);
    return;
  }
  for (const grant of grants.filter((g) => g.clientId === clientId)) {
    await helpers.revokeGrant(grant.id, userId);
  }
}

export async function revokeProviderGrantsForClient(
  helpers: OAuthHelpers,
  clientId: string,
  userId: string = OAUTH_OWNER_USER_ID,
): Promise<void> {
  const grants = await listAllUserGrants(helpers, userId);
  for (const grant of grants.filter((g) => g.clientId === clientId)) {
    await helpers.revokeGrant(grant.id, userId);
  }
}

/**
 * Saves or updates client information in the `oauth_clients` table.
 */
export async function recordOAuthClient(
  db: D1Database,
  clientId: string,
  name: string,
  metadataUrl?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_clients (id, name, metadata_document_url, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         metadata_document_url = excluded.metadata_document_url`
    )
    .bind(clientId, name, metadataUrl ?? null)
    .run();
}

/**
 * Saves a granted consent in the `oauth_consents` table.
 */
export async function recordOAuthConsent(
  db: D1Database,
  clientId: string,
  scopes: string[],
  redirectUri: string
): Promise<string> {
  const consentId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO oauth_consents (id, client_id, scopes, redirect_uri, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(consentId, clientId, JSON.stringify(scopes), redirectUri)
    .run();
  return consentId;
}

/**
 * Saves a token audit row in the `oauth_tokens` table.
 * Idempotent on grant id: re-consent / double Allow with the same
 * workers-oauth-provider grant must not fail UNIQUE and revoke the live grant.
 */
export async function recordOAuthToken(
  db: D1Database,
  tokenId: string,
  clientId: string,
  scopes: string[],
  expiresAt?: string,
  ip?: string,
  country?: string,
  lastUsedAt?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, client_id, scopes, created_at, expires_at, last_used_at, last_ip, last_country)
       VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         client_id = excluded.client_id,
         scopes = excluded.scopes,
         expires_at = excluded.expires_at,
         last_used_at = COALESCE(excluded.last_used_at, oauth_tokens.last_used_at),
         last_ip = COALESCE(excluded.last_ip, oauth_tokens.last_ip),
         last_country = COALESCE(excluded.last_country, oauth_tokens.last_country),
         revoked_at = NULL`
    )
    .bind(tokenId, clientId, JSON.stringify(scopes), expiresAt ?? null, lastUsedAt ?? null, ip ?? null, country ?? null)
    .run();
}

/**
 * Updates the last-used time of the client's active tokens.
 */
export async function touchOAuthClientUsage(
  db: D1Database,
  clientId: string,
  ip?: string,
  country?: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE oauth_tokens
       SET last_used_at = datetime('now'),
           last_ip = COALESCE(?, last_ip),
           last_country = COALESCE(?, last_country)
       WHERE client_id = ? AND revoked_at IS NULL`
    )
    .bind(ip ?? null, country ?? null, clientId)
    .run();
}

/**
 * Revokes a token in the `oauth_tokens` table.
 */
export async function revokeOAuthTokenInDb(db: D1Database, tokenId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE oauth_tokens
       SET revoked_at = datetime('now')
       WHERE id = ?`
    )
    .bind(tokenId)
    .run();
}

/**
 * Revokes all of a client's tokens in the `oauth_tokens` table.
 */
export async function revokeOAuthClientTokensInDb(db: D1Database, clientId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE oauth_tokens
       SET revoked_at = datetime('now')
       WHERE client_id = ? AND revoked_at IS NULL`
    )
    .bind(clientId)
    .run();
}

export { AuthorizationError, type AuthRequest, type OAuthHelpers };
