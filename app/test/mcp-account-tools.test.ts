import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import mcpApp from '../src/worker/mcp-server';
import type { Env } from '../src/worker/types';
import { normalizeAlias } from '../src/worker/account-aliases';

const typedEnv = env as unknown as Env;
const clientId = 'client-mcp-account-test';
let rpcId = 1;

async function call(name: string, args: Record<string, unknown>, scopes: string[] = ['read', 'write']) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApp.fetch(req, typedEnv, { props: { scopes, clientId } } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function confirm(name: string, args: Record<string, unknown>) {
  const first = await call(name, args);
  expect(first.result.isError).toBeFalsy();
  expect(first.result.structuredContent.resultType).toBe('input_required');
  const second = await call(name, { ...args, requestState: first.result.structuredContent.requestState });
  return { first, second };
}

async function insertAccount(name = 'Main EUR', currency = 'EUR'): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
     VALUES (?, ?, 10000, 1, 0, 'Alex', 'RS', '2026-10-01T00:00:00Z') RETURNING id`,
  ).bind(name, currency).first<{ id: number }>();
  return row!.id;
}

async function insertAlias(accountId: number, text: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO account_aliases (account_id, alias_text, alias_norm, created_at) VALUES (?, ?, ?, '2026-10-01T00:00:00Z') RETURNING id`,
  ).bind(accountId, text, normalizeAlias(text)).first<{ id: number }>();
  return row!.id;
}

async function insertPending(raw: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO pending_account_strings (raw_string, raw_norm, first_seen_at) VALUES (?, ?, '2026-10-01T00:00:00Z') RETURNING id`,
  ).bind(raw, normalizeAlias(raw)).first<{ id: number }>();
  return row!.id;
}

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

async function auditRow(key: string) {
  return env.DB.prepare('SELECT client_id, tool_name, status FROM mcp_audit_log WHERE idempotency_key = ? AND status = ?')
    .bind(key, 'success').first<any>();
}

const ASCII_ONLY = /^[\x20-\x7E\u2014]*$/;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM account_aliases'),
    env.DB.prepare('DELETE FROM pending_account_strings'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM oauth_clients'),
  ]);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Account Test Client', datetime('now'))`)
    .bind(clientId).run();
});

describe('MCP account read tools', () => {
  it('lists aliases, resolves strings read-only and lists pending strings', async () => {
    const accountId = await insertAccount();
    await insertAlias(accountId, 'Visa *6125');
    await insertPending('Mastercard *0001');

    const aliases = await call('account_aliases_list', { account_id: accountId });
    expect(aliases.result.structuredContent.aliases.map((a: any) => a.alias_text)).toEqual(['Visa *6125']);

    const resolved = await call('account_resolve', { q: 'Visa *6125' });
    expect(resolved.result.structuredContent.account_id).toBe(accountId);
    const before = await count('SELECT COUNT(*) AS n FROM pending_account_strings');
    const unknown = await call('account_resolve', { q: 'Amex *9999' });
    expect(unknown.result.structuredContent.account_id).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM pending_account_strings')).toBe(before);

    const pending = await call('pending_accounts_list', {});
    expect(pending.result.structuredContent.pending.map((p: any) => p.raw_string)).toEqual(['Mastercard *0001']);
  });

  it('requires read scope and validates arguments in English', async () => {
    const denied = await call('pending_accounts_list', {}, ['write']);
    expect(denied.error ?? denied.result?.isError).toBeTruthy();
    const bad = await call('account_aliases_list', { account_id: 'x' });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.structuredContent.error).toBe('Error executing tool: Invalid account_id');
    const empty = await call('account_resolve', { q: ' ' });
    expect(empty.result.structuredContent.error).toMatch(/q is required/);
  });
});

type Case = {
  tool: string;
  setup: () => Promise<Record<string, unknown>>;
  altArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  check: (args: Record<string, unknown>, result: any) => Promise<void>;
  unchanged: (args: Record<string, unknown>) => Promise<void>;
};

