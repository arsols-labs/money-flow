// S2-2: API для экрана «Доступ» и журнала аудита MCP (issue #262)

import { Hono } from 'hono';
import type { Env } from './types';
import { extractClientHost } from './oauth-consent';
import {
  getOAuthHelpers,
  recordOAuthClient,
  revokeOAuthClientTokensInDb,
  revokeOAuthTokenInDb,
  revokeProviderGrantForD1Token,
  revokeProviderGrantsForClient,
} from './oauth';
import { toIsoUtc } from './datetime';
import { resolveOrigin } from './auth';
import { fail } from './api-error';

const mcpApi = new Hono<{ Bindings: Env }>();

interface OAuthClientRow {
  id: string;
  name: string;
  metadata_document_url: string | null;
  created_at: string;
}

interface OAuthTokenRow {
  id: string;
  client_id: string;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_ip: string | null;
  last_country: string | null;
  revoked_at: string | null;
}

interface McpAuditLogRow {
  id: string;
  client_id: string;
  client_name: string | null;
  metadata_document_url: string | null;
  tool_name: string;
  status: string;
  result_summary: string | null;
  idempotency_key?: string | null;
  created_at: string;
}

/**
 * Возвращает список машинных клиентов и их активных токенов.
 */
mcpApi.get('/access', async (c) => {
  const [clientsRes, tokensRes, auditRes] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, metadata_document_url, created_at FROM oauth_clients ORDER BY created_at DESC').all<OAuthClientRow>(),
    c.env.DB.prepare('SELECT * FROM oauth_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC').all<OAuthTokenRow>(),
    c.env.DB.prepare('SELECT client_id, MAX(created_at) as last_audit_at FROM mcp_audit_log GROUP BY client_id').all<{ client_id: string; last_audit_at: string | null }>(),
  ]);

  const lastAuditByClient = new Map<string, string>();
  for (const row of auditRes.results) {
    if (row.client_id && row.last_audit_at) {
      lastAuditByClient.set(row.client_id, row.last_audit_at);
    }
  }

  const tokensByClient = new Map<string, Array<{
    id: string;
    scopes: string[];
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
    last_ip: string | null;
    last_country: string | null;
  }>>();

  for (const t of tokensRes.results) {
    let parsedScopes: string[] = [];
    try {
      parsedScopes = JSON.parse(t.scopes);
    } catch {
      parsedScopes = [t.scopes];
    }

    const auditTime = lastAuditByClient.get(t.client_id);
    let resolvedLastUsed = t.last_used_at;
    if (auditTime) {
      if (!resolvedLastUsed || new Date(auditTime).getTime() > new Date(resolvedLastUsed).getTime()) {
        resolvedLastUsed = auditTime;
      }
    }

    const tokenObj = {
      id: t.id,
      scopes: parsedScopes,
      created_at: toIsoUtc(t.created_at) ?? t.created_at,
      expires_at: toIsoUtc(t.expires_at),
      last_used_at: toIsoUtc(resolvedLastUsed),
      last_ip: t.last_ip,
      last_country: t.last_country,
    };

    if (!tokensByClient.has(t.client_id)) {
      tokensByClient.set(t.client_id, []);
    }
    tokensByClient.get(t.client_id)!.push(tokenObj);
  }

  const clients = clientsRes.results.map((client) => {
    const clientHost = extractClientHost(client.metadata_document_url || client.id);
    return {
      id: client.id,
      name: client.name,
      metadata_document_url: client.metadata_document_url,
      client_host: clientHost,
      created_at: toIsoUtc(client.created_at) ?? client.created_at,
      tokens: tokensByClient.get(client.id) || [],
    };
  });

  return c.json({ clients });
});

/**
 * Создаёт нового машинного OAuth-клиента (выпуск Client ID и Client Secret).
 */
mcpApi.post('/access/clients', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; redirect_uris?: string[] };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return fail(c, 'NAME_REQUIRED', 400);
  }

  const defaultRedirectUris = [
    'https://oauth-redirect.googleusercontent.com',
    'https://oauth-redirect.googleusercontent.com/r/money-flow',
    'https://developers.google.com/oauthredirect',
    'https://gemini.google.com/oauth/callback',
    'https://gemini.google.com',
    'http://localhost',
    'http://127.0.0.1',
    'http://localhost:8080/callback',
    'http://localhost:3000/callback',
  ];

  let redirectUris = defaultRedirectUris;
  if (Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0) {
    const customUris = body.redirect_uris
      .map(String)
      .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
    if (customUris.length > 0) {
      redirectUris = Array.from(new Set([...customUris, ...defaultRedirectUris]));
    }
  }

  const currentOrigin = resolveOrigin(c);
  const oauthHelpers = c.env.OAUTH_PROVIDER || getOAuthHelpers(c.env, currentOrigin);
  const client = await oauthHelpers.createClient({
    clientName: name,
    redirectUris,
    tokenEndpointAuthMethod: 'client_secret_basic',
  });

  await recordOAuthClient(c.env.DB, client.clientId, name);

  return c.json(
    {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      clientName: client.clientName || name,
      redirectUris: client.redirectUris,
    },
    201
  );
});

/**
 * Отзывает конкретный токен по ID.
 */
