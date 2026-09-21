import { DurableObject } from 'cloudflare:workers';
import migrationSql from '../../migrations/0001_initial_schema.sql';
import seedSql from '../../scripts/seed-demo.sql';
import { DEMO_SESSION_TTL_SECONDS } from './demo-flag';
import { splitSqlStatements } from './sql-split';
import type { Env } from './types';

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
 * The first touch applies the public schema and stranger-safe demo seed.
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
    return statements.map((statement) =>
      runStatement(this.ctx.storage.sql, statement.sql, statement.params),
    );
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
      applyScript(sql, migrationSql);
      applyScript(sql, seedSql);
      return;
    }
    const seeded = sql.exec(
      "SELECT 1 AS ok FROM settings WHERE key = 'setup_demo_seed' LIMIT 1",
    ).toArray();
    if (seeded.length === 0) applyScript(sql, seedSql);
  }

  async #scheduleEviction(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + DEMO_SESSION_TTL_SECONDS * 1000);
  }
}
