// Smoke test of the D1 schema (S1-1, issue #195).
//
// What it must catch: the migration applies at all; the inventory of tables and
// indexes matches the spec (an extra or missing table shows up immediately, not in
// S1-3); the basic invariants are alive. Invariant checks are negative —
// "the right row inserted" proves nothing about a CHECK that
// is written wrong and never fires.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const EXPECTED_TABLES = [
  'account_aliases',
  'accounts',
  'fx_rates',
  'imported_receipt_items',
  'mcp_audit_log',
  'oauth_clients',
  'oauth_consents',
  'oauth_tokens',
  'operation_fulfillment_links',
  'operations',
  'pending_account_strings',
  'planned_items',
  'receipts',
  'recurring_items',
  'recurring_period_fulfillments',
  'settings',
  'transfers',
];

const EXPECTED_INDEXES = [
  'idx_account_aliases_account_id',
  'idx_account_aliases_alias_norm',
  'idx_accounts_archived_sort',
  'idx_imported_receipt_items_acct',
  'idx_imported_receipt_items_op',
  'idx_mcp_audit_log_client_id',
  'idx_mcp_audit_log_created_at',
  'idx_mcp_audit_log_idempotency',
  'idx_oauth_consents_client_id',
  'idx_oauth_tokens_client_id',
  'idx_operation_fulfillment_planned_item',
  'idx_operation_fulfillment_recurring_period',
  'idx_operations_account_id',
  'idx_operations_category',
  'idx_operations_date',
  'idx_operations_fiscal_receipt_id',
  'idx_operations_id_recurring_item_id',
  'idx_operations_planned_item_id',
  'idx_operations_receipt_id',
  'idx_operations_recurring_item_id',
  'idx_operations_transfer_id',
  'idx_pending_account_strings_raw_norm',
  'idx_planned_items_account_id',
  'idx_planned_items_date',
  'idx_receipts_created_at',
  'idx_receipts_status',
  'idx_recurring_items_account_id',
  'idx_recurring_items_next_due_date',
];

const NOW = '2026-08-09T12:00:00Z';

// Storage isolation in @cloudflare/vitest-plugin is per test FILE, not per test:
// without explicit cleanup, fixtures from neighbouring tests are visible to each
// other and checks start failing on foreign rows. Deletion order is reverse of
// references. settings is left alone — it holds defaults from the migration itself.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM oauth_tokens'),
    env.DB.prepare('DELETE FROM oauth_consents'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM receipts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM accounts'),
  ]);
});

async function names(sql: string): Promise<string[]> {
  const { results } = await env.DB.prepare(sql).all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Account fixture: almost everything in the schema references accounts. */
async function insertAccount(): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, bank, type, owner, country, currency, balance_minor, balance_updated_at)
     VALUES ('Основной', 'Raiffeisen', 'Checking', 'Alex', 'SRB', 'RSD', 123456, ?)
     RETURNING id`,
  )
    .bind(NOW)
    .first<{ id: number }>();
  return row!.id;
}

/**
 * Asserts that the query is rejected SPECIFICALLY by a schema constraint. A bare
 * `.rejects.toThrow()` is green on a typo in the SQL itself — then the test
 * "checks a CHECK" that in fact never fires.
 */
async function expectRejected(sql: string, ...binds: unknown[]): Promise<void> {
  await expect(env.DB.prepare(sql).bind(...binds).run()).rejects.toThrow(/constraint failed/i);
}

/**
 * Asserts that the query is rejected SPECIFICALLY by `NOT NULL` and SPECIFICALLY
 * the named column. Stricter than `expectRejected`, and the difference is not cosmetic: that
 * one is green on any "constraint failed", and next to `NOT NULL` four of the six
 * accounts columns have their own `CHECK`. A `NOT NULL` test written
 * through the shared matcher would catch the neighboring check and stay green with
 * `NOT NULL` fully removed — that is, it would check something other than what the
 * name claims.
 *
 * The column is named together with the table, exactly as SQLite prints it:
 * `NOT NULL constraint failed: accounts.name`.
 */
async function expectRejectedNotNull(
  qualifiedColumn: string,
  sql: string,
  ...binds: unknown[]
): Promise<void> {
  // The whole name is escaped, not just the dot: the name comes from test
  // code, but partial escaping is exactly the kind of "works on the current
  // data" that later makes you hunt for why the matcher caught the wrong column.
  const escaped = qualifiedColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(env.DB.prepare(sql).bind(...binds).run()).rejects.toThrow(
    new RegExp(`NOT NULL constraint failed: ${escaped}\\b`),
  );
}

describe('schema inventory', () => {
  it('contains exactly the expected schema tables', async () => {
    // sqlite_* and _cf_* are internal (D1 itself creates the latter),
    // d1_migrations is the journal of applied migrations from wrangler.
    const tables = await names(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND name <> 'd1_migrations'
       ORDER BY name`,
    );
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it('contains the expected indexes', async () => {
    const indexes = await names(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`,
    );
    expect(indexes).toEqual(EXPECTED_INDEXES);
  });

  it('creates no triggers — the spec requires their absence', async () => {
    expect(await names(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)).toEqual([]);
  });

  it('passes quick_check and foreign_key_check', async () => {
    // integrity_check is forbidden in D1 (SQLITE_AUTH) — quick_check is available.
    const quick = await env.DB.prepare('PRAGMA quick_check').first<{ quick_check: string }>();
    expect(quick?.quick_check).toBe('ok');

    const { results } = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(results).toEqual([]);
  });

  it('keeps foreign key checks enabled — otherwise half the tests below are fictitious', async () => {
    const row = await env.DB.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it('inserts default settings so an empty database is usable', async () => {
    const { results } = await env.DB.prepare(
      'SELECT key, value FROM settings ORDER BY key',
    ).all<{ key: string; value: string }>();
    expect(results).toEqual([
      { key: 'base_currency', value: 'USD' },
      { key: 'low_balance_threshold_minor', value: '100000' },
    ]);
  });
});

async function insertRecurringFulfillmentFixture(periodDueDate = '2026-09-01') {
  const accountId = await insertAccount();
  const recurring = await env.DB.prepare(
    `INSERT INTO recurring_items
       (title, amount_minor, currency, account_id, category, frequency, interval_count,
        day_of_month, month_of_year, next_due_date, end_date, active)
     VALUES ('Подписка', -1000, 'RSD', ?, 'Software', 'monthly', 1, 1, NULL, ?, NULL, 1)
     RETURNING id`,
  ).bind(accountId, periodDueDate).first<{ id: number }>();
  const operation = await env.DB.prepare(
    `INSERT INTO operations
       (date, account_id, kind, item, category, amount_minor, source, recurring_item_id)
     VALUES (?, ?, 'expense', 'Подписка', 'Software', -1000, 'recurring', ?)
     RETURNING id`,
  ).bind(periodDueDate, accountId, recurring!.id).first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, ?, 'materialized', ?)`,
    ).bind(recurring!.id, periodDueDate, NOW),
    env.DB.prepare(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, ?, ?, 'materialized', ?)`,
    ).bind(operation!.id, recurring!.id, periodDueDate, NOW),
  ]);
  return { accountId, recurringId: recurring!.id, operationId: operation!.id };
}

describe('expectation fulfillments — atomic invariants MF-21', () => {
  it('rejects a second fact for the same recurring period', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-09-01', 'skipped', ?)`,
      fixture.recurringId, NOW,
    );
  });

  it('rejects linking one operation to two periods', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-10-01', 'linked', ?)`,
    ).bind(fixture.recurringId, NOW).run();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, ?, '2026-10-01', 'linked', ?)`,
      fixture.operationId, fixture.recurringId, NOW,
    );
  });

  it('rejects a link without exactly one planned or recurring target', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, NULL, NULL, 'linked', ?)`,
      fixture.operationId, NOW,
    );
  });

  it('rejects an operation link whose outcome differs from the parent fulfillment', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    const operation = await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
       VALUES ('2026-10-01', ?, 'expense', 'Внешний факт', 'Software', -1000, 'agent')
       RETURNING id`,
    ).bind(fixture.accountId).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-10-01', 'skipped', ?)`,
    ).bind(fixture.recurringId, NOW).run();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, ?, '2026-10-01', 'linked', ?)`,
      operation!.id, fixture.recurringId, NOW,
    );
  });

  it('holds foreign keys and forbids deleting an operation out from under a durable link', async () => {
    const byOperation = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (999999, NULL, ?, '2026-09-01', 'linked', ?)`,
      byOperation.recurringId, NOW,
    );
    await expect(env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(byOperation.operationId).run()).rejects.toThrow();
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);

    const byRecurring = await insertRecurringFulfillmentFixture('2026-10-01');
    await env.DB.prepare('DELETE FROM recurring_items WHERE id = ?').bind(byRecurring.recurringId).run();
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(1);
  });

  it('validates evidence_quantity as a durable arithmetic proof', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments
         (recurring_item_id, period_due_date, outcome, evidence_quantity, fulfilled_at)
       VALUES (?, '2026-10-01', 'linked', 0, ?)`,
      fixture.recurringId, NOW,
    );
  });

  it('rejects invalid period_due_date and fulfilled_at', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-02-30', 'skipped', ?)`,
      fixture.recurringId, NOW,
    );
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-10-01', 'skipped', '2026-08-09 12:00:00')`,
      fixture.recurringId,
    );
  });
});

