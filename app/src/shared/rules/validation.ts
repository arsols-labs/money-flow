import { validatePatternSafety, validateSafeRegexPattern } from './matcher';
import { formatTemplateErrors, isStatementDateFormat, validateStatementTemplate } from '../statement-import/template-schema';
import {
  MATCH_FIELDS,
  MATCH_TYPES,
  PROVENANCE_SOURCES,
  RULE_DOMAINS,
  RULE_SET_STATES,
  RECURRING_POLICY_TYPES,
  SHARED_COUNTRY,
  type CategoryRulePayload,
  type CurrencyStandardPayload,
  type DeliveryServicePayload,
  type FiscalFormatPayload,
  type MatchField,
  type MatchType,
  type MerchantAliasPayload,
  type OrderHintPayload,
  type PdfBalanceRule,
  type PdfLayoutPayload,
  type ProvenanceSource,
  type RecurringPolicyType,
  type RuleDomain,
  type RuleSetState,
  type VenueSuffixPayload,
} from './types';

export interface RuleValidationError {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: RuleValidationError[] };

export interface ValidatedRuleSetInput {
  domain: RuleDomain;
  scope_country: string;
  scope_locale: string;
  set_key: string;
  version: number;
  state: RuleSetState;
  effective_from: string | null;
  effective_to: string | null;
  priority: number;
  allow_shared_fallback: number;
  label: string;
  description: string | null;
  provenance_source: ProvenanceSource;
  provenance_actor: string | null;
}

export interface ValidatedRuleEntryInput {
  entry_key: string;
  match_type: MatchType | null;
  match_field: MatchField | null;
  pattern: string | null;
  priority: number;
  enabled: number;
  payload_json: string;
  meta_json: string | null;
}

export interface ValidatedRecurringPolicyInput {
  recurring_item_id: number;
  policy_type: RecurringPolicyType;
  scope_country: string;
  version: number;
  state: RuleSetState;
  effective_from: string | null;
  effective_to: string | null;
  priority: number;
  provenance_source: ProvenanceSource;
  provenance_actor: string | null;
  notes: string | null;
}

export interface ValidatedBundleRuleSet extends ValidatedRuleSetInput {
  entries: ValidatedRuleEntryInput[];
}

export interface ValidatedRulesBundle {
  schema_version: 1;
  rule_sets: ValidatedBundleRuleSet[];
  recurring_policies: ValidatedRecurringPolicyInput[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;
const SUPPORTED_LOCALE_SCOPES = new Set(['', 'en', 'ru', 'de', 'fr', 'es', 'pt', 'sr']);

const PATTERN_MATCH_TYPES = new Set<MatchType>([
  'exact',
  'prefix',
  'suffix',
  'contains',
  'tokens',
  'regex_safe',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTrimmedNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonOrObject(value: unknown): { ok: true; obj: Record<string, unknown> } | { ok: false; message: string } {
  if (isPlainObject(value)) return { ok: true, obj: value };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isPlainObject(parsed)) return { ok: true, obj: parsed };
      return { ok: false, message: 'payload must be a JSON object' };
    } catch {
      return { ok: false, message: 'payload_json must be valid JSON' };
    }
  }
  return { ok: false, message: 'payload must be a JSON object' };
}

export function normalizeCountryScope(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === SHARED_COUNTRY) return SHARED_COUNTRY;
  return COUNTRY_CODE_RE.test(upper) ? upper : null;
}

export function normalizeLocaleScope(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'all' || trimmed === '') return '';
  return SUPPORTED_LOCALE_SCOPES.has(trimmed) ? trimmed : null;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

function validatePriority(value: unknown, fallback = 100): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000000) {
    return { ok: false, message: 'priority must be an integer between 0 and 1000000' };
  }
  return { ok: true, value };
}

