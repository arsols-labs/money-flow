import { env } from 'cloudflare:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import DemoBanner from '../src/ui/DemoBanner.jsx';
import Login from '../src/ui/Login.jsx';
import i18n from '../src/ui/i18n.js';
import { createSessionCookie, verifySessionCookie } from '../src/worker/auth';
import { DEMO_DISCLAIMER } from '../src/worker/demo-flag';
import { resetRateLimitMemoryForTests } from '../src/worker/rate-limit';
import { splitSqlStatements } from '../src/worker/sql-split';
import type { Env } from '../src/worker/types';

const ORIGIN = 'https://money-flow.arsols.com';
const sharedCalls: string[] = [];

function bindings(): Env {
  const real = env as unknown as Env;
  const spiedDb = new Proxy(real.DB, {
    get(target, prop) {
      if (
        prop === 'prepare'
        || prop === 'batch'
        || prop === 'exec'
        || prop === 'withSession'
        || prop === 'dump'
      ) {
        sharedCalls.push(String(prop));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'DEMO_MODE') return '1';
      if (prop === 'DB') return spiedDb;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Env;
}

function demoCookie(response: Response): string {
  const match = response.headers.getSetCookie().find((cookie) => cookie.startsWith('mf_demo_sid='));
  expect(match, 'demo session cookie').toBeTruthy();
  expect(match).toContain('HttpOnly');
  expect(match).toContain('Secure');
  return match!.split(';')[0]!;
}

async function demoFetch(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('Cookie', cookie);
  return app.request(`${ORIGIN}${path}`, { ...init, headers }, bindings());
}

beforeEach(() => {
  sharedCalls.length = 0;
  resetRateLimitMemoryForTests();
});

describe('SQL splitter', () => {
  it('keeps semicolons inside strings and drops comments', () => {
    const parts = splitSqlStatements(`
      -- comment with ;
      CREATE TABLE t (note TEXT);
      INSERT INTO t (note) VALUES ('a;b');
    `);
    expect(parts).toEqual([
      'CREATE TABLE t (note TEXT)',
      "INSERT INTO t (note) VALUES ('a;b')",
    ]);
  });
});

describe('DEMO_MODE session isolation', { timeout: 30_000 }, () => {
  it('blocks passkey enrollment and still allows session login', async () => {
    const paths = [
      '/api/auth/register/options',
      '/api/auth/register/verify',
      '/api/v2/passkeys/register-options',
      '/api/v2/passkeys/register-verify',
    ];
    const before = await env.KV.list({ prefix: 'webauthn_' });
    for (const path of paths) {
      const res = await demoFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'test-setup-token', response: { id: 'x' } }),
      });
      expect(res.status, path).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code, path).toBe('DEMO_PASSKEY_DISABLED');
      expect(body.error.message.length).toBeGreaterThan(0);
    }
    const setup = await demoFetch('/setup/passkey');
    expect(setup.status).toBe(403);
    expect((await setup.json<{ error: { code: string } }>()).error.code).toBe('DEMO_PASSKEY_DISABLED');

    const after = await env.KV.list({ prefix: 'webauthn_' });
    expect(after.keys.length).toBe(before.keys.length);

    const login = await demoFetch('/api/auth/login/options', { method: 'POST' });
    const loginBody = await login.json<{ error?: { code: string } }>();
    expect(loginBody.error?.code).not.toBe('DEMO_PASSKEY_DISABLED');
    expect(login.status).not.toBe(403);

    const session = (await createSessionCookie(env as unknown as Env, true)).split(';')[0]!;
    const sessionEnv = new Proxy(env as unknown as Env, {
      get(target, prop) {
        if (prop === 'DEMO_MODE') return '1';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Env;
    expect(await verifySessionCookie(sessionEnv, session)).toBe(true);
    expect(sharedCalls).toEqual([]);
  });

  it('writes only to the session ledger, not shared D1', async () => {
    const real = env as unknown as Env;
    const before = await real.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    const created = await demoFetch('/api/v2/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Money-Flow': '1' },
      body: JSON.stringify({
        name: 'Session Alpha',
        currency: 'USD',
        owner: 'Household',
        country: 'USA',
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const cookie = demoCookie(created);
    const listed = await demoFetch('/api/v2/accounts', {}, cookie);
    expect(listed.status).toBe(200);
    const body = await listed.json<{ accounts: { name: string; country: string; currency: string }[] }>();
    const names = body.accounts.map((account) => account.name);
    expect(names).toContain('Session Alpha');
    expect(names).toContain('Everyday Checking');
    expect(names).toContain('Sterling Current');
    expect(names).toContain('Rhine Checking');
    expect(names).toContain('Maple Everyday');
    expect(names.join(' ')).not.toMatch(/Norway|NOK/);
    const countries = new Set(body.accounts.map((account) => account.country));
    expect(countries).toEqual(new Set(['USA', 'Germany', 'United Kingdom', 'Canada']));

    const after = await real.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const leaked = await real.DB.prepare(
      "SELECT id FROM accounts WHERE name = 'Session Alpha'",
    ).first();
    expect(leaked).toBeNull();
    expect(sharedCalls).toEqual([]);
  });

  it('keeps two browser sessions on separate ledgers', async () => {
    async function open(name: string): Promise<string> {
      const created = await demoFetch('/api/v2/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Money-Flow': '1' },
        body: JSON.stringify({
          name,
          currency: 'USD',
          owner: 'Household',
          country: 'USA',
        }),
      });
      expect(created.status, await created.clone().text()).toBe(201);
      return demoCookie(created);
    }

    const cookieA = await open('Alpha Only');
    const cookieB = await open('Beta Only');
    expect(cookieA).not.toBe(cookieB);

    const listA = await (await demoFetch('/api/v2/accounts', {}, cookieA)).json<{ accounts: { name: string }[] }>();
    const listB = await (await demoFetch('/api/v2/accounts', {}, cookieB)).json<{ accounts: { name: string }[] }>();
    const namesA = listA.accounts.map((account) => account.name);
    const namesB = listB.accounts.map((account) => account.name);
    expect(namesA).toContain('Alpha Only');
    expect(namesA).not.toContain('Beta Only');
    expect(namesB).toContain('Beta Only');
    expect(namesB).not.toContain('Alpha Only');
    expect(sharedCalls).toEqual([]);
  });

  it('preserves SQLite changes() across a demo batch', async () => {
    const real = env as unknown as Env;
    const namespace = real.DEMO_SESSION;
    expect(namespace).toBeTruthy();
    const stub = namespace!.get(namespace!.idFromName(crypto.randomUUID())) as unknown as {
      ensureReady(): Promise<void>;
      ledgerBatch(statements: { sql: string; params: unknown[] }[]): Promise<{ meta: { changes: number } }[]>;
      ledgerQuery(sql: string, params: unknown[]): Promise<{ results: { value: string }[] }>;
    };
    await stub.ensureReady();
    const [first, second] = await stub.ledgerBatch([
      { sql: "INSERT INTO settings (key, value) VALUES ('probe_a', '1')", params: [] },
      {
        sql: "INSERT INTO settings (key, value) SELECT 'probe_b', 'ok' WHERE changes() = 1",
        params: [],
      },
    ]);
    expect(first?.meta.changes).toBe(1);
    expect(second?.meta.changes).toBe(1);
    const row = await stub.ledgerQuery("SELECT value FROM settings WHERE key = 'probe_b'", []);
    expect(row.results[0]?.value).toBe('ok');
    const leaked = await real.DB.prepare("SELECT key FROM settings WHERE key = 'probe_a'").first();
    expect(leaked).toBeNull();
  });

  it('logout retires the demo cookie instead of reusing that ledger', async () => {
    const created = await demoFetch('/api/v2/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Money-Flow': '1' },
      body: JSON.stringify({
        name: 'Logout Ledger',
        currency: 'USD',
        owner: 'Household',
        country: 'USA',
      }),
    });
    expect(created.status).toBe(201);
    const cookie = demoCookie(created);
    const loggedOut = await demoFetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Money-Flow': '1' },
    }, cookie);
    expect(loggedOut.status).toBe(204);
    const cleared = loggedOut.headers.getSetCookie().find((header) => header.startsWith('mf_demo_sid='));
    expect(cleared).toMatch(/Max-Age=0/i);
    const next = await demoFetch('/api/config');
    expect(demoCookie(next)).not.toBe(cookie);
  });

  it('fails closed without a DemoSession binding and does not touch shared D1', async () => {
    const missing = new Proxy(bindings(), {
      get(target, prop) {
        if (prop === 'DEMO_SESSION') return undefined;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const res = await app.request(`${ORIGIN}/api/config`, {}, missing as Env);
    expect(res.status).toBe(503);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('DEMO_LEDGER_UNAVAILABLE');
    expect(sharedCalls).toEqual([]);
  });

  it('publishes a demo disclaimer and stays off when DEMO_MODE is unset', async () => {
    const demo = await demoFetch('/api/config');
    expect(demo.status).toBe(200);
    const body = await demo.json<{ demoMode: boolean; disclaimer: string }>();
    expect(body.demoMode).toBe(true);
    expect(body.disclaimer).toBe(DEMO_DISCLAIMER);
    expect(body.disclaimer).toMatch(/not production data/);
    expect(body.disclaimer).toMatch(/PolyForm Noncommercial/);
    demoCookie(demo);

    const plain = await app.request(`${ORIGIN}/api/config`, {}, env as unknown as Env);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ demoMode: false });
    expect(plain.headers.getSetCookie().some((cookie) => cookie.startsWith('mf_demo_sid='))).toBe(false);

    const me = await demoFetch('/api/auth/me');
    const meBody = await me.json<{ authenticated: boolean; demoMode: boolean; hasPasskeys: boolean }>();
    expect(meBody.authenticated).toBe(true);
    expect(meBody.demoMode).toBe(true);
    expect(meBody.hasPasskeys).toBe(false);
  });

  it('shows the demo disclaimer in the UI and hides passkey enrollment', async () => {
    await i18n.changeLanguage('en');
    const banner = renderToStaticMarkup(React.createElement(DemoBanner));
    expect(banner).toContain('role="status"');
    expect(banner).toContain('not production data');
    expect(banner).toContain('PolyForm Noncommercial');
    const login = renderToStaticMarkup(React.createElement(Login, {
      hasPasskeys: false,
      onSuccess: () => {},
      demoMode: true,
    }));
    expect(login).toContain('Passkey enrollment is disabled');
    expect(login).not.toContain('Register this device');
  });
});