// Account insert with the required minimum of columns. That minimum grew in
// migration 0004: `owner` and `country` became NOT NULL, and an insert without them is now
// rejected BEFORE the DBMS looks at the condition under test. For
// the negative tests below this is critical — `expectRejected` is green on any
// "constraint failed", so a currency-format test that forgot the owner
// would be checking NOT NULL under the wrong name and would stay green with the
// GLOB fully removed.
const ACCOUNT_MINIMAL = `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)`;

describe('accounts', () => {
  it('writes and reads an account without losing values', async () => {
    const id = await insertAccount();
    const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      name: 'Основной',
      bank: 'Raiffeisen',
      type: 'Checking',
      owner: 'Alex',
      country: 'SRB',
      currency: 'RSD',
      balance_minor: 123456,
      balance_updated_at: NOW,
      sort: 0,
      archived: 0,
    });
  });

  it('allows a negative balance — a credit card in the red is normal', async () => {
    await env.DB.prepare(
      `INSERT INTO accounts (name, owner, country, currency, balance_minor, balance_updated_at)
       VALUES ('Visa', 'Alex', 'SRB', 'USD', -50000, ?)`,
    )
      .bind(NOW)
      .run();
    const row = await env.DB.prepare(
      `SELECT balance_minor FROM accounts WHERE name = 'Visa'`,
    ).first<{ balance_minor: number }>();
    expect(row?.balance_minor).toBe(-50000);
  });

  it('rejects a currency that is not ISO-4217', async () => {
    await expectRejected(`${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'rsd', ?)`, NOW);
  });

  it('rejects a timestamp that is not ISO-UTC', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-08-09 12:00:00')`,
    );
  });

  it('rejects a nonexistent date inside a timestamp', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-02-30T00:00:00Z')`,
    );
  });

  it('rejects garbage in place of a timestamp — the round-trip yields NULL, only IS NOT NULL catches it', async () => {
    // The only test that holds the first conjunct of the
    // `balance_updated_at` check. The mechanics are exactly what the header of
    // 0001 warns about: `strftime` on such a string returns NULL, the round-trip becomes
    // NULL, and both remaining halves (`>= '0001-01-01'` and the hour `<= '23'`) are
    // true on it — NULL AND TRUE AND TRUE yields NULL, that is, "not violated".
    // Without an explicit `IS NOT NULL` the row passes; verified by mutation — removing
    // this conjunct made the run green, because a "garbage instead of a
    // timestamp" case did not exist in the accounts block at all (recurring_items has one).
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '9999-99-99T00:00:00Z')`,
    );
  });

  it('rejects year zero — date() lets it through on its own', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '0000-01-01T00:00:00Z')`,
    );
  });

  it('rejects hour 24 — strftime() does not normalize it and the round-trip passes', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-08-09T24:30:15Z')`,
    );
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-08-09T24:00:00Z')`,
    );
  });
});

// Owner and country are required in the schema itself — migration 0004, issue #234.
// Before that the same invariant was held only by the API (#232), and any second write path
// slipped past: a hand edit of the DB, a code rollback, a debug script. The checks
// here go through DIRECT SQL past the worker for exactly that reason — they prove the rejection
// comes from the database, not from validation in api.ts.
describe('accounts — owner and country are required in the schema', () => {
  const cases: Array<[string, string]> = [
    ['owner as NULL', `VALUES ('X', NULL, 'SRB', 'USD', ?)`],
    ['country as NULL', `VALUES ('X', 'Alex', NULL, 'USD', ?)`],
    ['owner as an empty string', `VALUES ('X', '', 'SRB', 'USD', ?)`],
    ['country as an empty string', `VALUES ('X', 'Alex', '', 'USD', ?)`],
    // Whitespace is its own case: NOT NULL does not catch it, only
    // CHECK (length(trim(...)) > 0) does. Without these two tests the check could
    // be lost entirely while CI stayed green.
    ['owner made of only spaces', `VALUES ('X', '   ', 'SRB', 'USD', ?)`],
    ['country made of only spaces', `VALUES ('X', 'Alex', '  ', 'USD', ?)`],
  ];

  it.each(cases)('rejects an account: %s', async (_name, values) => {
    await expectRejected(`${ACCOUNT_MINIMAL} ${values}`, NOW);
  });

  // A column cannot be omitted from INSERT — a separate case from an explicit NULL: that is
  // what a forgotten field in someone else's code looks like, not an attempt to erase a value.
  it('rejects an account whose INSERT omits the owner column entirely', async () => {
    await expectRejected(
      `INSERT INTO accounts (name, country, currency, balance_updated_at) VALUES ('X', 'SRB', 'USD', ?)`,
      NOW,
    );
  });

  // UPDATE is the second path by which an empty dimension could appear
  // after the insert. The CHECK is alive on it too.
  it('does not let owner or country be erased through UPDATE', async () => {
    await insertAccount();
    await expectRejected('UPDATE accounts SET owner = NULL');
    await expectRejected("UPDATE accounts SET country = '  '");
  });
});