mcpApi.delete('/access/tokens/:tokenId', async (c) => {
  const tokenId = c.req.param('tokenId');
  if (!tokenId) {
    return fail(c, 'TOKEN_ID_REQUIRED', 400);
  }

  const row = await c.env.DB.prepare(
    'SELECT id, client_id FROM oauth_tokens WHERE id = ?',
  )
    .bind(tokenId)
    .first<{ id: string; client_id: string }>();
  if (!row) {
    return fail(c, 'NOT_FOUND', 404);
  }

  try {
    const origin = resolveOrigin(c);
    const helpers = c.env.OAUTH_PROVIDER || getOAuthHelpers(c.env, origin);
    await revokeProviderGrantForD1Token(helpers, row.id, row.client_id);
  } catch {
    return fail(c, 'OAUTH_REVOKE_FAILED', 500);
  }

  await revokeOAuthTokenInDb(c.env.DB, tokenId);
  return c.body(null, 204);
});

/**
 * Отзывает все активные токены машинного клиента.
 */
mcpApi.delete('/access/clients/:clientId', async (c) => {
  const clientId = c.req.param('clientId');
  if (!clientId) {
    return fail(c, 'CLIENT_ID_REQUIRED', 400);
  }

  try {
    const origin = resolveOrigin(c);
    const helpers = c.env.OAUTH_PROVIDER || getOAuthHelpers(c.env, origin);
    await revokeProviderGrantsForClient(helpers, clientId);
  } catch {
    return fail(c, 'OAUTH_REVOKE_FAILED', 500);
  }

  await revokeOAuthClientTokensInDb(c.env.DB, clientId);
  return c.body(null, 204);
});

/**
 * Возвращает последние 100 записей журнала вызовов инструментов MCP.
 */
mcpApi.get('/audit', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT 
       l.id,
       l.client_id,
       c.name AS client_name,
       c.metadata_document_url,
       l.tool_name,
       l.status,
       l.result_summary,
       l.created_at
     FROM mcp_audit_log l
     LEFT JOIN oauth_clients c ON l.client_id = c.id
     ORDER BY l.created_at DESC, l.rowid DESC
     LIMIT 100`
  ).all<McpAuditLogRow>();

  const logs = results.map((row) => ({
    id: row.id,
    client_id: row.client_id,
    client_name: row.client_name || row.client_id,
    client_host: extractClientHost(row.metadata_document_url || row.client_id),
    tool_name: row.tool_name,
    status: row.status,
    result_summary: row.result_summary,
    created_at: toIsoUtc(row.created_at) ?? row.created_at,
  }));

  return c.json({ logs });
});

/**
 * Помощник для записи в журнал аудита MCP.
 */
const AUDIT_RETENTION_DAYS = 14;
const AUDIT_TELEMETRY_WINDOW_LIMIT = 40;
export const IDEMPOTENCY_RETENTION_DAYS = 90;
export const IDEMPOTENCY_MAX_ROWS_PER_CLIENT = 500;
export const IDEMPOTENCY_MAX_SUMMARY_BYTES = 4096;

export function clipAuditSummary(summary: string | null | undefined): string | null {
  if (summary == null) return null;
  const encoded = new TextEncoder().encode(summary);
  if (encoded.length <= IDEMPOTENCY_MAX_SUMMARY_BYTES) return summary;
  return JSON.stringify({ clipped: true, bytes: encoded.length });
}

export async function pruneMcpAuditLog(db: D1Database): Promise<void> {
  await db
    .prepare(
      `DELETE FROM mcp_audit_log
       WHERE idempotency_key IS NULL
         AND created_at < datetime('now', ?)`,
    )
    .bind(`-${AUDIT_RETENTION_DAYS} days`)
    .run();
  await db
    .prepare(
      `DELETE FROM mcp_audit_log
       WHERE idempotency_key IS NOT NULL
         AND created_at < datetime('now', ?)`,
    )
    .bind(`-${IDEMPOTENCY_RETENTION_DAYS} days`)
    .run();
  const clients = await db
    .prepare(
      `SELECT client_id AS clientId, COUNT(*) AS n
       FROM mcp_audit_log
       WHERE idempotency_key IS NOT NULL
       GROUP BY client_id
       HAVING COUNT(*) > ?`,
    )
    .bind(IDEMPOTENCY_MAX_ROWS_PER_CLIENT)
    .all<{ clientId: string; n: number }>();
  for (const row of clients.results) {
    await db
      .prepare(
        `DELETE FROM mcp_audit_log
         WHERE client_id = ?
           AND idempotency_key IS NOT NULL
           AND id NOT IN (
             SELECT id FROM (
               SELECT id FROM mcp_audit_log
               WHERE client_id = ?
                 AND idempotency_key IS NOT NULL
               ORDER BY created_at DESC
               LIMIT ?
             )
           )`,
      )
      .bind(row.clientId, row.clientId, IDEMPOTENCY_MAX_ROWS_PER_CLIENT)
      .run();
  }
}

export async function recordMcpAuditLog(
  db: D1Database,
  clientId: string,
  toolName: string,
  status: 'success' | 'error' | 'pending',
  resultSummary?: string,
  idempotencyKey?: string
): Promise<string> {
  await pruneMcpAuditLog(db);

  if (!idempotencyKey) {
    const recent = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM mcp_audit_log
         WHERE client_id = ?
           AND idempotency_key IS NULL
           AND created_at >= datetime('now', '-60 seconds')`,
      )
      .bind(clientId)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= AUDIT_TELEMETRY_WINDOW_LIMIT) {
      return '';
    }
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(id, clientId, toolName, status, clipAuditSummary(resultSummary), idempotencyKey ?? null)
    .run();
  await pruneMcpAuditLog(db);
  return id;
}

export { mcpApi };
export default mcpApi;
