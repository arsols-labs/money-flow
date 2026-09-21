/**
 * Builds the stranger-safe product-showcase SQL for `scripts/seed-demo.sql`.
 * Each row is its own INSERT…SELECT — D1 remote rejects multi-arm UNION ALL
 * compound SELECTs ("too many terms").
 */

export const DEMO_SEED_MARKER_KEY = 'setup_demo_seed';
export const DEMO_SEED_MARKER_VALUE = '1';

const SEED_GUARD = `EXISTS (SELECT 1 FROM settings WHERE key = '${DEMO_SEED_MARKER_KEY}' AND value = '${DEMO_SEED_MARKER_VALUE}')`;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlValue(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value.sql) return value.sql;
  return sqlString(value);
}

function daysAgo(days) {
  return { sql: `date('now', '-${days} days')` };
}

function daysAhead(days) {
  return { sql: `date('now', '+${days} days')` };
}

function nextMonthStart() {
  return { sql: "date('now', 'start of month', '+1 month')" };
}

function accountRef(name) {
  return `FROM accounts a
WHERE a.name = ${sqlString(name)} AND a.owner = 'Household'`;
}

export const DEMO_ACCOUNTS = Object.freeze([
  {
    name: 'Everyday Checking',
    bank: 'Example Bank',
    type: 'Checking',
    owner: 'Household',
    country: 'USA',
    currency: 'USD',
    balance_minor: 428000,
    sort: 0,
  },
  {
    name: 'Emergency Savings',
    bank: 'Example Bank',
    type: 'Savings',
    owner: 'Household',
    country: 'USA',
    currency: 'USD',
    balance_minor: 1250000,
    sort: 1,
  },
  {
    // Already negative on Pulse Warnings. Household overall stays positive:
    // the card is one account; the total series is the sum of all accounts.
    name: 'Everyday Card',
    bank: 'Example Bank',
    type: 'Credit',
    owner: 'Household',
    country: 'USA',
    currency: 'USD',
    balance_minor: -64000,
    sort: 2,
  },
  {
    name: 'Travel Cash',
    bank: null,
    type: 'Cash',
    owner: 'Household',
    country: 'USA',
    currency: 'EUR',
    balance_minor: 21500,
    sort: 3,
  },
  {
    name: 'Rhine Checking',
    bank: 'Rhine Bank',
    type: 'Checking',
    owner: 'Household',
    country: 'Germany',
    currency: 'EUR',
    balance_minor: 318000,
    sort: 4,
  },
  {
    name: 'Sterling Current',
    bank: 'Thames Bank',
    type: 'Checking',
    owner: 'Household',
    country: 'United Kingdom',
    currency: 'GBP',
    balance_minor: 154000,
    sort: 5,
  },
  {
    name: 'Maple Everyday',
    bank: 'Maple Credit Union',
    type: 'Checking',
    owner: 'Household',
    country: 'Canada',
    currency: 'CAD',
    balance_minor: 184000,
    sort: 6,
  },
  {
    name: 'Maple Savings',
    bank: 'Maple Credit Union',
    type: 'Savings',
    owner: 'Household',
    country: 'Canada',
    currency: 'CAD',
    balance_minor: 620000,
    sort: 7,
  },
]);

export const DEMO_FX_RATES = Object.freeze([
  { code: 'EUR', rate_e9: 1080000000 },
  { code: 'GBP', rate_e9: 1270000000 },
  { code: 'CAD', rate_e9: 740000000 },
]);

function groceryAmount(daysAgoValue) {
  return -(7200 + (daysAgoValue % 11) * 160 + (daysAgoValue % 5) * 40);
}

