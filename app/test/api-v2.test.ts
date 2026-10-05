// CRUD API v2 (S1-2, issue #196) — accounts, FX rates, settings.
// Hono is called directly (app.request), with no ASSETS binding and no network —
// see the approach in vitest.config.ts / test/apply-migrations.ts.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index';
import { CURRENCY_TABLES } from '../src/worker/api';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { errorBody, errorOf } from './api-error-helpers';

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let cookie: string;

// A valid session cookie does not depend on DB state — compute it once.
// createSessionCookie uses only env.SESSION_SECRET (test/env.d.ts +
// vitest.config.ts set it up specifically for this file).
beforeAll(async () => {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  cookie = setCookie.split(';')[0]!;
});

// The same isolation as in test/schema.test.ts: reverse reference order.
// Settings are now written through the API, so both keys are restored to their defaults.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
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
  const init: RequestInit = {
    method,
    headers: {
      ...(withCookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  return app.request(path, init, env as unknown as Env);
}

// owner and country are filled in by default on purpose: they are required (#232), and
// without them every helper call would test validation instead of its own scenario.
// Tests of that requirement itself hit the API directly, bypassing this helper.
async function createAccount(overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/accounts', {
    name: 'Основной',
    currency: 'usd',
    owner: 'Алекс',
    country: 'SRB',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { account: Record<string, unknown> };
}

// A planned-item reference to an account is what closes the dimension lock. A direct
// insert, not via planned-item CRUD (S1-3, issue #197): lock tests must not
// depend on the new API being correct — they check accounts, not operations.
async function referenceAccount(accountId: unknown) {
  await env.DB.prepare(
    `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
     VALUES ('2026-09-01', 'Аренда', -1000, 'USD', ?)`,
  )
    .bind(accountId)
    .run();
}

// A planned/recurring item THROUGH the new API (S1-3, issue #197) — unlike
// referenceAccount, these helpers test the CRUD itself, not only the account lock.
async function createPlannedItem(accountId: unknown, overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/planned-items', {
    date: '2026-09-01',
    title: 'Аренда',
    amount_minor: -1000,
    account_id: accountId,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { planned_item: Record<string, unknown> };
}

async function createRecurringItem(accountId: unknown, overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/recurring-items', {
    title: 'Подписка',
    amount_minor: -1000,
    account_id: accountId,
    frequency: 'daily',
    next_due_date: '2026-09-01',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { recurring_item: Record<string, unknown> };
}

// An account is required, currency is not accepted at all (it belongs to the account), the amount is a balance
// delta: an expense is negative (issue #200, owner's decision 2026-08-12).
async function createOperation(accountId: unknown, overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/operations', {
    date: '2026-08-10',
    account_id: accountId,
    kind: 'expense',
    item: 'Кофе',
    amount_minor: -350,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { operation: Record<string, unknown> };
}

// A direct rate insert that bypasses the API (#228: PUT for the base currency is now
// rejected at the door) — models a row created before the fix or by editing
// the DB directly. It lives at module level, not inside a single describe: the tests
// that need it for setup are scattered across describe('fx-rates') and across
// nested describes inside describe('FX rate coverage of currencies (issue #193)').
async function insertRate(code: string, rateE9: string, updatedAt = '2026-08-01T00:00:00Z') {
  await env.DB.prepare('INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)')
    .bind(code, rateE9, updatedAt)
    .run();
}

describe('guard: no session', () => {
  it('any /api/v2/* route without a cookie → 401', async () => {
    for (const [method, path] of [
      ['GET', '/api/v2/accounts'],
      ['GET', '/api/v2/fx-rates'],
      ['GET', '/api/v2/settings'],
      ['GET', '/api/v2/planned-items'],
      ['GET', '/api/v2/recurring-items'],
    ] as const) {
      const res = await api(method, path, undefined, false);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      });
    }
  });
});

describe('accounts', () => {
  it('create and read back in the list', async () => {
    const created = await createAccount({ name: 'Карта', currency: 'rsd', balance_minor: 12345 });
    expect(created.account).toMatchObject({
      name: 'Карта',
      currency: 'RSD', // normalized to UPPER
      balance_minor: 12345,
      sort: 0,
      archived: false,
    });
    expect(created.account.balance_updated_at).toMatch(ISO_SECONDS);

    const listRes = await api('GET', '/api/v2/accounts');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]!.id).toBe(created.account.id);
  });

  it('a second account without sort gets max(sort)+1', async () => {
    await createAccount({ sort: 5 });
    const second = await createAccount({ name: 'Второй' });
    expect(second.account.sort).toBe(6);
  });

  it('rejects an empty name', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: '   ', currency: 'USD' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('rejects a currency that is not three letters', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: 'X', currency: 'US' });
    expect(res.status).toBe(400);
  });

  it('rejects a fractional balance_minor', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: 'X', currency: 'USD', balance_minor: 10.5 });
    expect(res.status).toBe(400);
  });

  // ROADMAP rule "An account has one owner, one currency, and a required
  // country": owner and country are required fields just like name and currency.
  // An empty string and null fail too: these fields have no "unset" state.
  it.each([
    ['without owner', { name: 'X', currency: 'USD', country: 'SRB' }],
    ['without country', { name: 'X', currency: 'USD', owner: 'Алекс' }],
    ['owner as an empty string', { name: 'X', currency: 'USD', owner: '   ', country: 'SRB' }],
    ['country as an empty string', { name: 'X', currency: 'USD', owner: 'Алекс', country: '' }],
    ['owner as null', { name: 'X', currency: 'USD', owner: null, country: 'SRB' }],
    ['country as null', { name: 'X', currency: 'USD', owner: 'Алекс', country: null }],
  ])('POST %s → 400', async (_label, body) => {
    const res = await api('POST', '/api/v2/accounts', body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('POST with owner and country stores them as given, and bank stays optional', async () => {
    const created = await createAccount({ owner: '  Алекс  ', country: '  SRB  ' });
    expect(created.account).toMatchObject({ owner: 'Алекс', country: 'SRB', bank: null });
  });

  it('PATCH does not allow clearing the owner or the country', async () => {
    const created = await createAccount();
    for (const patch of [{ owner: '' }, { owner: null }, { country: '   ' }, { country: null }]) {
      const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, patch);
      expect(res.status).toBe(400);
    }
  });

  it('PATCH changes the fields that were sent and leaves the rest alone', async () => {
    const created = await createAccount({ name: 'До', bank: 'Старый банк', currency: 'usd' });
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, { name: 'После', bank: 'Новый банк' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ name: 'После', bank: 'Новый банк', currency: 'USD' });
  });

  it('PATCH with balance_minor moves balance_updated_at — even when the value is unchanged', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const created = await createAccount({ balance_minor: 1000 });
      expect(created.account.balance_updated_at).toBe('2026-01-01T00:00:00Z');

      vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
      const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, { balance_minor: 1000 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { account: Record<string, unknown> };
      expect(body.account.balance_minor).toBe(1000);
      expect(body.account.balance_updated_at).toBe('2026-01-01T00:00:05Z');
    } finally {
      vi.useRealTimers();
    }
  });

  // Currencies have different minor-unit scales, so changing currency without
  // a new balance would silently rescale the amount by orders of magnitude ($1500.00 = 150000 cents
  // → ¥150 000). The server rejects that so the client must name the amount explicitly.
  it('PATCH that changes currency without balance_minor → 400', async () => {
    const created = await createAccount({ currency: 'USD', balance_minor: 150000 });
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, { currency: 'JPY' });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('ACCOUNT_CURRENCY_CHANGE_REQUIRES_BALANCE');

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts[0]).toMatchObject({ currency: 'USD', balance_minor: 150000 });
  });

  it('PATCH that changes currency and includes a balance succeeds', async () => {
    const created = await createAccount({ currency: 'USD', balance_minor: 150000 });
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, {
      currency: 'JPY',
      balance_minor: 1500,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ currency: 'JPY', balance_minor: 1500 });
  });

  it('PATCH with the same currency does not require a balance', async () => {
    const created = await createAccount({ currency: 'USD', name: 'До' });
    // The edit form always sends currency, even when it was not changed — this path
    // must not hit the check above.
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, { currency: 'usd', name: 'После' });
    expect(res.status).toBe(200);
  });

  it('rejects sort outside the exact-integer range — otherwise the INTEGER column would receive a REAL', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: 'X', currency: 'USD', sort: 1e21 });
    expect(res.status).toBe(400);
  });

  // MAX(sort)+1 for a new account is computed without checks, so the bound
  // is needed on input: otherwise one large value in the table would drag
  // the next increment past the exact-integer limit.
  it('rejects sort at the exact-integer boundary itself', async () => {
    const res = await api('POST', '/api/v2/accounts', {
      name: 'X',
      currency: 'USD',
      sort: Number.MAX_SAFE_INTEGER,
    });
    expect(res.status).toBe(400);
  });

  it('PATCH of a missing account → 404', async () => {
    const res = await api('PATCH', '/api/v2/accounts/999999', { name: 'Кто-то' });
    expect(res.status).toBe(404);
  });

  it('PATCH with an empty body (no known fields) → 400', async () => {
    const created = await createAccount();
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, {});
    expect(res.status).toBe(400);
  });

  it('DELETE removes the account: 204 and it disappears from the list', async () => {
    const created = await createAccount();
    const delRes = await api('DELETE', `/api/v2/accounts/${created.account.id}`);
    expect(delRes.status).toBe(204);

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts).toHaveLength(0);
  });

  it('DELETE of a missing account → 404', async () => {
    const res = await api('DELETE', '/api/v2/accounts/999999');
    expect(res.status).toBe(404);
  });

  it('DELETE of an account referenced by planned_items → 409, and the account stays', async () => {
    const created = await createAccount();
    await referenceAccount(created.account.id);

    const delRes = await api('DELETE', `/api/v2/accounts/${created.account.id}`);
    expect(delRes.status).toBe(409);
    expect(await errorOf(delRes)).toBeTypeOf('string');

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts.map((a) => a.id)).toContain(created.account.id);
  });
});

