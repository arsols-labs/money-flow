import type { RuleDomain } from '../shared/rules';

// Synthetic shapes, validated with the API validators in documentation tests.
// They are documentation examples, never installer defaults or seed data.
export const MCP_RULE_ENTRY_EXAMPLES: Record<RuleDomain, Record<string, unknown>> = {
  currency_standards: {
    entry_key: 'example-usd', match_type: 'schema_entry', match_field: 'code', pattern: 'USD',
    payload: { code: 'USD', minor_digits: 2, is_fx_anchor: true },
  },
  fiscal_formats: {
    entry_key: 'example-receipt', match_type: 'url_host', match_field: 'url',
    payload: { id: 'example-receipt', label: 'Example receipt host', canonical_scheme: 'https', canonical_host: 'receipts.example.com', allowed_hosts: ['receipts.example.com'], query_param: 'pfr' },
  },
  merchant_aliases: {
    entry_key: 'example-market', match_type: 'exact', match_field: 'merchant', pattern: 'EXAMPLE MARKET',
    payload: { target_merchant: 'Example Market', case_sensitive: false },
  },
  delivery_services: {
    entry_key: 'example-delivery', match_type: 'contains', match_field: 'store', pattern: 'Example Delivery',
    payload: { label: 'Example Delivery', case_sensitive: false },
  },
  venue_suffixes: {
    entry_key: 'example-branch', match_type: 'suffix', match_field: 'store', pattern: ' - Example Branch',
    payload: { label: 'Example branch suffix', trim_result: true },
  },
  order_hints: {
    entry_key: 'example-order', match_type: 'regex_safe', match_field: 'text', pattern: 'Order ([A-Z0-9-]+)',
    payload: { label: 'Example order reference', token_group: 1, uppercase: true },
  },
  category_rules: {
    entry_key: 'example-category', match_type: 'contains', match_field: 'description', pattern: 'Example Market',
    payload: { category: 'Groceries', subcategory: null },
  },
  statement_templates: {
    entry_key: 'example-csv', match_type: 'template',
    payload: {
      schemaVersion: 1, id: 'example-csv', label: 'Example CSV', format: 'csv',
      csv: {
        mapping: { date: 'Date', description: 'Description', amount: 'Amount' },
        options: { delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', encoding: 'utf-8', hasHeader: true, defaultCurrency: 'USD' },
      },
    },
  },
  pdf_layouts: {
    entry_key: 'example-pdf', match_type: 'layout', match_field: 'text',
    payload: {
      id: 'example-pdf', label: 'Example text PDF', currency_code: 'USD',
      decimal_separator: '.', date_format: 'YYYY-MM-DD', detect: { include_all: ['Example Bank Statement'] },
      row_mode: 'single_line_regex', row_start_pattern: '^(\\d{4}-\\d{2}-\\d{2}) (.+) (-?\\d+\\.\\d{2})$',
      date_group: 1, description_group: 2, amount_group: 3,
    },
  },
};
