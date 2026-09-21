// CRUD API v2 (S1-2, issue #196) — счета, курсы валют, чтение настроек.
// Все роуты требуют валидную сессию (verifySessionCookie) и монтируются в
// index.ts как `app.route('/api/v2', apiV2)` — пути здесь без префикса.
import { Hono } from 'hono';
import type { Env } from './types';
import { verifySessionCookie } from './auth';
import { addDays } from './forecast/dates';
import { makeConverter } from './forecast/convert';
import { loadAccounts, loadFlowsAndPayments, loadForecastSettings, loadRates } from './forecast/load';
import { buildForecast } from './forecast/build';
import { nextOccurrence, type RecurringRule } from './forecast/recurrence';
import {
  ISO_4217_CURRENCY_CODES,
  normalizeCurrencyCode,
  normalizeIso4217CurrencyCode,
} from '../shared/currency';
import { buildAnalytics, normalizeAnalyticsFilters, type OperationWithAccount, type RecurringRuleRow } from './analytics';
import { SAFE_MINOR_MAX, SAFE_MINOR_MIN, minorBigIntToNumber } from '../shared/money';
import { parseHttpUrl, RECEIPT_URL_MAX_LENGTH } from '../shared/http-url';
import { FISCAL_RECEIPT_ID_MAX_LENGTH } from '../shared/fiscal-receipts';
import {
  type AliasJson,
  listAliases,
  addAlias,
  removeAlias,
  listPending,
  bindPending,
  resolveOrPend,
  resolveAccount,
  AliasError,
} from './account-aliases';
import mcpApi from './api-mcp';
import passkeysApi from './api-passkeys';
import backupApi from './api-backup';
import dataApi from './api-data';
import { ValidationError, fail, failCaught } from './api-error';
import { browserMutationRejection } from './csrf';
import { ANALYTICS_MAX_JSON_BYTES, BodyTooLargeError, readLimitedJson } from './limited-body';
import {
  expenseLooksLikeDuplicate,
  isAnalyticalSkipOnlyRecurringId,
  type ExpenseDuplicateCandidate,
} from '../shared/booking-guards';

const apiV2 = new Hono<{ Bindings: Env }>();

// Guard — единственное middleware sub-app'а, регистрируется ПЕРВЫМ: Hono
// выполняет middleware и роуты в порядке регистрации, а не «middleware всегда
// раньше» — объявленный после маршрутов `use()` их бы не перехватывал.
apiV2.use('*', async (c, next) => {
  // Внутренние вызовы от MCP сервера внутри Worker'а
  let isInternalMcp = false;
  try {
    isInternalMcp = (c.executionCtx as any)?.isInternalMcp === true;
  } catch {}

  if (isInternalMcp) {
    await next();
    return;
  }

  const authenticated = await verifySessionCookie(c.env, c.req.header('Cookie'));
  if (!authenticated) return fail(c, 'UNAUTHORIZED', 401);

  const csrf = browserMutationRejection(c.req.method, c.req.url, {
    origin: c.req.header('Origin'),
    secFetchSite: c.req.header('Sec-Fetch-Site'),
    contentType: c.req.header('Content-Type'),
    requestedWith: c.req.header('X-Money-Flow'),
  });
  if (csrf) {
    return fail(c, csrf, csrf === 'CONTENT_TYPE_INVALID' ? 415 : 403);
  }

  await next();
});

// ---------- общие помощники ----------

// Момент с точностью до СЕКУНД — CHECK-ограничение схемы отклоняет миллисекунды
// из наивного `new Date().toISOString()` (migrations/0001_initial_schema.sql).
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isInternalMcp(c: { executionCtx?: unknown }): boolean {
  try {
    return (c.executionCtx as { isInternalMcp?: boolean } | undefined)?.isInternalMcp === true;
  } catch {
    return false;
  }
}

function ledgerApplied(result: D1Result | undefined, min = 1): boolean {
  return (result?.meta.changes ?? 0) >= min;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('REQUEST_BODY_INVALID');
  }
  return body as Record<string, unknown>;
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  // Пустое/битое тело сводим к {} — дальше это даёт тот же 400 «нет нужных
  // полей», что и осмысленный, но неполный JSON: разбираться, чем конкретно
  // не угодил клиент, здесь не обязательно.
  const raw = await c.req.json().catch(() => ({}));
  return asRecord(raw);
}

function normalizeName(input: unknown): string {
  if (typeof input !== 'string') throw new ValidationError('FIELD_TYPE_STRING', { field: 'name' });
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new ValidationError('FIELD_EMPTY', { field: 'name' });
  return trimmed;
}

function normalizeCurrency(input: unknown): string {
  if (typeof input !== 'string') throw new ValidationError('INVALID_CURRENCY');
  const upper = input.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new ValidationError('INVALID_CURRENCY');
  }
  return upper;
}

/** bank/type: строка или null; пустая строка после trim → null. */
function normalizeOptionalText(input: unknown, field: string): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new ValidationError('FIELD_TYPE_STRING_OR_NULL', { field });
  const trimmed = input.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Optional fiscal/verification URL: empty → null; only http(s). */
function normalizeOptionalHttpUrl(input: unknown, field: string): string | null {
  const text = normalizeOptionalText(input, field);
  if (text === null) return null;
  if (text.length > RECEIPT_URL_MAX_LENGTH || parseHttpUrl(text) === null) {
    throw new ValidationError('INVALID_RECEIPT_URL');
  }
  return text;
}

/** Optional TaxCore/PURS PFR (or equivalent). Empty → null; no fake id. */
function normalizeOptionalFiscalReceiptId(input: unknown, field = 'fiscal_receipt_id'): string | null {
  const text = normalizeOptionalText(input, field);
  if (text === null) return null;
  if (text.length > FISCAL_RECEIPT_ID_MAX_LENGTH) {
    throw new ValidationError('INVALID_FISCAL_RECEIPT_ID');
  }
  return text;
}

/**
 * owner/country: непустая строка, как `name` и `currency`. Отдельно от
 * `normalizeOptionalText` потому, что правило ROADMAP «Счёт имеет одного
 * владельца, одну валюту и обязательную страну» не оставляет им состояния
 * «не указано»: счёт без владельца нельзя отобрать под операцию (отбор идёт
 * строго по владельцу и валюте, решение владельца 2026-08-11), а счёт без
 * страны — пустая колонка там, где v1 держит RUS/USA/SRB. `null` здесь тоже
 * ошибка, а не «оставить как есть»: PATCH без поля и так его не трогает,
 * поэтому явный `null` может означать только попытку стереть обязательное.
 */
function normalizeRequiredText(input: unknown, field: string): string {
  if (typeof input !== 'string') throw new ValidationError('FIELD_REQUIRED', { field });
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new ValidationError('FIELD_EMPTY', { field });
  return trimmed;
}

function normalizeIntegerMinor(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new ValidationError('FIELD_TYPE_INTEGER_MINOR', { field });
  }
  return input;
}

function assertSafeBalanceDelta(currentMinor: number, deltaMinor: number): void {
  try {
    minorBigIntToNumber(BigInt(currentMinor) + BigInt(deltaMinor), 'balance_minor');
  } catch {
    throw new ValidationError('BALANCE_OUT_OF_SAFE_RANGE');
  }
}

// Порядковый номер в списке счетов. Диапазон узкий намеренно: новый счёт без
// явного sort получает MAX(sort)+1 без проверок, и если бы в таблице лежало
// значение у самой границы точного целого, инкремент вышел бы за неё — дальше
// точность теряется и позиции начинают дублироваться. Миллиард позиций в
// списке счетов — запас, которого эта задача не увидит никогда.
const SORT_LIMIT = 1_000_000_000;

function normalizeSort(input: unknown): number {
  // isSafeInteger, а не isInteger: за пределами 2^53 у double нет дробной
  // части в принципе, поэтому isInteger(1e21) === true — и такое значение
  // ложится в INTEGER-колонку как REAL (проверено на локальной D1). Та же
  // болезнь, что у rate_e9 ниже, то же лекарство.
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || Math.abs(input) > SORT_LIMIT) {
    throw new ValidationError('INVALID_SORT');
  }
  return input;
}

// done/active/archived — одна и та же булева проверка на три ресурса
// (счета, плановые и регулярные операции). Раньше была своя копия с зашитым
// именем поля 'archived' — обобщена сюда, чтобы третьей копии не завести.
function normalizeBoolean(input: unknown, field: string): number {
  if (typeof input !== 'boolean') throw new ValidationError('FIELD_TYPE_BOOLEAN', { field });
  return input ? 1 : 0;
}

/** :id из пути — нечисловой/дробный id не может ничему соответствовать, это 404, а не 400. */
function parseIdParam(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// ---------- счета ----------

interface AccountRow {
  id: number;
  name: string;
  bank: string | null;
  type: string | null;
  account_number: string | null;
  // Без `| null`: с миграции 0004 обе колонки NOT NULL, и пустое значение
  // отвергает уже сама D1 (#234). До неё тип честно отражал схему, теперь
  // `| null` описывал бы состояние, которого в базе не бывает.
  owner: string;
  country: string;
  currency: string;
  balance_minor: number;
  balance_updated_at: string;
  sort: number;
  archived: number;
}

function toAccountJson(row: AccountRow, aliases?: AliasJson[]) {
  return {
    id: row.id,
    name: row.name,
    bank: row.bank,
    type: row.type,
    account_number: row.account_number,
    owner: row.owner,
    country: row.country,
    currency: row.currency,
    balance_minor: row.balance_minor,
    balance_updated_at: row.balance_updated_at,
    sort: row.sort,
    archived: row.archived === 1,
    // Алиасы счёта — для UI «Данные» (привязка виртуальных карт, issue #339).
    // Пустой массив, когда их нет, чтобы клиент всегда видел поле одной формы.
    aliases: aliases ?? [],
  };
}

apiV2.get('/accounts', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM accounts ORDER BY archived ASC, sort ASC, id ASC',
  ).all<AccountRow>();
  // Алиасов у счёта мало, поэтому набор запросов к account_aliases по id
  // счёта дешевле, чем JOIN с группировкой по JSON. Число счетов в v2
  // измеряется единицами, а не тысячами — N+1 здесь не болит.
  const accounts = await Promise.all(
    results.map(async (row) => toAccountJson(row, await listAliases(c.env.DB, row.id))),
  );
  return c.json({ accounts });
});

// ---------- алиасы счетов (issue #339) ----------
//
// Виртуальные карты (`Visa *6125`, `DinaCard`) привязываются к реальному
// счёту через account_aliases. Резолвер (resolveOrPend) — единственная точка,
// где импорт истории (#340) и автоматизация (#341) превращают «счёт списания»
// чека в account_id; на неизвестном счёте он не падает, а кладёт строку в
// pending_account_strings (эндпоинты /pending ниже), которую потом разбирает
// Hermes Scheduled Job (#341) через Telegram.
//
// AliasError несёт свой HTTP-статус — ловим его отдельно от ValidationError.

apiV2.get('/accounts/:id/aliases', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);
  if (!(await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first())) {
    return fail(c, 'NOT_FOUND', 404);
  }
  return c.json({ aliases: await listAliases(c.env.DB, id) });
});

apiV2.post('/accounts/:id/aliases', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);
  if (!(await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first())) {
    return fail(c, 'NOT_FOUND', 404);
  }
  try {
    const body = await readBody(c);
    const alias = await addAlias(c.env.DB, id, body.alias_text);
    return c.json({ alias }, 201);
  } catch (e) {
    if (e instanceof AliasError) return failCaught(c, e);
    throw e;
  }
});

apiV2.delete('/accounts/:id/aliases/:aliasId', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  const aliasId = parseIdParam(c.req.param('aliasId'));
  if (id === null || aliasId === null) return fail(c, 'NOT_FOUND', 404);
  try {
    await removeAlias(c.env.DB, id, aliasId);
    return c.body(null, 204);
  } catch (e) {
    if (e instanceof AliasError) return failCaught(c, e);
    throw e;
  }
});

// GET is read-only: unknown strings are not written. Pending creation is POST.
apiV2.get('/accounts/resolve', async (c) => {
  const q = c.req.query('q');
  if (typeof q !== 'string' || q.trim().length === 0) {
    return fail(c, 'QUERY_REQUIRED', 400);
  }
  const accountId = await resolveAccount(c.env.DB, q);
  return c.json({ account_id: accountId, pending: accountId === null });
});

apiV2.post('/accounts/resolve', async (c) => {
  let q: unknown;
  try {
    const body = await readBody(c);
    q = body.q;
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }
  if (typeof q !== 'string' || q.trim().length === 0) {
    return fail(c, 'QUERY_REQUIRED', 400);
  }
  const accountId = await resolveOrPend(c.env.DB, q);
  return c.json({ account_id: accountId, pending: accountId === null });
});

// Список непривязанных счетов из чеков — для Hermes Scheduled Job (#341).
apiV2.get('/accounts/pending', async (c) => {
  return c.json({ pending: await listPending(c.env.DB) });
});

// Привязка неизвестного счёта к реальному: создаёт алиас и убирает строку из
// pending. Вызывается ответом владельца на Telegram-подтверждение (#341).
apiV2.post('/accounts/pending/:id/bind', async (c) => {
  const pendingId = parseIdParam(c.req.param('id'));
  if (pendingId === null) return fail(c, 'NOT_FOUND', 404);
  try {
    const body = await readBody(c);
    const accountId = parseIdParam(String(body.account_id ?? ''));
    if (accountId === null) return fail(c, 'ACCOUNT_ID_REQUIRED', 400);
    const alias = await bindPending(c.env.DB, pendingId, accountId);
    return c.json({ alias }, 201);
  } catch (e) {
    if (e instanceof AliasError) return failCaught(c, e);
    throw e;
  }
});

