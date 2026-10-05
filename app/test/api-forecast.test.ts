// Forecast endpoints and settings writes (issue #198, S1-4) — a real workerd
// on top of a real D1, using the same approach as test/api-v2.test.ts (the
// session-cookie signature lives there and is not repeated in a comment here).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { errorOf } from './api-error-helpers';

let cookie: string;

beforeAll(async () => {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM receipts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM accounts'),
    // settings are left alone — the defaults come from migration 0001 itself, and the
    // "end-to-end run" test also checks a write on top of them.
  ]);
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('base_currency', 'USD') ON CONFLICT(key) DO UPDATE SET value = 'USD'",
  ).run();
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('low_balance_threshold_minor', '100000') ON CONFLICT(key) DO UPDATE SET value = '100000'",
  ).run();
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

async function createAccount(overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/accounts', {
    name: 'Основной',
    currency: 'usd',
    owner: 'Алекс',
    country: 'USA',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { account: Record<string, unknown> }).account;
}

describe('guard: no session', () => {
  it('GET /forecast without a cookie → 401', async () => {
    const res = await api('GET', '/api/v2/forecast', undefined, false);
    expect(res.status).toBe(401);
  });

  it('PUT /settings/:key without a cookie → 401', async () => {
    const res = await api('PUT', '/api/v2/settings/low_balance_threshold_minor', { value: 0 }, false);
    expect(res.status).toBe(401);
  });
});

describe('GET /forecast — days validation', () => {
  it.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '1.5'],
    ['above 366', '367'],
  ])('days=%s (%s) → 400', async (_label, raw) => {
    const res = await api('GET', `/api/v2/forecast?days=${raw}`);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('without days, the default horizon is 365', async () => {
    const res = await api('GET', '/api/v2/forecast');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { horizon_days: number; series: unknown[] };
    expect(body.horizon_days).toBe(365);
    expect(body.series).toHaveLength(365);
  });

  it('days=366 — the upper bound is valid', async () => {
    const res = await api('GET', '/api/v2/forecast?days=366');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { horizon_days: number };
    expect(body.horizon_days).toBe(366);
  });

  it('on an empty database — zero aggregates, lowest = null, no warnings', async () => {
    const res = await api('GET', '/api/v2/forecast?days=7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      base_currency: 'USD',
      low_balance_threshold_minor: 100000,
      net_worth_minor: 0,
      cash_flow_minor: 0,
      countries: [],
      lowest: null,
      accounts: [],
      upcoming: [],
      warnings: [],
      missing_rates: [],
    });
  });

  it('an unknown three-letter code in settings does not become the forecast base currency', async () => {
    await env.DB.prepare("UPDATE settings SET value = 'ZZZ' WHERE key = 'base_currency'").run();

    const res = await api('GET', '/api/v2/forecast?days=1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { base_currency: string }).base_currency).toBe('USD');
  });
});