function validateBooleanFlag(value: unknown, fallback: 0 | 1): 0 | 1 | null {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

export function validateRuleSetInput(
  raw: unknown,
  defaultProvenance: ProvenanceSource = 'api',
): ValidationResult<ValidatedRuleSetInput> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '/', message: 'rule_set must be an object' }] };
  }
  const errors: RuleValidationError[] = [];

  const domain = raw.domain as RuleDomain;
  if (typeof raw.domain !== 'string' || !(RULE_DOMAINS as readonly string[]).includes(raw.domain)) {
    errors.push({ path: '/domain', message: `domain must be one of ${RULE_DOMAINS.join(', ')}` });
  }

  const scopeCountry = normalizeCountryScope(raw.scope_country);
  if (!scopeCountry) {
    errors.push({ path: '/scope_country', message: `scope_country must be a 2-letter uppercase ISO country code or "${SHARED_COUNTRY}"` });
  }

  const scopeLocale = normalizeLocaleScope(raw.scope_locale);
  if (scopeLocale === null) {
    errors.push({ path: '/scope_locale', message: 'scope_locale must be "all" or a valid locale tag (e.g. "en", "sr")' });
  }

  const setKey = typeof raw.set_key === 'string' ? raw.set_key.trim().toLowerCase() : '';
  if (!SET_KEY_RE.test(setKey)) {
    errors.push({ path: '/set_key', message: 'set_key must match ^[a-z0-9][a-z0-9._-]{0,79}$' });
  }

  const label = asTrimmedNonEmpty(raw.label);
  if (!label || label.length > 120) {
    errors.push({ path: '/label', message: 'label must be a non-empty string up to 120 chars' });
  }

  let version = 1;
  if (raw.version !== undefined && raw.version !== null) {
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
      errors.push({ path: '/version', message: 'version must be a positive integer' });
    } else {
      version = raw.version;
    }
  }

  let state: RuleSetState = 'draft';
  if (raw.state !== undefined && raw.state !== null) {
    if (typeof raw.state !== 'string' || !(RULE_SET_STATES as readonly string[]).includes(raw.state)) {
      errors.push({ path: '/state', message: `state must be one of ${RULE_SET_STATES.join(', ')}` });
    } else {
      state = raw.state as RuleSetState;
    }
  }

  const effectiveFrom = raw.effective_from === undefined || raw.effective_from === null || raw.effective_from === ''
    ? null
    : String(raw.effective_from).trim();
  const effectiveTo = raw.effective_to === undefined || raw.effective_to === null || raw.effective_to === ''
    ? null
    : String(raw.effective_to).trim();
  if (effectiveFrom !== null && !isValidIsoDate(effectiveFrom)) {
    errors.push({ path: '/effective_from', message: 'effective_from must be YYYY-MM-DD or null' });
  }
  if (effectiveTo !== null && !isValidIsoDate(effectiveTo)) {
    errors.push({ path: '/effective_to', message: 'effective_to must be YYYY-MM-DD or null' });
  }
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    errors.push({ path: '/effective_to', message: 'effective_to must be on or after effective_from' });
  }

  const priorityResult = validatePriority(raw.priority, 100);
  if (!priorityResult.ok) errors.push({ path: '/priority', message: priorityResult.message });

  const allowShared = validateBooleanFlag(raw.allow_shared_fallback, 1);
  if (allowShared === null) {
    errors.push({ path: '/allow_shared_fallback', message: 'allow_shared_fallback must be a boolean or 0/1' });
  }

  let provenanceSource: ProvenanceSource = defaultProvenance;
  if (raw.provenance_source !== undefined && raw.provenance_source !== null) {
    if (typeof raw.provenance_source !== 'string' || !(PROVENANCE_SOURCES as readonly string[]).includes(raw.provenance_source)) {
      errors.push({ path: '/provenance_source', message: `provenance_source must be one of ${PROVENANCE_SOURCES.join(', ')}` });
    } else {
      provenanceSource = raw.provenance_source as ProvenanceSource;
    }
  }

  let description: string | null = null;
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') {
      errors.push({ path: '/description', message: 'description must be a string or null' });
    } else {
      const trimmed = raw.description.trim();
      description = trimmed.length > 0 ? trimmed.slice(0, 500) : null;
    }
  }

  let provenanceActor: string | null = null;
  if (raw.provenance_actor !== undefined && raw.provenance_actor !== null) {
    if (typeof raw.provenance_actor !== 'string') {
      errors.push({ path: '/provenance_actor', message: 'provenance_actor must be a string or null' });
    } else {
      const trimmed = raw.provenance_actor.trim();
      provenanceActor = trimmed.length > 0 ? trimmed.slice(0, 120) : null;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      domain,
      scope_country: scopeCountry!,
      scope_locale: scopeLocale!,
      set_key: setKey,
      version,
      state,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      priority: priorityResult.ok ? priorityResult.value : 100,
      allow_shared_fallback: allowShared ?? 1,
      label: label!,
      description,
      provenance_source: provenanceSource,
      provenance_actor: provenanceActor,
    },
  };
}

function validateSafeOptionalRegex(
  value: unknown,
  path: string,
  errors: RuleValidationError[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a string or null' });
    return undefined;
  }
  const check = validateSafeRegexPattern(value);
  if (!check.ok) {
    errors.push({ path, message: check.reason ?? 'unsafe regex' });
    return undefined;
  }
  return value;
}

function validateStringList(value: unknown, path: string, errors: RuleValidationError[], allowEmpty = false): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    errors.push({ path, message: 'must be an array of non-empty strings' });
    return undefined;
  }
  if (!allowEmpty && value.length === 0) {
    errors.push({ path, message: 'must contain at least 1 string' });
    return undefined;
  }
  return value.map((item) => item.trim());
}

function validateBalanceRule(raw: unknown, path: string, errors: RuleValidationError[]): PdfBalanceRule | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'balance rule must be an object or null' });
    return undefined;
  }
  const out: PdfBalanceRule = {};
  if (raw.label_prefixes !== undefined) {
    out.label_prefixes = validateStringList(raw.label_prefixes, `${path}/label_prefixes`, errors, true);
  }
  const pat = validateSafeOptionalRegex(raw.pattern, `${path}/pattern`, errors);
  if (pat !== undefined) out.pattern = pat;
  if (raw.decimal_separator !== undefined) {
    if (raw.decimal_separator !== '.' && raw.decimal_separator !== ',') {
      errors.push({ path: `${path}/decimal_separator`, message: 'decimal_separator must be "." or ","' });
    } else {
      out.decimal_separator = raw.decimal_separator;
    }
  }
  if (raw.negate_if_contains !== undefined) {
    out.negate_if_contains = validateStringList(raw.negate_if_contains, `${path}/negate_if_contains`, errors, true);
  }
  if (raw.positive_if_contains !== undefined) {
    out.positive_if_contains = validateStringList(raw.positive_if_contains, `${path}/positive_if_contains`, errors, true);
  }
  return out;
}