// The remaining `NOT NULL` columns of accounts — issue #247.
//
// They had NO behavioral test at all: `owner` and `country` are covered
// only because task #234 wrote tests for them right here, and nobody wrote
// any for the neighbors. A single DDL snapshot below held them, and it catches an edit
// only when the edit landed in the migration and was forgotten in the snapshot: a coordinated removal
// of `NOT NULL` in both places passed a green run — verified by mutations,
// each column separately.
//
// Direct SQL past the worker — for the same reason as the block above: the rejection
// must come from the database, not from validation in api.ts.
//
// What is actually lost for each column once `NOT NULL` is removed — three different
// cases, and they are worth telling apart:
//   * `name`, `currency`, `archived` — the neighboring `CHECK` on NULL yields NULL, that
//     is, "not violated", and NULL passes straight through.
//   * `balance_minor`, `sort` — there is no `CHECK` beside them at all.
//   * `balance_updated_at` — its `CHECK` actually REJECTS NULL: the first
//     conjunct `strftime(...) IS NOT NULL` yields 0, not NULL (the
//     `IS NOT` operator in SQLite never returns NULL). Here `NOT NULL`
//     is redundant in substance — and that is exactly why a test for it is possible only
//     through the strict matcher: the shared one would stay green, catching the CHECK rejection
//     (verified by swapping in the shared matcher — the column's three tests stay
//     green with NOT NULL fully removed). The strict one goes red because
//     after `NOT NULL` is removed the REASON for the rejection changes, not the fact of rejection.
//
//     The price of this trick is worth knowing up front: it relies on SQLite
//     checking NOT NULL BEFORE CHECK. That is observed engine behavior, not
//     a promised contract. It will go red on its own someday, with no schema edits —
//     look here, do not hunt for a break in accounts.
describe('accounts — NOT NULL on the remaining columns', () => {
  /** accounts columns with `NOT NULL`, except `owner` and `country` (the block above). */
  const COLUMNS = [
    'name',
    'currency',
    'balance_updated_at',
    'balance_minor',
    'sort',
    'archived',
  ];

  // Explicit NULL. Neighboring columns' values are known-valid — otherwise the rejection
  // would come from someone else's check, and the test would be checking that under the wrong name.
  const explicitNull: Array<[string, string]> = [
    [
      'name',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)
       VALUES (NULL, 'Alex', 'SRB', 'USD', '${NOW}')`,
    ],
    [
      'currency',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)
       VALUES ('X', 'Alex', 'SRB', NULL, '${NOW}')`,
    ],
    [
      'balance_updated_at',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)
       VALUES ('X', 'Alex', 'SRB', 'USD', NULL)`,
    ],
    [
      'balance_minor',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at, balance_minor)
       VALUES ('X', 'Alex', 'SRB', 'USD', '${NOW}', NULL)`,
    ],
    [
      'sort',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at, sort)
       VALUES ('X', 'Alex', 'SRB', 'USD', '${NOW}', NULL)`,
    ],
    [
      'archived',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at, archived)
       VALUES ('X', 'Alex', 'SRB', 'USD', '${NOW}', NULL)`,
    ],
  ];

  it.each(explicitNull)('rejects an account where %s is set to NULL', async (column, sql) => {
    await expectRejectedNotNull(`accounts.${column}`, sql);
  });

  // A column omitted from INSERT — a separate case from an explicit NULL: that is what
  // a forgotten field in someone else's code looks like, not an attempt to erase a value.
  //
  // There are three cases here, not six, and that is not forgetfulness: `balance_minor`,
  // `sort`, and `archived` have a DEFAULT, and omitting the column there is LEGAL. That it
  // really is legal is asserted by the positive test right under the list,
  // so the difference between "must not omit" and "may omit" is held by
  // tests, not by the reader's memory.
  const omitted: Array<[string, string]> = [
    [
      'name',
      `INSERT INTO accounts (owner, country, currency, balance_updated_at)
       VALUES ('Alex', 'SRB', 'USD', '${NOW}')`,
    ],
    [
      'currency',
      `INSERT INTO accounts (name, owner, country, balance_updated_at)
       VALUES ('X', 'Alex', 'SRB', '${NOW}')`,
    ],
    [
      'balance_updated_at',
      `INSERT INTO accounts (name, owner, country, currency)
       VALUES ('X', 'Alex', 'SRB', 'USD')`,
    ],
  ];

  it.each(omitted)('rejects an account whose INSERT omits the %s column entirely', async (column, sql) => {
    await expectRejectedNotNull(`accounts.${column}`, sql);
  });

  it('fills DEFAULT columns with their defaults when they are absent from INSERT', async () => {
    await env.DB.prepare(`${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', ?)`)
      .bind(NOW)
      .run();
    const row = await env.DB.prepare(
      `SELECT balance_minor, sort, archived FROM accounts WHERE name = 'X'`,
    ).first<{ balance_minor: number; sort: number; archived: number }>();
    expect(row).toEqual({ balance_minor: 0, sort: 0, archived: 0 });
  });

  // UPDATE is the second write path by which NULL could appear after
  // the insert. NOT NULL is alive on it too.
  it.each(COLUMNS)('does not let %s be set to NULL through UPDATE', async (column) => {
    await insertAccount();
    await expectRejectedNotNull(`accounts.${column}`, `UPDATE accounts SET ${column} = NULL`);
  });

  // Completeness of the lists above is held not by eyes but by the table itself: `table_info`
  // says which columns really are `NOT NULL` and which have a `DEFAULT`.
  // The point is exactly why #247 was filed: a list nobody
  // checks stays silent. A future migration that adds another `NOT NULL` — this test
  // goes red and demands a case, instead of leaving the column untested for years.
  it('covers every NOT NULL of the table except owner and country', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(accounts)').all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    // `owner` and `country` are covered by the #234 block above; `id` is a rowid alias, and
    // `notnull` on such a PRIMARY KEY in SQLite is 0, so it does not need
    // to be excluded separately.
    const notNull = results.filter(
      (c) => c.notnull === 1 && c.name !== 'owner' && c.name !== 'country',
    );
    const expected = [...COLUMNS].sort();
    // SETS of covered columns are compared, not list lengths: a second
    // case for the same column (the same NULL with a different set of neighbors) is
    // a legitimate strengthening, and this test must not go red on it. It is about
    // "a column was left without a test", not about "there are exactly this many cases".
    const covered = (cases: Array<[string, string]>): string[] =>
      [...new Set(cases.map(([column]) => column))].sort();

    expect(notNull.map((c) => c.name).sort()).toEqual(expected);
    expect(covered(explicitNull)).toEqual(expected);
    // Omitting a column from INSERT is checked only where it is illegal at all,
    // that is, on columns without a DEFAULT. The list is derived, not rewritten.
    expect(covered(omitted)).toEqual(
      notNull
        .filter((c) => c.dflt_value === null)
        .map((c) => c.name)
        .sort(),
    );
  });
});

