import { DurableObject } from 'cloudflare:workers';
import migration0001 from '../../migrations/0001_initial_schema.sql';
import migration0021 from '../../migrations/0021_statement_import.sql';
import migration0022 from '../../migrations/0022_import_batch_files.sql';
import migration0023 from '../../migrations/0023_statement_templates.sql';
import migration0024 from '../../migrations/0024_statement_template_mcp.sql';
import migration0025 from '../../migrations/0025_purchase_orders.sql';
import migration0026 from '../../migrations/0026_receipt_groups.sql';
import migration0027 from '../../migrations/0027_receipt_group_rename.sql';
import seedSql from '../../scripts/seed-demo.sql';
import { DEMO_SESSION_TTL_SECONDS } from './demo-flag';
import { splitSqlStatements } from './sql-split';
import type { Env } from './types';

/**
 * Public baseline is 0001 (end state of the earlier chain). Later files are
 * additive. Apply every shipped file in order; the seed expects `operations`.
 */
const MIGRATION_SQL = [
  migration0001,
  migration0021,
  migration0022,
  migration0023,
  migration0024,
  migration0025,
  migration0026,
  migration0027,
];

type SqlValue = ArrayBuffer | string | number | null;

export type DemoStatement = {
  sql: string;
  params: SqlValue[];
};

function normalizeCell(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return BigInt(asNumber) === value ? asNumber : value.toString();
  }
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[key] = normalizeCell(row[key]);
  return out;
}

function isWriteStatement(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .toLowerCase();
  if (stripped.startsWith('with')) {
    return /\b(insert|update|delete|replace)\b/.test(stripped);
  }
  return /^(insert|update|delete|replace)\b/.test(stripped);
}

function skipBootstrapStatement(statement: string): boolean {
  return /^pragma\s+foreign_keys\b/i.test(statement);
}

function applyScript(sql: SqlStorage, script: string): void {
  for (const statement of splitSqlStatements(script)) {
    if (skipBootstrapStatement(statement)) continue;
    try {
      sql.exec(statement).toArray();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`demo schema failed: ${detail} :: ${statement.slice(0, 180)}`);
    }
  }
}

function tableExists(sql: SqlStorage, name: string): boolean {
  const rows = sql.exec(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    name,
  ).toArray();
  return rows.length > 0;
}

function columnNames(sql: SqlStorage, table: string): Set<string> {
  if (!tableExists(sql, table)) return new Set();
  const rows = sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name ?? '')));
}

/**
 * Sessions created before statement import keep their seed forever.
 * Replay 0021 and 0022 as missing objects only: CREATE IF NOT EXISTS, and
 * skip an ALTER when the column is already there.
 */
function applyMissingSchema(sql: SqlStorage, script: string): void {
  for (const statement of splitSqlStatements(script)) {
    if (skipBootstrapStatement(statement)) continue;
    const alter = /^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(statement);
    if (alter) {
      const table = alter[1]!;
      const column = alter[2]!;
      if (columnNames(sql, table).has(column)) continue;
    }
    const tolerant = statement
      .replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/^CREATE UNIQUE INDEX\s+/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
      .replace(/^CREATE INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS ');
    try {
      sql.exec(tolerant).toArray();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (/duplicate column name|already exists/i.test(detail)) continue;
      throw new Error(`demo schema failed: ${detail} :: ${statement.slice(0, 180)}`);
    }
  }
}

function upgradeStatementImport(sql: SqlStorage): void {
  applyMissingSchema(sql, migration0021);
  applyMissingSchema(sql, migration0022);
  applyMissingSchema(sql, migration0023);
  applyMissingSchema(sql, migration0024);
  applyMissingSchema(sql, migration0025);
  applyMissingSchema(sql, migration0026);
  if (!tableExists(sql, 'receipt_group_requests')) return;
  const rows = sql.exec(
    "SELECT sql AS ddl FROM sqlite_master WHERE type = 'table' AND name = 'receipt_group_requests'",
  ).toArray() as Array<{ ddl?: string }>;
  const ddl = String(rows[0]?.ddl ?? '');
  // 0027 rebuilds the table so `rename` is allowed. Replaying it would drop
  // the rows, so run it only while the stored CHECK still omits that value.
  if (!ddl.includes("'rename'")) applyScript(sql, migration0027);
}

function runStatement(sql: SqlStorage, statement: string, params: SqlValue[]): D1Result {
  const parts = splitSqlStatements(statement);
  if (parts.length !== 1) {
    throw new Error('demo ledger expects a single SQL statement');
  }
  const started = performance.now();
  const cursor = sql.exec(parts[0]!, ...params);
  const results = cursor.toArray().map((row) => normalizeRow(row as Record<string, unknown>));
  const write = isWriteStatement(parts[0]!);
  let changes = 0;
  let lastRowId = 0;
  if (write) {
    const metaRow = sql.exec(
      'SELECT changes() AS changes, last_insert_rowid() AS last_row_id',
    ).one() as { changes?: unknown; last_row_id?: unknown };
    changes = Number(metaRow.changes ?? 0);
    lastRowId = Number(metaRow.last_row_id ?? 0);
  }
  const meta: D1Meta = {
    duration: performance.now() - started,
    size_after: sql.databaseSize,
    rows_read: Number(cursor.rowsRead ?? 0),
    rows_written: Number(cursor.rowsWritten ?? 0),
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
  return { results, success: true, meta } as D1Result;
}

/**
 * One SQLite ledger per browser session. Shared D1 is never used here.
 * The first touch applies every migration in order, then the stranger-safe demo seed.
 */
export class DemoSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.#ensureSchema();
      await this.#scheduleEviction();
    });
  }

  async ensureReady(): Promise<void> {
    this.#ensureSchema();
    await this.#scheduleEviction();
  }

  async ledgerQuery(sqlText: string, params: SqlValue[]): Promise<D1Result> {
    this.#ensureSchema();
    await this.#scheduleEviction();
    return runStatement(this.ctx.storage.sql, sqlText, params);
  }

  async ledgerBatch(statements: DemoStatement[]): Promise<D1Result[]> {
    this.#ensureSchema();
    await this.#scheduleEviction();
    const sql = this.ctx.storage.sql;
    // One transaction. A failed statement must not leave import_batches
    // committed with no operations (Durable Object SQL has no implicit batch).
    try {
      return this.ctx.storage.transactionSync(() =>
        statements.map((statement) => runStatement(sql, statement.sql, statement.params)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  }

  async ledgerExec(script: string): Promise<{ count: number; duration: number }> {
    this.#ensureSchema();
    await this.#scheduleEviction();
    const started = performance.now();
    const statements = splitSqlStatements(script).filter((statement) => !skipBootstrapStatement(statement));
    for (const statement of statements) {
      this.ctx.storage.sql.exec(statement).toArray();
    }
    return { count: statements.length, duration: performance.now() - started };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  #ensureSchema(): void {
    const sql = this.ctx.storage.sql;
    const settings = sql.exec(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
    ).toArray();
    if (settings.length === 0) {
      for (const migrationSql of MIGRATION_SQL) applyScript(sql, migrationSql);
      applyScript(sql, seedSql);
      return;
    }
    const seeded = sql.exec(
      "SELECT 1 AS ok FROM settings WHERE key = 'setup_demo_seed' LIMIT 1",
    ).toArray();
    if (seeded.length === 0) applyScript(sql, seedSql);
    upgradeStatementImport(sql);
  }

  async #scheduleEviction(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + DEMO_SESSION_TTL_SECONDS * 1000);
  }
}