function validateCurrencyPayload(obj: Record<string, unknown>, errors: RuleValidationError[]): CurrencyStandardPayload | null {
  const code = typeof obj.code === 'string' ? obj.code.trim().toUpperCase() : '';
  if (!CURRENCY_CODE_RE.test(code)) {
    errors.push({ path: '/payload/code', message: 'code must be a 3-letter uppercase currency code' });
  }
  if (typeof obj.minor_digits !== 'number' || !Number.isInteger(obj.minor_digits) || obj.minor_digits < 0 || obj.minor_digits > 6) {
    errors.push({ path: '/payload/minor_digits', message: 'minor_digits must be an integer between 0 and 6' });
  }
  let symbol: string | null | undefined;
  if (obj.symbol !== undefined && obj.symbol !== null) {
    if (typeof obj.symbol !== 'string' || obj.symbol.trim().length === 0 || obj.symbol.trim().length > 16) {
      errors.push({ path: '/payload/symbol', message: 'symbol must be 1..16 chars or null' });
    } else {
      symbol = obj.symbol.trim();
    }
  } else if (obj.symbol === null) {
    symbol = null;
  }
  let isFxAnchor: boolean | undefined;
  if (obj.is_fx_anchor !== undefined) {
    if (typeof obj.is_fx_anchor !== 'boolean') {
      errors.push({ path: '/payload/is_fx_anchor', message: 'is_fx_anchor must be a boolean' });
    } else {
      isFxAnchor = obj.is_fx_anchor;
    }
  }
  if (errors.length > 0) return null;
  return {
    code,
    minor_digits: obj.minor_digits as number,
    ...(symbol !== undefined ? { symbol } : {}),
    ...(isFxAnchor !== undefined ? { is_fx_anchor: isFxAnchor } : {}),
  };
}

function validateFiscalPayload(obj: Record<string, unknown>, errors: RuleValidationError[]): FiscalFormatPayload | null {
  const id = asTrimmedNonEmpty(obj.id);
  const label = asTrimmedNonEmpty(obj.label);
  if (!id || !SET_KEY_RE.test(id)) {
    errors.push({ path: '/payload/id', message: 'id must match ^[a-z0-9][a-z0-9._-]{0,63}$' });
  }
  if (!label) errors.push({ path: '/payload/label', message: 'label must be non-empty' });
  if (obj.canonical_scheme !== 'https' && obj.canonical_scheme !== 'http') {
    errors.push({ path: '/payload/canonical_scheme', message: 'canonical_scheme must be "https" or "http"' });
  }
  const canonicalHost = typeof obj.canonical_host === 'string' ? obj.canonical_host.trim().toLowerCase() : '';
  if (!canonicalHost || /\s/.test(canonicalHost)) {
    errors.push({ path: '/payload/canonical_host', message: 'canonical_host must be a valid hostname' });
  }
  const allowedHosts = validateStringList(obj.allowed_hosts, '/payload/allowed_hosts', errors, false)
    ?.map((h) => h.toLowerCase());
  if (allowedHosts && canonicalHost && !allowedHosts.includes(canonicalHost)) {
    errors.push({ path: '/payload/allowed_hosts', message: 'allowed_hosts must include canonical_host' });
  }
  if (obj.allow_subdomains !== undefined && typeof obj.allow_subdomains !== 'boolean') {
    errors.push({ path: '/payload/allow_subdomains', message: 'allow_subdomains must be boolean' });
  }
  if (obj.allowed_ports !== undefined) {
    if (!Array.isArray(obj.allowed_ports) || obj.allowed_ports.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535)) {
      errors.push({ path: '/payload/allowed_ports', message: 'allowed_ports must be valid TCP port numbers' });
    }
  }
  const pfrPattern = validateSafeOptionalRegex(obj.pfr_in_text_pattern, '/payload/pfr_in_text_pattern', errors);
  const vlTokenPattern = validateSafeOptionalRegex(obj.vl_token_pattern, '/payload/vl_token_pattern', errors);
  if (obj.default_currency !== undefined && obj.default_currency !== null) {
    if (typeof obj.default_currency !== 'string' || !CURRENCY_CODE_RE.test(obj.default_currency.trim().toUpperCase())) {
      errors.push({ path: '/payload/default_currency', message: 'default_currency must be a 3-letter uppercase code or null' });
    }
  }
  let extractionLabels: Record<string, string[]> | undefined;
  if (obj.extraction_labels !== undefined) {
    if (!isPlainObject(obj.extraction_labels)) {
      errors.push({ path: '/payload/extraction_labels', message: 'extraction_labels must be an object' });
    } else {
      extractionLabels = {};
      for (const [k, v] of Object.entries(obj.extraction_labels)) {
        const list = validateStringList(v, `/payload/extraction_labels/${k}`, errors, true);
        if (list) extractionLabels[k] = list;
      }
    }
  }
  if (errors.length > 0) return null;
  return {
    id: id!,
    label: label!,
    canonical_scheme: obj.canonical_scheme as 'https' | 'http',
    canonical_host: canonicalHost,
    allowed_hosts: allowedHosts!,
    ...(obj.allow_subdomains !== undefined ? { allow_subdomains: Boolean(obj.allow_subdomains) } : {}),
    ...(Array.isArray(obj.allowed_ports) ? { allowed_ports: obj.allowed_ports as number[] } : {}),
    ...(typeof obj.canonical_path === 'string' ? { canonical_path: obj.canonical_path } : {}),
    ...(typeof obj.query_param === 'string' ? { query_param: obj.query_param } : {}),
    ...(pfrPattern !== undefined ? { pfr_in_text_pattern: pfrPattern } : {}),
    ...(obj.pfr_canonical_uppercase !== undefined ? { pfr_canonical_uppercase: Boolean(obj.pfr_canonical_uppercase) } : {}),
    ...(obj.vl_base64_scan !== undefined ? { vl_base64_scan: Boolean(obj.vl_base64_scan) } : {}),
    ...(vlTokenPattern !== undefined ? { vl_token_pattern: vlTokenPattern } : {}),
    ...(obj.default_currency !== undefined
      ? { default_currency: obj.default_currency === null ? null : String(obj.default_currency).trim().toUpperCase() }
      : {}),
    ...(extractionLabels ? { extraction_labels: extractionLabels } : {}),
  };
}

