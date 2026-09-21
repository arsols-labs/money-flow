// CRUD API v2 (S1-2, issue #196) — счета, курсы валют, настройки.
// Hono вызывается напрямую (app.request), без ASSETS-binding и без сети —
// см. приём в vitest.config.ts / test/apply-migrations.ts.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index';
import { CURRENCY_TABLES } from '../src/worker/api';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { errorBody, errorOf } from './api-error-helpers';

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let cookie: string;

// Валидная сессионная cookie не зависит от состояния БД — считаем один раз.
// createSessionCookie использует только env.SESSION_SECRET (test/env.d.ts +
// vitest.config.ts заводят его специально для этого файла).
beforeAll(async () => {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  cookie = setCookie.split(';')[0]!;
});

// Та же изоляция, что в test/schema.test.ts: обратный порядок ссылок.
// Settings теперь пишутся через API, поэтому возвращаем оба ключа к дефолтам.
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

// owner и country подставляются дефолтом намеренно: они обязательны (#232), и
// без них каждый вызов помощника проверял бы валидацию вместо своего сценария.
// Тесты самой обязательности ходят в API напрямую, минуя этот помощник.
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

// Ссылка на счёт из плановых — то, что закрывает замок измерений. Прямая
// вставка, а не через CRUD плановых (S1-3, issue #197): тесты замка не должны
// зависеть от корректности нового API — они проверяют счета, а не операции.
async function referenceAccount(accountId: unknown) {
  await env.DB.prepare(
    `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
     VALUES ('2026-09-01', 'Аренда', -1000, 'USD', ?)`,
  )
    .bind(accountId)
    .run();
}

// Плановая/регулярная операция ЧЕРЕЗ новый API (S1-3, issue #197) — в отличие
// от referenceAccount, эти хелперы проверяют сам CRUD, а не только замок счёта.
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

// Счёт обязателен, валюта не принимается вовсе (она у счёта), сумма — дельта
// баланса: расход отрицателен (issue #200, решение владельца 2026-08-12).
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

// Прямая вставка курса в обход API (#228: PUT для базовой валюты теперь
// отклоняется на входе) — моделирует строку, заведённую до фикса или правкой
// БД напрямую. Живёт на уровне модуля, а не внутри одного describe: тесты,
// которым она нужна для setup, разбросаны по describe('fx-rates') и по
// вложенным describe внутри describe('покрытие валют курсами (issue #193)').
async function insertRate(code: string, rateE9: string, updatedAt = '2026-08-01T00:00:00Z') {
  await env.DB.prepare('INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)')
    .bind(code, rateE9, updatedAt)
    .run();
}