apiV2.post('/accounts', async (c) => {
  try {
    const body = await readBody(c);
    const name = normalizeName(body.name);
    const currency = normalizeCurrency(body.currency);
    const bank = normalizeOptionalText(body.bank, 'bank');
    const type = normalizeOptionalText(body.type, 'type');
    const accountNumber = normalizeOptionalText(body.account_number, 'account_number');
    const owner = normalizeRequiredText(body.owner, 'owner');
    const country = normalizeRequiredText(body.country, 'country');
    const balanceMinor = body.balance_minor === undefined ? 0 : normalizeIntegerMinor(body.balance_minor, 'balance_minor');

    let sort: number;
    if (body.sort === undefined) {
      // max(sort)+1 среди ВСЕХ счетов (включая архивные) — новый счёт не должен
      // случайно занять чужое место после разархивации. Пустая таблица → 0.
      const row = await c.env.DB.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS next_sort FROM accounts').first<{
        next_sort: number;
      }>();
      sort = row?.next_sort ?? 0;
    } else {
      sort = normalizeSort(body.sort);
    }

    const balanceUpdatedAt = nowIso();
    const row = await c.env.DB.prepare(
      `INSERT INTO accounts (name, bank, type, account_number, owner, country, currency, balance_minor, balance_updated_at, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
      .bind(name, bank, type, accountNumber, owner, country, currency, balanceMinor, balanceUpdatedAt, sort)
      .first<AccountRow>();
    return c.json({ account: toAccountJson(row!) }, 201);
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }
});

const ACCOUNT_PATCH_FIELDS = ['name', 'bank', 'type', 'account_number', 'owner', 'country', 'currency', 'balance_minor', 'sort', 'archived'] as const;

// Измерения счёта — пять полей, которые правило ROADMAP объявляет неизменяемыми
// после первой операции: «После первой операции владелец, валюта, страна, банк
// и вид счёта неизменяемы». Остальные поля PATCH'а замок не трогает: `name`
// правится всегда (имя редактируемое по тому же правилу), `balance_minor` —
// суть экрана «Данные», `sort` и `archived` — признаки строки, а не свойства
// денег на ней.
const ACCOUNT_LOCKED_FIELDS = ['owner', 'currency', 'country', 'bank', 'type'] as const;

// Таблицы, ссылка из которых означает «на счёте была операция». Список один на
// обе формы проверки ниже: новая ссылающаяся таблица иначе тихо выпала бы из
// одной из них, и DELETE с PATCH разошлись бы в понимании занятости. Значения
// литеральные, пользовательский ввод сюда не попадает.
//
// `operations` здесь особенно важна, и не только ради симметрии: валюта
// операции не хранится, а берётся у счёта (миграция 0005). Смена валюты счёта
// задним числом переписала бы смысл КАЖДОЙ суммы на нём — 1 200 RSD стали бы
// 1 200 USD, не изменившись ни в одной колонке. Замок измерений — единственное,
// что этого не даёт.
const ACCOUNT_REF_TABLES = ['operations', 'planned_items', 'recurring_items'] as const;

/** Сколько операций, плановых и регулярных строк ссылается на счёт. */
async function countAccountRefs(db: D1Database, id: number): Promise<number> {
  // Явный COUNT вместо того, чтобы полагаться на срабатывание FK: FK без
  // ON DELETE (схема) и так отклонит DELETE, но нам нужен наш собственный
  // текст ошибки и код 409, а не то, что D1 отдаст по факту нарушения FK.
  const refs = await db
    .prepare(
      `SELECT ${ACCOUNT_REF_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE account_id = ?)`).join(' + ')} AS cnt`,
    )
    .bind(...ACCOUNT_REF_TABLES.map(() => id))
    .first<{ cnt: number }>();
  return refs?.cnt ?? 0;
}

// То же условие, но пригодное внутри UPDATE — страховка от гонки. Ранняя
// проверка `countAccountRefs` даёт внятный 409 и стоит до всех прочих отказов,
// но между ней и записью счёт может обзавестись операцией: транзакции на запрос
// в v2 нет. Условие в самом `WHERE` делает проверку и запись атомарными — тот же
// приём и та же причина, что у `RATE_DELETABLE_SQL` ниже. Ссылки идут на
// `accounts.id` (коррелированный подзапрос), чтобы не плодить лишние бинды.
const ACCOUNT_UNLOCKED_SQL = ACCOUNT_REF_TABLES.map(
  (table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE account_id = accounts.id)`,
).join('\n  AND ');

apiV2.patch('/accounts/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  // Нормализованные значения собираем в Map, а не сразу в SQL: замок ниже
  // сравнивает их с текущей строкой, и делать это на сыром теле запроса
  // нельзя — 'usd' и 'USD' там разные строки, а в базе одна и та же валюта.
  const updates = new Map<(typeof ACCOUNT_PATCH_FIELDS)[number], unknown>();
  try {
    const body = await readBody(c);
    for (const field of ACCOUNT_PATCH_FIELDS) {
      if (!(field in body)) continue;
      let value: unknown;
      switch (field) {
        case 'name':
          value = normalizeName(body.name);
          break;
        case 'currency':
          value = normalizeCurrency(body.currency);
          break;
        case 'bank':
        case 'type':
        case 'account_number':
          value = normalizeOptionalText(body[field], field);
          break;
        case 'owner':
        case 'country':
          value = normalizeRequiredText(body[field], field);
          break;
        case 'balance_minor':
          value = normalizeIntegerMinor(body.balance_minor, 'balance_minor');
          break;
        case 'sort':
          value = normalizeSort(body.sort);
          break;
        case 'archived':
          value = normalizeBoolean(body.archived, 'archived');
          break;
      }
      updates.set(field, value);
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  if (updates.size === 0) {
    return fail(c, 'NO_PATCH_FIELDS', 400);
  }

  const current = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);

  // Замок измерений срабатывает по ФАКТИЧЕСКОМУ изменению, а не по наличию
  // поля в теле: форма правки шлёт все свои поля всегда, в том числе
  // нетронутые, и проверка «поле пришло» превратила бы переименование счёта в
  // 409. Архивация замок не снимает — правило не делает для архива исключения,
  // а деньги на архивном счёте никуда не делись.
  const touchesLocked = ACCOUNT_LOCKED_FIELDS.some(
    (field) => updates.has(field) && updates.get(field) !== current[field],
  );

  // Замок проверяется ПЕРВЫМ среди отказов, и это не порядок ради порядка: он
  // терминален, а требование balance_minor ниже — устранимо. В обратном порядке
  // смена валюты на занятом счёте отвечала бы «добавьте balance_minor», а на
  // послушный повторный запрос — «менять поздно»: клиента водили бы по кругу.
  if (touchesLocked && (await countAccountRefs(c.env.DB, id)) > 0) {
    return fail(c, 'ACCOUNT_LOCKED', 409);
  }

  // Валюта и баланс связаны, хотя в теле запроса это два независимых поля:
  // balance_minor хранится в минорных единицах СВОЕЙ валюты, а их разрядность
  // у валют разная. Сменить USD на JPY, не тронув баланс, — значит превратить
  // $1500.00 (150000 центов) в ¥150 000, молча и на два порядка. Поэтому смена
  // валюты требует явно назвать баланс в новой валюте тем же запросом: пусть
  // клиент решает, пересчитать сумму или подтвердить как есть.
  if (updates.has('currency') && updates.get('currency') !== current.currency && !updates.has('balance_minor')) {
    return fail(
      c,
      'ACCOUNT_CURRENCY_CHANGE_REQUIRES_BALANCE',
      400,
    );
  }

  // Поле с прежним значением в SET не идёт вовсе. Для незапертых это просто
  // экономия, а для запертых — единственная защита: guard ниже добавляется
  // только когда измерения реально меняются, и без этого фильтра запрос,
  // который «не менял» измерения, всё равно переписывал бы их по снапшоту,
  // прочитанному раньше, — то есть откатывал бы чужую параллельную правку в
  // обход замка. Не пишем — нечего и терять.
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of updates) {
    if (value === current[field]) continue;
    setClauses.push(`${field} = ?`);
    values.push(value);
  }

  // balance_minor в теле — это подтверждение баланса «на сейчас», даже если
  // число совпало со старым: отметка «я проверил» не то же самое, что «я не менял».
  if (updates.has('balance_minor')) {
    setClauses.push('balance_updated_at = ?');
    values.push(nowIso());
  }

  // Все переданные значения совпали с текущими — писать нечего. Это штатный
  // случай, а не ошибка: форма правки шлёт все поля, и «сохранить, ничего не
  // изменив» должно отвечать тем же, чем ответило бы изменение.
  if (setClauses.length === 0) {
    return c.json({ account: toAccountJson(current) });
  }

  values.push(id);
  const lockGuard = touchesLocked ? ` AND ${ACCOUNT_UNLOCKED_SQL}` : '';
  const row = await c.env.DB.prepare(
    `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = ?${lockGuard} RETURNING *`,
  )
    .bind(...values)
    .first<AccountRow>();

  // Сюда попадаем только гонкой: занятость и существование счёта проверены
  // выше, поэтому ноль обновлённых строк означает, что между проверкой и
  // записью счёт удалили или на него сослалась первая операция. Что именно
  // случилось, разбирает отдельный SELECT — он идёт только по этому пути и
  // обычную правку не удорожает (тот же приём, что в DELETE курса ниже).
  if (!row) {
    const stillThere = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first();
    return stillThere ? fail(c, 'ACCOUNT_LOCKED', 409) : fail(c, 'NOT_FOUND', 404);
  }
  return c.json({ account: toAccountJson(row) });
});

// Подтверждение баланса без правки суммы (issue #223). Отдельный роут, а не
// поле в теле PATCH'а, по трём причинам сразу. Смысл действия обратный правке:
// оно НЕ меняет данные, а свидетельствует о них — смешивать его с эндпоинтом,
// который данные меняет, значит терять это различие в первом же чтении кода.
// PATCH к тому же собирает поля циклом по ACCOUNT_PATCH_FIELDS и проверяет
// «передано хотя бы одно известное поле»; флаг-исключение пришлось бы проводить
// мимо цикла, мимо замка измерений и мимо проверки «нечего писать» — три
// развилки в коде, который сегодня читается линейно. И третье: подтверждение
// обязано быть однозначным. Тело `{"confirm_balance": true}` открывает вопрос,
// что делать с `false` и с сочетанием флага и суммы в одном запросе; у роута
// без тела таких вопросов нет.
//
// Тело запроса не читается вовсе: подтверждать нечего, кроме самого факта.
// Замок измерений (ACCOUNT_LOCKED_FIELDS) здесь не при чём — момент проверки
// не измерение счёта, и подтверждать баланс на счёте с операциями нужно тем
// более. Архивный счёт тоже подтверждается: деньги на нём никуда не делись.
apiV2.post('/accounts/:id/confirm-balance', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  // Одним statement'ом, без пары «прочитать и записать»: транзакции на запрос в
  // v2 нет, а между чтением и записью счёт можно удалить. Ноль обновлённых
  // строк здесь означает ровно одно — счёта нет, — потому что других условий в
  // WHERE не стоит; разбирать этот случай вторым запросом, как в PATCH, нечего.
  const row = await c.env.DB.prepare('UPDATE accounts SET balance_updated_at = ? WHERE id = ? RETURNING *')
    .bind(nowIso(), id)
    .first<AccountRow>();
  if (!row) return fail(c, 'NOT_FOUND', 404);
  return c.json({ account: toAccountJson(row) });
});

apiV2.delete('/accounts/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const existing = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first();
  if (!existing) return fail(c, 'NOT_FOUND', 404);

  // Явный COUNT вместо того, чтобы полагаться на срабатывание FK: FK без
  // ON DELETE (схема) и так отклонит DELETE, но нам нужен наш собственный
  // текст ошибки и код 409, а не то, что D1 отдаст по факту нарушения FK.
  if ((await countAccountRefs(c.env.DB, id)) > 0) return fail(c, 'ACCOUNT_IN_USE', 409);

  try {
    await c.env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  } catch (e) {
    // Между COUNT выше и этим DELETE ссылка может появиться — проверка и
    // действие не в одной транзакции. Сейчас через API такую строку создать
    // ещё нечем, но эндпоинты плановых и регулярных приходят следующей
    // задачей, и тогда голый COUNT отдал бы владельцу 500 вместо внятного
    // «счёт занят». Ответ один и тот же, каким бы путём мы это ни узнали.
    if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) {
      return fail(c, 'ACCOUNT_IN_USE', 409);
    }
    throw e;
  }
  return c.body(null, 204);
});

// ---------- курсы валют ----------
//
// Инвариант раздела (issue #193): у валюты, на которую есть ссылка, должен
// быть курс к базовой. Схемой не выражается — CHECK в SQLite не видит другую
// таблицу, триггеров в v2 нет намеренно, — поэтому держится здесь: DELETE не
// снимает курс с валюты в ходу, GET показывает валюты в ходу без курса.
//
// Гарантия односторонняя, и это осознанно: завести счёт в валюте без курса
// по-прежнему можно, сменить базовую валюту в settings — тоже. То есть код
// не даёт курс ПОТЕРЯТЬ, но не обещает, что он всегда есть. Продуктовое
// обоснование и требование к пересчёту — ТЗ, docs/2026-08-09-v2-simple-spec.md,
// раздел «Данные»; устройство проверок — README, «API и экраны v2».

interface FxRateRow {
  code: string;
  rate_e9: number;
  updated_at: string;
}

// Разбор курса — целочисленно, без единого float на пути (см. комментарий к
// fx_rates в migrations/0001_initial_schema.sql). Формат: неотрицательное
// десятичное число, не больше девяти знаков после точки, без экспоненты и
// без знака — молчаливое округление входа запрещено контрактом.
const RATE_PATTERN = /^\d+(\.\d{1,9})?$/;

// Потолок сверху нужен именно здесь, а не в схеме. Регулярка не ограничивает
// целую часть, а `rate_e9` — это ввод, умноженный на 1e9, поэтому длинная
// строка цифр переполняет 64-битный INTEGER SQLite. Проверено на локальной
// D1: `rate_e9` из 23 цифр оседает в колонке как REAL (`typeof` → 'real',
// значение 1e+23), `CHECK (rate_e9 > 0)` его пропускает — то есть без границы
// ошибка ввода не отклоняется, а тихо превращает целочисленный курс в float,
// ровно в то, чего вся эта арифметика избегает. MAX_SAFE_INTEGER — курс до
// ~9 007 199 базовых единиц за одну чужую, на порядки больше любой реальной
// валюты, и заодно гарантия точности обратного форматирования через Number.
const MAX_RATE_E9 = BigInt(Number.MAX_SAFE_INTEGER);

function parseRateE9(input: unknown): bigint {
  if (input === undefined || input === null) {
    throw new ValidationError('RATE_REQUIRED');
  }
  const raw = typeof input === 'number' ? String(input) : input;
  if (typeof raw !== 'string') {
    throw new ValidationError('RATE_REQUIRED');
  }
  const trimmed = raw.trim();
  if (!RATE_PATTERN.test(trimmed)) {
    throw new ValidationError('RATE_INVALID', { value: trimmed });
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const rateE9 = BigInt(intPart + fracPart.padEnd(9, '0'));
  if (rateE9 === 0n) {
    throw new ValidationError('RATE_ZERO');
  }
  if (rateE9 > MAX_RATE_E9) {
    throw new ValidationError('RATE_TOO_LARGE');
  }
  return rateE9;
}

/** Обратное форматирование rate_e9 → человеческая строка, тоже целочисленно. */
function formatRateE9(rateE9: number): string {
  const digits = BigInt(rateE9).toString().padStart(10, '0');
  const intPart = digits.slice(0, -9);
  const fracPart = digits.slice(-9).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function toRateJson(row: FxRateRow) {
  return {
    code: row.code,
    rate_e9: row.rate_e9,
    rate: formatRateE9(row.rate_e9),
    updated_at: row.updated_at,
  };
}

function normalizeCurrencyCodeParam(raw: string): string | null {
  return /^[A-Za-z]{3}$/.test(raw) ? raw.toUpperCase() : null;
}

// Таблицы с колонкой `currency` — единственный список на весь файл, чтобы обе
// проверки ниже не разошлись между собой. Значения литеральные, в SQL идут
// только они: пользовательский ввод сюда не попадает ни при каком раскладе.
// Экспортируется ради теста, который сверяет список с реальной схемой: новая
// таблица с колонкой `currency` иначе тихо выпала бы из обеих проверок.
//
// `operations` в списке нет, и это не пропуск: своей колонки `currency` у неё
// не осталось (миграция 0005) — валюта операции равна валюте счёта и берётся
// у него `JOIN`'ом. Валюту «в ходу» такая операция всё равно держит, но через
// `accounts`, куда она и так ссылается. Тест сверки со схемой это стережёт:
// вернут колонку — список придётся дополнить.
export const CURRENCY_TABLES = ['accounts', 'planned_items', 'recurring_items', 'imported_receipt_items'] as const;

// Нормализация базовой валюты живёт в двух видах — на JS и на SQL — потому что
// `DELETE` ниже обязан выполнить проверку одним statement'ом, а не сравнивать с
// заранее прочитанным значением. SQL-список строится из того же snapshot ISO,
// поэтому прямой мусор вроде `ZZZ` не получает привилегий базовой валюты.
const ISO_4217_CODES_SQL = ISO_4217_CURRENCY_CODES.map((code) => `'${code}'`).join(', ');
const BASE_CURRENCY_SQL = `(
  SELECT upper(trim(value))
  FROM settings
  WHERE key = 'base_currency' AND upper(trim(value)) IN (${ISO_4217_CODES_SQL})
)`;

/**
 * Базовая валюта из settings, или `null`, если значение непригодно. Своего
 * курса у неё нет и быть не должно — она и есть единица пересчёта, курс к
 * самой себе равен единице по определению. Отсюда три следствия: в `missing`
 * она не попадает никогда; завести ей курс нельзя — `PUT` отвечает 400 (#228);
 * а её случайную строку в fx_rates разрешено удалить даже когда валюта в ходу
 * (иначе ошибку ввода нельзя было бы исправить). Вход закрыт, выход оставлен
 * открытым намеренно: строки, заведённые до запрета или правкой БД, иначе
 * стало бы нечем убрать.
 *
 * Именно поэтому непригодное значение даёт `null`, а не подстановку 'USD'.
 * Решение это про обе формы нормализации сразу — они обязаны совпадать (см.
 * `BASE_CURRENCY_SQL` выше), поэтому дефолт пришлось бы завести и в SQL.
 * Выглядел бы он безобиднее, но применил бы все три следствия к
 * КОНКРЕТНОЙ валюте: при мусоре в settings доллар молча перестал бы
 * показываться в `missing`, стал бы удаляемым при живых долларовых счетах и
 * лишился бы права на курс — а базовой в этот момент вполне может быть не он.
 * То есть сломанная настройка разом и незаметно снимала бы две защиты и
 * навешивала бы лишний запрет. `null` ошибается в другую сторону: ни
 * послаблений, ни запретов не достаётся никому, лишняя валюта в `missing` —
 * видимая и безвредная неточность.
 *
 * PUT /settings/base_currency принимает только действующий ISO 4217 код, так
 * что непригодное значение достижимо только прямой правкой БД. Защитное чтение
 * всё равно нужно: ручная ошибка не должна молча назначить другую базу.
 */
async function readBaseCurrency(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT ${BASE_CURRENCY_SQL} AS code`).first<{ code: string | null }>();
  // Нормализация — общая с forecast/load.ts (shared/currency.ts): разойдись
  // эти две формы, `GET /fx-rates` и `GET /forecast` считали бы базовой валютой
  // разное при одном и том же значении в settings.
  return normalizeIso4217CurrencyCode(row?.code);
}

/**
 * Валюты, на которые в базе есть хоть одна ссылка. Архивные счета считаются
 * наравне с активными намеренно: архив в v2 — это признак строки, а не списание
 * денег. Деньги на счёте остались, счёт можно разархивировать одним PATCH, и
 * любой итог, куда он попадёт, всё так же потребует курса. Ровно на этом
 * «архивное не держит справочник» и построен исходный сценарий #193.
 */
async function currenciesInUse(db: D1Database): Promise<Set<string>> {
  // UNION, а не UNION ALL: дубли нам не нужны, и дедупликацию дешевле сделать
  // в SQLite, чем тащить в Worker по строке на каждый счёт и каждую трату.
  const sql = CURRENCY_TABLES.map((table) => `SELECT currency FROM ${table}`).join(' UNION ');
  const { results } = await db.prepare(sql).all<{ currency: string }>();
  return new Set(results.map((row) => row.currency));
}

apiV2.get('/fx-rates', async (c) => {
  // Три запроса взаимно независимы — идут параллельно. Последовательными они
  // втрое удлиняли бы загрузку экрана «Данные» без единой на то причины.
  const [{ results }, baseCurrency, inUse] = await Promise.all([
    c.env.DB.prepare('SELECT code, rate_e9, updated_at FROM fx_rates ORDER BY code').all<FxRateRow>(),
    readBaseCurrency(c.env.DB),
    currenciesInUse(c.env.DB),
  ]);
  const known = new Set(results.map((row) => row.code));
  // Валюты в ходу, для которых пересчёт невозможен. Якорной валюте (USD) курс
  // не нужен по определению. Если какой-то другой валюты (включая базовую) нет
  // в таблице курсов, пересчёт через USD сломается. Экран показывает это
  // предупреждением, чтобы владелец ввёл курс к USD.
  const missing = [...inUse].filter((code) => code !== 'USD' && !known.has(code)).sort();
  return c.json({ base_currency: baseCurrency, rates: results.map(toRateJson), missing });
});

apiV2.put('/fx-rates/:code', async (c) => {
  const code = normalizeCurrencyCodeParam(c.req.param('code'));
  if (code === null) {
    return fail(c, 'CURRENCY_CODE_INVALID', 400);
  }

  // Вход закрыт, выход — нет: USD является абсолютным якорем (usd_per_unit).
  // Заводить строку для USD бессмысленно, 1 USD = 1 USD всегда.
  // DELETE такой строки, уже лежащей в базе, разрешён — это единственный путь её убрать.
  const baseCurrency = await readBaseCurrency(c.env.DB);
  if (code === 'USD') {
    return fail(c, 'BASE_CURRENCY_RATE_FORBIDDEN', 400);
  }

  let rateE9: bigint;
  try {
    const body = await readBody(c);
    rateE9 = parseRateE9(body.rate);
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const updatedAt = nowIso();
  // Строкой, а не bigint/number: D1 не принимает bigint в bind(), а INTEGER-
  // аффинити SQLite сама и без потерь превращает цифровую строку в целое —
  // это ещё и обходит риск потери точности JS Number на больших rate_e9.
  // Курсы баз-независимы (usd_per_unit), поэтому смена базы их не трогает.
  const row = await c.env.DB.prepare(
    `INSERT INTO fx_rates (code, rate_e9, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET rate_e9 = excluded.rate_e9, updated_at = excluded.updated_at
     RETURNING code, rate_e9, updated_at`,
  )
    .bind(code, rateE9.toString(), updatedAt)
    .first<FxRateRow>();

  if (row === null) {
    return fail(c, 'RATE_SAVE_FAILED', 500);
  }
  return c.json({ rate: toRateJson(row) });
});

// «Курс удалять можно»: либо это якорная валюта (USD), либо на код не ссылается ни
// одна строка. Условие стоит внутри самого DELETE, а не отдельным SELECT'ом
// перед ним, и это не стилистика: проверка и удаление в одном statement
// атомарны, поэтому строка, вставленная между ними, невозможна в принципе.
// Пара «SELECT, потом DELETE» такое окно оставляла бы, а транзакции у нас на
// каждый запрос нет. Ссылки внутри подзапросов идут на `fx_rates.code`, чтобы
// не плодить одинаковые бинды.
const RATE_DELETABLE_SQL = `(
  code = 'USD'
  OR (${CURRENCY_TABLES.map((table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE currency = fx_rates.code)`).join('\n      AND ')})
)`;

apiV2.delete('/fx-rates/:code', async (c) => {
  const code = normalizeCurrencyCodeParam(c.req.param('code'));
  if (code === null) return fail(c, 'NOT_FOUND', 404);

  const deleted = await c.env.DB.prepare(`DELETE FROM fx_rates WHERE code = ? AND ${RATE_DELETABLE_SQL}`)
    .bind(code)
    .run();
  if (deleted.meta.changes > 0) return c.body(null, 204);

  // Ноль удалённых строк означает одно из двух: строки не было (404) либо она
  // есть, но валюта занята (409). Различает их отдельный SELECT — он идёт
  // только по неуспешному пути и обычное удаление не удорожает. Заодно это
  // верный ответ на два одновременных DELETE: тот, кто опоздал, получит 404
  // «уже нет», а не 409 «занята».
  const existing = await c.env.DB.prepare('SELECT code FROM fx_rates WHERE code = ?').bind(code).first();
  return existing ? fail(c, 'RATE_IN_USE', 409, { code }) : fail(c, 'NOT_FOUND', 404);
});

// ---------- плановые операции ----------
//
// Разовые операции с определённой датой (S1-3, issue #197). Валюта строки
// независима от валюты счёта — так же, как у счетов и трат в CURRENCY_TABLES
// выше: колонка currency своя, смена одной не меняет другую и совпадать они
// не обязаны. Замок измерений счёта (issue #232) на planned_items не
// распространяется: правило ROADMAP запирает карточку счёта, а не операции,
// которые на него ссылаются.

interface PlannedItemRow {
  id: number;
  revision: string;
  date: string;
  title: string;
  amount_minor: number;
  currency: string;
  account_id: number;
  category: string | null;
  done: number;
}

interface OperationFulfillmentLinkRow {
  operation_id: number;
  planned_item_id: number | null;
  recurring_item_id: number | null;
  period_due_date: string | null;
  fulfillment_type: 'materialized' | 'linked';
  linked_at: string;
}

interface RecurringPeriodFulfillmentRow {
  recurring_item_id: number;
  period_due_date: string;
  outcome: 'materialized' | 'linked' | 'skipped';
  evidence_quantity: number;
  fulfilled_at: string;
}

function toPlannedItemJson(row: PlannedItemRow, fulfillment?: OperationFulfillmentLinkRow | null) {
  return {
    id: row.id,
    date: row.date,
    title: row.title,
    amount_minor: row.amount_minor,
    currency: row.currency,
    account_id: row.account_id,
    category: row.category,
    done: row.done === 1,
    fulfillment: fulfillment
      ? {
          type: fulfillment.fulfillment_type,
          operation_id: fulfillment.operation_id,
          fulfilled_at: fulfillment.linked_at,
        }
      : null,
  };
}

// Даты — TEXT 'YYYY-MM-DD' (шапка 0001_initial_schema.sql), схема проверяет
// формат round-trip'ом через SQLite `date()`. Та же проверка нужна ДО записи:
// без неё "2026-02-30" улетает в CHECK и падает 500-кой вместо внятного 400.
// `Date.UTC` + сверка компонентов обратно — тот же приём, что у `date()`, но
// без зависимости от таймзоны окружения: `new Date('2026-02-30')` без UTC в
// некоторых таймзонах не бросает вовсе, а тихо съезжает на соседние сутки.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDateString(input: unknown, field: string): string {
  if (typeof input !== 'string' || !DATE_PATTERN.test(input)) {
    throw new ValidationError('INVALID_ISO_DATE', { field });
  }
  const [year, month, day] = input.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ValidationError('INVALID_CALENDAR_DATE', { field, value: String(input) });
  }
  return input;
}

/** end_date — та же проверка формата, но null разрешён явно (снять срок). */
function normalizeNullableDateString(input: unknown, field: string): string | null {
  if (input === null || input === undefined) return null;
  return normalizeDateString(input, field);
}

// amount_minor — та же целочисленность, что у balance_minor счёта, плюс
// запрет нуля: схема отклоняет его CHECK'ом (amount_minor <> 0), у баланса
// счёта такого ограничения нет (пустой счёт — обычное дело).
function normalizeAmountMinor(input: unknown, field: string): number {
  const value = normalizeIntegerMinor(input, field);
  if (value === 0) {
    throw new ValidationError('FIELD_NOT_ZERO', { field });
  }
  return value;
}

function normalizeAccountId(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new ValidationError('ACCOUNT_ID_REQUIRED');
  }
  return input;
}

/**
 * Счёт по id — для проверки существования и для валюты по умолчанию.
 * Архивный счёт разрешён намеренно: архив — признак строки (см.
 * `toAccountJson`), а не запрет на операции с ним.
 */
async function loadAccountForReference(
  db: D1Database,
  id: number,
): Promise<{ name: string; currency: string; balance_minor: number } | null> {
  return db.prepare('SELECT name, currency, balance_minor FROM accounts WHERE id = ?')
    .bind(id)
    .first<{ name: string; currency: string; balance_minor: number }>();
}

const DUPLICATE_EXPENSE_LOOKBACK_DAYS = 14;

async function findDuplicateExpenseId(
  db: D1Database,
  candidate: ExpenseDuplicateCandidate,
): Promise<number | null> {
  const from = addDays(candidate.date, -DUPLICATE_EXPENSE_LOOKBACK_DAYS);
  const to = addDays(candidate.date, 1);
  const { results } = await db.prepare(
    `SELECT id, date, account_id, store, item, comment, fiscal_receipt_id, amount_minor
     FROM operations
     WHERE kind = 'expense' AND account_id = ? AND date >= ? AND date <= ?`,
  ).bind(candidate.account_id, from, to).all<ExpenseDuplicateCandidate & { id: number }>();
  for (const row of results) {
    if (expenseLooksLikeDuplicate(candidate, row)) return row.id;
  }
  return null;
}

/**
 * Вид операции из знака плановой. У плановой `kind` нет: минус — расход,
 * плюс — доход. Возврат (`refund`) отсюда не вывести — его у плана нет,
 * и issue #267 этого не просит.
 */
function kindFromPlannedAmount(amountMinor: number): 'expense' | 'income' {
  return amountMinor < 0 ? 'expense' : 'income';
}

/**
 * Операция не имеет своей валюты — она равна валюте счёта. Применить
 * `amount_minor` плановой «как есть» можно только в тех же единицах.
 * Тихий пересчёт по курсу хуже, чем отказ: курса на дату плана мы не
 * обещали, а чужие минорные единицы на счёте — это враньё в деньгах.
 */
function assertPlannedCurrencyMatchesAccount(plannedCurrency: string, accountCurrency: string): void {
  if (plannedCurrency !== accountCurrency) {
    throw new ValidationError('PLANNED_CURRENCY_MISMATCH', { accountCurrency, plannedCurrency });
  }
}

function insertOperationFromPlannedStatement(
  db: D1Database,
  planned: Pick<PlannedItemRow, 'date' | 'title' | 'amount_minor' | 'account_id' | 'category'>,
  plannedItemId: number | 'last_insert_rowid',
) {
  const kind = kindFromPlannedAmount(planned.amount_minor);
  if (plannedItemId === 'last_insert_rowid') {
    return db
      .prepare(
        `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, planned_item_id)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, NULL, 'planned', last_insert_rowid())`,
      )
      .bind(planned.date, planned.account_id, kind, planned.title, planned.category, planned.amount_minor);
  }
  // UNIQUE на planned_item_id — сеть на гонке двух отметок. Пустой INSERT
  // здесь нарочно не делаем: к нему нельзя приклеить дельту баланса, не
  // применив её повторно на втором запросе.
  return db
    .prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, planned_item_id)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, NULL, 'planned', ?)`,
    )
    .bind(
      planned.date,
      planned.account_id,
      kind,
      planned.title,
      planned.category,
      planned.amount_minor,
      plannedItemId,
    );
}