// Migration 0004 rebuilds accounts wholesale — SQLite cannot ALTER COLUMN.
// The table definition was rewritten by hand, so the snapshot here is the same device and for
// the same reason as recurring_items below. It holds everything that has
// no behavioral test.
//
// This list has changed, and it must be read as a claim about the file's CURRENT
// state, not as a historical fact. Before issue #247 the snapshot was
// the only protection of ALL `NOT NULL` columns of the table, except `owner` and `country`;
// now each of them is covered by a behavioral test in the "accounts —
// NOT NULL on the remaining columns" block above, and each was verified by mutation. The header
// of migration 0004 describes the state at the time of its merge and is already
// stale here — an applied migration is not edited, and the canon of test
// coverage lives in this file.
//
// What remains behind the snapshot alone and would be lost silently (verified by mutations).
// Of the CHECKS — `CHECK (length(trim(name)) > 0)` and `CHECK (archived IN (0, 1))`:
// both are about the shape of a value, not about its presence, and they were not part
// of the `NOT NULL` task. But the snapshot is not exhausted by checks, and narrowing the list to them
// would lie in exactly the same way the list lied before #247.
// A coordinated edit in the migration and here still passes green for COLUMN
// ORDER and for the DECLARED TYPE of a nullable column: swapping `bank` and
// `type`, like replacing `bank TEXT` with `bank INTEGER`, yields a fully
// green run. The list is therefore open — nothing can close it except the
// snapshot itself, and that is its point.
//
// These go red even without the snapshot: `currency GLOB`, each of the four conjuncts of
// `balance_updated_at`, `PRIMARY KEY`, both `NOT NULL`s from #234, all six
// `NOT NULL`s from #247, and `DEFAULT` on `balance_minor`, `sort`, and `archived`. What
// normalization tolerates and what it does not is in the comment on RECURRING_ITEMS_DDL below;
// no need to repeat it.
//
// Quotes around the table name are a trace of `ALTER TABLE ... RENAME TO`, not part of
// the schema's meaning.
const ACCOUNTS_DDL = `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    bank TEXT,
    type TEXT,
    owner TEXT NOT NULL CHECK (length(trim(owner)) > 0),
    country TEXT NOT NULL CHECK (length(trim(country)) > 0),
    currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
    balance_minor INTEGER NOT NULL DEFAULT 0,
    balance_updated_at TEXT NOT NULL CHECK (
      strftime('%Y-%m-%dT%H:%M:%SZ', balance_updated_at) IS NOT NULL
      AND balance_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', balance_updated_at)
      AND balance_updated_at >= '0001-01-01'
      AND substr(balance_updated_at, 12, 2) <= '23'
    ),
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    account_number TEXT
  )`;

describe('accounts — table rebuild by migration 0004', () => {
  it('preserved the table definition in full: columns, DEFAULT, every CHECK', async () => {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`,
    ).first<{ sql: string }>();
    expect(normalizeDdl(row!.sql)).toBe(normalizeDdl(ACCOUNTS_DDL));
  });

  // Public cut ships one squashed migration (0001). Historical rebuild
  // replay for 0004 is not in this tree; the DDL snapshot above locks the
  // table that 0001 creates directly.

  // A test "a reference to a nonexistent account is rejected" is deliberately ABSENT here,
  // even though the 0003 rebuild block has one. There the table being rebuilt
  // was the one whose definition holds the foreign key itself — there was something to lose.
  // Here the PARENT is rebuilt, and `REFERENCES` is written on the children, and the migration
  // does not touch them at all; if `accounts` had not come back under its own name, that
  // would be caught by `PRAGMA foreign_key_check` in the schema inventory, and the liveness of the
  // key itself is already held by `planned_items > rejects a reference to a nonexistent account`.
  // A copy of that test here would give a second failure for one defect.

  it('recreated the index with the same definition, not only the same name', async () => {
    // The schema inventory above checks names; here — the column set and order.
    const { results } = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'accounts' AND name LIKE 'idx_%'`,
    ).all<{ sql: string }>();
    expect(results.map((i) => i.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE INDEX idx_accounts_archived_sort ON accounts (archived, sort)',
    ]);
  });
});

describe('planned_items', () => {
  it('writes a planned operation with a sign', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?, 'Жильё')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare(
      'SELECT amount_minor, done FROM planned_items',
    ).first<{ amount_minor: number; done: number }>();
    expect(row).toEqual({ amount_minor: -95000, done: 0 });
  });

  it('rejects a zero amount', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Пустая', 0, 'RSD', ?)`,
      accountId,
    );
  });

  it('rejects a date with a nonexistent day', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-02-30', 'Аренда', -1, 'RSD', ?)`,
      accountId,
    );
  });

  it('rejects a reference to a nonexistent account', async () => {
    await expectRejected(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -1, 'RSD', 999999)`,
    );
  });

  it('does not let an account be deleted while planned operations hang on it', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -1, 'RSD', ?)`,
    )
      .bind(accountId)
      .run();
    await expectRejected('DELETE FROM accounts WHERE id = ?', accountId);
  });
});

describe('recurring_items — rule anchors', () => {
  const base = `INSERT INTO recurring_items
    (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date)`;

  it('accepts a monthly rule with a day of month', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, 31, NULL, '2026-08-31')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare(
      'SELECT day_of_month, active FROM recurring_items',
    ).first<{ day_of_month: number; active: number }>();
    expect(row).toEqual({ day_of_month: 31, active: 1 });
  });

  it('requires a day of month for monthly — otherwise the anchor is lost when clamping to the 28th', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, NULL, NULL, '2026-08-31')`,
      accountId,
    );
  });

  it('requires a month and a day for yearly', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, NULL, '2028-02-29')`,
      accountId,
    );
  });

  it('forbids a day of month on daily and weekly — it has no meaning there', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кофе', -300, 'RSD', ?, 'weekly', 1, 5, NULL, '2026-08-10')`,
      accountId,
    );
    await expectRejected(
      `${base} VALUES ('Кофе', -300, 'RSD', ?, 'daily', 1, 5, NULL, '2026-08-10')`,
      accountId,
    );
  });

  it('rejects an unknown frequency', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Странное', -1, 'RSD', ?, 'fortnightly', 1, NULL, NULL, '2026-08-10')`,
      accountId,
    );
  });
});

// An insert with an end date — shared by the two blocks below. Separate from `base` in the
// "rule anchors" block: that one deliberately has no end_date column, so the anchor checks do not
// depend on migration 0002.
const BASE_WITH_END_DATE = `INSERT INTO recurring_items
  (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date)`;

// The rule's end date — migration 0002, issue #211. `end_date` is inclusive:
// that is how the `expandRecurring` consumer reads it (`while (cur <= hardEnd)`).
describe('recurring_items — end date', () => {
  const base = BASE_WITH_END_DATE;

  it('accepts a rule with no end date — the column is nullable', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, 15, NULL, '2026-08-15', NULL)`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT end_date FROM recurring_items').first<{
      end_date: string | null;
    }>();
    expect(row?.end_date).toBeNull();
  });

  it('stores an end date — a loan with a fixed term', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2029-09-05')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT end_date FROM recurring_items').first<{
      end_date: string;
    }>();
    expect(row?.end_date).toBe('2029-09-05');
  });

  it('allows an end date equal to the anchor — a rule with exactly one payment', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Последний взнос', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2026-09-05')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT end_date FROM recurring_items').first<{
      end_date: string;
    }>();
    expect(row?.end_date).toBe('2026-09-05');
  });

  it('rejects an end date before the anchor — a rule with no payments at all', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2026-08-05')`,
      accountId,
    );
  });

  it('rejects a non-canonical date format — the column comparison is textual', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2029-9-5')`,
      accountId,
    );
  });

  it('rejects a nonexistent date — date() NORMALIZES it, the round-trip catches it', async () => {
    // date('2026-02-30') returns not NULL but '2026-03-02'. A check of
    // "date(x) IS NOT NULL" alone would not be enough — it is the equality that works.
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-01-05', '2026-02-30')`,
      accountId,
    );
  });

  it('rejects garbage in place of a date', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', 'никогда')`,
      accountId,
    );
  });

  // A test of the lower bound '0001-01-01' is deliberately ABSENT here. Year zero in
  // end_date requires the same anchor, and that is rejected by the next_due_date check from
  // migration 0001 — that check fires, not the end_date bound. Such a test would stay
  // green even with the bound fully removed, that is, it would cover someone else's CHECK under
  // its own name. Why the bound is still in the migration is in its header.
});