function validatePdfLayoutPayload(obj: Record<string, unknown>, errors: RuleValidationError[]): PdfLayoutPayload | null {
  const id = asTrimmedNonEmpty(obj.id);
  const label = asTrimmedNonEmpty(obj.label);
  if (!id || !SET_KEY_RE.test(id)) {
    errors.push({ path: '/payload/id', message: 'id must match ^[a-z0-9][a-z0-9._-]{0,63}$' });
  }
  if (!label) errors.push({ path: '/payload/label', message: 'label must be non-empty' });
  if (obj.currency_code !== undefined && obj.currency_code !== null) {
    if (typeof obj.currency_code !== 'string' || !CURRENCY_CODE_RE.test(obj.currency_code.trim().toUpperCase())) {
      errors.push({ path: '/payload/currency_code', message: 'currency_code must be a 3-letter uppercase code or null' });
    }
  }
  const currencyPattern = validateSafeOptionalRegex(obj.currency_pattern, '/payload/currency_pattern', errors);
  if (obj.decimal_separator !== '.' && obj.decimal_separator !== ',') {
    errors.push({ path: '/payload/decimal_separator', message: 'decimal_separator must be "." or ","' });
  }
  if (typeof obj.date_format !== 'string' || !isStatementDateFormat(obj.date_format)) {
    errors.push({ path: '/payload/date_format', message: 'date_format must be a supported statement date format' });
  }
  if (!isPlainObject(obj.detect)) {
    errors.push({ path: '/payload/detect', message: 'detect must be an object' });
  } else {
    const incAll = validateStringList(obj.detect.include_all, '/payload/detect/include_all', errors, true);
    const incAny = validateStringList(obj.detect.include_any, '/payload/detect/include_any', errors, true);
    validateStringList(obj.detect.exclude_any, '/payload/detect/exclude_any', errors, true);
    if ((!incAll || incAll.length === 0) && (!incAny || incAny.length === 0)) {
      errors.push({ path: '/payload/detect', message: 'detect must specify at least one include_all or include_any marker' });
    }
  }

  const accountRefPattern = validateSafeOptionalRegex(obj.account_ref_pattern, '/payload/account_ref_pattern', errors);
  const yearPattern = validateSafeOptionalRegex(obj.year_pattern, '/payload/year_pattern', errors);
  validateStringList(obj.section_start_markers, '/payload/section_start_markers', errors, true);
  validateStringList(obj.section_stop_markers, '/payload/section_stop_markers', errors, true);
  if (obj.section_signs !== undefined) {
    if (!Array.isArray(obj.section_signs)) {
      errors.push({ path: '/payload/section_signs', message: 'section_signs must be an array' });
    } else {
      obj.section_signs.forEach((item, idx) => {
        if (!isPlainObject(item) || typeof item.marker !== 'string' || !item.marker.trim() || (item.sign !== 1 && item.sign !== -1)) {
          errors.push({ path: `/payload/section_signs/${idx}`, message: 'section_signs entries need marker and sign (1 or -1)' });
        }
      });
    }
  }
  validateStringList(obj.noise_prefixes, '/payload/noise_prefixes', errors, true);
  validateStringList(obj.noise_contains, '/payload/noise_contains', errors, true);
  const openingBalance = validateBalanceRule(obj.opening_balance, '/payload/opening_balance', errors);
  const closingBalance = validateBalanceRule(obj.closing_balance, '/payload/closing_balance', errors);

  if (obj.row_mode !== 'single_line_regex' && obj.row_mode !== 'dated_blocks') {
    errors.push({ path: '/payload/row_mode', message: 'row_mode must be "single_line_regex" or "dated_blocks"' });
  }
  if (typeof obj.row_start_pattern !== 'string' || obj.row_start_pattern.length === 0) {
    errors.push({ path: '/payload/row_start_pattern', message: 'row_start_pattern is required' });
  } else {
    const check = validateSafeRegexPattern(obj.row_start_pattern);
    if (!check.ok) errors.push({ path: '/payload/row_start_pattern', message: check.reason ?? 'unsafe regex' });
  }
  const rowLinePattern = validateSafeOptionalRegex(obj.row_line_pattern, '/payload/row_line_pattern', errors);

  const groupKeys = [
    'date_group',
    'amount_group',
    'debit_group',
    'credit_group',
    'description_group',
    'balance_group',
    'currency_group',
    'bank_ref_group',
  ] as const;
  for (const key of groupKeys) {
    const val = obj[key];
    if (val !== undefined && (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 20)) {
      errors.push({ path: `/payload/${key}`, message: `${key} must be an integer 0..20` });
    }
  }
  validateStringList(obj.debit_indicators, '/payload/debit_indicators', errors, true);
  validateStringList(obj.credit_indicators, '/payload/credit_indicators', errors, true);

  let columnRules: PdfLayoutPayload['column_rules'];
  if (obj.column_rules !== undefined && obj.column_rules !== null) {
    if (!isPlainObject(obj.column_rules)) {
      errors.push({ path: '/payload/column_rules', message: 'column_rules must be an object or null' });
    } else {
      const creditHeaders = validateStringList(obj.column_rules.credit_headers, '/payload/column_rules/credit_headers', errors, true);
      const debitHeaders = validateStringList(obj.column_rules.debit_headers, '/payload/column_rules/debit_headers', errors, true);
      const balanceHeaders = validateStringList(obj.column_rules.balance_headers, '/payload/column_rules/balance_headers', errors, true);
      const refPattern = validateSafeOptionalRegex(obj.column_rules.ref_pattern, '/payload/column_rules/ref_pattern', errors);
      const stripPatterns = validateStringList(obj.column_rules.strip_patterns, '/payload/column_rules/strip_patterns', errors, true);
      if (stripPatterns) {
        stripPatterns.forEach((p, idx) => {
          const check = validateSafeRegexPattern(p);
          if (!check.ok) {
            errors.push({ path: `/payload/column_rules/strip_patterns/${idx}`, message: check.reason ?? 'unsafe regex' });
          }
        });
      }
      columnRules = {
        ...(creditHeaders ? { credit_headers: creditHeaders } : {}),
        ...(debitHeaders ? { debit_headers: debitHeaders } : {}),
        ...(balanceHeaders ? { balance_headers: balanceHeaders } : {}),
        ...(refPattern !== undefined ? { ref_pattern: refPattern } : {}),
        ...(stripPatterns ? { strip_patterns: stripPatterns } : {}),
      };
    }
  }

  if (obj.description_flags !== undefined) {
    if (!Array.isArray(obj.description_flags)) {
      errors.push({ path: '/payload/description_flags', message: 'description_flags must be an array' });
    } else {
      obj.description_flags.forEach((flag, idx) => {
        if (!isPlainObject(flag) || flag.id !== 'possible_own_account_transfer' || typeof flag.pattern !== 'string') {
          errors.push({ path: `/payload/description_flags/${idx}`, message: 'invalid description flag' });
        } else {
          const check = validateSafeRegexPattern(flag.pattern);
          if (!check.ok) {
            errors.push({ path: `/payload/description_flags/${idx}/pattern`, message: check.reason ?? 'unsafe regex' });
          }
        }
      });
    }
  }

  if (errors.length > 0) return null;
  const detect = obj.detect as PdfLayoutPayload['detect'];
  return {
    ...(obj as unknown as PdfLayoutPayload),
    id: id!,
    label: label!,
    ...(obj.currency_code !== undefined
      ? { currency_code: obj.currency_code === null ? null : String(obj.currency_code).trim().toUpperCase() }
      : {}),
    ...(currencyPattern !== undefined ? { currency_pattern: currencyPattern } : {}),
    ...(accountRefPattern !== undefined ? { account_ref_pattern: accountRefPattern } : {}),
    ...(yearPattern !== undefined ? { year_pattern: yearPattern } : {}),
    ...(openingBalance !== undefined ? { opening_balance: openingBalance } : {}),
    ...(closingBalance !== undefined ? { closing_balance: closingBalance } : {}),
    ...(rowLinePattern !== undefined ? { row_line_pattern: rowLinePattern } : {}),
    ...(columnRules !== undefined ? { column_rules: columnRules } : {}),
    detect,
  };
}