function linkLastMaterializedPlannedOperationStatement(db: D1Database) {
  return db.prepare(
    `INSERT INTO operation_fulfillment_links
       (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
     SELECT id, planned_item_id, NULL, NULL, 'materialized', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     FROM operations
     WHERE id = last_insert_rowid() AND source = 'planned' AND planned_item_id IS NOT NULL`,
  );
}

apiV2.get('/planned-items', async (c) => {
  const [planned, links] = await c.env.DB.batch<PlannedItemRow & OperationFulfillmentLinkRow>([
    c.env.DB.prepare('SELECT * FROM planned_items ORDER BY done ASC, date ASC, id ASC'),
    c.env.DB.prepare('SELECT * FROM operation_fulfillment_links WHERE planned_item_id IS NOT NULL'),
  ]);
  const byPlanned = new Map<number, OperationFulfillmentLinkRow>();
  for (const raw of links.results) {
    const link = raw as unknown as OperationFulfillmentLinkRow;
    byPlanned.set(link.planned_item_id!, link);
  }
  return c.json({
    planned_items: planned.results.map((row) => toPlannedItemJson(row as PlannedItemRow, byPlanned.get(row.id))),
  });
});

apiV2.post('/planned-items', async (c) => {
  try {
    const body = await readBody(c);
    const date = normalizeDateString(body.date, 'date');
    const title = normalizeRequiredText(body.title, 'title');
    const amountMinor = normalizeAmountMinor(body.amount_minor, 'amount_minor');
    const accountId = normalizeAccountId(body.account_id);
    const account = await loadAccountForReference(c.env.DB, accountId);
    if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    // Валюта по умолчанию — валюта счёта, но независимая от неё дальше: явно
    // переданная валюта принимается как есть, совпадать с валютой счёта не
    // обязана (см. докблок раздела).
    const currency = body.currency === undefined ? account.currency : normalizeCurrency(body.currency);
    const category = normalizeOptionalText(body.category, 'category');
    const done = body.done === undefined ? 0 : normalizeBoolean(body.done, 'done');

    if (done === 1) {
      assertPlannedCurrencyMatchesAccount(currency, account.currency);
      assertSafeBalanceDelta(account.balance_minor, amountMinor);
      // Создание сразу выполненным — тот же факт, что отметка: плановая,
      // операция и дельта баланса в одном batch. last_insert_rowid() берёт
      // id только что вставленной плановой в этой же транзакции.
      const [inserted] = await c.env.DB.batch<PlannedItemRow>([
        c.env.DB.prepare(
          `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done, revision)
           VALUES (?, ?, ?, ?, ?, ?, 1, lower(hex(randomblob(16))))
           RETURNING *`,
        ).bind(date, title, amountMinor, currency, accountId, category),
        insertOperationFromPlannedStatement(
          c.env.DB,
          { date, title, amount_minor: amountMinor, account_id: accountId, category },
          'last_insert_rowid',
        ),
        linkLastMaterializedPlannedOperationStatement(c.env.DB),
        balanceDeltaStatement(c.env.DB, accountId, amountMinor),
      ]);
      return c.json({ planned_item: toPlannedItemJson(inserted.results[0]!) }, 201);
    }

    const row = await c.env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category, done, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, lower(hex(randomblob(16))))
       RETURNING *`,
    )
      .bind(date, title, amountMinor, currency, accountId, category, done)
      .first<PlannedItemRow>();
    return c.json({ planned_item: toPlannedItemJson(row!) }, 201);
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }
});

const PLANNED_PATCH_FIELDS = ['date', 'title', 'amount_minor', 'currency', 'account_id', 'category', 'done'] as const;

const PLANNED_SNAPSHOT_WHERE = `id = ? AND revision IS ? AND date = ? AND title = ? AND amount_minor = ?
  AND currency = ? AND account_id = ? AND category IS ? AND done = ?`;

function plannedSnapshotBinds(row: PlannedItemRow): unknown[] {
  return [row.id, row.revision, row.date, row.title, row.amount_minor, row.currency, row.account_id, row.category, row.done];
}

function plannedSnapshotMatches(row: PlannedItemRow, snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const value = snapshot as Record<string, unknown>;
  return (value.type === 'planned_item' || value.type === 'planned_done' || value.type === 'planned_fulfill')
    && value.id === row.id
    && value.revision === row.revision
    && value.date === row.date
    && value.title === row.title
    && value.amount_minor === row.amount_minor
    && value.currency === row.currency
    && value.account_id === row.account_id
    && value.category === row.category
    && value.done === row.done;
}

apiV2.post('/planned-items/:id/fulfill-existing', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  let operationId: number;
  let expectedSnapshot: unknown;
  try {
    const body = await readBody(c);
    expectedSnapshot = body.__mcp_expected_snapshot;
    operationId = normalizeAccountId(body.operation_id);
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const planned = await c.env.DB.prepare('SELECT * FROM planned_items WHERE id = ?')
    .bind(id).first<PlannedItemRow>();
  if (!planned) return fail(c, 'NOT_FOUND', 404);
  if (expectedSnapshot !== undefined && !plannedSnapshotMatches(planned, expectedSnapshot)) {
    return fail(c, 'PLANNED_ITEM_STALE', 409);
  }

  const existing = await c.env.DB.prepare(
    'SELECT * FROM operation_fulfillment_links WHERE planned_item_id = ?',
  ).bind(id).first<OperationFulfillmentLinkRow>();
  if (existing) {
    if (existing.operation_id === operationId && existing.fulfillment_type === 'linked' && planned.done === 1) {
      const operation = await c.env.DB.prepare(`${OPERATION_SELECT} WHERE o.id = ?`)
        .bind(operationId).first<OperationRowWithCurrency>();
      return c.json({
        status: 'already-linked',
        planned_item: toPlannedItemJson(planned, existing),
        operation: operation ? toOperationJson(operation) : null,
      });
    }
    return fail(c, 'PLANNED_ITEM_ALREADY_FULFILLED', 409);
  }
  if (planned.done === 1) {
    return fail(c, 'PLANNED_ITEM_ALREADY_DONE_UNLINKED', 409);
  }

  const operation = await c.env.DB.prepare(`${OPERATION_SELECT} WHERE o.id = ?`)
    .bind(operationId).first<OperationRowWithCurrency>();
  if (!operation) return fail(c, 'OPERATION_NOT_FOUND', 404);
  const claimed = await c.env.DB.prepare(
    'SELECT * FROM operation_fulfillment_links WHERE operation_id = ?',
  ).bind(operationId).first<OperationFulfillmentLinkRow>();
  if (claimed) return fail(c, 'OPERATION_ALREADY_CLAIMED', 409);

  try {
    if (operation.transfer_id !== null) throw new ValidationError('TRANSFER_CANNOT_FULFILL_PLANNED');
    if (operation.kind !== kindFromPlannedAmount(planned.amount_minor)) {
      throw new ValidationError('FULFILLMENT_KIND_MISMATCH');
    }
    if (operation.account_id !== planned.account_id) throw new ValidationError('FULFILLMENT_ACCOUNT_MISMATCH');
    if (operation.currency !== planned.currency) throw new ValidationError('FULFILLMENT_CURRENCY_MISMATCH');
    if (operation.amount_minor !== planned.amount_minor) throw new ValidationError('FULFILLMENT_AMOUNT_MISMATCH');
    if (operation.date !== planned.date) throw new ValidationError('FULFILLMENT_DATE_MISMATCH');
    if (planned.category !== null && operation.category !== planned.category) {
      throw new ValidationError('FULFILLMENT_CATEGORY_MISMATCH');
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  let results: D1Result<PlannedItemRow>[];
  try {
    results = await c.env.DB.batch<PlannedItemRow>([
      c.env.DB.prepare(
        `INSERT INTO operation_fulfillment_links
           (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
         SELECT ?1, ?2, NULL, NULL, 'linked', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         FROM operations o
         JOIN planned_items p ON p.id = ?2
         JOIN accounts a ON a.id = o.account_id
         WHERE o.id = ?1
           AND p.revision IS ?3 AND p.date = ?4 AND p.title = ?5 AND p.amount_minor = ?6
           AND p.currency = ?7 AND p.account_id = ?8 AND p.category IS ?9 AND p.done = ?10
           AND o.transfer_id IS NULL
           AND o.account_id = p.account_id
           AND o.amount_minor = p.amount_minor
           AND o.date = p.date
           AND o.kind = CASE WHEN p.amount_minor < 0 THEN 'expense' ELSE 'income' END
           AND a.currency = p.currency
           AND (p.category IS NULL OR o.category = p.category)
           AND NOT EXISTS (SELECT 1 FROM operation_fulfillment_links l WHERE l.operation_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM operation_fulfillment_links l WHERE l.planned_item_id = p.id)`,
      ).bind(operationId, id, ...plannedSnapshotBinds(planned).slice(1)),
      c.env.DB.prepare(
        `UPDATE planned_items SET done = 1
         WHERE ${PLANNED_SNAPSHOT_WHERE}
           AND EXISTS (
             SELECT 1 FROM operation_fulfillment_links
             WHERE planned_item_id = ?1 AND operation_id = ?10
           )
         RETURNING *`,
      ).bind(...plannedSnapshotBinds(planned), operationId),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed/i.test(message)) {
      return fail(c, 'FULFILLMENT_CONFLICT', 409);
    }
    throw e;
  }
  const updated = results[1]?.results[0];
  if (!updated) return fail(c, 'CONCURRENT_UPDATE', 409);
  const liveOperation = await c.env.DB.prepare(`${OPERATION_SELECT} WHERE o.id = ?`)
    .bind(operationId).first<OperationRowWithCurrency>();
  const link = await c.env.DB.prepare('SELECT * FROM operation_fulfillment_links WHERE planned_item_id = ?')
    .bind(id).first<OperationFulfillmentLinkRow>();
  return c.json({
    status: 'linked',
    planned_item: toPlannedItemJson(updated, link),
    operation: liveOperation ? toOperationJson(liveOperation) : toOperationJson(operation),
  }, 201);
});

function plannedOperationMatches(
  operation: Pick<OperationRow, 'source' | 'date' | 'account_id' | 'item' | 'category' | 'amount_minor'> | null,
  planned: PlannedItemRow,
): boolean {
  return operation !== null
    && operation.source === 'planned'
    && operation.date === planned.date
    && operation.account_id === planned.account_id
    && operation.item === planned.title
    && operation.category === planned.category
    && operation.amount_minor === planned.amount_minor;
}

apiV2.patch('/planned-items/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const updates = new Map<(typeof PLANNED_PATCH_FIELDS)[number], unknown>();
  let expectedSnapshot: unknown;
  try {
    const body = await readBody(c);
    expectedSnapshot = body.__mcp_expected_snapshot;
    for (const field of PLANNED_PATCH_FIELDS) {
      if (!(field in body)) continue;
      let value: unknown;
      switch (field) {
        case 'date':
          value = normalizeDateString(body.date, 'date');
          break;
        case 'title':
          value = normalizeRequiredText(body.title, 'title');
          break;
        case 'amount_minor':
          value = normalizeAmountMinor(body.amount_minor, 'amount_minor');
          break;
        case 'currency':
          value = normalizeCurrency(body.currency);
          break;
        case 'account_id':
          value = normalizeAccountId(body.account_id);
          break;
        case 'category':
          value = normalizeOptionalText(body.category, 'category');
          break;
        case 'done':
          value = normalizeBoolean(body.done, 'done');
          break;
      }
      updates.set(field, value);
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  if (updates.size === 0) {
    return fail(c, 'NO_PATCH_FIELDS', 400);
  }

  const current = await c.env.DB.prepare('SELECT * FROM planned_items WHERE id = ?').bind(id).first<PlannedItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (expectedSnapshot !== undefined && !plannedSnapshotMatches(current, expectedSnapshot)) {
    return fail(c, 'PLANNED_ITEM_STALE', 409);
  }

  try {
    if (updates.has('account_id')) {
      const account = await loadAccountForReference(c.env.DB, updates.get('account_id') as number);
      if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    }

    // Та же причина, что у счетов: amount_minor хранится в минорных единицах
    // СВОЕЙ валюты, и у валют разная разрядность. Смена account_id валюту не
    // переопределяет — только явная смена currency требует суммы тем же запросом.
    if (updates.has('currency') && updates.get('currency') !== current.currency && !updates.has('amount_minor')) {
      throw new ValidationError('CURRENCY_CHANGE_REQUIRES_AMOUNT');
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const next: PlannedItemRow = {
    ...current,
    ...(updates.has('date') ? { date: updates.get('date') as string } : {}),
    ...(updates.has('title') ? { title: updates.get('title') as string } : {}),
    ...(updates.has('amount_minor') ? { amount_minor: updates.get('amount_minor') as number } : {}),
    ...(updates.has('currency') ? { currency: updates.get('currency') as string } : {}),
    ...(updates.has('account_id') ? { account_id: updates.get('account_id') as number } : {}),
    ...(updates.has('category') ? { category: updates.get('category') as string | null } : {}),
    ...(updates.has('done') ? { done: updates.get('done') as number } : {}),
  };
  const existingOp = await c.env.DB.prepare('SELECT id FROM operations WHERE planned_item_id = ?')
    .bind(id)
    .first<{ id: number }>();
  const existingFulfillment = await c.env.DB.prepare(
    `SELECT * FROM operation_fulfillment_links WHERE planned_item_id = ?`,
  ).bind(id).first<OperationFulfillmentLinkRow>();
  if (existingFulfillment?.fulfillment_type === 'linked') {
    const protectedFields = ['date', 'amount_minor', 'currency', 'account_id', 'category'] as const;
    const changedProtected = protectedFields.filter(
      (field) => updates.has(field) && updates.get(field) !== current[field],
    );
    if (changedProtected.length > 0) {
      return fail(c, 'PLANNED_ITEM_LINKED_FACT', 409, { fields: changedProtected.join(', ') });
    }
  }
  // Старая галочка без операции (до #267) и повторный done: true после
  // удаления факта — тот же путь, что первая отметка, но ТОЛЬКО при явной
  // передаче done: true в запросе. Иначе обычная правка полей (название,
  // категория) выполненной плановой пытается материализовать операцию и
  // падает на несовпадении валют со счётом (#282).
  const needsMaterialize = updates.has('done') && updates.get('done') === 1 && !existingOp && !existingFulfillment;
  const becomingOpen = current.done === 1 && next.done === 0;

  try {
    if (needsMaterialize) {
      const account = await loadAccountForReference(c.env.DB, next.account_id);
      if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
      assertPlannedCurrencyMatchesAccount(next.currency, account.currency);
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of updates) {
    if (value === current[field as keyof PlannedItemRow]) continue;
    setClauses.push(`${field} = ?`);
    values.push(value);
  }

  if (setClauses.length === 0 && !needsMaterialize) {
    return c.json({ planned_item: toPlannedItemJson(current) });
  }

  const updatePlanned = c.env.DB
    .prepare(
      `UPDATE planned_items SET ${setClauses.length === 0 ? 'id = id' : setClauses.join(', ')}
       WHERE ${PLANNED_SNAPSHOT_WHERE}
       RETURNING *`,
    )
    .bind(...values, ...plannedSnapshotBinds(current));

  // Без смены факта — одиночный CAS UPDATE. Устаревший snapshot получает 409,
  // а не молча перетирает более свежую правку.
  if (!needsMaterialize && !becomingOpen) {
    const row = await updatePlanned.first<PlannedItemRow>();
    if (!row) {
      const exists = await c.env.DB.prepare('SELECT id FROM planned_items WHERE id = ?').bind(id).first<{ id: number }>();
      return exists
        ? fail(c, 'CONCURRENT_UPDATE', 409)
        : fail(c, 'NOT_FOUND', 404);
    }
    return c.json({ planned_item: toPlannedItemJson(row) });
  }

  // CAS UPDATE идёт первым. Каждый следующий statement исполняет эффект
  // только когда предыдущий изменил ровно одну строку (`changes() = 1`).
  // Поэтому устаревший snapshot не создаёт operation и не двигает balance.
  const statements: D1PreparedStatement[] = [updatePlanned];
  if (becomingOpen) {
    if (existingFulfillment?.fulfillment_type === 'linked') {
      statements.push(
        c.env.DB.prepare(
          'DELETE FROM operation_fulfillment_links WHERE planned_item_id = ? AND changes() = 1',
        ).bind(id),
      );
    } else {
      const operationId = existingFulfillment?.operation_id ?? existingOp?.id;
      if (operationId !== undefined) {
        statements.push(
          c.env.DB.prepare(
            `UPDATE accounts
             SET balance_minor = balance_minor - (SELECT amount_minor FROM operations WHERE id = ?1)
             WHERE id = (SELECT account_id FROM operations WHERE id = ?1)
               AND changes() = 1
               AND (balance_minor - (SELECT amount_minor FROM operations WHERE id = ?1)) BETWEEN ${SAFE_MINOR_MIN} AND ${SAFE_MINOR_MAX}`,
          ).bind(operationId),
          c.env.DB.prepare(
            'DELETE FROM operation_fulfillment_links WHERE operation_id = ? AND changes() = 1',
          ).bind(operationId),
          c.env.DB.prepare('DELETE FROM operations WHERE id = ? AND changes() = 1').bind(operationId),
        );
      }
    }
  }
  if (needsMaterialize) {
    const kind = kindFromPlannedAmount(next.amount_minor);
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, planned_item_id)
         SELECT ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, 'planned', ?
         WHERE changes() = 1`,
      ).bind(next.date, next.account_id, kind, next.title, next.category, next.amount_minor, id),
      linkLastMaterializedPlannedOperationStatement(c.env.DB),
      c.env.DB.prepare(
        'UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ? AND changes() = 1 AND (balance_minor + ?) BETWEEN ? AND ?',
      ).bind(next.amount_minor, next.account_id, next.amount_minor, SAFE_MINOR_MIN, SAFE_MINOR_MAX),
    );
  }

  let updated: D1Result<PlannedItemRow>;
  try {
    const results = await c.env.DB.batch<PlannedItemRow>(statements);
    updated = results[0]!;
    if (needsMaterialize && !ledgerApplied(results[results.length - 1])) {
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM operation_fulfillment_links WHERE planned_item_id = ?').bind(id),
        c.env.DB.prepare('DELETE FROM operations WHERE planned_item_id = ?').bind(id),
        c.env.DB.prepare(
          `UPDATE planned_items
           SET date = ?, title = ?, amount_minor = ?, currency = ?, account_id = ?, category = ?, done = ?
           WHERE id = ?`,
        ).bind(
          current.date,
          current.title,
          current.amount_minor,
          current.currency,
          current.account_id,
          current.category,
          current.done,
          id,
        ),
      ]);
      return fail(c, 'LEDGER_EFFECT_MISSING', 409);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (needsMaterialize && /UNIQUE constraint failed/i.test(message)) {
      const fresh = await c.env.DB.prepare('SELECT * FROM planned_items WHERE id = ?').bind(id).first<PlannedItemRow>();
      const operation = await c.env.DB.prepare(
        `SELECT source, date, account_id, item, category, amount_minor
         FROM operations WHERE planned_item_id = ?`,
      ).bind(id).first<Pick<OperationRow, 'source' | 'date' | 'account_id' | 'item' | 'category' | 'amount_minor'>>();
      const requestAlreadySatisfied = fresh !== null
        && Array.from(updates).every(([field, value]) => fresh[field] === value)
        && plannedOperationMatches(operation, fresh);
      return requestAlreadySatisfied
        ? c.json({ planned_item: toPlannedItemJson(fresh) })
        : fail(c, 'CONCURRENT_UPDATE', 409);
    }
    throw e;
  }

  const row = updated.results[0];
  if (!row) {
    const exists = await c.env.DB.prepare('SELECT id FROM planned_items WHERE id = ?').bind(id).first<{ id: number }>();
    return exists
      ? fail(c, 'CONCURRENT_UPDATE', 409)
      : fail(c, 'NOT_FOUND', 404);
  }
  return c.json({ planned_item: toPlannedItemJson(row) });
});