// The only sign of balance freshness is `balance_updated_at`, and before this
// task the only way to move it was to change the amount. A separate route lets
// you say "checked with the bank, the amount is the same" without distorting anything.
describe('balance confirmation (issue #223)', () => {
  const PATH = (id: unknown) => `/api/v2/accounts/${id}/confirm-balance`;

  it('moves balance_updated_at and touches nothing else', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const created = await createAccount({ balance_minor: 250000, currency: 'usd', bank: 'Банк', type: 'card' });
      expect(created.account.balance_updated_at).toBe('2026-01-01T00:00:00Z');

      vi.setSystemTime(new Date('2026-04-01T12:34:56Z'));
      const res = await api('POST', PATH(created.account.id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { account: Record<string, unknown> };

      expect(body.account.balance_updated_at).toBe('2026-04-01T12:34:56Z');
      // Everything else is byte-for-byte the same. Compare whole objects, not
      // one field: confirmation must be safe as a whole, and a new account
      // column falls under this check on its own, without editing the test.
      expect({ ...body.account, balance_updated_at: null }).toEqual({
        ...created.account,
        balance_updated_at: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the timestamp has second precision, as everywhere else in v2', async () => {
    const created = await createAccount();
    const res = await api('POST', PATH(created.account.id));
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.balance_updated_at).toMatch(ISO_SECONDS);
  });

  it('the new value is visible in the list, not only in the response', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const created = await createAccount({ balance_minor: 777 });

      vi.setSystemTime(new Date('2026-02-02T02:02:02Z'));
      expect((await api('POST', PATH(created.account.id))).status).toBe(200);

      const listRes = await api('GET', '/api/v2/accounts');
      const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
      expect(list.accounts[0]).toMatchObject({
        balance_minor: 777,
        balance_updated_at: '2026-02-02T02:02:02Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // The dimension lock (#232) does not apply here: the check timestamp is not
  // an account dimension. Confirming the balance on an account with operations matters even more:
  // those are the accounts that take part in the forecast.
  it('works on an account occupied by an operation — the dimension lock does not apply to it', async () => {
    const created = await createAccount();
    await referenceAccount(created.account.id);
    const res = await api('POST', PATH(created.account.id));
    expect(res.status).toBe(200);
  });

  it('works on an archived account — the money on it has not gone anywhere', async () => {
    const created = await createAccount({ balance_minor: 500 });
    expect((await api('PATCH', `/api/v2/accounts/${created.account.id}`, { archived: true })).status).toBe(200);

    const res = await api('POST', PATH(created.account.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ archived: true, balance_minor: 500 });
  });

  it('a missing account → 404, and nothing is created', async () => {
    const res = await api('POST', PATH(999999));
    expect(res.status).toBe(404);

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts).toHaveLength(0);
  });

  it('a non-numeric id and a fractional id → 404, not 500', async () => {
    for (const raw of ['abc', '1.5']) {
      const res = await api('POST', PATH(raw));
      expect(res.status).toBe(404);
    }
  });

  // The route does not read the body at all — there is nothing to confirm except the fact itself. Broken
  // JSON must not turn into a 500: the client has no reason to send it, but the
  // endpoint has no reason to crash on it either.
  it('a submitted body is ignored, and broken JSON does not yield 500', async () => {
    const created = await createAccount({ balance_minor: 4242 });
    const res = await app.request(
      PATH(created.account.id),
      { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{' },
      env as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.balance_minor).toBe(4242);
  });

  it('without a session → 401 and the timestamp does not move', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const created = await createAccount();

      vi.setSystemTime(new Date('2026-06-06T06:06:06Z'));
      const res = await api('POST', PATH(created.account.id), undefined, false);
      expect(res.status).toBe(401);

      const listRes = await api('GET', '/api/v2/accounts');
      const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
      expect(list.accounts[0]!.balance_updated_at).toBe('2026-01-01T00:00:00Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ROADMAP rule: "After the first operation, the owner, currency, country, bank, and account
// type are immutable". The first operation here means any reference to the account from
// planned_items or recurring_items — the same occupancy signal that already
// blocks DELETE.
describe('account dimension lock (issue #232)', () => {
  const LOCKED: Array<[string, Record<string, unknown>]> = [
    ['owner', { owner: 'Другой' }],
    ['country', { country: 'USA' }],
    ['bank', { bank: 'Другой банк' }],
    ['type', { type: 'cash' }],
    // Currency is sent with a balance: without it the request would hit 400 before the lock, and
    // the test would prove the wrong thing.
    ['currency', { currency: 'EUR', balance_minor: 100 }],
  ];

  it.each(LOCKED)('PATCH %s after a reference appears → 409, and the value is unchanged', async (field, patch) => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, patch);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBeTypeOf('string');

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts[0]![field]).toBe(account[field]);
  });

  it.each(LOCKED)('PATCH %s before the first reference still succeeds', async (field, patch) => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, patch);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account[field]).not.toBe(account[field]);
  });

  // The lock counts an actual change, not the mere presence of a field in the body: the edit form
  // always sends every field, including untouched ones. Otherwise renaming an account
  // that is already referenced would return 409.
  it('PATCH with the previous dimension values after a reference succeeds', async () => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, {
      name: 'Переименован',
      owner: account.owner,
      country: account.country,
      bank: account.bank,
      type: account.type,
      currency: 'usd', // different case, same currency — this is not a change
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ name: 'Переименован', currency: 'USD' });
  });

  it('the lock does not touch balance, order, or archive', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);

    for (const patch of [{ balance_minor: 999 }, { sort: 7 }, { archived: true }, { name: 'Новое имя' }]) {
      const res = await api('PATCH', `/api/v2/accounts/${account.id}`, patch);
      expect(res.status).toBe(200);
    }
  });

  // Archive is a row flag, not a withdrawal of money: the balance on the account has not
  // gone anywhere, and unarchiving costs one PATCH. The rule makes no exception
  // for archive, and neither does the code.
  it('archiving does not lift the lock', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);
    expect((await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true })).status).toBe(200);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { owner: 'Другой' });
    expect(res.status).toBe(409);
  });

  // The lock is per account: it is about operations on THIS account. Without this test
  // the condition `account_id = accounts.id` could be replaced with `account_id IS NOT
  // NULL` — that is, lock every account in the database at once — and the whole file would stay
  // green (verified by swapping the SQL).
  it('one account being occupied does not lock another', async () => {
    const locked = (await createAccount({ name: 'Занятый' })).account;
    const free = (await createAccount({ name: 'Свободный', sort: 1 })).account;
    await referenceAccount(locked.id);

    expect((await api('PATCH', `/api/v2/accounts/${locked.id}`, { owner: 'Другой' })).status).toBe(409);

    const res = await api('PATCH', `/api/v2/accounts/${free.id}`, { owner: 'Другой' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.owner).toBe('Другой');

    // And the occupied account's owner is unchanged — the edit landed on exactly the free account.
    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts.find((a) => a.id === locked.id)!.owner).toBe(locked.owner);
  });

  // A lock rejection rejects the whole request, not "I will apply what I can". Otherwise
  // an owner who corrected the name and the country in one form would see a 409 and half
  // of the changes saved.
  it('on 409 nothing from that same body is applied', async () => {
    const { account } = await createAccount({ balance_minor: 1000 });
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, {
      owner: 'Другой',
      name: 'Новое имя',
      balance_minor: 999,
      sort: 7,
    });
    expect(res.status).toBe(409);

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts[0]).toMatchObject({
      owner: account.owner,
      name: account.name,
      balance_minor: 1000,
      sort: account.sort,
      balance_updated_at: account.balance_updated_at,
    });
  });

  // The lock is terminal, while the balance_minor requirement on a currency change is fixable.
  // Answering "add balance_minor" first, and then on the obedient retry
  // "too late to change", would send the client in circles.
  it('changing currency on an occupied account returns 409, not "pass balance_minor"', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { currency: 'EUR' });
    expect(res.status).toBe(409);
  });

  it('unarchiving an occupied account succeeds — the lock does not touch archive in either direction', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);
    expect((await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true })).status).toBe(200);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.archived).toBe(false);
  });

  // The only branch where the comparison is NULL against a string: the bank was never
  // set, and someone tries to set it after the first operation.
  it('bank from empty to a value after a reference → 409', async () => {
    const { account } = await createAccount();
    expect(account.bank).toBeNull();
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { bank: 'Появился' });
    expect(res.status).toBe(409);
  });

  // The form always sends every field — "save without changing anything" must
  // respond the same way as a save that does change something, not fail on an empty SET.
  it('PATCH with the previous values and not a single change → 200 and the row is untouched', async () => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, {
      name: account.name,
      owner: account.owner,
      country: account.country,
      bank: account.bank,
      type: account.type,
      currency: account.currency,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject(account);
  });

  // The two checks below look at the SQL itself, not the status code, and that is not
  // a whim: both lock defenses are invisible from the outside. Their result matches
  // the result of their absence in everything except a race, and this harness does not
  // reproduce one — D1 in miniflare serializes requests. Without them, the line with
  // the filter and the guard in WHERE can be removed, and the whole file stays green
  // (verified by swapping both).
  async function sqlOf(run: () => Promise<unknown>): Promise<string[]> {
    const statements: string[] = [];
    const original = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      statements.push(sql);
      return original(sql);
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return statements;
  }

  // A locked field kept at its previous value must not appear in SET at all: the guard in
  // WHERE is added only when dimensions actually change, so such a
  // write would slip past the lock and overwrite the column with the snapshot value
  // read before someone else's concurrent edit.
  it('previous dimensions do not appear in SET', async () => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });

    const statements = await sqlOf(() =>
      api('PATCH', `/api/v2/accounts/${account.id}`, {
        name: 'Новое имя',
        owner: account.owner,
        country: account.country,
        bank: account.bank,
        type: account.type,
        currency: account.currency,
      }),
    );

    const update = statements.find((sql) => sql.startsWith('UPDATE accounts'))!;
    expect(update).toContain('name = ?');
    for (const field of ['owner', 'country', 'bank', 'type', 'currency']) {
      expect(update).not.toContain(`${field} = ?`);
    }
  });

  // The other half of the lock: the occupancy condition goes into the WHERE of the UPDATE itself,
  // otherwise the first operation can slip in between the early check and the write.
  it('changing a dimension adds the occupancy condition to the UPDATE itself, and a name edit does not', async () => {
    const { account } = await createAccount();

    const withLock = await sqlOf(() =>
      api('PATCH', `/api/v2/accounts/${account.id}`, { owner: 'Другой' }),
    );
    const lockUpdate = withLock.find((sql) => sql.startsWith('UPDATE accounts'))!;
    expect(lockUpdate).toContain('NOT EXISTS (SELECT 1 FROM planned_items');
    expect(lockUpdate).toContain('NOT EXISTS (SELECT 1 FROM recurring_items');

    const withoutLock = await sqlOf(() =>
      api('PATCH', `/api/v2/accounts/${account.id}`, { name: 'Другое имя' }),
    );
    expect(withoutLock.find((sql) => sql.startsWith('UPDATE accounts'))!).not.toContain('NOT EXISTS');
  });

  it('a reference from recurring_items closes the lock the same way a planned one does', async () => {
    const { account } = await createAccount();
    await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, next_due_date)
       VALUES ('Подписка', -1000, 'USD', ?, 'daily', '2026-09-01')`,
    )
      .bind(account.id)
      .run();

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { country: 'USA' });
    expect(res.status).toBe(409);
  });
});

describe('fx-rates', () => {
  it('PUT creates, a repeat PUT updates, and it does not multiply rows', async () => {
    const first = await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { rate: Record<string, unknown> };
    expect(firstBody.rate).toMatchObject({ code: 'RSD', rate_e9: 9_200_000, rate: '0.0092' });
    expect(firstBody.rate.updated_at).toMatch(ISO_SECONDS);

    const second = await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0100' });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { rate: Record<string, unknown> };
    expect(secondBody.rate).toMatchObject({ code: 'RSD', rate_e9: 10_000_000, rate: '0.01' });

    const listRes = await api('GET', '/api/v2/fx-rates');
    const list = (await listRes.json()) as { rates: Array<Record<string, unknown>> };
    expect(list.rates).toHaveLength(1);
  });

  it('an integer value is formatted without trailing zeros ("1" when rate_e9 = 1e9)', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/eur', { rate: '1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate: Record<string, unknown> };
    expect(body.rate).toMatchObject({ code: 'EUR', rate_e9: 1_000_000_000, rate: '1' });
  });

  it('accepts a rate as a JSON number, not only as a string', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/rsd', { rate: 0.0092 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate: Record<string, unknown> };
    expect(body.rate.rate_e9).toBe(9_200_000);
  });

  it.each([
    ['exponential notation', '1e-3'],
    ['a zero rate', '0'],
    ['more than nine digits after the decimal point', '0.0000000001'],
    // Without an upper bound this value would overflow SQLite's 64-bit INTEGER
    // and land in the database as TEXT — CHECK (rate_e9 > 0) lets such a string
    // through. The test pins down that the rejection happens on input, not as corruption
    // of the data on the way out (see MAX_RATE_E9 in src/worker/api.ts).
    ['a rate beyond the exact integer', '99999999999.999999999'],
  ])('rejects: %s (%s)', async (_label, rate) => {
    const res = await api('PUT', '/api/v2/fx-rates/rub', { rate });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('accepts a rate right at the exact-integer boundary', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/rub', { rate: '9007199.254740991' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate: Record<string, unknown> };
    expect(body.rate.rate_e9).toBe(Number.MAX_SAFE_INTEGER);
    expect(body.rate.rate).toBe('9007199.254740991');
  });

  it('DELETE removes the rate → 204', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(204);

    const listRes = await api('GET', '/api/v2/fx-rates');
    const list = (await listRes.json()) as { rates: Array<Record<string, unknown>> };
    expect(list.rates).toHaveLength(0);
  });

  it('DELETE of a missing rate → 404', async () => {
    const res = await api('DELETE', '/api/v2/fx-rates/xyz');
    expect(res.status).toBe(404);
  });

  // #228: a rate for the base currency is nonsense (1 USD = 1 USD when the base is USD),
  // and the S1-4 calculation core will not use it. Input is closed on PUT, and the row does
  // not appear at all — not only status 400, but also absence from GET.
  it('PUT of the base currency → 400, and no row appears in fx_rates', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/USD', { rate: '1' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('USD');

    const listRes = await api('GET', '/api/v2/fx-rates');
    const list = (await listRes.json()) as { rates: Array<Record<string, unknown>> };
    expect(list.rates).toEqual([]);
  });

  // normalizeCurrencyCodeParam uppercases BEFORE comparing with
  // the base currency — lowercase in the path must not bypass this check.
  it('PUT /fx-rates/usd (lowercase in the path) when the base is USD → 400', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/usd', { rate: '1' });
    expect(res.status).toBe(400);
  });

  // The row is already in the database (created before the fix or by a direct DB edit) — PUT does
  // not touch it: the server rejects the request before the UPSERT, so the value and updated_at
  // stay as they were.
  it('a base-currency row already in the database is not overwritten by PUT', async () => {
    await insertRate('USD', '1000000000', '2026-01-01T00:00:00Z');

    const res = await api('PUT', '/api/v2/fx-rates/usd', { rate: '2' });
    expect(res.status).toBe(400);

    const listRes = await api('GET', '/api/v2/fx-rates');
    const list = (await listRes.json()) as { rates: Array<Record<string, unknown>> };
    expect(list.rates).toEqual([
      expect.objectContaining({ code: 'USD', rate: '1', updated_at: '2026-01-01T00:00:00Z' }),
    ]);
  });

  // A regression next to the new ban: it applies only to the code that matches
  // the base currency — the other codes are still saved as before.
  it('a non-base currency is still saved by PUT', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    expect(res.status).toBe(200);
  });

  it('changing the base between the check and the rate UPSERT → 409 with no stale row', async () => {
    const realPrepare = env.DB.prepare.bind(env.DB);
    let baseChanged = false;
    const changeBaseOnce = async () => {
      if (baseChanged) return;
      baseChanged = true;
      await realPrepare("UPDATE settings SET value = 'EUR' WHERE key = 'base_currency'").run();
    };

    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation(((sql: string) => {
      const statement = realPrepare(sql);
      if (!sql.includes('INSERT INTO fx_rates (code, rate_e9, updated_at)')) return statement as never;
      return {
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return {
            first: async <T = unknown>() => {
              await changeBaseOnce();
              return bound.first<T>();
            },
          };
        },
      } as never;
    }) as never);

    try {
      // Initially the base is USD
      await realPrepare("UPDATE settings SET value = 'USD' WHERE key = 'base_currency'").run();
      const res = await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.92' });
      
      // The UPSERT succeeded. Changing the base did not interfere, because the base is no longer checked.
      expect(res.status).toBe(200);
      const row = await realPrepare("SELECT COUNT(*) AS count FROM fx_rates WHERE code = 'RSD'").first<{
        count: number;
      }>();
      expect(row?.count).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// Invariant of issue #193: a currency that something in the database references must have
// a rate to the base — otherwise its amounts cannot be converted. The schema cannot express this
// (CHECK cannot see another table, and v2 has no triggers), so the API holds it:
// DELETE will not remove the rate of a currency in use, and GET shows the ones that still
// have no rate.
describe('FX rate coverage of currencies (issue #193)', () => {
  async function fxState() {
    const res = await api('GET', '/api/v2/fx-rates');
    expect(res.status).toBe(200);
    return (await res.json()) as {
      base_currency: string | null;
      missing: string[];
      rates: Array<Record<string, unknown>>;
    };
  }

  // Planned and recurring items reference a currency through their own column — insert them
  // directly where only that fact is needed. Without those inserts, half
  // of the invariant would not be tested at all: dropping a table from
  // CURRENCY_TABLES would still pass a fully green run.
  //
  // Operations are absent here on purpose: they no longer have a currency of their own (0005); it
  // comes from the account — and the currency "in use" is held by the same account the operation
  // references. A separate test for that sits below.

  async function insertPlanned(currency: string, accountId: unknown) {
    await env.DB.prepare(
      "INSERT INTO planned_items (date, title, amount_minor, currency, account_id) VALUES ('2026-09-01', 'Страховка', -50000, ?, ?)",
    )
      .bind(currency, accountId)
      .run();
  }

  async function insertRecurring(currency: string, accountId: unknown) {
    await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, next_due_date)
       VALUES ('Подписка', -1000, ?, ?, 'daily', '2026-09-01')`,
    )
      .bind(currency, accountId)
      .run();
  }

  it('on an empty database: the base currency is named, and no currency lacks a rate', async () => {
    const state = await fxState();
    expect(state.base_currency).toBe('USD');
    expect(state.missing).toEqual([]);
  });

  it('an account in a currency without a rate lands in missing, and a rate removes it from there', async () => {
    await createAccount({ currency: 'RSD' });
    expect((await fxState()).missing).toEqual(['RSD']);

    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    expect((await fxState()).missing).toEqual([]);
  });

  it('the base currency does not land in missing — a rate to itself is not required', async () => {
    await createAccount({ currency: 'USD' });
    expect((await fxState()).missing).toEqual([]);
  });

  // Exactly the scenario from #193: archive does not "release" the currency. The money on the account
  // is still there, unarchiving is one PATCH, and conversion will need the rate again.
  it('an archived account keeps its currency in missing just like an active one', async () => {
    const { account } = await createAccount({ currency: 'RSD' });
    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true });
    expect(res.status).toBe(200);
    expect((await fxState()).missing).toEqual(['RSD']);
  });

  // This used to check that a spend itself supplies the currency in use, through its own
  // column. Since 0005 there is no such column: the operation references an account, and that account
  // holds the currency. The invariant is not weaker for it — an operation cannot be created without an account —
  // but it is now held through `accounts`, which is what the test pins down.
  it('the currency in use is held by the account of the operation, not by the operation itself', async () => {
    const { account } = await createAccount({ currency: 'RUB' });
    await createOperation(account.id);
    expect((await fxState()).missing).toEqual(['RUB']);
  });

  it('missing is sorted and has no duplicates', async () => {
    await createAccount({ currency: 'RSD' });
    await createAccount({ name: 'Второй', currency: 'RSD' });
    await createAccount({ name: 'Третий', currency: 'EUR' });
    expect((await fxState()).missing).toEqual(['EUR', 'RSD']);
  });

  it('DELETE of a rate for a currency an account occupies → 409, and the rate stays', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    await createAccount({ currency: 'RSD' });

    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('RSD');
    expect((await fxState()).rates).toHaveLength(1);
  });

  it('DELETE of a rate for a currency an ARCHIVED account occupies → 409 as well', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    const { account } = await createAccount({ currency: 'RSD' });
    await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true });

    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(409);
  });

  it('DELETE of a rate for a currency occupied by an account that has an operation → 409', async () => {
    await api('PUT', '/api/v2/fx-rates/rub', { rate: '0.0127' });
    const { account } = await createAccount({ currency: 'RUB' });
    await createOperation(account.id);

    const res = await api('DELETE', '/api/v2/fx-rates/rub');
    expect(res.status).toBe(409);
  });

  it('a currency that is no longer in use can be deleted', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    const { account } = await createAccount({ currency: 'RSD' });
    expect((await api('DELETE', '/api/v2/fx-rates/rsd')).status).toBe(409);

    // The account moved to another currency — nothing is left to hold the rate.
    await api('PATCH', `/api/v2/accounts/${account.id}`, { currency: 'USD', balance_minor: 0 });
    expect((await api('DELETE', '/api/v2/fx-rates/rsd')).status).toBe(204);
  });

  // A row in fx_rates for the base currency is a data-entry error: conversion does not
  // use it. If the same occupancy check held that row, this
  // error could not be fixed — accounts in the base currency always exist.
  it('the base-currency rate can be deleted even when accounts in that currency exist', async () => {
    // Setup via insertRate, not PUT: since #228, PUT for the base currency
    // is rejected at the door — here we model a row that is already in the database.
    await insertRate('USD', '1000000000');
    await createAccount({ currency: 'USD' });

    const res = await api('DELETE', '/api/v2/fx-rates/usd');
    expect(res.status).toBe(204);
  });

  it('a planned item supplies a currency in use', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    await insertPlanned('CHF', account.id);
    expect((await fxState()).missing).toEqual(['CHF']);

    await api('PUT', '/api/v2/fx-rates/chf', { rate: '1.1' });
    expect((await api('DELETE', '/api/v2/fx-rates/chf')).status).toBe(409);
  });

  it('a recurring item supplies a currency in use', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    await insertRecurring('GBP', account.id);
    expect((await fxState()).missing).toEqual(['GBP']);

    await api('PUT', '/api/v2/fx-rates/gbp', { rate: '1.3' });
    expect((await api('DELETE', '/api/v2/fx-rates/gbp')).status).toBe(409);
  });

  // The list of tables that reference a currency is hardcoded as a constant. If the schema
  // gains another such table and the constant is not updated, that table silently
  // drops out of both checks — and the test catches that when the schema changes, not
  // in production. PRAGMA table_info is unavailable in D1 (SQLITE_AUTH), so whether
  // the column exists is discovered with a probe SELECT.
  it('CURRENCY_TABLES lists every schema table that has a currency column', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();

    const withCurrency: string[] = [];
    for (const { name } of results) {
      try {
        await env.DB.prepare(`SELECT currency FROM ${name} LIMIT 0`).all();
        withCurrency.push(name);
      } catch (e) {
        // Swallow ONLY "no such column". An unconditional catch would yield
        // a false green: a table with currency whose probe SELECT failed for any
        // other reason would silently drop out of the comparison — the test would miss
        // exactly the thing it was written to catch.
        if (!(e instanceof Error) || !/no such column/i.test(e.message)) throw e;
      }
    }
    expect(withCurrency.sort()).toEqual([...CURRENCY_TABLES].sort());
  });

  it('DELETE returns 404, not 409, when the currency is in use but there is no rate row', async () => {
    await createAccount({ currency: 'RSD' });
    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(404);
  });

  describe('the base currency is read from settings', () => {
    async function setBase(value: string | null) {
      if (value === null) await env.DB.prepare("DELETE FROM settings WHERE key = 'base_currency'").run();
      else await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'base_currency'").bind(value).run();
    }


    it('it is not hardcoded: with EUR and no rate, it stays EUR', async () => {
      await setBase('EUR');
      await createAccount({ currency: 'EUR' });
      await createAccount({ name: 'Долларовый', currency: 'USD' });
      const state = await fxState();
      expect(state.base_currency).toBe('EUR');
      expect(state.missing).toEqual(['EUR']);
    });

    // Normalization lives in two forms — in JS (`readBaseCurrency`, which serves
    // GET and PUT) and in SQL (inside the DELETE condition). They must not diverge,
    // and EVERY request has to be checked: a GET-only test would still pass
    // when DELETE treats an entirely different currency as the base — verified
    // by mutation.
    it('it is normalized: case and spaces in settings do not change the value', async () => {
      await setBase('  eur  ');
      // Input for USD is now rejected (USD is the global anchor)
      await insertRate('USD', '1000000000');
      await createAccount({ currency: 'EUR' });
      await createAccount({ name: 'Долларовый', currency: 'USD' });

      const state = await fxState();
      expect(state.base_currency).toBe('EUR');
      expect(state.missing).toEqual(['EUR']); // EUR needs a rate to USD!

      expect((await api('DELETE', '/api/v2/fx-rates/usd')).status).toBe(204);
    });


    it('a missing settings row is an unusable value too', async () => {
      await setBase(null);
      await createAccount({ currency: 'EUR' });
      await createAccount({ name: 'Долларовый', currency: 'USD' });
      const state = await fxState();
      expect(state.base_currency).toBeNull();
      expect(state.missing).toEqual(['EUR']);
    });

    it('the USD rate can be deleted even when the base is not USD', async () => {
      await setBase('EUR');
      await insertRate('USD', '1000000000');
      await createAccount({ currency: 'USD' });
      expect((await api('DELETE', '/api/v2/fx-rates/usd')).status).toBe(204);
    });

    // Changing the base currency is a separate question in issue #228: the ban and the allowances
    // follow the CURRENT settings value, rather than sticking to the currency that
    // was the base when the row was inserted.
    it('changing the base currency no longer affects the rate ban (only USD is always forbidden)', async () => {
      // While USD is the base, it may hold a rate created before the fix or
      // by a direct DB edit (insertRate) — it does not affect conversion, and DELETE
      // removes it.
      await insertRate('USD', '1000000000');
      await createAccount({ currency: 'USD' });
      expect((await api('DELETE', '/api/v2/fx-rates/usd')).status).toBe(204);

      await setBase('EUR');

      // USD is no longer the base, but it is still the anchor: it has no rate, and a live account in it → NOT in missing.
      expect((await fxState()).missing).toEqual([]);

      // Input for USD is always closed.
      expect((await api('PUT', '/api/v2/fx-rates/usd', { rate: '1.05' })).status).toBe(400);

      // Input for EUR is open, even though it is now the display base.
      expect((await api('PUT', '/api/v2/fx-rates/eur', { rate: '1' })).status).toBe(200);
    });

    // The other half of that same question from issue #228: the new base currency
    // may have picked up a rate back when it was an ordinary currency. Such a row becomes
    // erroneous after the fact, and its fate is the same as one entered by hand:
    // GET shows it (otherwise the owner would never learn it is there), PUT does not update it,
    // DELETE removes it even while accounts in that currency are live.
    it('a display-currency rate cannot be deleted while that currency is in use, because it is not the anchor (USD)', async () => {
      await insertRate('EUR', '1080000000');
      await createAccount({ currency: 'EUR' });
      await setBase('EUR');

      const state = await fxState();
      expect(state.base_currency).toBe('EUR');
      expect(state.rates).toEqual([expect.objectContaining({ code: 'EUR', rate: '1.08' })]);
      
      // Conversion through USD requires the EUR rate!
      // So the EUR rate does not land in missing, because it EXISTS!
      expect(state.missing).toEqual([]);

      // Input for EUR is open! We can update its rate, because it is not USD.
      expect((await api('PUT', '/api/v2/fx-rates/eur', { rate: '1.09' })).status).toBe(200);

      // It cannot be deleted, because accounts in EUR require a rate to the anchor (USD)!
      expect((await api('DELETE', '/api/v2/fx-rates/eur')).status).toBe(409);
      expect((await fxState()).missing).toEqual([]);
    });
  });
});

