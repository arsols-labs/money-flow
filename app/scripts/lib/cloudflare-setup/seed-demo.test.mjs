import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DEMO_SEED_RELATIVE_PATH,
  assertDemoSeedIsStrangerSafe,
  buildDemoSeedSql,
  loadDemoSeedSql,
  parseYesNo,
  resolveSeedDemoChoice,
} from './seed-demo.mjs';
import {
  DEMO_ACCOUNTS,
  DEMO_FX_RATES,
  DEMO_OPERATIONS,
  DEMO_PLANNED,
  DEMO_RECURRING,
  DEMO_TRANSFERS,
  buildDemoSeedStatements,
} from './seed-demo-sql.mjs';

const repoAppV2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('parseYesNo', () => {
  it('accepts yes tokens', () => {
    for (const value of ['y', 'Y', 'yes', 'YES', 'true', '1']) {
      assert.equal(parseYesNo(value), true, value);
    }
  });

  it('accepts no tokens', () => {
    for (const value of ['n', 'no', 'false', '0']) {
      assert.equal(parseYesNo(value), false, value);
    }
  });

  it('uses emptyDefault for blank input and returns null for unknown tokens', () => {
    assert.equal(parseYesNo('', { emptyDefault: false }), false);
    assert.equal(parseYesNo(null, { emptyDefault: false }), false);
    assert.equal(parseYesNo('maybe'), null);
  });
});

describe('resolveSeedDemoChoice', () => {
  it('prefers an explicit flag over the environment', () => {
    assert.equal(resolveSeedDemoChoice({ flag: true, envValue: 'no' }), true);
    assert.equal(resolveSeedDemoChoice({ flag: false, envValue: 'yes' }), false);
  });

  it('reads SETUP_SEED_DEMO when the flag is unset', () => {
    assert.equal(resolveSeedDemoChoice({ envValue: 'yes' }), true);
    assert.equal(resolveSeedDemoChoice({ envValue: '0' }), false);
    assert.equal(resolveSeedDemoChoice({ envValue: '' }), null);
    assert.equal(resolveSeedDemoChoice({}), null);
  });

  it('rejects an invalid environment value', () => {
    assert.throws(() => resolveSeedDemoChoice({ envValue: 'maybe' }), /SETUP_SEED_DEMO/);
  });
});

describe('demo seed SQL', () => {
  const sql = loadDemoSeedSql(path.join(repoAppV2, DEMO_SEED_RELATIVE_PATH));

  it('is generated from the showcase builder and stays in sync', () => {
    assert.equal(sql, buildDemoSeedSql());
  });

  it('is a stranger-safe English product showcase without UNION ALL', () => {
    assertDemoSeedIsStrangerSafe(sql);
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bUNION\s+ALL\b/i);
    assert.match(sql, /setup_demo_seed/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM accounts\)/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM operations\)/);
    assert.match(sql, /INSERT INTO planned_items/i);
    assert.match(sql, /INSERT INTO recurring_items/i);
    assert.match(sql, /fiscal_receipt_id/);
    assert.match(sql, /INSERT INTO transfers/i);
  });

  it('covers multiple countries, currencies, and denser operations', () => {
    const countries = new Set(DEMO_ACCOUNTS.map((account) => account.country));
    const currencies = new Set(DEMO_ACCOUNTS.map((account) => account.currency));
    assert.ok(DEMO_ACCOUNTS.length >= 6, 'expected several accounts');
    assert.ok(countries.size >= 3, 'expected multiple countries');
    assert.ok(currencies.size >= 3, 'expected multiple currencies');
    assert.ok(DEMO_OPERATIONS.length >= 40, 'expected denser operations for analytics');
    assert.ok(DEMO_PLANNED.some((item) => item.done === 1));
    assert.ok(DEMO_PLANNED.some((item) => item.done === 0));
    assert.ok(DEMO_RECURRING.some((item) => item.frequency === 'monthly'));
    assert.ok(DEMO_RECURRING.some((item) => item.frequency === 'weekly'));
    assert.ok(DEMO_RECURRING.some((item) => item.frequency === 'yearly'));
    assert.ok(DEMO_FX_RATES.map((rate) => rate.code).includes('EUR'));
    assert.ok(DEMO_FX_RATES.map((rate) => rate.code).includes('GBP'));
    assert.ok(DEMO_FX_RATES.map((rate) => rate.code).includes('CAD'));
    assert.ok(DEMO_TRANSFERS.length >= 2);
    assert.ok(DEMO_OPERATIONS.some((op) => op.fiscal_receipt_id));
    assert.ok(sql.includes('Everyday Checking'));
    assert.ok(sql.includes('Rhine Checking'));
    assert.ok(sql.includes('Sterling Current'));
    assert.ok(sql.includes('Maple Everyday'));
  });

  it('keeps a single City rent expectation and Pulse warning scenarios', () => {
    const cityRentPlanned = DEMO_PLANNED.filter((item) => item.title === 'City rent');
    const cityRentRecurring = DEMO_RECURRING.filter((item) => item.title === 'City rent');
    assert.equal(cityRentPlanned.length, 0);
    assert.equal(cityRentRecurring.length, 1);
    assert.equal(cityRentRecurring[0].amount_minor, -180000);

    const card = DEMO_ACCOUNTS.find((account) => account.name === 'Everyday Card');
    const travel = DEMO_ACCOUNTS.find((account) => account.name === 'Travel Cash');
    const sterling = DEMO_ACCOUNTS.find((account) => account.name === 'Sterling Current');
    const museum = DEMO_PLANNED.find((item) => item.title === 'City museum tickets');
    const boiler = DEMO_PLANNED.find((item) => item.title === 'Winter boiler service');

    assert.ok(card && card.balance_minor < 0, 'Everyday Card stays already negative');
    assert.ok(museum && museum.account === 'Travel Cash');
    assert.ok(travel && travel.balance_minor + museum.amount_minor < 0, 'Travel Cash reaches zero soon');
    assert.ok(boiler && boiler.account === 'Sterling Current');
    assert.ok(
      sterling && sterling.balance_minor + boiler.amount_minor < 0,
      'Sterling Current goes negative later',
    );
    const plannedStatements = [...sql.matchAll(/INSERT INTO planned_items[\s\S]*?;/g)].map((match) => match[0]);
    const recurringStatements = [...sql.matchAll(/INSERT INTO recurring_items[\s\S]*?;/g)].map((match) => match[0]);
    assert.equal(plannedStatements.filter((statement) => statement.includes("'City rent'")).length, 0);
    assert.equal(recurringStatements.filter((statement) => statement.includes("'City rent'")).length, 1);
    assert.match(sql, /City museum tickets/);
    assert.match(sql, /Winter boiler service/);
  });

  it('uses one INSERT…SELECT per statement', () => {
    const statements = buildDemoSeedStatements();
    assert.ok(statements.length >= 60);
    for (const statement of statements) {
      assert.match(statement.trim(), /^INSERT INTO /i);
      assert.doesNotMatch(statement, /\bUNION\s+ALL\b/i);
    }
  });
});

