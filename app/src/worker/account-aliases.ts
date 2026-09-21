// Алиасы счетов (issue #339) — резолвер виртуальных карт к реальному счёту и
// работа со списком «неизвестных» счетов из чеков.
//
// Две ответственности, одна таблица на каждую:
//   * account_aliases — строка из чека → account_id (обратного хода нет);
//   * pending_account_strings — счёт из чека, который ещё не привязан.
//
// Резолвер (`resolveOrPend`) — единственная точка, через которую импорт
// истории (#340) и автоматизация (#341) превращают «счёт списания» из чека в
// счёт v2. По контракту он НИКОГДА не бросает на неизвестном счёте: либо
// возвращает account_id, либо кладёт строку в pending и возвращает null
// (Закон 1 — тихий провал импорта хуже явной пометки «требует подтверждения»).
//
// Нормализация. `alias_text` хранит оригинал (включая регистр: в листе
// `Visa *6125`, а не `visa`), а `alias_norm` — форму для совпадения:
// trim, схлопывание внутренних пробелов, lower-case. Так `Visa *6125` и
// `visa *6125` указывают на один счёт, а UNIQUE на `alias_norm` не даёт
// завести тот же алиас дважды под разным регистром. Тот же алгоритм
// (normalizeAlias) применяется к pending-строкам, поэтому один и тот же
// неизвестный счёт попадает в список ровно один раз, какую бы галлюцинацию
// регистра/пробелов ни выдал экстрактор чека.
import type { D1Database } from '@cloudflare/workers-types';
import { AppError, type ApiErrorCode, type ApiErrorParams } from '../shared/api-errors';

/** Ошибка слоя алиасов с готовым HTTP-статусом — API-слой только пробрасывает. */
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

/** Момент с точностью до СЕКУНД — CHECK-ограничение схемы отклоняет миллисекунды. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Нормализует строку счёта для поиска совпадения: убирает краевые пробелы,
 * схлопывает внутренние, приводит к нижнему регистру. Пустая/не-строка → null
 * (такой «счёт» резолвер не интересен — ни в алиас, ни в pending он не идёт).
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
 * Резолвит строку счёта из чека в account_id.
 *
 * Порядок: сначала точное совпадение по нормализованному алиасу, затем —
 * точное совпадение по нормализованному ИМЕНИ счёта (дешёвый fallback:
 * реальная карта `200-0750000027949-16` иногда вводится и как имя счёта).
 * Ни то, ни другое не подошло — строка ложится в pending_account_strings
 * (INSERT OR IGNORE, идемпотентно), и функция возвращает null. Никогда не
 * бросает на неизвестном счёте.
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

  // Не резолвится — помечаем для подтверждения владельцем (Scheduled Job #341).
  // INSERT OR IGNORE: повторный first-seen того же счёта не плодит дубли.
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

/** Все алиасы счёта, отсортированные стабильно (по id). */
export async function listAliases(db: D1Database, accountId: number): Promise<AliasJson[]> {
  const { results } = await db
    .prepare(
      'SELECT id, account_id, alias_text, created_at FROM account_aliases WHERE account_id = ? ORDER BY id',
    )
    .bind(accountId)
    .all<AliasRow>();
  return results.map(toAliasJson);
}

/** Добавляет алиас к счёту. Бросает AliasError на пустом тексте, несуществующем
 *  счёте (404) или уже занятом алиасе (409, в т.ч. привязанном к другому счёту). */
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
    // Счёт не существует — FK без ON DELETE здесь именно так и отклоняет.
    if (isFkViolation(e)) throw new AliasError(404, 'ACCOUNT_NOT_FOUND');
    // alias_norm уже есть — привязан к этому или другому счёту.
    if (isUniqueViolation(e)) {
      throw new AliasError(409, 'ALIAS_ALREADY_BOUND');
    }
    throw e;
  }
}

/** Удаляет алиас у счёта. 404, если алиас не принадлежит этому счёту (или нет). */
export async function removeAlias(db: D1Database, accountId: number, aliasId: number): Promise<void> {
  const res = await db
    .prepare('DELETE FROM account_aliases WHERE id = ? AND account_id = ?')
    .bind(aliasId, accountId)
    .run();
  // D1 run() возвращает meta.changes; типизация wrangler'а зовёт это
  // `meta`, но в miniflare/prod оно есть. Безопасно читаем через any.
  const changes = (res as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes === 0) {
    throw new AliasError(404, 'ALIAS_NOT_FOUND');
  }
}

/** Список всех непривязанных счетов из чеков (для Scheduled Job #341). */
export async function listPending(db: D1Database): Promise<PendingStringJson[]> {
  const { results } = await db
    .prepare(
      'SELECT id, raw_string, first_seen_at FROM pending_account_strings ORDER BY first_seen_at, id',
    )
    .all<PendingStringRow>();
  return results.map((r: PendingStringRow) => ({ id: r.id, raw_string: r.raw_string, first_seen_at: r.first_seen_at }));
}

/**
 * Привязывает неизвестный счёт к реальному: создаёт алиас из оригинала строки
 * и удаляет её из pending. Атомарно через batch — если алиас уже занят
 * (уникальное нарушение), batch откатывается и строка остаётся в pending.
 * 404, если строка уже обработана; 409, если алиас уже привязан к другому
 * счёту; 404 на несуществующий счёт назначения.
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
