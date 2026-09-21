// Instance reset (issue #579).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import {
  EMPTY_INSTANCE_SETTINGS,
  RESET_CONFIRM_PHRASE,
  USER_TABLES,
  isPreservedSettingKey,
  parseResetConfirmation,
} from '../src/worker/backup';
import { expectErrorCode } from './api-error-helpers';

let cookie: string;

beforeAll(async () => {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM oauth_tokens'),
    env.DB.prepare('DELETE FROM oauth_consents'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM imported_receipt_items'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM account_aliases'),
    env.DB.prepare('DELETE FROM pending_account_strings'),
    env.DB.prepare('DELETE FROM receipts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES
         ('base_currency', 'USD'),
         ('low_balance_threshold_minor', '100000')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ]);
});

async function api(method: string, path: string, body?: unknown, withCookie = true): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(withCookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env as unknown as Env);
}

describe('reset confirmation helper', () => {
  it('preserves auth/session setting keys', () => {
    expect(isPreservedSettingKey('auth_epoch')).toBe(true);
    expect(isPreservedSettingKey('session_revoked:abc')).toBe(true);
    expect(isPreservedSettingKey('passkey_revoked:cred')).toBe(true);
    expect(isPreservedSettingKey('passkey_disabled:cred')).toBe(true);
    expect(isPreservedSettingKey('base_currency')).toBe(false);
    expect(isPreservedSettingKey('setup_demo_seed')).toBe(false);
  });

  it('requires confirm and the RESET phrase', () => {
    expect(() => parseResetConfirmation(null)).toThrow();
    expect(() => parseResetConfirmation({ confirm: true })).toThrow();
    expect(() => parseResetConfirmation({ phrase: RESET_CONFIRM_PHRASE })).toThrow();
    expect(() => parseResetConfirmation({ confirm: true, phrase: 'reset' })).toThrow();
    expect(() => parseResetConfirmation({ confirm: true, phrase: RESET_CONFIRM_PHRASE })).not.toThrow();
  });
});

describe('POST /api/v2/data/reset', () => {
  it('rejects an unauthenticated session', async () => {
    const res = await api('POST', '/api/v2/data/reset', {
      confirm: true,
      phrase: RESET_CONFIRM_PHRASE,
    }, false);
    expect(res.status).toBe(401);
    await expectErrorCode(res, 'UNAUTHORIZED');
  });

  it('rejects a missing confirm flag', async () => {
    const res = await api('POST', '/api/v2/data/reset', { phrase: RESET_CONFIRM_PHRASE });
    expect(res.status).toBe(400);
    await expectErrorCode(res, 'RESET_CONFIRM_REQUIRED');
  });

  it('rejects a wrong typed phrase', async () => {
    const res = await api('POST', '/api/v2/data/reset', { confirm: true, phrase: 'wipe' });
    expect(res.status).toBe(400);
    await expectErrorCode(res, 'RESET_PHRASE_REQUIRED');
  });

  it('wipes ledger tables, restores defaults, and keeps auth plus OAuth rows', async () => {
    const created = await api('POST', '/api/v2/accounts', {
      name: 'Cash',
      currency: 'USD',
      owner: 'Owner',
      country: 'US',
      balance_minor: 500,
    });
    expect(created.status).toBe(201);
    const account = (await created.json() as { account: { id: number } }).account;
    const op = await api('POST', '/api/v2/operations', {
      date: '2026-09-20',
      account_id: account.id,
      kind: 'income',
      item: 'Demo',
      amount_minor: 100,
    });
    expect(op.status).toBe(201);
    const rate = await api('PUT', '/api/v2/fx-rates/EUR', { rate: 1.1 });
    expect(rate.status).toBe(200);
    const epochBefore = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'auth_epoch'",
    ).first<{ value: string }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES
           ('setup_demo_seed', '1'),
           ('session_revoked:sid-1', '1999999999'),
           ('passkey_revoked:cred-1', '1'),
           ('passkey_disabled:cred-1', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
      env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, created_at)
         VALUES ('client_reset', 'Reset test', '2026-09-20T12:00:00Z')`,
      ),
    ]);

    const res = await api('POST', '/api/v2/data/reset', {
      confirm: true,
      phrase: RESET_CONFIRM_PHRASE,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      reset: boolean;
      defaults: { base_currency: string; low_balance_threshold_minor: string };
    };
    expect(body).toEqual({
      ok: true,
      reset: true,
      defaults: {
        base_currency: EMPTY_INSTANCE_SETTINGS[0].value,
        low_balance_threshold_minor: EMPTY_INSTANCE_SETTINGS[1].value,
      },
    });

    const settings = await api('GET', '/api/v2/settings');
    const settingsBody = await settings.json() as { settings: Record<string, string> };
    expect(settingsBody.settings.base_currency).toBe('USD');
    expect(settingsBody.settings.low_balance_threshold_minor).toBe('100000');
    expect(settingsBody.settings.auth_epoch).toBe(epochBefore?.value);
    expect(settingsBody.settings['session_revoked:sid-1']).toBe('1999999999');
    expect(settingsBody.settings['passkey_revoked:cred-1']).toBe('1');
    expect(settingsBody.settings['passkey_disabled:cred-1']).toBe('1');
    expect(settingsBody.settings.setup_demo_seed).toBeUndefined();

    const accounts = await api('GET', '/api/v2/accounts');
    const accountBody = await accounts.json() as { accounts: unknown[] };
    expect(accountBody.accounts).toEqual([]);

    const exportRes = await api('GET', '/api/v2/backup/export');
    const dump = await exportRes.json() as { tables: Record<string, unknown[]> };
    for (const name of USER_TABLES) {
      if (name === 'settings') continue;
      expect(dump.tables[name], name).toEqual([]);
    }

    const oauth = await env.DB.prepare(
      'SELECT id FROM oauth_clients WHERE id = ?',
    ).bind('client_reset').first<{ id: string }>();
    expect(oauth?.id).toBe('client_reset');

    const me = await api('GET', '/api/auth/me');
    expect(me.status).toBe(200);
  });
});
