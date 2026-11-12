-- MCP provenance for user statement templates, and one-time upload slots.
-- Forward-only and additive. Templates saved before this migration have
-- created_via NULL, so an MCP update still needs a human confirmation.
-- Upload bytes are temporary and are not part of backup.

ALTER TABLE statement_templates ADD COLUMN created_via TEXT
  CHECK (created_via IS NULL OR created_via IN ('api', 'mcp', 'backup'));

ALTER TABLE statement_templates ADD COLUMN created_by_client_id TEXT
  CHECK (
    created_by_client_id IS NULL
    OR length(created_by_client_id) BETWEEN 1 AND 200
  );

ALTER TABLE statement_templates ADD COLUMN used_batch_id INTEGER
  CHECK (used_batch_id IS NULL OR used_batch_id > 0);

CREATE INDEX idx_statement_templates_used_batch
  ON statement_templates (used_batch_id)
  WHERE used_batch_id IS NOT NULL;

CREATE TABLE statement_import_uploads (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  content_base64 TEXT,
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) IS NOT NULL
    AND expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', expires_at)
    AND expires_at >= '0001-01-01'
    AND substr(expires_at, 12, 2) <= '23'
  ),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  ),
  CONSTRAINT statement_import_uploads_body CHECK (
    (content_base64 IS NULL AND byte_length IS NULL)
    OR (content_base64 IS NOT NULL AND byte_length IS NOT NULL)
  )
);

CREATE INDEX idx_statement_import_uploads_expires
  ON statement_import_uploads (expires_at);