apiV2.delete('/planned-items/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const body = await readBody(c);
  const expectedSnapshot = body.__mcp_expected_snapshot;
  const current = await c.env.DB.prepare('SELECT * FROM planned_items WHERE id = ?').bind(id).first<PlannedItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (expectedSnapshot !== undefined && !plannedSnapshotMatches(current, expectedSnapshot)) {
    return fail(c, 'PLANNED_ITEM_STALE', 409);
  }

  const deleted = expectedSnapshot === undefined
    ? await c.env.DB.prepare('DELETE FROM planned_items WHERE id = ?').bind(id).run()
    : await c.env.DB.prepare(`DELETE FROM planned_items WHERE ${PLANNED_SNAPSHOT_WHERE}`).bind(...plannedSnapshotBinds(current)).run();
  if (deleted.meta.changes === 0) {
    const exists = await c.env.DB.prepare('SELECT id FROM planned_items WHERE id = ?').bind(id).first<{ id: number }>();
    return exists
      ? fail(c, 'PLANNED_ITEM_STALE', 409)
      : fail(c, 'NOT_FOUND', 404);
  }
  return c.body(null, 204);
});

// ---------- регулярные операции ----------
//
// Правило хранится якорем + шагом (шапка 0001_initial_schema.sql): день/месяц
// имеют смысл только для части частот, и связь между ними жёстко проверяют
// CONSTRAINT'ы `recurring_items_rule_anchors` (0001) и
// `recurring_items_yearly_month_matches_anchor` (0003) — оба живые на ЛЮБОМ
// UPDATE строки, не только на INSERT. Валидация ниже не дублирует эти
// CHECK'и, а отвечает внятным 400 РАНЬШЕ, чем запрос до них дойдёт: без неё
// несогласованный ввод падал бы 500-кой с текстом SQLite вместо объяснения.

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
type Frequency = (typeof FREQUENCIES)[number];

function normalizeFrequency(input: unknown): Frequency {
  if (typeof input !== 'string') {
    throw new ValidationError('INVALID_FREQUENCY', { values: FREQUENCIES.join(', ') });
  }
  if (!(FREQUENCIES as readonly string[]).includes(input)) {
    throw new ValidationError('INVALID_FREQUENCY', { values: FREQUENCIES.join(', ') });
  }
  return input as Frequency;
}

function normalizeIntervalCount(input: unknown): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > 365) {
    throw new ValidationError('INVALID_INTERVAL_COUNT');
  }
  return input;
}

// day_of_month/month_of_year — общая форма: число в границах CHECK'а схемы
// или null. undefined приравнен к null — на POST оба означают «поле не
// пришло», а в PATCH-цикле этот путь недостижим (туда попадают только поля,
// реально пришедшие в теле, см. `field in body` ниже).
function normalizeNullableInteger(input: unknown, field: string, min: number, max: number): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
    throw new ValidationError('INVALID_RANGE', { field, min, max });
  }
  return input;
}

function dayFromDateString(date: string): number {
  return Number(date.slice(8, 10));
}

function monthFromDateString(date: string): number {
  return Number(date.slice(5, 7));
}

/**
 * Якоря для НОВОЙ строки (POST). day_of_month: явный или выведенный из дня
 * next_due_date. month_of_year года — производный от next_due_date всегда;
 * явное значение принимается, только если совпадает с производным (CONSTRAINT
 * миграции 0003 требует ровно этого, и не только на INSERT).
 */
function computeAnchorsForCreate(
  frequency: Frequency,
  dayOfMonthRaw: unknown,
  monthOfYearRaw: unknown,
  nextDueDate: string,
): { dayOfMonth: number | null; monthOfYear: number | null } {
  const dayOfMonth = normalizeNullableInteger(dayOfMonthRaw, 'day_of_month', 1, 31);
  const monthOfYear = normalizeNullableInteger(monthOfYearRaw, 'month_of_year', 1, 12);

  if (frequency === 'daily' || frequency === 'weekly') {
    if (dayOfMonth !== null) {
      throw new ValidationError('FREQUENCY_DAY_FORBIDDEN');
    }
    if (monthOfYear !== null) {
      throw new ValidationError('FREQUENCY_MONTH_FORBIDDEN');
    }
    return { dayOfMonth: null, monthOfYear: null };
  }

  const effectiveDayOfMonth = dayOfMonth ?? dayFromDateString(nextDueDate);

  if (frequency === 'monthly') {
    if (monthOfYear !== null) {
      throw new ValidationError('FREQUENCY_MONTH_YEARLY_ONLY');
    }
    return { dayOfMonth: effectiveDayOfMonth, monthOfYear: null };
  }

  // yearly
  const derivedMonth = monthFromDateString(nextDueDate);
  if (monthOfYear !== null && monthOfYear !== derivedMonth) {
    throw new ValidationError('FREQUENCY_MONTH_DERIVED', { month: derivedMonth });
  }
  return { dayOfMonth: effectiveDayOfMonth, monthOfYear: derivedMonth };
}

/**
 * Якоря для ПРАВКИ существующей строки (PATCH) — правило считается целиком:
 * эффективная частота решает, какие якоря обязательны, а `dayProvided`/
 * `monthProvided` отличают «клиент не тронул поле» (наследуем от старой
 * строки или выводим из даты) от «клиент явно передал» (в т. ч. явный null —
 * это отказ, если частота требует значение). Смена frequency, не трогающая
 * сами якоря явно, обязана сама решить их судьбу — иначе PATCH
 * `{ frequency: 'daily' }` на месячном правиле упёрся бы в CHECK схемы вместо
 * внятного результата (докблок раздела).
 */
function computeEffectiveAnchors(
  frequency: Frequency,
  dayProvided: boolean,
  dayValue: number | null,
  monthProvided: boolean,
  monthValue: number | null,
  currentFrequency: Frequency,
  currentDayOfMonth: number | null,
  nextDueDate: string,
): { dayOfMonth: number | null; monthOfYear: number | null } {
  if (frequency === 'daily' || frequency === 'weekly') {
    if (dayProvided && dayValue !== null) {
      throw new ValidationError('FREQUENCY_DAY_FORBIDDEN');
    }
    if (monthProvided && monthValue !== null) {
      throw new ValidationError('FREQUENCY_MONTH_FORBIDDEN');
    }
    return { dayOfMonth: null, monthOfYear: null };
  }

  let dayOfMonth: number;
  if (dayProvided) {
    if (dayValue === null) throw new ValidationError('FREQUENCY_DAY_REQUIRED', { frequency });
    dayOfMonth = dayValue;
  } else if (currentFrequency === 'monthly' || currentFrequency === 'yearly') {
    // Правило уже несло якорь — переносим его как есть. Это и есть «скользящая
    // дата не двигает day_of_month»: 31 числа, один раз прижатое к 28 февраля,
    // не должно навсегда остаться 28-м (докблок 0001). current.day_of_month
    // здесь гарантированно не NULL — того требует сама схема для этих частот.
    dayOfMonth = currentDayOfMonth as number;
  } else {
    dayOfMonth = dayFromDateString(nextDueDate);
  }

  if (frequency === 'monthly') {
    if (monthProvided && monthValue !== null) {
      throw new ValidationError('FREQUENCY_MONTH_YEARLY_ONLY');
    }
    return { dayOfMonth, monthOfYear: null };
  }

  // yearly — month_of_year производный от next_due_date ВСЕГДА, даже когда
  // клиент его не трогал: перенос даты в другой месяц обязан перенести якорь
  // за собой одним и тем же PATCH (докблок миграции 0003).
  const derivedMonth = monthFromDateString(nextDueDate);
  if (monthProvided && monthValue !== null && monthValue !== derivedMonth) {
    throw new ValidationError('FREQUENCY_MONTH_DERIVED', { month: derivedMonth });
  }
  return { dayOfMonth, monthOfYear: derivedMonth };
}

interface RecurringItemRow {
  id: number;
  revision: string;
  title: string;
  amount_minor: number;
  currency: string;
  account_id: number;
  category: string | null;
  frequency: string;
  interval_count: number;
  day_of_month: number | null;
  month_of_year: number | null;
  next_due_date: string;
  end_date: string | null;
  active: number;
}

interface RecurringFulfillmentJson {
  recurring_item_id: number;
  period_due_date: string;
  outcome: 'materialized' | 'linked' | 'skipped';
  evidence_quantity: number;
  operation_ids: number[];
  fulfilled_at: string;
}

function toRecurringItemJson(row: RecurringItemRow, lastFulfillment?: RecurringFulfillmentJson | null) {
  return {
    id: row.id,
    title: row.title,
    amount_minor: row.amount_minor,
    currency: row.currency,
    account_id: row.account_id,
    category: row.category,
    frequency: row.frequency,
    interval_count: row.interval_count,
    day_of_month: row.day_of_month,
    month_of_year: row.month_of_year,
    next_due_date: row.next_due_date,
    end_date: row.end_date,
    active: row.active === 1,
    last_fulfillment: lastFulfillment ?? null,
  };
}

async function listRecurringFulfillments(db: D1Database, recurringItemId?: number): Promise<RecurringFulfillmentJson[]> {
  const where = recurringItemId === undefined ? '' : ' WHERE recurring_item_id = ?';
  const parentQuery = db.prepare(
    `SELECT * FROM recurring_period_fulfillments${where}
     ORDER BY period_due_date DESC, recurring_item_id ASC`,
  );
  const linkQuery = db.prepare(
    `SELECT * FROM operation_fulfillment_links${where}
     ORDER BY operation_id ASC`,
  );
  const [parents, links] = recurringItemId === undefined
    ? await db.batch<RecurringPeriodFulfillmentRow & OperationFulfillmentLinkRow>([parentQuery, linkQuery])
    : await db.batch<RecurringPeriodFulfillmentRow & OperationFulfillmentLinkRow>([
        parentQuery.bind(recurringItemId), linkQuery.bind(recurringItemId),
      ]);
  const operations = new Map<string, number[]>();
  for (const raw of links.results) {
    const link = raw as unknown as OperationFulfillmentLinkRow;
    if (link.recurring_item_id === null || link.period_due_date === null) continue;
    const key = `${link.recurring_item_id}:${link.period_due_date}`;
    const ids = operations.get(key) ?? [];
    ids.push(link.operation_id);
    operations.set(key, ids);
  }
  return parents.results.map((raw) => {
    const row = raw as unknown as RecurringPeriodFulfillmentRow;
    return {
      recurring_item_id: row.recurring_item_id,
      period_due_date: row.period_due_date,
      outcome: row.outcome,
      evidence_quantity: row.evidence_quantity,
      operation_ids: operations.get(`${row.recurring_item_id}:${row.period_due_date}`) ?? [],
      fulfilled_at: row.fulfilled_at,
    };
  });
}

apiV2.get('/recurring-items', async (c) => {
  const [items, fulfillments] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM recurring_items ORDER BY active DESC, next_due_date ASC, id ASC').all<RecurringItemRow>(),
    listRecurringFulfillments(c.env.DB),
  ]);
  const lastByItem = new Map<number, RecurringFulfillmentJson>();
  for (const fulfillment of fulfillments) {
    if (!lastByItem.has(fulfillment.recurring_item_id)) lastByItem.set(fulfillment.recurring_item_id, fulfillment);
  }
  return c.json({
    recurring_items: items.results.map((row) => toRecurringItemJson(row, lastByItem.get(row.id))),
  });
});

apiV2.get('/recurring-fulfillments', async (c) => {
  const rawId = c.req.query('recurring_item_id');
  let recurringItemId: number | undefined;
  if (rawId !== undefined) {
    const parsed = Number(rawId);
    if (!Number.isInteger(parsed) || parsed <= 0) return fail(c, 'INVALID_RECURRING_ITEM_ID', 400);
    recurringItemId = parsed;
  }
  return c.json({ recurring_fulfillments: await listRecurringFulfillments(c.env.DB, recurringItemId) });
});

apiV2.post('/recurring-items', async (c) => {
  try {
    const body = await readBody(c);
    const title = normalizeRequiredText(body.title, 'title');
    const amountMinor = normalizeAmountMinor(body.amount_minor, 'amount_minor');
    const accountId = normalizeAccountId(body.account_id);
    const account = await loadAccountForReference(c.env.DB, accountId);
    if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    const frequency = normalizeFrequency(body.frequency);
    const nextDueDate = normalizeDateString(body.next_due_date, 'next_due_date');
    const currency = body.currency === undefined ? account.currency : normalizeCurrency(body.currency);
    const category = normalizeOptionalText(body.category, 'category');
    const intervalCount = body.interval_count === undefined ? 1 : normalizeIntervalCount(body.interval_count);
    const active = body.active === undefined ? 1 : normalizeBoolean(body.active, 'active');
    const endDate = normalizeNullableDateString(body.end_date, 'end_date');
    if (endDate !== null && endDate < nextDueDate) {
      throw new ValidationError('RECURRING_END_BEFORE_NEXT');
    }
    const { dayOfMonth, monthOfYear } = computeAnchorsForCreate(frequency, body.day_of_month, body.month_of_year, nextDueDate);

    const row = await c.env.DB.prepare(
      `INSERT INTO recurring_items
         (title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date, active, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, lower(hex(randomblob(16))))
       RETURNING *`,
    )
      .bind(
        title,
        amountMinor,
        currency,
        accountId,
        category,
        frequency,
        intervalCount,
        dayOfMonth,
        monthOfYear,
        nextDueDate,
        endDate,
        active,
      )
      .first<RecurringItemRow>();
    return c.json({ recurring_item: toRecurringItemJson(row!) }, 201);
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }
});

const RECURRING_PATCH_FIELDS = [
  'title',
  'amount_minor',
  'currency',
  'account_id',
  'category',
  'frequency',
  'interval_count',
  'day_of_month',
  'month_of_year',
  'next_due_date',
  'end_date',
  'active',
] as const;