function buildOperations() {
  /** @type {object[]} */
  const operations = [];

  for (const days of [90, 60, 30]) {
    operations.push({
      date: daysAgo(days),
      account: 'Everyday Checking',
      kind: 'income',
      store: 'Acme Studio',
      item: 'Monthly salary',
      category: 'Income',
      subcategory: 'Salary',
      amount_minor: 320000,
      source: 'manual',
    });
  }

  for (const days of [84, 77, 70, 63, 56, 49, 42, 35, 28, 21, 14, 7]) {
    operations.push({
      date: daysAgo(days),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Neighborhood Market',
      item: 'Weekly groceries',
      category: 'Food',
      subcategory: 'Groceries',
      amount_minor: groceryAmount(days),
      source: 'manual',
    });
  }

  const dining = [
    [82, 'Harbor Cafe', 'Morning coffee', -650],
    [68, 'Harbor Cafe', 'Lunch special', -1850],
    [51, 'Cedar Bistro', 'Dinner out', -6400],
    [39, 'Harbor Cafe', 'Coffee and pastry', -720],
    [24, 'Lakeside Diner', 'Weekend brunch', -4200],
    [11, 'Harbor Cafe', 'Afternoon coffee', -580],
    [4, 'Cedar Bistro', 'Shared dinner', -7100],
  ];
  for (const [days, store, item, amount_minor] of dining) {
    operations.push({
      date: daysAgo(days),
      account: 'Everyday Checking',
      kind: 'expense',
      store,
      item,
      category: 'Dining',
      subcategory: null,
      amount_minor,
      source: 'manual',
    });
  }

  for (const days of [88, 58, 27]) {
    operations.push({
      date: daysAgo(days),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'City Transit',
      item: 'Monthly pass',
      category: 'Transport',
      subcategory: null,
      amount_minor: -12000,
      source: 'manual',
    });
  }

  for (const days of [86, 55, 25]) {
    operations.push({
      date: daysAgo(days),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Metro Utilities',
      item: 'Electric and water',
      category: 'Utilities',
      subcategory: null,
      amount_minor: -14800 - (days % 3) * 250,
      source: 'manual',
    });
  }

  for (const days of [80, 50, 19]) {
    operations.push({
      date: daysAgo(days),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Cloud Notes',
      item: 'Notes subscription',
      category: 'Subscriptions',
      subcategory: null,
      amount_minor: -999,
      source: 'manual',
    });
  }

  operations.push(
    {
      date: daysAgo(73),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Cedar Pharmacy',
      item: 'Household pharmacy',
      category: 'Health',
      subcategory: null,
      amount_minor: -2850,
      source: 'manual',
    },
    {
      date: daysAgo(16),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Cedar Pharmacy',
      item: 'Vitamins',
      category: 'Health',
      subcategory: null,
      amount_minor: -1640,
      source: 'manual',
    },
    {
      date: daysAgo(47),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Northwind Books',
      item: 'Paperback and notebook',
      category: 'Shopping',
      subcategory: null,
      amount_minor: -3200,
      source: 'manual',
    },
    {
      date: daysAgo(9),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Northwind Books',
      item: 'Children storybook',
      category: 'Shopping',
      subcategory: null,
      amount_minor: -1450,
      source: 'manual',
    },
    {
      date: daysAgo(62),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Example Fuel',
      item: 'Full tank',
      category: 'Transport',
      subcategory: 'Fuel',
      amount_minor: -5400,
      source: 'manual',
    },
    {
      date: daysAgo(33),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Example Fuel',
      item: 'Full tank',
      category: 'Transport',
      subcategory: 'Fuel',
      amount_minor: -5120,
      source: 'manual',
    },
    {
      date: daysAgo(6),
      account: 'Everyday Checking',
      kind: 'refund',
      store: 'Neighborhood Market',
      item: 'Returned produce',
      category: 'Food',
      subcategory: 'Groceries',
      amount_minor: 1200,
      source: 'manual',
    },
    {
      date: daysAgo(13),
      account: 'Everyday Checking',
      kind: 'expense',
      store: 'Neighborhood Market',
      item: 'Market basket',
      category: 'Food',
      subcategory: 'Groceries',
      amount_minor: -6340,
      source: 'manual',
      comment: 'Sample fiscal receipt for the demo household',
      receipt_url: 'https://example.com/receipts/demo-fiscal-2401',
      fiscal_receipt_id: 'DEMO-FISCAL-2401',
    },
    {
      date: daysAgo(44),
      account: 'Everyday Card',
      kind: 'expense',
      store: 'Harbor Cafe',
      item: 'Card coffee',
      category: 'Dining',
      subcategory: null,
      amount_minor: -610,
      source: 'manual',
    },
    {
      date: daysAgo(22),
      account: 'Everyday Card',
      kind: 'expense',
      store: 'Northwind Books',
      item: 'Card bookstore',
      category: 'Shopping',
      subcategory: null,
      amount_minor: -2800,
      source: 'manual',
    },
    {
      date: daysAgo(10),
      account: 'Everyday Card',
      kind: 'expense',
      store: 'Cedar Pharmacy',
      item: 'Card pharmacy',
      category: 'Health',
      subcategory: null,
      amount_minor: -2190,
      source: 'manual',
    },
    {
      date: daysAgo(71),
      account: 'Emergency Savings',
      kind: 'income',
      store: 'Example Bank',
      item: 'Savings interest',
      category: 'Income',
      subcategory: 'Interest',
      amount_minor: 1850,
      source: 'manual',
    },
    {
      date: daysAgo(41),
      account: 'Travel Cash',
      kind: 'expense',
      store: 'Harbor Inn',
      item: 'Two-night stay',
      category: 'Travel',
      subcategory: 'Lodging',
      amount_minor: -12800,
      source: 'manual',
    },
    {
      date: daysAgo(40),
      account: 'Travel Cash',
      kind: 'expense',
      store: 'Rhine Bakery',
      item: 'Breakfast pastry',
      category: 'Dining',
      subcategory: null,
      amount_minor: -640,
      source: 'manual',
    },
    {
      date: daysAgo(39),
      account: 'Travel Cash',
      kind: 'expense',
      store: 'City Transit',
      item: 'Day ticket',
      category: 'Transport',
      subcategory: null,
      amount_minor: -820,
      source: 'manual',
    },
    {
      date: daysAgo(38),
      account: 'Travel Cash',
      kind: 'expense',
      store: 'Corner Market',
      item: 'Travel snacks',
      category: 'Food',
      subcategory: null,
      amount_minor: -1850,
      source: 'manual',
    },
    {
      date: daysAgo(65),
      account: 'Rhine Checking',
      kind: 'income',
      store: 'Rhine Design Studio',
      item: 'Contract payment',
      category: 'Income',
      subcategory: 'Freelance',
      amount_minor: 180000,
      source: 'manual',
    },
    {
      date: daysAgo(36),
      account: 'Rhine Checking',
      kind: 'expense',
      store: 'Rhine Bakery',
      item: 'Weekly bread',
      category: 'Food',
      subcategory: 'Groceries',
      amount_minor: -1850,
      source: 'manual',
      comment: 'Sample fiscal receipt for a euro account',
      receipt_url: 'https://example.com/receipts/demo-fiscal-2402',
      fiscal_receipt_id: 'DEMO-FISCAL-2402',
    },
    {
      date: daysAgo(18),
      account: 'Rhine Checking',
      kind: 'expense',
      store: 'Rhine Market',
      item: 'Neighborhood groceries',
      category: 'Food',
      subcategory: 'Groceries',
      amount_minor: -6240,
      source: 'manual',
    },
    {
      date: daysAgo(8),
      account: 'Rhine Checking',
      kind: 'expense',
      store: 'Rhine Transit',
      item: 'Monthly pass',
      category: 'Transport',
      subcategory: null,
      amount_minor: -8900,
      source: 'manual',
    },
    {
      date: daysAgo(52),
      account: 'Sterling Current',
      kind: 'income',
      store: 'Thames Studio',
      item: 'Side project payment',
      category: 'Income',
      subcategory: 'Freelance',
      amount_minor: 85000,
      source: 'manual',
    },
    {
      date: daysAgo(29),
      account: 'Sterling Current',
      kind: 'expense',
      store: 'Thames Grocer',
      item: 'Weekly groceries',
      category: 'Food',
      subcategory: 'Groceries',
      amount_minor: -5400,
      source: 'manual',
      comment: 'Sample fiscal receipt for a sterling account',
      receipt_url: 'https://example.com/receipts/demo-fiscal-2403',
      fiscal_receipt_id: 'DEMO-FISCAL-2403',
    },
    {
      date: daysAgo(17),
      account: 'Sterling Current',
      kind: 'expense',
      store: 'Thames Transit',
      item: 'Oyster top-up',
      category: 'Transport',
      subcategory: null,
      amount_minor: -3000,
      source: 'manual',
    },
    {
      date: daysAgo(5),
      account: 'Sterling Current',
      kind: 'expense',
      store: 'Thames Cafe',
      item: 'Tea and sandwich',
      category: 'Dining',
      subcategory: null,
      amount_minor: -1250,
      source: 'manual',
    },
    {
      date: daysAgo(46),
      account: 'Maple Everyday',
      kind: 'income',
      store: 'Maple Studio',
      item: 'Contract payment',
      category: 'Income',
      subcategory: 'Freelance',
      amount_minor: 210000,
      source: 'manual',
    },
    {
      date: daysAgo(23),
      account: 'Maple Everyday',
      kind: 'expense',
      store: 'Maple Grocer',
      item: 'Weekly groceries',
      category: 'Food',
      subcategory: 'Groceries',
      amount_minor: -9800,
      source: 'manual',
    },
    {
      date: daysAgo(12),
      account: 'Maple Everyday',
      kind: 'expense',
      store: 'Maple Transit',
      item: 'Monthly pass',
      category: 'Transport',
      subcategory: null,
      amount_minor: -12800,
      source: 'manual',
    },
    {
      date: daysAgo(3),
      account: 'Maple Everyday',
      kind: 'expense',
      store: 'Maple Cafe',
      item: 'Coffee',
      category: 'Dining',
      subcategory: null,
      amount_minor: -650,
      source: 'manual',
    },
    {
      date: daysAgo(61),
      account: 'Maple Savings',
      kind: 'income',
      store: 'Maple Credit Union',
      item: 'Savings interest',
      category: 'Income',
      subcategory: 'Interest',
      amount_minor: 2400,
      source: 'manual',
    },
  );

  return operations;
}

