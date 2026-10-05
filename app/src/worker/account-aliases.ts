// Account aliases (issue #339) — a resolver from virtual cards to a real
// account, and work with the list of "unknown" accounts from receipts.
//
// Two responsibilities, one table for each:
//   * account_aliases — a string from a receipt → account_id (there is no reverse path);
//   * pending_account_strings — an account from a receipt that is not bound yet.
//
// The resolver (`resolveOrPend`) is the only point through which history
// import (#340) and automation (#341) turn a receipt's charge account into a
// v2 account. By contract it NEVER throws on an unknown account: it either
// returns account_id, or puts the string into pending and returns null
// (Law 1 — a silent import failure is worse than an explicit "needs confirmation" mark).
//
// Normalization. `alias_text` stores the original (including case: on the sheet
// `Visa *6125`, not `visa`), and `alias_norm` is the form used for matching:
// trim, collapsing internal whitespace, lower-case. So `Visa *6125` and
// `visa *6125` point at one account, and UNIQUE on `alias_norm` does not allow
// creating the same alias twice under different case. The same algorithm
// (normalizeAlias) is applied to pending rows, so one and the same unknown
// account lands in the list exactly once, whatever case/whitespace hallucination
// the receipt extractor produced.
import type { D1Database } from '@cloudflare/workers-types';
import { AppError, type ApiErrorCode, type ApiErrorParams } from '../shared/api-errors';

/** An aliases-layer error with a ready HTTP status — the API layer only rethrows it. */
export class AliasError extends AppError {
  constructor(status: number, code: ApiErrorCode, params?: ApiErrorParams) {
    super(code, status, params);
    this.name = 'AliasError';
  }
}

export interface AliasRow {
  id: number;
  account_id: number;
  alias_text: string;
  alias_norm: string;
  created_at: string;
}

export interface PendingStringRow {
  id: number;
  raw_string: string;
  raw_norm: string;
  first_seen_at: string;
}

export interface AliasJson {
  id: number;
  account_id: number;
  alias_text: string;
  created_at: string;
}

export interface PendingStringJson {
  id: number;
  raw_string: string;
  first_seen_at: string;
}

/** A timestamp precise to SECONDS — the schema CHECK rejects milliseconds. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Normalizes an account string for matching: strips leading and trailing
 * whitespace, collapses internal whitespace, lower-cases. Empty/non-string → null
 * (such an "account" is of no interest to the resolver — it goes neither into an alias nor into pending).
 */
export function normalizeAlias(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const collapsed = input.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) return null;
  return collapsed.toLowerCase();
}

function isFkViolation(e: unknown): boolean {
  return e instanceof Error && /FOREIGN KEY/i.test(e.message);
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/**
 * Resolves an account string from a receipt into account_id.
 *
 * Order: first an exact match on the normalized alias, then an exact match on
 * the normalized account NAME (a cheap fallback: a real card
 * `200-0750000027949-16` is sometimes entered as the account name too). If
 * neither matches, the string is placed into pending_account_strings
 * (INSERT OR IGNORE, idempotent), and the function returns null. It never
 * throws on an unknown account.
 */
/** Lookup only — never writes pending rows. */
export async function resolveAccount(db: D1Database, raw: unknown): Promise<number | null> {
  const norm = normalizeAlias(raw);
  if (!norm) return null;

  const byAlias = await db
    .prepare('SELECT account_id FROM account_aliases WHERE alias_norm = ? LIMIT 1')
    .bind(norm)
    .first<{ account_id: number }>();
  if (byAlias) return byAlias.account_id;

  const byName = await db
    .prepare('SELECT id FROM accounts WHERE lower(trim(name)) = ? LIMIT 1')
    .bind(norm)
    .first<{ id: number }>();
  if (byName) return byName.id;

  return null;
}

export async function resolveOrPend(db: D1Database, raw: unknown): Promise<number | null> {
  const resolved = await resolveAccount(db, raw);
  if (resolved !== null) return resolved;

  const norm = normalizeAlias(raw);
  if (!norm) return null;

  // It does not resolve — mark it for confirmation by the owner (Scheduled Job #341).
  // INSERT OR IGNORE: a repeated first-seen of the same account does not spawn duplicates.
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length > 0) {
    await db
      .prepare(
        'INSERT OR IGNORE INTO pending_account_strings (raw_string, raw_norm, first_seen_at) VALUES (?, ?, ?)',
      )
      .bind(text, norm, nowIso())
      .run();
  }
  return null;
}

