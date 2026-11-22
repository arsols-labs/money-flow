// Reusable test-only fixtures for D1 rule sets and currency standards.
// Nothing here is shipped in production bundle code (`app/src/` stays empty-by-default).
import {
  buildCurrencyCatalog,
  setRuntimeCurrencyCatalog,
  type CurrencyCatalog,
} from '../src/shared/currency';
import type {
  CurrencyStandardPayload,
  DeliveryServicePayload,
  FiscalFormatPayload,
  MatchType,
  MerchantAliasPayload,
  OrderHintPayload,
  PdfLayoutPayload,
  ResolvedRuleEntry,
  RuleDomain,
  VenueSuffixPayload,
} from '../src/shared/rules/types';
import type { StatementTemplate } from '../src/shared/statement-import/template-schema';
import { invalidateRulesCache } from '../src/worker/rules-store';

export const TEST_CURRENCY_STANDARDS: readonly CurrencyStandardPayload[] = [
  { code: 'USD', minor_digits: 2, symbol: '$', is_fx_anchor: true },
  { code: 'EUR', minor_digits: 2, symbol: '€', is_fx_anchor: false },
  { code: 'GBP', minor_digits: 2, symbol: '£', is_fx_anchor: false },
  { code: 'CAD', minor_digits: 2, symbol: 'CA$', is_fx_anchor: false },
  { code: 'RSD', minor_digits: 2, symbol: 'RSD', is_fx_anchor: false },
  { code: 'JPY', minor_digits: 0, symbol: '¥', is_fx_anchor: false },
  { code: 'CHF', minor_digits: 2, symbol: 'CHF', is_fx_anchor: false },
  { code: 'BAM', minor_digits: 2, symbol: 'KM', is_fx_anchor: false },
  { code: 'MKD', minor_digits: 2, symbol: 'MKD', is_fx_anchor: false },
  { code: 'RUB', minor_digits: 2, symbol: '₽', is_fx_anchor: false },
  { code: 'KWD', minor_digits: 3, symbol: 'KWD', is_fx_anchor: false },
  { code: 'CLF', minor_digits: 4, symbol: 'CLF', is_fx_anchor: false },
];

export const TEST_CURRENCY_CATALOG: CurrencyCatalog = buildCurrencyCatalog(TEST_CURRENCY_STANDARDS);

export function installTestRuntimeCurrencies(
  entries: readonly CurrencyStandardPayload[] = TEST_CURRENCY_STANDARDS,
): CurrencyCatalog {
  const catalog = buildCurrencyCatalog(entries);
  setRuntimeCurrencyCatalog(catalog);
  return catalog;
}

export function makeTestResolvedRuleEntry<T>(
  domain: RuleDomain,
  entryKey: string,
  matchType: MatchType | null,
  pattern: string | null,
  payload: T,
  priority = 100,
): ResolvedRuleEntry<T> {
  const now = '2026-01-01T00:00:00Z';
  return {
    entry: {
      id: 1,
      rule_set_id: 1,
      entry_key: entryKey,
      match_type: matchType,
      match_field: 'any',
      pattern,
      priority,
      enabled: 1,
      payload_json: JSON.stringify(payload),
      meta_json: null,
      revision: 1,
      created_at: now,
      updated_at: now,
    },
    set: {
      id: 1,
      domain,
      scope_country: 'SHARED',
      scope_locale: '',
      set_key: `test-${domain}`,
      version: 1,
      state: 'active',
      effective_from: null,
      effective_to: null,
      priority: 100,
      allow_shared_fallback: 1,
      label: `test-${domain}`,
      description: null,
      provenance_source: 'api',
      provenance_actor: 'test',
      revision: 1,
      activated_at: now,
      retired_at: null,
      created_at: now,
      updated_at: now,
    },
    specificity: 1,
    payload,
  };
}

export const TEST_FISCAL_FORMATS: readonly FiscalFormatPayload[] = [
  {
    id: 'rs-purs',
    label: 'Serbia PURS TaxCore',
    canonical_scheme: 'https',
    canonical_host: 'suf.purs.gov.rs',
    allowed_hosts: ['suf.purs.gov.rs', 'pos.purs.gov.rs', 'purs.gov.rs'],
    allow_subdomains: true,
    canonical_path: '/v/',
    query_param: 'vl',
    vl_base64_scan: true,
    pfr_in_text_pattern: '([A-Z0-9]{8}-[A-Z0-9]{8}-\\d+)',
    pfr_canonical_uppercase: true,
    default_currency: 'RSD',
  },
  {
    id: 'demo-fiscal',
    label: 'Demo Fiscal URL',
    canonical_scheme: 'https',
    canonical_host: 'example.com',
    allowed_hosts: ['example.com'],
    canonical_path: '/receipts/',
    pfr_in_text_pattern: '(DEMO-FISCAL-[0-9]+)',
    pfr_canonical_uppercase: true,
    default_currency: 'USD',
  },
];