apiV2.patch('/recurring-items/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const updates = new Map<(typeof RECURRING_PATCH_FIELDS)[number], unknown>();
  let expectedSnapshot: unknown;
  try {
    const body = await readBody(c);
    expectedSnapshot = body.__mcp_expected_snapshot;
    for (const field of RECURRING_PATCH_FIELDS) {
      if (!(field in body)) continue;
      let value: unknown;
      switch (field) {
        case 'title':
          value = normalizeRequiredText(body.title, 'title');
          break;
        case 'amount_minor':
          value = normalizeAmountMinor(body.amount_minor, 'amount_minor');
          break;
        case 'currency':
          value = normalizeCurrency(body.currency);
          break;
        case 'account_id':
          value = normalizeAccountId(body.account_id);
          break;
        case 'category':
          value = normalizeOptionalText(body.category, 'category');
          break;
        case 'frequency':
          value = normalizeFrequency(body.frequency);
          break;
        case 'interval_count':
          value = normalizeIntervalCount(body.interval_count);
          break;
        case 'day_of_month':
          value = normalizeNullableInteger(body.day_of_month, 'day_of_month', 1, 31);
          break;
        case 'month_of_year':
          value = normalizeNullableInteger(body.month_of_year, 'month_of_year', 1, 12);
          break;
        case 'next_due_date':
          value = normalizeDateString(body.next_due_date, 'next_due_date');
          break;
        case 'end_date':
          value = normalizeNullableDateString(body.end_date, 'end_date');
          break;
        case 'active':
          value = normalizeBoolean(body.active, 'active');
          break;
      }
      updates.set(field, value);
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  if (updates.size === 0) {
    return fail(c, 'NO_PATCH_FIELDS', 400);
  }

  const current = await c.env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
    .bind(id)
    .first<RecurringItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (expectedSnapshot !== undefined && !recurringSnapshotMatches(current, expectedSnapshot, 'recurring_item')) {
    return fail(c, 'RECURRING_ITEM_STALE', 409);
  }

  try {
    if (updates.has('account_id')) {
      const account = await loadAccountForReference(c.env.DB, updates.get('account_id') as number);
      if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    }

    if (updates.has('currency') && updates.get('currency') !== current.currency && !updates.has('amount_minor')) {
      throw new ValidationError('CURRENCY_CHANGE_REQUIRES_AMOUNT');
    }

    // effectiveNextDueDate нужен и якорям, и проверке end_date — считаем один раз.
    const effectiveNextDueDate = updates.has('next_due_date')
      ? (updates.get('next_due_date') as string)
      : current.next_due_date;

    // Правило считается ЦЕЛИКОМ: ни одно из четырёх полей не валидно без
    // остальных трёх (докблок раздела), поэтому пересчёт срабатывает, если
    // тронуто хотя бы одно из них, и переписывает day_of_month/month_of_year
    // оба сразу — даже то поле, которое клиент не назвал явно.
    const ruleTouched =
      updates.has('frequency') ||
      updates.has('day_of_month') ||
      updates.has('month_of_year') ||
      updates.has('next_due_date');
    if (ruleTouched) {
      const effectiveFrequency = (updates.has('frequency') ? updates.get('frequency') : current.frequency) as Frequency;
      const dayProvided = updates.has('day_of_month');
      const dayValue = (dayProvided ? updates.get('day_of_month') : null) as number | null;
      const monthProvided = updates.has('month_of_year');
      const monthValue = (monthProvided ? updates.get('month_of_year') : null) as number | null;

      const { dayOfMonth, monthOfYear } = computeEffectiveAnchors(
        effectiveFrequency,
        dayProvided,
        dayValue,
        monthProvided,
        monthValue,
        current.frequency as Frequency,
        current.day_of_month,
        effectiveNextDueDate,
      );
      updates.set('day_of_month', dayOfMonth);
      updates.set('month_of_year', monthOfYear);
    }

    // end_date держит СВОЙ инвариант (>= next_due_date) на любом UPDATE строки
    // (докблок 0002), а не только когда его меняют явно: продвинуть якорь за
    // уже стоящий срок отдельным PATCH нельзя — отвечаем 400 раньше отказа схемы.
    if (updates.has('next_due_date') || updates.has('end_date')) {
      const effectiveEndDate = updates.has('end_date') ? (updates.get('end_date') as string | null) : current.end_date;
      if (effectiveEndDate !== null && effectiveEndDate < effectiveNextDueDate) {
        throw new ValidationError('RECURRING_END_BEFORE_NEXT');
      }
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of updates) {
    if (value === current[field as keyof RecurringItemRow]) continue;
    setClauses.push(`${field} = ?`);
    values.push(value);
  }

  if (setClauses.length === 0) {
    return c.json({ recurring_item: toRecurringItemJson(current) });
  }

  const row = await c.env.DB.prepare(
    `UPDATE recurring_items SET ${setClauses.join(', ')} WHERE ${RECURRING_SNAPSHOT_WHERE} RETURNING *`,
  )
    .bind(...values, ...recurringSnapshotBinds(current))
    .first<RecurringItemRow>();
  if (!row) {
    const exists = await c.env.DB.prepare('SELECT id FROM recurring_items WHERE id = ?').bind(id).first<{ id: number }>();
    return exists
      ? fail(c, 'RECURRING_ITEM_STALE', 409)
      : fail(c, 'NOT_FOUND', 404);
  }
  return c.json({ recurring_item: toRecurringItemJson(row) });
});

apiV2.delete('/recurring-items/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const body = await readBody(c);
  const expectedSnapshot = body.__mcp_expected_snapshot;
  const current = await c.env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?').bind(id).first<RecurringItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (expectedSnapshot !== undefined && !recurringSnapshotMatches(current, expectedSnapshot, 'recurring_item')) {
    return fail(c, 'RECURRING_ITEM_STALE', 409);
  }

  const deleted = expectedSnapshot === undefined
    ? await c.env.DB.prepare('DELETE FROM recurring_items WHERE id = ?').bind(id).run()
    : await c.env.DB.prepare(`DELETE FROM recurring_items WHERE ${RECURRING_SNAPSHOT_WHERE}`).bind(...recurringSnapshotBinds(current)).run();
  if (deleted.meta.changes === 0) {
    const exists = await c.env.DB.prepare('SELECT id FROM recurring_items WHERE id = ?').bind(id).first<{ id: number }>();
    return exists
      ? fail(c, 'RECURRING_ITEM_STALE', 409)
      : fail(c, 'NOT_FOUND', 404);
  }
  return c.body(null, 204);
});

const RECURRING_SNAPSHOT_WHERE = `id = ? AND revision IS ? AND title = ? AND amount_minor = ? AND currency = ?
  AND account_id = ? AND category IS ? AND frequency = ? AND interval_count = ?
  AND day_of_month IS ? AND month_of_year IS ? AND next_due_date = ? AND end_date IS ? AND active = ?`;

function recurringSnapshotBinds(row: RecurringItemRow): unknown[] {
  return [
    row.id, row.revision, row.title, row.amount_minor, row.currency, row.account_id, row.category,
    row.frequency, row.interval_count, row.day_of_month, row.month_of_year,
    row.next_due_date, row.end_date, row.active,
  ];
}

function recurringSnapshotMatches(
  row: RecurringItemRow,
  snapshot: unknown,
  type: 'recurring_item' | 'recurring_close' | 'recurring_skip' | 'recurring_fulfill' | 'recurring_cancel',
): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const value = snapshot as Record<string, unknown>;
  return value.type === type
    && value.id === row.id
    && value.revision === row.revision
    && value.title === row.title
    && value.amount_minor === row.amount_minor
    && value.currency === row.currency
    && value.account_id === row.account_id
    && value.category === row.category
    && value.frequency === row.frequency
    && value.interval_count === row.interval_count
    && value.day_of_month === row.day_of_month
    && value.month_of_year === row.month_of_year
    && value.next_due_date === row.next_due_date
    && value.end_date === row.end_date
    && value.active === row.active;
}

// Закрытие периода регулярного платежа (issue #280): порождает операцию-факт
// (source = 'recurring'), двигает баланс счёта и сдвигает скользящий якорь
// `next_due_date` на следующее вхождение (nextOccurrence).
//
// Если следующее вхождение выходит за `end_date`, правило деактивируется
// (active = 0), а дата якоря остаётся в границах CHECK'а.
apiV2.post('/recurring-items/:id/close-period', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const current = await c.env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
    .bind(id)
    .first<RecurringItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (isAnalyticalSkipOnlyRecurringId(id)) {
    return fail(c, 'ANALYTICAL_RECURRING_SKIP_ONLY', 409, { recurringItemId: id });
  }
  if (current.active !== 1) return fail(c, 'RECURRING_ITEM_INACTIVE_CLOSE', 409);

  let date: string;
  let amountMinor: number;
  let accountId: number;
  let item: string;
  let category: string | null;
  let subcategory: string | null;
  let accountCurrency: string;
  let expectedSnapshot: unknown;

  try {
    const body = await readBody(c);
    expectedSnapshot = body.__mcp_expected_snapshot;
    date = body.date === undefined ? current.next_due_date : normalizeDateString(body.date, 'date');
    amountMinor = body.amount_minor === undefined ? current.amount_minor : normalizeAmountMinor(body.amount_minor, 'amount_minor');
    accountId = body.account_id === undefined ? current.account_id : normalizeAccountId(body.account_id);
    item = body.item === undefined ? current.title : normalizeRequiredText(body.item, 'item');
    category = body.category === undefined ? current.category : normalizeOptionalText(body.category, 'category');
    subcategory = body.subcategory === undefined ? null : normalizeOptionalText(body.subcategory, 'subcategory');

    const kind: OperationKind = amountMinor < 0 ? 'expense' : 'income';
    assertSignMatchesKind(kind, amountMinor);
    assertSubcategoryHasCategory(category, subcategory);

    const account = await loadAccountForReference(c.env.DB, accountId);
    if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    accountCurrency = account.currency;

    if (current.currency !== account.currency) {
      throw new ValidationError('RECURRING_CURRENCY_MISMATCH', {
        accountCurrency: account.currency,
        ruleCurrency: current.currency,
      });
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  if (expectedSnapshot !== undefined && !recurringSnapshotMatches(current, expectedSnapshot, 'recurring_close')) {
    return fail(c, 'RECURRING_ITEM_STALE', 409);
  }

  if (amountMinor < 0) {
    const duplicateId = await findDuplicateExpenseId(c.env.DB, {
      date,
      account_id: accountId,
      store: null,
      amount_minor: amountMinor,
      item,
      comment: null,
      fiscal_receipt_id: null,
    });
    if (duplicateId !== null) {
      return fail(c, 'DUPLICATE_EXPENSE', 409, { existingOperationId: duplicateId });
    }
  }

  const rule: RecurringRule = {
    id: current.id,
    frequency: current.frequency as Frequency,
    interval_count: current.interval_count,
    day_of_month: current.day_of_month,
    month_of_year: current.month_of_year,
    next_due_date: current.next_due_date,
    end_date: current.end_date,
  };

  const nextDate = nextOccurrence(rule, current.next_due_date);
  const isFinished = current.end_date !== null && nextDate > current.end_date;

  const kind: OperationKind = amountMinor < 0 ? 'expense' : 'income';

  const updateRecurringStmt = isFinished
    ? c.env.DB.prepare(
        `UPDATE recurring_items SET active = 0
         WHERE ${RECURRING_SNAPSHOT_WHERE}
         RETURNING *`,
      ).bind(...recurringSnapshotBinds(current))
    : c.env.DB.prepare(
        `UPDATE recurring_items SET next_due_date = ?
         WHERE ${RECURRING_SNAPSHOT_WHERE}
         RETURNING *`,
      ).bind(nextDate, ...recurringSnapshotBinds(current));

  // CAS rule update starts the chain. No later effect runs unless the exact
  // confirmed rule snapshot was still current at the transactional write.
  const insertFulfillmentStmt = c.env.DB.prepare(
    `INSERT INTO recurring_period_fulfillments
       (recurring_item_id, period_due_date, outcome, fulfilled_at)
     SELECT ?, ?, 'materialized', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE changes() = 1`,
  ).bind(id, current.next_due_date);

  const insertOpStmt = c.env.DB.prepare(
    `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, recurring_item_id)
     SELECT ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'recurring', ?
     WHERE changes() = 1
     RETURNING *`,
  ).bind(date, accountId, kind, item, category, subcategory, amountMinor, id);

  const insertOperationLinkStmt = c.env.DB.prepare(
    `INSERT INTO operation_fulfillment_links
       (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
     SELECT last_insert_rowid(), NULL, ?, ?, 'materialized', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE changes() = 1`,
  ).bind(id, current.next_due_date);

  const updateBalanceStmt = c.env.DB.prepare(
    'UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ? AND changes() = 1 AND (balance_minor + ?) BETWEEN ? AND ?',
  ).bind(amountMinor, accountId, amountMinor, SAFE_MINOR_MIN, SAFE_MINOR_MAX);

  let batchResults: D1Result<OperationRow & RecurringItemRow>[];
  try {
    batchResults = await c.env.DB.batch<OperationRow & RecurringItemRow>([
      updateRecurringStmt,
      insertFulfillmentStmt,
      insertOpStmt,
      insertOperationLinkStmt,
      updateBalanceStmt,
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed:.*recurring_period_fulfillments/i.test(message)) {
      return fail(c, 'RECURRING_PERIOD_ALREADY_CLOSED', 409);
    }
    throw e;
  }

  const [updatedRecurring, , insertedOp, , balanceRes] = batchResults;
  const recurringRow = updatedRecurring.results[0] as unknown as RecurringItemRow | undefined;
  const opRow = insertedOp.results[0] as unknown as OperationRow | undefined;
  if (!recurringRow || !opRow) {
    return fail(c, 'CONCURRENT_UPDATE', 409);
  }
  if (!ledgerApplied(balanceRes)) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM operation_fulfillment_links WHERE operation_id = ?').bind(opRow.id),
      c.env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(opRow.id),
      c.env.DB.prepare('DELETE FROM recurring_period_fulfillments WHERE recurring_item_id = ? AND period_due_date = ?')
        .bind(id, current.next_due_date),
      c.env.DB.prepare('UPDATE recurring_items SET next_due_date = ?, active = ? WHERE id = ?')
        .bind(current.next_due_date, current.active, id),
    ]);
    return fail(c, 'LEDGER_EFFECT_MISSING', 409);
  }

  return c.json(
    {
      recurring_item: toRecurringItemJson(recurringRow),
      operation: toOperationJson({ ...opRow, currency: accountCurrency }),
    },
    201,
  );
});

apiV2.post('/recurring-items/:id/fulfill-existing', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  let periodDueDate: string;
  let operationIds: number[];
  let evidenceQuantity: number;
  let expectedSnapshot: unknown;
  try {
    const body = await readBody(c);
    expectedSnapshot = body.__mcp_expected_snapshot;
    periodDueDate = normalizeDateString(body.period_due_date, 'period_due_date');
    if (!Array.isArray(body.operation_ids) || body.operation_ids.length === 0 || body.operation_ids.length > 100) {
      throw new ValidationError('OPERATION_IDS_INVALID');
    }
    operationIds = body.operation_ids.map((value) => normalizeAccountId(value));
    if (new Set(operationIds).size !== operationIds.length) {
      throw new ValidationError('OPERATION_IDS_DUPLICATE');
    }
    operationIds.sort((a, b) => a - b);
    evidenceQuantity = body.evidence_quantity === undefined
      ? 1
      : normalizeAccountId(body.evidence_quantity);
    if (evidenceQuantity > 100) {
      throw new ValidationError('EVIDENCE_QUANTITY_INVALID');
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const current = await c.env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
    .bind(id).first<RecurringItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (isAnalyticalSkipOnlyRecurringId(id)) {
    return fail(c, 'ANALYTICAL_RECURRING_SKIP_ONLY', 409, { recurringItemId: id });
  }

  const prior = (await listRecurringFulfillments(c.env.DB, id))
    .find((item) => item.period_due_date === periodDueDate);
  if (prior) {
    const priorIds = [...prior.operation_ids].sort((a, b) => a - b);
    if (
      prior.outcome === 'linked'
      && prior.evidence_quantity === evidenceQuantity
      && JSON.stringify(priorIds) === JSON.stringify(operationIds)
    ) {
      return c.json({
        status: 'already-linked',
        evidence_quantity: prior.evidence_quantity,
        recurring_item: toRecurringItemJson(current, prior),
        fulfillment: prior,
      });
    }
    return fail(c, 'RECURRING_OCCURRENCE_ALREADY_FULFILLED', 409);
  }
  if (current.active !== 1) return fail(c, 'RECURRING_ITEM_INACTIVE_FULFILL', 409);
  if (current.next_due_date !== periodDueDate) {
    return fail(c, 'RECURRING_PERIOD_MISMATCH', 409);
  }
  if (expectedSnapshot !== undefined && !recurringSnapshotMatches(current, expectedSnapshot, 'recurring_fulfill')) {
    return fail(c, 'RECURRING_ITEM_STALE', 409);
  }

  const placeholders = operationIds.map(() => '?').join(', ');
  const { results: operations } = await c.env.DB.prepare(
    `${OPERATION_SELECT} WHERE o.id IN (${placeholders}) ORDER BY o.id ASC`,
  ).bind(...operationIds).all<OperationRowWithCurrency>();
  if (operations.length !== operationIds.length) return fail(c, 'OPERATIONS_NOT_FOUND', 404);

  const { results: claims } = await c.env.DB.prepare(
    `SELECT * FROM operation_fulfillment_links WHERE operation_id IN (${placeholders})`,
  ).bind(...operationIds).all<OperationFulfillmentLinkRow>();
  if (claims.length > 0) return fail(c, 'OPERATIONS_ALREADY_CLAIMED', 409);

  try {
    for (const operation of operations) {
      if (operation.transfer_id !== null) throw new ValidationError('TRANSFER_CANNOT_FULFILL_RECURRING');
      const expectedKind = current.amount_minor < 0 ? 'expense' : 'income';
      if (operation.kind !== expectedKind) throw new ValidationError('FULFILLMENT_KIND_MISMATCH');
      if (operation.account_id !== current.account_id) throw new ValidationError('FULFILLMENT_ACCOUNT_MISMATCH');
      if (operation.currency !== current.currency) throw new ValidationError('FULFILLMENT_CURRENCY_MISMATCH');
      if (Math.sign(operation.amount_minor) !== Math.sign(current.amount_minor)) {
        throw new ValidationError('FULFILLMENT_SIGN_MISMATCH');
      }
      if (operation.date !== periodDueDate) throw new ValidationError('FULFILLMENT_DATE_MISMATCH');
      if (current.category !== null && operation.category !== current.category) {
        throw new ValidationError('FULFILLMENT_CATEGORY_MISMATCH');
      }
    }
    const aggregateAmount = operations.reduce((sum, operation) => sum + operation.amount_minor, 0);
    const expectedAmount = current.amount_minor * evidenceQuantity;
    if (!Number.isSafeInteger(aggregateAmount) || !Number.isSafeInteger(expectedAmount) || aggregateAmount !== expectedAmount) {
      throw new ValidationError('FULFILLMENT_EVIDENCE_AMOUNT_MISMATCH');
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const rule: RecurringRule = {
    id: current.id,
    frequency: current.frequency as Frequency,
    interval_count: current.interval_count,
    day_of_month: current.day_of_month,
    month_of_year: current.month_of_year,
    next_due_date: current.next_due_date,
    end_date: current.end_date,
  };
  const nextDate = nextOccurrence(rule, periodDueDate);
  const isFinished = current.end_date !== null && nextDate > current.end_date;

  const opPlaceholders = operationIds.map(() => '?').join(', ');
  const expectedAmount = current.amount_minor * evidenceQuantity;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments
         (recurring_item_id, period_due_date, outcome, evidence_quantity, fulfilled_at)
       SELECT ?, ?, 'linked', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE (SELECT COUNT(*) FROM operations WHERE id IN (${opPlaceholders})) = ?
         AND (SELECT COALESCE(SUM(amount_minor), 0) FROM operations WHERE id IN (${opPlaceholders})) = ?
         AND NOT EXISTS (
           SELECT 1 FROM recurring_period_fulfillments
           WHERE recurring_item_id = ? AND period_due_date = ?
         )
       RETURNING recurring_item_id`,
    ).bind(
      id,
      periodDueDate,
      evidenceQuantity,
      ...operationIds,
      operationIds.length,
      ...operationIds,
      expectedAmount,
      id,
      periodDueDate,
    ),
  ];
  for (const operationId of operationIds) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO operation_fulfillment_links
           (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
         SELECT ?, NULL, ?, ?, 'linked', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         FROM operations o
         JOIN recurring_items r ON r.id = ?
         JOIN accounts a ON a.id = o.account_id
         WHERE o.id = ?
           AND o.transfer_id IS NULL
           AND o.account_id = r.account_id
           AND a.currency = r.currency
           AND o.date = ?
           AND o.kind = CASE WHEN r.amount_minor < 0 THEN 'expense' ELSE 'income' END
           AND ((r.amount_minor < 0 AND o.amount_minor < 0) OR (r.amount_minor > 0 AND o.amount_minor > 0))
           AND (r.category IS NULL OR o.category = r.category)
           AND NOT EXISTS (SELECT 1 FROM operation_fulfillment_links l WHERE l.operation_id = o.id)
           AND EXISTS (
             SELECT 1 FROM recurring_period_fulfillments
             WHERE recurring_item_id = ? AND period_due_date = ? AND outcome = 'linked'
           )
         RETURNING operation_id`,
      ).bind(operationId, id, periodDueDate, id, operationId, periodDueDate, id, periodDueDate),
    );
  }
  statements.push(
    isFinished
      ? c.env.DB.prepare(
          `UPDATE recurring_items SET active = 0
           WHERE ${RECURRING_SNAPSHOT_WHERE}
             AND EXISTS (
               SELECT 1 FROM recurring_period_fulfillments
               WHERE recurring_item_id = ? AND period_due_date = ? AND outcome = 'linked'
             )
             AND (SELECT COUNT(*) FROM operation_fulfillment_links
                  WHERE recurring_item_id = ? AND period_due_date = ?) = ?
           RETURNING *`,
        ).bind(...recurringSnapshotBinds(current), id, periodDueDate, id, periodDueDate, operationIds.length)
      : c.env.DB.prepare(
          `UPDATE recurring_items SET next_due_date = ?
           WHERE ${RECURRING_SNAPSHOT_WHERE}
             AND EXISTS (
               SELECT 1 FROM recurring_period_fulfillments
               WHERE recurring_item_id = ? AND period_due_date = ? AND outcome = 'linked'
             )
             AND (SELECT COUNT(*) FROM operation_fulfillment_links
                  WHERE recurring_item_id = ? AND period_due_date = ?) = ?
           RETURNING *`,
        ).bind(nextDate, ...recurringSnapshotBinds(current), id, periodDueDate, id, periodDueDate, operationIds.length),
  );

  let updated: RecurringItemRow | undefined;
  try {
    const results = await c.env.DB.batch<RecurringItemRow>(statements);
    const parentInserted = results[0]?.results?.length ?? 0;
    const linksOk = results.slice(1, -1).every((row) => (row.results?.length ?? 0) === 1);
    updated = results[results.length - 1]?.results[0];
    if (!updated || parentInserted !== 1 || !linksOk) {
      // Roll back only this request's evidence. A concurrent winner's parent
      // for the same period must stay; orphan links from a lost parent insert
      // are removed by operation id.
      if (parentInserted === 1) {
        await c.env.DB.batch([
          c.env.DB.prepare(
            'DELETE FROM operation_fulfillment_links WHERE recurring_item_id = ? AND period_due_date = ?',
          ).bind(id, periodDueDate),
          c.env.DB.prepare(
            'DELETE FROM recurring_period_fulfillments WHERE recurring_item_id = ? AND period_due_date = ?',
          ).bind(id, periodDueDate),
        ]);
      } else if (operationIds.length > 0) {
        const placeholders = operationIds.map(() => '?').join(', ');
        await c.env.DB.prepare(
          `DELETE FROM operation_fulfillment_links WHERE operation_id IN (${placeholders})`,
        ).bind(...operationIds).run();
      }
      return fail(c, 'CONCURRENT_UPDATE', 409);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed/i.test(message)) {
      return fail(c, 'FULFILLMENT_CONFLICT', 409);
    }
    throw e;
  }
  if (!updated) return fail(c, 'CONCURRENT_UPDATE', 409);

  const fulfillment = (await listRecurringFulfillments(c.env.DB, id))
    .find((item) => item.period_due_date === periodDueDate)!;
  return c.json({
    status: 'linked',
    evidence_quantity: evidenceQuantity,
    recurring_item: toRecurringItemJson(updated, fulfillment),
    fulfillment,
    operations: operations.map((operation) => toOperationJson(operation)),
  }, 201);
});