describe('planned_items (issue #197)', () => {
  it('create and read: the default currency comes from the account', async () => {
    const { account } = await createAccount({ currency: 'RSD' });
    const created = await createPlannedItem(account.id);
    expect(created.planned_item).toMatchObject({
      date: '2026-09-01',
      title: 'Аренда',
      amount_minor: -1000,
      currency: 'RSD',
      account_id: account.id,
      category: null,
      done: false,
    });

    const listRes = await api('GET', '/api/v2/planned-items');
    const list = (await listRes.json()) as { planned_items: Array<Record<string, unknown>> };
    expect(list.planned_items).toHaveLength(1);
    expect(list.planned_items[0]!.id).toBe(created.planned_item.id);
    const stored = await env.DB.prepare('SELECT revision FROM planned_items WHERE id = ?')
      .bind(created.planned_item.id).first<{ revision: string }>();
    expect(stored?.revision).toMatch(/^[0-9a-f]{32}$/);
  });

  it('an explicit currency is accepted as given and does not have to match the account currency', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    const created = await createPlannedItem(account.id, { currency: 'eur' });
    expect(created.planned_item.currency).toBe('EUR');
  });

  it.each([
    ['without date', { title: 'X', amount_minor: -100 }],
    ['without title', { date: '2026-09-01', amount_minor: -100 }],
    ['without amount_minor', { date: '2026-09-01', title: 'X' }],
    ['without account_id', { date: '2026-09-01', title: 'X', amount_minor: -100 }],
  ])('POST %s → 400', async (_label, body) => {
    const res = await api('POST', '/api/v2/planned-items', body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('amount_minor = 0 → 400', async () => {
    const { account } = await createAccount();
    const res = await api('POST', '/api/v2/planned-items', {
      date: '2026-09-01',
      title: 'X',
      amount_minor: 0,
      account_id: account.id,
    });
    expect(res.status).toBe(400);
  });

  it('a missing account_id → 400, not a 500 from the FK', async () => {
    const res = await api('POST', '/api/v2/planned-items', {
      date: '2026-09-01',
      title: 'X',
      amount_minor: -100,
      account_id: 999999,
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('a calendar date that does not exist (2026-02-30) → 400', async () => {
    const { account } = await createAccount();
    const res = await api('POST', '/api/v2/planned-items', {
      date: '2026-02-30',
      title: 'X',
      amount_minor: -100,
      account_id: account.id,
    });
    expect(res.status).toBe(400);
  });

  it('an archived account is allowed — archive is not a ban on operations', async () => {
    const { account } = await createAccount();
    await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true });
    const res = await api('POST', '/api/v2/planned-items', {
      date: '2026-09-01',
      title: 'X',
      amount_minor: -100,
      account_id: account.id,
    });
    expect(res.status).toBe(201);
  });

  it('PATCH changes the subset of fields that was sent', async () => {
    const { account } = await createAccount();
    const created = await createPlannedItem(account.id, { title: 'До' });
    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, {
      title: 'После',
      done: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { planned_item: Record<string, unknown> };
    expect(body.planned_item).toMatchObject({ title: 'После', done: true, amount_minor: -1000 });
  });

  it('PATCH with no known fields → 400', async () => {
    const { account } = await createAccount();
    const created = await createPlannedItem(account.id);
    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { unknown: 1 });
    expect(res.status).toBe(400);
  });

  it('PATCH of a missing record → 404', async () => {
    const res = await api('PATCH', '/api/v2/planned-items/999999', { title: 'X' });
    expect(res.status).toBe(404);
  });

  it('PATCH that changes currency without amount_minor → 400, with amount_minor → 200', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    const created = await createPlannedItem(account.id, { currency: 'USD', amount_minor: -1500 });

    const rejected = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { currency: 'JPY' });
    expect(rejected.status).toBe(400);
    expect((await errorBody(rejected)).code).toBe('CURRENCY_CHANGE_REQUIRES_AMOUNT');

    const accepted = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, {
      currency: 'JPY',
      amount_minor: -1500,
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { planned_item: Record<string, unknown> };
    expect(body.planned_item).toMatchObject({ currency: 'JPY', amount_minor: -1500 });
  });

  it('PATCH that changes account_id does not override the currency', async () => {
    const first = await createAccount({ currency: 'USD', name: 'Первый' });
    const second = await createAccount({ currency: 'RSD', name: 'Второй' });
    const created = await createPlannedItem(first.account.id, { currency: 'USD' });

    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, {
      account_id: second.account.id,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { planned_item: Record<string, unknown> };
    expect(body.planned_item).toMatchObject({ account_id: second.account.id, currency: 'USD' });
  });

  it('PATCH with a missing account_id → 400', async () => {
    const { account } = await createAccount();
    const created = await createPlannedItem(account.id);
    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { account_id: 999999 });
    expect(res.status).toBe(400);
  });

  it('DELETE removes it: 204 and it disappears from the list, 404 on a second delete', async () => {
    const { account } = await createAccount();
    const created = await createPlannedItem(account.id);

    const res = await api('DELETE', `/api/v2/planned-items/${created.planned_item.id}`);
    expect(res.status).toBe(204);

    const listRes = await api('GET', '/api/v2/planned-items');
    const list = (await listRes.json()) as { planned_items: unknown[] };
    expect(list.planned_items).toHaveLength(0);

    const again = await api('DELETE', `/api/v2/planned-items/${created.planned_item.id}`);
    expect(again.status).toBe(404);
  });

  it('GET sorts by done ASC, date ASC, id ASC', async () => {
    const { account } = await createAccount();
    const c = await createPlannedItem(account.id, { title: 'C', date: '2026-09-01', done: true });
    const a = await createPlannedItem(account.id, { title: 'A', date: '2026-09-05' });
    const b = await createPlannedItem(account.id, { title: 'B', date: '2026-09-01' });

    const listRes = await api('GET', '/api/v2/planned-items');
    const list = (await listRes.json()) as { planned_items: Array<Record<string, unknown>> };
    expect(list.planned_items.map((p) => p.id)).toEqual([b.planned_item.id, a.planned_item.id, c.planned_item.id]);
  });

  // A planned item created THROUGH CRUD closes the account dimension lock
  // (issue #232) the same way a direct insert does — and blocks deleting the account.
  it('a planned item created through the API closes the account dimension lock and blocks deleting the account', async () => {
    const { account } = await createAccount();
    await createPlannedItem(account.id);

    const patchRes = await api('PATCH', `/api/v2/accounts/${account.id}`, { owner: 'Другой' });
    expect(patchRes.status).toBe(409);

    const delRes = await api('DELETE', `/api/v2/accounts/${account.id}`);
    expect(delRes.status).toBe(409);
  });
});

describe('recurring_items (issue #197)', () => {
  it('create and read: the default currency comes from the account', async () => {
    const { account } = await createAccount({ currency: 'RSD' });
    const created = await createRecurringItem(account.id);
    expect(created.recurring_item).toMatchObject({
      title: 'Подписка',
      amount_minor: -1000,
      currency: 'RSD',
      account_id: account.id,
      category: null,
      frequency: 'daily',
      interval_count: 1,
      day_of_month: null,
      month_of_year: null,
      next_due_date: '2026-09-01',
      end_date: null,
      active: true,
    });

    const listRes = await api('GET', '/api/v2/recurring-items');
    const list = (await listRes.json()) as { recurring_items: Array<Record<string, unknown>> };
    expect(list.recurring_items).toHaveLength(1);
    expect(list.recurring_items[0]!.id).toBe(created.recurring_item.id);
    const stored = await env.DB.prepare('SELECT revision FROM recurring_items WHERE id = ?')
      .bind(created.recurring_item.id).first<{ revision: string }>();
    expect(stored?.revision).toMatch(/^[0-9a-f]{32}$/);
  });

  it('an explicit currency is accepted as given', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    const created = await createRecurringItem(account.id, { currency: 'eur' });
    expect(created.recurring_item.currency).toBe('EUR');
  });

  it.each([
    ['without title', { amount_minor: -100, frequency: 'daily', next_due_date: '2026-09-01' }],
    ['without amount_minor', { title: 'X', frequency: 'daily', next_due_date: '2026-09-01' }],
    ['without account_id — the validator inserts it', { title: 'X', amount_minor: -100, frequency: 'daily', next_due_date: '2026-09-01' }],
    ['without frequency', { title: 'X', amount_minor: -100, next_due_date: '2026-09-01' }],
    ['without next_due_date', { title: 'X', amount_minor: -100, frequency: 'daily' }],
  ])('POST %s → 400', async (_label, body) => {
    const res = await api('POST', '/api/v2/recurring-items', body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('amount_minor = 0 → 400', async () => {
    const { account } = await createAccount();
    const res = await api('POST', '/api/v2/recurring-items', {
      title: 'X',
      amount_minor: 0,
      account_id: account.id,
      frequency: 'daily',
      next_due_date: '2026-09-01',
    });
    expect(res.status).toBe(400);
  });

  it('a missing account_id → 400', async () => {
    const res = await api('POST', '/api/v2/recurring-items', {
      title: 'X',
      amount_minor: -100,
      account_id: 999999,
      frequency: 'daily',
      next_due_date: '2026-09-01',
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('a calendar date that does not exist (2026-02-30) → 400', async () => {
    const { account } = await createAccount();
    const res = await api('POST', '/api/v2/recurring-items', {
      title: 'X',
      amount_minor: -100,
      account_id: account.id,
      frequency: 'daily',
      next_due_date: '2026-02-30',
    });
    expect(res.status).toBe(400);
  });

  it.each([
    ['0', 0],
    ['366', 366],
  ])('interval_count = %s outside the bounds 1..365 → 400', async (_label, interval_count) => {
    const { account } = await createAccount();
    const res = await api('POST', '/api/v2/recurring-items', {
      title: 'X',
      amount_minor: -100,
      account_id: account.id,
      frequency: 'daily',
      next_due_date: '2026-09-01',
      interval_count,
    });
    expect(res.status).toBe(400);
  });

  it.each([[1], [365]])('interval_count = %s on the boundary is accepted', async (interval_count) => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id, { interval_count });
    expect(created.recurring_item.interval_count).toBe(interval_count);
  });

  describe('rule anchors', () => {
    it('daily/weekly: day_of_month and month_of_year must be NULL', async () => {
      const { account } = await createAccount();
      for (const frequency of ['daily', 'weekly']) {
        const created = await createRecurringItem(account.id, { frequency });
        expect(created.recurring_item).toMatchObject({ day_of_month: null, month_of_year: null });
      }
    });

    it.each(['daily', 'weekly'])('%s: a non-empty day_of_month → 400', async (frequency) => {
      const { account } = await createAccount();
      const res = await api('POST', '/api/v2/recurring-items', {
        title: 'X',
        amount_minor: -100,
        account_id: account.id,
        frequency,
        next_due_date: '2026-09-01',
        day_of_month: 5,
      });
      expect(res.status).toBe(400);
    });

    it.each(['daily', 'weekly'])('%s: a non-empty month_of_year → 400', async (frequency) => {
      const { account } = await createAccount();
      const res = await api('POST', '/api/v2/recurring-items', {
        title: 'X',
        amount_minor: -100,
        account_id: account.id,
        frequency,
        next_due_date: '2026-09-01',
        month_of_year: 3,
      });
      expect(res.status).toBe(400);
    });

    it('monthly: day_of_month was not sent — it is derived from the day of next_due_date', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'monthly', next_due_date: '2026-09-15' });
      expect(created.recurring_item).toMatchObject({ day_of_month: 15, month_of_year: null });
    });

    it('monthly: an explicit day_of_month is used as given', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-09-15',
        day_of_month: 28,
      });
      expect(created.recurring_item.day_of_month).toBe(28);
    });

    it('monthly: a non-empty month_of_year → 400', async () => {
      const { account } = await createAccount();
      const res = await api('POST', '/api/v2/recurring-items', {
        title: 'X',
        amount_minor: -100,
        account_id: account.id,
        frequency: 'monthly',
        next_due_date: '2026-09-15',
        month_of_year: 9,
      });
      expect(res.status).toBe(400);
    });

    it('yearly: day_of_month is explicit or taken from the day of next_due_date, and month_of_year is derived', async () => {
      const { account } = await createAccount();
      const withoutDay = await createRecurringItem(account.id, { frequency: 'yearly', next_due_date: '2026-08-10' });
      expect(withoutDay.recurring_item).toMatchObject({ day_of_month: 10, month_of_year: 8 });

      const withDay = await createRecurringItem(account.id, {
        frequency: 'yearly',
        next_due_date: '2026-08-10',
        day_of_month: 29,
      });
      expect(withDay.recurring_item).toMatchObject({ day_of_month: 29, month_of_year: 8 });
    });

    it('yearly: an explicit month_of_year that matches the date is accepted', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'yearly',
        next_due_date: '2026-08-10',
        month_of_year: 8,
      });
      expect(created.recurring_item.month_of_year).toBe(8);
    });

    it('yearly: an explicit month_of_year that does not match the month of next_due_date → 400', async () => {
      const { account } = await createAccount();
      const res = await api('POST', '/api/v2/recurring-items', {
        title: 'X',
        amount_minor: -100,
        account_id: account.id,
        frequency: 'yearly',
        next_due_date: '2026-08-10',
        month_of_year: 2,
      });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/8/);
    });
  });

  describe('end_date', () => {
    it('an end_date equal to next_due_date is valid (exactly one payment)', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        next_due_date: '2026-09-01',
        end_date: '2026-09-01',
      });
      expect(created.recurring_item.end_date).toBe('2026-09-01');
    });

    it('end_date earlier than next_due_date → 400', async () => {
      const { account } = await createAccount();
      const res = await api('POST', '/api/v2/recurring-items', {
        title: 'X',
        amount_minor: -100,
        account_id: account.id,
        frequency: 'daily',
        next_due_date: '2026-09-01',
        end_date: '2026-08-01',
      });
      expect(res.status).toBe(400);
    });

    it('end_date omitted or null → null', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { end_date: null });
      expect(created.recurring_item.end_date).toBeNull();
    });
  });

  it('active defaults to true, and an explicit false is accepted', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id, { active: false });
    expect(created.recurring_item.active).toBe(false);
  });

  it('PATCH with no known fields → 400, and PATCH of a missing record → 404', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id);
    expect((await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { unknown: 1 })).status).toBe(400);
    expect((await api('PATCH', '/api/v2/recurring-items/999999', { title: 'X' })).status).toBe(404);
  });

  it('PATCH changes the sent subset of independent fields', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id, { title: 'До' });
    const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { title: 'После', category: 'Связь' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recurring_item: Record<string, unknown> };
    expect(body.recurring_item).toMatchObject({ title: 'После', category: 'Связь', frequency: 'daily' });
  });

  it('PATCH that changes currency without amount_minor → 400, with amount_minor → 200', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    const created = await createRecurringItem(account.id, { currency: 'USD', amount_minor: -1500 });

    const rejected = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { currency: 'JPY' });
    expect(rejected.status).toBe(400);
    expect((await errorBody(rejected)).code).toBe('CURRENCY_CHANGE_REQUIRES_AMOUNT');

    const accepted = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
      currency: 'JPY',
      amount_minor: -1500,
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { recurring_item: Record<string, unknown> };
    expect(body.recurring_item).toMatchObject({ currency: 'JPY', amount_minor: -1500 });
  });

  it('PATCH that changes account_id does not override the currency', async () => {
    const first = await createAccount({ currency: 'USD', name: 'Первый' });
    const second = await createAccount({ currency: 'RSD', name: 'Второй' });
    const created = await createRecurringItem(first.account.id, { currency: 'USD' });

    const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
      account_id: second.account.id,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recurring_item: Record<string, unknown> };
    expect(body.recurring_item).toMatchObject({ account_id: second.account.id, currency: 'USD' });
  });

  it('PATCH with a missing account_id → 400', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id);
    const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { account_id: 999999 });
    expect(res.status).toBe(400);
  });

  describe('PATCH evaluates the rule as a whole', () => {
    it('changing frequency from monthly to daily clears the anchors by itself', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-09-15',
        day_of_month: 15,
      });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { frequency: 'daily' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ frequency: 'daily', day_of_month: null, month_of_year: null });
    });

    it('changing frequency from yearly to weekly clears the anchors by itself', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'yearly', next_due_date: '2026-08-10' });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { frequency: 'weekly' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ frequency: 'weekly', day_of_month: null, month_of_year: null });
    });

    it('changing frequency to monthly when the row has no anchors derives day_of_month from next_due_date', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'daily', next_due_date: '2026-09-20' });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { frequency: 'monthly' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ frequency: 'monthly', day_of_month: 20, month_of_year: null });
    });

    it('moving next_due_date of a yearly rule into another month carries month_of_year along', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'yearly', next_due_date: '2026-08-10' });
      expect(created.recurring_item).toMatchObject({ day_of_month: 10, month_of_year: 8 });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
        next_due_date: '2027-11-10',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ next_due_date: '2027-11-10', day_of_month: 10, month_of_year: 11 });
    });

    it('moving next_due_date of a monthly rule does NOT touch day_of_month', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-01-10',
        day_of_month: 5,
      });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
        next_due_date: '2026-02-20',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ next_due_date: '2026-02-20', day_of_month: 5 });
    });

    it('PATCH of day_of_month on daily/weekly as its own request → 400', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'daily' });
      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { day_of_month: 10 });
      expect(res.status).toBe(400);
    });

    it('PATCH of month_of_year on monthly as its own request → 400', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-09-15',
      });
      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { month_of_year: 5 });
      expect(res.status).toBe(400);
    });

    it('PATCH month_of_year of a yearly rule that does not match the new next_due_date → 400; a matching one → 200', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'yearly', next_due_date: '2026-08-10' });

      const rejected = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
        next_due_date: '2027-11-10',
        month_of_year: 8,
      });
      expect(rejected.status).toBe(400);

      const accepted = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
        next_due_date: '2027-11-10',
        month_of_year: 11,
      });
      expect(accepted.status).toBe(200);
    });

    // Exactly what the "Recurring" screen form sends: it submits the rule
    // as a whole, including day_of_month, on every save. Two cases, and both
    // must work — otherwise there is no way to change the day of the rule through the UI
    // (moving next_due_date deliberately does not move it; see the test above).
    it('an explicit day_of_month in PATCH changes the rule itself, and a pinned day survives edits of neighboring fields', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-02-28',
        day_of_month: 31,
      });
      const id = created.recurring_item.id;

      // The form saves the title, sending the whole rule with the previous day.
      const untouched = await api('PATCH', `/api/v2/recurring-items/${id}`, {
        title: 'Кредит',
        frequency: 'monthly',
        interval_count: 1,
        next_due_date: '2026-02-28',
        day_of_month: 31,
      });
      expect(untouched.status).toBe(200);
      expect(((await untouched.json()) as { recurring_item: Record<string, unknown> }).recurring_item)
        .toMatchObject({ title: 'Кредит', day_of_month: 31, next_due_date: '2026-02-28' });

      // And now the owner really does move the rule to the 20th.
      const moved = await api('PATCH', `/api/v2/recurring-items/${id}`, { day_of_month: 20 });
      expect(moved.status).toBe(200);
      expect(((await moved.json()) as { recurring_item: Record<string, unknown> }).recurring_item)
        .toMatchObject({ day_of_month: 20, next_due_date: '2026-02-28' });
    });

    it('an explicit day_of_month: null on monthly/yearly → 400 (the anchor is required)', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-09-15',
      });
      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { day_of_month: null });
      expect(res.status).toBe(400);
    });
  });

  describe('end_date and next_due_date move in a single request', () => {
    it('next_due_date later than the current end_date, sent as its own PATCH → 400', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        next_due_date: '2026-01-01',
        end_date: '2026-06-01',
      });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
        next_due_date: '2026-07-01',
      });
      expect(res.status).toBe(400);
    });

    it('next_due_date and end_date in one PATCH — succeeds', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        next_due_date: '2026-01-01',
        end_date: '2026-06-01',
      });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, {
        next_due_date: '2026-07-01',
        end_date: '2026-09-01',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ next_due_date: '2026-07-01', end_date: '2026-09-01' });
    });

    it('PATCH end_date: null clears the end date', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { end_date: '2026-12-01' });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { end_date: null });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item.end_date).toBeNull();
    });
  });

  it('DELETE removes it: 204 and it disappears from the list, 404 on a second delete', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id);

    const res = await api('DELETE', `/api/v2/recurring-items/${created.recurring_item.id}`);
    expect(res.status).toBe(204);

    const listRes = await api('GET', '/api/v2/recurring-items');
    const list = (await listRes.json()) as { recurring_items: unknown[] };
    expect(list.recurring_items).toHaveLength(0);

    const again = await api('DELETE', `/api/v2/recurring-items/${created.recurring_item.id}`);
    expect(again.status).toBe(404);
  });

  it('GET sorts by active DESC, next_due_date ASC, id ASC', async () => {
    const { account } = await createAccount();
    const inactive = await createRecurringItem(account.id, { title: 'Неактивная', next_due_date: '2026-01-01', active: false });
    const late = await createRecurringItem(account.id, { title: 'Поздняя', next_due_date: '2026-09-05' });
    const early = await createRecurringItem(account.id, { title: 'Ранняя', next_due_date: '2026-09-01' });

    const listRes = await api('GET', '/api/v2/recurring-items');
    const list = (await listRes.json()) as { recurring_items: Array<Record<string, unknown>> };
    expect(list.recurring_items.map((r) => r.id)).toEqual([
      early.recurring_item.id,
      late.recurring_item.id,
      inactive.recurring_item.id,
    ]);
  });

  // A recurring item created THROUGH CRUD closes the account dimension lock
  // (issue #232) the same way a direct insert does — and blocks deleting the account.
  it('a recurring item created through the API closes the account dimension lock and blocks deleting the account', async () => {
    const { account } = await createAccount();
    await createRecurringItem(account.id);

    const patchRes = await api('PATCH', `/api/v2/accounts/${account.id}`, { owner: 'Другой' });
    expect(patchRes.status).toBe(409);

    const delRes = await api('DELETE', `/api/v2/accounts/${account.id}`);
    expect(delRes.status).toBe(409);
  });

  describe('close-period and skip-period (issue #280)', () => {
    it('close-period with default parameters: creates an operation with source=recurring, moves the balance, and shifts next_due_date', async () => {
      const { account } = await createAccount({ balance_minor: 100000, currency: 'RSD' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Аренда',
        amount_minor: -40000,
        currency: 'RSD',
        frequency: 'monthly',
        day_of_month: 15,
        next_due_date: '2026-08-15',
        category: 'Жильё',
      });

      const res = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {});
      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        recurring_item: Record<string, unknown>;
        operation: Record<string, unknown>;
      };

      // 1. The operation was created
      expect(data.operation).toMatchObject({
        date: '2026-08-15',
        account_id: account.id,
        kind: 'expense',
        item: 'Аренда',
        category: 'Жильё',
        subcategory: null,
        amount_minor: -40000,
        currency: 'RSD',
        source: 'recurring',
        planned_item_id: null,
        recurring_item_id: item.id,
      });

      // 2. The account balance went down
      const accRes = await api('GET', '/api/v2/accounts');
      const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
      expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(60000);

      // 3. The anchor moved to 15 September
      expect(data.recurring_item.next_due_date).toBe('2026-09-15');
      expect(data.recurring_item.active).toBe(true);

      // 4. The operation shows up in the general operations list
      const opListRes = await api('GET', '/api/v2/operations');
      const opList = (await opListRes.json()) as { operations: Array<{ id: number; source: string; recurring_item_id: number }> };
      expect(opList.operations).toHaveLength(1);
      expect(opList.operations[0].source).toBe('recurring');
      expect(opList.operations[0].recurring_item_id).toBe(item.id);
    });

    it('close-period overriding the amount (utilities), date, category, and subcategory', async () => {
      const { account } = await createAccount({ balance_minor: 50000, currency: 'RSD' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Коммуналка',
        amount_minor: -8000,
        currency: 'RSD',
        frequency: 'monthly',
        day_of_month: 20,
        next_due_date: '2026-08-20',
        category: 'Жильё',
      });

      // In August the utilities bill came in at 9 450 RSD
      const res = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        date: '2026-08-19',
        amount_minor: -9450,
        item: 'Коммуналка за июль',
        category: 'Жильё',
        subcategory: 'Электричество',
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        recurring_item: Record<string, unknown>;
        operation: Record<string, unknown>;
      };

      expect(data.operation).toMatchObject({
        date: '2026-08-19',
        amount_minor: -9450,
        item: 'Коммуналка за июль',
        category: 'Жильё',
        subcategory: 'Электричество',
        recurring_item_id: item.id,
      });

      // The account balance changed by exactly the actual amount
      const accRes = await api('GET', '/api/v2/accounts');
      const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
      expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(40550);

      // The rule anchor moved to 20 September, and the rule amount stayed -8000
      expect(data.recurring_item.next_due_date).toBe('2026-09-20');
      expect(data.recurring_item.amount_minor).toBe(-8000);
    });

    it('close-period on a rule with end_date: closing the last period deactivates the rule (active = false)', async () => {
      const { account } = await createAccount({ balance_minor: 100000, currency: 'RSD' });
      // A loan/installment plan of 2 payments: 2026-08-15 and 2026-09-15 (end_date: 2026-09-15)
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Рассрочка',
        amount_minor: -15000,
        currency: 'RSD',
        frequency: 'monthly',
        day_of_month: 15,
        next_due_date: '2026-08-15',
        end_date: '2026-09-15',
      });

      // 1st payment
      const res1 = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {});
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()) as { recurring_item: Record<string, unknown> };
      expect(data1.recurring_item.next_due_date).toBe('2026-09-15');
      expect(data1.recurring_item.active).toBe(true);

      // 2nd (last) payment
      const res2 = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {});
      expect(res2.status).toBe(201);
      const data2 = (await res2.json()) as { recurring_item: Record<string, unknown> };
      expect(data2.recurring_item.active).toBe(false);
    });

    it('skip-period shifts the anchor without creating an operation and without changing the balance', async () => {
      const { account } = await createAccount({ balance_minor: 50000, currency: 'RSD' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Фитнес',
        amount_minor: -5000,
        currency: 'RSD',
        frequency: 'monthly',
        day_of_month: 1,
        next_due_date: '2026-08-01',
      });

      const res = await api('POST', `/api/v2/recurring-items/${item.id}/skip-period`, {});
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        recurring_item: Record<string, unknown>;
        fulfillment: Record<string, unknown>;
      };
      expect(data.recurring_item.next_due_date).toBe('2026-09-01');
      expect(data.fulfillment).toMatchObject({
        recurring_item_id: item.id,
        period_due_date: '2026-08-01',
        outcome: 'skipped',
        operation_ids: [],
      });

      const historyRes = await api('GET', `/api/v2/recurring-fulfillments?recurring_item_id=${item.id}`);
      expect(historyRes.status).toBe(200);
      expect((await historyRes.json()) as Record<string, unknown>).toMatchObject({
        recurring_fulfillments: [{
          recurring_item_id: item.id,
          period_due_date: '2026-08-01',
          outcome: 'skipped',
          operation_ids: [],
        }],
      });

      // No operations
      const opListRes = await api('GET', '/api/v2/operations');
      const opList = (await opListRes.json()) as { operations: unknown[] };
      expect(opList.operations).toHaveLength(0);

      // The balance did not change
      const accRes = await api('GET', '/api/v2/accounts');
      const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
      expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(50000);
    });

    it('close-period and skip-period do not change an inactive rule', async () => {
      const { account } = await createAccount({ balance_minor: 50000, currency: 'RSD' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Архивная подписка',
        amount_minor: -1000,
        currency: 'RSD',
        next_due_date: '2026-08-01',
        active: false,
      });

      expect((await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {})).status).toBe(409);
      expect((await api('POST', `/api/v2/recurring-items/${item.id}/skip-period`, {})).status).toBe(409);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(50000);
    });

    it('skip-period on the last period that has an end_date deactivates the rule', async () => {
      const { account } = await createAccount({ balance_minor: 50000, currency: 'RSD' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Подписка',
        amount_minor: -1000,
        currency: 'RSD',
        frequency: 'monthly',
        day_of_month: 1,
        next_due_date: '2026-08-01',
        end_date: '2026-08-01',
      });

      const res = await api('POST', `/api/v2/recurring-items/${item.id}/skip-period`, {});
      expect(res.status).toBe(200);
      const data = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(data.recurring_item.active).toBe(false);
    });

    it('provider CAS does not close the next period again from the previous period snapshot', async () => {
      const { account } = await createAccount({ balance_minor: 100000, currency: 'RSD' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Подписка', amount_minor: -4000, currency: 'RSD', frequency: 'monthly',
        day_of_month: 1, next_due_date: '2026-08-01', category: 'Software',
      });
      const snapshotRow = await env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
        .bind(item.id).first<Record<string, unknown>>();
      const snapshot = { type: 'recurring_close', ...snapshotRow };

      const first = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        __mcp_expected_snapshot: snapshot,
      });
      expect(first.status).toBe(201);
      const second = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        __mcp_expected_snapshot: snapshot,
      });
      expect(second.status).toBe(409);

      const current = await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?')
        .bind(item.id).first<{ next_due_date: string }>();
      expect(current?.next_due_date).toBe('2026-09-01');
      const operations = await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE recurring_item_id = ?')
        .bind(item.id).first<{ count: number }>();
      expect(operations?.count).toBe(1);
      const balance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
        .bind(account.id).first<{ balance_minor: number }>();
      expect(balance?.balance_minor).toBe(96000);
    });

    it('provider CAS does not skip a different recurring period from a stale snapshot', async () => {
      const { account } = await createAccount({ balance_minor: 50000, currency: 'RSD' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Фитнес', amount_minor: -5000, currency: 'RSD', frequency: 'monthly',
        day_of_month: 1, next_due_date: '2026-08-01',
      });
      const snapshotRow = await env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
        .bind(item.id).first<Record<string, unknown>>();
      const snapshot = { type: 'recurring_skip', ...snapshotRow };
      await env.DB.prepare("UPDATE recurring_items SET next_due_date = '2026-09-01' WHERE id = ?").bind(item.id).run();

      const stale = await api('POST', `/api/v2/recurring-items/${item.id}/skip-period`, {
        __mcp_expected_snapshot: snapshot,
      });
      expect(stale.status).toBe(409);
      const current = await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?')
        .bind(item.id).first<{ next_due_date: string }>();
      expect(current?.next_due_date).toBe('2026-09-01');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(50000);
    });

    it('close-period validation: 404 when the rule is missing, 400 on a currency mismatch or invalid data', async () => {
      expect((await api('POST', '/api/v2/recurring-items/999999/close-period', {})).status).toBe(404);
      expect((await api('POST', '/api/v2/recurring-items/abc/close-period', {})).status).toBe(404);

      const { account } = await createAccount({ balance_minor: 50000, currency: 'RSD' });
      const { account: accountEur } = await createAccount({ name: 'EUR счёт', balance_minor: 1000, currency: 'EUR' });
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Тест',
        amount_minor: -1000,
        currency: 'RSD',
        frequency: 'monthly',
        day_of_month: 1,
        next_due_date: '2026-08-01',
      });

      // Move onto an account in another currency without a matching currency
      const currencyMismatch = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        account_id: accountEur.id,
      });
      expect(currencyMismatch.status).toBe(400);

      // Invalid amount of 0
      const zeroAmount = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        amount_minor: 0,
      });
      expect(zeroAmount.status).toBe(400);

      // A subcategory without a category
      const subWithoutCat = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        category: null,
        subcategory: 'Тест',
      });
      expect(subWithoutCat.status).toBe(400);
    });
  });

  describe('integration of closing a recurring period with the forecast (issue #280 + #279)', () => {
    it('closing a period removes the overdue debt from the forecast, debits the balance, and leaves the future horizon complete', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
        const { account } = await createAccount({ balance_minor: 100000, currency: 'RSD' });
        await api('PUT', '/api/v2/fx-rates/RSD', { rate: 1 });
        await api('PUT', '/api/v2/settings/base_currency', { value: 'RSD' });

        // Create a rule whose next_due_date was yesterday (2026-08-08 when asOf is 2026-08-09)
        const { recurring_item: item } = await createRecurringItem(account.id, {
          title: 'Аренда',
          amount_minor: -40000,
          currency: 'RSD',
          frequency: 'monthly',
          day_of_month: 8,
          next_due_date: '2026-08-08',
        });

        // Before closing: the forecast sees a debt of -40 000 on the nearest day
        const f1 = await (await api('GET', '/api/v2/forecast')).json() as {
          series: Array<{ date: string; overall_minor: number }>;
        };
        // Starting balance 100 000, but on day 0 (2026-08-09) overdue rent brings the balance to 60 000
        expect(f1.series[0].overall_minor).toBe(60000);

        // Close the period (actual payment on 8 August for -40 000)
        const closeRes = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {});
        expect(closeRes.status).toBe(201);

        // After closing:
        // 1. The real account balance became 60 000
        const accRes = await api('GET', '/api/v2/accounts');
        const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
        expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(60000);

        // 2. The forecast starts from 60 000 and does NOT duplicate the 8 August debit (it is already in the balance)
        const f2 = await (await api('GET', '/api/v2/forecast')).json() as {
          series: Array<{ date: string; overall_minor: number }>;
        };
        // On day 0 (2026-08-09) the balance stays 60 000, not 20 000 (the debt is no longer outstanding)
        expect(f2.series[0].overall_minor).toBe(60000);

        // 3. The next payment on 8 September deducts another -40 000 (the balance becomes 20 000)
        const sep8Point = f2.series.find((p) => p.date === '2026-09-08');
        expect(sep8Point).toBeDefined();
        expect(sep8Point!.overall_minor).toBe(20000);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('operations (issue #200)', () => {
  async function listOperations() {
    const res = await api('GET', '/api/v2/operations');
    expect(res.status).toBe(200);
    return ((await res.json()) as { operations: Record<string, unknown>[] }).operations;
  }

  /** Read the account balance through the API, not from the DB: we check observable behavior. */
  async function balanceOf(accountId: unknown): Promise<number> {
    const res = await api('GET', '/api/v2/accounts');
    const { accounts } = (await res.json()) as { accounts: Record<string, unknown>[] };
    return accounts.find((a) => a.id === accountId)!.balance_minor as number;
  }

  async function accountWithBalance(balanceMinor: number, overrides: Record<string, unknown> = {}) {
    const { account } = await createAccount({ balance_minor: balanceMinor, ...overrides });
    return account;
  }

  it('create: account, kind, subcategory; currency comes from the account, and the origin is manual', async () => {
    const account = await accountWithBalance(100000, { currency: 'RSD' });
    const { operation } = await createOperation(account.id, {
      store: 'Maxi',
      category: 'Продукты',
      subcategory: 'Овощи и фрукты',
      item: 'Огурцы',
      amount_minor: -18990,
    });

    expect(operation).toMatchObject({
      date: '2026-08-10',
      account_id: account.id,
      kind: 'expense',
      store: 'Maxi',
      item: 'Огурцы',
      category: 'Продукты',
      subcategory: 'Овощи и фрукты',
      amount_minor: -18990,
      currency: 'RSD',
      receipt_id: null,
      source: 'manual',
    });
    expect(await listOperations()).toEqual([operation]);
  });

  // The main new behavior of this task: the operation amount adjusts the account balance when
  // it is saved (owner's decision 2026-08-12).
  it('an expense decreases the account balance, income increases it, and a refund puts it back', async () => {
    const account = await accountWithBalance(100000);

    await createOperation(account.id, { amount_minor: -25000 });
    expect(await balanceOf(account.id)).toBe(75000);

    await createOperation(account.id, { kind: 'income', item: 'Зарплата', amount_minor: 500000 });
    expect(await balanceOf(account.id)).toBe(575000);

    await createOperation(account.id, { kind: 'refund', item: 'Возврат наушников', amount_minor: 4999 });
    expect(await balanceOf(account.id)).toBe(579999);
  });

  // The "checked with the bank" mark (issue #223) does not move because of our adjustment:
  // an amount we computed is not a reconciliation, and using it to clear the
  // "time to reconcile" reminder would lie exactly where the discrepancy accumulates.
  it('a balance adjustment does not move balance_updated_at', async () => {
    const account = await accountWithBalance(100000);
    const before = (await (await api('GET', '/api/v2/accounts')).json()) as { accounts: Record<string, unknown>[] };
    const stampBefore = before.accounts[0]!.balance_updated_at;

    await createOperation(account.id, { amount_minor: -25000 });

    const after = (await (await api('GET', '/api/v2/accounts')).json()) as { accounts: Record<string, unknown>[] };
    expect(after.accounts[0]!.balance_updated_at).toBe(stampBefore);
    expect(after.accounts[0]!.balance_minor).toBe(75000);
  });

  it('the list is newest first, and same-day rows put the later entry above', async () => {
    const account = await accountWithBalance(1000000);
    await createOperation(account.id, { date: '2026-08-01', item: 'Старая' });
    await createOperation(account.id, { date: '2026-08-10', item: 'Первая того дня' });
    await createOperation(account.id, { date: '2026-08-10', item: 'Вторая того дня' });

    expect((await listOperations()).map((o) => o.item)).toEqual(['Вторая того дня', 'Первая того дня', 'Старая']);
  });

  it('the currency in the response is the account currency, and each operation takes its own from its account', async () => {
    const rsd = await accountWithBalance(0, { currency: 'RSD' });
    const eur = await accountWithBalance(0, { name: 'Евровый', currency: 'EUR' });
    await createOperation(rsd.id, { item: 'Кофе' });
    await createOperation(eur.id, { item: 'Подписка' });

    const byItem = Object.fromEntries((await listOperations()).map((o) => [o.item, o.currency]));
    expect(byItem).toEqual({ Кофе: 'RSD', Подписка: 'EUR' });
  });

  it('a currency from the client is not accepted at all — the field is unknown', async () => {
    const account = await accountWithBalance(0, { currency: 'RSD' });
    const { operation } = await createOperation(account.id, { currency: 'JPY' });
    expect(operation.currency).toBe('RSD');
  });

  // The sign is the balance delta, and the kind must agree with it. Silently fixing the sign
  // is not allowed: the client got one of the two fields wrong, and it is not known which.
  it('rejects an expense with a plus and income with a minus', async () => {
    const account = await accountWithBalance(100000);

    const plus = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: account.id, kind: 'expense', item: 'Кофе', amount_minor: 350,
    });
    expect(plus.status).toBe(400);
    expect((await errorBody(plus)).code).toBe('AMOUNT_MUST_BE_NEGATIVE');

    const minus = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: account.id, kind: 'income', item: 'Зарплата', amount_minor: -350,
    });
    expect(minus.status).toBe(400);
    expect((await errorBody(minus)).code).toBe('AMOUNT_MUST_BE_POSITIVE');

    expect(await listOperations()).toEqual([]);
    expect(await balanceOf(account.id)).toBe(100000);
  });

  it('rejects an unknown operation kind', async () => {
    const account = await accountWithBalance(0);
    const res = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: account.id, kind: 'transfer', item: 'Перевод', amount_minor: -350,
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('kind');
  });

  it('rejects a subcategory without a category — both on create and on edit', async () => {
    const account = await accountWithBalance(0);
    const res = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: account.id, kind: 'expense', item: 'Огурцы',
      amount_minor: -350, subcategory: 'Овощи и фрукты',
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('subcategory');

    const { operation } = await createOperation(account.id, { category: 'Продукты', subcategory: 'Овощи и фрукты' });
    const cleared = await api('PATCH', `/api/v2/operations/${operation.id}`, { category: '' });
    expect(cleared.status).toBe(400);
  });

  it('rejects an operation with no account and with a missing account', async () => {
    const noAccount = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', kind: 'expense', item: 'Кофе', amount_minor: -350,
    });
    expect(noAccount.status).toBe(400);
    expect(await errorOf(noAccount)).toContain('account_id');

    const missing = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: 999, kind: 'expense', item: 'Кофе', amount_minor: -350,
    });
    expect(missing.status).toBe(400);
    expect((await errorBody(missing)).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('rejects a zero amount, a fractional amount, a date that does not exist, and an empty name', async () => {
    const account = await accountWithBalance(100000);
    const bad = async (body: Record<string, unknown>) =>
      (await api('POST', '/api/v2/operations', {
        date: '2026-08-10', account_id: account.id, kind: 'expense', item: 'Кофе', amount_minor: -350, ...body,
      })).status;

    expect(await bad({ amount_minor: 0 })).toBe(400);
    expect(await bad({ amount_minor: -3.5 })).toBe(400);
    expect(await bad({ date: '2026-02-30' })).toBe(400);
    expect(await bad({ item: '   ' })).toBe(400);
    expect(await listOperations()).toEqual([]);
    expect(await balanceOf(account.id)).toBe(100000);
  });

  // Requirement of issue #200 — reject before the operations_source_matches_receipt CHECK.
  // The schema safety net is illusory here: the INSERT writes NULL and 'manual'
  // as literals, so the submitted value never reaches the CHECK. Drop the check —
  // and the result is not a 500 but a quiet 201 with an empty receipt link, and `toEqual([])` catches that.
  it('receipt_id and source are not accepted through manual entry', async () => {
    const account = await accountWithBalance(0);
    const withReceipt = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: account.id, kind: 'expense', item: 'Кофе', amount_minor: -350, receipt_id: 1,
    });
    expect(withReceipt.status).toBe(400);
    expect(await errorOf(withReceipt)).toContain('receipt_id');

    const withSource = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: account.id, kind: 'expense', item: 'Кофе', amount_minor: -350, source: 'receipt',
    });
    expect(withSource.status).toBe(400);
    expect(await errorOf(withSource)).toContain('source');
    expect(await listOperations()).toEqual([]);
  });

  it('PATCH changes the fields that were sent and does not touch the origin', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { store: 'Maxi' });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, {
      item: 'Чай', category: 'Продукты', subcategory: 'Напитки',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { operation: Record<string, unknown> }).operation).toMatchObject({
      item: 'Чай', category: 'Продукты', subcategory: 'Напитки', store: 'Maxi',
      amount_minor: -350, source: 'manual', receipt_id: null,
    });
  });

  it('accepts comment, receipt_url, and fiscal_receipt_id on create and on edit; rejects javascript:', async () => {
    const account = await accountWithBalance(100000);
    const purs = 'https://suf.purs.gov.rs/v/?vl=' + 'A'.repeat(200);
    const { operation } = await createOperation(account.id, {
      comment: '  акция  ',
      receipt_url: `  ${purs}  `,
      fiscal_receipt_id: '  PFR-MAXI-GROCERY  ',
    });
    expect(operation).toMatchObject({
      comment: 'акция',
      receipt_url: purs,
      fiscal_receipt_id: 'PFR-MAXI-GROCERY',
    });

    const listed = await listOperations();
    expect(listed[0]).toMatchObject({
      id: operation.id,
      comment: 'акция',
      receipt_url: purs,
      fiscal_receipt_id: 'PFR-MAXI-GROCERY',
    });

    const cleared = await api('PATCH', `/api/v2/operations/${operation.id}`, {
      comment: null,
      receipt_url: '',
      fiscal_receipt_id: '',
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { operation: Record<string, unknown> }).operation).toMatchObject({
      comment: null,
      receipt_url: null,
      fiscal_receipt_id: null,
    });

    const bad = await api('PATCH', `/api/v2/operations/${operation.id}`, {
      receipt_url: 'javascript:alert(1)',
    });
    expect(bad.status).toBe(400);
    expect((await errorBody(bad)).code).toBe('INVALID_RECEIPT_URL');

    const tooLong = await api('PATCH', `/api/v2/operations/${operation.id}`, {
      fiscal_receipt_id: 'X'.repeat(129),
    });
    expect(tooLong.status).toBe(400);
    expect((await errorBody(tooLong)).code).toBe('INVALID_FISCAL_RECEIPT_ID');
  });

  // Without this, a corrected typo (350 instead of 3500) would leave the account wrong
  // forever: one operation is already applied, and editing it would have skipped the balance.
  it('PATCH of the amount adjusts the balance by exactly the difference', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -35000 });
    expect(await balanceOf(account.id)).toBe(65000);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { amount_minor: -3500 });
    expect(res.status).toBe(200);
    expect(await balanceOf(account.id)).toBe(96500);
  });

  it('PATCH that changes the account takes the amount off the old one and puts it on the new one', async () => {
    const from = await accountWithBalance(100000);
    const to = await accountWithBalance(50000, { name: 'Второй' });
    const { operation } = await createOperation(from.id, { amount_minor: -25000 });
    expect(await balanceOf(from.id)).toBe(75000);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: to.id });
    expect(res.status).toBe(200);
    expect(await balanceOf(from.id)).toBe(100000);
    expect(await balanceOf(to.id)).toBe(25000);
  });

  // An operation has no currency of its own, so changing the account changes the currency, and
  // the amount has to be named again. Without this check, moving "1 500,00 RSD" onto
  // a dollar account returned 200 and left amount_minor as-is: dinars silently
  // became dollars without a single column changing. The dimension lock
  // (#232) does not close this path — it forbids changing the currency OF THE ACCOUNT.
  it('PATCH that moves to an account in another currency without an amount → 400, and nothing is touched', async () => {
    const rsd = await accountWithBalance(0, { currency: 'RSD' });
    const usd = await accountWithBalance(0, { name: 'Долларовый', currency: 'USD' });
    const { operation } = await createOperation(rsd.id, { amount_minor: -150000 });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: usd.id });
    expect(res.status).toBe(400);
    const error = await errorBody(res);
    expect(error.code).toBe('CURRENCY_CHANGE_REQUIRES_AMOUNT');
    expect(error.params).toMatchObject({ fromCurrency: 'RSD', toCurrency: 'USD' });

    expect((await listOperations())[0]).toMatchObject({ account_id: rsd.id, currency: 'RSD', amount_minor: -150000 });
    expect(await balanceOf(rsd.id)).toBe(-150000);
    expect(await balanceOf(usd.id)).toBe(0);
  });

  it('PATCH that moves to an account in another currency and includes an amount succeeds', async () => {
    const rsd = await accountWithBalance(0, { currency: 'RSD' });
    const usd = await accountWithBalance(0, { name: 'Долларовый', currency: 'USD' });
    const { operation } = await createOperation(rsd.id, { amount_minor: -150000 });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: usd.id, amount_minor: -1500 });
    expect(res.status).toBe(200);
    expect(await balanceOf(rsd.id)).toBe(0);
    expect(await balanceOf(usd.id)).toBe(-1500);
  });

  // Accounts in the same currency do not revalue anything when money is moved — requiring an amount there
  // would get in the way of an ordinary "charged the wrong card".
  it('PATCH that moves to an account of the same currency does not require an amount', async () => {
    const from = await accountWithBalance(0, { currency: 'RSD' });
    const to = await accountWithBalance(0, { name: 'Второй динаровый', currency: 'RSD' });
    const { operation } = await createOperation(from.id, { amount_minor: -150000 });

    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: to.id })).status).toBe(200);
    expect(await balanceOf(to.id)).toBe(-150000);
  });

  it('PATCH that changes the account returns the currency of the NEW account', async () => {
    const rsd = await accountWithBalance(0, { currency: 'RSD' });
    const eur = await accountWithBalance(0, { name: 'Евровый', currency: 'EUR' });
    const { operation } = await createOperation(rsd.id);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: eur.id, amount_minor: -3 });
    expect(((await res.json()) as { operation: Record<string, unknown> }).operation.currency).toBe('EUR');
  });

  // The rule is evaluated on the effective row: changing only the kind of an expense
  // with a negative amount must produce a clear 400, not run into the CHECK.
  it('PATCH of kind without an amount that breaks the sign → 400, and the balance is untouched', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -35000 });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { kind: 'income' });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('AMOUNT_MUST_BE_POSITIVE');
    expect(await balanceOf(account.id)).toBe(65000);
  });

  it('PATCH of kind together with an amount succeeds and adjusts the balance', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -35000 });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { kind: 'income', amount_minor: 35000 });
    expect(res.status).toBe(200);
    expect(await balanceOf(account.id)).toBe(135000);
  });

  it('PATCH with the previous values → 200, and the row and the balance are untouched', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { item: 'Кофе', amount_minor: -350 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { operation: Record<string, unknown> }).operation).toEqual(operation);
    expect(await balanceOf(account.id)).toBe(99650);
  });

  it('PATCH does not accept receipt_id or source, and an empty body → 400', async () => {
    const account = await accountWithBalance(0);
    const { operation } = await createOperation(account.id);

    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { receipt_id: 1 })).status).toBe(400);
    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { source: 'receipt' })).status).toBe(400);
    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { nonsense: 1 })).status).toBe(400);
  });

  it('DELETE returns the amount onto the balance', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -25000 });
    expect(await balanceOf(account.id)).toBe(75000);

    const res = await api('DELETE', `/api/v2/operations/${operation.id}`);
    expect(res.status).toBe(204);
    expect(await balanceOf(account.id)).toBe(100000);
    expect(await listOperations()).toEqual([]);
  });

  it('PATCH and DELETE of a missing operation → 404, and a non-numeric id does too', async () => {
    expect((await api('PATCH', '/api/v2/operations/999', { item: 'Чай' })).status).toBe(404);
    expect((await api('DELETE', '/api/v2/operations/999')).status).toBe(404);
    expect((await api('PATCH', '/api/v2/operations/abc', { item: 'Чай' })).status).toBe(404);
    expect((await api('DELETE', '/api/v2/operations/1.5')).status).toBe(404);
  });

  it('DELETE of a missing operation does not touch the balance', async () => {
    const account = await accountWithBalance(100000);
    await api('DELETE', '/api/v2/operations/999');
    expect(await balanceOf(account.id)).toBe(100000);
  });

  // The dimension lock (#232) is closed by operations the same way it is by planned items, and this
  // is not symmetry for its own sake: an operation currency is not stored, it is taken from the account
  // — changing the account currency would rewrite the meaning of every amount on it.
  it('an operation closes the account dimension lock and forbids deleting the account', async () => {
    const account = await accountWithBalance(100000, { currency: 'RSD' });
    await createOperation(account.id);

    const patched = await api('PATCH', `/api/v2/accounts/${account.id}`, { currency: 'EUR', balance_minor: 0 });
    expect(patched.status).toBe(409);

    const deleted = await api('DELETE', `/api/v2/accounts/${account.id}`);
    expect(deleted.status).toBe(409);
  });

  // An invariant that must hold through any race: the account balance equals
  // "starting balance + the sum of every operation on it". The previous version computed the delta
  // in JS from a snapshot it had read — and two parallel PATCHes produced a lost update:
  // both answered 200, and the balance was 55000 instead of 70000. Live subqueries in the batch
  // close this: whatever the neighbor managed to do, what gets removed and applied is
  // whatever actually sits in the row.
  it('two parallel PATCHes do not let the balance diverge from the history', async () => {
    const account = await accountWithBalance(100000);
    const id = (await createOperation(account.id, { amount_minor: -25000 })).operation.id as number;
    expect(await balanceOf(account.id)).toBe(75000);

    // A neighboring PATCH slips in exactly between our SELECT and our batch.
    const realBatch = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'batch').mockImplementation((async (statements: unknown) => {
      spy.mockRestore();
      const other = await api('PATCH', `/api/v2/operations/${id}`, { amount_minor: -40000 });
      expect(other.status).toBe(200);
      return realBatch(statements as never);
    }) as never);

    const res = await api('PATCH', `/api/v2/operations/${id}`, { amount_minor: -30000 });
    expect(res.status).toBe(200);

    const stored = (await listOperations())[0]!.amount_minor as number;
    expect(await balanceOf(account.id)).toBe(100000 + stored);
  });

  // The same invariant, but the race moves the operation to another account: the previous version
  // took the amount off the account from its own snapshot and left both accounts wrong.
  it('editing the amount against a parallel account move does not break the invariant', async () => {
    const a = await accountWithBalance(100000);
    const b = await accountWithBalance(100000, { name: 'Второй' });
    const id = (await createOperation(a.id, { amount_minor: -25000 })).operation.id as number;

    const realBatch = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'batch').mockImplementation((async (statements: unknown) => {
      spy.mockRestore();
      expect((await api('PATCH', `/api/v2/operations/${id}`, { account_id: b.id })).status).toBe(200);
      return realBatch(statements as never);
    }) as never);

    expect((await api('PATCH', `/api/v2/operations/${id}`, { amount_minor: -30000 })).status).toBe(200);

    const stored = (await listOperations())[0]!;
    const [balanceA, balanceB] = [await balanceOf(a.id), await balanceOf(b.id)];
    // There is exactly one operation — its contribution must sit on exactly one account.
    expect(stored.account_id === a.id ? [balanceA, balanceB] : [balanceB, balanceA]).toEqual([
      100000 + (stored.amount_minor as number),
      100000,
    ]);
  });

  // The whole balance correction rests on a D1 batch being a single transaction.
  // Check the claim directly: if the second statement fails, the first must not
  // remain applied.
  it('a D1 batch is atomic — the whole balance correction rests on that', async () => {
    const account = await accountWithBalance(100000);
    await expect(
      env.DB.batch([
        env.DB.prepare('UPDATE accounts SET balance_minor = balance_minor - 25000 WHERE id = ?').bind(account.id),
        // Violates operations_sign_matches_kind — an expense with a positive amount.
        env.DB.prepare(
          `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
           VALUES ('2026-08-10', ?, 'expense', 'Кофе', 350, 'manual')`,
        ).bind(account.id),
      ]),
    ).rejects.toThrow();

    expect(await balanceOf(account.id)).toBe(100000);
  });
});