/** All aliases of an account, sorted stably (by id). */
export async function listAliases(db: D1Database, accountId: number): Promise<AliasJson[]> {
  const { results } = await db
    .prepare(
      'SELECT id, account_id, alias_text, created_at FROM account_aliases WHERE account_id = ? ORDER BY id',
    )
    .bind(accountId)
    .all<AliasRow>();
  return results.map(toAliasJson);
}

/** Adds an alias to an account. Throws AliasError on empty text, a missing
 *  account (404), or an alias already taken (409, including one bound to another account). */
export async function addAlias(
  db: D1Database,
  accountId: number,
  aliasText: unknown,
): Promise<AliasJson> {
  const text = typeof aliasText === 'string' ? aliasText.trim() : '';
  if (text.length === 0) {
    throw new AliasError(400, 'ALIAS_TEXT_REQUIRED');
  }
  const norm = normalizeAlias(aliasText);
  if (!norm) {
    throw new AliasError(400, 'ALIAS_TEXT_REQUIRED');
  }

  try {
    const row = await db
      .prepare(
        'INSERT INTO account_aliases (account_id, alias_text, alias_norm, created_at) VALUES (?, ?, ?, ?) RETURNING *',
      )
      .bind(accountId, text, norm, nowIso())
      .first<AliasRow>();
    return toAliasJson(row!);
  } catch (e) {
    // The account does not exist — an FK without ON DELETE rejects it in exactly this way.
    if (isFkViolation(e)) throw new AliasError(404, 'ACCOUNT_NOT_FOUND');
    // alias_norm already exists — bound to this account or to another.
    if (isUniqueViolation(e)) {
      throw new AliasError(409, 'ALIAS_ALREADY_BOUND');
    }
    throw e;
  }
}

/** Removes an alias from an account. 404 if the alias does not belong to this account (or does not exist). */
export async function removeAlias(db: D1Database, accountId: number, aliasId: number): Promise<void> {
  const res = await db
    .prepare('DELETE FROM account_aliases WHERE id = ? AND account_id = ?')
    .bind(aliasId, accountId)
    .run();
  // D1 run() returns meta.changes; wrangler's typings call this
  // `meta`, but in miniflare/prod it is there. Read it safely through any.
  const changes = (res as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes === 0) {
    throw new AliasError(404, 'ALIAS_NOT_FOUND');
  }
}

/** List of all unbound accounts from receipts (for Scheduled Job #341). */
export async function listPending(db: D1Database): Promise<PendingStringJson[]> {
  const { results } = await db
    .prepare(
      'SELECT id, raw_string, first_seen_at FROM pending_account_strings ORDER BY first_seen_at, id',
    )
    .all<PendingStringRow>();
  return results.map((r: PendingStringRow) => ({ id: r.id, raw_string: r.raw_string, first_seen_at: r.first_seen_at }));
}

/**
 * Binds an unknown account to a real one: creates an alias from the original
 * string and deletes it from pending. Atomic via batch — if the alias is
 * already taken (a unique violation), the batch rolls back and the row stays
 * in pending. 404 if the row was already processed; 409 if the alias is
 * already bound to another account; 404 for a missing destination account.
 */
export async function bindPending(
  db: D1Database,
  pendingId: number,
  accountId: number,
): Promise<AliasJson> {
  const pend = await db
    .prepare('SELECT raw_string, raw_norm FROM pending_account_strings WHERE id = ?')
    .bind(pendingId)
    .first<PendingStringRow>();
  if (!pend) {
    throw new AliasError(404, 'PENDING_ACCOUNT_RESOLVED');
  }
  const text = pend.raw_string.trim();
  const norm = pend.raw_norm;

  try {
    await db.batch([
      db.prepare(
        'INSERT INTO account_aliases (account_id, alias_text, alias_norm, created_at) VALUES (?, ?, ?, ?)',
      ).bind(accountId, text, norm, nowIso()),
      db.prepare('DELETE FROM pending_account_strings WHERE id = ?').bind(pendingId),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AliasError(409, 'ALIAS_ALREADY_BOUND');
    }
    if (isFkViolation(e)) throw new AliasError(404, 'ACCOUNT_NOT_FOUND');
    throw e;
  }

  return {
    id: 0,
    account_id: accountId,
    alias_text: text,
    created_at: nowIso(),
  };
}

function toAliasJson(row: AliasRow): AliasJson {
  return {
    id: row.id,
    account_id: row.account_id,
    alias_text: row.alias_text,
    created_at: row.created_at,
  };
}