// The `..._after_anchor` contract for S1-3 and S1-4: the CHECK is alive on ANY UPDATE
// of the row. That constrains not only moving the anchor forward, but also shortening
// the term retroactively — the second is unobvious and would have cost an S1-3 debugging session.
describe('recurring_items — end date against the sliding anchor', () => {
  const base = BASE_WITH_END_DATE;

  /** A rule with an end date, anchor on the first payment. */
  async function insertBounded(accountId: number): Promise<void> {
    await env.DB.prepare(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2026-10-05')`,
    )
      .bind(accountId)
      .run();
  }

  it('does not let the anchor move past the end date', async () => {
    const accountId = await insertAccount();
    await insertBounded(accountId);
    await expectRejected("UPDATE recurring_items SET next_due_date = '2026-11-05'");
  });

  it('retires the rule with the active = 0 flag, without touching the anchor', async () => {
    const accountId = await insertAccount();
    await insertBounded(accountId);
    await env.DB.prepare('UPDATE recurring_items SET active = 0').run();
    const row = await env.DB.prepare('SELECT active, next_due_date FROM recurring_items').first<{
      active: number;
      next_due_date: string;
    }>();
    expect(row).toEqual({ active: 0, next_due_date: '2026-09-05' });
  });

  it('does not let the term be shortened below an anchor that has moved on — and active = 0 is NOT a way out', async () => {
    // A rule with no end date that has run for half a year: the anchor has moved into the future. The owner
    // sets an end date retroactively — "the rent ended in September".
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Аренда', -100000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-11-05', NULL)`,
    )
      .bind(accountId)
      .run();
    await expectRejected("UPDATE recurring_items SET end_date = '2026-09-30'");
    // The CHECK does not look at active — on a retired row the rejection is exactly the same.
    await env.DB.prepare('UPDATE recurring_items SET active = 0').run();
    await expectRejected("UPDATE recurring_items SET end_date = '2026-09-30'");
  });

  it('allows a retroactive close when the anchor and the term change in one UPDATE', async () => {
    // The normal path for S1-3: the CHECK is evaluated after the whole UPDATE is applied,
    // so the pair passes where each half is rejected on its own.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Аренда', -100000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-11-05', NULL)`,
    )
      .bind(accountId)
      .run();
    await env.DB.prepare(
      "UPDATE recurring_items SET next_due_date = '2026-09-05', end_date = '2026-09-30', active = 0",
    ).run();
    const row = await env.DB.prepare(
      'SELECT next_due_date, end_date, active FROM recurring_items',
    ).first<{ next_due_date: string; end_date: string; active: number }>();
    expect(row).toEqual({ next_due_date: '2026-09-05', end_date: '2026-09-30', active: 0 });
  });
});

// The month anchor of a yearly rule — migration 0003, issue #225. What is checked is
// SPECIFICALLY the month: the day of `next_due_date` is allowed to diverge from `day_of_month`, and
// why is in the migration header. The tests below lock both halves of that decision.
describe('recurring_items — yearly rule and its month anchor', () => {
  // No end_date: these checks have nothing to do with the end date.
  const base = `INSERT INTO recurring_items
    (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date)`;

  it('accepts a yearly rule that falls in its own month', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2028-02-29')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare(
      'SELECT month_of_year, next_due_date FROM recurring_items',
    ).first<{ month_of_year: number; next_due_date: string }>();
    expect(row).toEqual({ month_of_year: 2, next_due_date: '2028-02-29' });
  });

  it('rejects a yearly rule whose next date is not in the anchor month', async () => {
    // Exactly the row from issue #225: the anchor is February, the date is August. From there
    // the S1-4 forecast diverges from itself — advanceByPeriods takes the month from
    // the date, nextOccurrence from month_of_year.
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2026-08-10')`,
      accountId,
    );
  });

  it('does not let an UPDATE move the anchor into another month — the CHECK is alive on it too', async () => {
    // This is the S1-3 and S1-4 path: the sliding anchor is moved specifically by UPDATE, and
    // for a yearly rule it may be moved only inside the anchor month —
    // the month is what is checked, the day does not dictate it.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-28')`,
    )
      .bind(accountId)
      .run();
    await expectRejected("UPDATE recurring_items SET next_due_date = '2027-03-29'");
    await env.DB.prepare("UPDATE recurring_items SET next_due_date = '2028-02-29'").run();
    const row = await env.DB.prepare('SELECT next_due_date FROM recurring_items').first<{
      next_due_date: string;
    }>();
    expect(row?.next_due_date).toBe('2028-02-29');
  });

  it('accepts February 29 clamped to the 28th in a non-leap year', async () => {
    // Clamping 29–31 to the last day of the month is part of the rule contract, not
    // corruption of the row. The month check must let it through.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-28')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT next_due_date FROM recurring_items').first<{
      next_due_date: string;
    }>();
    expect(row?.next_due_date).toBe('2027-02-28');
  });

  it('allows a day that diverges from the day anchor — shifting one payment is legal', async () => {
    // A deliberate boundary of task #225, not a missed case: both
    // forecast consumers take the day from day_of_month, so they have nothing
    // to diverge on because of it — only the first occurrence differs, and that is the
    // sliding anchor itself. The test holds this decision: if the day starts being checked,
    // it goes red and forces an update of the migration 0003 header.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-15')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT next_due_date FROM recurring_items').first<{
      next_due_date: string;
    }>();
    expect(row?.next_due_date).toBe('2027-02-15');
  });

  it('allows changing the anchor month together with the date in one UPDATE — the S1-3 path', async () => {
    // "Insurance was moved from February to August". It cannot be done in halves:
    // the CHECK is alive on UPDATE, so month_of_year alone is rejected, while
    // the pair passes — it is checked only after the whole UPDATE is applied.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-28')`,
    )
      .bind(accountId)
      .run();
    await expectRejected('UPDATE recurring_items SET month_of_year = 8');
    await env.DB.prepare(
      "UPDATE recurring_items SET month_of_year = 8, next_due_date = '2027-08-29'",
    ).run();
    const row = await env.DB.prepare(
      'SELECT month_of_year, next_due_date FROM recurring_items',
    ).first<{ month_of_year: number; next_due_date: string }>();
    expect(row).toEqual({ month_of_year: 8, next_due_date: '2027-08-29' });
  });
});