describe('GET /forecast — end-to-end run on seeded data', () => {
  it('accounts in two currencies, a planned operation and a recurring one, and a rate — concrete numbers', async () => {
    vi.useFakeTimers();
    try {
      // "Today" is fixed so flow dates stay predictable.
      vi.setSystemTime(new Date('2026-08-12T00:00:00Z'));

      const usd = await createAccount({ name: 'USD-счёт', currency: 'USD', balance_minor: 1_000_000 }); // $10 000.00
      const rsd = await createAccount({ name: 'RSD-счёт', currency: 'RSD', country: 'SRB', balance_minor: 20_000_000 }); // 200 000.00 RSD

      expect((await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' })).status).toBe(200);

      // Planned: -500.00 RSD in 10 days (2026-08-22); currency equals the account currency.
      const plannedRes = await api('POST', '/api/v2/planned-items', {
        date: '2026-08-22',
        title: 'Аренда',
        amount_minor: -50000,
        account_id: rsd.id,
      });
      expect(plannedRes.status).toBe(201);

      // Recurring: -$10.00 every 20 days from 2026-08-14 — two occurrences
      // within the 30-day horizon (2026-08-14 and 2026-09-03).
      const recurringRes = await api('POST', '/api/v2/recurring-items', {
        title: 'Подписка',
        amount_minor: -1000,
        account_id: usd.id,
        frequency: 'daily',
        interval_count: 20,
        next_due_date: '2026-08-14',
      });
      expect(recurringRes.status).toBe(201);

      const res = await api('GET', '/api/v2/forecast?days=30');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;

      expect(body.as_of).toBe('2026-08-12');
      expect(body.horizon_days).toBe(30);
      expect(body.base_currency).toBe('USD');
      expect(body.low_balance_threshold_minor).toBe(100000);
      expect(body.cash_flow_days).toBe(30);

      // 1 000 000 (USD) + 184 000 (200 000.00 RSD * 0.0092, ROUND_HALF_EVEN) —
      // computed independently when the test was written; see the implementer report.
      expect(body.net_worth_minor).toBe(1_184_000);
      // By day 30: 2 recurring debits (-1000×2) + 1 planned item, converted
      // from RSD (-50000 RSD → -460 USD minor) = -2460 in total from the start.
      expect(body.cash_flow_minor).toBe(-2460);

      expect(body.countries.sort()).toEqual(['SRB', 'USA']);

      const accountsById = new Map(body.accounts.map((a: any) => [a.id, a]));
      expect(accountsById.get(usd.id)).toMatchObject({ balance_minor: 1_000_000, balance_base_minor: 1_000_000 });
      expect(accountsById.get(rsd.id)).toMatchObject({ balance_minor: 20_000_000, balance_base_minor: 184_000 });

      // The complete 30-day payment window includes both recurring dates.
      expect(body.upcoming).toHaveLength(3);
      expect(body.upcoming.map((u: any) => u.date)).toEqual(['2026-08-14', '2026-08-22', '2026-09-03']);
      expect(body.upcoming[0]).toMatchObject({
        date: '2026-08-14', kind: 'recurring', account_id: usd.id, account_name: 'USD-счёт',
        amount_minor: -1000, currency: 'USD', amount_base_minor: -1000,
      });
      expect(body.upcoming[1]).toMatchObject({
        date: '2026-08-22', kind: 'planned', account_id: rsd.id, account_name: 'RSD-счёт',
        amount_minor: -50000, currency: 'RSD', amount_base_minor: -460,
      });

      // Both accounts stay far above the threshold ($1000) for the whole horizon —
      // there are no warnings on any dimension.
      expect(body.warnings).toEqual([]);
      expect(body.missing_rates).toEqual([]);

      // series — one element per horizon day; dates run consecutively.
      expect(body.series).toHaveLength(30);
      expect(body.series[0].date).toBe('2026-08-13');
      expect(body.series[29].date).toBe('2026-09-11');
      expect(body.series[0].by_country).toMatchObject({ USA: expect.any(Number), SRB: expect.any(Number) });
      expect(body.owners).toEqual(expect.arrayContaining(['Алекс']));
      expect(body.series[0].by_account).toMatchObject({
        [String(usd.id)]: expect.any(Number),
        [String(rsd.id)]: expect.any(Number),
      });
      expect(body.series[0].by_owner).toMatchObject({ Алекс: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an account in a currency with no rate drops out of the groups and lands in missing_rates', async () => {
    await createAccount({ name: 'Без курса', currency: 'CHF', balance_minor: 500000 });
    const res = await api('GET', '/api/v2/forecast?days=5');
    const body = (await res.json()) as Record<string, any>;
    expect(body.missing_rates).toEqual(['CHF']);
    expect(body.net_worth_minor).toBe(0);
    expect(body.accounts[0]).toMatchObject({ currency: 'CHF', balance_base_minor: null });
  });

  it('an overdue recurring payment enters the forecast as one sum on the nearest day and does not lose future occurrences (issue #279)', async () => {
    vi.useFakeTimers();
    try {
      // asOf = 2026-08-15
      vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));

      const account = await createAccount({ name: 'Основной', currency: 'USD', balance_minor: 100_000 }); // $1000.00

      // Recurring payment: monthly on the 15th, $100 (-10000 minor), next_due_date = 2026-07-15 (a month ago).
      // Periods already due: 2026-07-15 and 2026-08-15 (today). That is 2 missed periods = -$200.
      const recurringRes = await api('POST', '/api/v2/recurring-items', {
        title: 'Аренда серверов',
        amount_minor: -10000,
        account_id: account.id,
        frequency: 'monthly',
        day_of_month: 15,
        next_due_date: '2026-07-15',
      });
      expect(recurringRes.status).toBe(201);

      const res = await api('GET', '/api/v2/forecast?days=60');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;

      expect(body.as_of).toBe('2026-08-15');
      expect(body.net_worth_minor).toBe(100_000); // balance on asOf is $1000

      // In series: the first day, 2026-08-16, already includes the -$200 debt = $800 (80000)
      expect(body.series[0].date).toBe('2026-08-16');
      expect(body.series[0].overall_minor).toBe(80_000);

      // The next future occurrence is 2026-09-15 (-$100 = $700)
      const daySep15 = body.series.find((s: any) => s.date === '2026-09-15');
      expect(daySep15.overall_minor).toBe(70_000);

      // The calendar preserves July overdue and August due-today separately.
      expect(body.upcoming).toHaveLength(2);
      expect(body.upcoming[0]).toMatchObject({
        date: '2026-07-15',
        occurrence_count: 1,
        kind: 'recurring',
        title: 'Аренда серверов',
        amount_minor: -10000,
        currency: 'USD',
        amount_base_minor: -10000,
        account_id: account.id,
      });
      expect(body.upcoming[1]).toMatchObject({ date: '2026-08-15', amount_minor: -10000, occurrence_count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Pulse payment calendar (#470)', () => {
  it('includes outstanding past/today and a complete month even for a one-day forecast', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-15T23:30:00Z'));
      const account = await createAccount({ balance_minor: 100_000 });
      for (const date of ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-21', '2026-08-22', '2026-08-30', '2026-09-13', '2026-09-14']) {
        expect((await api('POST', '/api/v2/planned-items', {
          date, title: date, amount_minor: -100, account_id: account.id,
        })).status).toBe(201);
      }
      // Omit completed plans without creating actual financial operations.
      await env.DB.prepare("UPDATE planned_items SET done = 1 WHERE date = '2026-08-30'").run();
      const res = await api('GET', '/api/v2/forecast?days=1');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;
      expect(body.as_of).toBe('2026-08-15');
      expect(body.upcoming.map((p: any) => p.date)).toEqual([
        '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-21', '2026-08-22', '2026-09-13',
      ]);
      expect(body.upcoming.every((p: any) => p.occurrence_count === 1)).toBe(true);
      expect(body.series).toHaveLength(1);
      expect(body.series[0].overall_minor).toBe(99_900);
      expect(body.net_worth_minor).toBe(100_000);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>())?.n).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('groups only prior recurring periods, respects inclusive ends and clamps month dates', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-28T12:00:00Z'));
      const account = await createAccount({ balance_minor: 100_000 });
      for (const [title, end_date, active] of [
        ['due-today', '2026-02-28', true], ['ended-yesterday', '2026-02-27', true],
        ['future', null, true], ['inactive', null, false],
      ] as const) {
        expect((await api('POST', '/api/v2/recurring-items', {
          title, amount_minor: -1000, account_id: account.id, frequency: 'monthly',
          day_of_month: 31, next_due_date: '2025-12-31', end_date, active,
        })).status).toBe(201);
      }
      const res = await api('GET', '/api/v2/forecast?days=1');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;
      const rows = (title: string) => body.upcoming.filter((p: any) => p.title === title);
      expect(rows('due-today')).toMatchObject([
        { date: '2025-12-31', occurrence_count: 2, amount_minor: -2000 },
        { date: '2026-02-28', occurrence_count: 1, amount_minor: -1000 },
      ]);
      expect(rows('ended-yesterday')).toMatchObject([
        { date: '2025-12-31', occurrence_count: 2, amount_minor: -2000 },
      ]);
      expect(rows('future')).toHaveLength(2); // March 31 is outside the 30-day calendar.
      expect(rows('inactive')).toEqual([]);
      expect(body.series[0].overall_minor).toBe(92_000); // 3 + 2 + 3 periods, unchanged projection.
      await env.DB.prepare('UPDATE accounts SET archived = 1 WHERE id = ?').bind(account.id).run();
      const archived = await api('GET', '/api/v2/forecast');
      expect((await archived.json() as Record<string, any>).upcoming).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('PUT /settings/:key', () => {
  it('low_balance_threshold_minor accepts a number and stores it as a string', async () => {
    const res = await api('PUT', '/api/v2/settings/low_balance_threshold_minor', { value: 50000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, string> };
    expect(body.settings.low_balance_threshold_minor).toBe('50000');

    // Visible both in GET /settings and taken into account by /forecast.
    const getRes = await api('GET', '/api/v2/settings');
    expect(((await getRes.json()) as { settings: Record<string, string> }).settings.low_balance_threshold_minor).toBe(
      '50000',
    );
    const forecastRes = await api('GET', '/api/v2/forecast?days=1');
    expect(((await forecastRes.json()) as { low_balance_threshold_minor: number }).low_balance_threshold_minor).toBe(
      50000,
    );
  });

  it('accepts a string of digits; 0 is a valid value', async () => {
    const res = await api('PUT', '/api/v2/settings/low_balance_threshold_minor', { value: '0' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, string> };
    expect(body.settings.low_balance_threshold_minor).toBe('0');
  });

  it.each([
    ['negative number', -1],
    ['fractional number', 1.5],
    ['non-numeric string', 'abc'],
    ['signed string', '-5'],
    ['null', null],
  ])('garbage value (%s) → 400, nothing changes', async (_label, value) => {
    const before = await api('GET', '/api/v2/settings');
    const beforeBody = (await before.json()) as { settings: Record<string, string> };

    const res = await api('PUT', '/api/v2/settings/low_balance_threshold_minor', { value });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');

    const after = await api('GET', '/api/v2/settings');
    const afterBody = (await after.json()) as { settings: Record<string, string> };
    expect(afterBody.settings.low_balance_threshold_minor).toBe(beforeBody.settings.low_balance_threshold_minor);
  });

  it('an unknown key → 404', async () => {
    for (const key of ['unknown_key', 'currency', 'theme']) {
      const res = await api('PUT', `/api/v2/settings/${key}`, { value: '1' });
      expect(res.status).toBe(404);
    }
  });
});