export function validateRuleEntryInput(domain: RuleDomain, raw: unknown): ValidationResult<ValidatedRuleEntryInput> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '/', message: 'rule_entry must be an object' }] };
  }
  const errors: RuleValidationError[] = [];

  const entryKey = asTrimmedNonEmpty(raw.entry_key);
  if (!entryKey || entryKey.length > 128) {
    errors.push({ path: '/entry_key', message: 'entry_key must be a non-empty string up to 128 chars' });
  }

  let matchType: MatchType | null = null;
  if (raw.match_type !== undefined && raw.match_type !== null) {
    if (typeof raw.match_type !== 'string' || !(MATCH_TYPES as readonly string[]).includes(raw.match_type)) {
      errors.push({ path: '/match_type', message: `match_type must be one of ${MATCH_TYPES.join(', ')}` });
    } else {
      matchType = raw.match_type as MatchType;
    }
  }

  let matchField: MatchField | null = null;
  if (raw.match_field !== undefined && raw.match_field !== null) {
    if (typeof raw.match_field !== 'string' || !(MATCH_FIELDS as readonly string[]).includes(raw.match_field)) {
      errors.push({ path: '/match_field', message: `match_field must be one of ${MATCH_FIELDS.join(', ')}` });
    } else {
      matchField = raw.match_field as MatchField;
    }
  }

  const pattern = raw.pattern === undefined || raw.pattern === null ? null : String(raw.pattern);
  if (pattern !== null) {
    const safety = validatePatternSafety(matchType, pattern);
    if (!safety.ok) {
      errors.push({ path: '/pattern', message: safety.reason ?? 'invalid pattern' });
    }
  }

  const priorityRes = validatePriority(raw.priority, 100);
  if (!priorityRes.ok) errors.push({ path: '/priority', message: priorityRes.message });

  const enabled = validateBooleanFlag(raw.enabled, 1);
  if (enabled === null) errors.push({ path: '/enabled', message: 'enabled must be boolean or 0/1' });

  const parsedPayload = parseJsonOrObject(raw.payload ?? raw.payload_json);
  if (!parsedPayload.ok) {
    errors.push({ path: '/payload', message: parsedPayload.message });
    return { ok: false, errors };
  }
  const obj = parsedPayload.obj;

  let metaJson: string | null = null;
  if (raw.meta !== undefined && raw.meta !== null) {
    const parsedMeta = parseJsonOrObject(raw.meta);
    if (!parsedMeta.ok) errors.push({ path: '/meta', message: parsedMeta.message });
    else metaJson = JSON.stringify(parsedMeta.obj);
  } else if (typeof raw.meta_json === 'string' && raw.meta_json.trim().length > 0) {
    const parsedMeta = parseJsonOrObject(raw.meta_json);
    if (!parsedMeta.ok) errors.push({ path: '/meta_json', message: parsedMeta.message });
    else metaJson = JSON.stringify(parsedMeta.obj);
  }

  let normalizedPayload: unknown = null;
  switch (domain) {
    case 'currency_standards': {
      matchType ??= 'schema_entry';
      matchField ??= 'code';
      normalizedPayload = validateCurrencyPayload(obj, errors);
      break;
    }
    case 'fiscal_formats': {
      matchType ??= 'url_host';
      matchField ??= 'url';
      normalizedPayload = validateFiscalPayload(obj, errors);
      break;
    }
    case 'merchant_aliases': {
      if (!matchType || !PATTERN_MATCH_TYPES.has(matchType)) {
        errors.push({ path: '/match_type', message: 'merchant_aliases requires a pattern match_type' });
      }
      if (!pattern || pattern.length === 0) {
        errors.push({ path: '/pattern', message: 'merchant_aliases requires non-empty pattern' });
      }
      matchField ??= 'merchant';
      const target = asTrimmedNonEmpty(obj.target_merchant);
      if (!target) {
        errors.push({ path: '/payload/target_merchant', message: 'target_merchant must be non-empty' });
      } else {
        const out: MerchantAliasPayload = {
          target_merchant: target,
          ...(obj.case_sensitive !== undefined ? { case_sensitive: Boolean(obj.case_sensitive) } : {}),
        };
        normalizedPayload = out;
      }
      break;
    }
    case 'delivery_services': {
      if (!matchType || !PATTERN_MATCH_TYPES.has(matchType)) {
        errors.push({ path: '/match_type', message: 'delivery_services requires a pattern match_type' });
      }
      if (!pattern || pattern.length === 0) {
        errors.push({ path: '/pattern', message: 'delivery_services requires non-empty pattern' });
      }
      matchField ??= 'store';
      const label = asTrimmedNonEmpty(obj.label);
      if (!label) {
        errors.push({ path: '/payload/label', message: 'label must be non-empty' });
      } else {
        const out: DeliveryServicePayload = {
          label,
          ...(obj.case_sensitive !== undefined ? { case_sensitive: Boolean(obj.case_sensitive) } : {}),
        };
        normalizedPayload = out;
      }
      break;
    }
    case 'venue_suffixes': {
      if (!matchType || !PATTERN_MATCH_TYPES.has(matchType)) {
        errors.push({ path: '/match_type', message: 'venue_suffixes requires a pattern match_type' });
      }
      if (!pattern || pattern.length === 0) {
        errors.push({ path: '/pattern', message: 'venue_suffixes requires non-empty pattern' });
      }
      matchField ??= 'store';
      const label = asTrimmedNonEmpty(obj.label);
      if (!label) {
        errors.push({ path: '/payload/label', message: 'label must be non-empty' });
      } else {
        const out: VenueSuffixPayload = {
          label,
          ...(obj.case_sensitive !== undefined ? { case_sensitive: Boolean(obj.case_sensitive) } : {}),
          ...(obj.trim_result !== undefined ? { trim_result: Boolean(obj.trim_result) } : {}),
        };
        normalizedPayload = out;
      }
      break;
    }
    case 'order_hints': {
      if (!matchType || !PATTERN_MATCH_TYPES.has(matchType)) {
        errors.push({ path: '/match_type', message: 'order_hints requires a pattern match_type' });
      }
      if (!pattern || pattern.length === 0) {
        errors.push({ path: '/pattern', message: 'order_hints requires non-empty pattern' });
      }
      matchField ??= 'text';
      const label = asTrimmedNonEmpty(obj.label);
      if (!label) {
        errors.push({ path: '/payload/label', message: 'label must be non-empty' });
      } else {
        if (obj.token_group !== undefined && (typeof obj.token_group !== 'number' || !Number.isInteger(obj.token_group) || obj.token_group < 0 || obj.token_group > 10)) {
          errors.push({ path: '/payload/token_group', message: 'token_group must be an integer 0..10' });
        }
        const out: OrderHintPayload = {
          label,
          ...(obj.token_group !== undefined ? { token_group: obj.token_group as number } : {}),
          ...(obj.uppercase !== undefined ? { uppercase: Boolean(obj.uppercase) } : {}),
          ...(obj.case_sensitive !== undefined ? { case_sensitive: Boolean(obj.case_sensitive) } : {}),
        };
        normalizedPayload = out;
      }
      break;
    }
    case 'category_rules': {
      if (!matchType || !PATTERN_MATCH_TYPES.has(matchType)) {
        errors.push({ path: '/match_type', message: 'category_rules requires a pattern match_type' });
      }
      if (!pattern || pattern.length === 0) {
        errors.push({ path: '/pattern', message: 'category_rules requires non-empty pattern' });
      }
      matchField ??= 'any';
      const category = asTrimmedNonEmpty(obj.category);
      const subcategory = obj.subcategory === undefined || obj.subcategory === null || obj.subcategory === ''
        ? null
        : asTrimmedNonEmpty(obj.subcategory);
      if (!category) {
        errors.push({ path: '/payload/category', message: 'category must be non-empty' });
      } else {
        const out: CategoryRulePayload = { category, subcategory };
        normalizedPayload = out;
      }
      break;
    }
    case 'statement_templates': {
      matchType ??= 'template';
      const check = validateStatementTemplate(obj);
      if (!check.ok) {
        errors.push({ path: '/payload', message: formatTemplateErrors(check.errors) });
      } else {
        // Also ensure descriptionFlags patterns stay ReDoS-safe.
        const layoutFlags = [
          ...(check.value.csv?.options.descriptionFlags ?? []),
          ...(check.value.xls?.descriptionFlags ?? []),
        ];
        layoutFlags.forEach((flag, idx) => {
          const safe = validateSafeRegexPattern(flag.pattern);
          if (!safe.ok) {
            errors.push({ path: `/payload/descriptionFlags/${idx}`, message: safe.reason ?? 'unsafe regex' });
          }
        });
        normalizedPayload = check.value;
      }
      break;
    }
    case 'pdf_layouts': {
      matchType ??= 'layout';
      matchField ??= 'text';
      normalizedPayload = validatePdfLayoutPayload(obj, errors);
      break;
    }
  }

  if (errors.length > 0 || !normalizedPayload) return { ok: false, errors };

  return {
    ok: true,
    value: {
      entry_key: entryKey!,
      match_type: matchType,
      match_field: matchField,
      pattern,
      priority: priorityRes.ok ? priorityRes.value : 100,
      enabled: enabled ?? 1,
      payload_json: JSON.stringify(normalizedPayload),
      meta_json: metaJson,
    },
  };
}