export const TEST_DELIVERY_SERVICES: readonly { key: string; pattern: string; payload: DeliveryServicePayload }[] = [
  { key: 'wolt', pattern: 'Wolt', payload: { label: 'Wolt' } },
  { key: 'glovo', pattern: 'Glovo', payload: { label: 'Glovo' } },
];

export const TEST_VENUE_SUFFIXES: readonly { key: string; pattern: string; payload: VenueSuffixPayload }[] = [
  { key: 'food', pattern: 'Food', payload: { label: 'Food', trim_result: true } },
  { key: 'bar', pattern: 'Bar', payload: { label: 'Bar', trim_result: true } },
  { key: 'kitchen', pattern: 'Kitchen', payload: { label: 'Kitchen', trim_result: true } },
  { key: 'kuhinja-cyr', pattern: 'кухня', payload: { label: 'кухня', trim_result: true } },
  { key: 'bar-cyr', pattern: 'бар', payload: { label: 'бар', trim_result: true } },
];

export const TEST_MERCHANT_ALIASES: readonly { key: string; match_type: 'tokens' | 'contains'; pattern: string; payload: MerchantAliasPayload }[] = [
  { key: 'uber', match_type: 'tokens', pattern: 'UBER', payload: { target_merchant: 'Uber' } },
  { key: 'dr-max', match_type: 'tokens', pattern: 'DR.MAX', payload: { target_merchant: 'Dr. Max' } },
  { key: 'dr-max-spaced', match_type: 'tokens', pattern: 'DR. MAX', payload: { target_merchant: 'Dr. Max' } },
  { key: 'dr-maxi', match_type: 'tokens', pattern: 'DR.MAXI', payload: { target_merchant: 'Maxi' } },
  { key: 'maxi', match_type: 'tokens', pattern: 'MAXI', payload: { target_merchant: 'Maxi' } },
  { key: 'posta', match_type: 'tokens', pattern: 'POSTA SRBIJE', payload: { target_merchant: 'Pošta Srbije' } },
  { key: 'posta-cyr', match_type: 'tokens', pattern: 'ПОШТА', payload: { target_merchant: 'Pošta Srbije' } },
];

export const TEST_ORDER_HINTS: readonly { key: string; pattern: string; payload: OrderHintPayload }[] = [
  { key: 'wolt-order', pattern: 'Wolt\\s+(?:order\\s+)?([A-Z0-9-]{6,32})', payload: { label: 'Wolt Order', token_group: 1, uppercase: false } },
  { key: 'delivery-order', pattern: 'Delivery\\s+order\\s+([A-Z0-9-]{6,32})', payload: { label: 'Delivery Order', token_group: 1, uppercase: false } },
  { key: 'order-hash', pattern: 'ORDER\\s*#([A-Z0-9-]{6,32})', payload: { label: 'Order #', token_group: 1, uppercase: false } },
];