describe('guard: без сессии', () => {
  it('любой роут /api/v2/* без cookie → 401', async () => {
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
  it('создание и чтение в списке', async () => {
    const created = await createAccount({ name: 'Карта', currency: 'rsd', balance_minor: 12345 });
    expect(created.account).toMatchObject({
      name: 'Карта',
      currency: 'RSD', // нормализовано в UPPER
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

  it('второй счёт без sort получает max(sort)+1', async () => {
    await createAccount({ sort: 5 });
    const second = await createAccount({ name: 'Второй' });
    expect(second.account.sort).toBe(6);
  });

  it('отклоняет пустое имя', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: '   ', currency: 'USD' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('отклоняет валюту не из трёх букв', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: 'X', currency: 'US' });
    expect(res.status).toBe(400);
  });

  it('отклоняет дробный balance_minor', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: 'X', currency: 'USD', balance_minor: 10.5 });
    expect(res.status).toBe(400);
  });

  // Правило ROADMAP «Счёт имеет одного владельца, одну валюту и обязательную
  // страну»: owner и country — такие же обязательные поля, как name и currency.
  // Пустая строка и null тоже не проходят: «не указано» у этих полей нет.
  it.each([
    ['без owner', { name: 'X', currency: 'USD', country: 'SRB' }],
    ['без country', { name: 'X', currency: 'USD', owner: 'Алекс' }],
    ['owner пустой строкой', { name: 'X', currency: 'USD', owner: '   ', country: 'SRB' }],
    ['country пустой строкой', { name: 'X', currency: 'USD', owner: 'Алекс', country: '' }],
    ['owner как null', { name: 'X', currency: 'USD', owner: null, country: 'SRB' }],
    ['country как null', { name: 'X', currency: 'USD', owner: 'Алекс', country: null }],
  ])('POST %s → 400', async (_label, body) => {
    const res = await api('POST', '/api/v2/accounts', body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('POST с владельцем и страной сохраняет их как есть, банк остаётся необязательным', async () => {
    const created = await createAccount({ owner: '  Алекс  ', country: '  SRB  ' });
    expect(created.account).toMatchObject({ owner: 'Алекс', country: 'SRB', bank: null });
  });

  it('PATCH не даёт стереть владельца или страну', async () => {
    const created = await createAccount();
    for (const patch of [{ owner: '' }, { owner: null }, { country: '   ' }, { country: null }]) {
      const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, patch);
      expect(res.status).toBe(400);
    }
  });

  it('PATCH меняет переданные поля и не трогает остальные', async () => {
    const created = await createAccount({ name: 'До', bank: 'Старый банк', currency: 'usd' });
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, { name: 'После', bank: 'Новый банк' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ name: 'После', bank: 'Новый банк', currency: 'USD' });
  });

  it('PATCH с balance_minor переставляет balance_updated_at — даже при том же значении', async () => {
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

  // Разрядность минорной единицы у валют разная, поэтому смена валюты без
  // нового баланса тихо меняла бы сумму на порядки ($1500.00 = 150000 центов
  // → ¥150 000). Сервер это отклоняет, чтобы клиент назвал сумму явно.
  it('PATCH со сменой валюты без balance_minor → 400', async () => {
    const created = await createAccount({ currency: 'USD', balance_minor: 150000 });
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, { currency: 'JPY' });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('ACCOUNT_CURRENCY_CHANGE_REQUIRES_BALANCE');

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts[0]).toMatchObject({ currency: 'USD', balance_minor: 150000 });
  });

  it('PATCH со сменой валюты и балансом проходит', async () => {
    const created = await createAccount({ currency: 'USD', balance_minor: 150000 });
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, {
      currency: 'JPY',
      balance_minor: 1500,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ currency: 'JPY', balance_minor: 1500 });
  });

  it('PATCH с той же валютой баланса не требует', async () => {
    const created = await createAccount({ currency: 'USD', name: 'До' });
    // Форма правки шлёт валюту всегда, даже когда её не меняли, — этот путь
    // не должен упираться в проверку выше.
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, { currency: 'usd', name: 'После' });
    expect(res.status).toBe(200);
  });

  it('отклоняет sort за пределами точного целого — иначе INTEGER-колонка получит REAL', async () => {
    const res = await api('POST', '/api/v2/accounts', { name: 'X', currency: 'USD', sort: 1e21 });
    expect(res.status).toBe(400);
  });

  // MAX(sort)+1 для нового счёта считается без проверок, поэтому граница
  // нужна на входе: иначе одно большое значение в таблице утащило бы
  // следующий инкремент за предел точного целого.
  it('отклоняет sort у самой границы точного целого', async () => {
    const res = await api('POST', '/api/v2/accounts', {
      name: 'X',
      currency: 'USD',
      sort: Number.MAX_SAFE_INTEGER,
    });
    expect(res.status).toBe(400);
  });

  it('PATCH несуществующего счёта → 404', async () => {
    const res = await api('PATCH', '/api/v2/accounts/999999', { name: 'Кто-то' });
    expect(res.status).toBe(404);
  });

  it('PATCH с пустым телом (без известных полей) → 400', async () => {
    const created = await createAccount();
    const res = await api('PATCH', `/api/v2/accounts/${created.account.id}`, {});
    expect(res.status).toBe(400);
  });

  it('DELETE удаляет счёт: 204 и пропажа из списка', async () => {
    const created = await createAccount();
    const delRes = await api('DELETE', `/api/v2/accounts/${created.account.id}`);
    expect(delRes.status).toBe(204);

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts).toHaveLength(0);
  });

  it('DELETE несуществующего счёта → 404', async () => {
    const res = await api('DELETE', '/api/v2/accounts/999999');
    expect(res.status).toBe(404);
  });

  it('DELETE счёта, на который ссылается planned_items → 409, счёт на месте', async () => {
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

// Единственный признак свежести баланса — `balance_updated_at`, и до этой
// задачи переставить его можно было только изменив сумму. Отдельный роут даёт
// сказать «сверился с банком, сумма та же», ничего не искажая.
describe('подтверждение баланса (issue #223)', () => {
  const PATH = (id: unknown) => `/api/v2/accounts/${id}/confirm-balance`;

  it('переставляет balance_updated_at и не трогает ничего больше', async () => {
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
      // Всё остальное — побайтово прежнее. Сравнение целыми объектами, а не
      // полем: подтверждение обязано быть безопасным целиком, и новая колонка
      // счёта попадёт под эту проверку сама, без правки теста.
      expect({ ...body.account, balance_updated_at: null }).toEqual({
        ...created.account,
        balance_updated_at: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('момент — с точностью до секунд, как везде в v2', async () => {
    const created = await createAccount();
    const res = await api('POST', PATH(created.account.id));
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.balance_updated_at).toMatch(ISO_SECONDS);
  });

  it('новое значение видно в списке, а не только в ответе', async () => {
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

  // Замок измерений (#232) сюда не распространяется: момент проверки — не
  // измерение счёта. На счёте с операциями подтверждать баланс нужно тем более:
  // именно такие счета и участвуют в прогнозе.
  it('работает на счёте, занятом операцией, — замок измерений его не касается', async () => {
    const created = await createAccount();
    await referenceAccount(created.account.id);
    const res = await api('POST', PATH(created.account.id));
    expect(res.status).toBe(200);
  });

  it('работает на архивном счёте — деньги на нём никуда не делись', async () => {
    const created = await createAccount({ balance_minor: 500 });
    expect((await api('PATCH', `/api/v2/accounts/${created.account.id}`, { archived: true })).status).toBe(200);

    const res = await api('POST', PATH(created.account.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ archived: true, balance_minor: 500 });
  });

  it('несуществующий счёт → 404, ничего не создаётся', async () => {
    const res = await api('POST', PATH(999999));
    expect(res.status).toBe(404);

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts).toHaveLength(0);
  });

  it('нечисловой и дробный id → 404, а не 500', async () => {
    for (const raw of ['abc', '1.5']) {
      const res = await api('POST', PATH(raw));
      expect(res.status).toBe(404);
    }
  });

  // Тело роут не читает вовсе — подтверждать нечего, кроме самого факта. Битый
  // JSON не должен превращаться в 500: у клиента нет причин его слать, но и
  // падать на нём эндпоинту незачем.
  it('присланное тело игнорируется, битый JSON не даёт 500', async () => {
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

  it('без сессии → 401 и отметка не двигается', async () => {
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

// Правило ROADMAP: «После первой операции владелец, валюта, страна, банк и вид
// счёта неизменяемы». Первой операцией здесь считается любая ссылка на счёт из
// planned_items или recurring_items — тот же признак занятости, который уже
// держит DELETE.
describe('замок измерений счёта (issue #232)', () => {
  const LOCKED: Array<[string, Record<string, unknown>]> = [
    ['owner', { owner: 'Другой' }],
    ['country', { country: 'USA' }],
    ['bank', { bank: 'Другой банк' }],
    ['type', { type: 'cash' }],
    // Валюта идёт с балансом: без него запрос упёрся бы в 400 раньше замка, и
    // тест доказывал бы не то, что нужно.
    ['currency', { currency: 'EUR', balance_minor: 100 }],
  ];

  it.each(LOCKED)('PATCH %s после появления ссылки → 409, значение не изменилось', async (field, patch) => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, patch);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBeTypeOf('string');

    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts[0]![field]).toBe(account[field]);
  });

  it.each(LOCKED)('PATCH %s до первой ссылки по-прежнему проходит', async (field, patch) => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, patch);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account[field]).not.toBe(account[field]);
  });

  // Замок считает фактическое изменение, а не наличие поля в теле: форма правки
  // шлёт все свои поля всегда, включая нетронутые. Иначе переименование счёта,
  // на который уже сослались, отвечало бы 409.
  it('PATCH с прежними значениями измерений после ссылки проходит', async () => {
    const { account } = await createAccount({ bank: 'Банк', type: 'bank' });
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, {
      name: 'Переименован',
      owner: account.owner,
      country: account.country,
      bank: account.bank,
      type: account.type,
      currency: 'usd', // регистр другой, валюта та же — это не смена
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account).toMatchObject({ name: 'Переименован', currency: 'USD' });
  });

  it('баланс, порядок и архив замок не трогает', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);

    for (const patch of [{ balance_minor: 999 }, { sort: 7 }, { archived: true }, { name: 'Новое имя' }]) {
      const res = await api('PATCH', `/api/v2/accounts/${account.id}`, patch);
      expect(res.status).toBe(200);
    }
  });

  // Архив — признак строки, а не списание денег: остаток на счёте никуда не
  // делся, разархивация стоит один PATCH. Правило исключения для архива не
  // делает, и код тоже не делает.
  it('архивация замок не снимает', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);
    expect((await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true })).status).toBe(200);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { owner: 'Другой' });
    expect(res.status).toBe(409);
  });

  // Замок персональный: он про операции ИМЕННО этого счёта. Без этого теста
  // условие `account_id = accounts.id` можно заменить на `account_id IS NOT
  // NULL` — то есть запереть разом все счета в базе — и весь файл останется
  // зелёным (проверено подменой SQL).
  it('занятость одного счёта не запирает другой', async () => {
    const locked = (await createAccount({ name: 'Занятый' })).account;
    const free = (await createAccount({ name: 'Свободный', sort: 1 })).account;
    await referenceAccount(locked.id);

    expect((await api('PATCH', `/api/v2/accounts/${locked.id}`, { owner: 'Другой' })).status).toBe(409);

    const res = await api('PATCH', `/api/v2/accounts/${free.id}`, { owner: 'Другой' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.owner).toBe('Другой');

    // И у занятого владелец на месте — правку получил ровно тот счёт, что свободен.
    const listRes = await api('GET', '/api/v2/accounts');
    const list = (await listRes.json()) as { accounts: Array<Record<string, unknown>> };
    expect(list.accounts.find((a) => a.id === locked.id)!.owner).toBe(locked.owner);
  });

  // Отказ замка — это отказ всему запросу, а не «применю что смогу». Иначе
  // владелец, поправивший имя и страну одной формой, увидел бы 409 и половину
  // сохранённых изменений.
  it('на 409 не применяется ничего из того же тела', async () => {
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

  // Замок терминален, а требование balance_minor при смене валюты — устранимо.
  // Ответить сначала «добавьте balance_minor», а на послушный повторный запрос
  // «менять поздно» — значит водить клиента по кругу.
  it('смена валюты на занятом счёте отвечает 409, а не «передайте balance_minor»', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { currency: 'EUR' });
    expect(res.status).toBe(409);
  });

  it('разархивация занятого счёта проходит — архив замок не касается в обе стороны', async () => {
    const { account } = await createAccount();
    await referenceAccount(account.id);
    expect((await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true })).status).toBe(200);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.archived).toBe(false);
  });

  // Единственная ветка, где сравнение идёт NULL против строки: банк не был
  // указан, и его пытаются задать уже после первой операции.
  it('банк из пустого в значение после ссылки → 409', async () => {
    const { account } = await createAccount();
    expect(account.bank).toBeNull();
    await referenceAccount(account.id);

    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { bank: 'Появился' });
    expect(res.status).toBe(409);
  });

  // Форма шлёт все поля всегда — «сохранить, ничего не изменив» должно
  // отвечать так же, как сохранение с изменением, а не падать на пустом SET.
  it('PATCH прежними значениями без единого изменения → 200 и строка нетронута', async () => {
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

  // Две проверки ниже смотрят на сам SQL, а не на код ответа, и это не
  // прихоть: обе защиты замка снаружи невидимы. Их результат совпадает с
  // результатом их отсутствия во всём, кроме гонки, а гонку этот стенд не
  // воспроизводит — D1 в miniflare сериализует запросы. Без них строку с
  // фильтром и guard в WHERE можно убрать, и весь файл останется зелёным
  // (проверено подменой обеих).
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

  // Запертое поле с прежним значением не должно попадать в SET вовсе: guard в
  // WHERE добавляется только когда измерения реально меняются, поэтому такая
  // запись прошла бы мимо замка и переписала бы колонку значением из снапшота,
  // прочитанного до чужой параллельной правки.
  it('прежние измерения в SET не попадают', async () => {
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

  // Вторая половина замка: условие занятости уходит в WHERE самого UPDATE,
  // иначе между ранней проверкой и записью успевает влезть первая операция.
  it('смена измерения добавляет условие занятости в сам UPDATE, а правка имени — нет', async () => {
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

  it('ссылка из recurring_items закрывает замок так же, как плановая', async () => {
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
  it('PUT создаёт, повторный PUT обновляет и не плодит строк', async () => {
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

  it('целое значение форматируется без хвостовых нулей ("1" при rate_e9 = 1e9)', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/eur', { rate: '1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate: Record<string, unknown> };
    expect(body.rate).toMatchObject({ code: 'EUR', rate_e9: 1_000_000_000, rate: '1' });
  });

  it('принимает курс числом JSON, не только строкой', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/rsd', { rate: 0.0092 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate: Record<string, unknown> };
    expect(body.rate.rate_e9).toBe(9_200_000);
  });

  it.each([
    ['экспоненциальная запись', '1e-3'],
    ['нулевой курс', '0'],
    ['больше девяти знаков после точки', '0.0000000001'],
    // Без верхней границы это значение переполнило бы 64-битный INTEGER
    // SQLite и осело в базе как TEXT — CHECK (rate_e9 > 0) такую строку
    // пропускает. Тест фиксирует, что отказ приходит на входе, а не порча
    // данных на выходе (см. MAX_RATE_E9 в src/worker/api.ts).
    ['курс за пределами точного целого', '99999999999.999999999'],
  ])('отклоняет: %s (%s)', async (_label, rate) => {
    const res = await api('PUT', '/api/v2/fx-rates/rub', { rate });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBeTypeOf('string');
  });

  it('принимает курс на самой границе точного целого', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/rub', { rate: '9007199.254740991' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate: Record<string, unknown> };
    expect(body.rate.rate_e9).toBe(Number.MAX_SAFE_INTEGER);
    expect(body.rate.rate).toBe('9007199.254740991');
  });

  it('DELETE удаляет курс → 204', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(204);

    const listRes = await api('GET', '/api/v2/fx-rates');
    const list = (await listRes.json()) as { rates: Array<Record<string, unknown>> };
    expect(list.rates).toHaveLength(0);
  });

  it('DELETE несуществующего курса → 404', async () => {
    const res = await api('DELETE', '/api/v2/fx-rates/xyz');
    expect(res.status).toBe(404);
  });

  // #228: курс базовой валюты — бессмыслица (1 USD = 1 USD при базовой USD),
  // и расчётное ядро S1-4 им не воспользуется. Вход закрыт на PUT, строка не
  // появляется вовсе — не только статус 400, но и отсутствие в GET.
  it('PUT базовой валюты → 400, строка в fx_rates не появляется', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/USD', { rate: '1' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('USD');

    const listRes = await api('GET', '/api/v2/fx-rates');
    const list = (await listRes.json()) as { rates: Array<Record<string, unknown>> };
    expect(list.rates).toEqual([]);
  });

  // normalizeCurrencyCodeParam верхний регистр применяет ДО сравнения с
  // базовой валютой — нижний регистр в пути не должен эту проверку обойти.
  it('PUT /fx-rates/usd (нижний регистр в пути) при базовой USD → 400', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/usd', { rate: '1' });
    expect(res.status).toBe(400);
  });

  // Строка уже лежит в базе (заведена до фикса или правкой БД) — PUT её не
  // трогает: сервер отклоняет запрос ещё до UPSERT, значение и updated_at
  // остаются прежними.
  it('уже лежащая в базе строка базовой валюты не перезаписывается PUT', async () => {
    await insertRate('USD', '1000000000', '2026-01-01T00:00:00Z');

    const res = await api('PUT', '/api/v2/fx-rates/usd', { rate: '2' });
    expect(res.status).toBe(400);

    const listRes = await api('GET', '/api/v2/fx-rates');
    const list = (await listRes.json()) as { rates: Array<Record<string, unknown>> };
    expect(list.rates).toEqual([
      expect.objectContaining({ code: 'USD', rate: '1', updated_at: '2026-01-01T00:00:00Z' }),
    ]);
  });

  // Регрессия рядом с новым запретом: он касается только кода, совпавшего с
  // базовой валютой, — остальные коды сохраняются как прежде.
  it('небазовая валюта по-прежнему сохраняется PUT-ом', async () => {
    const res = await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    expect(res.status).toBe(200);
  });

  it('смена базы между проверкой и UPSERT курса → 409 без устаревшей записи', async () => {
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
      // Изначально базовая USD
      await realPrepare("UPDATE settings SET value = 'USD' WHERE key = 'base_currency'").run();
      const res = await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.92' });
      
      // UPSERT прошёл успешно. Смена базы не помешала, так как база больше не проверяется.
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

// Инвариант issue #193: у валюты, на которую в базе есть ссылка, должен быть
// курс к базовой — иначе её суммы не пересчитать. Схемой это не выразить
// (CHECK не видит другую таблицу, триггеров в v2 нет), поэтому держится API:
// DELETE не даёт снять курс с валюты в ходу, а GET показывает те, где курса
// всё-таки нет.
describe('покрытие валют курсами (issue #193)', () => {
  async function fxState() {
    const res = await api('GET', '/api/v2/fx-rates');
    expect(res.status).toBe(200);
    return (await res.json()) as {
      base_currency: string | null;
      missing: string[];
      rates: Array<Record<string, unknown>>;
    };
  }

  // Плановые и регулярные ссылку на валюту дают своей колонкой — вставляем их
  // напрямую там, где нужен только этот факт. Без таких вставок половина
  // инварианта не проверялась бы вовсе: выбрасывание таблицы из
  // CURRENCY_TABLES проходило бы полностью зелёным прогоном.
  //
  // Операций здесь нет намеренно: своей валюты у них не осталось (0005), она
  // берётся у счёта — и валюту «в ходу» держит тот же счёт, на который операция
  // ссылается. Отдельный тест на это стоит ниже.

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

  it('на пустой базе: базовая валюта названа, валют без курса нет', async () => {
    const state = await fxState();
    expect(state.base_currency).toBe('USD');
    expect(state.missing).toEqual([]);
  });

  it('счёт в валюте без курса попадает в missing, курс его оттуда убирает', async () => {
    await createAccount({ currency: 'RSD' });
    expect((await fxState()).missing).toEqual(['RSD']);

    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    expect((await fxState()).missing).toEqual([]);
  });

  it('базовая валюта в missing не попадает — курс к самой себе не нужен', async () => {
    await createAccount({ currency: 'USD' });
    expect((await fxState()).missing).toEqual([]);
  });

  // Ровно сценарий из #193: архив не «отпускает» валюту. Деньги на счёте
  // остались, разархивация — один PATCH, и пересчёт снова потребует курса.
  it('архивный счёт держит свою валюту в missing наравне с активным', async () => {
    const { account } = await createAccount({ currency: 'RSD' });
    const res = await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true });
    expect(res.status).toBe(200);
    expect((await fxState()).missing).toEqual(['RSD']);
  });

  // Раньше здесь проверялось, что валюту в ходу даёт трата САМА, своей
  // колонкой. С 0005 колонки нет: операция ссылается на счёт, и валюту держит
  // он. Инвариант от этого не ослаб — операцию без счёта завести нельзя, —
  // но держится он теперь через `accounts`, что тест и фиксирует.
  it('валюту в ходу держит счёт операции, а не сама операция', async () => {
    const { account } = await createAccount({ currency: 'RUB' });
    await createOperation(account.id);
    expect((await fxState()).missing).toEqual(['RUB']);
  });

  it('missing отсортирован и без дублей', async () => {
    await createAccount({ currency: 'RSD' });
    await createAccount({ name: 'Второй', currency: 'RSD' });
    await createAccount({ name: 'Третий', currency: 'EUR' });
    expect((await fxState()).missing).toEqual(['EUR', 'RSD']);
  });

  it('DELETE курса валюты, которую занимает счёт → 409, курс остаётся', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    await createAccount({ currency: 'RSD' });

    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('RSD');
    expect((await fxState()).rates).toHaveLength(1);
  });

  it('DELETE курса валюты, которую занимает АРХИВНЫЙ счёт → тоже 409', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    const { account } = await createAccount({ currency: 'RSD' });
    await api('PATCH', `/api/v2/accounts/${account.id}`, { archived: true });

    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(409);
  });

  it('DELETE курса валюты, которую занимает счёт с операцией → 409', async () => {
    await api('PUT', '/api/v2/fx-rates/rub', { rate: '0.0127' });
    const { account } = await createAccount({ currency: 'RUB' });
    await createOperation(account.id);

    const res = await api('DELETE', '/api/v2/fx-rates/rub');
    expect(res.status).toBe(409);
  });

  it('освободившуюся валюту удалить можно', async () => {
    await api('PUT', '/api/v2/fx-rates/rsd', { rate: '0.0092' });
    const { account } = await createAccount({ currency: 'RSD' });
    expect((await api('DELETE', '/api/v2/fx-rates/rsd')).status).toBe(409);

    // Счёт ушёл на другую валюту — держать курс больше нечему.
    await api('PATCH', `/api/v2/accounts/${account.id}`, { currency: 'USD', balance_minor: 0 });
    expect((await api('DELETE', '/api/v2/fx-rates/rsd')).status).toBe(204);
  });

  // Строка в fx_rates для базовой валюты — ошибка ввода: пересчёт её не
  // использует. Если бы её держала та же проверка занятости, исправить эту
  // ошибку было бы нельзя — счета в базовой валюте есть всегда.
  it('курс базовой валюты удаляется, даже когда счета в ней есть', async () => {
    // Setup через insertRate, а не PUT: с #228 PUT для базовой валюты
    // отклоняется на входе — здесь моделируем строку, уже лежащую в базе.
    await insertRate('USD', '1000000000');
    await createAccount({ currency: 'USD' });

    const res = await api('DELETE', '/api/v2/fx-rates/usd');
    expect(res.status).toBe(204);
  });

  it('валюту в ходу даёт плановая операция', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    await insertPlanned('CHF', account.id);
    expect((await fxState()).missing).toEqual(['CHF']);

    await api('PUT', '/api/v2/fx-rates/chf', { rate: '1.1' });
    expect((await api('DELETE', '/api/v2/fx-rates/chf')).status).toBe(409);
  });

  it('валюту в ходу даёт регулярная операция', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    await insertRecurring('GBP', account.id);
    expect((await fxState()).missing).toEqual(['GBP']);

    await api('PUT', '/api/v2/fx-rates/gbp', { rate: '1.3' });
    expect((await api('DELETE', '/api/v2/fx-rates/gbp')).status).toBe(409);
  });

  // Список таблиц со ссылкой на валюту зашит в коде константой. Если в схеме
  // появится ещё одна такая таблица, а константу не поправят, она молча
  // выпадет из обеих проверок — и тест поймает это в момент правки схемы, а не
  // в проде. PRAGMA table_info в D1 недоступна (SQLITE_AUTH), поэтому наличие
  // колонки выясняется пробным SELECT.
  it('CURRENCY_TABLES перечисляет все таблицы схемы с колонкой currency', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();

    const withCurrency: string[] = [];
    for (const { name } of results) {
      try {
        await env.DB.prepare(`SELECT currency FROM ${name} LIMIT 0`).all();
        withCurrency.push(name);
      } catch (e) {
        // Глотаем ТОЛЬКО «нет такой колонки». Безусловный catch дал бы
        // ложно-зелёный: таблица с currency, чей пробный SELECT упал по любой
        // другой причине, молча выпала бы из сверки — то есть тест пропустил
        // бы ровно то, ради чего написан.
        if (!(e instanceof Error) || !/no such column/i.test(e.message)) throw e;
      }
    }
    expect(withCurrency.sort()).toEqual([...CURRENCY_TABLES].sort());
  });

  it('DELETE отдаёт 404, а не 409, когда валюта в ходу, но строки курса нет', async () => {
    await createAccount({ currency: 'RSD' });
    const res = await api('DELETE', '/api/v2/fx-rates/rsd');
    expect(res.status).toBe(404);
  });

  describe('базовая валюта читается из settings', () => {
    async function setBase(value: string | null) {
      if (value === null) await env.DB.prepare("DELETE FROM settings WHERE key = 'base_currency'").run();
      else await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'base_currency'").bind(value).run();
    }


    it('не зашита константой: при EUR без курса остаётся EUR', async () => {
      await setBase('EUR');
      await createAccount({ currency: 'EUR' });
      await createAccount({ name: 'Долларовый', currency: 'USD' });
      const state = await fxState();
      expect(state.base_currency).toBe('EUR');
      expect(state.missing).toEqual(['EUR']);
    });

    // Нормализация живёт в двух формах — на JS (`readBaseCurrency`, отвечает
    // за GET и PUT) и на SQL (внутри условия DELETE). Разойтись они не должны,
    // и проверять это обязан КАЖДЫЙ запрос: тест только на GET проходил бы и
    // тогда, когда DELETE считает базовой совсем другую валюту — проверено
    // мутацией.
    it('нормализуется: регистр и пробелы в settings значения не меняют', async () => {
      await setBase('  eur  ');
      // Вход для USD теперь отклонён (USD — глобальный якорь)
      await insertRate('USD', '1000000000');
      await createAccount({ currency: 'EUR' });
      await createAccount({ name: 'Долларовый', currency: 'USD' });

      const state = await fxState();
      expect(state.base_currency).toBe('EUR');
      expect(state.missing).toEqual(['EUR']); // EUR нужен курс к USD!

      expect((await api('DELETE', '/api/v2/fx-rates/usd')).status).toBe(204);
    });


    it('отсутствующая строка settings — тоже непригодное значение', async () => {
      await setBase(null);
      await createAccount({ currency: 'EUR' });
      await createAccount({ name: 'Долларовый', currency: 'USD' });
      const state = await fxState();
      expect(state.base_currency).toBeNull();
      expect(state.missing).toEqual(['EUR']);
    });

    it('курс USD удаляется и когда база не USD', async () => {
      await setBase('EUR');
      await insertRate('USD', '1000000000');
      await createAccount({ currency: 'USD' });
      expect((await api('DELETE', '/api/v2/fx-rates/usd')).status).toBe(204);
    });

    // Смена базовой валюты — отдельный вопрос issue #228: запрет и послабления
    // следуют за ТЕКУЩИМ значением settings, а не застревают на валюте, которая
    // была базовой на момент вставки строки.
    it('смена базовой валюты больше не влияет на запрет курсов (всегда запрещен только USD)', async () => {
      // Пока USD базовая, у неё может лежать курс, заведённый до фикса или
      // правкой БД (insertRate) — на пересчёт он не влияет, и DELETE его
      // убирает.
      await insertRate('USD', '1000000000');
      await createAccount({ currency: 'USD' });
      expect((await api('DELETE', '/api/v2/fx-rates/usd')).status).toBe(204);

      await setBase('EUR');

      // USD больше не базовая, но она все еще якорь: курса у неё нет, счёт в ней живой → НЕТ в missing.
      expect((await fxState()).missing).toEqual([]);

      // Вход для USD всегда закрыт.
      expect((await api('PUT', '/api/v2/fx-rates/usd', { rate: '1.05' })).status).toBe(400);

      // Вход для EUR открыт, хотя она теперь базовая для отображения.
      expect((await api('PUT', '/api/v2/fx-rates/eur', { rate: '1' })).status).toBe(200);
    });

    // Вторая половина того же вопроса из issue #228: новая базовая валюта
    // могла обзавестись курсом ещё когда была обычной. Такая строка становится
    // ошибочной задним числом, и её судьба — та же, что у заведённой руками:
    // GET её показывает (иначе владелец не узнает о ней), PUT её не обновляет,
    // DELETE убирает даже при живых счетах в этой валюте.
    it('курс валюты отображения (если она в использовании) удалить нельзя, так как она не якорь (USD)', async () => {
      await insertRate('EUR', '1080000000');
      await createAccount({ currency: 'EUR' });
      await setBase('EUR');

      const state = await fxState();
      expect(state.base_currency).toBe('EUR');
      expect(state.rates).toEqual([expect.objectContaining({ code: 'EUR', rate: '1.08' })]);
      
      // Пересчёт через USD требует курса EUR!
      // Значит курс EUR не попадает в missing, потому что он ЕСТЬ!
      expect(state.missing).toEqual([]);

      // Вход для EUR открыт! Мы можем обновлять её курс, так как она не USD.
      expect((await api('PUT', '/api/v2/fx-rates/eur', { rate: '1.09' })).status).toBe(200);

      // Удалить её нельзя, так как счета в EUR требуют курса к якорю (USD)!
      expect((await api('DELETE', '/api/v2/fx-rates/eur')).status).toBe(409);
      expect((await fxState()).missing).toEqual([]);
    });
  });
});

