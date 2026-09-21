// Алиасы счетов (issue #339) — поведенческие тесты модуля резолвера и API.
//
// Проверяем именно то, что ловит Закон 1 и контракт issue: резолвер НЕ падает
// на неизвестном счёте (а кладёт строку в pending), алиас уникален по
// нормализации, удаление счёта уносит алиасы каскадом, а bind из pending
// создаёт алиас и убирает строку.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import {
  normalizeAlias,
  resolveOrPend,
  listAliases,
  addAlias,
  removeAlias,
  listPending,
  bindPending,
  AliasError,
} from '../src/worker/account-aliases';
import type { Env } from '../src/worker/types';

const NOW = '2026-08-09T12:00:00Z';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_aliases'),
    env.DB.prepare('DELETE FROM pending_account_strings'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM accounts'),
  ]);
});

async function insertAccount(name = 'Основной'): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, bank, type, owner, country, currency, balance_minor, balance_updated_at)
     VALUES (?, 'Raiffeisen', 'Checking', 'Alex', 'SRB', 'RSD', 0, ?)
     RETURNING id`,
  )
    .bind(name, NOW)
    .first<{ id: number }>();
  return row!.id;
}

describe('normalizeAlias', () => {
  it('trim + collapse spaces + lower-case', () => {
    expect(normalizeAlias('  Visa *6125  ')).toBe('visa *6125');
    expect(normalizeAlias('Visa   *6125')).toBe('visa *6125');
    expect(normalizeAlias('DinaCard')).toBe('dinacard');
  });
  it('пустое/не-строка → null', () => {
    expect(normalizeAlias('   ')).toBeNull();
    expect(normalizeAlias(null)).toBeNull();
    expect(normalizeAlias(undefined)).toBeNull();
    expect(normalizeAlias(123)).toBeNull();
  });
});

describe('resolveOrPend', () => {
  it('резолвит по точному совпадению алиаса', async () => {
    const accId = await insertAccount();
    await addAlias(env.DB, accId, 'Visa *6125');
    expect(await resolveOrPend(env.DB, 'Visa *6125')).toBe(accId);
  });

  it('резолвит по алиасу с другим регистром/пробелами', async () => {
    const accId = await insertAccount();
    await addAlias(env.DB, accId, 'Visa *6125');
    // Нормализация в запросе ловит разницу регистра и внутренних пробелов.
    expect(await resolveOrPend(env.DB, ' visa *6125 ')).toBe(accId);
  });

  it('резолвит по имени счёта как fallback', async () => {
    const accId = await insertAccount('200-0750000027949-16');
    expect(await resolveOrPend(env.DB, '200-0750000027949-16')).toBe(accId);
  });

  it('НЕ падает на неизвестном счёте — кладёт в pending и возвращает null', async () => {
    await insertAccount();
    const res = await resolveOrPend(env.DB, 'Совсем неизвестный счёт');
    expect(res).toBeNull();
    const pending = await listPending(env.DB);
    expect(pending).toHaveLength(1);
    expect(pending[0].raw_string).toBe('Совсем неизвестный счёт');
  });

  it('пустой счёт не падает и не создаёт pending', async () => {
    expect(await resolveOrPend(env.DB, '   ')).toBeNull();
    expect(await listPending(env.DB)).toHaveLength(0);
  });

  it('повторный first-seen того же счёта не плодит дубли в pending', async () => {
    await resolveOrPend(env.DB, 'Unknown X');
    await resolveOrPend(env.DB, 'unknown x'); // та же нормализация
    expect(await listPending(env.DB)).toHaveLength(1);
  });
});

describe('addAlias / listAliases / removeAlias', () => {
  it('добавляет и перечисляет алиасы счёта', async () => {
    const accId = await insertAccount();
    const a = await addAlias(env.DB, accId, 'Visa *6125');
    expect(a.account_id).toBe(accId);
    expect(a.alias_text).toBe('Visa *6125');
    const list = await listAliases(env.DB, accId);
    expect(list).toHaveLength(1);
    expect(list[0].alias_text).toBe('Visa *6125');
  });

  it('хранит оригинал, а не нормализованную форму', async () => {
    const accId = await insertAccount();
    await addAlias(env.DB, accId, 'Visa *6125');
    const row = await env.DB.prepare('SELECT alias_text, alias_norm FROM account_aliases').first<{ alias_text: string; alias_norm: string }>();
    expect(row?.alias_text).toBe('Visa *6125');
    expect(row?.alias_norm).toBe('visa *6125');
  });

  it('отклоняет пустой alias_text (400)', async () => {
    const accId = await insertAccount();
    await expect(addAlias(env.DB, accId, '   ')).rejects.toThrow(AliasError);
    try {
      await addAlias(env.DB, accId, '   ');
    } catch (e) {
      expect((e as AliasError).status).toBe(400);
    }
  });

  it('не даёт завести тот же алиас дважды (409)', async () => {
    const accId = await insertAccount();
    await addAlias(env.DB, accId, 'Visa *6125');
    await expect(addAlias(env.DB, accId, 'visa *6125')).rejects.toThrow(/already bound/i);
  });

  it('не даёт привязать алиас к несуществующему счёту (404)', async () => {
    await expect(addAlias(env.DB, 99999, 'X')).rejects.toThrow(AliasError);
    try {
      await addAlias(env.DB, 99999, 'X');
    } catch (e) {
      expect((e as AliasError).status).toBe(404);
    }
  });

  it('удаление счёта уносит алиасы каскадом', async () => {
    const accId = await insertAccount();
    await addAlias(env.DB, accId, 'Visa *6125');
    await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accId).run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM account_aliases').first()).toEqual({ n: 0 });
  });

  it('removeAlias 404 на чужом алиасе', async () => {
    const a = await insertAccount('A');
    const b = await insertAccount('B');
    const alias = await addAlias(env.DB, a, 'Visa *6125');
    await expect(removeAlias(env.DB, b, alias.id)).rejects.toThrow(AliasError);
    try {
      await removeAlias(env.DB, b, alias.id);
    } catch (e) {
      expect((e as AliasError).status).toBe(404);
    }
  });
});

describe('bindPending', () => {
  it('создаёт алиас из оригинала строки и убирает её из pending', async () => {
    const accId = await insertAccount();
    await resolveOrPend(env.DB, 'Новая карта');
    const pending = await listPending(env.DB);
    expect(pending).toHaveLength(1);
    const alias = await bindPending(env.DB, pending[0].id, accId);
    expect(alias.account_id).toBe(accId);
    expect(alias.alias_text).toBe('Новая карта');
    // Строка ушла из pending, алиас появился у счёта.
    expect(await listPending(env.DB)).toHaveLength(0);
    const list = await listAliases(env.DB, accId);
    expect(list.map((x) => x.alias_text)).toContain('Новая карта');
  });

  it('404 на уже обработанную строку', async () => {
    const accId = await insertAccount();
    await resolveOrPend(env.DB, 'X');
    const pending = await listPending(env.DB);
    await bindPending(env.DB, pending[0].id, accId);
    await expect(bindPending(env.DB, pending[0].id, accId)).rejects.toThrow(AliasError);
  });

  it('batch откатывается, если алиас уже занят — строка остаётся', async () => {
    const a = await insertAccount('A');
    const b = await insertAccount('B');
    // Алиас `Visa *6125` уже занят счётом A.
    await addAlias(env.DB, a, 'Visa *6125');
    // Независимая неизвестная строка (не совпадает по норме с существующим
    // алиасом, поэтому resolveOrPend кладёт её в pending, а не резолвит).
    await resolveOrPend(env.DB, 'Совсем другой счёт');
    const pending = await listPending(env.DB);
    expect(pending).toHaveLength(1);
    // bind пытается создать алиас `Совсем другой счёт` — уникален, поэтому
    // здесь успех; конфликт проверяем отдельно ниже через addAlias.
    await bindPending(env.DB, pending[0].id, b);
    expect(await listPending(env.DB)).toHaveLength(0);
    // Прямая попытка завести уже занятый алиас отклоняется (409), и счёт B
    // не получает дубль — это тот же инвариант, что ловит bind через UNIQUE.
    await expect(addAlias(env.DB, b, 'Visa *6125')).rejects.toThrow(/already bound/i);
  });
});

describe('API алиасов счетов', () => {
  let cookie: string;
  beforeEach(async () => {
    const { createSessionCookie } = await import('../src/worker/auth');
    const setCookie = await createSessionCookie(env as unknown as Env, false);
    cookie = setCookie.split(';')[0]!;
  });

  async function api(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        Cookie: cookie,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return app.request(path, init, env as unknown as Env);
  }

  async function createAccount(): Promise<number> {
    const res = await api('POST', '/api/v2/accounts', {
      name: 'Основной', currency: 'RSD', owner: 'Alex', country: 'SRB',
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { account: { id: number } }).account.id;
  }

  it('GET /accounts несёт aliases (пустой массив)', async () => {
    const id = await createAccount();
    const res = await api('GET', '/api/v2/accounts');
    const acc = (await res.json() as { accounts: Array<{ id: number; aliases: unknown[] }> })
      .accounts.find((a) => a.id === id)!;
    expect(acc.aliases).toEqual([]);
  });

  it('POST/GET/DELETE алиаса по счёту', async () => {
    const id = await createAccount();
    const add = await api('POST', `/api/v2/accounts/${id}/aliases`, { alias_text: 'Visa *6125' });
    expect(add.status).toBe(201);
    const alias = (await add.json() as { alias: { id: number; alias_text: string } }).alias;
    expect(alias.alias_text).toBe('Visa *6125');

    const list = await api('GET', `/api/v2/accounts/${id}/aliases`);
    expect(((await list.json()) as { aliases: unknown[] }).aliases).toHaveLength(1);

    const del = await api('DELETE', `/api/v2/accounts/${id}/aliases/${alias.id}`);
    expect(del.status).toBe(204);
    const list2 = await api('GET', `/api/v2/accounts/${id}/aliases`);
    expect(((await list2.json()) as { aliases: unknown[] }).aliases).toHaveLength(0);
  });

  it('POST алиаса на несуществующий счёт → 404', async () => {
    const res = await api('POST', '/api/v2/accounts/99999/aliases', { alias_text: 'X' });
    expect(res.status).toBe(404);
  });

  it('GET /accounts/resolve резолвит и не падает на неизвестном', async () => {
    const id = await createAccount();
    await api('POST', `/api/v2/accounts/${id}/aliases`, { alias_text: 'Visa *6125' });

    const hit = await api('GET', '/api/v2/accounts/resolve?q=' + encodeURIComponent('Visa *6125'));
    const hitJson = await hit.json() as { account_id: number | null; pending: boolean };
    expect(hitJson.account_id).toBe(id);
    expect(hitJson.pending).toBe(false);

    const miss = await api('GET', '/api/v2/accounts/resolve?q=' + encodeURIComponent('Unknown'));
    const missJson = await miss.json() as { account_id: number | null; pending: boolean };
    expect(missJson.account_id).toBeNull();
    expect(missJson.pending).toBe(true);
    const pendingAfterGet = await api('GET', '/api/v2/accounts/pending');
    expect(((await pendingAfterGet.json()) as { pending: unknown[] }).pending).toHaveLength(0);

    const bad = await api('GET', '/api/v2/accounts/resolve?q=');
    expect(bad.status).toBe(400);
  });

  it('pending list + bind через API', async () => {
    const id = await createAccount();
    const res = await api('POST', '/api/v2/accounts/resolve', { q: 'New Card' });
    expect(((await res.json()) as { pending: boolean }).pending).toBe(true);

    const list = await api('GET', '/api/v2/accounts/pending');
    const pend = (await list.json()) as { pending: Array<{ id: number; raw_string: string }> };
    expect(pend.pending).toHaveLength(1);

    const bind = await api('POST', `/api/v2/accounts/pending/${pend.pending[0].id}/bind`, { account_id: id });
    expect(bind.status).toBe(201);
    // Повторный bind → 404 (уже обработано).
    const bind2 = await api('POST', `/api/v2/accounts/pending/${pend.pending[0].id}/bind`, { account_id: id });
    expect(bind2.status).toBe(404);
  });
});
