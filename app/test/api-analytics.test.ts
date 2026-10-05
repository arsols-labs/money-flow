// Tests for the POST /api/v2/analytics endpoint (S1-5b, issue #250).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';

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
  ]);
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('base_currency', 'USD') ON CONFLICT(key) DO UPDATE SET value = 'USD'",
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

async function createAccount(name: string, currency: string, overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/accounts', {
    name,
    currency,
    owner: 'Алекс',
    country: 'USA',
    ...overrides,
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { account: { id: number; name: string; currency: string } };
  return data.account;
}

async function createRate(code: string, rate: string) {
  const res = await api('PUT', `/api/v2/fx-rates/${code}`, { rate });
  expect(res.status).toBe(200);
}

async function createOperation(account_id: number, kind: string, amount_minor: number, overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/operations', {
    date: '2026-08-10',
    account_id,
    kind,
    item: 'Покупка',
    amount_minor,
    ...overrides,
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { operation: { id: number } };
  return data.operation;
}

describe('POST /api/v2/analytics', () => {
  it('requires authorization', async () => {
    const res = await api('POST', '/api/v2/analytics', {}, false);
    expect(res.status).toBe(401);
  });

  it('rejects invalid dates (400)', async () => {
    const res1 = await api('POST', '/api/v2/analytics', { start_date: 'not-a-date' });
    expect(res1.status).toBe(400);

    const res2 = await api('POST', '/api/v2/analytics', { start_date: '2026-08-20', end_date: '2026-08-10' });
    expect(res2.status).toBe(400);
  });

  it('returns empty totals and options on an empty database', async () => {
    const res = await api('POST', '/api/v2/analytics', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.base_currency).toBe('USD');
    expect(body.stats).toEqual({
      total_spent_minor: 0,
      total_income_minor: 0,
      avg_receipt_minor: 0,
      per_day_minor: 0,
      receipts_count: 0,
      positions_count: 0,
    });
    expect(body.series.day).toEqual([]);
    expect(body.options.categories).toEqual([]);
    expect(body.missing_rates).toEqual([]);
  });

  it('computes spending, income, refunds, and series with currency conversion', async () => {
    const accUsd = await createAccount('USD Card', 'USD');
    const accRsd = await createAccount('RSD Cash', 'RSD');

    // RSD to USD rate: 0.009 (1 RSD = 0.009 USD)
    await createRate('RSD', '0.009');

    // 1. Spending in USD: $50.00 (5000 cents) on Aug 10
    await createOperation(accUsd.id, 'expense', -5000, {
      date: '2026-08-10',
      store: 'Amazon',
      category: 'Электроника',
      item: 'Кабель',
    });

    // 2. Spending in RSD: 10,000 RSD (1000000 minor, because RSD has 2 decimal places) on Aug 10 -> $90.00 (9000 cents)
    await createOperation(accRsd.id, 'expense', -1000000, {
      date: '2026-08-10',
      store: 'Maxi 722',
      category: 'Еда',
      item: 'Продукты',
    });

    // 3. Refund in RSD: 1,000 RSD on Aug 10 -> $9.00 (900 cents)
    await createOperation(accRsd.id, 'refund', 100000, {
      date: '2026-08-10',
      store: 'Maxi 722',
      category: 'Еда',
      item: 'Возврат товара',
    });

    // 4. Income in USD: $200.00 on Aug 11
    await createOperation(accUsd.id, 'income', 20000, {
      date: '2026-08-11',
      item: 'Зарплата',
    });

    const res = await api('POST', '/api/v2/analytics', {
      start_date: '2026-08-01',
      end_date: '2026-08-31',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // Spending: 5000 + 9000 - 900 = 13100 cents (131.00 USD)
    expect(body.stats.total_spent_minor).toBe(13100);
    // Income: 20000 cents (200.00 USD)
    expect(body.stats.total_income_minor).toBe(20000);
    // Spending line items: 2 (a refund and income do not increase the purchase-item counter)
    expect(body.stats.positions_count).toBe(2);
    // Receipts: 2
    expect(body.stats.receipts_count).toBe(2);
    // Average receipt: 13100 / 2 = 6550
    expect(body.stats.avg_receipt_minor).toBe(6550);
    // Days in the period: August 1 through August 31 = 31 days. Per day: 13100 / 31 = 422
    expect(body.stats.per_day_minor).toBe(422);

    // Filter options
    expect(body.options.categories.map((c: any) => c.label)).toContain('Еда');
    expect(body.options.categories.map((c: any) => c.label)).toContain('Электроника');
    expect(body.options.merchants.map((m: any) => m.label)).toContain('Maxi');
    expect(body.options.accounts).toEqual(['RSD Cash', 'USD Card']);
    expect(body.options.currencies).toEqual(['RSD', 'USD']);

    // Daily series: net 131.00, spending and refund kept separate (issue #582)
    expect(body.series.day).toHaveLength(1);
    expect(body.series.day[0].total_minor).toBe(13100);
    expect(body.series.day[0].expense_minor).toBe(14000);
    expect(body.series.day[0].refund_minor).toBe(900);
  });

  it('keeps a refund-only day as refund_minor, not a negative expense', async () => {
    const accUsd = await createAccount('USD Card', 'USD');
    await createOperation(accUsd.id, 'refund', 4000, {
      date: '2026-09-16',
      item: 'Amazon refund',
    });

    const res = await api('POST', '/api/v2/analytics', {
      start_date: '2026-09-01',
      end_date: '2026-09-30',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.series.day).toHaveLength(1);
    expect(body.series.day[0]).toMatchObject({
      total_minor: -4000,
      expense_minor: 0,
      refund_minor: 4000,
    });
  });

  it('does not throw when a currency rate is missing, and adds it to missing_rates', async () => {
    const accEur = await createAccount('EUR Card', 'EUR');
    const accUsd = await createAccount('USD Card', 'USD');

    // Spending in EUR with no rate on file
    await createOperation(accEur.id, 'expense', -5000, {
      date: '2026-08-10',
      category: 'Развлечения',
      item: 'Билет',
    });

    // Spending in USD
    await createOperation(accUsd.id, 'expense', -3000, {
      date: '2026-08-10',
      category: 'Еда',
      item: 'Обед',
    });

    const res = await api('POST', '/api/v2/analytics', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.missing_rates).toEqual(['EUR']);
    // Only the USD amount (3000) went into the total
    expect(body.stats.total_spent_minor).toBe(3000);
  });

  it('filters correctly by category, search, and store', async () => {
    const acc = await createAccount('USD Card', 'USD');

    await createOperation(acc.id, 'expense', -1000, {
      date: '2026-08-10',
      store: 'Apple Store',
      category: 'Электроника',
      item: 'iPhone Case',
    });

    await createOperation(acc.id, 'expense', -2000, {
      date: '2026-08-11',
      store: 'Steam',
      category: 'Игры',
      item: 'Game',
    });

    // Filter by category
    const resCat = await api('POST', '/api/v2/analytics', { cats: ['Игры'] });
    const bodyCat = (await resCat.json()) as any;
    expect(bodyCat.stats.total_spent_minor).toBe(2000);
    expect(bodyCat.stats.positions_count).toBe(1);

    // Filter by search
    const resSearch = await api('POST', '/api/v2/analytics', { q: 'iphone' });
    const bodySearch = (await resSearch.json()) as any;
    expect(bodySearch.stats.total_spent_minor).toBe(1000);

    // Available filter options return every category for the period
    expect(bodyCat.options.categories.map((c: any) => c.label)).toEqual(['Игры', 'Электроника']);
  });

  it('builds breakdowns of categories, subcategories, stores, top items, and receipts', async () => {
    const acc = await createAccount('USD Checking', 'USD');

    // Receipt 1: create a row in receipts (FK)
    await env.DB.prepare(
      `INSERT INTO receipts (id, r2_key, status, created_at) VALUES (101, 'receipt_101.jpg', 'confirmed', '2026-08-10T12:00:00Z')`,
    ).run();

    // 2 receipt line items (receipt_id = 101, source = 'receipt')
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source)
       VALUES ('2026-08-10', ?, 'expense', 'Maxi 722', 'Сыр Гауда', 'Еда', 'Молочные продукты', -1500, 101, 'receipt')`,
    ).bind(acc.id).run();

    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source)
       VALUES ('2026-08-10', ?, 'expense', 'Maxi 722', 'Багет', 'Еда', 'Хлеб', -800, 101, 'receipt')`,
    ).bind(acc.id).run();

    // Recurring operation (source = 'recurring')
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source)
       VALUES ('2026-08-05', ?, 'expense', NULL, 'Spotify', 'Подписки', NULL, -1200, NULL, 'recurring')`,
    ).bind(acc.id).run();

    // A recurring rule in recurring_items for the "Plans and subscriptions" block
    await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, next_due_date, active)
       VALUES ('Netflix', -1500, 'USD', ?, 'Подписки', 'monthly', 1, 15, '2026-08-15', 1)`,
    ).bind(acc.id).run();

    const res = await api('POST', '/api/v2/analytics', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // Top items
    expect(body.top_items.expense).toEqual([
      { label: 'Сыр Гауда', value_minor: 1500, count: 1 },
      { label: 'Spotify', value_minor: 1200, count: 1 },
      { label: 'Багет', value_minor: 800, count: 1 },
    ]);

    // Categories
    expect(body.categories).toEqual([
      { label: 'Еда', value_minor: 2300, count: 2, receipts_count: 1 },
      { label: 'Подписки', value_minor: 1200, count: 1, receipts_count: 1 },
    ]);

    // Subcategories
    expect(body.subcategories).toEqual([
      { label: 'Молочные продукты', value_minor: 1500, count: 1, receipts_count: 1 },
      { label: 'Хлеб', value_minor: 800, count: 1, receipts_count: 1 },
    ]);

    // Stores
    expect(body.merchants).toEqual([
      { label: 'Maxi', value_minor: 2300, count: 2, receipts_count: 1 },
    ]);

    // Recurring operations
    expect(body.recurring_operations).toEqual([
      { label: 'Spotify', value_minor: 1200, count: 1, receipts_count: 1 },
    ]);
    expect(body.recurring_details).toEqual([
      {
        id: expect.any(Number),
        date: '2026-08-05',
        item: 'Spotify',
        store: null,
        category: 'Подписки',
        subcategory: null,
        amount_minor: -1200,
        account_currency: 'USD',
        account_name: 'USD Checking',
        converted_minor: 1200,
      },
    ]);

    // Receipts
    expect(body.receipts).toHaveLength(2); // Maxi receipt (2 items) + manual Spotify (1 item)
    const maxiReceipt = body.receipts.find((r: any) => r.id === 'receipt_101');
    expect(maxiReceipt).toBeDefined();
    expect(maxiReceipt.merchant).toBe('Maxi');
    expect(maxiReceipt.receipt_total_minor).toBe(2300);
    expect(maxiReceipt.positions_count).toBe(2);
    expect(maxiReceipt.lines).toHaveLength(2);

    // Plans and subscriptions
    expect(body.plans).toBeDefined();
    expect(body.plans.monthly_subscriptions_minor).toBe(1500);
    expect(body.plans.yearly_subscriptions_minor).toBe(18000);
    expect(body.plans.categories).toEqual([
      { label: 'Подписки', value_minor: 1500 },
    ]);
    expect(body.plans.items).toHaveLength(1);
    expect(body.plans.items[0]).toMatchObject({
      title: 'Netflix',
      amount_minor: -1500,
      currency: 'USD',
      category: 'Подписки',
      frequency: 'monthly',
      monthly_eq_minor: -1500,
      converted_amount_minor: -1500,
      active: 1,
    });
  });

  it('ignores transfer operations (transfer_out, transfer_in) when calculating spending and income', async () => {
    const accFrom = await createAccount('USD Карта', 'USD');
    const accTo = await createAccount('RSD Наличные', 'RSD');

    await api('POST', '/api/v2/transfers', {
      date: '2026-08-15',
      from_account_id: accFrom.id,
      to_account_id: accTo.id,
      from_amount_minor: 10000,
      to_amount_minor: 1080000,
      item: 'Снятие $100',
    });

    // An ordinary expense for the check
    await createOperation(accFrom.id, 'expense', -2000, { item: 'Кофе', category: 'Кафе' });

    const res = await api('POST', '/api/v2/analytics', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.stats.total_spent_minor).toBe(2000);
    expect(body.stats.total_income_minor).toBe(0);
    expect(body.categories).toEqual([
      { label: 'Кафе', value_minor: 2000, count: 1, receipts_count: 1 },
    ]);
  });

  it('keeps Analytics receipt grouping by store+date+account even when PFRs differ (#557)', async () => {
    const acc = await createAccount('RSD Card', 'USD');
    await createOperation(acc.id, 'expense', -800, {
      store: 'Maxi 722', item: 'Молоко', fiscal_receipt_id: 'PFR-GROCERY',
    });
    await createOperation(acc.id, 'expense', -1200, {
      store: 'Maxi 722', item: 'Торт', fiscal_receipt_id: 'PFR-CAKE',
    });
    await createOperation(acc.id, 'expense', -443, {
      store: 'Maxi 722', item: 'Marlboro', fiscal_receipt_id: 'PFR-TOBACCO',
    });

    const res = await api('POST', '/api/v2/analytics', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const maxiCards = body.receipts.filter((r: { merchant: string }) => r.merchant === 'Maxi');
    expect(maxiCards).toHaveLength(1);
    expect(maxiCards[0].positions_count).toBe(3);
    expect(maxiCards[0].id).toMatch(/^manual_/);
  });
});

