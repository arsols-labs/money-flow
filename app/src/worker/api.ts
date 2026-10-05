// CRUD API v2 (S1-2, issue #196) — accounts, exchange rates, and settings reads.
// Every route requires a valid session (verifySessionCookie) and is mounted in
// index.ts as `app.route('/api/v2', apiV2)` — paths here have no prefix.
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

// Guard is the sub-app's only middleware and is registered FIRST: Hono
// runs middleware and routes in registration order, not "middleware always
// first" — a `use()` declared after the routes would not intercept them.
apiV2.use('*', async (c, next) => {
  // Internal calls from the MCP server inside the Worker
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

// ---------- shared helpers ----------

// A timestamp precise to the SECOND — the schema CHECK rejects milliseconds
// from a naive `new Date().toISOString()` (migrations/0001_initial_schema.sql).
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
  // An empty or broken body collapses to {} — that then yields the same 400 "missing required
  // fields" as meaningful but incomplete JSON: figuring out exactly how
  // the client failed is not necessary here.
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

/** bank/type: a string or null; an empty string after trim → null. */
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
 * owner/country: a non-empty string, like `name` and `currency`. Separate from
 * `normalizeOptionalText` because the ROADMAP rule "An account has one
 * owner, one currency, and a required country" leaves them no
 * "unspecified" state: an account without an owner cannot be selected for an operation (selection is
 * strictly by owner and currency, owner decision 2026-08-11), and an account without a
 * country is an empty column where v1 stores RUS/USA/SRB. `null` here is also an
 * error, not "leave as is": a PATCH that omits the field already leaves it untouched,
 * so an explicit `null` can only mean an attempt to erase a required value.
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

// Ordinal position in the account list. The range is narrow on purpose: a new account without
// an explicit sort gets MAX(sort)+1 with no checks, and if the table held a value
// at the very edge of the exact integer range, the increment would step past it — after that
// precision is lost and positions start to duplicate. A billion positions in
// the account list is headroom this task will never see.
const SORT_LIMIT = 1_000_000_000;

function normalizeSort(input: unknown): number {
  // isSafeInteger, not isInteger: past 2^53 a double has no fractional
  // part at all, so isInteger(1e21) === true — and such a value
  // lands in an INTEGER column as REAL (verified on local D1). The same
  // disease as rate_e9 below, the same remedy.
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || Math.abs(input) > SORT_LIMIT) {
    throw new ValidationError('INVALID_SORT');
  }
  return input;
}

// done/active/archived — the same boolean check for three resources
// (accounts, planned operations, and recurring operations). There used to be a private copy with the hardcoded
// field name 'archived' — generalized here so a third copy would not appear.
function normalizeBoolean(input: unknown, field: string): number {
  if (typeof input !== 'boolean') throw new ValidationError('FIELD_TYPE_BOOLEAN', { field });
  return input ? 1 : 0;
}

/** :id from the path — a non-numeric or fractional id cannot match anything; that is 404, not 400. */
function parseIdParam(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// ---------- accounts ----------

interface AccountRow {
  id: number;
  name: string;
  bank: string | null;
  type: string | null;
  account_number: string | null;
  // No `| null`: since migration 0004 both columns are NOT NULL, and an empty value
  // is already rejected by D1 itself (#234). Before that the type honestly reflected the schema; now
  // `| null` would describe a state that does not occur in the database.
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
    // Account aliases — for the "Data" UI (virtual-card binding, issue #339).
    // An empty array when there are none, so the client always sees the field in one shape.
    aliases: aliases ?? [],
  };
}

apiV2.get('/accounts', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM accounts ORDER BY archived ASC, sort ASC, id ASC',
  ).all<AccountRow>();
  // An account has few aliases, so a set of queries against account_aliases by account
  // id is cheaper than a JOIN with JSON grouping. The number of accounts in v2
  // is measured in ones, not thousands — N+1 does not hurt here.
  const accounts = await Promise.all(
    results.map(async (row) => toAccountJson(row, await listAliases(c.env.DB, row.id))),
  );
  return c.json({ accounts });
});

// ---------- account aliases (issue #339) ----------
//
// Virtual cards (`Visa *6125`, `DinaCard`) are bound to a real
// account through account_aliases. The resolver (resolveOrPend) is the only point
// where history import (#340) and automation (#341) turn a receipt's "charge account"
// into an account_id; on an unknown account it does not fail, but stores a row in
// pending_account_strings (the /pending endpoints below), which is later handled by
// the Hermes Scheduled Job (#341) via Telegram.
//
// AliasError carries its own HTTP status — catch it separately from ValidationError.

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

// List of unbound accounts from receipts — for the Hermes Scheduled Job (#341).
apiV2.get('/accounts/pending', async (c) => {
  return c.json({ pending: await listPending(c.env.DB) });
});

// Binding an unknown account to a real one: creates an alias and removes the row from
// pending. Called by the owner's reply to a Telegram confirmation (#341).
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
      // max(sort)+1 across ALL accounts (including archived) — a new account must not
      // accidentally take someone else's place after unarchiving. An empty table → 0.
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