export const DEMO_OPERATIONS = Object.freeze(buildOperations());

export const DEMO_PLANNED = Object.freeze([
  // City rent is the monthly recurring rule only — a planned twin on the
  // same date double-counted -$1,800 on Pulse (1 Oct / start of next month).
  {
    date: daysAhead(21),
    title: 'Weekend rail tickets',
    amount_minor: -8900,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Travel',
    done: 0,
  },
  {
    date: daysAhead(45),
    title: 'Replacement laptop',
    amount_minor: -120000,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Shopping',
    done: 0,
  },
  {
    date: daysAhead(18),
    title: 'Rhine apartment insurance',
    amount_minor: -14500,
    currency: 'EUR',
    account: 'Rhine Checking',
    category: 'Insurance',
    done: 0,
  },
  {
    date: daysAgo(12),
    title: 'Hallway lamp',
    amount_minor: -4500,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Home',
    done: 1,
  },
  // Approaching zero soon: Travel Cash €215 minus this weekend outflow.
  {
    date: daysAhead(6),
    title: 'City museum tickets',
    amount_minor: -28000,
    currency: 'EUR',
    account: 'Travel Cash',
    category: 'Travel',
    done: 0,
  },
  // Will go negative later: Sterling Current £1,540 minus this autumn bill.
  // United Kingdom / GBP also warn because this is the only GBP account.
  {
    date: daysAhead(48),
    title: 'Winter boiler service',
    amount_minor: -180000,
    currency: 'GBP',
    account: 'Sterling Current',
    category: 'Home',
    done: 0,
  },
]);