export function validateRecurringPolicyInput(
  raw: unknown,
  defaultProvenance: ProvenanceSource = 'api',
): ValidationResult<ValidatedRecurringPolicyInput> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '/', message: 'recurring policy must be an object' }] };
  }
  const errors: RuleValidationError[] = [];

  if (typeof raw.recurring_item_id !== 'number' || !Number.isInteger(raw.recurring_item_id) || raw.recurring_item_id < 1) {
    errors.push({ path: '/recurring_item_id', message: 'recurring_item_id must be a positive integer' });
  }
  const policyType = typeof raw.policy_type === 'string' && (RECURRING_POLICY_TYPES as readonly string[]).includes(raw.policy_type)
    ? (raw.policy_type as RecurringPolicyType)
    : null;
  if (!policyType) {
    errors.push({ path: '/policy_type', message: `policy_type must be one of ${RECURRING_POLICY_TYPES.join(', ')}` });
  }

  const scopeCountry = raw.scope_country === undefined
    ? SHARED_COUNTRY
    : normalizeCountryScope(raw.scope_country);
  if (!scopeCountry) {
    errors.push({ path: '/scope_country', message: `scope_country must be 2-letter uppercase ISO country code or "${SHARED_COUNTRY}"` });
  }

  let version = 1;
  if (raw.version !== undefined && raw.version !== null) {
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
      errors.push({ path: '/version', message: 'version must be a positive integer' });
    } else {
      version = raw.version;
    }
  }

  let state: RuleSetState = 'active';
  if (raw.state !== undefined && raw.state !== null) {
    if (typeof raw.state !== 'string' || !(RULE_SET_STATES as readonly string[]).includes(raw.state)) {
      errors.push({ path: '/state', message: `state must be one of ${RULE_SET_STATES.join(', ')}` });
    } else {
      state = raw.state as RuleSetState;
    }
  }

  const effectiveFrom = raw.effective_from === undefined || raw.effective_from === null || raw.effective_from === ''
    ? null
    : String(raw.effective_from).trim();
  const effectiveTo = raw.effective_to === undefined || raw.effective_to === null || raw.effective_to === ''
    ? null
    : String(raw.effective_to).trim();
  if (effectiveFrom !== null && !isValidIsoDate(effectiveFrom)) {
    errors.push({ path: '/effective_from', message: 'effective_from must be YYYY-MM-DD or null' });
  }
  if (effectiveTo !== null && !isValidIsoDate(effectiveTo)) {
    errors.push({ path: '/effective_to', message: 'effective_to must be YYYY-MM-DD or null' });
  }
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    errors.push({ path: '/effective_to', message: 'effective_to must be on or after effective_from' });
  }

  const priorityRes = validatePriority(raw.priority, 100);
  if (!priorityRes.ok) errors.push({ path: '/priority', message: priorityRes.message });

  let provenanceSource: ProvenanceSource = defaultProvenance;
  if (raw.provenance_source !== undefined && raw.provenance_source !== null) {
    if (typeof raw.provenance_source !== 'string' || !(PROVENANCE_SOURCES as readonly string[]).includes(raw.provenance_source)) {
      errors.push({ path: '/provenance_source', message: `provenance_source must be one of ${PROVENANCE_SOURCES.join(', ')}` });
    } else {
      provenanceSource = raw.provenance_source as ProvenanceSource;
    }
  }

  let notes: string | null = null;
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== 'string') errors.push({ path: '/notes', message: 'notes must be string or null' });
    else notes = raw.notes.trim().slice(0, 500) || null;
  }

  let actor: string | null = null;
  if (raw.provenance_actor !== undefined && raw.provenance_actor !== null) {
    if (typeof raw.provenance_actor !== 'string') errors.push({ path: '/provenance_actor', message: 'provenance_actor must be string or null' });
    else actor = raw.provenance_actor.trim().slice(0, 120) || null;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      recurring_item_id: raw.recurring_item_id as number,
      policy_type: policyType!,
      scope_country: scopeCountry!,
      version,
      state,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      priority: priorityRes.ok ? priorityRes.value : 100,
      provenance_source: provenanceSource,
      provenance_actor: actor,
      notes,
    },
  };
}