describe('settings', () => {
  it('returns the migration default values as strings', async () => {
    const res = await api('GET', '/api/v2/settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, string> };
    expect(body.settings).toEqual({
      base_currency: 'USD',
      low_balance_threshold_minor: '100000',
    });
  });

  describe('PUT /settings/base_currency', () => {
    it('normalizes a valid ISO 4217 code, saves it, and reflects it after the update', async () => {
      const threshold = await api('PUT', '/api/v2/settings/low_balance_threshold_minor', { value: 12345 });
      expect(threshold.status).toBe(200);

      const res = await api('PUT', '/api/v2/settings/base_currency', { value: ' rsd ' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { settings: Record<string, string> };
      expect(body.settings.base_currency).toBe('RSD');
      expect(body.settings.low_balance_threshold_minor).toBe('12345');

      const refreshed = await api('GET', '/api/v2/settings');
      const refreshedBody = (await refreshed.json()) as { settings: Record<string, string> };
      expect(refreshedBody.settings.base_currency).toBe('RSD');
      expect(refreshedBody.settings.low_balance_threshold_minor).toBe('12345');

      const forecast = await api('GET', '/api/v2/forecast?days=1');
      expect(await forecast.json()).toMatchObject({
        base_currency: 'RSD',
        low_balance_threshold_minor: 12345,
      });
    });

    it.each([
      ['a non-string', 123],
      ['a 2-letter code', 'EU'],
      ['a code with digits', 'EU1'],
      ['a three-letter code that does not exist', 'ZZZ'],
    ])('rejects %s and does not change the setting', async (_label, value) => {
      const res = await api('PUT', '/api/v2/settings/base_currency', { value });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBeTypeOf('string');

      const refreshed = await api('GET', '/api/v2/settings');
      const body = (await refreshed.json()) as { settings: Record<string, string> };
      expect(body.settings.base_currency).toBe('USD');
    });

    it('saving the same base again does not delete the current fx_rates', async () => {
      await api('PUT', '/api/v2/fx-rates/EUR', { rate: '0.92' });

      const res = await api('PUT', '/api/v2/settings/base_currency', { value: ' usd ' });
      expect(res.status).toBe(200);

      const rates = (await (await api('GET', '/api/v2/fx-rates')).json()) as { rates: unknown[] };
      expect(rates.rates).toHaveLength(1);
    });

    it('changing the base does NOT delete fx_rates (rates are independent of the base)', async () => {
      // Create a rate for a non-base currency while the current base is USD.
      await api('PUT', '/api/v2/fx-rates/EUR', { rate: '0.92' });
      const before = (await (await api('GET', '/api/v2/fx-rates')).json()) as { rates: unknown[] };
      expect(before.rates.length).toBeGreaterThan(0);

      // Change the base — rates are stored as usd_per_unit and do not depend on the base,
      // so they must stay untouched (regression ALE-9: previously
      // changing the base wiped every rate).
      const res = await api('PUT', '/api/v2/settings/base_currency', { value: 'EUR' });
      expect(res.status).toBe(200);

      const after = (await (await api('GET', '/api/v2/fx-rates')).json()) as { rates: unknown[] };
      expect(after.rates).toEqual(before.rates);
    });
  });
});

// An operation row can be deleted from another tab exactly between the PATCH
// read and the PATCH write: v2 has no per-request transaction. Without a branch for
// an empty RETURNING, the handler would dereference null and return a 500 with the text
// of an internal error — the race is reproduced by swapping prepare on the UPDATE itself,
// because otherwise it cannot be caught deterministically.
describe('race: the row was deleted between the PATCH read and the PATCH write', () => {
  function deleteRowBeforeUpdate(table: string, id: number) {
    const realPrepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.startsWith(`UPDATE ${table}`)) return stmt as never;
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            first: async () => {
              await realPrepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
              return bound.first();
            },
          };
        },
      } as never;
    }) as never);
    return spy;
  }

  it('a planned item → 404, not 500', async () => {
    const { account } = await createAccount();
    const id = (await createPlannedItem(account.id, {})).planned_item.id as number;
    const spy = deleteRowBeforeUpdate('planned_items', id);
    try {
      const res = await api('PATCH', `/api/v2/planned-items/${id}`, { title: 'Новое' });
      expect(res.status).toBe(404);
      expect((await errorBody(res)).code).toBe('NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
  });

  it('a recurring item → 404, not 500', async () => {
    const { account } = await createAccount();
    const id = (await createRecurringItem(account.id, {})).recurring_item.id as number;
    const spy = deleteRowBeforeUpdate('recurring_items', id);
    try {
      const res = await api('PATCH', `/api/v2/recurring-items/${id}`, { title: 'Новое' });
      expect(res.status).toBe(404);
      expect((await errorBody(res)).code).toBe('NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
  });

  // For an operation the cost of this race is higher than for a planned item: the same batch
  // that edits the row also corrects the balance. Check both halves — a 404 instead of
  // a 500 AND an untouched balance: the delta in the batch is conditional (`balanceDeltaStatement`),
  // otherwise the balance would move along with an operation that is already gone.
  // An operation edit is a single `batch` (row + balance), so swapping
  // `prepare` does not fit here — open the window in front of the batch itself.
  function deleteRowBeforeBatch(id: number) {
    const realBatch = env.DB.batch.bind(env.DB);
    return vi.spyOn(env.DB, 'batch').mockImplementation((async (statements: unknown) => {
      await env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(id).run();
      return realBatch(statements as never);
    }) as never);
  }

  it('an operation → 404, not 500, and the balance does not drift', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const id = (await createOperation(account.id, { amount_minor: -25000 })).operation.id as number;
    const spy = deleteRowBeforeBatch(id);
    try {
      const res = await api('PATCH', `/api/v2/operations/${id}`, { amount_minor: -50000 });
      expect(res.status).toBe(404);
      expect((await errorBody(res)).code).toBe('NOT_FOUND');
    } finally {
      spy.mockRestore();
    }

    const { accounts } = (await (await api('GET', '/api/v2/accounts')).json()) as {
      accounts: Record<string, unknown>[];
    };
    // 100000 - 25000 from creation; deleting the row outside the API does not adjust the balance,
    // so the expected state here is exactly the post-creation state, with no trace of the patch.
    expect(accounts[0]!.balance_minor).toBe(75000);
  });
});

describe('MF-21 existing-operation fulfillment', () => {
  it('links an existing operation to a planned item without changing provenance, count, or balance', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const accountId = account.id as number;
    const { planned_item: planned } = await createPlannedItem(accountId, {
      date: '2026-09-01', amount_minor: -1000, currency: 'USD', category: 'Housing',
    });
    const { operation } = await createOperation(accountId, {
      date: '2026-09-01', amount_minor: -1000, item: 'Аренда', category: 'Housing',
    });
    await env.DB.prepare("UPDATE operations SET source = 'agent' WHERE id = ?").bind(operation.id).run();
    operation.source = 'agent';
    const before = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
    const beforeCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>();

    const response = await api('POST', `/api/v2/planned-items/${planned.id}/fulfill-existing`, {
      operation_id: operation.id,
    });
    expect(response.status).toBe(201);
    const body: any = await response.json();
    expect(body.status).toBe('linked');
    expect(body.planned_item).toMatchObject({ done: true, fulfillment: { type: 'linked', operation_id: operation.id } });
    expect(body.operation).toMatchObject({ id: operation.id, source: 'agent', planned_item_id: null });
    expect(await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first()).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first()).toEqual(beforeCount);

    const replay = await api('POST', `/api/v2/planned-items/${planned.id}/fulfill-existing`, { operation_id: operation.id });
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).status).toBe('already-linked');

    const reopened = await api('PATCH', `/api/v2/planned-items/${planned.id}`, { done: false });
    expect(reopened.status).toBe(200);
    expect((await reopened.json()) as Record<string, unknown>).toMatchObject({
      planned_item: { id: planned.id, done: false, fulfillment: null },
    });
    expect((await env.DB.prepare('SELECT source FROM operations WHERE id = ?').bind(operation.id).first<{ source: string }>())?.source).toBe('agent');
    expect(await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first()).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first()).toEqual(beforeCount);
  });

  it('links several existing operations to one recurring occurrence and rejects incompatible reuse', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const accountId = account.id as number;
    const { recurring_item: recurring } = await createRecurringItem(accountId, {
      title: 'Продукты', category: 'Продукты', next_due_date: '2026-09-01', amount_minor: -1300,
    });
    const first = (await createOperation(accountId, {
      date: '2026-09-01', item: 'Хлеб', category: 'Продукты', amount_minor: -600,
    })).operation;
    const second = (await createOperation(accountId, {
      date: '2026-09-01', item: 'Молоко', category: 'Продукты', amount_minor: -700,
    })).operation;
    const before = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
    const beforeCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>();

    const response = await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [second.id, first.id],
    });
    expect(response.status).toBe(201);
    const body: any = await response.json();
    expect(body.status).toBe('linked');
    expect(body.fulfillment).toMatchObject({
      recurring_item_id: recurring.id, period_due_date: '2026-09-01', outcome: 'linked',
      evidence_quantity: 1,
      operation_ids: [first.id, second.id],
    });
    expect(body.recurring_item.next_due_date).toBe('2026-09-02');
    expect(await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first()).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first()).toEqual(beforeCount);

    const replay = await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [first.id, second.id],
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).status).toBe('already-linked');

    const conflict = await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [first.id],
    });
    expect(conflict.status).toBe(409);
  });

  it('uses explicit evidence_quantity only to validate discrete units and advances exactly one occurrence', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const recurring = (await createRecurringItem(account.id, {
      title: 'Сигареты', category: 'Smoking', next_due_date: '2026-09-01', amount_minor: -53000,
    })).recurring_item;
    const operation = (await createOperation(account.id, {
      date: '2026-09-01', item: '3 packs', category: 'Smoking', amount_minor: -159000,
    })).operation;

    const withoutQuantity = await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [operation.id],
    });
    expect(withoutQuantity.status).toBe(400);

    const linked = await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [operation.id], evidence_quantity: 3,
    });
    expect(linked.status).toBe(201);
    expect(await linked.json()).toMatchObject({
      evidence_quantity: 3,
      recurring_item: { next_due_date: '2026-09-02' },
      fulfillment: { evidence_quantity: 3, period_due_date: '2026-09-01' },
    });

    const mismatchedReplay = await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [operation.id], evidence_quantity: 2,
    });
    expect(mismatchedReplay.status).toBe(409);
  });

  it('rejects recurring fulfillment across accounts and leaves the ledger unchanged', async () => {
    const firstAccount = (await createAccount({ name: 'A', balance_minor: 100000 })).account;
    const secondAccount = (await createAccount({ name: 'B', balance_minor: 50000 })).account;
    const recurring = (await createRecurringItem(firstAccount.id, { category: 'Продукты' })).recurring_item;
    const operation = (await createOperation(secondAccount.id, {
      date: '2026-09-01', category: 'Продукты', amount_minor: -1000,
    })).operation;
    const before = (await env.DB.prepare('SELECT id, balance_minor FROM accounts ORDER BY id').all()).results;

    const response = await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [operation.id],
    });
    expect(response.status).toBe(400);
    expect((await env.DB.prepare('SELECT id, balance_minor FROM accounts ORDER BY id').all()).results).toEqual(before);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(0);
  });

  it('does not use a refund to fulfill a planned income with the same amount', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const planned = (await createPlannedItem(account.id, {
      date: '2026-09-01', title: 'Доход', amount_minor: 1000,
    })).planned_item;
    const operation = (await createOperation(account.id, {
      date: '2026-09-01', kind: 'refund', item: 'Возврат', amount_minor: 1000,
    })).operation;
    const response = await api('POST', `/api/v2/planned-items/${planned.id}/fulfill-existing`, {
      operation_id: operation.id,
    });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('FULFILLMENT_KIND_MISMATCH');
  });

  it('does not delete an operation that is durable evidence for a recurring occurrence', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const recurring = (await createRecurringItem(account.id, {
      category: 'Продукты', next_due_date: '2026-09-01',
    })).recurring_item;
    const operation = (await createOperation(account.id, {
      date: '2026-09-01', category: 'Продукты', amount_minor: -1000,
    })).operation;
    expect((await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-01', operation_ids: [operation.id],
    })).status).toBe(201);

    const response = await api('DELETE', `/api/v2/operations/${operation.id}`);
    expect(response.status).toBe(409);
    expect((await errorBody(response)).code).toBe('OPERATION_FULFILLS_RECURRING');
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE id = ?').bind(operation.id).first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(99000);
  });

  describe('cancel-period-fulfillment (issue #565)', () => {
    it('cancels a materialized period, leaves the operation, then delete succeeds', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const recurring = (await createRecurringItem(account.id, {
        title: 'Ежедневные', next_due_date: '2026-09-20',
      })).recurring_item;
      const closed = await api('POST', `/api/v2/recurring-items/${recurring.id}/close-period`, {});
      expect(closed.status).toBe(201);
      const closedBody = await closed.json() as {
        operation: { id: number; amount_minor: number };
        recurring_item: { next_due_date: string };
      };
      expect(closedBody.recurring_item.next_due_date).toBe('2026-09-21');
      expect((await api('DELETE', `/api/v2/operations/${closedBody.operation.id}`)).status).toBe(409);

      const cancel = await api('POST', `/api/v2/recurring-items/${recurring.id}/cancel-period-fulfillment`, {
        period_due_date: '2026-09-20',
      });
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toMatchObject({
        recurring_item: { id: recurring.id, next_due_date: '2026-09-20', active: true },
        canceled: {
          recurring_item_id: recurring.id,
          period_due_date: '2026-09-20',
          outcome: 'materialized',
          operation_ids: [closedBody.operation.id],
        },
      });
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE id = ?').bind(closedBody.operation.id).first<{ count: number }>())?.count).toBe(1);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(99000);

      expect((await api('DELETE', `/api/v2/operations/${closedBody.operation.id}`)).status).toBe(204);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations WHERE id = ?').bind(closedBody.operation.id).first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(100000);
    });

    it('cancels a linked period so leftover operations become deletable', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const recurring = (await createRecurringItem(account.id, {
        category: 'Продукты', next_due_date: '2026-09-20',
      })).recurring_item;
      const operation = (await createOperation(account.id, {
        date: '2026-09-20', category: 'Продукты', amount_minor: -1000,
      })).operation;
      expect((await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
        period_due_date: '2026-09-20', operation_ids: [operation.id],
      })).status).toBe(201);

      const cancel = await api('POST', `/api/v2/recurring-items/${recurring.id}/cancel-period-fulfillment`, {
        period_due_date: '2026-09-20',
      });
      expect(cancel.status).toBe(200);
      expect((await cancel.json() as { canceled: { outcome: string } }).canceled.outcome).toBe('linked');
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(recurring.id).first<{ next_due_date: string }>())?.next_due_date).toBe('2026-09-20');
      expect((await api('DELETE', `/api/v2/operations/${operation.id}`)).status).toBe(204);
    });

    it('cancels a skip so skip_period can be re-applied later', async () => {
      const { account } = await createAccount({ balance_minor: 50000 });
      const recurring = (await createRecurringItem(account.id, {
        title: 'Аналитика', next_due_date: '2026-09-20',
      })).recurring_item;
      expect((await api('POST', `/api/v2/recurring-items/${recurring.id}/skip-period`, {})).status).toBe(200);
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(recurring.id).first<{ next_due_date: string }>())?.next_due_date).toBe('2026-09-21');

      const cancel = await api('POST', `/api/v2/recurring-items/${recurring.id}/cancel-period-fulfillment`, {
        period_due_date: '2026-09-20',
      });
      expect(cancel.status).toBe(200);
      expect((await cancel.json() as { canceled: { outcome: string } }).canceled.outcome).toBe('skipped');
      expect((await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(recurring.id).first<{ next_due_date: string }>())?.next_due_date).toBe('2026-09-20');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(50000);

      const skippedAgain = await api('POST', `/api/v2/recurring-items/${recurring.id}/skip-period`, {});
      expect(skippedAgain.status).toBe(200);
      expect((await skippedAgain.json() as { fulfillment: { outcome: string; period_due_date: string } }).fulfillment)
        .toMatchObject({ outcome: 'skipped', period_due_date: '2026-09-20' });
    });

    it('fails closed on bad ids and unknown periods without mutating history', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const recurring = (await createRecurringItem(account.id, {
        next_due_date: '2026-09-20',
      })).recurring_item;
      expect((await api('POST', `/api/v2/recurring-items/${recurring.id}/skip-period`, {})).status).toBe(200);

      expect((await api('POST', '/api/v2/recurring-items/999999/cancel-period-fulfillment', {
        period_due_date: '2026-09-20',
      })).status).toBe(404);
      expect((await api('POST', '/api/v2/recurring-items/abc/cancel-period-fulfillment', {
        period_due_date: '2026-09-20',
      })).status).toBe(404);
      const badDate = await api('POST', `/api/v2/recurring-items/${recurring.id}/cancel-period-fulfillment`, {
        period_due_date: '20-09-2026',
      });
      expect(badDate.status).toBe(400);
      const missingPeriod = await api('POST', `/api/v2/recurring-items/${recurring.id}/cancel-period-fulfillment`, {
        period_due_date: '2026-09-21',
      });
      expect(missingPeriod.status).toBe(404);
      expect((await errorBody(missingPeriod)).code).toBe('RECURRING_PERIOD_FULFILLMENT_NOT_FOUND');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);
    });

    it('does not rewind the schedule when a later period remains fulfilled', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const recurring = (await createRecurringItem(account.id, {
        next_due_date: '2026-09-20',
      })).recurring_item;
      expect((await api('POST', `/api/v2/recurring-items/${recurring.id}/close-period`, {})).status).toBe(201);
      expect((await api('POST', `/api/v2/recurring-items/${recurring.id}/skip-period`, {})).status).toBe(200);

      const cancel = await api('POST', `/api/v2/recurring-items/${recurring.id}/cancel-period-fulfillment`, {
        period_due_date: '2026-09-20',
      });
      expect(cancel.status).toBe(200);
      expect((await cancel.json() as { recurring_item: { next_due_date: string } }).recurring_item.next_due_date).toBe('2026-09-22');
      const history = await api('GET', `/api/v2/recurring-fulfillments?recurring_item_id=${recurring.id}`);
      expect(await history.json()).toMatchObject({
        recurring_fulfillments: [{ period_due_date: '2026-09-21', outcome: 'skipped' }],
      });
    });

    it('reactivates a finished rule when its last closed period is canceled', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const recurring = (await createRecurringItem(account.id, {
        frequency: 'monthly',
        day_of_month: 20,
        next_due_date: '2026-09-20',
        end_date: '2026-09-20',
      })).recurring_item;
      const closed = await api('POST', `/api/v2/recurring-items/${recurring.id}/close-period`, {});
      expect(closed.status).toBe(201);
      expect((await closed.json() as { recurring_item: { active: boolean } }).recurring_item.active).toBe(false);

      const cancel = await api('POST', `/api/v2/recurring-items/${recurring.id}/cancel-period-fulfillment`, {
        period_due_date: '2026-09-20',
      });
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toMatchObject({
        recurring_item: { active: true, next_due_date: '2026-09-20' },
      });
    });
  });

  describe('booking guards (issue #565)', () => {
    async function seedAnalyticalRule(accountId: number, id: 16 | 17, title: string) {
      await env.DB.prepare(
        `INSERT INTO recurring_items
           (id, title, amount_minor, currency, account_id, category, frequency, interval_count,
            day_of_month, month_of_year, next_due_date, end_date, active)
         VALUES (?, ?, -1000, 'USD', ?, ?, 'daily', 1, NULL, NULL, '2026-09-20', NULL, 1)`,
      ).bind(id, title, accountId, title).run();
    }

    it('rejects close_period and fulfill-existing on analytical ids 16 and 17; skip_period still works', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const accountId = account.id as number;
      await seedAnalyticalRule(accountId, 16, 'Продукты');
      await seedAnalyticalRule(accountId, 17, 'Ежедневные');
      const operation = (await createOperation(account.id, {
        date: '2026-09-20', item: 'Хлеб', amount_minor: -1000, category: 'Продукты',
      })).operation;

      for (const id of [16, 17] as const) {
        const close = await api('POST', `/api/v2/recurring-items/${id}/close-period`, {});
        expect(close.status).toBe(409);
        expect((await errorBody(close)).code).toBe('ANALYTICAL_RECURRING_SKIP_ONLY');
        const fulfill = await api('POST', `/api/v2/recurring-items/${id}/fulfill-existing`, {
          period_due_date: '2026-09-20', operation_ids: [operation.id],
        });
        expect(fulfill.status).toBe(409);
        expect((await errorBody(fulfill)).code).toBe('ANALYTICAL_RECURRING_SKIP_ONLY');
      }

      const skipped = await api('POST', '/api/v2/recurring-items/16/skip-period', {});
      expect(skipped.status).toBe(200);
      expect((await skipped.json() as { fulfillment: { outcome: string } }).fulfillment.outcome).toBe('skipped');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>())?.count).toBe(1);
    });

    it('rejects a new expense that repeats a Wolt/order id or the same date/account/store/amount', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const first = await api('POST', '/api/v2/operations', {
        date: '2026-09-20', account_id: account.id, kind: 'expense',
        item: 'Wolt order ABC12345', store: 'Wolt', amount_minor: -283169, comment: 'order ABC12345',
      });
      expect(first.status).toBe(201);
      const firstId = (await first.json() as { operation: { id: number } }).operation.id;

      const byOrder = await api('POST', '/api/v2/operations', {
        date: '2026-09-21', account_id: account.id, kind: 'expense',
        item: 'Dinner', store: 'Other', amount_minor: -100, comment: 'Wolt ABC12345',
      });
      expect(byOrder.status).toBe(409);
      expect(await errorBody(byOrder)).toMatchObject({
        code: 'DUPLICATE_EXPENSE',
        params: { existingOperationId: firstId },
      });

      const byFingerprint = await api('POST', '/api/v2/operations', {
        date: '2026-09-20', account_id: account.id, kind: 'expense',
        item: 'Same shop trip', store: 'Wolt', amount_minor: -283169,
      });
      expect(byFingerprint.status).toBe(409);
      expect((await errorBody(byFingerprint)).code).toBe('DUPLICATE_EXPENSE');

      const distinct = await api('POST', '/api/v2/operations', {
        date: '2026-09-20', account_id: account.id, kind: 'expense',
        item: 'Bread', store: 'Maxi', amount_minor: -400,
      });
      expect(distinct.status).toBe(201);
    });

    it('allows same-PFR multi-line expenses and still 409s an exact line as ValidationError', async () => {
      const { account } = await createAccount({ balance_minor: 100000 });
      const pfr = 'JDEKKL35-GESE6HO0-136069';
      const receiptUrl = 'https://suf.purs.gov.rs/v/?vl=aroma';
      const first = await api('POST', '/api/v2/operations', {
        date: '2026-09-20', account_id: account.id, kind: 'expense',
        item: 'Espresso', store: 'Aroma', amount_minor: -25000,
        fiscal_receipt_id: pfr, receipt_url: receiptUrl,
      });
      expect(first.status).toBe(201);
      const firstId = (await first.json() as { operation: { id: number } }).operation.id;

      const second = await api('POST', '/api/v2/operations', {
        date: '2026-09-20', account_id: account.id, kind: 'expense',
        item: 'Croissant', store: 'Aroma', amount_minor: -18000,
        fiscal_receipt_id: pfr, receipt_url: receiptUrl,
      });
      expect(second.status).toBe(201);

      const duplicate = await api('POST', '/api/v2/operations', {
        date: '2026-09-20', account_id: account.id, kind: 'expense',
        item: 'Espresso', store: 'Aroma', amount_minor: -25000,
        fiscal_receipt_id: pfr, receipt_url: receiptUrl,
      });
      expect(duplicate.status).toBe(409);
      expect(await errorBody(duplicate)).toMatchObject({
        code: 'DUPLICATE_EXPENSE',
        params: { existingOperationId: firstId },
      });
    });
  });

  it('blocks semantic edits of externally linked facts but allows descriptive edits', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const planned = (await createPlannedItem(account.id, {
      date: '2026-09-01', title: 'Rent', amount_minor: -1000, category: 'Housing',
    })).planned_item;
    const operation = (await createOperation(account.id, {
      date: '2026-09-01', item: 'Rent', amount_minor: -1000, category: 'Housing',
    })).operation;
    await env.DB.prepare("UPDATE operations SET source = 'agent' WHERE id = ?").bind(operation.id).run();
    operation.source = 'agent';
    expect((await api('POST', `/api/v2/planned-items/${planned.id}/fulfill-existing`, {
      operation_id: operation.id,
    })).status).toBe(201);

    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { amount_minor: -2000 })).status).toBe(409);
    expect((await api('PATCH', `/api/v2/planned-items/${planned.id}`, { amount_minor: -2000 })).status).toBe(409);
    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { item: 'Corrected rent label' })).status).toBe(200);
    expect((await api('PATCH', `/api/v2/planned-items/${planned.id}`, { title: 'Corrected plan label' })).status).toBe(200);

    const recurring = (await createRecurringItem(account.id, {
      category: 'Food', next_due_date: '2026-09-02', amount_minor: -500,
    })).recurring_item;
    const food = (await createOperation(account.id, {
      date: '2026-09-02', category: 'Food', amount_minor: -500,
    })).operation;
    expect((await api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
      period_due_date: '2026-09-02', operation_ids: [food.id],
    })).status).toBe(201);
    expect((await api('PATCH', `/api/v2/operations/${food.id}`, { date: '2026-09-03' })).status).toBe(409);
  });

  it('deleting a planned-linked operation explicitly removes the link and reopens the plan', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const planned = (await createPlannedItem(account.id, { amount_minor: -1000 })).planned_item;
    const operation = (await createOperation(account.id, {
      date: '2026-09-01', item: 'Аренда', amount_minor: -1000,
    })).operation;
    await env.DB.prepare("UPDATE operations SET source = 'agent' WHERE id = ?").bind(operation.id).run();
    operation.source = 'agent';
    expect((await api('POST', `/api/v2/planned-items/${planned.id}/fulfill-existing`, {
      operation_id: operation.id,
    })).status).toBe(201);

    expect((await api('DELETE', `/api/v2/operations/${operation.id}`)).status).toBe(204);
    expect((await env.DB.prepare('SELECT done FROM planned_items WHERE id = ?').bind(planned.id).first<{ done: number }>())?.done).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(100000);
  });

  it('allows only one concurrent operation group to fulfill a recurring occurrence', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const recurring = (await createRecurringItem(account.id, {
      category: 'Продукты', next_due_date: '2026-09-01',
    })).recurring_item;
    const first = (await createOperation(account.id, {
      date: '2026-09-01', category: 'Продукты', amount_minor: -1000,
    })).operation;
    const second = (await createOperation(account.id, {
      date: '2026-09-01', category: 'Продукты', amount_minor: -1000,
    })).operation;

    const [left, right] = await Promise.all([
      api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
        period_due_date: '2026-09-01', operation_ids: [first.id],
      }),
      api('POST', `/api/v2/recurring-items/${recurring.id}/fulfill-existing`, {
        period_due_date: '2026-09-01', operation_ids: [second.id],
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    const links = (await env.DB.prepare(
      `SELECT operation_id FROM operation_fulfillment_links
       WHERE recurring_item_id = ? AND period_due_date = '2026-09-01'`,
    ).bind(recurring.id).all<{ operation_id: number }>()).results;
    expect(links).toHaveLength(1);
    expect([first.id, second.id]).toContain(links[0].operation_id);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);
  });
});

