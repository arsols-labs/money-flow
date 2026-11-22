-- Clean-install starter currency for `npm run setup` (non-demo path).
-- Writes only USD (minor_digits: 2, is_fx_anchor: true) when `currency_standards`
-- is empty. Does not write EUR, GBP, CAD, RSD, shops, banks, statement
-- templates, or fiscal hosts. Users can change this starter or add other
-- currencies in Settings.

INSERT INTO rule_sets (
  domain, scope_country, scope_locale, set_key, version, state,
  effective_from, effective_to, priority, allow_shared_fallback,
  label, description, provenance_source, provenance_actor,
  revision, activated_at, created_at, updated_at
)
SELECT
  'currency_standards',
  'SHARED',
  '',
  'starter-currency',
  1,
  'active',
  NULL,
  NULL,
  100,
  1,
  'Starter currency',
  'Starter USD currency created by setup when currency_standards is empty. Change or add currencies in Settings.',
  'import',
  'setup',
  1,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE NOT EXISTS (
  SELECT 1
  FROM rule_sets
  WHERE domain = 'currency_standards'
);

INSERT INTO rule_entries (
  rule_set_id, entry_key, match_type, match_field, pattern,
  priority, enabled, payload_json, meta_json, revision, created_at, updated_at
)
SELECT
  rs.id,
  'USD',
  'exact',
  'code',
  'USD',
  10,
  1,
  '{"code":"USD","minor_digits":2,"symbol":"$","is_fx_anchor":true}',
  NULL,
  1,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM rule_sets rs
WHERE rs.domain = 'currency_standards'
  AND rs.scope_country = 'SHARED'
  AND rs.scope_locale = ''
  AND rs.set_key = 'starter-currency'
  AND rs.version = 1
  AND NOT EXISTS (
    SELECT 1
    FROM rule_entries re
    JOIN rule_sets rs2 ON rs2.id = re.rule_set_id
    WHERE rs2.domain = 'currency_standards'
  );
