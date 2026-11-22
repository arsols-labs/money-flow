import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PRIVATE_FORBIDDEN_CONTENT_PATTERNS } from './constants.mjs';
import {
  STARTER_CURRENCY_NOTICE,
  STARTER_CURRENCY_RELATIVE_PATH,
  loadStarterCurrencySql,
  starterCurrencyFilePath,
} from './starter-currency.mjs';

const repoApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function applyMigrations(dbPath) {
  const migrationsDir = path.join(repoApp, 'migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of migrations) {
    execFileSync('sqlite3', [dbPath, `.read ${path.join(migrationsDir, name)}`]);
  }
  execFileSync('sqlite3', [dbPath, 'PRAGMA foreign_keys = ON;']);
}

function applyStarterCurrency(dbPath) {
  execFileSync('sqlite3', [dbPath, `.read ${starterCurrencyFilePath(repoApp)}`]);
}

function query(dbPath, sql) {
  return execFileSync('sqlite3', ['-readonly', dbPath, sql], { encoding: 'utf8' }).trim();
}

describe('starter currency SQL', () => {
  const sql = loadStarterCurrencySql(path.join(repoApp, STARTER_CURRENCY_RELATIVE_PATH));
  const executableSql = sql.replace(/^--.*$/gm, '');

  it('writes only USD and excludes other currencies, business rules, and private patterns', () => {
    assert.doesNotMatch(executableSql, /\bUNION\s+ALL\b/i);
    assert.match(executableSql, /'currency_standards'/);
    assert.match(executableSql, /"code":"USD"/);
    assert.match(executableSql, /"minor_digits":2/);
    assert.match(executableSql, /"is_fx_anchor":true/);

    for (const forbidden of [
      /\bEUR\b/,
      /\bGBP\b/,
      /\bCAD\b/,
      /\bRSD\b/,
      /fiscal_formats/,
      /merchant_aliases/,
      /delivery_services/,
      /venue_suffixes/,
      /order_hints/,
      /category_rules/,
      /statement_templates/,
      /pdf_layouts/,
      /\baccounts\b/,
      /\boperations\b/,
      /\bfx_rates\b/,
      /\bsettings\b/,
    ]) {
      assert.doesNotMatch(executableSql, forbidden, `unexpected pattern in starter SQL: ${forbidden}`);
    }

    for (const pattern of PRIVATE_FORBIDDEN_CONTENT_PATTERNS) {
      assert.doesNotMatch(sql, pattern);
    }
  });

  it('describes changing the starter and adding currencies in Settings', () => {
    assert.match(STARTER_CURRENCY_NOTICE, /USD/);
    assert.match(STARTER_CURRENCY_NOTICE, /Settings/);
    assert.match(STARTER_CURRENCY_NOTICE, /other currencies/i);
  });
});

describe('starter currency against migrated SQLite', () => {
  it('writes only USD (minor_digits 2, is_fx_anchor true) on empty currency_standards and is idempotent', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mf-starter-currency-'));
    const dbPath = path.join(tmp, 'starter.sqlite');
    try {
      applyMigrations(dbPath);
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_sets;'), '0');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_entries;'), '0');
      const settingsBefore = query(dbPath, 'SELECT COUNT(*) FROM settings;');

      applyStarterCurrency(dbPath);

      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_sets;'), '1');
      assert.equal(query(dbPath, "SELECT COUNT(*) FROM rule_sets WHERE domain = 'currency_standards';"), '1');
      assert.equal(query(dbPath, "SELECT state FROM rule_sets WHERE domain = 'currency_standards';"), 'active');
      assert.equal(query(dbPath, "SELECT scope_country FROM rule_sets WHERE domain = 'currency_standards';"), 'SHARED');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_entries;'), '1');
      assert.equal(query(dbPath, 'SELECT entry_key FROM rule_entries;'), 'USD');

      const payload = JSON.parse(query(dbPath, 'SELECT payload_json FROM rule_entries;'));
      assert.equal(payload.code, 'USD');
      assert.equal(payload.minor_digits, 2);
      assert.equal(payload.is_fx_anchor, true);

      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM accounts;'), '0');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM operations;'), '0');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM fx_rates;'), '0');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM settings;'), settingsBefore);

      // Re-run is a no-op.
      applyStarterCurrency(dbPath);
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_sets;'), '1');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_entries;'), '1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not insert USD when currency_standards already has another configured currency', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mf-starter-currency-nonempty-'));
    const dbPath = path.join(tmp, 'nonempty.sqlite');
    try {
      applyMigrations(dbPath);
      execFileSync('sqlite3', [
        dbPath,
        `
        INSERT INTO rule_sets (
          domain, scope_country, scope_locale, set_key, version, state,
          priority, allow_shared_fallback, label, provenance_source, revision,
          activated_at, created_at, updated_at
        ) VALUES (
          'currency_standards', 'SHARED', '', 'custom-currencies', 1, 'active',
          100, 1, 'Custom currencies', 'ui', 1,
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        );
        INSERT INTO rule_entries (
          rule_set_id, entry_key, match_type, match_field, pattern,
          priority, enabled, payload_json, revision, created_at, updated_at
        ) VALUES (
          1, 'EUR', 'exact', 'code', 'EUR',
          10, 1, '{"code":"EUR","minor_digits":2,"symbol":"€","is_fx_anchor":true}',
          1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        );
        `,
      ]);

      applyStarterCurrency(dbPath);
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_sets;'), '1');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_entries;'), '1');
      assert.equal(query(dbPath, 'SELECT entry_key FROM rule_entries;'), 'EUR');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not re-insert USD if the user replaced USD with EUR inside the starter set', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mf-starter-currency-replaced-'));
    const dbPath = path.join(tmp, 'replaced.sqlite');
    try {
      applyMigrations(dbPath);
      applyStarterCurrency(dbPath);
      execFileSync('sqlite3', [
        dbPath,
        `
        DELETE FROM rule_entries WHERE entry_key = 'USD';
        INSERT INTO rule_entries (
          rule_set_id, entry_key, match_type, match_field, pattern,
          priority, enabled, payload_json, revision, created_at, updated_at
        ) SELECT
          id, 'EUR', 'exact', 'code', 'EUR',
          10, 1, '{"code":"EUR","minor_digits":2,"symbol":"€","is_fx_anchor":true}',
          1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        FROM rule_sets WHERE set_key = 'starter-currency';
        `,
      ]);

      applyStarterCurrency(dbPath);
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_sets;'), '1');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM rule_entries;'), '1');
      assert.equal(query(dbPath, 'SELECT entry_key FROM rule_entries;'), 'EUR');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