// Account dimensions — five fields the ROADMAP rule declares immutable
// after the first operation: "After the first operation the owner, currency, country, bank,
// and account kind are immutable." The lock does not touch the other PATCH fields: `name`
// is always editable (the name is editable under the same rule), `balance_minor` is
// the point of the "Data" screen, and `sort` and `archived` are row flags, not properties
// of the money on it.
const ACCOUNT_LOCKED_FIELDS = ['owner', 'currency', 'country', 'bank', 'type'] as const;

// Tables whose reference means "the account has had an operation." One list for
// both checks below: a new referencing table would otherwise silently drop out of
// one of them, and DELETE and PATCH would disagree about occupancy. The values
// are literals; user input never reaches here.
//
// `operations` matters here, and not only for symmetry: an operation's currency
// is not stored; it is taken from the account (migration 0005). Changing the account currency
// retroactively would rewrite the meaning of EVERY amount on it — 1,200 RSD would become
// 1,200 USD without a change in any column. The dimension lock is the only thing
// that prevents that.
const ACCOUNT_REF_TABLES = ['operations', 'planned_items', 'recurring_items'] as const;

/** How many operations, planned rows, and recurring rows reference the account. */
async function countAccountRefs(db: D1Database, id: number): Promise<number> {
  // An explicit COUNT instead of relying on the FK firing: an FK without
  // ON DELETE (the schema) would reject the DELETE anyway, but we need our own
  // error text and a 409, not whatever D1 returns when the FK is violated.
  const refs = await db
    .prepare(
      `SELECT ${ACCOUNT_REF_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE account_id = ?)`).join(' + ')} AS cnt`,
    )
    .bind(...ACCOUNT_REF_TABLES.map(() => id))
    .first<{ cnt: number }>();
  return refs?.cnt ?? 0;
}

// The same condition, but usable inside an UPDATE — a race guard. The early
// `countAccountRefs` check yields a clear 409 and runs before every other rejection,
// but between it and the write the account can gain an operation: v2 has no
// per-request transaction. The condition in the `WHERE` itself makes the check and the write atomic — the same
// technique and the same reason as `RATE_DELETABLE_SQL` below. References point at
// `accounts.id` (a correlated subquery), so we do not multiply extra binds.
const ACCOUNT_UNLOCKED_SQL = ACCOUNT_REF_TABLES.map(
  (table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE account_id = accounts.id)`,
).join('\n  AND ');

apiV2.patch('/accounts/:id', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  // Normalized values go into a Map, not straight into SQL: the lock below
  // compares them with the current row, and doing that on the raw request body
  // is wrong — 'usd' and 'USD' are different strings there, but the same currency in the database.
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

  // The dimension lock fires on an ACTUAL change, not on the field's presence
  // in the body: the edit form always sends every field, including
  // untouched ones, and a "the field arrived" check would turn renaming an account into
  // a 409. Archiving does not lift the lock — the rule makes no exception for the archive,
  // and the money on an archived account has not gone anywhere.
  const touchesLocked = ACCOUNT_LOCKED_FIELDS.some(
    (field) => updates.has(field) && updates.get(field) !== current[field],
  );

  // The lock is checked FIRST among rejections, and that order is load-bearing: it is
  // terminal, while the balance_minor requirement below is fixable. In the reverse order
  // a currency change on an occupied account would answer "add balance_minor", and a
  // compliant retry would answer "too late to change": the client would be led in a circle.
  if (touchesLocked && (await countAccountRefs(c.env.DB, id)) > 0) {
    return fail(c, 'ACCOUNT_LOCKED', 409);
  }

  // Currency and balance are linked, even though they are two independent fields in the request body:
  // balance_minor is stored in the minor units of ITS OWN currency, and the scale
  // differs by currency. Changing USD to JPY without touching the balance means turning
  // $1500.00 (150000 cents) into ¥150,000, silently and by two orders of magnitude. So a currency
  // change requires naming the balance in the new currency explicitly in the same request: let
  // the client decide whether to convert the amount or confirm it as is.
  if (updates.has('currency') && updates.get('currency') !== current.currency && !updates.has('balance_minor')) {
    return fail(
      c,
      'ACCOUNT_CURRENCY_CHANGE_REQUIRES_BALANCE',
      400,
    );
  }

  // A field that keeps its previous value is left out of SET entirely. For unlocked fields that is just
  // a saving; for locked ones it is the only protection: the guard below is added
  // only when dimensions actually change, and without this filter a request
  // that "did not change" the dimensions would still rewrite them from a snapshot
  // read earlier — that is, it would roll back someone else's concurrent edit
  // around the lock. If we do not write it, there is nothing to lose.
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of updates) {
    if (value === current[field]) continue;
    setClauses.push(`${field} = ?`);
    values.push(value);
  }

  // balance_minor in the body confirms the balance "as of now", even when
  // the number matches the old one: a mark of "I checked" is not the same as "I did not change it".
  if (updates.has('balance_minor')) {
    setClauses.push('balance_updated_at = ?');
    values.push(nowIso());
  }

  // Every supplied value matched the current one — there is nothing to write. This is the normal
  // case, not an error: the edit form sends every field, and "save without
  // changing anything" must answer the same way a real change would.
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

  // We reach this only via a race: occupancy and existence of the account were checked
  // above, so zero updated rows means that between the check and
  // the write the account was deleted or the first operation came to reference it. Which one
  // happened is sorted out by a separate SELECT — it runs only on this path and
  // does not make an ordinary edit more expensive (the same technique as the rate DELETE below).
  if (!row) {
    const stillThere = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first();
    return stillThere ? fail(c, 'ACCOUNT_LOCKED', 409) : fail(c, 'NOT_FOUND', 404);
  }
  return c.json({ account: toAccountJson(row) });
});

