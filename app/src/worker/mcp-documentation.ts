import { MCP_COMMAND_CATALOG, type McpCommandGroup } from './mcp-command-catalog';
import { STATEMENT_TEMPLATE_SCHEMA } from '../shared/statement-import/template-schema';
import { MCP_RULE_ENTRY_EXAMPLES } from './mcp-rule-examples';

export const MCP_DOCS_INDEX_URI = 'money-flow://docs/';

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function payloadReference(group: McpCommandGroup): string {
  if (group === 'statements') {
    return `\n\n### Statement template document reference\n\nThe document argument of template_create/template_update and the payload of a statement_templates rule share this application schema. It is embedded from the same schema used by the runtime validator, including all nested CSV, XLS, OFX, and PDF fields; no external schema download is needed. PDF template metadata does not replace a pdf_layouts extraction rule.\n\n${jsonBlock(STATEMENT_TEMPLATE_SCHEMA)}\n\nSynthetic CSV document example (adapt column names to the actual file and preview before committing):\n\n${jsonBlock(MCP_RULE_ENTRY_EXAMPLES.statement_templates.payload)}`;
  }
  if (group !== 'rules') return '';
  return `\n\n### Rule entry payload reference\n\nThese are synthetic shapes, not starter data to install. Create only the domain needed by the person's request. For rule_entry_upsert, combine the entry object with rule_set_id, idempotency_key, and confirmation fields from tools/list; use entry_id for an update. For rule_set_create, put entry objects in entries. entry_key is required and at most 128 characters; priority defaults to 100 and enabled to true. Pattern match types are exact, prefix, suffix, contains, tokens, and regex_safe. Patterns are at most 512 characters; regex_safe is at most 300, rejects backreferences, lookbehinds, and nested quantifiers, and matches at most 4096 input characters.\n\n${Object.entries(MCP_RULE_ENTRY_EXAMPLES).map(([domain, entry]) => `### ${domain}\n\n${jsonBlock(entry)}`).join('\n\n')}\n\nCurrency minor_digits is 0..6; symbol is optional. Fiscal payload optional fields: allow_subdomains (boolean), allowed_ports (TCP port array), canonical_path and query_param (strings), pfr_in_text_pattern and vl_token_pattern (safe regex or null), pfr_canonical_uppercase and vl_base64_scan (booleans), default_currency (3-letter code or null), extraction_labels (object of string arrays). allowed_hosts must include canonical_host. ID fields on fiscal/PDF payloads use lowercase letters, digits, dots, underscores, or hyphens, at most 64 characters.\n\nPattern payload options: case_sensitive is boolean; venue trim_result is boolean; order token_group is 0..10 and uppercase is boolean; category subcategory is a string or null. Statement payloads use the complete schema on [the statements page](${MCP_DOCS_INDEX_URI}statements).\n\nPDF layout required fields are id, label, decimal_separator (dot or comma), date_format, detect, row_mode, and row_start_pattern. detect must have a non-empty include_all or include_any string array and may have exclude_any. Date formats: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, DD.MM.YYYY, YYYY/MM/DD. row_mode is single_line_regex or dated_blocks; row_line_pattern is optional. Capture indices date_group, amount_group, debit_group, credit_group, description_group, balance_group, currency_group, and bank_ref_group are integers 0..20. All regex fields use the safe regex limits above. Other optional fields: template_id, currency_code (3-letter code), currency_pattern, account_ref_pattern, account_label, year_pattern; section_start_markers, section_stop_markers, noise_prefixes, noise_contains, debit_indicators, credit_indicators (string arrays); section_signs (objects with marker and sign=1 or -1); balance_at_start_of_block (boolean). opening_balance and closing_balance accept label_prefixes, pattern, decimal_separator, negate_if_contains, positive_if_contains. column_rules accepts credit_headers, debit_headers, balance_headers, ref_pattern, strip_patterns. description_flags is an array of {id: "possible_own_account_transfer", pattern: "safe regex"}. Use statement_import_preview to validate extraction against the person's file.\n\n### Recurring policy and bundle shapes\n\nFor recurring_policy_create, pass a real recurring_item_id from recurring_items_list, policy_type="analytical_skip_only", scope_country, state="draft" or "active", and the confirmation fields from tools/list. Optional effective_from/effective_to are dates or null, priority defaults to 100, and notes is optional. recurring_policy_state_update accepts policy_id, state="active" or "retired", and optional expected_revision. These calls never post operations.\n\nA rules bundle has schema_version=1, rule_sets (array of set definitions with domain, scope_country, scope_locale, set_key, version, state, label, entries, and optional effective dates/priority/fallback/description), and recurring_policies (array of policy definitions). rules_bundle_export is the safest source for a portable bundle of the current workspace; do not invent IDs for bindings in another workspace. Pass that object as bundle to rules_bundle_import with mode="merge" (default) or "replace". mode="replace" retires all active sets and policies before importing.\n`;
}