describe('planned_items → operation (issue #267)', () => {
  async function listOperations() {
    const res = await api('GET', '/api/v2/operations');
    expect(res.status).toBe(200);
    return ((await res.json()) as { operations: Record<string, unknown>[] }).operations;
  }

  async function balanceOf(accountId: unknown): Promise<number> {
    const res = await api('GET', '/api/v2/accounts');
    const { accounts } = (await res.json()) as { accounts: Record<string, unknown>[] };
    return accounts.find((a) => a.id === accountId)!.balance_minor as number;
  }

  async function stampOf(accountId: unknown): Promise<unknown> {
    const res = await api('GET', '/api/v2/accounts');
    const { accounts } = (await res.json()) as { accounts: Record<string, unknown>[] };
    return accounts.find((a) => a.id === accountId)!.balance_updated_at;
  }

  it('marking done creates an operation and moves the balance', async () => {
    const { account } = await createAccount({ currency: 'USD', balance_minor: 100000 });
    const created = await createPlannedItem(account.id, {
      title: 'Аренда',
      date: '2026-09-01',
      amount_minor: -25000,
      category: 'Дом',
    });
    const stamp = await stampOf(account.id);

    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { planned_item: { done: boolean } }).planned_item.done).toBe(true);

    const ops = await listOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      date: '2026-09-01',
      account_id: account.id,
      kind: 'expense',
      store: null,
      item: 'Аренда',
      category: 'Дом',
      amount_minor: -25000,
      currency: 'USD',
      receipt_id: null,
      source: 'planned',
      planned_item_id: created.planned_item.id,
    });
    expect(await balanceOf(account.id)).toBe(75000);
    expect(await stampOf(account.id)).toBe(stamp);
  });

  it('marking done again does not spawn a second operation and does not move the balance again', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000 });
    await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
    const again = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
    expect(again.status).toBe(200);
    expect(await listOperations()).toHaveLength(1);
    expect(await balanceOf(account.id)).toBe(75000);
  });

  it('creating already with done: true behaves like marking done', async () => {
    const { account } = await createAccount({ currency: 'RSD', balance_minor: 50000 });
    const created = await createPlannedItem(account.id, {
      title: 'Зарплата',
      amount_minor: 120000,
      done: true,
    });
    expect(created.planned_item.done).toBe(true);
    const ops = await listOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'income',
      item: 'Зарплата',
      amount_minor: 120000,
      source: 'planned',
      planned_item_id: created.planned_item.id,
      currency: 'RSD',
    });
    expect(await balanceOf(account.id)).toBe(170000);
  });

  it('clearing the checkbox deletes the spawned operation and returns the live amount', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000, title: 'Аренда' });
    await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });

    const opId = (await listOperations())[0]!.id;
    const edited = await api('PATCH', `/api/v2/operations/${opId}`, { amount_minor: -40000 });
    expect(edited.status).toBe(200);
    expect(await balanceOf(account.id)).toBe(60000);

    const undone = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: false });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as { planned_item: { done: boolean } }).planned_item.done).toBe(false);
    expect(await listOperations()).toEqual([]);
    expect(await balanceOf(account.id)).toBe(100000);
  });

  it('refuses to mark done when the planned-item currency does not equal the account currency', async () => {
    const { account } = await createAccount({ currency: 'USD', balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { currency: 'EUR', amount_minor: -25000 });
    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('PLANNED_CURRENCY_MISMATCH');
    expect(await listOperations()).toEqual([]);
    expect(await balanceOf(account.id)).toBe(100000);
    const planned = await api('GET', '/api/v2/planned-items');
    expect(((await planned.json()) as { planned_items: Array<{ done: boolean }> }).planned_items[0]!.done).toBe(false);
  });

  it('deleting the planned item leaves the operation — the fact outlives the plan', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000, done: true });
    const del = await api('DELETE', `/api/v2/planned-items/${created.planned_item.id}`);
    expect(del.status).toBe(204);
    const ops = await listOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ source: 'planned', planned_item_id: null, amount_minor: -25000 });
    expect(await balanceOf(account.id)).toBe(75000);
  });

  it('manual entry does not accept planned_item_id', async () => {
    const { account } = await createAccount({ balance_minor: 0 });
    const res = await api('POST', '/api/v2/operations', {
      date: '2026-08-10',
      account_id: account.id,
      kind: 'expense',
      item: 'Кофе',
      amount_minor: -350,
      planned_item_id: 1,
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/planned_item_id/);
    expect(await listOperations()).toEqual([]);
  });

  it('a repeat done: true repairs an old checkbox that has no operation', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000, title: 'Аренда' });
    await env.DB.prepare('UPDATE planned_items SET done = 1 WHERE id = ?')
      .bind(created.planned_item.id)
      .run();

    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { planned_item: { done: boolean } }).planned_item.done).toBe(true);
    const ops = await listOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      source: 'planned',
      planned_item_id: created.planned_item.id,
      amount_minor: -25000,
    });
    expect(await balanceOf(account.id)).toBe(75000);
  });

  it('editing the title of a completed planned item that has no operation does not materialize the fact (#282)', async () => {
    const { account } = await createAccount({ currency: 'EUR', balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { currency: 'EUR', amount_minor: -25000, title: 'Аренда' });
    // An old checkbox with no operation
    await env.DB.prepare("UPDATE planned_items SET done = 1, currency = 'USD' WHERE id = ?")
      .bind(created.planned_item.id)
      .run();

    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { title: 'Новая аренда' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { planned_item: { title: string; done: boolean } }).planned_item.title).toBe('Новая аренда');
    expect(await listOperations()).toEqual([]);
    expect(await balanceOf(account.id)).toBe(100000);
  });

  it('deleting the spawned operation clears done on the planned item and restores the balance', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000, title: 'Аренда', done: true });
    const opId = (await listOperations())[0]!.id;

    const res = await api('DELETE', `/api/v2/operations/${opId}`);
    expect(res.status).toBe(204);
    expect(await listOperations()).toEqual([]);
    expect(await balanceOf(account.id)).toBe(100000);

    const planned = await api('GET', '/api/v2/planned-items');
    expect(((await planned.json()) as { planned_items: Array<{ done: boolean }> }).planned_items[0]!.done).toBe(false);
  });

  it('a race with an operation someone else already inserted returns 409 and does not rewrite the plan or the balance', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000, title: 'Аренда' });
    const spy = vi.spyOn(env.DB, 'batch').mockImplementation(async () => {
      await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
         VALUES ('2026-09-01', ?, 'expense', 'Аренда', -25000, 'planned', ?)`,
      )
        .bind(account.id, created.planned_item.id)
        .run();
      throw new Error('UNIQUE constraint failed: index idx_operations_planned_item_id');
    });
    try {
      const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
      expect(res.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(await listOperations()).toHaveLength(1);
    expect(await balanceOf(account.id)).toBe(100000);
    const listed = await api('GET', '/api/v2/planned-items');
    const plan = ((await listed.json()) as { planned_items: Array<{ id: number; done: boolean; title: string }> }).planned_items
      .find((item) => item.id === created.planned_item.id);
    expect(plan).toMatchObject({ done: false, title: 'Аренда' });
  });

  it('concurrent done=true with different data leave plan, operation, and balance consistent', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000, title: 'Исходный план' });

    const [first, second] = await Promise.all([
      api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, {
        title: 'Победитель A', amount_minor: -25000, category: 'A', done: true,
      }),
      api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, {
        title: 'Победитель B', amount_minor: -30000, category: 'B', done: true,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);

    const listed = await api('GET', '/api/v2/planned-items');
    const plan = ((await listed.json()) as {
      planned_items: Array<{ id: number; date: string; title: string; amount_minor: number; account_id: number; category: string | null; done: boolean }>;
    }).planned_items.find((item) => item.id === created.planned_item.id)!;
    const operations = await listOperations() as Array<{
      planned_item_id: number; date: string; item: string; amount_minor: number; account_id: number; category: string | null;
    }>;
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      planned_item_id: plan.id,
      date: plan.date,
      item: plan.title,
      amount_minor: plan.amount_minor,
      account_id: plan.account_id,
      category: plan.category,
    });
    expect(plan.done).toBe(true);
    expect(await balanceOf(account.id)).toBe(100000 + plan.amount_minor);
  });
});

describe('API v2: transfers between accounts (/api/v2/transfers)', () => {
  async function listOperations() {
    const res = await api('GET', '/api/v2/operations');
    expect(res.status).toBe(200);
    return ((await res.json()) as { operations: Record<string, unknown>[] }).operations;
  }

  async function balanceOf(accountId: unknown): Promise<number> {
    const res = await api('GET', '/api/v2/accounts');
    const { accounts } = (await res.json()) as { accounts: Record<string, unknown>[] };
    return accounts.find((a) => a.id === accountId)!.balance_minor as number;
  }

  it('creates a transfer between accounts in the same currency and moves both balances atomically', async () => {
    const { account: from } = await createAccount({ name: 'Карта', currency: 'RSD', balance_minor: 100000 });
    const { account: to } = await createAccount({ name: 'Наличные', currency: 'RSD', balance_minor: 20000 });

    const res = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: from.id,
      to_account_id: to.id,
      from_amount_minor: 30000,
      to_amount_minor: 30000,
      item: 'Снятие в банкомате',
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      transfer: {
        id: number;
        from_operation: { id: number; account_id: number; kind: string; amount_minor: number; transfer_id: number };
        to_operation: { id: number; account_id: number; kind: string; amount_minor: number; transfer_id: number };
      };
    };

    expect(body.transfer.id).toBeTypeOf('number');
    expect(body.transfer.from_operation).toMatchObject({
      account_id: from.id,
      kind: 'transfer_out',
      amount_minor: -30000,
      transfer_id: body.transfer.id,
      item: 'Снятие в банкомате',
    });
    expect(body.transfer.to_operation).toMatchObject({
      account_id: to.id,
      kind: 'transfer_in',
      amount_minor: 30000,
      transfer_id: body.transfer.id,
      item: 'Снятие в банкомате',
    });

    expect(await balanceOf(from.id)).toBe(70000);
    expect(await balanceOf(to.id)).toBe(50000);

    const ops = await listOperations();
    expect(ops).toHaveLength(2);
  });

  it('creates a transfer between accounts in different currencies (conversion)', async () => {
    const { account: usd } = await createAccount({ name: 'USD счет', currency: 'USD', balance_minor: 100000 });
    const { account: rsd } = await createAccount({ name: 'RSD счет', currency: 'RSD', balance_minor: 0 });

    const res = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: usd.id,
      to_account_id: rsd.id,
      from_amount_minor: 10000, // $100.00
      to_amount_minor: 1080000, // 10,800.00 RSD
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      transfer: {
        id: number;
        from_operation: { amount_minor: number; currency: string; item: string };
        to_operation: { amount_minor: number; currency: string; item: string };
      };
    };

    expect(body.transfer.from_operation.amount_minor).toBe(-10000);
    expect(body.transfer.from_operation.currency).toBe('USD');
    expect(body.transfer.from_operation.item).toBe(`Перевод на «${rsd.name}»`);

    expect(body.transfer.to_operation.amount_minor).toBe(1080000);
    expect(body.transfer.to_operation.currency).toBe('RSD');
    expect(body.transfer.to_operation.item).toBe(`Перевод с «${usd.name}»`);

    expect(await balanceOf(usd.id)).toBe(90000);
    expect(await balanceOf(rsd.id)).toBe(1080000);
  });

  it('rejects a transfer to the same account', async () => {
    const { account } = await createAccount({ balance_minor: 50000 });
    const res = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: account.id,
      to_account_id: account.id,
      from_amount_minor: 1000,
      to_amount_minor: 1000,
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('ACCOUNTS_MUST_DIFFER');
  });

  it('rejects a transfer with a zero amount or to a missing account', async () => {
    const { account } = await createAccount({ balance_minor: 50000 });
    const zeroRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: account.id,
      to_account_id: 99999,
      from_amount_minor: 0,
      to_amount_minor: 1000,
    });
    expect(zeroRes.status).toBe(400);

    const missingRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: account.id,
      to_account_id: 99999,
      from_amount_minor: 1000,
      to_amount_minor: 1000,
    });
    expect(missingRes.status).toBe(400);
    expect((await errorBody(missingRes)).code).toBe('TO_ACCOUNT_NOT_FOUND');
  });

  it('rejects creating transfer_out/transfer_in directly through POST /operations', async () => {
    const { account } = await createAccount({ balance_minor: 50000 });
    const res = await api('POST', '/api/v2/operations', {
      date: '2026-08-15',
      account_id: account.id,
      kind: 'transfer_out',
      item: 'Прямой перевод',
      amount_minor: -1000,
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('TRANSFER_VIA_OPERATIONS_FORBIDDEN');
  });

  it('delete via DELETE /api/v2/transfers/:id removes both operations and restores both balances', async () => {
    const { account: from } = await createAccount({ balance_minor: 100000 });
    const { account: to } = await createAccount({ balance_minor: 20000 });

    const createRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: from.id,
      to_account_id: to.id,
      from_amount_minor: 30000,
      to_amount_minor: 30000,
    });
    const { transfer } = (await createRes.json()) as { transfer: { id: number } };

    expect(await balanceOf(from.id)).toBe(70000);
    expect(await balanceOf(to.id)).toBe(50000);

    const delRes = await api('DELETE', `/api/v2/transfers/${transfer.id}`);
    expect(delRes.status).toBe(204);

    expect(await balanceOf(from.id)).toBe(100000);
    expect(await balanceOf(to.id)).toBe(20000);
    expect(await listOperations()).toEqual([]);
  });

  it('deleting one leg of a transfer via DELETE /api/v2/operations/:id removes the whole transfer and restores both balances', async () => {
    const { account: from } = await createAccount({ balance_minor: 100000 });
    const { account: to } = await createAccount({ balance_minor: 20000 });

    const createRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: from.id,
      to_account_id: to.id,
      from_amount_minor: 40000,
      to_amount_minor: 40000,
    });
    const { transfer } = (await createRes.json()) as {
      transfer: { from_operation: { id: number } };
    };

    const delRes = await api('DELETE', `/api/v2/operations/${transfer.from_operation.id}`);
    expect(delRes.status).toBe(204);

    expect(await balanceOf(from.id)).toBe(100000);
    expect(await balanceOf(to.id)).toBe(20000);
    expect(await listOperations()).toEqual([]);
  });

  it('forbids changing the amount, account, or kind of a transfer operation via PATCH /operations/:id', async () => {
    const { account: from } = await createAccount({ balance_minor: 100000 });
    const { account: to } = await createAccount({ balance_minor: 20000 });

    const createRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: from.id,
      to_account_id: to.id,
      from_amount_minor: 15000,
      to_amount_minor: 15000,
    });
    const { transfer } = (await createRes.json()) as {
      transfer: { from_operation: { id: number } };
    };

    const patchAmount = await api('PATCH', `/api/v2/operations/${transfer.from_operation.id}`, { amount_minor: -20000 });
    expect(patchAmount.status).toBe(400);
    expect((await errorBody(patchAmount)).code).toBe('TRANSFER_FIELDS_ATOMIC');

    const patchAccount = await api('PATCH', `/api/v2/operations/${transfer.from_operation.id}`, { account_id: to.id });
    expect(patchAccount.status).toBe(400);

    const patchKind = await api('PATCH', `/api/v2/operations/${transfer.from_operation.id}`, { kind: 'expense' });
    expect(patchKind.status).toBe(400);

    // But it does allow changing the description (item) or the date
    const patchItem = await api('PATCH', `/api/v2/operations/${transfer.from_operation.id}`, { item: 'Новое описание' });
    expect(patchItem.status).toBe(200);
    expect(((await patchItem.json()) as { operation: { item: string } }).operation.item).toBe('Новое описание');
  });

  it('PUT /transfers/:id changes both amounts and recalculates the balances correctly (#401)', async () => {
    const from = (await createAccount({ balance_minor: 100000, currency: 'RSD', name: 'Списание' })).account;
    const to = (await createAccount({ balance_minor: 50000, currency: 'RSD', name: 'Зачисление' })).account;
    const createRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: from.id,
      to_account_id: to.id,
      from_amount_minor: 15000,
      to_amount_minor: 15000,
    });
    const { transfer } = (await createRes.json()) as {
      transfer: { id: number; from_operation: { id: number }; to_operation: { id: number } };
    };
    expect(await balanceOf(from.id)).toBe(85000);
    expect(await balanceOf(to.id)).toBe(65000);

    // Correct the incoming amount from 15000 to 9925.12 (as on a real exchange receipt).
    const putRes = await api('PUT', `/api/v2/transfers/${transfer.id}`, {
      date: '2026-08-15',
      from_account_id: from.id,
      to_account_id: to.id,
      from_amount_minor: 15000,
      to_amount_minor: 992512,
    });
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as {
      transfer: { from_operation: { amount_minor: number }; to_operation: { amount_minor: number } };
    };
    expect(body.transfer.from_operation.amount_minor).toBe(-15000);
    expect(body.transfer.to_operation.amount_minor).toBe(992512);

    // Balances: the debit stayed -15000 (unchanged), the credit became +992512.
    expect(await balanceOf(from.id)).toBe(85000);
    expect(await balanceOf(to.id)).toBe(50000 + 992512);
  });

  it('PUT /transfers/:id rejects a zero amount and does not corrupt the balance', async () => {
    const from = (await createAccount({ balance_minor: 100000, currency: 'RSD', name: 'Списание' })).account;
    const to = (await createAccount({ balance_minor: 0, currency: 'RSD', name: 'Зачисление' })).account;
    const createRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15', from_account_id: from.id, to_account_id: to.id,
      from_amount_minor: 1000, to_amount_minor: 1000,
    });
    const { transfer } = (await createRes.json()) as { transfer: { id: number } };

    const bad = await api('PUT', `/api/v2/transfers/${transfer.id}`, {
      date: '2026-08-15', from_account_id: from.id, to_account_id: to.id,
      from_amount_minor: 0, to_amount_minor: 1000,
    });
    expect(bad.status).toBe(400);
    // Balances were not touched.
    expect(await balanceOf(from.id)).toBe(99000);
    expect(await balanceOf(to.id)).toBe(1000);
  });

  it('PUT /transfers/:id rejects a currency change without an explicit new amount', async () => {
    const from = (await createAccount({ balance_minor: 100000, currency: 'RSD', name: 'Списание' })).account;
    const to = (await createAccount({ balance_minor: 0, currency: 'RSD', name: 'Зачисление' })).account;
    const usd = (await createAccount({ balance_minor: 0, currency: 'USD', name: 'USD' })).account;
    const createRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15', from_account_id: from.id, to_account_id: to.id,
      from_amount_minor: 1000, to_amount_minor: 1000,
    });
    const { transfer } = (await createRes.json()) as { transfer: { id: number } };

    // Move the credit onto a USD account without to_amount_minor in the new currency.
    const bad = await api('PUT', `/api/v2/transfers/${transfer.id}`, {
      date: '2026-08-15', from_account_id: from.id, to_account_id: usd.id,
      from_amount_minor: 1000,
    });
    expect(bad.status).toBe(400);
    expect((await errorBody(bad)).code).toBe('TRANSFER_TO_CURRENCY_CHANGE_REQUIRES_AMOUNT');
  });

  it('PUT /transfers/:id rejects a missing transfer → 404', async () => {
    const res = await api('PUT', '/api/v2/transfers/999999', {
      date: '2026-08-15', from_account_id: 1, to_account_id: 2,
      from_amount_minor: 100, to_amount_minor: 100,
    });
    expect(res.status).toBe(404);
  });
});