// Пропуск периода регулярного платежа (issue #280): сдвигает якорь на следующее
// вхождение без создания операции и без изменения баланса.
apiV2.post('/recurring-items/:id/skip-period', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const current = await c.env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
    .bind(id)
    .first<RecurringItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (current.active !== 1) return fail(c, 'RECURRING_ITEM_INACTIVE_SKIP', 409);

  let expectedSnapshot: unknown;
  try {
    const rawBody = await c.req.raw.clone().text();
    if (rawBody.trim().length > 0) {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      expectedSnapshot = body.__mcp_expected_snapshot;
    }
  } catch {
    return fail(c, 'INVALID_JSON', 400);
  }
  if (expectedSnapshot !== undefined && !recurringSnapshotMatches(current, expectedSnapshot, 'recurring_skip')) {
    return fail(c, 'RECURRING_ITEM_STALE', 409);
  }

  const rule: RecurringRule = {
    id: current.id,
    frequency: current.frequency as Frequency,
    interval_count: current.interval_count,
    day_of_month: current.day_of_month,
    month_of_year: current.month_of_year,
    next_due_date: current.next_due_date,
    end_date: current.end_date,
  };

  const nextDate = nextOccurrence(rule, current.next_due_date);
  const isFinished = current.end_date !== null && nextDate > current.end_date;

  const update = isFinished
    ? c.env.DB.prepare(
        `UPDATE recurring_items SET active = 0
         WHERE ${RECURRING_SNAPSHOT_WHERE}
         RETURNING *`,
      ).bind(...recurringSnapshotBinds(current))
    : c.env.DB.prepare(
        `UPDATE recurring_items SET next_due_date = ?
         WHERE ${RECURRING_SNAPSHOT_WHERE}
         RETURNING *`,
      ).bind(nextDate, ...recurringSnapshotBinds(current));

  let results: D1Result<RecurringItemRow>[];
  try {
    results = await c.env.DB.batch<RecurringItemRow>([
      update,
      c.env.DB.prepare(
        `INSERT INTO recurring_period_fulfillments
           (recurring_item_id, period_due_date, outcome, fulfilled_at)
         SELECT ?, ?, 'skipped', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE changes() = 1`,
      ).bind(id, current.next_due_date),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed:.*recurring_period_fulfillments/i.test(message)) {
      return fail(c, 'RECURRING_PERIOD_ALREADY_RESOLVED', 409);
    }
    throw e;
  }
  const row = results[0]?.results[0];

  if (!row) {
    const exists = await c.env.DB.prepare('SELECT id FROM recurring_items WHERE id = ?').bind(id).first<{ id: number }>();
    return exists
      ? fail(c, 'CONCURRENT_UPDATE', 409)
      : fail(c, 'NOT_FOUND', 404);
  }
  const fulfillment = (await listRecurringFulfillments(c.env.DB, id))
    .find((item) => item.period_due_date === current.next_due_date);
  return c.json({ recurring_item: toRecurringItemJson(row, fulfillment), fulfillment });
});

function recurringCancelRewindTarget(
  current: RecurringItemRow,
  periodDueDate: string,
): { nextDueDate: string; active: number } | null {
  const rule: RecurringRule = {
    id: current.id,
    frequency: current.frequency as Frequency,
    interval_count: current.interval_count,
    day_of_month: current.day_of_month,
    month_of_year: current.month_of_year,
    next_due_date: periodDueDate,
    end_date: current.end_date,
  };
  const successor = nextOccurrence(rule, periodDueDate);
  const finished = current.end_date !== null && successor > current.end_date;
  if (finished) {
    return current.next_due_date === periodDueDate
      ? { nextDueDate: periodDueDate, active: 1 }
      : null;
  }
  return current.next_due_date === successor
    ? { nextDueDate: periodDueDate, active: current.active }
    : null;
}

// Cancel a recurring period fulfillment (issue #565): drop the durable
// occurrence history and any operation links without inventing balances.
// The leftover operation, if any, becomes an ordinary deletable expense.
// When this period is still the latest resolved occurrence and the rule
// schedule still points at its successor (or the finished-rule active=0
// case), rewind next_due_date / reactivate so skip/link/close can be
// re-applied later.
apiV2.post('/recurring-items/:id/cancel-period-fulfillment', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  let periodDueDate: string;
  let expectedSnapshot: unknown;
  try {
    const body = await readBody(c);
    expectedSnapshot = body.__mcp_expected_snapshot;
    periodDueDate = normalizeDateString(body.period_due_date, 'period_due_date');
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const current = await c.env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
    .bind(id)
    .first<RecurringItemRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  if (expectedSnapshot !== undefined && !recurringSnapshotMatches(current, expectedSnapshot, 'recurring_cancel')) {
    return fail(c, 'RECURRING_ITEM_STALE', 409);
  }

  const fulfillment = (await listRecurringFulfillments(c.env.DB, id))
    .find((item) => item.period_due_date === periodDueDate);
  if (!fulfillment) return fail(c, 'RECURRING_PERIOD_FULFILLMENT_NOT_FOUND', 404);

  const rewind = recurringCancelRewindTarget(current, periodDueDate);
  const statements = [
    c.env.DB.prepare(
      'DELETE FROM operation_fulfillment_links WHERE recurring_item_id = ? AND period_due_date = ?',
    ).bind(id, periodDueDate),
    c.env.DB.prepare(
      'DELETE FROM recurring_period_fulfillments WHERE recurring_item_id = ? AND period_due_date = ?',
    ).bind(id, periodDueDate),
  ];
  if (rewind) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE recurring_items SET next_due_date = ?, active = ?
         WHERE ${RECURRING_SNAPSHOT_WHERE}
           AND NOT EXISTS (
             SELECT 1 FROM recurring_period_fulfillments
             WHERE recurring_item_id = ? AND period_due_date > ?
           )
         RETURNING *`,
      ).bind(rewind.nextDueDate, rewind.active, ...recurringSnapshotBinds(current), id, periodDueDate),
    );
  }

  const results = await c.env.DB.batch<RecurringItemRow>(statements);
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    return fail(c, 'CONCURRENT_UPDATE', 409);
  }

  const updated = rewind ? results[2]?.results[0] : undefined;
  const recurringRow = updated ?? await c.env.DB.prepare('SELECT * FROM recurring_items WHERE id = ?')
    .bind(id)
    .first<RecurringItemRow>();
  if (!recurringRow) return fail(c, 'NOT_FOUND', 404);

  const remaining = await listRecurringFulfillments(c.env.DB, id);
  return c.json({
    recurring_item: toRecurringItemJson(recurringRow, remaining[0] ?? null),
    canceled: fulfillment,
  });
});

// ---------- операции ----------
//
// Траты, доходы и возвраты одной таблицей (S1-5a, issue #200; решение владельца
// 2026-08-12, отменившее прежнюю посылку ТЗ «у траты счёта нет»). Три правила,
// без которых остальной код этого раздела читается как произвол:
//
//   1. СЧЁТ ОБЯЗАТЕЛЕН. Любая операция случилась на каком-то счёте — это и есть
//      «пульт слежения за течением денег» из идеи проекта.
//   2. ВАЛЮТА НЕ ХРАНИТСЯ И НЕ ЗАДАЁТСЯ — она равна валюте счёта всегда.
//      Причина не техническая: с динарового счёта долларовая покупка списывается
//      в динарах, и хранить у операции «доллары» значило бы записать то, чего на
//      счету не было. В JSON валюта есть — это `JOIN`, а не колонка (0005).
//   3. СУММА — ДЕЛЬТА БАЛАНСА СЧЁТА: расход отрицателен, доход и возврат
//      положительны, и то же самое требует CONSTRAINT `operations_sign_matches_kind`.
//      Прежняя `expenses` держала обратную конвенцию, унаследованную от листа v1;
//      она стала неверной ровно тогда, когда сумма начала править баланс.
//
// БАЛАНС СЧЁТА ДВИГАЕТСЯ ВМЕСТЕ С ОПЕРАЦИЕЙ — при создании, правке и удалении.
// Это не двойная запись и не бухгалтерия: баланс остаётся редактируемым полем,
// ручная сверка с банком по-прежнему главнее, а операция лишь избавляет от того,
// чтобы вводить сумму заново после каждой покупки. Отсюда следствие, которое
// стоит знать: банковский баланс, вбитый после покупки, уже включает её — и
// введённая следом операция вычтет её второй раз. Дрейф самоизлечивается на
// ближайшей ручной сверке, потому что баланс это поле, а не сумма операций;
// экран показывает будущее значение до сохранения, чтобы эффект был виден.
//
// `balance_updated_at` при этом НЕ ПЕРЕСТАВЛЯЕТСЯ, и это тоже решение: отметка
// означает «я сверился с банком» (issue #223), а посчитанная нами коррекция
// сверкой не является. Переставлять её значило бы гасить напоминание «пора
// сверить» ровно тогда, когда расхождение с банком как раз и накапливается.

const OPERATION_KINDS = ['expense', 'income', 'refund', 'transfer_out', 'transfer_in'] as const;
type OperationKind = (typeof OPERATION_KINDS)[number];

interface OperationRow {
  id: number;
  date: string;
  account_id: number;
  kind: string;
  store: string | null;
  item: string;
  category: string | null;
  subcategory: string | null;
  amount_minor: number;
  receipt_id: number | null;
  source: string;
  planned_item_id: number | null;
  recurring_item_id: number | null;
  transfer_id: number | null;
  comment: string | null;
  receipt_url: string | null;
  fiscal_receipt_id: string | null;
}

/** Строка операции вместе с валютой счёта — форма, в которой она уходит клиенту. */
interface OperationRowWithCurrency extends OperationRow {
  currency: string;
}

function toOperationJson(row: OperationRowWithCurrency, fulfillment?: OperationFulfillmentLinkRow | null) {
  return {
    id: row.id,
    date: row.date,
    account_id: row.account_id,
    kind: row.kind,
    store: row.store,
    item: row.item,
    category: row.category,
    subcategory: row.subcategory,
    amount_minor: row.amount_minor,
    // Не колонка, а валюта счёта: своей у операции нет (см. правило 2 выше).
    currency: row.currency,
    receipt_id: row.receipt_id,
    source: row.source,
    planned_item_id: row.planned_item_id,
    recurring_item_id: row.recurring_item_id,
    transfer_id: row.transfer_id,
    comment: row.comment,
    receipt_url: row.receipt_url,
    fiscal_receipt_id: row.fiscal_receipt_id,
    fulfillment: fulfillment
      ? {
          type: fulfillment.fulfillment_type,
          planned_item_id: fulfillment.planned_item_id,
          recurring_item_id: fulfillment.recurring_item_id,
          period_due_date: fulfillment.period_due_date,
          linked_at: fulfillment.linked_at,
        }
      : null,
  };
}

// Валюта берётся `JOIN`'ом во всех чтениях — своей колонки у операции нет.
// INNER JOIN, а не LEFT: `account_id NOT NULL` плюс FK без ON DELETE означают,
// что операции без счёта не существует, и подставлять null было бы враньём.
const OPERATION_SELECT = `
  SELECT o.*, a.currency AS currency
  FROM operations o
  JOIN accounts a ON a.id = o.account_id`;

function normalizeKind(input: unknown): OperationKind {
  if (typeof input !== 'string' || !(OPERATION_KINDS as readonly string[]).includes(input)) {
    throw new ValidationError('INVALID_KIND', { values: OPERATION_KINDS.join(', ') });
  }
  return input as OperationKind;
}

/**
 * Знак суммы и вид операции проверяются вместе, потому что вместе их проверяет
 * и схема. Без этого расход с положительной суммой уходил бы в CONSTRAINT
 * `operations_sign_matches_kind` и возвращался 500-кой с текстом SQLite вместо
 * объяснения. Сам знак не выводится из вида молча: клиент, приславший «расход
 * на +350», ошибся в одном из двух полей, и какое именно он имел в виду —
 * неизвестно.
 */
function assertSignMatchesKind(kind: OperationKind, amountMinor: number): void {
  if ((kind === 'expense' || kind === 'transfer_out') && amountMinor > 0) {
    throw new ValidationError('AMOUNT_MUST_BE_NEGATIVE', {
      kind: kind === 'expense' ? 'Expense' : 'Transfer debit',
    });
  }
  if (kind !== 'expense' && kind !== 'transfer_out' && amountMinor < 0) {
    throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', {
      kind: kind === 'income' ? 'Income' : kind === 'refund' ? 'Refund' : 'Transfer credit',
    });
  }
}

/**
 * Подкатегория без категории запрещена схемой (`operations_subcategory_needs_category`)
 * и бессмысленна по существу: «Овощи и фрукты» сами по себе ничего не уточняют.
 * Проверка нужна здесь по той же причине, что и предыдущая, — внятный 400
 * вместо отказа базы.
 */
function assertSubcategoryHasCategory(category: string | null, subcategory: string | null): void {
  if (subcategory !== null && category === null) {
    throw new ValidationError('SUBCATEGORY_REQUIRES_CATEGORY');
  }
}

/**
 * Происхождение операции этим API не задаётся: ручной ввод — всегда
 * `source = 'manual'` с пустым `receipt_id`, позиции чеков заводит S2 своим
 * путём. Присланное значение не игнорируется, а отклоняется: клиент, ждавший
 * привязки к чеку, иначе получил бы 201 с пустой ссылкой и решил, что привязка
 * состоялась. Именно 201, а не отказ базы: INSERT ниже пишет `NULL, 'manual'`
 * литералами, а `OPERATION_PATCH_FIELDS` обеих колонок не содержит — до CHECK'а
 * присланное значение не доходит вообще.
 */
function rejectReceiptFields(body: Record<string, unknown>, allowAgentSource = false): void {
  if ('source' in body) {
    if (body.source === 'agent' && !allowAgentSource) {
      throw new ValidationError('SOURCE_NOT_SETTABLE');
    }
    if (body.source !== 'manual' && body.source !== 'agent') {
      throw new ValidationError('SOURCE_NOT_SETTABLE');
    }
  }
  if ('receipt_id' in body && body.receipt_id !== null) {
    throw new ValidationError('RECEIPT_ID_NOT_SETTABLE');
  }
  if ('planned_item_id' in body) {
    throw new ValidationError('PLANNED_ITEM_ID_NOT_SETTABLE');
  }
  if ('recurring_item_id' in body) {
    throw new ValidationError('RECURRING_ITEM_ID_NOT_SETTABLE');
  }
  if ('transfer_id' in body) {
    throw new ValidationError('TRANSFER_ID_NOT_SETTABLE');
  }
}

/**
 * Правка баланса счёта на дельту — только для СОЗДАНИЯ, где сумма известна из
 * входа, а строки, с которой её можно было бы рассинхронизировать, ещё нет.
 * Правка и удаление считают дельту иначе — подзапросом по живой строке (см.
 * комментарий в `PATCH` ниже): арифметика на JS от прочитанного снимка даёт там
 * lost update на двух параллельных запросах.
 *
 * `balance_updated_at` не трогается намеренно (докблок раздела).
 */
function balanceDeltaStatement(db: D1Database, accountId: number, deltaMinor: number) {
  return db.prepare(
    'UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ? AND (balance_minor + ?) BETWEEN ? AND ?',
  ).bind(deltaMinor, accountId, deltaMinor, SAFE_MINOR_MIN, SAFE_MINOR_MAX);
}

apiV2.get('/operations', async (c) => {
  // Свежие сверху — обратный порядок к плановым, и по той же причине, по
  // которой у тех он прямой: плановые смотрят вперёд, а операция уже случилась.
  // id вторым ключом тоже по убыванию: позже введённая стоит выше.
  const [operations, links] = await Promise.all([
    c.env.DB.prepare(`${OPERATION_SELECT} ORDER BY o.date DESC, o.id DESC`).all<OperationRowWithCurrency>(),
    c.env.DB.prepare('SELECT * FROM operation_fulfillment_links').all<OperationFulfillmentLinkRow>(),
  ]);
  const byOperation = new Map(links.results.map((link) => [link.operation_id, link]));
  return c.json({
    operations: operations.results.map((row) => toOperationJson(row, byOperation.get(row.id))),
  });
});

apiV2.post('/operations', async (c) => {
  let accountId: number;
  let accountCurrency: string;
  let amountMinor: number;
  let statements: D1PreparedStatement[];
  try {
    const body = await readBody(c);
    rejectReceiptFields(body, isInternalMcp(c));
    const date = normalizeDateString(body.date, 'date');
    accountId = normalizeAccountId(body.account_id);
    const kind = normalizeKind(body.kind);
    if (kind === 'transfer_out' || kind === 'transfer_in') {
      throw new ValidationError('TRANSFER_VIA_OPERATIONS_FORBIDDEN');
    }
    const item = normalizeRequiredText(body.item, 'item');
    amountMinor = normalizeAmountMinor(body.amount_minor, 'amount_minor');
    assertSignMatchesKind(kind, amountMinor);
    const store = normalizeOptionalText(body.store, 'store');
    const category = normalizeOptionalText(body.category, 'category');
    const subcategory = normalizeOptionalText(body.subcategory, 'subcategory');
    const comment = normalizeOptionalText(body.comment, 'comment');
    const receiptUrl = normalizeOptionalHttpUrl(body.receipt_url, 'receipt_url');
    const fiscalReceiptId = normalizeOptionalFiscalReceiptId(body.fiscal_receipt_id);
    assertSubcategoryHasCategory(category, subcategory);

    // Валюта не принимается от клиента — она у счёта, и отсюда же берётся для
    // ответа. Проверка существования счёта нужна и сама по себе: без неё FK
    // отдал бы 500 вместо внятного «Счёт не найден».
    const account = await loadAccountForReference(c.env.DB, accountId);
    if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    accountCurrency = account.currency;
    assertSafeBalanceDelta(account.balance_minor, amountMinor);

    const source = isInternalMcp(c) && body.source === 'agent' ? 'agent' : 'manual';

    if (kind === 'expense') {
      const duplicateId = await findDuplicateExpenseId(c.env.DB, {
        date,
        account_id: accountId,
        store,
        amount_minor: amountMinor,
        item,
        comment,
        fiscal_receipt_id: fiscalReceiptId,
      });
      if (duplicateId !== null) {
        // Must be ValidationError so MCP's apiV2.fetch path maps 409 (not 500/UNCERTAIN).
        throw new ValidationError('DUPLICATE_EXPENSE', { existingOperationId: duplicateId }, 409);
      }
    }

    statements = [
      balanceDeltaStatement(c.env.DB, accountId, amountMinor),
      c.env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, comment, receipt_url, fiscal_receipt_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?
         WHERE changes() = 1
         RETURNING *`,
      ).bind(date, accountId, kind, store, item, category, subcategory, amountMinor, source, comment, receiptUrl, fiscalReceiptId),
    ];
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  // batch — одна транзакция (D1). Запись операции и правка баланса обязаны быть
  // атомарны: половина этой пары означала бы либо потерянную операцию, либо
  // баланс, разъехавшийся с историей без следа.
  const [balanceRes, inserted] = await c.env.DB.batch<OperationRow>(statements);
  if (!ledgerApplied(balanceRes) || !inserted?.results[0]) {
    return fail(c, ledgerApplied(balanceRes) ? 'BALANCE_OUT_OF_SAFE_RANGE' : 'LEDGER_EFFECT_MISSING', 400);
  }
  return c.json({ operation: toOperationJson({ ...inserted.results[0]!, currency: accountCurrency }) }, 201);
});

