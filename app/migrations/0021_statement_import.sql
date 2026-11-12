-- Statement import: category rules, import batches, and provenance on operations.
--
-- Forward-only. SQLite cannot add a FOREIGN KEY or a new CHECK value with
-- ALTER TABLE, so `import_batch_id` is a nullable integer without a schema
-- foreign key. The import API writes it only for a batch row created in the
-- same transaction. Imported operations keep source = 'manual': the owner
-- confirms the preview, and `import_batch_id` is the provenance.
--
-- `bank_transaction_id` is the bank's own id when the file has one (OFX FITID,
-- CAMT AcctSvcrRef or EndToEndId, CSV reference). `import_fingerprint` is the
-- stable per-row identity used for idempotent replay. Both are NULL on rows
-- that were not created by statement import.

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  category_mode TEXT NOT NULL CHECK (category_mode IN ('manual', 'rules')),
  status TEXT NOT NULL CHECK (status IN ('committed', 'undone')),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  ),
  undone_at TEXT CHECK (
    undone_at IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%SZ', undone_at) IS NOT NULL
      AND undone_at = strftime('%Y-%m-%dT%H:%M:%SZ', undone_at)
      AND undone_at >= '0001-01-01'
      AND substr(undone_at, 12, 2) <= '23'
    )
  ),
  CONSTRAINT import_batches_undo_matches_status CHECK (
    (status = 'committed' AND undone_at IS NULL)
    OR (status = 'undone' AND undone_at IS NOT NULL)
  )
);

CREATE INDEX idx_import_batches_created_at ON import_batches (created_at DESC);

CREATE TABLE category_rules (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL CHECK (length(trim(pattern)) BETWEEN 1 AND 200),
  match_field TEXT NOT NULL CHECK (match_field IN ('merchant', 'description', 'any')),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 200),
  subcategory TEXT CHECK (subcategory IS NULL OR length(trim(subcategory)) BETWEEN 1 AND 200),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000000),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  )
);

CREATE INDEX idx_category_rules_priority ON category_rules (priority, id);

ALTER TABLE operations ADD COLUMN import_batch_id INTEGER;
ALTER TABLE operations ADD COLUMN bank_transaction_id TEXT;
ALTER TABLE operations ADD COLUMN import_fingerprint TEXT;

CREATE INDEX idx_operations_import_batch_id
  ON operations (import_batch_id) WHERE import_batch_id IS NOT NULL;

CREATE UNIQUE INDEX idx_operations_import_fingerprint
  ON operations (import_fingerprint) WHERE import_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX idx_operations_bank_transaction_id
  ON operations (account_id, bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
