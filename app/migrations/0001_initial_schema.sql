-- Money Flow v2 — initial schema (public baseline).
-- End-state shape matching private migrations 0001–0020 on production D1.
-- Conventions:
--   * Surrogate IDs are INTEGER PRIMARY KEY (rowid), except natural keys
--     on fx_rates (currency code) and settings (key name).
--   * Money is INTEGER minor units; column names use the `_minor` suffix.
--   * Calendar dates are TEXT 'YYYY-MM-DD'; instants are TEXT ISO-8601 UTC
--     'YYYY-MM-DDTHH:MM:SSZ' (second precision — milliseconds are rejected).
--   * No triggers; invariants are CHECK and FOREIGN KEY only.
-- SQLite/D1 CHECK notes:
--   * NULL inside CHECK is treated as satisfied, so function results are
--     paired with explicit IS NOT NULL.
--   * Year zero round-trips through date(); lower bound is >= '0001-01-01'.
--   * Hour 24 is not normalized by strftime; each instant CHECK bounds hour <= '23'.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
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
);

CREATE INDEX idx_accounts_archived_sort ON accounts (archived, sort);

-- ---------------------------------------------------------------------------
-- fx_rates — manual rates vs base currency; usd_per_unit = rate_e9 / 1e9
-- ---------------------------------------------------------------------------
CREATE TABLE fx_rates (
  code TEXT PRIMARY KEY CHECK (code GLOB '[A-Z][A-Z][A-Z]'),
  rate_e9 INTEGER NOT NULL CHECK (rate_e9 > 0),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) IS NOT NULL
    AND updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at)
    AND updated_at >= '0001-01-01'
    AND substr(updated_at, 12, 2) <= '23'
  )
);

-- ---------------------------------------------------------------------------
-- settings — key/value app config
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('base_currency', 'USD'),
  ('low_balance_threshold_minor', '100000');

-- ---------------------------------------------------------------------------
-- planned_items
-- ---------------------------------------------------------------------------
CREATE TABLE planned_items (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL CHECK (
    date(date) IS NOT NULL AND date = date(date) AND date >= '0001-01-01'
  ),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  category TEXT,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  -- Optimistic concurrency token (nullable; app fills on write).
  revision TEXT
);

CREATE INDEX idx_planned_items_account_id ON planned_items (account_id);
CREATE INDEX idx_planned_items_date ON planned_items (date);

-- ---------------------------------------------------------------------------
-- recurring_items
-- ---------------------------------------------------------------------------
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
  -- Optimistic concurrency token (nullable; app fills on write).
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
);

CREATE INDEX idx_recurring_items_account_id ON recurring_items (account_id);
CREATE INDEX idx_recurring_items_next_due_date
  ON recurring_items (next_due_date) WHERE active = 1;

-- ---------------------------------------------------------------------------
-- receipts — uploaded receipt files (R2 object + parse status)
-- ---------------------------------------------------------------------------
CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE CHECK (length(trim(r2_key)) > 0),
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'parsed', 'confirmed')),
  parsed_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  )
);

CREATE INDEX idx_receipts_created_at ON receipts (created_at DESC);
CREATE INDEX idx_receipts_status ON receipts (status);

-- ---------------------------------------------------------------------------
-- transfers — pairs transfer_out / transfer_in operations
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
  id INTEGER PRIMARY KEY
);

-- ---------------------------------------------------------------------------
-- operations — ledger (replaces legacy expenses)
-- ---------------------------------------------------------------------------
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
);

CREATE INDEX idx_operations_date ON operations (date DESC);
CREATE INDEX idx_operations_category ON operations (category);
CREATE INDEX idx_operations_account_id ON operations (account_id);
CREATE INDEX idx_operations_receipt_id ON operations (receipt_id);
CREATE INDEX idx_operations_fiscal_receipt_id
  ON operations (fiscal_receipt_id) WHERE fiscal_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX idx_operations_planned_item_id
  ON operations (planned_item_id) WHERE planned_item_id IS NOT NULL;
CREATE INDEX idx_operations_recurring_item_id
  ON operations (recurring_item_id) WHERE recurring_item_id IS NOT NULL;
CREATE INDEX idx_operations_transfer_id
  ON operations (transfer_id) WHERE transfer_id IS NOT NULL;
-- Composite unique parent key for fulfillment FKs that reference
-- (operation id, recurring_item_id) together.
CREATE UNIQUE INDEX idx_operations_id_recurring_item_id
  ON operations (id, recurring_item_id);

-- ---------------------------------------------------------------------------
-- oauth_* — machine-client OAuth 2.1 (MCP)
-- Timestamps use SQLite datetime('now') defaults (not ISO CHECK), matching prod.
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata_document_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE oauth_consents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
);

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_used_at TEXT,
  last_ip TEXT,
  last_country TEXT,
  revoked_at TEXT,
  FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
);

CREATE INDEX idx_oauth_consents_client_id ON oauth_consents (client_id);
CREATE INDEX idx_oauth_tokens_client_id ON oauth_tokens (client_id);

