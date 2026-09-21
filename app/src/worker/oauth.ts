// S2-1: OAuth 2.1 Provider и D1-хранилище согласий/токенов (issue #261)

import OAuthProvider, {
  AuthorizationError,
  getOAuthApi,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import type { Env } from './types';

export const DEFAULT_APP_ORIGIN = 'https://localhost';
export const OAUTH_RESOURCE_URI = `${DEFAULT_APP_ORIGIN}/mcp`;
export const OAUTH_ISSUER_URI = DEFAULT_APP_ORIGIN;
export const OAUTH_SCOPES_SUPPORTED = ['read', 'write'];

/** User id written into every workers-oauth-provider grant (single-user app). */
export const OAUTH_OWNER_USER_ID = 'owner';

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
 * Получает канонический URI издателя (Issuer URI) без trailing slash.
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
 * Получает Resource URI для MCP-сервера.
 */
export function getOAuthResourceUri(origin?: string, env?: Env): string {
  const issuer = getOAuthIssuerUri(origin, env);
  return `${issuer}/mcp`;
}

/**
 * Создаёт конфигурацию OAuthProviderOptions.
 */
export function getOAuthProviderOptions(
  defaultHandler: ExportedHandler<Env>,
  apiHandler?: any,
  origin?: string,
  env?: Env
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
 * Инициализирует OAuthProvider для Cloudflare Workers.
 */
export function createOAuthProvider(
  defaultHandler: ExportedHandler<Env>,
  apiHandler?: any,
  origin?: string,
  env?: Env
) {
  const options = getOAuthProviderOptions(defaultHandler, apiHandler, origin, env);
  return new OAuthProvider<Env>(options);
}

/**
 * Получает экземпляр OAuthHelpers вне обработчика OAuthProvider.
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
};

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
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return items;
}

/** Newest provider grant for this client, or null if KV has none. */
export async function resolveLatestGrantId(
  helpers: OAuthHelpers,
  clientId: string,
  userId: string = OAUTH_OWNER_USER_ID,
): Promise<string | null> {
  const matches = (await listAllUserGrants(helpers, userId)).filter((g) => g.clientId === clientId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return matches[0]!.id;
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
 * Сохраняет или обновляет информацию о клиенте в таблице `oauth_clients`.
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
 * Сохраняет выданное согласие в таблице `oauth_consents`.
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
 * Сохраняет аудит токена в таблице `oauth_tokens`.
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
 * Обновляет время последнего использования активных токенов клиента.
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
 * Отзывает токен в таблице `oauth_tokens`.
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
 * Отзывает все токены клиента в таблице `oauth_tokens`.
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