export const TEST_STATEMENT_TEMPLATES: readonly StatementTemplate[] = [
  {
    schemaVersion: 1,
    id: 'us-bofa',
    label: 'Bank of America',
    format: 'csv',
    csv: {
      mapping: { date: 'Date', description: 'Description', amount: 'Amount', balance: 'Running Bal.' },
      options: {
        delimiter: ',',
        decimalSeparator: '.',
        dateFormat: 'MM/DD/YYYY',
        encoding: 'utf-8',
        hasHeader: true,
        defaultCurrency: 'USD',
        skipEmptyAmount: true,
        checkRunningBalance: true,
      },
    },
  },
  {
    schemaVersion: 1,
    id: 'us-bofa-pdf',
    label: 'Bank of America PDF',
    format: 'pdf',
    pdf: { textLayer: true, pageSize: 'Letter' },
  },
  {
    schemaVersion: 1,
    id: 'rs-bps',
    label: 'Banka Poštanska štedionica',
    format: 'xls',
    xls: {
      sheetName: 'Sheet1',
      accountLabel: 'Account',
      accountAliases: ['account', 'account number', 'racun', 'broj racuna'],
      dateFormat: 'DD/MM/YYYY',
      decimalSeparator: '.',
      amountMode: 'credit-debit',
      currencyMode: 'per-row',
      columns: {
        valueDate: { index: 1, header: 'Value date' },
        transactionDate: { index: 2, header: 'Transaction date' },
        currency: { index: 6, header: 'Currency code' },
        credit: { index: 8, header: 'Credit' },
        debit: { index: 10, header: 'Debit' },
        description: { index: 12, header: 'Description' },
      },
      headerAliases: {
        valueDate: ['value date', 'datum valute'],
        transactionDate: ['transaction date', 'datum transakcije', 'datum knjizenja', 'datum prometa'],
        currency: ['currency code', 'oznaka valute', 'sifra valute', 'currency', 'valuta'],
        credit: ['credit', 'potrazuje', 'potrazivanje', 'odobrenje', 'uplata'],
        debit: ['debit', 'duguje', 'dugovanje', 'zaduzenje', 'isplata'],
        description: ['description', 'opis transakcije', 'opis'],
      },
      descriptionFlags: [
        { id: 'possible_own_account_transfer', pattern: 'otkup strane valute' },
      ],
    },
  },
  {
    schemaVersion: 1,
    id: 'rs-bps-pdf',
    label: 'Banka Poštanska štedionica PDF',
    format: 'pdf',
    pdf: { textLayer: true, pageSize: 'A4' },
  },
];

export const TEST_PDF_LAYOUTS: readonly PdfLayoutPayload[] = [
  {
    id: 'us-bofa-pdf',
    label: 'Bank of America Statement PDF',
    template_id: 'us-bofa-pdf',
    currency_code: 'USD',
    decimal_separator: '.',
    date_format: 'MM/DD/YYYY',
    detect: { include_all: ['Adv SafeBalance Banking'] },
    account_ref_pattern: 'Account number:\\s*([0-9 ]+)',
    opening_balance: { label_prefixes: ['Beginning balance'] },
    closing_balance: { label_prefixes: ['Ending balance'] },
    section_signs: [
      { marker: 'Deposits and other additions', sign: 1 },
      { marker: 'Withdrawals and other subtractions', sign: -1 },
      { marker: 'ATM and debit card subtractions', sign: -1 },
      { marker: 'Other subtractions', sign: -1 },
      { marker: 'Service fees', sign: -1 },
    ],
    section_stop_markers: ['IMPORTANT INFORMATION', 'This page intentionally left blank'],
    noise_prefixes: ['Date ', 'Total ', 'continued on', 'PULL:', 'PLACEHOLDER !', '©'],
    row_mode: 'single_line_regex',
    row_start_pattern: '^(\\d{2}/\\d{2}/\\d{2})\\s+(.+?)\\s+(-?[\\d,]+\\.\\d{2})$',
    date_group: 1,
    description_group: 2,
    amount_group: 3,
  },
  {
    id: 'rs-bps-pdf',
    label: 'BPS IZVOD RSD PDF',
    template_id: 'rs-bps-pdf',
    currency_code: 'RSD',
    decimal_separator: '.',
    date_format: 'DD.MM.YYYY',
    detect: { include_all: ['IZVOD BROJ'] },
    account_ref_pattern: 'Ra[cč]un:\\s*([0-9-]+)',
    opening_balance: { label_prefixes: ['Prethodno stanje'] },
    closing_balance: { label_prefixes: ['Novo stanje'] },
    section_stop_markers: ['UKUPNO ZA IZVOD'],
    noise_prefixes: ['Strana:', 'IZVOD BROJ', 'Od:', 'Komitent:', 'Sif.pl', 'Asseco SEE', 'NEREALIZOVANI', 'KAMATNE STOPE', 'Banka ', 'Sinteti'],
    row_mode: 'dated_blocks',
    row_start_pattern: '^\\d+\\.\\s+(\\d{2}\\.\\d{2}\\.\\d{4})\\b',
    date_group: 1,
    column_rules: {
      credit_headers: ['Potražuje', 'Potrazuje'],
      debit_headers: ['Duguje'],
      balance_headers: ['Stanje:', 'Stanje'],
      ref_pattern: 'Poziv za reklamaciju:\\s*([A-Z0-9-]+)',
      strip_patterns: [
        'Poziv za reklamaciju:\\s*[A-Z0-9-]+',
        'Vreme prijema:\\s*\\d{2}\\.\\d{2}\\.\\d{4}',
        'Iznos transakcije:.*',
        '^\\d+\\.(?=\\s|$)',
        '\\s*:(?=\\s*[0-9*])',
      ],
    },
    description_flags: [
      { id: 'possible_own_account_transfer', pattern: 'otkup strane valute' },
    ],
  },
  {
    id: 'rs-bps-fx-pdf',
    label: 'BPS FX Promene PDF',
    template_id: 'rs-bps',
    currency_pattern: '\\bu\\s+([A-Z]{3})\\b',
    decimal_separator: ',',
    date_format: 'DD.MM.YYYY',
    detect: { include_all: ['ZA TEKUCI RACUN BROJ'] },
    account_ref_pattern: 'ZA TEKUCI RACUN BROJ:\\s*([0-9-]+)',
    year_pattern: 'PROMENE U PERIODU:\\s*\\d{2}\\.\\d{2}\\.(\\d{2,4})\\s*-\\s*\\d{2}\\.\\d{2}\\.(\\d{2,4})',
    opening_balance: { label_prefixes: ['PRETHODNO STANJE'] },
    noise_prefixes: ['Izvod br:', 'ZA TEKUCI RACUN', 'u USD', 'u EUR', 'DATUM ', 'Valuta '],
    row_mode: 'single_line_regex',
    row_start_pattern: '^(\\d{2}\\.\\d{2}\\.?)\\s+(.+?)\\s+((?:\\d*,\\d{2}-?|\\d{1,3}(?:\\.\\d\\d\\d)*,\\d{2}-?))\\s+((?:\\d{1,3}(?:\\.\\d\\d\\d)*|\\d+),\\d{2})$',
    date_group: 1,
    description_group: 2,
    amount_group: 3,
    balance_group: 4,
    description_flags: [
      { id: 'possible_own_account_transfer', pattern: 'otkup strane' },
    ],
  },
];

