// S2-2: API tests for the "Access" screen and the MCP audit log (issue #262)

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import { recordMcpAuditLog } from '../src/worker/api-mcp';
import type { Env } from '../src/worker/types';

describe('S2-2: MCP Access & Audit API', () => {
  let cookie: string;

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mcp_audit_log'),
      env.DB.prepare('DELETE FROM oauth_tokens'),
      env.DB.prepare('DELETE FROM oauth_consents'),
      env.DB.prepare('DELETE FROM oauth_clients'),
    ]);

    const setCookie = await createSessionCookie(env as unknown as Env, false);
    cookie = setCookie.split(';')[0]!;
  });

  describe('GET /api/v2/mcp/access', () => {
    it('requires authorization (401 without a cookie)', async () => {
      const res = await app.request('https://example.com/api/v2/mcp/access', undefined, env as unknown as Env);
      expect(res.status).toBe(401);
    });

    it('returns an empty client list when there is no data', async () => {
      const res = await app.request('https://example.com/api/v2/mcp/access', {
        headers: { Cookie: cookie },
      }, env as unknown as Env);
      expect(res.status).toBe(200);
      const json = await res.json<{ clients: any[] }>();
      expect(json.clients).toEqual([]);
    });

    it('returns clients with their active tokens and parses the host', async () => {
      const clientId = 'https://claude.ai/mcp-metadata.json';
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, metadata_document_url, created_at)
         VALUES (?, 'Claude Code', ?, datetime('now'))`
      ).bind(clientId, clientId).run();

      const tokenId1 = 'token-1';
      const tokenId2 = 'token-2';
      const revokedTokenId = 'token-revoked';

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at, last_used_at, last_ip, last_country)
         VALUES (?, ?, ?, '2026-08-15T12:00:00Z', '2026-08-15T12:05:00Z', '1.2.3.4', 'US')`
      ).bind(tokenId1, clientId, JSON.stringify(['read', 'write'])).run();

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at, last_used_at, last_ip, last_country)
         VALUES (?, ?, ?, '2026-08-15T13:00:00Z', NULL, NULL, NULL)`
      ).bind(tokenId2, clientId, JSON.stringify(['read'])).run();

      // A revoked token must not land among the active ones
      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at, revoked_at)
         VALUES (?, ?, ?, '2026-08-15T10:00:00Z', '2026-08-15T11:00:00Z')`
      ).bind(revokedTokenId, clientId, JSON.stringify(['read'])).run();

      const res = await app.request('https://example.com/api/v2/mcp/access', {
        headers: { Cookie: cookie },
      }, env as unknown as Env);

      expect(res.status).toBe(200);
      const json = await res.json<{ clients: any[] }>();
      expect(json.clients).toHaveLength(1);
      const client = json.clients[0];
      expect(client.id).toBe(clientId);
      expect(client.name).toBe('Claude Code');
      expect(client.client_host).toBe('claude.ai');
      expect(client.tokens).toHaveLength(2);
      expect(client.tokens[0].id).toBe(tokenId2);
      expect(client.tokens[0].scopes).toEqual(['read']);
      expect(client.tokens[1].id).toBe(tokenId1);
      expect(client.tokens[1].scopes).toEqual(['read', 'write']);
      expect(client.tokens[1].last_ip).toBe('1.2.3.4');
      expect(client.tokens[1].last_country).toBe('US');
    });

    it('syncs the token last_used_at with a newer call from mcp_audit_log', async () => {
      const clientId = 'cursor-ide';
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at)
         VALUES (?, 'Cursor IDE', datetime('now'))`
      ).bind(clientId).run();

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at, last_used_at)
         VALUES ('token-old', ?, '["read","write"]', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')`
      ).bind(clientId).run();

      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, created_at)
         VALUES ('log-new', ?, 'operation_add', 'success', '2026-09-10T02:30:00Z')`
      ).bind(clientId).run();

      const res = await app.request('https://example.com/api/v2/mcp/access', {
        headers: { Cookie: cookie },
      }, env as unknown as Env);

      expect(res.status).toBe(200);
      const json = await res.json<{ clients: any[] }>();
      expect(json.clients).toHaveLength(1);
      const token = json.clients[0].tokens[0];
      expect(token.last_used_at).toBe('2026-09-10T02:30:00Z');
    });
  });

  describe('POST /api/v2/mcp/access/clients', () => {
    it('requires authorization (401 without a cookie)', async () => {
      const res = await app.request('https://example.com/api/v2/mcp/access/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Gemini Desktop' }),
      }, env as unknown as Env);
      expect(res.status).toBe(401);
    });

    it('requires the name field (400 when name is empty)', async () => {
      const res = await app.request('https://example.com/api/v2/mcp/access/clients', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ name: '   ' }),
      }, env as unknown as Env);
      expect(res.status).toBe(400);
    });

    it('successfully creates an OAuth client, writes it to D1, and returns the keys', async () => {
      const res = await app.request('https://example.com/api/v2/mcp/access/clients', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          name: 'Gemini Desktop',
          redirect_uris: ['http://localhost:8080/callback'],
        }),
      }, env as unknown as Env);

      expect(res.status).toBe(201);
      const json = await res.json<{
        clientId: string;
        clientSecret: string;
        clientName: string;
        redirectUris: string[];
      }>();

      expect(json.clientId).toBeDefined();
      expect(json.clientSecret).toBeDefined();
      expect(json.clientName).toBe('Gemini Desktop');
      expect(json.redirectUris).toContain('http://localhost:8080/callback');
      expect(json.redirectUris).toContain('https://oauth-redirect.googleusercontent.com');

      // Check that it was saved in D1
      const clientRow = await env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?')
        .bind(json.clientId)
        .first<{ id: string; name: string }>();

      expect(clientRow).toBeDefined();
      expect(clientRow?.name).toBe('Gemini Desktop');
    });
  });

  describe('DELETE /api/v2/mcp/access/tokens/:tokenId', () => {
    it('revokes the token in the database', async () => {
      const clientId = 'client-1';
      const tokenId = 'tok-123';

      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Test Client', datetime('now'))`
      ).bind(clientId).run();

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at) VALUES (?, ?, '["read"]', datetime('now'))`
      ).bind(tokenId, clientId).run();

      const res = await app.request(`https://example.com/api/v2/mcp/access/tokens/${tokenId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }, env as unknown as Env);

      expect(res.status).toBe(204);

      const row = await env.DB.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?').bind(tokenId).first<{ revoked_at: string | null }>();
      expect(row?.revoked_at).not.toBeNull();
    });

    it('does not mark D1 if revoking the grant in the provider fails (fail closed)', async () => {
      const clientId = 'client-fail-closed';
      const tokenId = 'tok-fail-closed';
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Broken', datetime('now'))`,
      )
        .bind(clientId)
        .run();
      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at) VALUES (?, ?, '["read"]', datetime('now'))`,
      )
        .bind(tokenId, clientId)
        .run();

      const brokenEnv = {
        ...(env as unknown as Env),
        OAUTH_PROVIDER: {
          listUserGrants: async () => {
            throw new Error('oauth kv unavailable');
          },
          revokeGrant: async () => {
            throw new Error('oauth kv unavailable');
          },
        },
      };

      const res = await app.request(
        `https://example.com/api/v2/mcp/access/tokens/${tokenId}`,
        { method: 'DELETE', headers: { Cookie: cookie } },
        brokenEnv as unknown as Env,
      );
      expect(res.status).toBe(500);
      const json = await res.json<{ error: { code: string } }>();
      expect(json.error.code).toBe('OAUTH_REVOKE_FAILED');

      const row = await env.DB.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?')
        .bind(tokenId)
        .first<{ revoked_at: string | null }>();
      expect(row?.revoked_at).toBeNull();
    });
  });

  describe('DELETE /api/v2/mcp/access/clients/:clientId', () => {
    it('revokes every active token of the client', async () => {
      const clientId = 'client-multi';

      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Test Client', datetime('now'))`
      ).bind(clientId).run();

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at) VALUES ('tok-a', ?, '["read"]', datetime('now'))`
      ).bind(clientId).run();

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at) VALUES ('tok-b', ?, '["write"]', datetime('now'))`
      ).bind(clientId).run();

      const res = await app.request(`https://example.com/api/v2/mcp/access/clients/${clientId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }, env as unknown as Env);

      expect(res.status).toBe(204);

      const activeCount = await env.DB.prepare(
        'SELECT COUNT(*) as cnt FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NULL'
      ).bind(clientId).first<{ cnt: number }>();
      expect(activeCount?.cnt).toBe(0);
    });
  });

  describe('GET /api/v2/mcp/audit & recordMcpAuditLog', () => {
    it('writes and returns audit logs with a join to the client', async () => {
      const clientId = 'https://claude.ai/metadata.json';
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, metadata_document_url, created_at)
         VALUES (?, 'Claude Code', ?, datetime('now'))`
      ).bind(clientId, clientId).run();

      await recordMcpAuditLog(env.DB, clientId, 'get_accounts', 'success', 'returned 3 accounts');
      await recordMcpAuditLog(env.DB, clientId, 'create_operation', 'error', 'validation failed: amount is negative');

      const res = await app.request('https://example.com/api/v2/mcp/audit', {
        headers: { Cookie: cookie },
      }, env as unknown as Env);

      expect(res.status).toBe(200);
      const json = await res.json<{ logs: any[] }>();
      expect(json.logs).toHaveLength(2);

      const firstLog = json.logs[0];
      expect(firstLog.tool_name).toBe('create_operation');
      expect(firstLog.status).toBe('error');
      expect(firstLog.result_summary).toBe('validation failed: amount is negative');
      expect(firstLog.client_name).toBe('Claude Code');
      expect(firstLog.client_host).toBe('claude.ai');

      const secondLog = json.logs[1];
      expect(secondLog.tool_name).toBe('get_accounts');
      expect(secondLog.status).toBe('success');
    });

    it('#325: the log created_at returns ISO with Z even from sqlite datetime(now)', async () => {
      const clientId = 'https://claude.ai/metadata.json';
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, metadata_document_url, created_at)
         VALUES (?, 'Claude Code', ?, datetime('now'))`
      ).bind(clientId, clientId).run();

      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, created_at)
         VALUES ('log-naive', ?, 'accounts_list', 'success', 'ok', '2026-08-16 00:13:00')`
      ).bind(clientId).run();

      const res = await app.request('https://example.com/api/v2/mcp/audit', {
        headers: { Cookie: cookie },
      }, env as unknown as Env);

      expect(res.status).toBe(200);
      const json = await res.json<{ logs: Array<{ created_at: string }> }>();
      expect(json.logs[0]?.created_at).toBe('2026-08-16T00:13:00Z');
    });
  });

  describe('#325: token timestamps in ISO with Z', () => {
    it('GET /access normalizes sqlite datetime(now) to ISO UTC', async () => {
      const clientId = 'https://claude.ai/mcp-metadata.json';
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, metadata_document_url, created_at)
         VALUES (?, 'Claude Code', ?, '2026-08-16 00:13:00')`
      ).bind(clientId, clientId).run();
      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, created_at, last_used_at, expires_at)
         VALUES ('tok-naive', ?, ?, '2026-08-16 00:13:00', '2026-08-16 00:20:00', '2026-08-17 00:13:00')`
      ).bind(clientId, JSON.stringify(['read'])).run();

      const res = await app.request('https://example.com/api/v2/mcp/access', {
        headers: { Cookie: cookie },
      }, env as unknown as Env);

      expect(res.status).toBe(200);
      const json = await res.json<{ clients: Array<{ created_at: string; tokens: Array<{ created_at: string; last_used_at: string; expires_at: string }> }> }>();
      expect(json.clients[0]?.created_at).toBe('2026-08-16T00:13:00Z');
      expect(json.clients[0]?.tokens[0]?.created_at).toBe('2026-08-16T00:13:00Z');
      expect(json.clients[0]?.tokens[0]?.last_used_at).toBe('2026-08-16T00:20:00Z');
      expect(json.clients[0]?.tokens[0]?.expires_at).toBe('2026-08-17T00:13:00Z');
    });
  });
});
