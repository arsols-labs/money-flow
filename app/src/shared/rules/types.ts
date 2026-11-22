export const RULE_DOMAINS = [
  'currency_standards',
  'fiscal_formats',
  'merchant_aliases',
  'delivery_services',
  'venue_suffixes',
  'order_hints',
  'category_rules',
  'statement_templates',
  'pdf_layouts',
] as const;

export type RuleDomain = (typeof RULE_DOMAINS)[number];

export const RULE_SET_STATES = ['draft', 'active', 'retired'] as const;
export type RuleSetState = (typeof RULE_SET_STATES)[number];

export const PROVENANCE_SOURCES = ['api', 'mcp', 'backup', 'ui', 'import'] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

export const MATCH_TYPES = [
  'exact',
  'prefix',
  'suffix',
  'contains',
  'tokens',
  'regex_safe',
  'url_host',
  'layout',
  'template',
  'schema_entry',
] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const MATCH_FIELDS = [
  'merchant',
  'description',
  'store',
  'any',
  'url',
  'text',
  'pfr',
  'code',
] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

export const RECURRING_POLICY_TYPES = ['analytical_skip_only'] as const;
export type RecurringPolicyType = (typeof RECURRING_POLICY_TYPES)[number];

export const SHARED_COUNTRY = 'SHARED';

export interface CurrencyStandardPayload {
  code: string;
  minor_digits: number;
  symbol?: string | null;
  is_fx_anchor?: boolean;
}

export interface FiscalFormatPayload {
  id: string;
  label: string;
  canonical_scheme: 'https' | 'http';
  canonical_host: string;
  allowed_hosts: string[];
  allow_subdomains?: boolean;
  allowed_ports?: number[];
  canonical_path?: string;
  query_param?: string;
  pfr_in_text_pattern?: string | null;
  pfr_canonical_uppercase?: boolean;
  vl_base64_scan?: boolean;
  vl_token_pattern?: string | null;
  default_currency?: string | null;
  extraction_labels?: Record<string, string[]>;
}

export interface MerchantAliasPayload {
  target_merchant: string;
  case_sensitive?: boolean;
}

export interface DeliveryServicePayload {
  label: string;
  case_sensitive?: boolean;
}

export interface VenueSuffixPayload {
  label: string;
  case_sensitive?: boolean;
  trim_result?: boolean;
}

export interface OrderHintPayload {
  label: string;
  token_group?: number;
  uppercase?: boolean;
  case_sensitive?: boolean;
}

export interface CategoryRulePayload {
  category: string;
  subcategory: string | null;
}

export interface PdfBalanceRule {
  label_prefixes?: string[];
  pattern?: string | null;
  decimal_separator?: '.' | ',';
  negate_if_contains?: string[];
  positive_if_contains?: string[];
}

export interface PdfDescriptionFlagRule {
  id: 'possible_own_account_transfer';
  pattern: string;
}

export interface PdfSectionSignRule {
  marker: string;
  sign: 1 | -1;
}

export interface PdfColumnRules {
  credit_headers?: string[];
  debit_headers?: string[];
  balance_headers?: string[];
  ref_pattern?: string | null;
  strip_patterns?: string[];
}

export interface PdfLayoutPayload {
  id: string;
  label: string;
  /** Optional linked statement template id (e.g. from statement_templates). */
  template_id?: string | null;
  /** Default currency code when not extracted dynamically from document text. */
  currency_code?: string | null;
  /** Bounded safe regex capturing 3-letter currency code in group 1 or full match. */
  currency_pattern?: string | null;
  decimal_separator: '.' | ',';
  date_format: 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'DD.MM.YYYY' | 'YYYY/MM/DD';
  detect: {
    include_all?: string[];
    include_any?: string[];
    exclude_any?: string[];
  };
  account_ref_pattern?: string | null;
  account_label?: string | null;
  year_pattern?: string | null;
  section_start_markers?: string[];
  section_stop_markers?: string[];
  section_signs?: PdfSectionSignRule[];
  noise_prefixes?: string[];
  noise_contains?: string[];
  opening_balance?: PdfBalanceRule | null;
  closing_balance?: PdfBalanceRule | null;
  /**
   * 'single_line_regex' matches each line (after optional date-line joining);
   * 'dated_blocks' collects blocks starting with `row_start_pattern`.
   */
  row_mode: 'single_line_regex' | 'dated_blocks';
  row_start_pattern: string;
  row_line_pattern?: string | null;
  /** Field extraction rules when row_mode is 'dated_blocks' or 'single_line_regex'. */
  date_group?: number;
  amount_group?: number;
  debit_group?: number;
  credit_group?: number;
  description_group?: number;
  balance_group?: number;
  currency_group?: number;
  bank_ref_group?: number;
  debit_indicators?: string[];
  credit_indicators?: string[];
  balance_at_start_of_block?: boolean;
  column_rules?: PdfColumnRules | null;
  description_flags?: PdfDescriptionFlagRule[];
}

export interface RuleSetRecord {
  id: number;
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
  revision: number;
  activated_at: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuleEntryRecord {
  id: number;
  rule_set_id: number;
  entry_key: string;
  match_type: MatchType | null;
  match_field: MatchField | null;
  pattern: string | null;
  priority: number;
  enabled: number;
  payload_json: string;
  meta_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ResolvedRuleEntry<T = Record<string, unknown>> {
  entry: RuleEntryRecord;
  set: RuleSetRecord;
  specificity: number;
  payload: T;
}

export interface RecurringPolicyBindingRecord {
  id: number;
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
  revision: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainReadiness {
  domain: RuleDomain | 'recurring_policies';
  active_sets: number;
  active_entries: number;
  configured: boolean;
}