const cases: Case[] = [
  {
    tool: 'account_add',
    setup: async () => ({ name: 'New RSD', currency: 'RSD', owner: 'Alex', country: 'RS', balance_minor: 500 }),
    altArgs: (a) => ({ ...a, name: 'Other' }),
    unchanged: async () => expect(await count('SELECT COUNT(*) AS n FROM accounts')).toBe(0),
    check: async (_a, r) => {
      expect(r.account.name).toBe('New RSD');
      expect(await count('SELECT COUNT(*) AS n FROM accounts')).toBe(1);
    },
  },
  {
    tool: 'account_update',
    setup: async () => ({ account_id: await insertAccount(), name: 'Renamed' }),
    altArgs: (a) => ({ ...a, name: 'Renamed twice' }),
    unchanged: async (a) => expect((await env.DB.prepare('SELECT name FROM accounts WHERE id = ?').bind(a.account_id).first<any>()).name).toBe('Main EUR'),
    check: async (a) => expect((await env.DB.prepare('SELECT name FROM accounts WHERE id = ?').bind(a.account_id).first<any>()).name).toBe('Renamed'),
  },
  {
    tool: 'account_delete',
    setup: async () => {
      const id = await insertAccount('Old card');
      await insertAlias(id, 'Visa *1111');
      return { account_id: id };
    },
    altArgs: () => ({ account_id: 999999 }),
    unchanged: async (a) => expect(await count('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', a.account_id)).toBe(1),
    check: async (a, r) => {
      expect(r.success).toBe(true);
      expect(r.deleted_account.name).toBe('Old card');
      expect(r.removed_aliases.map((x: any) => x.alias_text)).toEqual(['Visa *1111']);
      expect(await count('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', a.account_id)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM account_aliases WHERE account_id = ?', a.account_id)).toBe(0);
    },
  },
  {
    tool: 'account_alias_add',
    setup: async () => ({ account_id: await insertAccount(), alias_text: 'Visa *6125' }),
    altArgs: (a) => ({ ...a, alias_text: 'Visa *0000' }),
    unchanged: async () => expect(await count('SELECT COUNT(*) AS n FROM account_aliases')).toBe(0),
    check: async (_a, r) => {
      expect(r.alias.alias_text).toBe('Visa *6125');
      expect(await count('SELECT COUNT(*) AS n FROM account_aliases')).toBe(1);
    },
  },
  {
    tool: 'account_alias_delete',
    setup: async () => {
      const id = await insertAccount();
      return { account_id: id, alias_id: await insertAlias(id, 'Visa *2222') };
    },
    altArgs: (a) => ({ ...a, alias_id: 999999 }),
    unchanged: async () => expect(await count('SELECT COUNT(*) AS n FROM account_aliases')).toBe(1),
    check: async (_a, r) => {
      expect(r.success).toBe(true);
      expect(r.deleted_alias.alias_text).toBe('Visa *2222');
      expect(await count('SELECT COUNT(*) AS n FROM account_aliases')).toBe(0);
    },
  },
  {
    tool: 'pending_account_bind',
    setup: async () => ({ pending_id: await insertPending('Visa *3333'), account_id: await insertAccount() }),
    altArgs: (a) => ({ ...a, pending_id: 999999 }),
    unchanged: async () => expect(await count('SELECT COUNT(*) AS n FROM pending_account_strings')).toBe(1),
    check: async (_a, r) => {
      expect(r.alias.alias_text).toBe('Visa *3333');
      expect(await count('SELECT COUNT(*) AS n FROM pending_account_strings')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM account_aliases')).toBe(1);
    },
  },
];

describe.each(cases)('MCP write tool $tool', ({ tool, setup, altArgs, check, unchanged }) => {
  it('requires the write scope', async () => {
    const args = await setup();
    const res = await call(tool, { ...args, idempotency_key: `scope-${tool}` }, ['read']);
    expect(res.error.message).toBe('Insufficient permissions. "write" scope required.');
    await unchanged(args);
  });

  it('writes nothing on the first call, then writes once on confirm with the client id audited', async () => {
    const args = { ...(await setup()), idempotency_key: `ok-${tool}` };
    const first = await call(tool, args);
    expect(first.result.structuredContent.resultType).toBe('input_required');
    expect(first.result.structuredContent.description).toMatch(ASCII_ONLY);
    await unchanged(args);

    const second = await call(tool, { ...args, requestState: first.result.structuredContent.requestState });
    expect(second.result.isError).toBeFalsy();
    const result = second.result.structuredContent;
    expect(result.resultType).toBe('complete');
    await check(args, result);

    const audit = await auditRow(args.idempotency_key);
    expect(audit).toMatchObject({ client_id: clientId, tool_name: tool, status: 'success' });

    // Idempotent replay: same key and arguments return the stored result without another write.
    const replay = await call(tool, args);
    expect(replay.result.isError).toBeFalsy();
    expect(replay.result.structuredContent.resultType).not.toBe('input_required');
    await check(args, result);

    // Same key with different arguments is a conflict.
    const conflict = await call(tool, { ...altArgs(args), idempotency_key: args.idempotency_key });
    expect(conflict.result.isError).toBe(true);
    expect(conflict.result.structuredContent.error).toMatch(/idempotency_key was already used with different arguments/);
  });

  it('returns English errors for invalid arguments', async () => {
    const res = await call(tool, { unexpected_field: 1, idempotency_key: `bad-${tool}` });
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.error).toMatch(/^Error executing tool: Fields not allowed for /);
    expect(res.result.structuredContent.error).toMatch(ASCII_ONLY);
  });
});

describe('MCP destructive account tools', () => {
  it('reject auto_confirm and do not advertise it', async () => {
    const accountId = await insertAccount();
    const aliasId = await insertAlias(accountId, 'Visa *4444');
    for (const [tool, args] of [
      ['account_delete', { account_id: accountId }],
      ['account_alias_delete', { account_id: accountId, alias_id: aliasId }],
    ] as const) {
      for (const flag of [true, false]) {
        const res = await call(tool, { ...args, auto_confirm: flag, idempotency_key: `auto-${tool}-${flag}` });
        expect(res.result.isError).toBe(true);
        expect(res.result.structuredContent.error).toMatch(/auto_confirm is not accepted/);
      }
    }
    expect(await count('SELECT COUNT(*) AS n FROM accounts')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM account_aliases')).toBe(1);

    const listReq = new Request('http://localhost/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const list: any = await (await mcpApp.fetch(listReq, typedEnv, { props: { scopes: ['read', 'write'], clientId } } as any)).json();
    const byName = new Map(list.result.tools.map((t: any) => [t.name, t]));
    for (const tool of ['account_delete', 'account_alias_delete']) {
      const t: any = byName.get(tool);
      expect(t.inputSchema.properties.auto_confirm).toBeUndefined();
      expect(t.annotations.destructiveHint).toBe(true);
    }
    expect((byName.get('account_add') as any).inputSchema.properties.auto_confirm).toBeDefined();
  });

  it('account_delete refuses an account in use with an English hint and no force option', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
       VALUES ('2026-10-01', ?, 'expense', 'Coffee', 'Food', -100, 'manual')`,
    ).bind(accountId).run();
    const res = await call('account_delete', { account_id: accountId, idempotency_key: 'in-use' });
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.error).toMatch(/cannot be deleted\. Move or delete those operations first/);
    expect(res.result.structuredContent.error).toMatch(ASCII_ONLY);
    const forced = await call('account_delete', { account_id: accountId, force: true, idempotency_key: 'in-use-force' });
    expect(forced.result.structuredContent.error).toMatch(/Fields not allowed/);
    expect(await count('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', accountId)).toBe(1);
  });

  it('account_delete preview lists exactly the aliases removed with the account', async () => {
    const accountId = await insertAccount('Card');
    const a1 = await insertAlias(accountId, 'Visa *5555');
    const a2 = await insertAlias(accountId, 'Apple Pay 5555');
    const first = await call('account_delete', { account_id: accountId, idempotency_key: 'preview' });
    const description = first.result.structuredContent.description;
    expect(description).toContain(`account ID ${accountId} "Card"`);
    expect(description).toContain(`Its 2 alias(es) will be removed with it`);
    expect(description).toContain(`"Visa *5555" (ID ${a1})`);
    expect(description).toContain(`"Apple Pay 5555" (ID ${a2})`);
  });

  it('account_alias_delete preview names the alias and the account', async () => {
    const accountId = await insertAccount('Card');
    const aliasId = await insertAlias(accountId, 'Visa *7777');
    const first = await call('account_alias_delete', { account_id: accountId, alias_id: aliasId, idempotency_key: 'alias-preview' });
    expect(first.result.structuredContent.description).toContain(
      `Confirm removing alias ID ${aliasId} "Visa *7777" from account ID ${accountId} "Card". Only the alias is removed; operations and balances are unchanged.`,
    );
  });
});
