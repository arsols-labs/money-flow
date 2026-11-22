import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DemoSession } from '../src/worker/demo-session';
import migration0028 from '../migrations/0028_country_versioned_rules.sql';
import { splitSqlStatements } from '../src/worker/sql-split';

const NOW = '2026-11-15T12:00:00Z';
const VERSION_KEY = 'demo_schema_version';
const RULE_TABLES = ['rule_sets', 'rule_entries', 'recurring_policy_bindings', 'rule_config_mutations'];

function session(): DurableObjectStub<DemoSession> {
  return env.DEMO_SESSION.getByName(crypto.randomUUID());
}

async function legacy(stub: DurableObjectStub<DemoSession>): Promise<void> {
  await stub.ensureReady();
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    for (const migration of env.TEST_MIGRATIONS) {
      if (Number(migration.name.slice(0, 4)) > 27) continue;
      for (const query of migration.queries) {
        if (!/^PRAGMA\s+foreign_keys\b/i.test(query.trim())) state.storage.sql.exec(query).toArray();
      }
    }
    state.storage.sql.exec("INSERT INTO settings (key, value) VALUES ('setup_demo_seed', '1')");
    state.storage.sql.exec(
      'INSERT INTO category_rules (pattern, match_field, category, created_at) VALUES (?, ?, ?, ?)',
      'SAMPLE SHOP', 'merchant', 'Groceries', NOW,
    );
    state.storage.sql.exec(
      `INSERT INTO statement_templates (template_id, label, format, document, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'legacy-bank', 'Legacy bank', 'csv', '{"id":"legacy-bank","format":"csv"}', NOW, NOW,
    );
    state.storage.sql.exec(
      `INSERT INTO receipt_group_requests
       (idempotency_key, operation, request_hash, status_code, response_json, created_at)
       VALUES (?, 'rename', ?, 200, '{}', ?)`,
      'legacy-request', 'a'.repeat(64), NOW,
    );
  });
}

async function repeatAccess(stub: DurableObjectStub<DemoSession>): Promise<void> {
  await stub.ensureReady();
  await stub.ledgerQuery('SELECT COUNT(*) AS n FROM rule_sets', []);
  await stub.ledgerBatch([{ sql: "UPDATE settings SET value = value WHERE key = 'setup_demo_seed'", params: [] }]);
  await evictDurableObject(stub);
  await stub.ensureReady();
  await stub.ledgerQuery('SELECT COUNT(*) AS n FROM rule_entries', []);
}

describe('demo schema upgrades', { timeout: 30_000 }, () => {
  it('backfills legacy rules/templates once and preserves requests across access and eviction', async () => {
    const stub = session();
    await legacy(stub);
    await repeatAccess(stub);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.kv.get(VERSION_KEY)).toBe(29);
      const sets = state.storage.sql.exec<{ set_key: string }>('SELECT set_key FROM rule_sets ORDER BY set_key').toArray();
      expect(sets.map((row) => row.set_key)).toEqual(['migrated-category-rules', 'migrated-user-templates']);
      const entries = state.storage.sql.exec<{ entry_key: string }>('SELECT entry_key FROM rule_entries ORDER BY entry_key').toArray();
      expect(entries.map((row) => row.entry_key)).toEqual(['legacy-1', 'legacy-bank']);
      expect(state.storage.sql.exec('SELECT * FROM category_rules').toArray()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT * FROM statement_templates').toArray()).toHaveLength(1);
      expect(state.storage.sql.exec<{ operation: string }>('SELECT operation FROM receipt_group_requests').one().operation).toBe('rename');
      const recurringCols = state.storage.sql.exec<{ name: string; dflt_value: string | null }>(
        "PRAGMA table_info(recurring_items)",
      ).toArray();
      const autoSkipCol = recurringCols.find((col) => col.name === 'auto_skip_overdue');
      const afterDaysCol = recurringCols.find((col) => col.name === 'auto_skip_after_days');
      expect(autoSkipCol?.dflt_value).toBe('0');
      expect(afterDaysCol?.dflt_value).toBe('1');
    });
    // User edits after migration must not be replaced on another schema check.
    await stub.ledgerQuery("UPDATE rule_entries SET payload_json = '{\"category\":\"Edited\"}' WHERE entry_key = 'legacy-1'", []);
    await repeatAccess(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const edited = state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM rule_entries WHERE entry_key = 'legacy-1'",
      ).one();
      expect(edited.payload_json).toBe('{"category":"Edited"}');
    });
  });

  it('adopts complete pre-marker schemas without resurrecting deleted entries or renamed sets', async () => {
    const stub = session();
    await legacy(stub);
    await runInDurableObject(stub, (_instance, state) => {
      for (const statement of splitSqlStatements(migration0028)) state.storage.sql.exec(statement).toArray();
      state.storage.sql.exec("UPDATE rule_sets SET set_key = 'user-renamed' WHERE domain = 'category_rules'");
      state.storage.sql.exec('DELETE FROM rule_entries');
      state.storage.sql.exec("DELETE FROM rule_sets WHERE domain = 'statement_templates'");
    });
    await repeatAccess(stub);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ set_key: string }>('SELECT set_key FROM rule_sets').one().set_key).toBe('user-renamed');
      expect(state.storage.sql.exec('SELECT * FROM rule_entries').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM category_rules').toArray()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT * FROM statement_templates').toArray()).toHaveLength(1);
    });
  });

  it('rolls back failed schema/backfill work and retries without a completion marker', async () => {
    const stub = session();
    await legacy(stub);
    await runInDurableObject(stub, (_instance, state) => {
      // Emulate a pre-fix partial DDL, then reject the second backfill.
      for (const statement of splitSqlStatements(migration0028)) {
        if (/^CREATE TABLE (rule_sets|rule_entries)\s*\(/i.test(statement)) state.storage.sql.exec(statement).toArray();
      }
      state.storage.sql.exec(`CREATE TRIGGER reject_category_backfill BEFORE INSERT ON rule_entries
        WHEN NEW.entry_key = 'legacy-1' BEGIN SELECT RAISE(ABORT, 'test backfill failure'); END`);
    });
    const failure = await stub.ensureReady().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/test backfill failure/);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.kv.get(VERSION_KEY)).toBeUndefined();
      expect(state.storage.sql.exec('SELECT * FROM rule_sets').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM rule_entries').toArray()).toEqual([]);
      const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
      expect(tables.map((row) => row.name)).not.toContain('rule_config_mutations');
      expect(tables.map((row) => row.name)).not.toContain('recurring_policy_bindings');
      state.storage.sql.exec('DROP TRIGGER reject_category_backfill');
    });
    await repeatAccess(stub);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.kv.get(VERSION_KEY)).toBe(29);
      expect(state.storage.sql.exec('SELECT * FROM rule_entries').toArray()).toHaveLength(2);
    });
  });

  it('keeps its completion record outside replaced settings and leaves an empty rules schema empty', async () => {
    const stub = session();
    await legacy(stub);
    await runInDurableObject(stub, (_instance, state) => {
      for (const statement of splitSqlStatements(migration0028)) {
        if (/^CREATE /i.test(statement)) state.storage.sql.exec(statement).toArray();
      }
    });
    await repeatAccess(stub);
    await stub.ledgerQuery('DELETE FROM settings', []);
    await repeatAccess(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.kv.get(VERSION_KEY)).toBe(29);
      expect(state.storage.sql.exec('SELECT * FROM settings').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM rule_entries').toArray()).toEqual([]);
      for (const table of RULE_TABLES) {
        expect(state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()).toHaveLength(1);
      }
      await expect(state.storage.getAlarm()).resolves.not.toBeNull();
    });
  });
});