interface SeedEntrySpec {
  entry_key: string;
  match_type: string;
  match_field: string;
  pattern: string | null;
  priority: number;
  payload: unknown;
}

async function seedRuleSetBatch(
  db: D1Database,
  specs: Array<{
    domain: RuleDomain;
    scope_country: string;
    scope_locale?: string;
    set_key: string;
    label: string;
    entries: SeedEntrySpec[];
  }>,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const spec of specs) {
    const scopeLocale = spec.scope_locale ?? '';
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO rule_sets (
          domain, scope_country, scope_locale, set_key, version, state,
          effective_from, effective_to, priority, allow_shared_fallback,
          label, description, provenance_source, provenance_actor,
          revision, activated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'active', NULL, NULL, 100, 1, ?, NULL, 'api', 'test-seed', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      ).bind(spec.domain, spec.scope_country, scopeLocale, spec.set_key, spec.label),
    );
    for (const entry of spec.entries) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO rule_entries (
            rule_set_id, entry_key, match_type, match_field, pattern,
            priority, enabled, payload_json, meta_json, revision, created_at, updated_at
          )
          SELECT rs.id, ?, ?, ?, ?, ?, 1, ?, NULL, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          FROM rule_sets rs
          WHERE rs.domain = ? AND rs.scope_country = ? AND rs.scope_locale = ? AND rs.set_key = ? AND rs.version = 1`,
        ).bind(
          entry.entry_key,
          entry.match_type,
          entry.match_field,
          entry.pattern,
          entry.priority,
          JSON.stringify(entry.payload),
          spec.domain,
          spec.scope_country,
          scopeLocale,
          spec.set_key,
        ),
      );
    }
  }
  if (stmts.length > 0) {
    await db.batch(stmts);
  }
  invalidateRulesCache(db);
}

export async function seedTestCurrencyRules(
  db: D1Database,
  currencies: readonly CurrencyStandardPayload[] = TEST_CURRENCY_STANDARDS,
): Promise<void> {
  await seedRuleSetBatch(db, [
    {
      domain: 'currency_standards',
      scope_country: 'SHARED',
      set_key: 'test-currencies',
      label: 'Test Currency Standards',
      entries: currencies.map((c, idx) => ({
        entry_key: c.code,
        match_type: 'exact',
        match_field: 'code',
        pattern: c.code,
        priority: (idx + 1) * 10,
        payload: c,
      })),
    },
  ]);
}

export async function seedTestFiscalRules(db: D1Database): Promise<void> {
  await seedRuleSetBatch(db, [
    {
      domain: 'fiscal_formats',
      scope_country: 'SHARED',
      set_key: 'test-fiscal-formats',
      label: 'Test Fiscal Formats',
      entries: TEST_FISCAL_FORMATS.map((f, idx) => ({
        entry_key: f.id,
        match_type: 'url_host',
        match_field: 'url',
        pattern: f.canonical_host,
        priority: (idx + 1) * 10,
        payload: f,
      })),
    },
  ]);
}

export async function seedTestDeliveryAndVenueRules(db: D1Database): Promise<void> {
  await seedRuleSetBatch(db, [
    {
      domain: 'delivery_services',
      scope_country: 'SHARED',
      set_key: 'test-delivery-services',
      label: 'Test Delivery Services',
      entries: TEST_DELIVERY_SERVICES.map((d, idx) => ({
        entry_key: d.key,
        match_type: 'tokens',
        match_field: 'store',
        pattern: d.pattern,
        priority: (idx + 1) * 10,
        payload: d.payload,
      })),
    },
    {
      domain: 'venue_suffixes',
      scope_country: 'SHARED',
      set_key: 'test-venue-suffixes',
      label: 'Test Venue Suffixes',
      entries: TEST_VENUE_SUFFIXES.map((v, idx) => ({
        entry_key: v.key,
        match_type: 'suffix',
        match_field: 'store',
        pattern: v.pattern,
        priority: (idx + 1) * 10,
        payload: v.payload,
      })),
    },
    {
      domain: 'merchant_aliases',
      scope_country: 'SHARED',
      set_key: 'test-merchant-aliases',
      label: 'Test Merchant Aliases',
      entries: TEST_MERCHANT_ALIASES.map((m, idx) => ({
        entry_key: m.key,
        match_type: m.match_type,
        match_field: 'merchant',
        pattern: m.pattern,
        priority: (idx + 1) * 10,
        payload: m.payload,
      })),
    },
    {
      domain: 'order_hints',
      scope_country: 'SHARED',
      set_key: 'test-order-hints',
      label: 'Test Order Hints',
      entries: TEST_ORDER_HINTS.map((h, idx) => ({
        entry_key: h.key,
        match_type: 'regex_safe',
        match_field: 'any',
        pattern: h.pattern,
        priority: (idx + 1) * 10,
        payload: h.payload,
      })),
    },
  ]);
}

export async function seedTestStatementRules(db: D1Database): Promise<void> {
  await seedRuleSetBatch(db, [
    {
      domain: 'statement_templates',
      scope_country: 'SHARED',
      set_key: 'test-statement-templates',
      label: 'Test Statement Templates',
      entries: TEST_STATEMENT_TEMPLATES.map((t, idx) => ({
        entry_key: t.id,
        match_type: 'template',
        match_field: 'any',
        pattern: t.id,
        priority: (TEST_STATEMENT_TEMPLATES.length - idx) * 100,
        payload: t,
      })),
    },
    {
      domain: 'pdf_layouts',
      scope_country: 'SHARED',
      set_key: 'test-pdf-layouts',
      label: 'Test PDF Layouts',
      entries: TEST_PDF_LAYOUTS.map((l, idx) => ({
        entry_key: l.id,
        match_type: 'layout',
        match_field: 'text',
        pattern: l.id,
        priority: (TEST_PDF_LAYOUTS.length - idx) * 100,
        payload: l,
      })),
    },
  ]);
}

export async function seedTestRecurringPolicies(
  db: D1Database,
  recurringItemIds: readonly number[] = [16, 17],
): Promise<void> {
  const stmts = recurringItemIds.map((id) =>
    db.prepare(
      `INSERT OR IGNORE INTO recurring_policy_bindings (
        recurring_item_id, policy_type, scope_country, version, state,
        effective_from, effective_to, priority, provenance_source, provenance_actor,
        revision, notes, created_at, updated_at
      ) VALUES (?, 'analytical_skip_only', 'SHARED', 1, 'active', NULL, NULL, 100, 'api', 'test-seed', 1, 'test analytical policy', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ).bind(id),
  );
  if (stmts.length > 0) await db.batch(stmts);
  invalidateRulesCache(db);
}

export async function seedAllTestRules(db: D1Database): Promise<void> {
  await seedTestCurrencyRules(db);
  await seedTestFiscalRules(db);
  await seedTestDeliveryAndVenueRules(db);
  await seedTestStatementRules(db);
}