// Balance confirmation without editing the amount (issue #223). A separate route, not
// a field in the PATCH body, for three reasons at once. The action means the opposite of an edit:
// it does NOT change the data, it attests to them — mixing it into the endpoint
// that changes data would lose that distinction on the first reading of the code.
// PATCH also collects fields in a loop over ACCOUNT_PATCH_FIELDS and checks that
// "at least one known field was sent"; an exception flag would have to be threaded
// past the loop, past the dimension lock, and past the "nothing to write" check — three
// branches in code that today reads linearly. And third: a confirmation
// must be unambiguous. A body `{"confirm_balance": true}` raises the question of
// what to do with `false` and with a flag combined with an amount in one request; a route
// with no body has no such questions.
//
// The request body is not read at all: there is nothing to confirm except the fact itself.
// The dimension lock (ACCOUNT_LOCKED_FIELDS) does not apply here — the moment of confirmation
// is not an account dimension, and confirming the balance of an account that already has operations matters all the
// more. An archived account is confirmed too: the money on it has not gone anywhere.
apiV2.post('/accounts/:id/confirm-balance', async (c) => {
  const id = parseIdParam(c.req.param('id'));
  if (id === null) return fail(c, 'NOT_FOUND', 404);

  // One statement, without a "read then write" pair: v2 has no per-request
  // transaction, and the account can be deleted between the read and the write. Zero updated
  // rows here means exactly one thing — the account does not exist — because the
  // WHERE has no other conditions; there is nothing to sort out with a second query the way PATCH does.
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

  // An explicit COUNT instead of relying on the FK firing: an FK without
  // ON DELETE (the schema) would reject the DELETE anyway, but we need our own
  // error text and a 409, not whatever D1 returns when the FK is violated.
  if ((await countAccountRefs(c.env.DB, id)) > 0) return fail(c, 'ACCOUNT_IN_USE', 409);

  try {
    await c.env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  } catch (e) {
    // A reference can appear between the COUNT above and this DELETE — the check and
    // the action are not in one transaction. The API still has no way to create
    // such a row, but the planned and recurring endpoints arrive in the next
    // task, and then a bare COUNT would give the owner a 500 instead of a clear
    // "account is in use". The response is the same whichever way we learn it.
    if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) {
      return fail(c, 'ACCOUNT_IN_USE', 409);
    }
    throw e;
  }
  return c.body(null, 204);
});

// ---------- exchange rates ----------
//
// Section invariant (issue #193): a currency that is referenced must
// have a rate to the base. The schema cannot express it — a SQLite CHECK cannot see another
// table, and v2 has no triggers on purpose — so it is held here: DELETE does not
// remove the rate of a currency in use, and GET shows currencies in use that lack a rate.
//
// The guarantee is one-sided, and that is deliberate: creating an account in a currency with no rate
// is still allowed, and so is changing the base currency in settings. The code
// does not let a rate be LOST, but it does not promise that a rate always exists. The product
// rationale and the conversion requirement are the spec, docs/2026-08-09-v2-simple-spec.md,
// section "Data"; how the checks are built is the README, "API and v2 screens".

interface FxRateRow {
  code: string;
  rate_e9: number;
  updated_at: string;
}

// Parsing a rate is integer-only, with no float anywhere on the path (see the comment on
// fx_rates in migrations/0001_initial_schema.sql). Format: a non-negative
// decimal, at most nine digits after the point, no exponent and
// no sign — silent rounding of the input is forbidden by the contract.
const RATE_PATTERN = /^\d+(\.\d{1,9})?$/;

// The upper bound belongs here, not in the schema. The regex does not limit
// the integer part, and `rate_e9` is the input multiplied by 1e9, so a long
// digit string overflows SQLite's 64-bit INTEGER. Verified on local
// D1: a 23-digit `rate_e9` lands in the column as REAL (`typeof` → 'real',
// value 1e+23), and `CHECK (rate_e9 > 0)` lets it through — so without a bound
// a bad input is not rejected; it quietly turns an integer rate into a float,
// exactly what this arithmetic exists to avoid. MAX_SAFE_INTEGER is a rate up to
// ~9,007,199 base units per one foreign unit, orders of magnitude above any real
// currency, and it also guarantees that formatting back through Number stays exact.
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

/** Formatting rate_e9 back into a human string, also integer-only. */
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