// Command names and command guidance come only from the catalog. These group
// introductions supply the cross-command workflow and accepted product rules.
export const MCP_DOCS_GROUPS: readonly {
  id: McpCommandGroup;
  title: string;
  guidance: string;
}[] = [
  {
    id: 'accounts',
    title: 'Accounts and account resolution',
    guidance: 'Read accounts before choosing IDs. Account aliases are exact normalized account tokens, separate from merchant display aliases. Resolve first; bind only a listed pending token to an existing account. Archive referenced accounts instead of deleting them.',
  },
  {
    id: 'operations',
    title: 'Operations, transfers, and balance correction',
    guidance: 'Operations are posted financial facts. Use integer minor units in the account currency: expenses are negative, income and refunds positive. Read configured minor_digits rather than assuming every currency has two decimals. Transfers require two distinct accounts and both positive magnitudes in their respective currencies. Edit or delete the pair with transfer tools. Balance correction directly replaces the stored balance; it does not record an adjustment operation.',
  },
  {
    id: 'planning',
    title: 'Plans, recurring schedules, and forecasts',
    guidance: 'Keep expectations separate from posted facts. If payment is already in the ledger, use fulfill_existing to link it rather than posting it again. planned_item_add(done=true), planned_item_update(done=true), and recurring_item_close_period can create financial operations. Skip and cancellation of fulfillment do not reverse money. Opt-in auto_skip_overdue (default false) with auto_skip_after_days (1..365, default 1) lets daily cron skip overdue periods for non-mandatory recurring rules using the local calendar date in cron_timezone (configurable via cron_schedule_get / cron_schedule_set, default 02:00 UTC) without posting operations or changing balances. A recurring analytical skip policy must never post or move money. Read history before changing an occurrence. Forecast days is a horizon from today, default 365, accepted range 1..366.',
  },
  {
    id: 'workspace',
    title: 'Analytics, exchange rates, settings, and backups',
    guidance: 'Read settings and configuration before interpreting conversions. FX rates are reference data, not transfers or payments. Automatic daily FX updates via ExchangeRate-API (no API key) are off by default and controlled with setting_set(key="fx_auto_update", value="1"|"0"), while fx_rates_refresh triggers an immediate refresh with a 60s cooldown. Background cron timezone and per-job local execution hours (0..23, default 02:00 UTC) are inspected with cron_schedule_get and updated with cron_schedule_set (or setting_set for cron_timezone, fx_auto_update_hour, and recurring_auto_skip_hour). For fx_rate_set always pass auto_confirm=false to obtain confirmation; omitting it can write immediately for an authenticated client. Export a backup before an intended replacement or reset. backup_import(dry_run=true) validates without writing; an actual replacement needs the IMPORT phrase and confirmation. data_reset needs RESET and confirmation. MCP inline backup export is capped at 512 KiB; backup import JSON is capped by the 64 KiB request body. Use the app for larger backups.',
  },
  {
    id: 'statements',
    title: 'Statement templates, upload, preview, import, and undo',
    guidance: 'List templates, then preview a bank file before committing. Add or change a statement template or PDF layout only when a bank file cannot be imported and the person wants it recognized. Templates are stored in D1 and an empty list is normal; copy an existing saved template or supply a schema-valid document. There is no built-in starter catalog. Send exactly one of content, content_base64, or upload_id. CSV, Excel .xls/.xlsx, OFX/QFX, and text-layer PDF are supported; photos, scans, and encrypted PDFs are not. The file limit is 1 MiB and the row limit is 2000, including upload transport. Creating an upload slot has write scope but no server confirmation: obtain explicit human confirmation before requesting it, then upload with the returned instructions. The upload slot returns resultType=complete and written=false with upload_id and upload_url because it does not post money. Preview can store confirmation state and consume uploaded bytes without posting money, and can return requestState; commit only after the person confirms that exact preview. Undo uses UNDO IMPORT and mandatory confirmation.',
  },
  {
    id: 'purchase-orders',
    title: 'Provider purchase orders and components',
    guidance: 'Provider orders group documents and expected amounts without changing financial operations, balances, or analytics. A shared date never creates a group. Upsert is first-writer-wins for provider plus provider_order_id; use update for metadata changes. Link an existing fiscal receipt or an expected, never-posted component. Operation-ID links and reconfirmation are unsupported. Use receipt group tools for manual groups. Unlinking or deleting an order preserves posted operations.',
  },
  {
    id: 'receipt-groups',
    title: 'Manual receipt groups',
    guidance: 'Create a group only from at least two distinct, standalone receipts on the same calendar date. Receipt keys are pfr:<canonical> or op:<token> from live receipt data. A receipt cannot belong to another group or provider order. Supply a name if the place cannot be inferred. Grouping, renaming, unlinking, and deleting preserve financial operations and balances. Unlinking can leave one member; the group disappears when no members remain.',
  },
  {
    id: 'rules',
    title: 'Business rules and analytical recurring policies',
    guidance: `Business lists live in D1. Screen words stay in bundled language templates. The setup script writes the database name into local Wrangler configuration; rules do not configure the database address.

Empty optional lists are normal. Do not treat them as a broken app or fill every domain. When no matching normalization rule exists, the stored value is shown. A clean install writes only USD with minor_digits=2 and is_fx_anchor=true, changeable in Settings. Do not write a world currency list.

Add rules only for these concrete needs:

- currency_standards: only when an account, rate, or forecast needs a currency. Use match_type=schema_entry and a payload with code, minor_digits, and is_fx_anchor.
- fiscal_formats: only when a receipt host is unrecognized and the person wants it recognized. Use match_type=url_host and the fiscal host/parser payload.
- merchant_aliases: only to group the same shop under different names. Match merchant text and set payload.target_merchant.
- delivery_services, venue_suffixes, order_hints: only when grouping is wrong and the person wants that pattern. Match store or text with the appropriate label, suffix, or token extraction payload.
- category_rules: only for automatic categorization. Match merchant, description, or any text and supply category and optional subcategory.
- statement_templates and pdf_layouts: only when a bank file cannot be imported and the person wants it recognized. Use match_type=template or layout and the corresponding parser document.
- recurring policy bindings: only policy_type=analytical_skip_only on an existing recurring item. Policies must never post operations or move money.

Read config_runtime_get, rule_sets_list, and rule_set_get before changing rules; read recurring_policies_list before changing policies. Use tools/list for top-level arguments and the payload reference below for nested rule and parser documents. scope_country is a two-letter uppercase code or SHARED; scope_locale is all or a supported locale. Drafts do not affect matching. rule_preview_match evaluates active rules only; it cannot select a draft by ID. For statement templates and PDF layouts, sample is an entry_key, not file content; test real files with statement_import_preview. Inspect draft entries directly before activation, then read back and check effective matching.

Prefer draft versions and clone active or retired sets for edits or rollback. Retired sets cannot be edited. Use expected_revision or expected_set_revision where offered to reject stale changes. Activation retires previous active versions of the same domain, country, locale, and set_key; conflicting overlaps are rejected. Bundle import with mode="replace" retires all active sets and policies before importing, so confirm that scope explicitly.

The rules editor lives in the collapsed Data section. Empty optional lists do not call for a home banner or a list of raw domain IDs. Do not seed production from a skill or onboarding run. Do not put a private ledger, personal statements, or private rule exports in git; use synthetic examples.`,
  },
];