// source и receipt_id в список не входят намеренно: происхождение операции —
// не редактируемое поле. Правка самих данных (что купили, за сколько, с какого
// счёта) разрешена независимо от происхождения: ошибка в названии распознанной
// позиции чека — обычное дело, и чинить её владелец будет здесь же.
const OPERATION_PATCH_FIELDS = ['date', 'account_id', 'kind', 'store', 'item', 'category', 'subcategory', 'amount_minor', 'comment', 'receipt_url', 'fiscal_receipt_id'] as const;

apiV2.patch('/operations/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const updates = new Map<(typeof OPERATION_PATCH_FIELDS)[number], unknown>();
  try {
    const body = await readBody(c);
    rejectReceiptFields(body);
    for (const field of OPERATION_PATCH_FIELDS) {
      if (!(field in body)) continue;
      let value: unknown;
      switch (field) {
        case 'date':
          value = normalizeDateString(body.date, 'date');
          break;
        case 'account_id':
          value = normalizeAccountId(body.account_id);
          break;
        case 'kind':
          value = normalizeKind(body.kind);
          break;
        case 'store':
          value = normalizeOptionalText(body.store, 'store');
          break;
        case 'item':
          value = normalizeRequiredText(body.item, 'item');
          break;
        case 'category':
          value = normalizeOptionalText(body.category, 'category');
          break;
        case 'subcategory':
          value = normalizeOptionalText(body.subcategory, 'subcategory');
          break;
        case 'amount_minor':
          value = normalizeAmountMinor(body.amount_minor, 'amount_minor');
          break;
        case 'comment':
          value = normalizeOptionalText(body.comment, 'comment');
          break;
        case 'receipt_url':
          value = normalizeOptionalHttpUrl(body.receipt_url, 'receipt_url');
          break;
        case 'fiscal_receipt_id':
          value = normalizeOptionalFiscalReceiptId(body.fiscal_receipt_id);
          break;
      }
      updates.set(field, value);
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  if (updates.size === 0) {
    return fail(c, 'NO_PATCH_FIELDS', 400);
  }

  const current = await c.env.DB.prepare('SELECT * FROM operations WHERE id = ?').bind(id).first<OperationRow>();
  if (!current) return fail(c, 'NOT_FOUND', 404);
  const fulfillment = await c.env.DB.prepare(
    'SELECT * FROM operation_fulfillment_links WHERE operation_id = ?',
  ).bind(id).first<OperationFulfillmentLinkRow>();
  if (fulfillment?.fulfillment_type === 'linked') {
    const protectedFields = ['date', 'account_id', 'kind', 'category', 'amount_minor'] as const;
    const changedProtected = protectedFields.filter(
      (field) => updates.has(field) && updates.get(field) !== current[field],
    );
    if (changedProtected.length > 0) {
      return fail(c, 'OPERATION_LINKED_EXPECTATION', 409, { fields: changedProtected.join(', ') });
    }
  }

  // Правило считается на ЭФФЕКТИВНОЙ строке — том, чем она станет после патча, —
  // а не на присланных полях. Иначе смена одного лишь `kind` на месячной строке
  // расхода упиралась бы в CONSTRAINT схемы вместо внятного ответа: тот же приём
  // и та же причина, что у якорей регулярных правил выше.
  const nextKind = (updates.get('kind') as OperationKind | undefined) ?? (current.kind as OperationKind);
  const nextAmount = (updates.get('amount_minor') as number | undefined) ?? current.amount_minor;
  const nextAccountId = (updates.get('account_id') as number | undefined) ?? current.account_id;
  const nextCategory = updates.has('category') ? (updates.get('category') as string | null) : current.category;
  const nextSubcategory = updates.has('subcategory') ? (updates.get('subcategory') as string | null) : current.subcategory;

  try {
    if (current.transfer_id !== null && (updates.has('kind') || updates.has('account_id') || updates.has('amount_minor'))) {
      throw new ValidationError('TRANSFER_FIELDS_ATOMIC');
    }
    assertSignMatchesKind(nextKind, nextAmount);
    assertSubcategoryHasCategory(nextCategory, nextSubcategory);
    if (nextAccountId !== current.account_id) {
      const [from, to] = await Promise.all([
        loadAccountForReference(c.env.DB, current.account_id),
        loadAccountForReference(c.env.DB, nextAccountId),
      ]);
      if (!to) throw new ValidationError('ACCOUNT_NOT_FOUND');
      // Смена счёта — это смена валюты операции, потому что своей у неё нет.
      // Без этой проверки перенос «1 500,00 RSD» на долларовый счёт отвечал 200
      // и оставлял `amount_minor` как есть: 1 500 динаров молча становились
      // 1 500 долларами, не изменившись ни в одной колонке. Поймано независимым
      // прогоном правила 13. Замок измерений (#232) этот путь не закрывает — он
      // запрещает менять валюту У СЧЁТА, а не уводить операцию на счёт с другой
      // валютой.
      //
      // Требование то же, что у счетов и плановых при смене currency: сумму
      // надо назвать заново, в новой валюте. Пересчитать по курсу за владельца
      // нельзя — курса на дату операции мы не знаем, а тихо округлить чужие
      // деньги хуже, чем переспросить.
      if (from && from.currency !== to.currency && !updates.has('amount_minor')) {
        throw new ValidationError('CURRENCY_CHANGE_REQUIRES_AMOUNT', {
          fromCurrency: from.currency,
          toCurrency: to.currency,
        });
      }
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of updates) {
    if (value === current[field as keyof OperationRow]) continue;
    setClauses.push(`${field} = ?`);
    values.push(value);
  }

  const account = (await loadAccountForReference(c.env.DB, nextAccountId))!;

  if (setClauses.length === 0) {
    return c.json({ operation: toOperationJson({ ...current, currency: account.currency }) });
  }

  values.push(id);

  // Баланс правится ТРЕМЯ statement'ами, и каждый читает живую строку
  // подзапросом, а не заранее прочитанный снимок: снять то, что реально лежит,
  // записать новое, применить то, что реально стало.
  //
  // Приём тот же, что в DELETE ниже, но чинит он не только гонку с удалением.
  // Прежняя редакция считала дельту на JS от снимка `current` — и два
  // параллельных PATCH давали классический lost update: соседнее устройство
  // правит сумму на −40 000 (баланс 60 000), затем наш запрос со снимком
  // −25 000 правит на −30 000 и снимает разницу от СВОЕГО снимка → 55 000
  // вместо 70 000, оба ответа 200, ошибки не видит никто. Поймано независимым
  // прогоном правила 13 на воспроизводимой подмене `batch`.
  //
  // Живые подзапросы закрывают этот класс целиком: что бы ни успел сделать
  // сосед, баланс остаётся равен «стартовый + сумма всех операций счёта».
  // Порядок полей в самой строке при этом по-прежнему «кто последний, тот и
  // прав» — обычное поведение PATCH и здесь, и у плановых, инвариант оно не
  // рушит. Строку удалили — все три подзапроса дают NULL, `WHERE id = NULL` не
  // совпадает ни с чем, RETURNING пуст, и ниже это честный 404 без единой
  // правки баланса.
  const liveDelta = (sign: '-' | '+', requirePriorChange = false) =>
    c.env.DB.prepare(
      `UPDATE accounts
       SET balance_minor = balance_minor ${sign} (SELECT amount_minor FROM operations WHERE id = ?1)
       WHERE id = (SELECT account_id FROM operations WHERE id = ?1)
         ${requirePriorChange ? 'AND changes() = 1' : ''}
         AND (balance_minor ${sign} (SELECT amount_minor FROM operations WHERE id = ?1)) BETWEEN ${SAFE_MINOR_MIN} AND ${SAFE_MINOR_MAX}`,
    ).bind(id);

  const protectedFields = ['date', 'account_id', 'kind', 'category', 'amount_minor'] as const;
  const changesProtected = protectedFields.some(
    (field) => updates.has(field) && updates.get(field) !== current[field],
  );
  const updateSql = changesProtected
    ? `UPDATE operations SET ${setClauses.join(', ')} WHERE id = ? AND changes() = 1 AND NOT EXISTS (
         SELECT 1 FROM operation_fulfillment_links WHERE operation_id = ? AND fulfillment_type = 'linked'
       ) RETURNING *`
    : `UPDATE operations SET ${setClauses.join(', ')} WHERE id = ? AND changes() = 1 RETURNING *`;
  const updateBinds = changesProtected ? [...values, id] : values;

  const [debitRes, updated, creditRes] = await c.env.DB.batch<OperationRow>([
    liveDelta('-'),
    c.env.DB.prepare(updateSql).bind(...updateBinds),
    liveDelta('+', true),
  ]);

  const row = updated.results[0];
  if (!row) {
    if (changesProtected) {
      const linked = await c.env.DB.prepare(
        'SELECT 1 FROM operation_fulfillment_links WHERE operation_id = ? AND fulfillment_type = ?',
      ).bind(id, 'linked').first();
      if (linked) return fail(c, 'OPERATION_LINKED_EXPECTATION', 409);
    }
    return fail(c, 'NOT_FOUND', 404);
  }
  if (!ledgerApplied(debitRes) || !ledgerApplied(creditRes)) {
    return fail(c, 'LEDGER_EFFECT_MISSING', 409);
  }
  return c.json({ operation: toOperationJson({ ...row, currency: account.currency }) });
});

apiV2.delete('/operations/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const current = await c.env.DB.prepare(
    `SELECT o.id, o.transfer_id,
            (SELECT recurring_item_id FROM operation_fulfillment_links WHERE operation_id = o.id) AS fulfilled_recurring_item_id,
            (SELECT planned_item_id FROM operation_fulfillment_links WHERE operation_id = o.id) AS fulfilled_planned_item_id
     FROM operations o WHERE o.id = ?`,
  ).bind(id).first<{
    id: number;
    transfer_id: number | null;
    fulfilled_recurring_item_id: number | null;
    fulfilled_planned_item_id: number | null;
  }>();
  if (!current) return fail(c, 'NOT_FOUND', 404);

  // Recurring fulfillment is durable evidence that the occurrence was
  // satisfied. Deleting its only financial fact would leave an advanced rule
  // with a false parent record. Cancel the period fulfillment first via
  // POST /recurring-items/:id/cancel-period-fulfillment; until then, fail
  // closed and preserve both the operation and history.
  if (current.fulfilled_recurring_item_id !== null) {
    return fail(c, 'OPERATION_FULFILLS_RECURRING', 409, {
      recurringItemId: current.fulfilled_recurring_item_id,
    });
  }

  if (current.transfer_id !== null) {
    const deleted = await deleteTransferExactlyOnce(c.env.DB, current.transfer_id);
    if (!deleted) return fail(c, 'NOT_FOUND', 404);
    return c.body(null, 204);
  }

  // Снятие вклада операции из баланса идёт ПЕРЕД удалением и читает живую
  // строку подзапросом, а не заранее прочитанное значение: пара «SELECT, потом
  // DELETE» оставила бы окно, в котором сумма успевает измениться, и с баланса
  // ушло бы не то, что там лежало. Строки нет — подзапрос даёт NULL, `WHERE id
  // = NULL` не совпадает ни с чем, и UPDATE ничего не делает.
  //
  // Если операция порождена плановой, done снимается в том же batch: удалили
  // факт — план снова ожидание, иначе прогноз её не видит, а галочка врёт.
  const balanceRes = await c.env.DB.prepare(
    `UPDATE accounts
     SET balance_minor = balance_minor - (SELECT amount_minor FROM operations WHERE id = ?1)
     WHERE id = (SELECT account_id FROM operations WHERE id = ?1)
       AND (balance_minor - (SELECT amount_minor FROM operations WHERE id = ?1)) BETWEEN ${SAFE_MINOR_MIN} AND ${SAFE_MINOR_MAX}`,
  ).bind(id).run();
  if (!ledgerApplied(balanceRes)) {
    const exists = await c.env.DB.prepare('SELECT id FROM operations WHERE id = ?').bind(id).first<{ id: number }>();
    return exists ? fail(c, 'LEDGER_EFFECT_MISSING', 409) : fail(c, 'NOT_FOUND', 404);
  }

  const [, , deleted] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE planned_items
       SET done = 0
       WHERE id = (
         SELECT planned_item_id FROM operation_fulfillment_links
         WHERE operation_id = ?1 AND planned_item_id IS NOT NULL
       )`,
    ).bind(id),
    c.env.DB.prepare('DELETE FROM operation_fulfillment_links WHERE operation_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(id),
  ]);
  if (deleted.meta.changes === 0) return fail(c, 'NOT_FOUND', 404);
  return c.body(null, 204);
});

// ---------- переводы между счетами ----------
apiV2.post('/transfers', async (c) => {
  let fromAccountId: number;
  let toAccountId: number;
  let fromMagnitude: number;
  let toMagnitude: number;
  let fromAccount: { currency: string; name: string };
  let toAccount: { currency: string; name: string };
  let date: string;
  let item: string | null;
  let store: string | null;
  let category: string | null;
  let subcategory: string | null;
  let comment: string | null;
  let receiptUrl: string | null;
  let fiscalReceiptId: string | null;
  let receiptId: number | null = null;
  let source: 'manual' | 'receipt' | 'agent' = 'manual';

  try {
    const body = await readBody(c);
    date = normalizeDateString(body.date, 'date');
    fromAccountId = normalizeAccountId(body.from_account_id ?? body.source_account_id);
    toAccountId = normalizeAccountId(body.to_account_id ?? body.dest_account_id);
    if (fromAccountId === toAccountId) {
      throw new ValidationError('ACCOUNTS_MUST_DIFFER');
    }

    const [accFrom, accTo] = await Promise.all([
      loadAccountForReference(c.env.DB, fromAccountId),
      loadAccountForReference(c.env.DB, toAccountId),
    ]);
    if (!accFrom) throw new ValidationError('FROM_ACCOUNT_NOT_FOUND');
    if (!accTo) throw new ValidationError('TO_ACCOUNT_NOT_FOUND');
    fromAccount = accFrom;
    toAccount = accTo;

    fromMagnitude = Math.abs(normalizeAmountMinor(body.from_amount_minor, 'from_amount_minor'));
    toMagnitude = Math.abs(normalizeAmountMinor(body.to_amount_minor, 'to_amount_minor'));
    if (fromMagnitude === 0 || toMagnitude === 0) {
      throw new ValidationError('TRANSFER_AMOUNTS_NONZERO');
    }
    assertSafeBalanceDelta(accFrom.balance_minor, -fromMagnitude);
    assertSafeBalanceDelta(accTo.balance_minor, toMagnitude);

    item = normalizeOptionalText(body.item, 'item');
    store = normalizeOptionalText(body.store, 'store');
    category = normalizeOptionalText(body.category, 'category');
    subcategory = normalizeOptionalText(body.subcategory, 'subcategory');
    comment = normalizeOptionalText(body.comment, 'comment');
    receiptUrl = normalizeOptionalHttpUrl(body.receipt_url, 'receipt_url');
    fiscalReceiptId = normalizeOptionalFiscalReceiptId(body.fiscal_receipt_id);
    assertSubcategoryHasCategory(category, subcategory);

    if ('receipt_id' in body && body.receipt_id !== null && body.receipt_id !== undefined) {
      receiptId = parseIdParam(String(body.receipt_id));
      if (receiptId === null) throw new ValidationError('FIELD_TYPE_INTEGER_MINOR', { field: 'receipt_id' });
      source = 'receipt';
    }
    if ('source' in body && body.source !== undefined) {
      if (body.source !== 'manual' && body.source !== 'receipt' && body.source !== 'agent') {
        throw new ValidationError('INVALID_SOURCE');
      }
      if (body.source === 'agent' && !isInternalMcp(c)) {
        throw new ValidationError('SOURCE_NOT_SETTABLE');
      }
      source = body.source as 'manual' | 'receipt' | 'agent';
    }
    if (source === 'receipt' && receiptId === null) {
      throw new ValidationError('FIELD_REQUIRED', { field: 'receipt_id' });
    }
    if (source === 'manual' && receiptId !== null) {
      throw new ValidationError('RECEIPT_ID_NOT_SETTABLE');
    }
    if (source === 'agent' && receiptId !== null) {
      throw new ValidationError('RECEIPT_ID_NOT_SETTABLE');
    }
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  const transfer = await c.env.DB.prepare('INSERT INTO transfers DEFAULT VALUES RETURNING id').first<{ id: number }>();
  if (!transfer) throw new Error('Не удалось создать запись перевода');

  const outAmountMinor = -fromMagnitude;
  const inAmountMinor = toMagnitude;

  const outItem = item || `Перевод на «${toAccount.name}»`;
  const inItem = item || `Перевод с «${fromAccount.name}»`;

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, transfer_id, comment, receipt_url, fiscal_receipt_id)
       VALUES (?, ?, 'transfer_out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).bind(date, fromAccountId, store, outItem, category, subcategory, outAmountMinor, receiptId, source, transfer.id, comment, receiptUrl, fiscalReceiptId),
    balanceDeltaStatement(c.env.DB, fromAccountId, outAmountMinor),
    c.env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, transfer_id, comment, receipt_url, fiscal_receipt_id)
       SELECT ?, ?, 'transfer_in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE changes() = 1
       RETURNING *`,
    ).bind(date, toAccountId, store, inItem, category, subcategory, inAmountMinor, receiptId, source, transfer.id, comment, receiptUrl, fiscalReceiptId),
    c.env.DB.prepare(
      'UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ? AND changes() = 1 AND (balance_minor + ?) BETWEEN ? AND ?',
    ).bind(inAmountMinor, toAccountId, inAmountMinor, SAFE_MINOR_MIN, SAFE_MINOR_MAX),
  ];

  const [outRes, fromBalance, inRes, toBalance] = await c.env.DB.batch<OperationRow>(statements);
  if (!ledgerApplied(fromBalance) || !ledgerApplied(toBalance) || !outRes.results[0] || !inRes.results[0]) {
    const undo: D1PreparedStatement[] = [];
    if (ledgerApplied(fromBalance)) {
      undo.push(balanceDeltaStatement(c.env.DB, fromAccountId, -outAmountMinor));
    }
    if (ledgerApplied(toBalance)) {
      undo.push(balanceDeltaStatement(c.env.DB, toAccountId, -inAmountMinor));
    }
    undo.push(c.env.DB.prepare('DELETE FROM transfers WHERE id = ?').bind(transfer.id));
    await c.env.DB.batch(undo);
    return fail(c, 'LEDGER_EFFECT_MISSING', 409);
  }

  return c.json(
    {
      transfer: {
        id: transfer.id,
        from_operation: toOperationJson({ ...outRes.results[0]!, currency: fromAccount.currency }),
        to_operation: toOperationJson({ ...inRes.results[0]!, currency: toAccount.currency }),
      },
    },
    201,
  );
});