// Tables with a `currency` column — the single list for the whole file, so the two
// checks below cannot drift apart. The values are literals, and only they go into SQL:
// user input never reaches here, whatever the request looks like.
// Exported for the test that checks the list against the real schema: otherwise a new
// table with a `currency` column would silently drop out of both checks.
//
// `operations` is absent from the list, and that is not an omission: it no longer has its own `currency`
// column (migration 0005) — an operation's currency equals the account currency and is taken
// from the account with a `JOIN`. Such an operation still holds a currency "in use", but through
// `accounts`, which it already references. The schema-reconciliation test guards this:
// if the column comes back, the list has to grow.
export const CURRENCY_TABLES = ['accounts', 'planned_items', 'recurring_items', 'imported_receipt_items'] as const;

// Base-currency normalization lives in two forms — in JS and in SQL — because the
// `DELETE` below must perform the check in one statement, not by comparing with a
// value read ahead of time. The SQL list is built from the same ISO snapshot,
// so raw junk such as `ZZZ` does not receive base-currency privileges.
const ISO_4217_CODES_SQL = ISO_4217_CURRENCY_CODES.map((code) => `'${code}'`).join(', ');
const BASE_CURRENCY_SQL = `(
  SELECT upper(trim(value))
  FROM settings
  WHERE key = 'base_currency' AND upper(trim(value)) IN (${ISO_4217_CODES_SQL})
)`;

/**
 * The base currency from settings, or `null` when the value is unusable. It has no
 * rate of its own and must not have one — it is the unit of conversion, so the rate to
 * itself is one by definition. Three consequences follow: it never lands in `missing`;
 * giving it a rate is forbidden — `PUT` answers 400 (#228);
 * and an accidental fx_rates row for it may be deleted even while the currency is in use
 * (otherwise an input mistake could not be repaired). Entry is closed and exit is left
 * open on purpose: rows created before the ban, or by a direct database edit, would otherwise
 * have no way to be removed.
 *
 * That is why an unusable value yields `null` rather than substituting 'USD'.
 * The decision covers both normalization forms at once — they must agree (see
 * `BASE_CURRENCY_SQL` above), so a default would have had to exist in SQL as well.
 * A default would have looked more harmless, but it would apply all three consequences to
 * ONE SPECIFIC currency: with junk in settings the dollar would silently stop
 * appearing in `missing`, become deletable while live dollar accounts exist, and
 * lose the right to a rate — while the base at that moment may well not be the dollar.
 * A broken setting would, at once and unnoticed, drop two protections and
 * add an extra ban. `null` fails the other way: nobody receives either
 * a relaxation or a ban, and an extra currency in `missing` is
 * a visible, harmless inaccuracy.
 *
 * PUT /settings/base_currency accepts only a current ISO 4217 code, so
 * an unusable value is reachable only by editing the database directly. The defensive read
 * is still required: a manual mistake must not silently appoint another base.
 */