const AGENT_WORKFLOW = `Read the relevant documentation page and tools/list schemas before calling tools. These pages are available through resources/list and resources/read with either read or write scope. They contain no ledger data; documentation access does not grant permission to read or write financial data. Read tools still require read scope, and write tools require write scope. A write-only client must obtain the required live state through a client with read access before proposing a change.

Read before write. Every write needs the person's explicit confirmation of the exact change. No confirmation means no write. Do not use auto_confirm=true to bypass this step, even where the API supports it. For normal writes, start without requestState, omit auto_confirm (except fx_rate_set, where auto_confirm=false is required), and use a fresh idempotency_key. The first response must be input_required with written=false. Present the proposal to the person, then repeat the confirmed arguments and the same key with the returned requestState only after confirmation. Preserve the confirmed payload; when it changes or becomes stale, read again and obtain a new confirmation. An upload slot has no server confirmation flow: get confirmation before calling statement_import_upload_create. backup_import dry-run and previews do not authorize a later write.

Check isError and structuredContent, not just HTTP success. Treat a financial or configuration mutation as complete only when resultType=complete and written=true, then read back the affected records. An upload slot instead returns resultType=complete and written=false with upload_id and upload_url; that confirms the slot, not a ledger import. A timeout or uncertain result is not permission to retry with a fresh key; reconcile current state and reuse the original key and payload as supported. Never invent account IDs, currency precision, rule payloads, or a successful write.

Each command below has a purpose, when to call, and when not to call. The literal "not stated" means the tool description and implementation provide no additional command-specific prohibition; scope, schema, read-before-write, and confirmation rules still apply. "API confirmation behavior" describes current transport capabilities, not permission to bypass the agent workflow above.`;

