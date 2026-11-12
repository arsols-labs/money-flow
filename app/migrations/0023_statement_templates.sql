-- User statement templates. Built-in bank templates stay in the application
-- bundle and are not copied here. Forward-only and additive: no change to
-- tables that already exist.
--
-- `document` is the schema-validated template JSON. `template_id` is the id
-- inside that document and the public key used by the API.

CREATE TABLE statement_templates (
  id INTEGER PRIMARY KEY,
  template_id TEXT NOT NULL UNIQUE CHECK (
    length(template_id) BETWEEN 1 AND 64
    AND template_id = lower(template_id)
  ),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  format TEXT NOT NULL CHECK (format IN ('csv', 'xls', 'ofx', 'pdf')),
  document TEXT NOT NULL CHECK (length(document) BETWEEN 2 AND 32768),
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
  )
);

CREATE INDEX idx_statement_templates_updated_at ON statement_templates (updated_at DESC, id DESC);