export const DEMO_RECURRING = Object.freeze([
  {
    title: 'Monthly salary',
    amount_minor: 320000,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Income',
    frequency: 'monthly',
    interval_count: 1,
    day_of_month: 1,
    month_of_year: null,
    next_due_date: nextMonthStart(),
    active: 1,
  },
  {
    title: 'City rent',
    amount_minor: -180000,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Housing',
    frequency: 'monthly',
    interval_count: 1,
    day_of_month: 1,
    month_of_year: null,
    next_due_date: nextMonthStart(),
    active: 1,
  },
  {
    title: 'Streamline Internet',
    amount_minor: -6500,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Utilities',
    frequency: 'monthly',
    interval_count: 1,
    day_of_month: { sql: "CAST(strftime('%d', date('now', '+12 days')) AS INTEGER)" },
    month_of_year: null,
    next_due_date: daysAhead(12),
    active: 1,
  },
  {
    title: 'Weekly produce box',
    amount_minor: -2800,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Food',
    frequency: 'weekly',
    interval_count: 1,
    day_of_month: null,
    month_of_year: null,
    next_due_date: daysAhead(4),
    active: 1,
  },
  {
    title: 'Annual travel insurance',
    amount_minor: -18600,
    currency: 'USD',
    account: 'Everyday Checking',
    category: 'Insurance',
    frequency: 'yearly',
    interval_count: 1,
    day_of_month: { sql: "CAST(strftime('%d', date('now', '+90 days')) AS INTEGER)" },
    month_of_year: { sql: "CAST(strftime('%m', date('now', '+90 days')) AS INTEGER)" },
    next_due_date: daysAhead(90),
    active: 1,
  },
]);