export function validateRulesBundleInput(
  raw: unknown,
  defaultProvenance: ProvenanceSource = 'import',
): ValidationResult<ValidatedRulesBundle> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '/', message: 'bundle must be a JSON object' }] };
  }
  const errors: RuleValidationError[] = [];
  if (raw.schema_version !== 1) {
    errors.push({ path: '/schema_version', message: 'schema_version must be 1' });
  }
  const setsRaw = raw.rule_sets === undefined ? [] : raw.rule_sets;
  if (!Array.isArray(setsRaw)) {
    errors.push({ path: '/rule_sets', message: 'rule_sets must be an array' });
  }
  const policiesRaw = raw.recurring_policies === undefined ? [] : raw.recurring_policies;
  if (!Array.isArray(policiesRaw)) {
    errors.push({ path: '/recurring_policies', message: 'recurring_policies must be an array' });
  }
  if (errors.length > 0) return { ok: false, errors };

  const validatedSets: ValidatedBundleRuleSet[] = [];
  (setsRaw as unknown[]).forEach((item, idx) => {
    const setRes = validateRuleSetInput(item, defaultProvenance);
    if (!setRes.ok) {
      setRes.errors.forEach((e) => errors.push({ path: `/rule_sets/${idx}${e.path}`, message: e.message }));
      return;
    }
    const entriesRaw = isPlainObject(item) && Array.isArray(item.entries) ? item.entries : [];
    const validatedEntries: ValidatedRuleEntryInput[] = [];
    entriesRaw.forEach((entryItem, eIdx) => {
      const entryRes = validateRuleEntryInput(setRes.value.domain, entryItem);
      if (!entryRes.ok) {
        entryRes.errors.forEach((e) => errors.push({ path: `/rule_sets/${idx}/entries/${eIdx}${e.path}`, message: e.message }));
      } else {
        validatedEntries.push(entryRes.value);
      }
    });
    validatedSets.push({ ...setRes.value, entries: validatedEntries });
  });

  const validatedPolicies: ValidatedRecurringPolicyInput[] = [];
  (policiesRaw as unknown[]).forEach((item, idx) => {
    const polRes = validateRecurringPolicyInput(item, defaultProvenance);
    if (!polRes.ok) {
      polRes.errors.forEach((e) => errors.push({ path: `/recurring_policies/${idx}${e.path}`, message: e.message }));
    } else {
      validatedPolicies.push(polRes.value);
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schema_version: 1,
      rule_sets: validatedSets,
      recurring_policies: validatedPolicies,
    },
  };
}