describe('demo seed against migrated SQLite', () => {
  function applyMigrations(dbPath) {
    const migrationsDir = path.join(repoAppV2, 'migrations');
    const migrations = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of migrations) {
      execFileSync('sqlite3', [dbPath, `.read ${path.join(migrationsDir, name)}`]);
    }
    execFileSync('sqlite3', [dbPath, 'PRAGMA foreign_keys = ON;']);
  }

  function applySeed(dbPath) {
    execFileSync('sqlite3', [dbPath, `.read ${path.join(repoAppV2, DEMO_SEED_RELATIVE_PATH)}`]);
  }

  function query(dbPath, sql) {
    return execFileSync('sqlite3', ['-readonly', dbPath, sql], { encoding: 'utf8' }).trim();
  }

  it('inserts the showcase once and is a no-op on re-run', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mf-seed-demo-'));
    const dbPath = path.join(tmp, 'demo.sqlite');
    try {
      applyMigrations(dbPath);
      applySeed(dbPath);
      const first = {
        accounts: Number(query(dbPath, 'SELECT COUNT(*) FROM accounts;')),
        operations: Number(query(dbPath, 'SELECT COUNT(*) FROM operations;')),
        planned: Number(query(dbPath, 'SELECT COUNT(*) FROM planned_items;')),
        recurring: Number(query(dbPath, 'SELECT COUNT(*) FROM recurring_items;')),
        transfers: Number(query(dbPath, 'SELECT COUNT(*) FROM transfers;')),
        fx: Number(query(dbPath, 'SELECT COUNT(*) FROM fx_rates;')),
        fiscal: Number(query(dbPath, 'SELECT COUNT(*) FROM operations WHERE fiscal_receipt_id IS NOT NULL;')),
        countries: Number(query(dbPath, 'SELECT COUNT(DISTINCT country) FROM accounts;')),
        currencies: Number(query(dbPath, 'SELECT COUNT(DISTINCT currency) FROM accounts;')),
        marker: query(dbPath, "SELECT value FROM settings WHERE key = 'setup_demo_seed';"),
      };

      assert.equal(first.accounts, DEMO_ACCOUNTS.length);
      assert.ok(first.operations >= DEMO_OPERATIONS.length);
      assert.equal(first.planned, DEMO_PLANNED.length);
      assert.equal(first.recurring, DEMO_RECURRING.length);
      assert.equal(first.transfers, DEMO_TRANSFERS.length);
      assert.ok(first.fx >= DEMO_FX_RATES.length);
      assert.ok(first.fiscal >= 3);
      assert.ok(first.countries >= 3);
      assert.ok(first.currencies >= 3);
      assert.equal(first.marker, '1');
      assert.equal(
        query(dbPath, "SELECT COUNT(*) FROM operations WHERE source = 'planned';"),
        '1',
      );
      assert.equal(
        query(dbPath, "SELECT COUNT(*) FROM operations WHERE source = 'recurring';"),
        '1',
      );
      assert.equal(
        query(dbPath, "SELECT COUNT(*) FROM planned_items WHERE title = 'City rent';"),
        '0',
      );
      assert.equal(
        query(dbPath, "SELECT COUNT(*) FROM recurring_items WHERE title = 'City rent';"),
        '1',
      );
      assert.equal(
        query(dbPath, "SELECT COUNT(*) FROM planned_items WHERE title = 'City museum tickets';"),
        '1',
      );
      assert.equal(
        query(dbPath, "SELECT COUNT(*) FROM planned_items WHERE title = 'Winter boiler service';"),
        '1',
      );
      assert.ok(
        Number(query(dbPath, "SELECT balance_minor FROM accounts WHERE name = 'Everyday Card';")) < 0,
      );

      applySeed(dbPath);
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM accounts;'), String(first.accounts));
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM operations;'), String(first.operations));
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM planned_items;'), String(first.planned));
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM recurring_items;'), String(first.recurring));
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM transfers;'), String(first.transfers));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not seed when accounts already exist', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mf-seed-demo-occupied-'));
    const dbPath = path.join(tmp, 'demo.sqlite');
    try {
      applyMigrations(dbPath);
      execFileSync(
        'sqlite3',
        [
          dbPath,
          `INSERT INTO accounts (name, bank, type, owner, country, currency, balance_minor, balance_updated_at, sort)
           VALUES ('Existing Checking', 'Other Bank', 'Checking', 'Household', 'USA', 'USD', 1000, '2026-09-01T12:00:00Z', 0);`,
        ],
      );
      execFileSync('sqlite3', [dbPath, `.read ${path.join(repoAppV2, DEMO_SEED_RELATIVE_PATH)}`]);
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM accounts;'), '1');
      assert.equal(query(dbPath, 'SELECT COUNT(*) FROM operations;'), '0');
      assert.equal(query(dbPath, "SELECT COUNT(*) FROM settings WHERE key = 'setup_demo_seed';"), '0');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('seeded balances cover already-negative, soon, and later warnings', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mf-seed-demo-warnings-'));
    const dbPath = path.join(tmp, 'demo.sqlite');
    try {
      applyMigrations(dbPath);
      applySeed(dbPath);

      const card = Number(query(dbPath, "SELECT balance_minor FROM accounts WHERE name = 'Everyday Card';"));
      const travel = Number(query(dbPath, "SELECT balance_minor FROM accounts WHERE name = 'Travel Cash';"));
      const sterling = Number(query(dbPath, "SELECT balance_minor FROM accounts WHERE name = 'Sterling Current';"));
      const museum = Number(query(
        dbPath,
        "SELECT amount_minor FROM planned_items WHERE title = 'City museum tickets';",
      ));
      const boiler = Number(query(
        dbPath,
        "SELECT amount_minor FROM planned_items WHERE title = 'Winter boiler service';",
      ));
      const museumDate = query(dbPath, "SELECT date FROM planned_items WHERE title = 'City museum tickets';");
      const boilerDate = query(dbPath, "SELECT date FROM planned_items WHERE title = 'Winter boiler service';");
      const today = query(dbPath, "SELECT date('now');");
      const soonLimit = query(dbPath, "SELECT date('now', '+10 days');");
      const laterFloor = query(dbPath, "SELECT date('now', '+30 days');");

      assert.ok(card < 0, 'Everyday Card is already negative');
      assert.ok(travel > 0 && travel + museum < 0, 'Travel Cash reaches zero soon');
      assert.ok(sterling > 0 && sterling + boiler < 0, 'Sterling Current goes negative later');
      assert.ok(museumDate > today && museumDate <= soonLimit);
      assert.ok(boilerDate >= laterFloor);

      const usdEquivalent = Number(query(
        dbPath,
        `SELECT SUM(
           CASE a.currency
             WHEN 'USD' THEN a.balance_minor
             ELSE a.balance_minor * r.rate_e9 / 1000000000
           END
         )
         FROM accounts a
         LEFT JOIN fx_rates r ON r.code = a.currency;`,
      ));
      assert.ok(usdEquivalent > 0, 'household sum stays positive despite the negative card');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