export const DEMO_TRANSFERS = Object.freeze([
  {
    item: 'Transfer to emergency savings',
    date: daysAgo(20),
    fromAccount: 'Everyday Checking',
    toAccount: 'Emergency Savings',
    fromAmount: -40000,
    toAmount: 40000,
  },
  {
    item: 'Travel cash top-up',
    date: daysAgo(43),
    fromAccount: 'Everyday Checking',
    toAccount: 'Travel Cash',
    fromAmount: -20000,
    toAmount: 18500,
  },
  {
    item: 'Card payment',
    date: daysAgo(8),
    fromAccount: 'Everyday Checking',
    toAccount: 'Everyday Card',
    fromAmount: -15000,
    toAmount: 15000,
  },
]);

function insertMarker() {
  return `INSERT INTO settings (key, value)
SELECT ${sqlString(DEMO_SEED_MARKER_KEY)}, ${sqlString(DEMO_SEED_MARKER_VALUE)}
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ${sqlString(DEMO_SEED_MARKER_KEY)})
  AND (SELECT COUNT(*) FROM accounts) = 0
  AND (SELECT COUNT(*) FROM operations) = 0;`;
}

function insertFxRate({ code, rate_e9 }) {
  return `INSERT INTO fx_rates (code, rate_e9, updated_at)
SELECT ${sqlString(code)}, ${rate_e9}, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE ${SEED_GUARD}
  AND NOT EXISTS (SELECT 1 FROM fx_rates WHERE code = ${sqlString(code)});`;
}

function insertAccount(account, { first = false } = {}) {
  const emptyGuard = first
    ? 'AND NOT EXISTS (SELECT 1 FROM accounts)'
    : `AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = ${sqlString(account.name)} AND owner = ${sqlString(account.owner)})`;
  return `INSERT INTO accounts (
  name, bank, type, owner, country, currency, balance_minor, balance_updated_at, sort
)
SELECT
  ${sqlString(account.name)},
  ${sqlValue(account.bank)},
  ${sqlString(account.type)},
  ${sqlString(account.owner)},
  ${sqlString(account.country)},
  ${sqlString(account.currency)},
  ${account.balance_minor},
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  ${account.sort}
WHERE ${SEED_GUARD}
  ${emptyGuard};`;
}