// Migration 0003 rebuilds recurring_items wholesale — SQLite cannot
// ALTER TABLE ADD CONSTRAINT. The table definition was rewritten by hand, and the tests
// above hold almost none of it: behavioral checks exist for the rule
// anchors, both `end_date` checks, and the new month anchor, but not for the bounds of
// `interval_count`, `day_of_month`, `month_of_year`, the format of `next_due_date`, or the
// checks of `title`, `amount_minor`, `currency`, `active` — neither before this
// migration nor after. Losing any of them would have passed CI silently.
//
// So the snapshot is one and whole: the normalized DDL of the table. It catches everything
// at once — columns, their order and types, DEFAULT, EVERY CHECK, the foreign key —
// instead of a dozen negative tests, each of which would have had to be invented
// separately.
//
// What normalization tolerates and what it does not is worth knowing up front, so a red test
// reads correctly. It tolerates: comment edits and any AMOUNT of whitespace.
// It does not tolerate: a line break at a token boundary, a change of keyword case —
// that yields a FALSE red, while the semantics did not change. It therefore errs
// on the safe side: it cannot miss a lost constraint,
// but it can demand a snapshot update once too often. The only real
// blindness is whitespace and `--` INSIDE string literals; today's
// definition has no such literals, but a column with `DEFAULT 'not set'` would
// bring them, and then normalization would have to be refined.
//
// The next migration that changes this table must update the snapshot. That is not
// overhead, but the only place where the MEANING of a schema change
// lands in the diff: the snapshot line shows exactly what became different.
//
// Quotes around the table name are a trace of `ALTER TABLE ... RENAME TO` from migration
// 0003, not part of the schema's meaning: that is how SQLite rewrites the stored DDL.
// A migration that creates this table directly will not add quotes — and the snapshot
// will have to be fixed right here, without taking that for a loss.
const RECURRING_ITEMS_DDL = `
  CREATE TABLE recurring_items (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    category TEXT,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
    interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 365),
    day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    month_of_year INTEGER CHECK (month_of_year IS NULL OR month_of_year BETWEEN 1 AND 12),
    next_due_date TEXT NOT NULL CHECK (
      date(next_due_date) IS NOT NULL
      AND next_due_date = date(next_due_date)
      AND next_due_date >= '0001-01-01'
    ),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    end_date TEXT,
    revision TEXT,
    CONSTRAINT recurring_items_end_date_format CHECK (
      end_date IS NULL
      OR (
        date(end_date) IS NOT NULL
        AND end_date = date(end_date)
        AND end_date >= '0001-01-01'
      )
    ),
    CONSTRAINT recurring_items_end_date_after_anchor CHECK (
      end_date IS NULL OR end_date >= next_due_date
    ),
    CONSTRAINT recurring_items_rule_anchors CHECK (
      (frequency IN ('daily', 'weekly') AND day_of_month IS NULL AND month_of_year IS NULL)
      OR (frequency = 'monthly' AND day_of_month IS NOT NULL AND month_of_year IS NULL)
      OR (frequency = 'yearly' AND day_of_month IS NOT NULL AND month_of_year IS NOT NULL)
    ),
    CONSTRAINT recurring_items_yearly_month_matches_anchor CHECK (
      frequency <> 'yearly'
      OR (
        strftime('%m', next_due_date) IS NOT NULL
        AND CAST(strftime('%m', next_due_date) AS INTEGER) = month_of_year
      )
    )
  )`;

