-- Purchase-order grouping. Forward-only and additive.
-- No ALTER, DROP, or UPDATE of existing tables.
-- No foreign key into operations, accounts, or any older table: a v2.35
-- Worker must still DELETE those tables. The only foreign key is inside
-- this pair (component -> order, ON DELETE CASCADE).
--
-- Operation-id links are not stored. operations.id is not AUTOINCREMENT, so
-- SQLite reuses max(rowid)+1 after the newest row is deleted, and a v2.35
-- delete does not rotate purchase_orders_epoch. A fingerprint of date,
-- account, kind, amount, and currency therefore cannot tell the old row
-- from a new row with the same id. v2.36 links fiscal documents by
-- canonical PFR only.

CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (
    length(provider) BETWEEN 1 AND 40
    AND provider NOT GLOB '*[^a-z0-9_-]*'
  ),
  provider_order_id TEXT NOT NULL CHECK (
    length(provider_order_id) BETWEEN 1 AND 128
    AND provider_order_id = trim(provider_order_id)
  ),
  order_date TEXT CHECK (
    order_date IS NULL
    OR (date(order_date) IS NOT NULL AND order_date = date(order_date))
  ),
  order_total_minor INTEGER CHECK (order_total_minor IS NULL OR order_total_minor >= 0),
  order_total_currency TEXT CHECK (
    order_total_currency IS NULL OR order_total_currency GLOB '[A-Z][A-Z][A-Z]'
  ),
  order_total_source TEXT CHECK (
    order_total_source IS NULL
    OR order_total_source IN ('provider_document', 'fiscal_document')
  ),
  order_total_reference TEXT CHECK (
    order_total_reference IS NULL OR length(order_total_reference) <= 200
  ),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_via TEXT NOT NULL CHECK (created_via IN ('api', 'mcp', 'backup')),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  ),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) IS NOT NULL
    AND updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at)
    AND updated_at >= '0001-01-01'
    AND substr(updated_at, 12, 2) <= '23'
  ),
  CONSTRAINT po_total_complete CHECK (
    (
      order_total_minor IS NULL
      AND order_total_currency IS NULL
      AND order_total_source IS NULL
    )
    OR (
      order_total_minor IS NOT NULL
      AND order_total_currency IS NOT NULL
      AND order_total_source IS NOT NULL
    )
  ),
  UNIQUE (provider, provider_order_id)
);

CREATE TABLE purchase_order_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  component_type TEXT NOT NULL CHECK (component_type IN (
    'goods', 'service_fee', 'delivery_fee', 'tip', 'discount', 'refund', 'other'
  )),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('pfr', 'expected')),
  pfr_canonical TEXT CHECK (
    pfr_canonical IS NULL
    OR (
      length(pfr_canonical) BETWEEN 1 AND 128
      AND pfr_canonical = upper(pfr_canonical)
      AND pfr_canonical = trim(pfr_canonical)
      AND instr(pfr_canonical, '  ') = 0
    )
  ),
  ledger_epoch TEXT NOT NULL CHECK (
    length(ledger_epoch) = 36
    AND ledger_epoch = lower(ledger_epoch)
    AND substr(ledger_epoch, 9, 1) = '-'
    AND substr(ledger_epoch, 14, 1) = '-'
    AND substr(ledger_epoch, 19, 1) = '-'
    AND substr(ledger_epoch, 24, 1) = '-'
  ),
  expected_amount_minor INTEGER,
  expected_currency TEXT CHECK (
    expected_currency IS NULL OR expected_currency GLOB '[A-Z][A-Z][A-Z]'
  ),
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  ),
  CONSTRAINT poc_target_shape CHECK (
    (
      target_kind = 'pfr'
      AND pfr_canonical IS NOT NULL
      AND expected_amount_minor IS NULL
      AND expected_currency IS NULL
    )
    OR (
      target_kind = 'expected'
      AND pfr_canonical IS NULL
      AND expected_amount_minor IS NOT NULL
      AND expected_currency IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX idx_poc_pfr
  ON purchase_order_components (pfr_canonical)
  WHERE pfr_canonical IS NOT NULL;

CREATE INDEX idx_poc_order ON purchase_order_components (order_id);