function operationExistsClause(op) {
  const storeClause =
    op.store == null ? 'store IS NULL' : `store = ${sqlString(op.store)}`;
  return `NOT EXISTS (
    SELECT 1 FROM operations
    WHERE item = ${sqlString(op.item)}
      AND date = ${sqlValue(op.date)}
      AND ${storeClause}
  )`;
}

function insertOperation(op, { first = false } = {}) {
  const extraGuard = first
    ? 'AND NOT EXISTS (SELECT 1 FROM operations)'
    : `AND ${operationExistsClause(op)}`;
  return `INSERT INTO operations (
  date, account_id, kind, store, item, category, subcategory, amount_minor,
  source, comment, receipt_url, fiscal_receipt_id
)
SELECT
  ${sqlValue(op.date)},
  a.id,
  ${sqlString(op.kind)},
  ${sqlValue(op.store)},
  ${sqlString(op.item)},
  ${sqlValue(op.category)},
  ${sqlValue(op.subcategory)},
  ${op.amount_minor},
  ${sqlString(op.source)},
  ${sqlValue(op.comment ?? null)},
  ${sqlValue(op.receipt_url ?? null)},
  ${sqlValue(op.fiscal_receipt_id ?? null)}
${accountRef(op.account)}
  AND ${SEED_GUARD}
  ${extraGuard};`;
}

function insertPlanned(item) {
  return `INSERT INTO planned_items (
  date, title, amount_minor, currency, account_id, category, done
)
SELECT
  ${sqlValue(item.date)},
  ${sqlString(item.title)},
  ${item.amount_minor},
  ${sqlString(item.currency)},
  a.id,
  ${sqlValue(item.category)},
  ${item.done}
${accountRef(item.account)}
  AND ${SEED_GUARD}
  AND NOT EXISTS (
    SELECT 1 FROM planned_items
    WHERE title = ${sqlString(item.title)} AND account_id = a.id
  );`;
}

function insertFulfilledPlanned({ title, item, store, category, subcategory }) {
  return `INSERT INTO operations (
  date, account_id, kind, store, item, category, subcategory, amount_minor,
  source, planned_item_id
)
SELECT
  p.date,
  p.account_id,
  'expense',
  ${sqlValue(store)},
  ${sqlString(item)},
  ${sqlValue(category)},
  ${sqlValue(subcategory)},
  p.amount_minor,
  'planned',
  p.id
FROM planned_items p
JOIN accounts a ON a.id = p.account_id
WHERE p.title = ${sqlString(title)}
  AND a.owner = 'Household'
  AND ${SEED_GUARD}
  AND NOT EXISTS (
    SELECT 1 FROM operations WHERE planned_item_id = p.id
  );`;
}

function insertRecurring(item) {
  return `INSERT INTO recurring_items (
  title, amount_minor, currency, account_id, category, frequency, interval_count,
  day_of_month, month_of_year, next_due_date, active
)
SELECT
  ${sqlString(item.title)},
  ${item.amount_minor},
  ${sqlString(item.currency)},
  a.id,
  ${sqlValue(item.category)},
  ${sqlString(item.frequency)},
  ${item.interval_count},
  ${sqlValue(item.day_of_month)},
  ${sqlValue(item.month_of_year)},
  ${sqlValue(item.next_due_date)},
  ${item.active}
${accountRef(item.account)}
  AND ${SEED_GUARD}
  AND NOT EXISTS (
    SELECT 1 FROM recurring_items
    WHERE title = ${sqlString(item.title)} AND account_id = a.id
  );`;
}

function insertFulfilledRecurring({ title, date, store, item, category, subcategory, amount_minor }) {
  return `INSERT INTO operations (
  date, account_id, kind, store, item, category, subcategory, amount_minor,
  source, recurring_item_id
)
SELECT
  ${sqlValue(date)},
  r.account_id,
  'expense',
  ${sqlValue(store)},
  ${sqlString(item)},
  ${sqlValue(category)},
  ${sqlValue(subcategory)},
  ${amount_minor},
  'recurring',
  r.id
FROM recurring_items r
JOIN accounts a ON a.id = r.account_id
WHERE r.title = ${sqlString(title)}
  AND a.owner = 'Household'
  AND ${SEED_GUARD}
  AND NOT EXISTS (
    SELECT 1 FROM operations
    WHERE recurring_item_id = r.id AND date = ${sqlValue(date)}
  );`;
}

