-- Country-scoped, versioned rules, reference standards, formats, templates,
-- PDF layouts, and recurring policy bindings.
--
-- Schema-only migration: NO shipped business lists, rules, standards, or
-- templates are inserted here. Fresh installs start empty of business data.
-- Existing user-authored rows in `category_rules` and `statement_templates` are
-- preserved into active SHARED v1 sets only when present on upgrade.

CREATE TABLE rule_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL CHECK (
    domain IN (
      'currency_standards',
      'fiscal_formats',
      'merchant_aliases',
      'delivery_services',
      'venue_suffixes',
      'order_hints',
      'category_rules',
      'statement_templates',
      'pdf_layouts'
    )
  ),
  scope_country TEXT NOT NULL CHECK (
    length(trim(scope_country)) BETWEEN 1 AND 32
    AND scope_country = upper(trim(scope_country))
  ),
  scope_locale TEXT NOT NULL DEFAULT '' CHECK (
    scope_locale IN ('', 'en', 'ru', 'de', 'fr', 'es', 'pt', 'sr')
  ),
  set_key TEXT NOT NULL CHECK (
    length(trim(set_key)) BETWEEN 1 AND 80
    AND set_key = lower(trim(set_key))
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'retired')),
  effective_from TEXT CHECK (
    effective_from IS NULL
    OR (
      date(effective_from) IS NOT NULL
      AND effective_from = date(effective_from)
      AND effective_from >= '0001-01-01'
    )
  ),
  effective_to TEXT CHECK (
    effective_to IS NULL
    OR (
      date(effective_to) IS NOT NULL
      AND effective_to = date(effective_to)
      AND effective_to >= '0001-01-01'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000000),
  allow_shared_fallback INTEGER NOT NULL DEFAULT 1 CHECK (allow_shared_fallback IN (0, 1)),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  provenance_source TEXT NOT NULL CHECK (
    provenance_source IN ('api', 'mcp', 'backup', 'ui', 'import')
  ),
  provenance_actor TEXT CHECK (provenance_actor IS NULL OR length(provenance_actor) <= 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  activated_at TEXT CHECK (
    activated_at IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%SZ', activated_at) IS NOT NULL
      AND activated_at = strftime('%Y-%m-%dT%H:%M:%SZ', activated_at)
      AND activated_at >= '0001-01-01'
      AND substr(activated_at, 12, 2) <= '23'
    )
  ),
  retired_at TEXT CHECK (
    retired_at IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%SZ', retired_at) IS NOT NULL
      AND retired_at = strftime('%Y-%m-%dT%H:%M:%SZ', retired_at)
      AND retired_at >= '0001-01-01'
      AND substr(retired_at, 12, 2) <= '23'
    )
  ),
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
  CONSTRAINT rule_sets_dates_order CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to
  ),
  UNIQUE (domain, scope_country, scope_locale, set_key, version)
);

CREATE INDEX idx_rule_sets_lookup
  ON rule_sets (domain, state, scope_country, scope_locale, priority, version);

CREATE TABLE rule_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_set_id INTEGER NOT NULL REFERENCES rule_sets (id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL CHECK (length(trim(entry_key)) BETWEEN 1 AND 128),
  match_type TEXT CHECK (
    match_type IS NULL
    OR match_type IN (
      'exact',
      'prefix',
      'suffix',
      'contains',
      'tokens',
      'regex_safe',
      'url_host',
      'layout',
      'template',
      'schema_entry'
    )
  ),
  match_field TEXT CHECK (
    match_field IS NULL
    OR match_field IN (
      'merchant',
      'description',
      'store',
      'any',
      'url',
      'text',
      'pfr',
      'code',
      'locale_key'
    )
  ),
  pattern TEXT CHECK (pattern IS NULL OR length(pattern) BETWEEN 1 AND 512),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 65536),
  meta_json TEXT CHECK (meta_json IS NULL OR length(meta_json) <= 4096),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
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
  UNIQUE (rule_set_id, entry_key)
);

CREATE INDEX idx_rule_entries_set_priority
  ON rule_entries (rule_set_id, enabled, priority, id);