async function deleteTransferExactlyOnce(db: D1Database, transferId: number): Promise<boolean> {
  const results = await db.batch([
    db.prepare(
      `UPDATE accounts
       SET balance_minor = balance_minor - (
         SELECT COALESCE(SUM(amount_minor), 0)
         FROM operations
         WHERE transfer_id = ?1 AND account_id = accounts.id
       )
       WHERE id IN (SELECT account_id FROM operations WHERE transfer_id = ?1)
         AND (
           SELECT COUNT(*) FROM accounts a
           WHERE a.id IN (SELECT account_id FROM operations WHERE transfer_id = ?1)
             AND (a.balance_minor - (
               SELECT COALESCE(SUM(amount_minor), 0)
               FROM operations
               WHERE transfer_id = ?1 AND account_id = a.id
             )) BETWEEN ${SAFE_MINOR_MIN} AND ${SAFE_MINOR_MAX}
         ) = (
           SELECT COUNT(DISTINCT account_id) FROM operations WHERE transfer_id = ?1
         )`,
    ).bind(transferId),
    db.prepare(
      `DELETE FROM transfers WHERE id = ?1 AND changes() >= (
         SELECT COUNT(DISTINCT account_id) FROM operations WHERE transfer_id = ?1
       ) RETURNING id`,
    ).bind(transferId),
  ]);
  if (!ledgerApplied(results[0], 1)) return false;
  return Array.isArray(results[1]?.results) && results[1].results.length === 1;
}

apiV2.delete('/transfers/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const deleted = await deleteTransferExactlyOnce(c.env.DB, id);
  if (!deleted) return fail(c, 'NOT_FOUND', 404);
  return c.body(null, 204);
});

// Атомарное изменение перевода (#401): вместо запрета PATCH'ить ноги по
// отдельности — обновляем обе операции одним batch. Балансы правятся теми же
// live-подзапросами, что и PATCH /operations (каждый читает живую строку,
// а не снимок, — закрывает lost-update при параллельных правках). Смена
// валюты запрещена без явной суммы в новой валюте (тот же замок, что у
// PATCH /operations). Нулевые суммы, как и в POST, недопустимы.
apiV2.put('/transfers/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  const transfer = await c.env.DB.prepare('SELECT id FROM transfers WHERE id = ?').bind(id).first();
  if (!transfer) return fail(c, 'NOT_FOUND', 404);

  const currentOps = await c.env.DB.prepare(
    'SELECT id, account_id, amount_minor, kind, store, item, category, subcategory, comment, receipt_url, fiscal_receipt_id FROM operations WHERE transfer_id = ? ORDER BY kind',
  ).bind(id).all<{ id: number; account_id: number; amount_minor: number; kind: OperationKind; store: string | null; item: string | null; category: string | null; subcategory: string | null; comment: string | null; receipt_url: string | null; fiscal_receipt_id: string | null }>();
  if (currentOps.results.length !== 2) {
    return fail(c, 'TRANSFER_CORRUPT', 409);
  }
  const outOp = currentOps.results.find((o) => o.kind === 'transfer_out')!;
  const inOp = currentOps.results.find((o) => o.kind === 'transfer_in')!;

  let date: string;
  let fromAccountId: number;
  let toAccountId: number;
  let fromMagnitude: number;
  let toMagnitude: number;
  let fromAccount: { currency: string; name: string };
  let toAccount: { currency: string; name: string };
  let item: string | null;
  let store: string | null;
  let category: string | null;
  let subcategory: string | null;
  let comment: string | null;
  let receiptUrl: string | null;
  let fiscalReceiptId: string | null;

  const body = await readBody(c);
  try {
    date = normalizeDateString(body.date ?? outOp, 'date');
    fromAccountId = normalizeAccountId(body.from_account_id ?? outOp.account_id);
    toAccountId = normalizeAccountId(body.to_account_id ?? inOp.account_id);
    if (fromAccountId === toAccountId) {
      throw new ValidationError('ACCOUNTS_MUST_DIFFER');
    }

    const [accFrom, accTo] = await Promise.all([
      loadAccountForReference(c.env.DB, fromAccountId),
      loadAccountForReference(c.env.DB, toAccountId),
    ]);
    if (!accFrom) throw new ValidationError('FROM_ACCOUNT_NOT_FOUND');
    if (!accTo) throw new ValidationError('TO_ACCOUNT_NOT_FOUND');
    fromAccount = accFrom;
    toAccount = accTo;

    fromMagnitude = Math.abs(normalizeAmountMinor(body.from_amount_minor ?? outOp.amount_minor, 'from_amount_minor'));
    toMagnitude = Math.abs(normalizeAmountMinor(body.to_amount_minor ?? inOp.amount_minor, 'to_amount_minor'));
    if (fromMagnitude === 0 || toMagnitude === 0) {
      throw new ValidationError('TRANSFER_AMOUNTS_NONZERO');
    }

    item = normalizeOptionalText(body.item ?? outOp.item, 'item');
    store = normalizeOptionalText(body.store ?? outOp.store, 'store');
    category = normalizeOptionalText(body.category ?? outOp.category, 'category');
    subcategory = normalizeOptionalText(body.subcategory ?? outOp.subcategory, 'subcategory');
    comment = normalizeOptionalText(body.comment ?? outOp.comment, 'comment');
    receiptUrl = normalizeOptionalHttpUrl(body.receipt_url ?? outOp.receipt_url, 'receipt_url');
    fiscalReceiptId = normalizeOptionalFiscalReceiptId(body.fiscal_receipt_id ?? outOp.fiscal_receipt_id);
    assertSubcategoryHasCategory(category, subcategory);
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  // Смена валюты запрещена без явной новой суммы (тот же замок, что у PATCH).
  const [fromCur, toCur, origFromCur, origToCur] = await Promise.all([
    loadAccountForReference(c.env.DB, fromAccountId),
    loadAccountForReference(c.env.DB, toAccountId),
    loadAccountForReference(c.env.DB, outOp.account_id),
    loadAccountForReference(c.env.DB, inOp.account_id),
  ]);
  const requestedFromCur = fromCur?.currency;
  const requestedToCur = toCur?.currency;
  if (requestedFromCur !== origFromCur?.currency && !('from_amount_minor' in body)) {
    return fail(c, 'TRANSFER_FROM_CURRENCY_CHANGE_REQUIRES_AMOUNT', 400, {
      fromCurrency: origFromCur?.currency ?? '',
      toCurrency: requestedFromCur ?? '',
    });
  }
  if (requestedToCur !== origToCur?.currency && !('to_amount_minor' in body)) {
    return fail(c, 'TRANSFER_TO_CURRENCY_CHANGE_REQUIRES_AMOUNT', 400, {
      fromCurrency: origToCur?.currency ?? '',
      toCurrency: requestedToCur ?? '',
    });
  }

  const outAmountMinor = -fromMagnitude;
  const inAmountMinor = toMagnitude;
  const outItem = item || `Перевод на «${toAccount.name}»`;
  const inItem = item || `Перевод с «${fromAccount.name}»`;

  const liveDeltaOut = (sign: '-' | '+') =>
    c.env.DB.prepare(
      `UPDATE accounts
       SET balance_minor = balance_minor ${sign} (SELECT amount_minor FROM operations WHERE id = ?1)
       WHERE id = (SELECT account_id FROM operations WHERE id = ?1)
         AND (balance_minor ${sign} (SELECT amount_minor FROM operations WHERE id = ?1)) BETWEEN ${SAFE_MINOR_MIN} AND ${SAFE_MINOR_MAX}`,
    ).bind(outOp.id);
  const liveDeltaIn = (sign: '-' | '+') =>
    c.env.DB.prepare(
      `UPDATE accounts
       SET balance_minor = balance_minor ${sign} (SELECT amount_minor FROM operations WHERE id = ?1)
       WHERE id = (SELECT account_id FROM operations WHERE id = ?1)
         AND (balance_minor ${sign} (SELECT amount_minor FROM operations WHERE id = ?1)) BETWEEN ${SAFE_MINOR_MIN} AND ${SAFE_MINOR_MAX}`,
    ).bind(inOp.id);

  const statements: D1PreparedStatement[] = [
    liveDeltaOut('-'),
    c.env.DB.prepare(
      `UPDATE operations
       SET date = ?, account_id = ?, store = ?, item = ?, category = ?, subcategory = ?, amount_minor = ?, comment = ?, receipt_url = ?, fiscal_receipt_id = ?
       WHERE id = ? RETURNING *`,
    ).bind(date, fromAccountId, store, outItem, category, subcategory, outAmountMinor, comment, receiptUrl, fiscalReceiptId, outOp.id),
    liveDeltaOut('+'),
    liveDeltaIn('-'),
    c.env.DB.prepare(
      `UPDATE operations
       SET date = ?, account_id = ?, store = ?, item = ?, category = ?, subcategory = ?, amount_minor = ?, comment = ?, receipt_url = ?, fiscal_receipt_id = ?
       WHERE id = ? RETURNING *`,
    ).bind(date, toAccountId, store, inItem, category, subcategory, inAmountMinor, comment, receiptUrl, fiscalReceiptId, inOp.id),
    liveDeltaIn('+'),
  ];

  const results = await c.env.DB.batch<OperationRow>(statements);
  const outRow = results[1]?.results[0];
  const inRow = results[4]?.results[0];
  if (outRow && inRow && (!ledgerApplied(results[0]) || !ledgerApplied(results[2]) || !ledgerApplied(results[3]) || !ledgerApplied(results[5]))) {
    return fail(c, 'LEDGER_EFFECT_MISSING', 409);
  }
  if (!outRow || !inRow) return fail(c, 'NOT_FOUND', 404);

  return c.json(
    {
      transfer: {
        id,
        from_operation: toOperationJson({ ...outRow, currency: fromAccount.currency }),
        to_operation: toOperationJson({ ...inRow, currency: toAccount.currency }),
      },
    },
    200,
  );
});
// ---------- прогноз ----------
//
// Движок (forecast/build.ts) — чистая функция без D1, вся загрузка данных
// живёт в forecast/load.ts (issue #198, S1-4). Роут ниже только склеивает их
// и сериализует BigInt-поля в обычные JS-числа — тем же приёмом, что и
// balance_minor/rate_e9 в остальном API v2: деньги здесь всегда влезают в
// Number.isSafeInteger, а bigint в JSON.stringify не сериализуется вовсе.

const CASH_FLOW_DAYS = 30;
const UPCOMING_DAYS = 30;

function normalizeHorizonDays(raw: string | undefined): number {
  if (raw === undefined) return 365;
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError('DAYS_INVALID');
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new ValidationError('DAYS_INVALID');
  }
  return days;
}

function forecastMinor(value: bigint | string | number, field: string): number {
  try {
    return minorBigIntToNumber(typeof value === 'bigint' ? value : BigInt(value), field);
  } catch {
    throw new ValidationError('AMOUNT_OUT_OF_SAFE_RANGE', { field });
  }
}

apiV2.get('/forecast', async (c) => {
  let horizonDays: number;
  try {
    horizonDays = normalizeHorizonDays(c.req.query('days'));
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  // «Сегодня» сервера в UTC — без учёта часового пояса просмотра, как и все
  // financial date в v2 (шапка migrations/0001_initial_schema.sql).
  const asOf = new Date().toISOString().slice(0, 10);
  const limitDate = addDays(asOf, horizonDays);

  const [accounts, ratesE9, settings] = await Promise.all([
    loadAccounts(c.env.DB),
    loadRates(c.env.DB),
    loadForecastSettings(c.env.DB),
  ]);
  const eligibleIds = new Set(accounts.map((a) => a.id));
  const upcomingLimit = addDays(asOf, UPCOMING_DAYS - 1);
  const { flows, payments } = await loadFlowsAndPayments(c.env.DB, eligibleIds, asOf, limitDate, upcomingLimit);

  const result = buildForecast({
    accounts,
    flows,
    ratesE9,
    baseCurrency: settings.baseCurrency,
    asOfDate: asOf,
    horizonDays,
    lowBalanceThresholdMinor: BigInt(settings.lowBalanceThresholdMinor),
    cashFlowDays: CASH_FLOW_DAYS,
  });

  // Тот же конвертер, что внутри buildForecast, — округление и трактовка
  // «курса нет» обязаны совпадать с агрегатами до последней минорной единицы.
  // Собственный экземпляр (без сбора missing_rates) нужен потому, что список
  // недостающих валют уже посчитан ядром и второй раз не собирается.
  const toBase = makeConverter(ratesE9, settings.baseCurrency);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  try {
  const upcoming = payments
    .map((f) => {
      const base = toBase(BigInt(f.amount_minor), f.currency, settings.baseCurrency);
      return {
        date: f.date,
        title: f.title,
        amount_minor: f.amount_minor,
        currency: f.currency,
        account_id: f.account_id,
        account_name: accountById.get(f.account_id)?.name ?? null,
        kind: f.kind,
        source_id: f.source_id,
        occurrence_count: f.occurrence_count,
        amount_base_minor: base === null ? null : forecastMinor(base, 'amount_base_minor'),
      };
    });

  return c.json({
    as_of: result.asOfDate,
    horizon_days: result.horizonDays,
    base_currency: result.baseCurrency,
    low_balance_threshold_minor: settings.lowBalanceThresholdMinor,
    cash_flow_days: result.cashFlowDays,
    net_worth_minor: forecastMinor(result.netWorthMinor, 'net_worth_minor'),
    cash_flow_minor: forecastMinor(result.cashFlowMinor, 'cash_flow_minor'),
    countries: result.countries,
    owners: result.owners,
    series: result.series.map((s) => ({
      date: s.date,
      overall_minor: forecastMinor(s.overallMinor, 'overall_minor'),
      by_country: Object.fromEntries([...s.byCountry].map(([code, minor]) => [code, forecastMinor(minor, 'by_country')])),
      by_account: Object.fromEntries([...s.byAccount].map(([id, minor]) => [String(id), forecastMinor(minor, 'by_account')])),
      by_owner: Object.fromEntries([...s.byOwner].map(([owner, minor]) => [owner, forecastMinor(minor, 'by_owner')])),
    })),
    lowest: result.lowest === null ? null : { date: result.lowest.date, amount_minor: forecastMinor(result.lowest.amountMinor, 'lowest_minor') },
    accounts: result.accounts.map(({ account, balanceBaseMinor }) => ({
      id: account.id,
      name: account.name,
      owner: account.owner,
      country: account.country,
      currency: account.currency,
      balance_minor: account.balance_minor,
      balance_updated_at: account.balance_updated_at,
      balance_base_minor: balanceBaseMinor === null ? null : forecastMinor(balanceBaseMinor, 'balance_base_minor'),
    })),
    upcoming,
    warnings: result.warnings.map((w) => ({
      dimension: w.dimension,
      dimension_key: w.dimensionKey,
      currency_code: w.currencyCode,
      threshold_minor: forecastMinor(w.thresholdMinor, 'threshold_minor'),
      earliest_below_threshold_date: w.earliestBelowThresholdDate,
      earliest_non_positive_date: w.earliestNonPositiveDate,
      start_minor: forecastMinor(w.startMinor, 'start_minor'),
      minimum_projected_minor: forecastMinor(w.minimumProjectedMinor, 'minimum_projected_minor'),
      minimum_projected_date: w.minimumProjectedDate,
    })),
    missing_rates: result.missingRates,
  });
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }
});

// ---------- настройки ----------

/** Все настройки одним объектом — форма ответа у GET и PUT одна и та же. */
async function readAllSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const row of results) settings[row.key] = row.value;
  return settings;
}

apiV2.get('/settings', async (c) => c.json({ settings: await readAllSettings(c.env.DB) }));

const SETTINGS_WRITABLE_KEYS = new Set(['low_balance_threshold_minor', 'base_currency']);

/** low_balance_threshold_minor — целое >= 0; 0 валиден («предупреждать только при уходе в ноль»). */
function normalizeThresholdSetting(input: unknown): string {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) {
      throw new ValidationError('SETTING_VALUE_INVALID');
    }
    return String(input);
  }
  if (typeof input === 'string' && /^\d+$/.test(input.trim())) {
    const value = Number(input.trim());
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError('SETTING_VALUE_TOO_LARGE');
    }
    return String(value);
  }
  throw new ValidationError('SETTING_VALUE_INVALID');
}

/** base_currency — трёхбуквенный код ISO 4217 (приводится к верхнему регистру). */
function normalizeCurrencySetting(input: unknown): string {
  const code = normalizeIso4217CurrencyCode(input);
  if (code === null) throw new ValidationError('SETTING_CURRENCY_INVALID');
  return code;
}

function normalizeSettingValue(key: string, input: unknown): string {
  if (key === 'base_currency') return normalizeCurrencySetting(input);
  return normalizeThresholdSetting(input);
}

apiV2.put('/settings/:key', async (c) => {
  const key = c.req.param('key');
  if (!SETTINGS_WRITABLE_KEYS.has(key)) return fail(c, 'NOT_FOUND', 404);

  try {
    const body = await readBody(c);
    const value = normalizeSettingValue(key, body.value);
    // Курсы хранятся как `usd_per_unit` (fx_rates.rate_e9, см. миграцию
    // 0001) — они НЕ зависят от выбранной базовой валюты, поэтому смена базы
    // никогда не трогает fx_rates. Удаление курсов при смене базы было
    // регрессией (ALE-9, первый прогон): владелец видел, как введённые курсы
    // исчезают. Здесь — только запись настройки.
    await c.env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }

  return c.json({ settings: await readAllSettings(c.env.DB) });
});

// ---------- аналитика (S1-5b) ----------

apiV2.post('/analytics', async (c) => {
  let startDate: string | null = null;
  let endDate: string | null = null;
  let q: string | null = null;
  let cats: string[] | null = null;
  let merchants: string[] | null = null;
  let accounts: string[] | null = null;
  let currencies: string[] | null = null;

  try {
    const raw = await readLimitedJson(c.req.raw, ANALYTICS_MAX_JSON_BYTES);
    const body = asRecord(raw);
    startDate = normalizeNullableDateString(body.start_date, 'start_date');
    endDate = normalizeNullableDateString(body.end_date, 'end_date');
    if (startDate && endDate && startDate > endDate) {
      throw new ValidationError('DATE_RANGE_INVALID');
    }
    const filters = normalizeAnalyticsFilters(body);
    q = filters.q;
    cats = filters.cats;
    merchants = filters.merchants;
    accounts = filters.accounts;
    currencies = filters.currencies;
  } catch (e) {
    if (e instanceof BodyTooLargeError || e instanceof ValidationError) return failCaught(c, e);
    if (e instanceof SyntaxError) return fail(c, 'REQUEST_BODY_INVALID', 400);
    throw e;
  }

  const [ratesE9, settings, recurringRows] = await Promise.all([
    loadRates(c.env.DB),
    loadForecastSettings(c.env.DB),
    c.env.DB.prepare(
      'SELECT id, title, amount_minor, currency, account_id, category, frequency, interval_count, active FROM recurring_items WHERE active = 1',
    ).all<RecurringRuleRow>(),
  ]);

  let query = `
    SELECT 
      o.id,
      o.date,
      o.account_id,
      o.kind,
      o.store,
      o.item,
      o.category,
      o.subcategory,
      o.amount_minor,
      o.receipt_id,
      o.source,
      o.comment,
      o.receipt_url,
      a.name AS account_name,
      a.currency AS account_currency
    FROM operations o
    JOIN accounts a ON o.account_id = a.id
  `;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (startDate) {
    conditions.push('o.date >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('o.date <= ?');
    params.push(endDate);
  }
  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY o.date ASC, o.id ASC';

  const stmt = c.env.DB.prepare(query);
  const bound = params.length ? stmt.bind(...params) : stmt;
  const { results } = await bound.all<OperationWithAccount>();

  const missingRates = new Set<string>();
  const converter = makeConverter(ratesE9, settings.baseCurrency, (code) => missingRates.add(code));

  try {
    const analytics = buildAnalytics({
      operations: results,
      converter,
      baseCurrency: settings.baseCurrency,
      missingRates,
      filters: {
        start_date: startDate,
        end_date: endDate,
        q,
        cats,
        merchants,
        accounts,
        currencies,
      },
      recurringRules: recurringRows.results,
    });

    return c.json({
      ...analytics,
      base_currency: settings.baseCurrency,
    });
  } catch (e) {
    if (e instanceof ValidationError) return failCaught(c, e);
    throw e;
  }
});

// ---------- Backup export/import (issue #515) ----------
apiV2.route('/backup', backupApi);

// ---------- Instance reset (issue #579) ----------
apiV2.route('/data', dataApi);

// ---------- Passkeys Management (issue #507) ----------
apiV2.route('/passkeys', passkeysApi);

// ---------- MCP Access & Audit (S2-2, issue #262) ----------
apiV2.route('/mcp', mcpApi);

export default apiV2;