function insertTransfer(transfer) {
  const outItem = transfer.item;
  const inItem = `${transfer.item} (in)`;
  return [
    `INSERT INTO transfers
SELECT NULL
WHERE ${SEED_GUARD}
  AND NOT EXISTS (
    SELECT 1 FROM operations
    WHERE item = ${sqlString(outItem)} AND kind = 'transfer_out'
  );`,
    `INSERT INTO operations (
  date, account_id, kind, store, item, category, subcategory, amount_minor,
  source, transfer_id
)
SELECT
  ${sqlValue(transfer.date)},
  a.id,
  'transfer_out',
  NULL,
  ${sqlString(outItem)},
  'Transfers',
  NULL,
  ${transfer.fromAmount},
  'manual',
  (SELECT MAX(id) FROM transfers)
${accountRef(transfer.fromAccount)}
  AND ${SEED_GUARD}
  AND NOT EXISTS (
    SELECT 1 FROM operations
    WHERE item = ${sqlString(outItem)} AND kind = 'transfer_out'
  );`,
    `INSERT INTO operations (
  date, account_id, kind, store, item, category, subcategory, amount_minor,
  source, transfer_id
)
SELECT
  ${sqlValue(transfer.date)},
  a.id,
  'transfer_in',
  NULL,
  ${sqlString(inItem)},
  'Transfers',
  NULL,
  ${transfer.toAmount},
  'manual',
  (SELECT MAX(id) FROM transfers)
${accountRef(transfer.toAccount)}
  AND ${SEED_GUARD}
  AND NOT EXISTS (
    SELECT 1 FROM operations
    WHERE item = ${sqlString(inItem)} AND kind = 'transfer_in'
  );`,
  ];
}

/**
 * @returns {string[]}
 */
export function buildDemoSeedStatements() {
  const statements = [
    insertMarker(),
    ...DEMO_FX_RATES.map(insertFxRate),
    ...DEMO_ACCOUNTS.map((account, index) => insertAccount(account, { first: index === 0 })),
    ...DEMO_OPERATIONS.map((operation, index) => insertOperation(operation, { first: index === 0 })),
    ...DEMO_PLANNED.map(insertPlanned),
    insertFulfilledPlanned({
      title: 'Hallway lamp',
      item: 'Hallway lamp',
      store: 'Harbor Home',
      category: 'Home',
      subcategory: null,
    }),
    ...DEMO_RECURRING.map(insertRecurring),
    insertFulfilledRecurring({
      title: 'Streamline Internet',
      date: daysAgo(19),
      store: 'Streamline Internet',
      item: 'Monthly internet',
      category: 'Utilities',
      subcategory: null,
      amount_minor: -6500,
    }),
  ];

  for (const transfer of DEMO_TRANSFERS) {
    statements.push(...insertTransfer(transfer));
  }

  return statements;
}

export function buildDemoSeedSql() {
  const header = [
    '-- Stranger-safe product showcase for `npm run setup -- --seed-demo`.',
    '-- Fake English household only. Applied when the instance is still empty.',
    '-- D1 remote rejects a multi-arm compound SELECT ("too many terms"),',
    '-- so each row is its own INSERT…SELECT.',
    '-- Generated by scripts/lib/cloudflare-setup/seed-demo-sql.mjs — edit that',
    '-- module and regenerate this file; do not use compound SELECT arms.',
    '-- Pulse Warnings coverage: Everyday Card already negative (household',
    '-- total stays positive); Travel Cash reaches zero soon; Sterling Current',
    '-- (and UK/GBP) go negative later. City rent is recurring only.',
    '',
  ].join('\n');
  return `${header}\n${buildDemoSeedStatements().join('\n\n')}\n`;
}