async function readBaseCurrency(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT ${BASE_CURRENCY_SQL} AS code`).first<{ code: string | null }>();
  // Normalization is shared with forecast/load.ts (shared/currency.ts): if the
  // two forms diverged, `GET /fx-rates` and `GET /forecast` would treat different currencies as the base
  // for the same value in settings.
  return normalizeIso4217CurrencyCode(row?.code);
}

/**
 * Currencies referenced at least once in the database. Archived accounts count
 * the same as active ones on purpose: in v2, archive is a row flag, not a write-off
 * of money. The money is still on the account, one PATCH can unarchive it, and
 * any total it lands in still needs a rate. The original scenario #193 is built
 * exactly on "archived rows do not hold the reference data".
 */
async function currenciesInUse(db: D1Database): Promise<Set<string>> {
  // UNION, not UNION ALL: duplicates are unwanted, and deduplication is cheaper
  // in SQLite than shipping one row per account and per expense into the Worker.
  const sql = CURRENCY_TABLES.map((table) => `SELECT currency FROM ${table}`).join(' UNION ');
  const { results } = await db.prepare(sql).all<{ currency: string }>();
  return new Set(results.map((row) => row.currency));
}

apiV2.get('/fx-rates', async (c) => {
  // The three queries are independent of each other, so they run in parallel. Run sequentially,
  // they would triple the load time of the "Data" screen for no reason at all.
  const [{ results }, baseCurrency, inUse] = await Promise.all([
    c.env.DB.prepare('SELECT code, rate_e9, updated_at FROM fx_rates ORDER BY code').all<FxRateRow>(),
    readBaseCurrency(c.env.DB),
    currenciesInUse(c.env.DB),
  ]);
  const known = new Set(results.map((row) => row.code));
  // Currencies in use for which conversion is impossible. The anchor currency (USD) needs no rate
  // by definition. If any other currency (including the base) is missing
  // from the rates table, conversion through USD breaks. The screen shows that
  // as a warning so the owner enters a rate to USD.
  const missing = [...inUse].filter((code) => code !== 'USD' && !known.has(code)).sort();
  return c.json({ base_currency: baseCurrency, rates: results.map(toRateJson), missing });
});

apiV2.put('/fx-rates/:code', async (c) => {
  const code = normalizeCurrencyCodeParam(c.req.param('code'));
  if (code === null) {
    return fail(c, 'CURRENCY_CODE_INVALID', 400);
  }

  // Entry is closed, exit is not: USD is the absolute anchor (usd_per_unit).
  // A row for USD is pointless; 1 USD = 1 USD always.
  // DELETE of such a row that is already in the database is allowed — it is the only way to remove it.
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
  // As a string, not bigint/number: D1 does not accept bigint in bind(), and SQLite
  // INTEGER affinity itself turns a digit string into an integer with no loss —
  // which also avoids JS Number losing precision on a large rate_e9.
  // Rates are independent of the base (usd_per_unit), so changing the base does not touch them.
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

// "A rate may be deleted": either this is the anchor currency (USD), or nothing
// references the code. The condition sits inside the DELETE itself, not in a separate SELECT
// beforehand, and that is not a matter of style: check and delete in one statement
// are atomic, so a row inserted between them is impossible.
// A "SELECT, then DELETE" pair would leave that window, and there is no transaction
// per request. References inside the subqueries point at `fx_rates.code`, so we
// do not repeat the same binds.
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

  // Zero deleted rows means one of two things: the row was absent (404), or it
  // is present but the currency is in use (409). A separate SELECT tells them apart — it runs
  // only on the failure path and does not make a normal delete more expensive. It is also
  // the right answer to two concurrent DELETEs: the one that loses gets 404
  // "already gone", not 409 "in use".
  const existing = await c.env.DB.prepare('SELECT code FROM fx_rates WHERE code = ?').bind(code).first();
  return existing ? fail(c, 'RATE_IN_USE', 409, { code }) : fail(c, 'NOT_FOUND', 404);
});

// ---------- planned operations ----------
//
// One-off operations with a definite date (S1-3, issue #197). The row currency
// is independent of the account currency — the same as accounts and expenses in CURRENCY_TABLES
// above: the currency column is its own, changing one does not change the other, and they
// do not have to match. The account dimension lock (issue #232) does not
// apply to planned_items: the ROADMAP rule locks the account card, not the operations
// that reference it.

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

// Dates are TEXT 'YYYY-MM-DD' (header of 0001_initial_schema.sql). The schema checks
// the format with a round trip through SQLite `date()`. The same check is required BEFORE the write:
// without it "2026-02-30" hits the CHECK and fails as a 500 instead of a clear 400.
// `Date.UTC` plus comparing the components back is the same technique as `date()`, but
// independent of the environment timezone: `new Date('2026-02-30')` without UTC does not
// throw at all in some timezones; it quietly slides onto a neighboring day.
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

/** end_date — the same format check, but null is explicitly allowed (clear the deadline). */
function normalizeNullableDateString(input: unknown, field: string): string | null {
  if (input === null || input === undefined) return null;
  return normalizeDateString(input, field);
}

// amount_minor — the same integer rule as an account's balance_minor, plus
// a ban on zero: the schema rejects zero with a CHECK (amount_minor <> 0). An account
// balance has no such limit (an empty account is ordinary).
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
 * The account by id — to check that it exists and to take the default currency.
 * An archived account is allowed on purpose: archive is a row flag (see
 * `toAccountJson`), not a ban on operations against it.
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
 * Operation kind from the sign of the planned item. A planned item has no `kind`: minus is an expense,
 * plus is income. A refund (`refund`) cannot be derived from this — a plan has none,
 * and issue #267 does not ask for one.
 */
function kindFromPlannedAmount(amountMinor: number): 'expense' | 'income' {
  return amountMinor < 0 ? 'expense' : 'income';
}

/**
 * An operation has no currency of its own — it equals the account currency. Applying a
 * planned item's `amount_minor` "as is" is valid only in those same units.
 * A silent conversion by rate is worse than a refusal: we never promised a rate on the plan's date,
 * and foreign minor units on the account are a lie about the money.
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
  // UNIQUE on planned_item_id is a net for a race between two completions. An empty INSERT
  // is deliberately not done here: a balance delta cannot be attached to it without
  // applying that delta a second time on the next request.
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
    // The default currency is the account currency, but it stays independent afterward: an explicitly
    // passed currency is accepted as is and does not have to match the account currency
    // (see the section docblock).
    const currency = body.currency === undefined ? account.currency : normalizeCurrency(body.currency);
    const category = normalizeOptionalText(body.category, 'category');
    const done = body.done === undefined ? 0 : normalizeBoolean(body.done, 'done');

    if (done === 1) {
      assertPlannedCurrencyMatchesAccount(currency, account.currency);
      assertSafeBalanceDelta(account.balance_minor, amountMinor);
      // Creating it already completed is the same fact as marking it done: the planned item,
      // the operation, and the balance delta go in one batch. last_insert_rowid() takes the
      // id of the planned item just inserted in this same transaction.
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

    // The same reason as for accounts: amount_minor is stored in the minor units
    // of ITS OWN currency, and currencies differ in scale. Changing account_id does not
    // redefine the currency — only an explicit currency change requires the amount in the same request.
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
  // An old checkbox with no operation (before #267), and a repeated done: true after
  // the fact was deleted, take the same path as the first completion, but ONLY when
  // done: true is sent explicitly. Otherwise an ordinary edit of fields (title,
  // category) on a completed planned item tries to materialize an operation and
  // fails on a currency mismatch with the account (#282).
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

  // When the fact does not change — a single CAS UPDATE. A stale snapshot gets 409
  // instead of silently overwriting a newer edit.
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

  // The CAS UPDATE goes first. Each following statement applies its effect
  // only when the previous one changed exactly one row (`changes() = 1`).
  // A stale snapshot therefore creates no operation and does not move the balance.
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

// ---------- recurring operations ----------
//
// A rule is stored as an anchor plus a step (header of 0001_initial_schema.sql): day and month
// matter only for some frequencies, and the link between them is enforced by
// the CONSTRAINTs `recurring_items_rule_anchors` (0001) and
// `recurring_items_yearly_month_matches_anchor` (0003) — both fire on ANY
// UPDATE of the row, not only on INSERT. The validation below does not duplicate those
// CHECKs; it answers with a clear 400 BEFORE the request reaches them. Without it,
// inconsistent input would fail as a 500 with SQLite's text instead of an explanation.

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

// day_of_month/month_of_year share one shape: a number inside the schema CHECK bounds,
// or null. undefined is treated as null — on POST both mean "the field
// did not arrive", and this path is unreachable inside the PATCH loop (only fields
// that actually arrived in the body get there; see `field in body` below).
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
 * Anchors for a NEW row (POST). day_of_month is explicit, or derived from the day of
 * next_due_date. For a yearly rule, month_of_year is always derived from next_due_date;
 * an explicit value is accepted only when it matches the derived one (the CONSTRAINT
 * in migration 0003 requires exactly that, and not only on INSERT).
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
 * Anchors for an EDIT of an existing row (PATCH) — the rule is evaluated as a whole:
 * the effective frequency decides which anchors are required, and `dayProvided` /
 * `monthProvided` distinguish "the client left the field alone" (inherit it from the old
 * row, or derive it from the date) from "the client sent it explicitly" (including an explicit null —
 * a rejection when the frequency requires a value). Changing frequency without touching
 * the anchors themselves must decide their fate: otherwise PATCH
 * `{ frequency: 'daily' }` on a monthly rule would hit the schema CHECK instead of
 * a clear result (section docblock).
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
    // The rule already carried an anchor — keep it as is. That is what "a sliding
    // date does not move day_of_month" means: the 31st, once clamped to 28 February,
    // must not stay the 28th forever (docblock of 0001). current.day_of_month
    // is guaranteed not NULL here — the schema itself requires that for these frequencies.
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

  // yearly — month_of_year is ALWAYS derived from next_due_date, even when
  // the client did not touch it: moving the date into another month must carry the anchor
  // along in the same PATCH (docblock of migration 0003).
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

    // effectiveNextDueDate is needed by both the anchors and the end_date check — compute it once.
    const effectiveNextDueDate = updates.has('next_due_date')
      ? (updates.get('next_due_date') as string)
      : current.next_due_date;

    // The rule is evaluated as a WHOLE: none of the four fields is valid without
    // the other three (section docblock), so the recompute runs when
    // at least one of them was touched, and it rewrites both day_of_month and month_of_year
    // at once — including the field the client did not name.
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

    // end_date keeps ITS OWN invariant (>= next_due_date) on every UPDATE of the row
    // (docblock of 0002), not only when it is changed explicitly: a separate PATCH must not push the anchor past
    // a deadline that is already set — answer 400 before the schema rejects it.
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

// Closing a recurring-payment period (issue #280): it creates a fact operation
// (source = 'recurring'), moves the account balance, and shifts the sliding anchor
// `next_due_date` to the next occurrence (nextOccurrence).
//
// If the next occurrence falls past `end_date`, the rule is deactivated
// (active = 0) and the anchor date stays inside the CHECK bounds.
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

// Skipping a recurring-payment period (issue #280): shifts the anchor to the next
// occurrence without creating an operation and without changing the balance.
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

// ---------- operations ----------
//
// Expenses, income, and refunds in one table (S1-5a, issue #200; owner decision
// of 2026-08-12, which cancelled the spec's former premise that "an expense has no account"). Three rules,
// without which the rest of this section reads as arbitrary:
//
//   1. AN ACCOUNT IS REQUIRED. Every operation happened on some account — that is
//      the "console for watching the flow of money" from the idea of the project.
//   2. CURRENCY IS NEITHER STORED NOR SUPPLIED — it always equals the account currency.
//      The reason is not technical: a dollar purchase charged to a dinar account is debited
//      in dinars, and storing "dollars" on the operation would record something that was never
//      on the account. JSON still has a currency — that is a `JOIN`, not a column (0005).
//   3. THE AMOUNT IS THE ACCOUNT-BALANCE DELTA: an expense is negative, income and a refund
//      are positive, and CONSTRAINT `operations_sign_matches_kind` requires the same thing.
//      The old `expenses` table kept the opposite convention, inherited from the v1 sheet;
//      it became wrong at the moment the amount started to adjust the balance.
//
// THE ACCOUNT BALANCE MOVES TOGETHER WITH THE OPERATION — on create, on edit, and on delete.
// This is not double-entry bookkeeping: the balance remains an editable field,
// a manual reconciliation with the bank is still the authority, and an operation only saves
// retyping the amount after every purchase. One consequence is worth
// knowing: a bank balance entered after a purchase already includes that purchase — and
// an operation entered next will subtract it a second time. The drift heals itself at the
// next manual reconciliation, because the balance is a field, not the sum of operations;
// the screen shows the future value before save, so the effect is visible.
//
// `balance_updated_at` is NOT moved when that happens, and that too is a decision: the mark
// means "I reconciled with the bank" (issue #223), and a correction we computed
// is not a reconciliation. Moving the mark would clear the "time to
// reconcile" reminder at the exact moment the gap with the bank is growing.

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

/** An operation row together with the account currency — the shape sent to the client. */
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
    // Not a column: it is the account currency. An operation has none of its own (see rule 2 above).
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

// Currency is taken with a `JOIN` on every read — an operation has no currency column of its own.
// INNER JOIN, not LEFT: `account_id NOT NULL` plus an FK with no ON DELETE mean
// that an operation without an account does not exist, and substituting null would be a lie.
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
 * The amount's sign and the operation kind are checked together because the schema
 * checks them together. Without that, an expense with a positive amount would hit CONSTRAINT
 * `operations_sign_matches_kind` and come back as a 500 with SQLite's text instead of
 * an explanation. The sign is not silently derived from the kind: a client that sent "an expense
 * of +350" was wrong in one of the two fields, and which one they meant
 * is unknown.
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
 * A subcategory without a category is forbidden by the schema (`operations_subcategory_needs_category`)
 * and meaningless on its own: "Vegetables and fruit" by itself clarifies nothing.
 * The check belongs here for the same reason as the previous one — a clear 400
 * instead of a database rejection.
 */
function assertSubcategoryHasCategory(category: string | null, subcategory: string | null): void {
  if (subcategory !== null && category === null) {
    throw new ValidationError('SUBCATEGORY_REQUIRES_CATEGORY');
  }
}

/**
 * This API does not set an operation's origin: manual entry is always
 * `source = 'manual'` with an empty `receipt_id`. Receipt line items are created by S2 on its own
 * path. A supplied value is rejected, not ignored: a client that expected
 * a link to a receipt would otherwise get 201 with an empty reference and conclude that the link
 * was stored. It would be a 201, not a database rejection: the INSERT below writes `NULL, 'manual'`
 * as literals, and `OPERATION_PATCH_FIELDS` contains neither column — a supplied value
 * never reaches the CHECK at all.
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
 * Adjusting the account balance by a delta is only for CREATE, where the amount is known from
 * the input and there is not yet a row it could drift away from.
 * Edit and delete compute the delta differently — with a subquery against the live row (see
 * the comment in `PATCH` below): doing the arithmetic in JS from a snapshot already read produces a
 * lost update when two requests run in parallel.
 *
 * `balance_updated_at` is left untouched on purpose (section docblock).
 */
function balanceDeltaStatement(db: D1Database, accountId: number, deltaMinor: number) {
  return db.prepare(
    'UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ? AND (balance_minor + ?) BETWEEN ? AND ?',
  ).bind(deltaMinor, accountId, deltaMinor, SAFE_MINOR_MIN, SAFE_MINOR_MAX);
}

apiV2.get('/operations', async (c) => {
  // Newest first — the reverse of planned items, for the same reason theirs
  // runs the other way: planned items look ahead, and an operation has already happened.
  // id, the second key, is descending too: the one entered later stands higher.
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

    // Currency is not accepted from the client — it belongs to the account, and the response takes it
    // from there as well. Checking that the account exists matters on its own: without it the FK
    // would return 500 instead of a clear "Account not found".
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

  // batch is one transaction (D1). Writing the operation and adjusting the balance have to be
  // atomic: half of that pair would mean either a lost operation or
  // a balance that has drifted from the history with no trace.
  const [balanceRes, inserted] = await c.env.DB.batch<OperationRow>(statements);
  if (!ledgerApplied(balanceRes) || !inserted?.results[0]) {
    return fail(c, ledgerApplied(balanceRes) ? 'BALANCE_OUT_OF_SAFE_RANGE' : 'LEDGER_EFFECT_MISSING', 400);
  }
  return c.json({ operation: toOperationJson({ ...inserted.results[0]!, currency: accountCurrency }) }, 201);
});

// source and receipt_id are omitted from the list on purpose: an operation's origin
// is not an editable field. Editing the data itself (what was bought, for how much, from which
// account) is allowed regardless of origin: a wrong name on a recognized
// receipt line is ordinary, and the owner fixes it here.
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

  // The rule is evaluated on the EFFECTIVE row — what the row will be after the patch —
  // not on the fields that were sent. Otherwise changing only `kind` on a monthly expense
  // row would hit the schema CONSTRAINT instead of a clear answer: the same technique
  // and the same reason as the recurring-rule anchors above.
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
      // Changing the account changes the operation's currency, because the operation has none of its own.
      // Without this check, moving "1,500.00 RSD" onto a dollar account would answer 200
      // and leave `amount_minor` unchanged: 1,500 dinars would silently become
      // 1,500 dollars, with no column changed. Caught by an independent
      // run of rule 13. The dimension lock (#232) does not close this path — it
      // forbids changing the currency OF THE ACCOUNT, not moving an operation onto an account in another
      // currency.
      //
      // The requirement matches accounts and planned items on a currency change: the amount
      // has to be named again, in the new currency. Converting by rate on the owner's behalf
      // is not allowed — the rate on the operation's date is unknown, and silently rounding someone else's
      // money is worse than asking again.
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

  // The balance is adjusted by THREE statements, and each one reads the live row
  // with a subquery rather than a snapshot taken earlier: remove what is actually stored,
  // write the new value, then apply what it actually became.
  //
  // The technique matches the DELETE below, but it fixes more than a race with deletion.
  // The previous version computed the delta in JS from the `current` snapshot — and two
  // parallel PATCHes produced a classic lost update: the other device
  // adjusts the amount by −40,000 (balance 60,000), then our request, holding a snapshot of
  // −25,000, adjusts it to −30,000 and subtracts the difference from ITS OWN snapshot → 55,000
  // instead of 70,000. Both answers are 200, and nobody sees an error. Caught by an independent
  // run of rule 13 against a reproducible stand-in for `batch`.
  //
  // Live subqueries close that whole class: whatever the other request managed to do,
  // the balance stays equal to "starting balance plus the sum of every operation on the account".
  // Field order on the row itself is still last-write-wins
  // — ordinary PATCH behavior, here and for planned items — and that does not
  // break the invariant. If the row was deleted, all three subqueries yield NULL, `WHERE id = NULL` matches
  // nothing, RETURNING is empty, and the result below is an honest 404 with no
  // balance change at all.
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

  // Removing the operation's contribution from the balance happens BEFORE the delete and reads the live
  // row with a subquery, not a value read earlier: a "SELECT, then
  // DELETE" pair would leave a window in which the amount can change, and the balance
  // would lose something other than what was stored. If the row is gone, the subquery yields NULL, `WHERE id
  // = NULL` matches nothing, and the UPDATE does nothing.
  //
  // If a planned item produced the operation, done is cleared in the same batch: once the
  // fact is deleted the plan is waiting again. Otherwise the forecast misses it and the checkbox lies.
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

// ---------- transfers between accounts ----------
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

// Atomic edit of a transfer (#401): instead of forbidding a PATCH of each leg
// on its own, both operations are updated in one batch. Balances are adjusted with the same
// live subqueries as PATCH /operations (each reads the live row,
// not a snapshot, which closes lost updates under concurrent edits). Changing
// currency is forbidden without an explicit amount in the new currency (the same lock as
// PATCH /operations). Zero amounts are forbidden, as they are in POST.
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

  // Changing currency is forbidden without an explicit new amount (the same lock as PATCH).
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
// ---------- forecast ----------
//
// The engine (forecast/build.ts) is a pure function with no D1. All data loading
// lives in forecast/load.ts (issue #198, S1-4). The route below only joins the two
// and serializes BigInt fields to ordinary JS numbers — the same technique as
// balance_minor and rate_e9 elsewhere in API v2. Amounts here always fit in
// Number.isSafeInteger, and JSON.stringify cannot serialize a bigint at all.

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

  // The server's "today", in UTC — the viewer's timezone is ignored, as for every
  // financial date in v2 (header of migrations/0001_initial_schema.sql).
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

  // The same converter used inside buildForecast. Rounding, and the meaning of
  // "no rate", must match the aggregates down to the last minor unit.
  // A separate instance (one that does not collect missing_rates) is required because the list of
  // missing currencies was already computed by the core and is not collected again.
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

// ---------- settings ----------

/** Every setting in one object — GET and PUT share the same response shape. */
async function readAllSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const row of results) settings[row.key] = row.value;
  return settings;
}

apiV2.get('/settings', async (c) => c.json({ settings: await readAllSettings(c.env.DB) }));

const SETTINGS_WRITABLE_KEYS = new Set(['low_balance_threshold_minor', 'base_currency']);

/** low_balance_threshold_minor — an integer >= 0; 0 is valid ("warn only when the balance reaches zero"). */
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

/** base_currency — a three-letter ISO 4217 code (folded to uppercase). */
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
    // Rates are stored as `usd_per_unit` (fx_rates.rate_e9; see migration
    // 0001). They do NOT depend on the chosen base currency, so changing the base
    // never touches fx_rates. Deleting rates when the base changed was
    // a regression (ALE-9, first run): the owner watched rates they had entered
    // disappear. This path writes the setting only.
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

// ---------- analytics (S1-5b) ----------

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