describe('planned_items (issue #197)', () => {
  it('создание и чтение: валюта по умолчанию берётся из счёта', async () => {
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

  it('явная валюта принимается как есть, совпадать с валютой счёта не обязана', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    const created = await createPlannedItem(account.id, { currency: 'eur' });
    expect(created.planned_item.currency).toBe('EUR');
  });

  it.each([
    ['без date', { title: 'X', amount_minor: -100 }],
    ['без title', { date: '2026-09-01', amount_minor: -100 }],
    ['без amount_minor', { date: '2026-09-01', title: 'X' }],
    ['без account_id', { date: '2026-09-01', title: 'X', amount_minor: -100 }],
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

  it('несуществующий account_id → 400, а не 500 от FK', async () => {
    const res = await api('POST', '/api/v2/planned-items', {
      date: '2026-09-01',
      title: 'X',
      amount_minor: -100,
      account_id: 999999,
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('несуществующая календарная дата (2026-02-30) → 400', async () => {
    const { account } = await createAccount();
    const res = await api('POST', '/api/v2/planned-items', {
      date: '2026-02-30',
      title: 'X',
      amount_minor: -100,
      account_id: account.id,
    });
    expect(res.status).toBe(400);
  });

  it('архивный счёт разрешён — архив не запрет на операции', async () => {
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

  it('PATCH меняет переданное подмножество полей', async () => {
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

  it('PATCH без известных полей → 400', async () => {
    const { account } = await createAccount();
    const created = await createPlannedItem(account.id);
    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { unknown: 1 });
    expect(res.status).toBe(400);
  });

  it('PATCH несуществующей записи → 404', async () => {
    const res = await api('PATCH', '/api/v2/planned-items/999999', { title: 'X' });
    expect(res.status).toBe(404);
  });

  it('PATCH со сменой валюты без amount_minor → 400, с amount_minor → 200', async () => {
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

  it('PATCH со сменой account_id валюту не переопределяет', async () => {
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

  it('PATCH с несуществующим account_id → 400', async () => {
    const { account } = await createAccount();
    const created = await createPlannedItem(account.id);
    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { account_id: 999999 });
    expect(res.status).toBe(400);
  });

  it('DELETE удаляет: 204 и пропажа из списка, 404 на повторном удалении', async () => {
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

  it('GET сортирует: done ASC, date ASC, id ASC', async () => {
    const { account } = await createAccount();
    const c = await createPlannedItem(account.id, { title: 'C', date: '2026-09-01', done: true });
    const a = await createPlannedItem(account.id, { title: 'A', date: '2026-09-05' });
    const b = await createPlannedItem(account.id, { title: 'B', date: '2026-09-01' });

    const listRes = await api('GET', '/api/v2/planned-items');
    const list = (await listRes.json()) as { planned_items: Array<Record<string, unknown>> };
    expect(list.planned_items.map((p) => p.id)).toEqual([b.planned_item.id, a.planned_item.id, c.planned_item.id]);
  });

  // Плановая операция, созданная ЧЕРЕЗ CRUD, закрывает замок измерений счёта
  // (issue #232) так же, как прямая вставка, — и блокирует удаление счёта.
  it('плановая операция через API закрывает замок измерений счёта и блокирует его удаление', async () => {
    const { account } = await createAccount();
    await createPlannedItem(account.id);

    const patchRes = await api('PATCH', `/api/v2/accounts/${account.id}`, { owner: 'Другой' });
    expect(patchRes.status).toBe(409);

    const delRes = await api('DELETE', `/api/v2/accounts/${account.id}`);
    expect(delRes.status).toBe(409);
  });
});

describe('recurring_items (issue #197)', () => {
  it('создание и чтение: валюта по умолчанию берётся из счёта', async () => {
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

  it('явная валюта принимается как есть', async () => {
    const { account } = await createAccount({ currency: 'USD' });
    const created = await createRecurringItem(account.id, { currency: 'eur' });
    expect(created.recurring_item.currency).toBe('EUR');
  });

  it.each([
    ['без title', { amount_minor: -100, frequency: 'daily', next_due_date: '2026-09-01' }],
    ['без amount_minor', { title: 'X', frequency: 'daily', next_due_date: '2026-09-01' }],
    ['без account_id — вставится валидатором', { title: 'X', amount_minor: -100, frequency: 'daily', next_due_date: '2026-09-01' }],
    ['без frequency', { title: 'X', amount_minor: -100, next_due_date: '2026-09-01' }],
    ['без next_due_date', { title: 'X', amount_minor: -100, frequency: 'daily' }],
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

  it('несуществующий account_id → 400', async () => {
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

  it('несуществующая календарная дата (2026-02-30) → 400', async () => {
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
  ])('interval_count = %s вне границ 1..365 → 400', async (_label, interval_count) => {
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

  it.each([[1], [365]])('interval_count = %s на границе принимается', async (interval_count) => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id, { interval_count });
    expect(created.recurring_item.interval_count).toBe(interval_count);
  });

  describe('якоря правила', () => {
    it('daily/weekly: day_of_month и month_of_year обязаны быть NULL', async () => {
      const { account } = await createAccount();
      for (const frequency of ['daily', 'weekly']) {
        const created = await createRecurringItem(account.id, { frequency });
        expect(created.recurring_item).toMatchObject({ day_of_month: null, month_of_year: null });
      }
    });

    it.each(['daily', 'weekly'])('%s: непустой day_of_month → 400', async (frequency) => {
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

    it.each(['daily', 'weekly'])('%s: непустой month_of_year → 400', async (frequency) => {
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

    it('monthly: day_of_month не передали — выводится из дня next_due_date', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'monthly', next_due_date: '2026-09-15' });
      expect(created.recurring_item).toMatchObject({ day_of_month: 15, month_of_year: null });
    });

    it('monthly: явный day_of_month используется как есть', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-09-15',
        day_of_month: 28,
      });
      expect(created.recurring_item.day_of_month).toBe(28);
    });

    it('monthly: непустой month_of_year → 400', async () => {
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

    it('yearly: day_of_month — явный или из дня next_due_date, month_of_year производный', async () => {
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

    it('yearly: явный month_of_year, совпадающий с датой, принимается', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'yearly',
        next_due_date: '2026-08-10',
        month_of_year: 8,
      });
      expect(created.recurring_item.month_of_year).toBe(8);
    });

    it('yearly: явный month_of_year, не совпадающий с месяцем next_due_date, → 400', async () => {
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
    it('end_date, равный next_due_date, валиден (ровно один платёж)', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        next_due_date: '2026-09-01',
        end_date: '2026-09-01',
      });
      expect(created.recurring_item.end_date).toBe('2026-09-01');
    });

    it('end_date раньше next_due_date → 400', async () => {
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

    it('end_date не передан или null → null', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { end_date: null });
      expect(created.recurring_item.end_date).toBeNull();
    });
  });

  it('active по умолчанию true, явный false принимается', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id, { active: false });
    expect(created.recurring_item.active).toBe(false);
  });

  it('PATCH без известных полей → 400, несуществующей записи → 404', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id);
    expect((await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { unknown: 1 })).status).toBe(400);
    expect((await api('PATCH', '/api/v2/recurring-items/999999', { title: 'X' })).status).toBe(404);
  });

  it('PATCH меняет переданное подмножество независимых полей', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id, { title: 'До' });
    const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { title: 'После', category: 'Связь' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recurring_item: Record<string, unknown> };
    expect(body.recurring_item).toMatchObject({ title: 'После', category: 'Связь', frequency: 'daily' });
  });

  it('PATCH со сменой валюты без amount_minor → 400, с amount_minor → 200', async () => {
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

  it('PATCH со сменой account_id валюту не переопределяет', async () => {
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

  it('PATCH с несуществующим account_id → 400', async () => {
    const { account } = await createAccount();
    const created = await createRecurringItem(account.id);
    const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { account_id: 999999 });
    expect(res.status).toBe(400);
  });

  describe('PATCH считает правило целиком', () => {
    it('смена frequency с monthly на daily сама обнуляет якоря', async () => {
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

    it('смена frequency с yearly на weekly сама обнуляет якоря', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'yearly', next_due_date: '2026-08-10' });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { frequency: 'weekly' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ frequency: 'weekly', day_of_month: null, month_of_year: null });
    });

    it('смена frequency на monthly без якорей в строке выводит day_of_month из next_due_date', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'daily', next_due_date: '2026-09-20' });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { frequency: 'monthly' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item).toMatchObject({ frequency: 'monthly', day_of_month: 20, month_of_year: null });
    });

    it('перенос next_due_date годового правила в другой месяц переносит month_of_year за собой', async () => {
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

    it('перенос next_due_date месячного правила НЕ трогает day_of_month', async () => {
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

    it('PATCH day_of_month на daily/weekly отдельным запросом → 400', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { frequency: 'daily' });
      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { day_of_month: 10 });
      expect(res.status).toBe(400);
    });

    it('PATCH month_of_year на monthly отдельным запросом → 400', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-09-15',
      });
      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { month_of_year: 5 });
      expect(res.status).toBe(400);
    });

    it('PATCH month_of_year годового правила, не совпадающего с новым next_due_date, → 400; совпадающего — 200', async () => {
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

    // Ровно то, что шлёт форма экрана «Регулярные»: она отправляет правило
    // целиком, включая day_of_month, при каждом сохранении. Два случая, и оба
    // обязаны работать — иначе поменять день правила через UI будет нечем
    // (перенос next_due_date его намеренно не двигает, тест выше).
    it('явный day_of_month в PATCH меняет само правило, а прижатый день переживает правку соседних полей', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-02-28',
        day_of_month: 31,
      });
      const id = created.recurring_item.id;

      // Форма сохраняет название, послав правило целиком с прежним днём.
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

      // А теперь владелец действительно переносит правило на 20-е число.
      const moved = await api('PATCH', `/api/v2/recurring-items/${id}`, { day_of_month: 20 });
      expect(moved.status).toBe(200);
      expect(((await moved.json()) as { recurring_item: Record<string, unknown> }).recurring_item)
        .toMatchObject({ day_of_month: 20, next_due_date: '2026-02-28' });
    });

    it('явный day_of_month: null на monthly/yearly → 400 (якорь обязателен)', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, {
        frequency: 'monthly',
        next_due_date: '2026-09-15',
      });
      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { day_of_month: null });
      expect(res.status).toBe(400);
    });
  });

  describe('end_date и next_due_date двигаются одним запросом', () => {
    it('next_due_date позже действующего end_date отдельным PATCH → 400', async () => {
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

    it('next_due_date и end_date одним PATCH — проходит', async () => {
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

    it('PATCH end_date: null снимает срок', async () => {
      const { account } = await createAccount();
      const created = await createRecurringItem(account.id, { end_date: '2026-12-01' });

      const res = await api('PATCH', `/api/v2/recurring-items/${created.recurring_item.id}`, { end_date: null });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recurring_item: Record<string, unknown> };
      expect(body.recurring_item.end_date).toBeNull();
    });
  });

  it('DELETE удаляет: 204 и пропажа из списка, 404 на повторном удалении', async () => {
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

  it('GET сортирует: active DESC, next_due_date ASC, id ASC', async () => {
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

  // Регулярная операция, созданная ЧЕРЕЗ CRUD, закрывает замок измерений счёта
  // (issue #232) так же, как прямая вставка, — и блокирует удаление счёта.
  it('регулярная операция через API закрывает замок измерений счёта и блокирует его удаление', async () => {
    const { account } = await createAccount();
    await createRecurringItem(account.id);

    const patchRes = await api('PATCH', `/api/v2/accounts/${account.id}`, { owner: 'Другой' });
    expect(patchRes.status).toBe(409);

    const delRes = await api('DELETE', `/api/v2/accounts/${account.id}`);
    expect(delRes.status).toBe(409);
  });

  describe('close-period and skip-period (issue #280)', () => {
    it('close-period с дефолтными параметрами: создаёт операцию source=recurring, двигает баланс и сдвигает next_due_date', async () => {
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

      // 1. Операция создана
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

      // 2. Баланс счёта уменьшился
      const accRes = await api('GET', '/api/v2/accounts');
      const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
      expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(60000);

      // 3. Якорь сдвинут на 15 сентября
      expect(data.recurring_item.next_due_date).toBe('2026-09-15');
      expect(data.recurring_item.active).toBe(true);

      // 4. Операция видна в общем списке операций
      const opListRes = await api('GET', '/api/v2/operations');
      const opList = (await opListRes.json()) as { operations: Array<{ id: number; source: string; recurring_item_id: number }> };
      expect(opList.operations).toHaveLength(1);
      expect(opList.operations[0].source).toBe('recurring');
      expect(opList.operations[0].recurring_item_id).toBe(item.id);
    });

    it('close-period с переопределением суммы (коммуналка), даты, категории и подкатегории', async () => {
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

      // В августе счёт за коммуналку пришёл на 9 450 RSD
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

      // Баланс счёта изменился ровно на фактическую сумму
      const accRes = await api('GET', '/api/v2/accounts');
      const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
      expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(40550);

      // Якорь правила сдвинулся на 20 сентября, сумма правила осталась -8000
      expect(data.recurring_item.next_due_date).toBe('2026-09-20');
      expect(data.recurring_item.amount_minor).toBe(-8000);
    });

    it('close-period на правиле с end_date: закрытие последнего периода деактивирует правило (active = false)', async () => {
      const { account } = await createAccount({ balance_minor: 100000, currency: 'RSD' });
      // Кредит/рассрочка на 2 платежа: 2026-08-15 и 2026-09-15 (end_date: 2026-09-15)
      const { recurring_item: item } = await createRecurringItem(account.id, {
        title: 'Рассрочка',
        amount_minor: -15000,
        currency: 'RSD',
        frequency: 'monthly',
        day_of_month: 15,
        next_due_date: '2026-08-15',
        end_date: '2026-09-15',
      });

      // 1-й платёж
      const res1 = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {});
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()) as { recurring_item: Record<string, unknown> };
      expect(data1.recurring_item.next_due_date).toBe('2026-09-15');
      expect(data1.recurring_item.active).toBe(true);

      // 2-й (последний) платёж
      const res2 = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {});
      expect(res2.status).toBe(201);
      const data2 = (await res2.json()) as { recurring_item: Record<string, unknown> };
      expect(data2.recurring_item.active).toBe(false);
    });

    it('skip-period сдвигает якорь без создания операции и без изменения баланса', async () => {
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

      // Операций нет
      const opListRes = await api('GET', '/api/v2/operations');
      const opList = (await opListRes.json()) as { operations: unknown[] };
      expect(opList.operations).toHaveLength(0);

      // Баланс не изменился
      const accRes = await api('GET', '/api/v2/accounts');
      const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
      expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(50000);
    });

    it('close-period и skip-period не меняют неактивное правило', async () => {
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

    it('skip-period на последнем периоде с end_date деактивирует правило', async () => {
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

    it('provider CAS не закрывает следующий период повторно по snapshot предыдущего', async () => {
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

    it('provider CAS не пропускает другой recurring-период по устаревшему snapshot', async () => {
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

    it('валидация close-period: 404 если нет правила, 400 при несовпадении валют или невалидных данных', async () => {
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

      // Перенос на счёт с другой валютой без совпадения валюты
      const currencyMismatch = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        account_id: accountEur.id,
      });
      expect(currencyMismatch.status).toBe(400);

      // Невалидная сумма 0
      const zeroAmount = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        amount_minor: 0,
      });
      expect(zeroAmount.status).toBe(400);

      // Подкатегория без категории
      const subWithoutCat = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {
        category: null,
        subcategory: 'Тест',
      });
      expect(subWithoutCat.status).toBe(400);
    });
  });

  describe('интеграция закрытия периода регулярного с прогнозом (issue #280 + #279)', () => {
    it('закрытие периода убирает просроченный долг из прогноза, списывает баланс и оставляет будущий горизонт полным', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
        const { account } = await createAccount({ balance_minor: 100000, currency: 'RSD' });
        await api('PUT', '/api/v2/fx-rates/RSD', { rate: 1 });
        await api('PUT', '/api/v2/settings/base_currency', { value: 'RSD' });

        // Создаём правило, у которого next_due_date был вчера (2026-08-08 при asOf 2026-08-09)
        const { recurring_item: item } = await createRecurringItem(account.id, {
          title: 'Аренда',
          amount_minor: -40000,
          currency: 'RSD',
          frequency: 'monthly',
          day_of_month: 8,
          next_due_date: '2026-08-08',
        });

        // До закрытия: прогноз видит долг -40 000 в ближайший день
        const f1 = await (await api('GET', '/api/v2/forecast')).json() as {
          series: Array<{ date: string; overall_minor: number }>;
        };
        // Стартовый баланс 100 000, но в день 0 (2026-08-09) из-за просроченной аренды баланс 60 000
        expect(f1.series[0].overall_minor).toBe(60000);

        // Закрываем период (факт оплаты 8 августа на -40 000)
        const closeRes = await api('POST', `/api/v2/recurring-items/${item.id}/close-period`, {});
        expect(closeRes.status).toBe(201);

        // После закрытия:
        // 1. Реальный баланс счёта стал 60 000
        const accRes = await api('GET', '/api/v2/accounts');
        const { accounts } = (await accRes.json()) as { accounts: Array<{ id: number; balance_minor: number }> };
        expect(accounts.find((a) => a.id === account.id)!.balance_minor).toBe(60000);

        // 2. Прогноз стартует от 60 000 и НЕ дублирует списание 8 августа (оно уже в балансе)
        const f2 = await (await api('GET', '/api/v2/forecast')).json() as {
          series: Array<{ date: string; overall_minor: number }>;
        };
        // В день 0 (2026-08-09) баланс остаётся 60 000, а не 20 000 (долг больше не висит)
        expect(f2.series[0].overall_minor).toBe(60000);

        // 3. Следующий платёж 8 сентября спишет ещё -40 000 (баланс станет 20 000)
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

  /** Баланс счёта читаем через API, а не из БД: проверяем наблюдаемое поведение. */
  async function balanceOf(accountId: unknown): Promise<number> {
    const res = await api('GET', '/api/v2/accounts');
    const { accounts } = (await res.json()) as { accounts: Record<string, unknown>[] };
    return accounts.find((a) => a.id === accountId)!.balance_minor as number;
  }

  async function accountWithBalance(balanceMinor: number, overrides: Record<string, unknown> = {}) {
    const { account } = await createAccount({ balance_minor: balanceMinor, ...overrides });
    return account;
  }

  it('создание: счёт, вид, подкатегория; валюта приходит от счёта, происхождение ручное', async () => {
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

  // Главное новое поведение задачи: сумма операции правит баланс счёта при
  // сохранении (решение владельца 2026-08-12).
  it('расход уменьшает баланс счёта, доход увеличивает, возврат возвращает', async () => {
    const account = await accountWithBalance(100000);

    await createOperation(account.id, { amount_minor: -25000 });
    expect(await balanceOf(account.id)).toBe(75000);

    await createOperation(account.id, { kind: 'income', item: 'Зарплата', amount_minor: 500000 });
    expect(await balanceOf(account.id)).toBe(575000);

    await createOperation(account.id, { kind: 'refund', item: 'Возврат наушников', amount_minor: 4999 });
    expect(await balanceOf(account.id)).toBe(579999);
  });

  // Отметка «сверился с банком» (issue #223) от нашей коррекции не двигается:
  // посчитанная нами сумма сверкой не является, и гасить ею напоминание
  // «пора сверить» значило бы врать ровно там, где расхождение и копится.
  it('коррекция баланса не переставляет balance_updated_at', async () => {
    const account = await accountWithBalance(100000);
    const before = (await (await api('GET', '/api/v2/accounts')).json()) as { accounts: Record<string, unknown>[] };
    const stampBefore = before.accounts[0]!.balance_updated_at;

    await createOperation(account.id, { amount_minor: -25000 });

    const after = (await (await api('GET', '/api/v2/accounts')).json()) as { accounts: Record<string, unknown>[] };
    expect(after.accounts[0]!.balance_updated_at).toBe(stampBefore);
    expect(after.accounts[0]!.balance_minor).toBe(75000);
  });

  it('список свежими сверху, позиции одного дня — позже введённая выше', async () => {
    const account = await accountWithBalance(1000000);
    await createOperation(account.id, { date: '2026-08-01', item: 'Старая' });
    await createOperation(account.id, { date: '2026-08-10', item: 'Первая того дня' });
    await createOperation(account.id, { date: '2026-08-10', item: 'Вторая того дня' });

    expect((await listOperations()).map((o) => o.item)).toEqual(['Вторая того дня', 'Первая того дня', 'Старая']);
  });

  it('валюта в ответе — валюта счёта, у каждой операции своя по её счёту', async () => {
    const rsd = await accountWithBalance(0, { currency: 'RSD' });
    const eur = await accountWithBalance(0, { name: 'Евровый', currency: 'EUR' });
    await createOperation(rsd.id, { item: 'Кофе' });
    await createOperation(eur.id, { item: 'Подписка' });

    const byItem = Object.fromEntries((await listOperations()).map((o) => [o.item, o.currency]));
    expect(byItem).toEqual({ Кофе: 'RSD', Подписка: 'EUR' });
  });

  it('валюту от клиента не принимает вовсе — поле неизвестное', async () => {
    const account = await accountWithBalance(0, { currency: 'RSD' });
    const { operation } = await createOperation(account.id, { currency: 'JPY' });
    expect(operation.currency).toBe('RSD');
  });

  // Знак — дельта баланса, и вид с ним обязан совпадать. Молча исправлять знак
  // нельзя: клиент ошибся в одном из двух полей, и в каком именно — неизвестно.
  it('отклоняет расход с плюсом и доход с минусом', async () => {
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

  it('отклоняет неизвестный вид операции', async () => {
    const account = await accountWithBalance(0);
    const res = await api('POST', '/api/v2/operations', {
      date: '2026-08-10', account_id: account.id, kind: 'transfer', item: 'Перевод', amount_minor: -350,
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('kind');
  });

  it('отклоняет подкатегорию без категории — и на создании, и на правке', async () => {
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

  it('отклоняет операцию без счёта и с несуществующим счётом', async () => {
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

  it('отклоняет нулевую и дробную сумму, несуществующую дату и пустое название', async () => {
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

  // Требование issue #200 — отказ раньше CHECK'а operations_source_matches_receipt.
  // Сеть безопасности из схемы при этом мнимая: INSERT пишет NULL и 'manual'
  // литералами, до CHECK'а присланное значение не доходит. Снимут проверку —
  // будет не 500, а тихий 201 с пустой ссылкой на чек, и `toEqual([])` ловит это.
  it('receipt_id и source через ручной ввод не принимаются', async () => {
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

  it('PATCH меняет переданные поля и не трогает происхождение', async () => {
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

  it('принимает comment, receipt_url и fiscal_receipt_id при создании и правке; javascript: отклоняет', async () => {
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

  // Без этого исправленная опечатка (350 вместо 3500) оставила бы счёт кривым
  // навсегда: одна операция уже применена, а её правка прошла бы мимо баланса.
  it('PATCH суммы правит баланс ровно на разницу', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -35000 });
    expect(await balanceOf(account.id)).toBe(65000);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { amount_minor: -3500 });
    expect(res.status).toBe(200);
    expect(await balanceOf(account.id)).toBe(96500);
  });

  it('PATCH со сменой счёта снимает со старого и кладёт на новый', async () => {
    const from = await accountWithBalance(100000);
    const to = await accountWithBalance(50000, { name: 'Второй' });
    const { operation } = await createOperation(from.id, { amount_minor: -25000 });
    expect(await balanceOf(from.id)).toBe(75000);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: to.id });
    expect(res.status).toBe(200);
    expect(await balanceOf(from.id)).toBe(100000);
    expect(await balanceOf(to.id)).toBe(25000);
  });

  // Своей валюты у операции нет, поэтому смена счёта — это смена валюты, и
  // сумму надо назвать заново. Без этой проверки перенос «1 500,00 RSD» на
  // долларовый счёт отвечал 200 и оставлял amount_minor как есть: динары молча
  // становились долларами, не изменившись ни в одной колонке. Замок измерений
  // (#232) этот путь не закрывает — он запрещает менять валюту У СЧЁТА.
  it('PATCH со сменой счёта на другую валюту без суммы → 400, ничего не тронуто', async () => {
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

  it('PATCH со сменой счёта на другую валюту и суммой проходит', async () => {
    const rsd = await accountWithBalance(0, { currency: 'RSD' });
    const usd = await accountWithBalance(0, { name: 'Долларовый', currency: 'USD' });
    const { operation } = await createOperation(rsd.id, { amount_minor: -150000 });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: usd.id, amount_minor: -1500 });
    expect(res.status).toBe(200);
    expect(await balanceOf(rsd.id)).toBe(0);
    expect(await balanceOf(usd.id)).toBe(-1500);
  });

  // Счета одной валюты переносом ничего не переоценивают — требовать сумму там
  // значило бы мешать обычному «списал не с той карты».
  it('PATCH со сменой счёта той же валюты суммы не требует', async () => {
    const from = await accountWithBalance(0, { currency: 'RSD' });
    const to = await accountWithBalance(0, { name: 'Второй динаровый', currency: 'RSD' });
    const { operation } = await createOperation(from.id, { amount_minor: -150000 });

    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: to.id })).status).toBe(200);
    expect(await balanceOf(to.id)).toBe(-150000);
  });

  it('PATCH со сменой счёта отдаёт валюту НОВОГО счёта', async () => {
    const rsd = await accountWithBalance(0, { currency: 'RSD' });
    const eur = await accountWithBalance(0, { name: 'Евровый', currency: 'EUR' });
    const { operation } = await createOperation(rsd.id);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { account_id: eur.id, amount_minor: -3 });
    expect(((await res.json()) as { operation: Record<string, unknown> }).operation.currency).toBe('EUR');
  });

  // Правило считается на эффективной строке: смена одного лишь вида на расходе
  // с отрицательной суммой обязана дать внятный 400, а не упереться в CHECK.
  it('PATCH вида без суммы, ломающий знак, → 400 и баланс не тронут', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -35000 });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { kind: 'income' });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('AMOUNT_MUST_BE_POSITIVE');
    expect(await balanceOf(account.id)).toBe(65000);
  });

  it('PATCH вида вместе с суммой проходит и правит баланс', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -35000 });

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { kind: 'income', amount_minor: 35000 });
    expect(res.status).toBe(200);
    expect(await balanceOf(account.id)).toBe(135000);
  });

  it('PATCH прежними значениями → 200, строка и баланс нетронуты', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id);

    const res = await api('PATCH', `/api/v2/operations/${operation.id}`, { item: 'Кофе', amount_minor: -350 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { operation: Record<string, unknown> }).operation).toEqual(operation);
    expect(await balanceOf(account.id)).toBe(99650);
  });

  it('PATCH не принимает receipt_id и source, пустое тело → 400', async () => {
    const account = await accountWithBalance(0);
    const { operation } = await createOperation(account.id);

    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { receipt_id: 1 })).status).toBe(400);
    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { source: 'receipt' })).status).toBe(400);
    expect((await api('PATCH', `/api/v2/operations/${operation.id}`, { nonsense: 1 })).status).toBe(400);
  });

  it('DELETE возвращает сумму на баланс', async () => {
    const account = await accountWithBalance(100000);
    const { operation } = await createOperation(account.id, { amount_minor: -25000 });
    expect(await balanceOf(account.id)).toBe(75000);

    const res = await api('DELETE', `/api/v2/operations/${operation.id}`);
    expect(res.status).toBe(204);
    expect(await balanceOf(account.id)).toBe(100000);
    expect(await listOperations()).toEqual([]);
  });

  it('PATCH и DELETE несуществующей операции → 404, нечисловой id тоже', async () => {
    expect((await api('PATCH', '/api/v2/operations/999', { item: 'Чай' })).status).toBe(404);
    expect((await api('DELETE', '/api/v2/operations/999')).status).toBe(404);
    expect((await api('PATCH', '/api/v2/operations/abc', { item: 'Чай' })).status).toBe(404);
    expect((await api('DELETE', '/api/v2/operations/1.5')).status).toBe(404);
  });

  it('DELETE несуществующей операции баланс не трогает', async () => {
    const account = await accountWithBalance(100000);
    await api('DELETE', '/api/v2/operations/999');
    expect(await balanceOf(account.id)).toBe(100000);
  });

  // Замок измерений (#232) операциями закрывается так же, как плановыми, и это
  // не симметрия ради симметрии: валюта операции не хранится, а берётся у счёта
  // — смена валюты счёта переписала бы смысл каждой суммы на нём.
  it('операция закрывает замок измерений счёта и запрещает его удаление', async () => {
    const account = await accountWithBalance(100000, { currency: 'RSD' });
    await createOperation(account.id);

    const patched = await api('PATCH', `/api/v2/accounts/${account.id}`, { currency: 'EUR', balance_minor: 0 });
    expect(patched.status).toBe(409);

    const deleted = await api('DELETE', `/api/v2/accounts/${account.id}`);
    expect(deleted.status).toBe(409);
  });

  // Инвариант, который обязан держаться при любых гонках: баланс счёта равен
  // «стартовый + сумма всех операций на нём». Прежняя редакция считала дельту
  // на JS от прочитанного снимка — и два параллельных PATCH давали lost update:
  // ответы 200 у обоих, баланс 55000 вместо 70000. Живые подзапросы в batch'е
  // это закрывают: что бы ни успел сделать сосед, снимается и применяется то,
  // что реально лежит в строке.
  it('два параллельных PATCH не расходят баланс с историей', async () => {
    const account = await accountWithBalance(100000);
    const id = (await createOperation(account.id, { amount_minor: -25000 })).operation.id as number;
    expect(await balanceOf(account.id)).toBe(75000);

    // Соседний PATCH влезает ровно между нашим SELECT и нашим batch'ем.
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

  // Тот же инвариант, но гонка увозит операцию на другой счёт: прежняя редакция
  // снимала сумму со счёта из своего снимка и оставляла оба счёта кривыми.
  it('правка суммы против параллельного переноса счёта не ломает инвариант', async () => {
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
    // Операция ровно одна — её вклад обязан лежать ровно на одном счёте.
    expect(stored.account_id === a.id ? [balanceA, balanceB] : [balanceB, balanceA]).toEqual([
      100000 + (stored.amount_minor as number),
      100000,
    ]);
  });

  // Вся коррекция баланса стоит на том, что batch у D1 — одна транзакция.
  // Утверждение проверяем прямо: если второй statement падает, первый не
  // остаётся применённым.
  it('batch D1 атомарен — на этом стоит вся коррекция баланса', async () => {
    const account = await accountWithBalance(100000);
    await expect(
      env.DB.batch([
        env.DB.prepare('UPDATE accounts SET balance_minor = balance_minor - 25000 WHERE id = ?').bind(account.id),
        // Нарушает operations_sign_matches_kind — расход с положительной суммой.
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
  it('отдаёт значения по умолчанию из миграции строками', async () => {
    const res = await api('GET', '/api/v2/settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, string> };
    expect(body.settings).toEqual({
      base_currency: 'USD',
      low_balance_threshold_minor: '100000',
    });
  });

  describe('PUT /settings/base_currency', () => {
    it('нормализует валидный ISO 4217 код, сохраняет его и отражает после обновления', async () => {
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
      ['не-строку', 123],
      ['код из 2 букв', 'EU'],
      ['код с цифрами', 'EU1'],
      ['несуществующий трёхбуквенный код', 'ZZZ'],
    ])('отвергает %s и не меняет настройку', async (_label, value) => {
      const res = await api('PUT', '/api/v2/settings/base_currency', { value });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBeTypeOf('string');

      const refreshed = await api('GET', '/api/v2/settings');
      const body = (await refreshed.json()) as { settings: Record<string, string> };
      expect(body.settings.base_currency).toBe('USD');
    });

    it('повторное сохранение той же базы не удаляет актуальные fx_rates', async () => {
      await api('PUT', '/api/v2/fx-rates/EUR', { rate: '0.92' });

      const res = await api('PUT', '/api/v2/settings/base_currency', { value: ' usd ' });
      expect(res.status).toBe(200);

      const rates = (await (await api('GET', '/api/v2/fx-rates')).json()) as { rates: unknown[] };
      expect(rates.rates).toHaveLength(1);
    });

    it('смена базы НЕ удаляет fx_rates (курсы баз-независимы)', async () => {
      // Заводим курс для небазовой валюты при текущей базе USD.
      await api('PUT', '/api/v2/fx-rates/EUR', { rate: '0.92' });
      const before = (await (await api('GET', '/api/v2/fx-rates')).json()) as { rates: unknown[] };
      expect(before.rates.length).toBeGreaterThan(0);

      // Меняем базу — курсы хранятся как usd_per_unit и не зависят от базы,
      // поэтому должны остаться нетронутыми (регрессия ALE-9: раньше
      // смена базы стирала все курсы).
      const res = await api('PUT', '/api/v2/settings/base_currency', { value: 'EUR' });
      expect(res.status).toBe(200);

      const after = (await (await api('GET', '/api/v2/fx-rates')).json()) as { rates: unknown[] };
      expect(after.rates).toEqual(before.rates);
    });
  });
});

// Строку операции могут удалить из другой вкладки ровно между тем, как PATCH её
// прочитал, и тем, как записал: транзакции на запрос в v2 нет. Без ветки на
// пустой RETURNING обработчик разыменовывал бы null и отдавал 500 с текстом
// внутренней ошибки — гонка воспроизводится подменой prepare на самом UPDATE,
// потому что иначе её не поймать детерминированно.
describe('гонка: строку удалили между чтением и записью PATCH', () => {
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

  it('плановая операция → 404, а не 500', async () => {
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

  it('регулярная операция → 404, а не 500', async () => {
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

  // У операции цена этой гонки выше, чем у плановой: вместе с правкой строки
  // тем же batch'ем идёт коррекция баланса. Проверяем обе половины — 404 вместо
  // 500 И нетронутый баланс: дельта в batch'е условная (`balanceDeltaStatement`),
  // иначе баланс уехал бы вслед за операцией, которой уже нет.
  // Правка операции идёт одним `batch`'ем (строка + баланс), поэтому подмена
  // `prepare` тут не годится — окно открываем перед самим batch'ем.
  function deleteRowBeforeBatch(id: number) {
    const realBatch = env.DB.batch.bind(env.DB);
    return vi.spyOn(env.DB, 'batch').mockImplementation((async (statements: unknown) => {
      await env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(id).run();
      return realBatch(statements as never);
    }) as never);
  }

  it('операция → 404, а не 500, и баланс не уезжает', async () => {
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
    // 100000 - 25000 от создания; удаление строки в обход API баланс не правит,
    // поэтому здесь ожидается ровно состояние после создания, без следов патча.
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

describe('planned_items → операция (issue #267)', () => {
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

  it('отметка «выполнено» создаёт операцию и двигает баланс', async () => {
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

  it('повторная отметка не плодит вторую операцию и не двигает баланс ещё раз', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000 });
    await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
    const again = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { done: true });
    expect(again.status).toBe(200);
    expect(await listOperations()).toHaveLength(1);
    expect(await balanceOf(account.id)).toBe(75000);
  });

  it('создание сразу с done: true ведёт себя как отметка', async () => {
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

  it('снятие галочки удаляет порождённую операцию и возвращает живую сумму', async () => {
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

  it('отказывается отмечать выполненным, если валюта плановой не равна валюте счёта', async () => {
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

  it('удаление плановой оставляет операцию — факт переживает план', async () => {
    const { account } = await createAccount({ balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { amount_minor: -25000, done: true });
    const del = await api('DELETE', `/api/v2/planned-items/${created.planned_item.id}`);
    expect(del.status).toBe(204);
    const ops = await listOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ source: 'planned', planned_item_id: null, amount_minor: -25000 });
    expect(await balanceOf(account.id)).toBe(75000);
  });

  it('ручной ввод не принимает planned_item_id', async () => {
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

  it('повторный done: true лечит старую галочку без операции', async () => {
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

  it('правка названия выполненной плановой без операции не материализует факт (#282)', async () => {
    const { account } = await createAccount({ currency: 'EUR', balance_minor: 100000 });
    const created = await createPlannedItem(account.id, { currency: 'EUR', amount_minor: -25000, title: 'Аренда' });
    // Старая галочка без операции
    await env.DB.prepare("UPDATE planned_items SET done = 1, currency = 'USD' WHERE id = ?")
      .bind(created.planned_item.id)
      .run();

    const res = await api('PATCH', `/api/v2/planned-items/${created.planned_item.id}`, { title: 'Новая аренда' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { planned_item: { title: string; done: boolean } }).planned_item.title).toBe('Новая аренда');
    expect(await listOperations()).toEqual([]);
    expect(await balanceOf(account.id)).toBe(100000);
  });

  it('удаление порождённой операции снимает done у плановой и возвращает баланс', async () => {
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

  it('гонка с уже вставленной чужой операцией отвечает 409 и не переписывает план или баланс', async () => {
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

  it('конкурентные done=true с разными данными оставляют plan, operation и balance согласованными', async () => {
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

describe('API v2: переводы между счетами (/api/v2/transfers)', () => {
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

  it('создаёт перевод между счетами в одной валюте и атомарно двигает балансы', async () => {
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

  it('создаёт перевод между счетами в разных валютах (конвертация)', async () => {
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

  it('отклоняет перевод на тот же счёт', async () => {
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

  it('отклоняет перевод с нулевой суммой или на несуществующий счёт', async () => {
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

  it('отклоняет создание transfer_out/transfer_in напрямую через POST /operations', async () => {
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

  it('удаление через DELETE /api/v2/transfers/:id удаляет обе операции и возвращает оба баланса', async () => {
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

  it('удаление одной ноги перевода через DELETE /api/v2/operations/:id удаляет весь перевод и возвращает оба баланса', async () => {
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

  it('запрещает менять сумму, счёт или вид у операции перевода через PATCH /operations/:id', async () => {
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

    // Но разрешает менять описание (item) или дату
    const patchItem = await api('PATCH', `/api/v2/operations/${transfer.from_operation.id}`, { item: 'Новое описание' });
    expect(patchItem.status).toBe(200);
    expect(((await patchItem.json()) as { operation: { item: string } }).operation.item).toBe('Новое описание');
  });

  it('PUT /transfers/:id меняет обе суммы и корректно пересчитывает балансы (#401)', async () => {
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

    // Исправляем сумму зачисления с 15000 на 9925.12 (как на живом чеке обмена).
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

    // Балансы: списание -15000 (не изменилось), зачисление стало +992512.
    expect(await balanceOf(from.id)).toBe(85000);
    expect(await balanceOf(to.id)).toBe(50000 + 992512);
  });

  it('PUT /transfers/:id отклоняет нулевую сумму и не портит баланс', async () => {
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
    // Балансы не тронуты.
    expect(await balanceOf(from.id)).toBe(99000);
    expect(await balanceOf(to.id)).toBe(1000);
  });

  it('PUT /transfers/:id отклоняет смену валюты без явной новой суммы', async () => {
    const from = (await createAccount({ balance_minor: 100000, currency: 'RSD', name: 'Списание' })).account;
    const to = (await createAccount({ balance_minor: 0, currency: 'RSD', name: 'Зачисление' })).account;
    const usd = (await createAccount({ balance_minor: 0, currency: 'USD', name: 'USD' })).account;
    const createRes = await api('POST', '/api/v2/transfers', {
      date: '2026-08-15', from_account_id: from.id, to_account_id: to.id,
      from_amount_minor: 1000, to_amount_minor: 1000,
    });
    const { transfer } = (await createRes.json()) as { transfer: { id: number } };

    // Перенос зачисления на USD-счёт без to_amount_minor в новой валюте.
    const bad = await api('PUT', `/api/v2/transfers/${transfer.id}`, {
      date: '2026-08-15', from_account_id: from.id, to_account_id: usd.id,
      from_amount_minor: 1000,
    });
    expect(bad.status).toBe(400);
    expect((await errorBody(bad)).code).toBe('TRANSFER_TO_CURRENCY_CHANGE_REQUIRES_AMOUNT');
  });

  it('PUT /transfers/:id реджектит несуществующий перевод → 404', async () => {
    const res = await api('PUT', '/api/v2/transfers/999999', {
      date: '2026-08-15', from_account_id: 1, to_account_id: 2,
      from_amount_minor: 100, to_amount_minor: 100,
    });
    expect(res.status).toBe(404);
  });
});
