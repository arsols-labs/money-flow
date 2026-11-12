-- Manual receipt groups. Forward-only and additive.
--
-- purchase_orders stays the only grouping record. kind='manual' is a receipt
-- group; existing rows stay kind='provider'. No backfill of groups.
--
-- operations.receipt_identity_token is metadata for a receipt that has no
-- PFR. It is nullable so a previous Worker can still insert an operation.
-- The token is deleted with that row. A reused operations.id therefore cannot
-- satisfy an old op:<token> key. No token is written for existing rows here.
--
-- receipt_membership is the shared claim for a fiscal document or a token.
-- purchase_order_components remains the provider-order component list. Both
-- paths check both stores. The only foreign key added here points at
-- purchase_orders and cascades, so deleting an order removes its claims.
--
-- receipt_group_requests keeps an idempotency result until reset or a backup
-- replace. There is no expiry: a replay must not look like a new request.

ALTER TABLE operations ADD COLUMN receipt_identity_token TEXT
  CHECK (
    receipt_identity_token IS NULL
    OR (
      length(receipt_identity_token) = 36
      AND receipt_identity_token = lower(receipt_identity_token)
      AND substr(receipt_identity_token, 9, 1) = '-'
      AND substr(receipt_identity_token, 14, 1) = '-'
      AND substr(receipt_identity_token, 19, 1) = '-'
      AND substr(receipt_identity_token, 24, 1) = '-'
    )
  );

CREATE UNIQUE INDEX idx_operations_receipt_identity_token
  ON operations (receipt_identity_token)
  WHERE receipt_identity_token IS NOT NULL;

ALTER TABLE purchase_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'provider'
  CHECK (kind IN ('provider', 'manual'));

ALTER TABLE purchase_orders ADD COLUMN display_name TEXT
  CHECK (
    display_name IS NULL
    OR (
      length(display_name) BETWEEN 1 AND 120
      AND display_name = trim(display_name)
    )
  );

CREATE TABLE receipt_membership (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  receipt_key TEXT NOT NULL CHECK (
    length(receipt_key) BETWEEN 4 AND 170
    AND (
      (
        substr(receipt_key, 1, 4) = 'pfr:'
        AND length(receipt_key) > 4
      )
      OR (
        substr(receipt_key, 1, 3) = 'op:'
        AND length(receipt_key) = 39
      )
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
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  ),
  UNIQUE (receipt_key)
);

CREATE INDEX idx_receipt_membership_order ON receipt_membership (order_id);

CREATE TABLE receipt_group_requests (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key = trim(idempotency_key)
  ),
  operation TEXT NOT NULL CHECK (operation IN ('create', 'unlink', 'delete')),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
  ),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 200 AND 201),
  response_json TEXT NOT NULL CHECK (length(response_json) BETWEEN 2 AND 200000),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  )
);