CREATE TABLE recurring_policy_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recurring_item_id INTEGER NOT NULL REFERENCES recurring_items (id) ON DELETE CASCADE,
  policy_type TEXT NOT NULL CHECK (policy_type IN ('analytical_skip_only')),
  scope_country TEXT NOT NULL DEFAULT 'SHARED' CHECK (
    length(trim(scope_country)) BETWEEN 1 AND 32
    AND scope_country = upper(trim(scope_country))
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'retired')),
  effective_from TEXT CHECK (
    effective_from IS NULL
    OR (
      date(effective_from) IS NOT NULL
      AND effective_from = date(effective_from)
      AND effective_from >= '0001-01-01'
    )
  ),
  effective_to TEXT CHECK (
    effective_to IS NULL
    OR (
      date(effective_to) IS NOT NULL
      AND effective_to = date(effective_to)
      AND effective_to >= '0001-01-01'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000000),
  provenance_source TEXT NOT NULL CHECK (
    provenance_source IN ('api', 'mcp', 'backup', 'ui', 'import')
  ),
  provenance_actor TEXT CHECK (provenance_actor IS NULL OR length(provenance_actor) <= 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
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
  CONSTRAINT recurring_policy_dates_order CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to
  ),
  UNIQUE (recurring_item_id, policy_type, scope_country, version)
);

CREATE INDEX idx_recurring_policy_active
  ON recurring_policy_bindings (policy_type, state, scope_country, priority, version);

CREATE TABLE rule_config_mutations (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key = trim(idempotency_key)
  ),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 80),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
  ),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 200 AND 299),
  response_json TEXT NOT NULL CHECK (length(response_json) BETWEEN 2 AND 200000),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
    AND created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at)
    AND created_at >= '0001-01-01'
    AND substr(created_at, 12, 2) <= '23'
  )
);

-- Preserve pre-existing user-authored statement templates if any exist on upgrade.
INSERT INTO rule_sets (
  domain, scope_country, scope_locale, set_key, version, state,
  priority, allow_shared_fallback, label, description,
  provenance_source, provenance_actor, revision,
  activated_at, created_at, updated_at
)
SELECT
  'statement_templates', 'SHARED', '', 'migrated-user-templates', 1, 'active',
  100, 1, 'Migrated user statement templates', 'Preserved user templates from statement_templates',
  'import', NULL, 1,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM statement_templates);

INSERT INTO rule_entries (
  rule_set_id, entry_key, match_type, match_field, pattern, priority, enabled,
  payload_json, meta_json, revision, created_at, updated_at
)
SELECT
  (SELECT id FROM rule_sets
   WHERE domain = 'statement_templates'
     AND scope_country = 'SHARED'
     AND scope_locale = ''
     AND set_key = 'migrated-user-templates'
     AND version = 1),
  template_id,
  'template',
  NULL,
  NULL,
  100,
  1,
  document,
  json_object(
    'created_via', created_via,
    'created_by_client_id', created_by_client_id,
    'used_batch_id', used_batch_id
  ),
  1,
  created_at,
  updated_at
FROM statement_templates;

-- Preserve pre-existing user-authored category rules if any exist on upgrade.
INSERT INTO rule_sets (
  domain, scope_country, scope_locale, set_key, version, state,
  priority, allow_shared_fallback, label, description,
  provenance_source, provenance_actor, revision,
  activated_at, created_at, updated_at
)
SELECT
  'category_rules', 'SHARED', '', 'migrated-category-rules', 1, 'active',
  100, 1, 'Migrated user category rules', 'Preserved user rules from category_rules',
  'import', NULL, 1,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM category_rules);

INSERT INTO rule_entries (
  rule_set_id, entry_key, match_type, match_field, pattern, priority, enabled,
  payload_json, meta_json, revision, created_at, updated_at
)
SELECT
  (SELECT id FROM rule_sets
   WHERE domain = 'category_rules'
     AND scope_country = 'SHARED'
     AND scope_locale = ''
     AND set_key = 'migrated-category-rules'
     AND version = 1),
  'legacy-' || id,
  'contains',
  match_field,
  pattern,
  priority,
  1,
  json_object('category', category, 'subcategory', subcategory),
  json_object('legacy_rule_id', id),
  1,
  created_at,
  created_at
FROM category_rules;
