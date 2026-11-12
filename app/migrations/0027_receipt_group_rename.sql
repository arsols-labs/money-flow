-- Allow a rename idempotency row. Forward-only.
--
-- receipt_group_requests.operation was limited to create, unlink, and delete.
-- SQLite cannot alter that CHECK, so the table is rebuilt with rename added.
-- Existing rows are copied first. The previous Worker only writes the three
-- original operations, which remain valid. No receipt, balance, or amount changes.

CREATE TABLE receipt_group_requests_v2 (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key = trim(idempotency_key)
  ),
  operation TEXT NOT NULL CHECK (operation IN ('create', 'unlink', 'delete', 'rename')),
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

INSERT INTO receipt_group_requests_v2 (
  idempotency_key, operation, request_hash, status_code, response_json, created_at
)
SELECT idempotency_key, operation, request_hash, status_code, response_json, created_at
FROM receipt_group_requests;

DROP TABLE receipt_group_requests;

ALTER TABLE receipt_group_requests_v2 RENAME TO receipt_group_requests;