/** Comments out, whitespace collapsed to one — meaning is compared, not formatting. */
function normalizeDdl(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('recurring_items — table rebuild by migration 0003', () => {
  it('preserved the table definition in full: columns, DEFAULT, every CHECK and FK', async () => {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recurring_items'`,
    ).first<{ sql: string }>();
    expect(normalizeDdl(row!.sql)).toBe(normalizeDdl(RECURRING_ITEMS_DDL));
  });

  it('kept the foreign key alive, not only written into the DDL', async () => {
    // The snapshot above holds the presence of `REFERENCES` in the schema text; here — that the key
    // is actually enforced on write. `PRAGMA foreign_key_check` in the schema
    // inventory will not show this: it runs against an empty database, and there is nothing to check there.
    await expectRejected(
      `INSERT INTO recurring_items
         (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date)
       VALUES ('Страховка', -100000, 'RSD', 999999, 'yearly', 1, 29, 2, '2027-02-28')`,
    );
  });

  it('preserved index definitions, not only names — the partial one stayed partial', async () => {
    // The schema inventory above checks names; here `WHERE active = 1` matters:
    // without it a partial index silently becomes a full one, and the forecast drags the weight
    // of inactive rules. Line breaks are collapsed — formatting is not an invariant.
    const { results } = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recurring_items'
       ORDER BY name`,
    ).all<{ name: string; sql: string }>();
    expect(results.map((i) => i.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE INDEX idx_recurring_items_account_id ON recurring_items (account_id)',
      'CREATE INDEX idx_recurring_items_next_due_date ON recurring_items (next_due_date) WHERE active = 1',
    ]);
  });
});

describe('fx_rates', () => {
  it('stores the rate as an integer scaled by 1e9', async () => {
    // RSD ≈ 0.0092 USD.
    await env.DB.prepare('INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)')
      .bind('RSD', 9_200_000, NOW)
      .run();
    const row = await env.DB.prepare('SELECT rate_e9 FROM fx_rates WHERE code = ?')
      .bind('RSD')
      .first<{ rate_e9: number }>();
    expect(row?.rate_e9).toBe(9_200_000);
  });

  it('rejects hour 24 — the condition is copied into three tables, a test is needed in each', async () => {
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'RUB',
      1,
      '2026-08-09T24:30:15Z',
    );
  });

  it('rejects a timestamp with milliseconds — the column precision is seconds', async () => {
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'RUB',
      1,
      '2026-08-09T12:00:00.000Z',
    );
  });

  it('rejects a non-positive rate', async () => {
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'RUB',
      0,
      NOW,
    );
  });

  it('does not allow two rows for one currency', async () => {
    await env.DB.prepare('INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)')
      .bind('EUR', 1_090_000_000, NOW)
      .run();
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'EUR',
      1_100_000_000,
      NOW,
    );
  });
});

describe('operations and receipts', () => {
  async function insertReceipt(): Promise<number> {
    const row = await env.DB.prepare(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/2026/abc.jpg', 'parsed', ?)
       RETURNING id`,
    )
      .bind(NOW)
      .first<{ id: number }>();
    return row!.id;
  }

  it('writes a manual operation without a receipt', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Maxi', 'Хлеб', 'Продукты', 'Выпечка', -12000, 'manual')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT source, receipt_id, subcategory FROM operations').first<{
      source: string;
      receipt_id: number | null;
      subcategory: string | null;
    }>();
    expect(row).toEqual({ source: 'manual', receipt_id: null, subcategory: 'Выпечка' });
  });

  it('keeps comment, receipt_url, and fiscal_receipt_id nullable with no default', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Хлеб', -12000, 'manual')`,
    )
      .bind(accountId)
      .run();
    const empty = await env.DB.prepare('SELECT comment, receipt_url, fiscal_receipt_id FROM operations').first<{
      comment: string | null;
      receipt_url: string | null;
      fiscal_receipt_id: string | null;
    }>();
    expect(empty).toEqual({ comment: null, receipt_url: null, fiscal_receipt_id: null });

    await env.DB.prepare(
      `UPDATE operations SET comment = ?, receipt_url = ?, fiscal_receipt_id = ?`,
    )
      .bind('скидка по карте', 'https://suf.purs.gov.rs/v/?vl=abc', 'PFR-GROCERY-1')
      .run();
    const filled = await env.DB.prepare('SELECT comment, receipt_url, fiscal_receipt_id FROM operations').first<{
      comment: string | null;
      receipt_url: string | null;
      fiscal_receipt_id: string | null;
    }>();
    expect(filled).toEqual({
      comment: 'скидка по карте',
      receipt_url: 'https://suf.purs.gov.rs/v/?vl=abc',
      fiscal_receipt_id: 'PFR-GROCERY-1',
    });
  });

  // An operation's account has been required since 0005 (owner decision 2026-08-12): an operation
  // without an account is not "a separate stream for Analytics", but a row that says nothing
  // about the movement of money.
  it('does not let an operation exist without an account', async () => {
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', NULL, 'expense', 'Хлеб', -12000, 'manual')`,
    );
  });

  it('does not let an account be deleted while operations hang on it', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Хлеб', -12000, 'manual')`,
    )
      .bind(accountId)
      .run();
    await expectRejected('DELETE FROM accounts WHERE id = ?', accountId);
  });

  // The sign is the balance delta, and the schema holds that itself, not only the API: an expense
  // is strictly negative, income and a refund are strictly positive.
  it('rejects an expense with a positive amount', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Хлеб', 12000, 'manual')`,
      accountId,
    );
  });

  it('rejects income with a negative amount', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'income', 'Зарплата', -500000, 'manual')`,
      accountId,
    );
  });

  it('writes a refund as a positive amount', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'refund', 'Возврат наушников', 499900, 'manual')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT kind, amount_minor FROM operations').first<{
      kind: string;
      amount_minor: number;
    }>();
    expect(row).toEqual({ kind: 'refund', amount_minor: 499900 });
  });

  it('rejects an unknown operation kind', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'transfer', 'Перевод', -12000, 'manual')`,
      accountId,
    );
  });

  it('rejects a zero amount', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Ничего', 0, 'manual')`,
      accountId,
    );
  });

  // "Vegetables and fruit" without "Groceries" specifies nothing.
  it('does not allow a subcategory without a category', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, subcategory, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Огурцы', 'Овощи и фрукты', -12000, 'manual')`,
      accountId,
    );
  });

  it('links a line item to a receipt', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, ?, 'receipt')`,
    )
      .bind(accountId, receiptId)
      .run();
    const row = await env.DB.prepare('SELECT receipt_id FROM operations').first<{
      receipt_id: number;
    }>();
    expect(row?.receipt_id).toBe(receiptId);
  });

  it('does not let a manual operation reference a receipt', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, ?, 'manual')`,
      accountId,
      receiptId,
    );
  });

  it('does not let a receipt operation exist without a receipt', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, 'receipt')`,
      accountId,
    );
  });

  it('rejects hour 24 on a receipt — the third copy of the same condition', async () => {
    await expectRejected(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/y.jpg', 'uploaded', ?)`,
      '2026-08-09T24:30:15Z',
    );
  });

  it('rejects an unknown receipt status', async () => {
    await expectRejected(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/x.jpg', 'pending', ?)`,
      NOW,
    );
  });

  it('does not allow two receipts for one R2 key', async () => {
    await insertReceipt();
    await expectRejected(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/2026/abc.jpg', 'uploaded', ?)`,
      NOW,
    );
  });

  it('does not let a receipt be deleted while its line items are alive', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, ?, 'receipt')`,
    )
      .bind(accountId, receiptId)
      .run();
    await expectRejected('DELETE FROM receipts WHERE id = ?', receiptId);
  });

  // Issue #267: marking "done" produces an operation. source = planned is
  // the origin, not "manual". Its receipt_id is empty, as for manual.
  it('writes an operation from a planned item without a receipt', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, done)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?, 1)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'planned', ?)`,
    )
      .bind(accountId, planned!.id)
      .run();
    const row = await env.DB.prepare('SELECT source, receipt_id, planned_item_id FROM operations').first<{
      source: string;
      receipt_id: number | null;
      planned_item_id: number | null;
    }>();
    expect(row).toEqual({ source: 'planned', receipt_id: null, planned_item_id: planned!.id });
  });

  it('does not let a planned operation reference a receipt', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, ?, 'planned', ?)`,
      accountId,
      receiptId,
      planned!.id,
    );
  });

  it('does not let a manual operation hold a link to a planned item', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'manual', ?)`,
      accountId,
      planned!.id,
    );
  });

  it('does not let two operations reference one planned item', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'planned', ?)`,
    )
      .bind(accountId, planned!.id)
      .run();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-02', ?, 'expense', 'Аренда ещё раз', -95000, 'planned', ?)`,
      accountId,
      planned!.id,
    );
  });

  it('deleting a planned item does not touch an operation that already happened', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'planned', ?)`,
    )
      .bind(accountId, planned!.id)
      .run();
    await env.DB.prepare('DELETE FROM planned_items WHERE id = ?').bind(planned!.id).run();
    const row = await env.DB.prepare('SELECT source, planned_item_id, amount_minor FROM operations').first<{
      source: string;
      planned_item_id: number | null;
      amount_minor: number;
    }>();
    expect(row).toEqual({ source: 'planned', planned_item_id: null, amount_minor: -95000 });
  });

  it('accepts an operation from a recurring rule: source = recurring and recurring_item_id', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    const row = await env.DB.prepare('SELECT source, receipt_id, recurring_item_id FROM operations').first<{
      source: string;
      receipt_id: number | null;
      recurring_item_id: number | null;
    }>();
    expect(row).toEqual({ source: 'recurring', receipt_id: null, recurring_item_id: recurring!.id });
  });

  it('does not let a recurring operation reference a receipt', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, ?, 'recurring', ?)`,
      accountId,
      receiptId,
      recurring!.id,
    );
  });

  it('does not let a manual operation hold a link to a recurring rule', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, 'manual', ?)`,
      accountId,
      recurring!.id,
    );
  });

  it('allows several operations to reference one recurring rule', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет за сентябрь', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-10-01', ?, 'expense', 'Интернет за октябрь', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    const { results } = await env.DB.prepare('SELECT id, recurring_item_id FROM operations ORDER BY date').all<{
      id: number;
      recurring_item_id: number | null;
    }>();
    expect(results).toHaveLength(2);
    expect(results[0].recurring_item_id).toBe(recurring!.id);
    expect(results[1].recurring_item_id).toBe(recurring!.id);
  });

  it('deleting a recurring rule does not touch an operation that already happened (ON DELETE SET NULL)', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    await env.DB.prepare('DELETE FROM recurring_items WHERE id = ?').bind(recurring!.id).run();
    const row = await env.DB.prepare('SELECT source, recurring_item_id, amount_minor FROM operations').first<{
      source: string;
      recurring_item_id: number | null;
      amount_minor: number;
    }>();
    expect(row).toEqual({ source: 'recurring', recurring_item_id: null, amount_minor: -3000 });
  });
});

// The operations rebuild by migration 0007 — the same contract as 0003 and 0006:
// the DDL snapshot catches columns/CHECK/FK, a rerun on a nonempty table catches
// the row copy itself (reordering columns in INSERT ... SELECT is invisible to the snapshot).
const OPERATIONS_DDL = `
  CREATE TABLE operations (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL CHECK (
      date(date) IS NOT NULL AND date = date(date) AND date >= '0001-01-01'
    ),
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'refund', 'transfer_out', 'transfer_in')),
    store TEXT,
    item TEXT NOT NULL CHECK (length(trim(item)) > 0),
    category TEXT,
    subcategory TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    receipt_id INTEGER REFERENCES receipts (id),
    source TEXT NOT NULL CHECK (source IN ('manual', 'receipt', 'planned', 'recurring', 'agent')),
    planned_item_id INTEGER REFERENCES planned_items (id) ON DELETE SET NULL,
    recurring_item_id INTEGER REFERENCES recurring_items (id) ON DELETE SET NULL,
    transfer_id INTEGER REFERENCES transfers (id) ON DELETE CASCADE,
    comment TEXT,
    receipt_url TEXT,
    fiscal_receipt_id TEXT,
    CONSTRAINT operations_source_matches_receipt CHECK (
      (source IN ('manual', 'planned', 'recurring', 'agent') AND receipt_id IS NULL)
      OR (source = 'receipt' AND receipt_id IS NOT NULL)
    ),
    CONSTRAINT operations_sign_matches_kind CHECK (
      (kind IN ('expense', 'transfer_out') AND amount_minor < 0)
      OR (kind IN ('income', 'refund', 'transfer_in') AND amount_minor > 0)
    ),
    CONSTRAINT operations_subcategory_needs_category CHECK (
      subcategory IS NULL OR category IS NOT NULL
    ),
    CONSTRAINT operations_planned_link_matches_source CHECK (
      planned_item_id IS NULL OR source = 'planned'
    ),
    CONSTRAINT operations_recurring_link_matches_source CHECK (
      recurring_item_id IS NULL OR source = 'recurring'
    ),
    CONSTRAINT operations_transfer_link_matches_kind CHECK (
      (transfer_id IS NULL AND kind NOT IN ('transfer_out', 'transfer_in'))
      OR (transfer_id IS NOT NULL AND kind IN ('transfer_out', 'transfer_in'))
    )
  )`;

describe('operations — table rebuild by migration 0011', () => {
  it('preserved the table definition in full: columns, every CHECK and FK', async () => {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'`,
    ).first<{ sql: string }>();
    expect(normalizeDdl(row!.sql)).toBe(normalizeDdl(OPERATIONS_DDL));
  });

  it('preserved index definitions, not only names', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'operations'
       ORDER BY name`,
    ).all<{ name: string; sql: string }>();
    expect(results.map((i) => i.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE INDEX idx_operations_account_id ON operations (account_id)',
      'CREATE INDEX idx_operations_category ON operations (category)',
      'CREATE INDEX idx_operations_date ON operations (date DESC)',
      'CREATE INDEX idx_operations_fiscal_receipt_id ON operations (fiscal_receipt_id) WHERE fiscal_receipt_id IS NOT NULL',
      'CREATE UNIQUE INDEX idx_operations_id_recurring_item_id ON operations (id, recurring_item_id)',
      'CREATE UNIQUE INDEX idx_operations_planned_item_id ON operations (planned_item_id) WHERE planned_item_id IS NOT NULL',
      'CREATE INDEX idx_operations_receipt_id ON operations (receipt_id)',
      'CREATE INDEX idx_operations_recurring_item_id ON operations (recurring_item_id) WHERE recurring_item_id IS NOT NULL',
      'CREATE INDEX idx_operations_transfer_id ON operations (transfer_id) WHERE transfer_id IS NOT NULL',
    ]);
  });

  it('cascades deletion of linked operations when a transfer is deleted (ON DELETE CASCADE)', async () => {
    const accountId = await insertAccount();
    const transfer = await env.DB.prepare('INSERT INTO transfers DEFAULT VALUES RETURNING id').first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_out', 'Списание перевода', -5000, 'manual', ?)`,
    ).bind(accountId, transfer!.id).run();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_in', 'Зачисление перевода', 5000, 'manual', ?)`,
    ).bind(accountId, transfer!.id).run();

    expect((await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>())?.count).toBe(2);

    await env.DB.prepare('DELETE FROM transfers WHERE id = ?').bind(transfer!.id).run();

    expect((await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>())?.count).toBe(0);
  });

  it('forbids transfer_out with a positive amount and transfer_in with a negative amount', async () => {
    const accountId = await insertAccount();
    const transfer = await env.DB.prepare('INSERT INTO transfers DEFAULT VALUES RETURNING id').first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_out', 'Ошибка знака', 5000, 'manual', ?)`,
      accountId,
      transfer!.id,
    );
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_in', 'Ошибка знака', -5000, 'manual', ?)`,
      accountId,
      transfer!.id,
    );
  });

  it('forbids transfer_id without transfer_out/transfer_in and the reverse', async () => {
    const accountId = await insertAccount();
    const transfer = await env.DB.prepare('INSERT INTO transfers DEFAULT VALUES RETURNING id').first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'expense', 'Обычная трата', -5000, 'manual', ?)`,
      accountId,
      transfer!.id,
    );
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-15', ?, 'transfer_out', 'Перевод без id', -5000, 'manual')`,
      accountId,
    );
  });

  describe('oauth_clients, oauth_consents, oauth_tokens (S2-1, issue #261)', () => {
    it('creates a client and rejects one without the required name', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, metadata_document_url)
         VALUES ('https://claude.ai/mcp.json', 'Claude Desktop', 'https://claude.ai/mcp.json')`,
      ).run();

      const client = await env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?')
        .bind('https://claude.ai/mcp.json')
        .first<{ id: string; name: string }>();
      expect(client?.name).toBe('Claude Desktop');

      await expectRejectedNotNull(
        'oauth_clients.name',
        `INSERT INTO oauth_clients (id, name) VALUES ('client-2', NULL)`,
      );
    });

    it('cascades deletion of consents and tokens when a client is deleted', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name) VALUES ('client-test', 'Test Client')`,
      ).run();

      await env.DB.prepare(
        `INSERT INTO oauth_consents (id, client_id, scopes, redirect_uri)
         VALUES ('consent-1', 'client-test', '["read"]', 'https://client.test/callback')`,
      ).run();

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, last_ip, last_country)
         VALUES ('token-1', 'client-test', '["read"]', '1.2.3.4', 'US')`,
      ).run();

      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_consents').first<{ count: number }>())?.count,
      ).toBe(1);
      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_tokens').first<{ count: number }>())?.count,
      ).toBe(1);

      await env.DB.prepare(`DELETE FROM oauth_clients WHERE id = 'client-test'`).run();

      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_consents').first<{ count: number }>())?.count,
      ).toBe(0);
      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_tokens').first<{ count: number }>())?.count,
      ).toBe(0);
    });

    it('forbids creating a consent or a token for a nonexistent client (FK)', async () => {
      await expectRejected(
        `INSERT INTO oauth_consents (id, client_id, scopes, redirect_uri)
         VALUES ('consent-bad', 'unknown-client', '["read"]', 'https://client.test/callback')`,
      );
      await expectRejected(
        `INSERT INTO oauth_tokens (id, client_id, scopes)
         VALUES ('token-bad', 'unknown-client', '["read"]')`,
      );
    });
  });

  describe('mcp_audit_log and source = "agent" (S2-4, issue #264)', () => {
    it('allows an operation with source = "agent" and no receipt_id', async () => {
      const accountId = await insertAccount();
      await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
         VALUES ('2026-08-15', ?, 'expense', 'Кофе от агента', -350, 'agent')`
      ).bind(accountId).run();

      const op = await env.DB.prepare('SELECT source FROM operations WHERE account_id = ?').bind(accountId).first<{ source: string }>();
      expect(op?.source).toBe('agent');
    });

    it('forbids an operation with source = "agent" and a nonempty receipt_id', async () => {
      const accountId = await insertAccount();
      const receipt = await env.DB.prepare(
        `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/2026/agent.jpg', 'parsed', ?) RETURNING id`
      )
        .bind(NOW)
        .first<{ id: number }>();

      await expectRejected(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, receipt_id)
         VALUES ('2026-08-15', ?, 'expense', 'Невалидный чек', -350, 'agent', ?)`,
        accountId,
        receipt!.id
      );
    });

    it('enforces uniqueness of idempotency_key for one client_id', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name) VALUES ('client-mcp-1', 'Test MCP Client')`
      ).run();

      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key)
         VALUES ('log-1', 'client-mcp-1', 'operation_add', 'success', '{"ok":true}', 'key-123')`
      ).run();

      // A repeat insert with the same client_id and idempotency_key must be rejected
      await expectRejected(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key)
         VALUES ('log-2', 'client-mcp-1', 'operation_add', 'success', '{"ok":true}', 'key-123')`
      );

      // But for a different client_id the same idempotency_key is allowed
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name) VALUES ('client-mcp-2', 'Second MCP Client')`
      ).run();

      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key)
         VALUES ('log-3', 'client-mcp-2', 'operation_add', 'success', '{"ok":true}', 'key-123')`
      ).run();

      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM mcp_audit_log WHERE idempotency_key = "key-123"').first<{ count: number }>())?.count
      ).toBe(2);
    });
  });
});