-- ---------------------------------------------------------------------------
-- mcp_audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_audit_log (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT,
  FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_audit_log_client_id ON mcp_audit_log (client_id);
CREATE INDEX idx_mcp_audit_log_created_at ON mcp_audit_log (created_at DESC);
CREATE UNIQUE INDEX idx_mcp_audit_log_idempotency
  ON mcp_audit_log (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- account_aliases / pending_account_strings — receipt account string resolution
-- ---------------------------------------------------------------------------
CREATE TABLE account_aliases (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  alias_text TEXT NOT NULL CHECK (length(trim(alias_text)) > 0),
  alias_norm TEXT NOT NULL CHECK (length(trim(alias_norm)) > 0),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  ),
  UNIQUE (alias_norm)
);

CREATE INDEX idx_account_aliases_account_id ON account_aliases (account_id);
CREATE INDEX idx_account_aliases_alias_norm ON account_aliases (alias_norm);

CREATE TABLE pending_account_strings (
  id INTEGER PRIMARY KEY,
  raw_string TEXT NOT NULL CHECK (length(trim(raw_string)) > 0),
  raw_norm TEXT NOT NULL CHECK (length(trim(raw_norm)) > 0),
  first_seen_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', first_seen_at) IS NOT NULL
    AND first_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', first_seen_at)
    AND first_seen_at >= '0001-01-01'
    AND substr(first_seen_at, 12, 2) <= '23'
  ),
  UNIQUE (raw_norm)
);

CREATE UNIQUE INDEX idx_pending_account_strings_raw_norm
  ON pending_account_strings (raw_norm);

-- ---------------------------------------------------------------------------
-- imported_receipt_items — idempotency tracker for historical sheet import
-- ---------------------------------------------------------------------------
CREATE TABLE imported_receipt_items (
  id INTEGER PRIMARY KEY,
  receipt_id TEXT NOT NULL CHECK (length(trim(receipt_id)) > 0),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  operation_id INTEGER NOT NULL REFERENCES operations (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  imported_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', imported_at) IS NOT NULL
    AND imported_at = strftime('%Y-%m-%dT%H:%M:%SZ', imported_at)
    AND imported_at >= '0001-01-01'
    AND substr(imported_at, 12, 2) <= '23'
  ),
  UNIQUE (receipt_id, line_no)
);

CREATE INDEX idx_imported_receipt_items_acct ON imported_receipt_items (account_id);
CREATE INDEX idx_imported_receipt_items_op ON imported_receipt_items (operation_id);

-- ---------------------------------------------------------------------------
-- recurring_period_fulfillments + operation_fulfillment_links
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_period_fulfillments (
  recurring_item_id INTEGER NOT NULL REFERENCES recurring_items (id) ON DELETE CASCADE,
  period_due_date TEXT NOT NULL CHECK (
    date(period_due_date) IS NOT NULL
    AND period_due_date = date(period_due_date)
    AND period_due_date >= '0001-01-01'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('materialized', 'linked', 'skipped')),
  evidence_quantity INTEGER NOT NULL DEFAULT 1 CHECK (
    evidence_quantity BETWEEN 1 AND 100
  ),
  fulfilled_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', fulfilled_at) IS NOT NULL
    AND fulfilled_at = strftime('%Y-%m-%dT%H:%M:%SZ', fulfilled_at)
    AND fulfilled_at >= '0001-01-01'
    AND substr(fulfilled_at, 12, 2) <= '23'
  ),
  PRIMARY KEY (recurring_item_id, period_due_date),
  UNIQUE (recurring_item_id, period_due_date, outcome)
);

CREATE TABLE operation_fulfillment_links (
  operation_id INTEGER PRIMARY KEY REFERENCES operations (id) ON DELETE RESTRICT,
  planned_item_id INTEGER REFERENCES planned_items (id) ON DELETE CASCADE,
  recurring_item_id INTEGER,
  period_due_date TEXT,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('materialized', 'linked')),
  linked_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', linked_at) IS NOT NULL
    AND linked_at = strftime('%Y-%m-%dT%H:%M:%SZ', linked_at)
    AND linked_at >= '0001-01-01'
    AND substr(linked_at, 12, 2) <= '23'
  ),
  CONSTRAINT operation_fulfillment_exactly_one_target CHECK (
    (planned_item_id IS NOT NULL AND recurring_item_id IS NULL AND period_due_date IS NULL)
    OR (planned_item_id IS NULL AND recurring_item_id IS NOT NULL AND period_due_date IS NOT NULL)
  ),
  FOREIGN KEY (recurring_item_id, period_due_date, fulfillment_type)
    REFERENCES recurring_period_fulfillments (recurring_item_id, period_due_date, outcome)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_operation_fulfillment_planned_item
  ON operation_fulfillment_links (planned_item_id)
  WHERE planned_item_id IS NOT NULL;

CREATE INDEX idx_operation_fulfillment_recurring_period
  ON operation_fulfillment_links (recurring_item_id, period_due_date)
  WHERE recurring_item_id IS NOT NULL;