export const MCP_DOCUMENTATION_RESOURCES = [
  {
    uri: MCP_DOCS_INDEX_URI,
    name: 'Money Flow documentation index',
    description: 'Start here: agent workflow and the complete MCP command reference by group.',
    mimeType: 'text/markdown',
  },
  ...MCP_DOCS_GROUPS.map((group) => ({
    uri: `${MCP_DOCS_INDEX_URI}${group.id}`,
    name: group.title,
    description: `Purpose, call guidance, restrictions, and confirmation behavior for ${group.title.toLowerCase()}.`,
    mimeType: 'text/markdown',
  })),
] as const;

export function readMcpDocumentation(uri: string): string | undefined {
  if (uri === MCP_DOCS_INDEX_URI) {
    return `# Money Flow MCP documentation\n\n${AGENT_WORKFLOW}\n\n## Command groups\n\n${MCP_DOCS_GROUPS.map((group) => {
      const count = MCP_COMMAND_CATALOG.filter((entry) => entry.group === group.id).length;
      return `- [${group.title}](${MCP_DOCS_INDEX_URI}${group.id}) — ${count} commands`;
    }).join('\n')}\n\nUse resources/read with a listed URI to open a page. Use tools/list for per-command descriptions and argument schemas. No git checkout, GitHub access, or repository skill installation is needed, and these resources remain readable even without a prior initialize handshake.\n`;
  }

  const group = MCP_DOCS_GROUPS.find((candidate) => uri === `${MCP_DOCS_INDEX_URI}${candidate.id}`);
  if (!group) return undefined;
  const commands = MCP_COMMAND_CATALOG.filter((entry) => entry.group === group.id);
  return `# ${group.title}\n\n[Documentation index](${MCP_DOCS_INDEX_URI}) — read the agent workflow before writing.\n\n${group.guidance}${payloadReference(group.id)}\n\n${commands.map((entry) => `## ${entry.name}\n\n- Scope: ${entry.access}\n- Purpose: ${entry.purpose}\n- When to call: ${entry.whenToCall}\n- When not to call: ${entry.whenNotToCall}\n- API confirmation behavior (${entry.writeConfirmation}): ${entry.confirmationPolicy}`).join('\n\n')}\n`;
}
