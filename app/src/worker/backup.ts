// Full-user-state D1 backup (issue #515).
//
// Dump is a versioned JSON envelope of user-owned tables. Auth/session tables
// (oauth_*, mcp_audit_log) and R2 receipt files stay on the instance: they are
// not portable financial state. Receipt *rows* are included so operations with
// receipt_id remain valid after restore.
//
// Import is replace-with-confirmation: validate first, then one D1 batch
// deletes user tables and inserts the dump. A failed batch leaves the previous
// state untouched.

import { ValidationError } from './api-error';
import { parseHttpUrl } from '../shared/http-url';
import { FISCAL_RECEIPT_ID_MAX_LENGTH } from '../shared/fiscal-receipts';

export const BACKUP_FORMAT = 'money-flow-v2-backup';
export const BACKUP_VERSION = 1;

export const USER_TABLES = [
  'settings',
  'accounts',
  'fx_rates',
  'receipts',
  'pending_account_strings',
  'account_aliases',
  'planned_items',
  'recurring_items',
  'transfers',
  'operations',
  'recurring_period_fulfillments',
  'imported_receipt_items',
  'operation_fulfillment_links',
] as const;

export type UserTableName = (typeof USER_TABLES)[number];

export const EXCLUDED_FROM_BACKUP = [
  'oauth_clients',
  'oauth_consents',
  'oauth_tokens',
  'mcp_audit_log',
] as const;

// Typed confirm token for in-app reset (issue #579). Stable across locales.
export const RESET_CONFIRM_PHRASE = 'RESET';

export const EMPTY_INSTANCE_SETTINGS = [
  { key: 'base_currency', value: 'USD' },
  { key: 'low_balance_threshold_minor', value: '100000' },
] as const;

const PRESERVED_SETTING_EXACT = new Set(['auth_epoch']);
const PRESERVED_SETTING_PREFIXES = [
  'session_revoked:',
  'passkey_revoked:',
  'passkey_disabled:',
] as const;

export function isPreservedSettingKey(key: string): boolean {
  if (PRESERVED_SETTING_EXACT.has(key)) return true;
  return PRESERVED_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const DELETE_ORDER: UserTableName[] = [
  'operation_fulfillment_links',
  'imported_receipt_items',
  'recurring_period_fulfillments',
  'operations',
  'transfers',
  'planned_items',
  'recurring_items',
  'account_aliases',
  'pending_account_strings',
  'receipts',
  'fx_rates',
  'accounts',
  'settings',
];

const INSERT_ORDER: UserTableName[] = [
  'settings',
  'accounts',
  'fx_rates',
  'receipts',
  'pending_account_strings',
  'account_aliases',
  'planned_items',
  'recurring_items',
  'transfers',
  'operations',
  'recurring_period_fulfillments',
  'imported_receipt_items',
  'operation_fulfillment_links',
];

const TABLE_COLUMNS: Record<UserTableName, readonly string[]> = {
  settings: ['key', 'value'],
  accounts: [
    'id', 'name', 'bank', 'type', 'owner', 'country', 'currency',
    'balance_minor', 'balance_updated_at', 'sort', 'archived', 'account_number',
  ],
  fx_rates: ['code', 'rate_e9', 'updated_at'],
  receipts: ['id', 'r2_key', 'status', 'parsed_json', 'error', 'created_at'],
  pending_account_strings: ['id', 'raw_string', 'raw_norm', 'first_seen_at'],
  account_aliases: ['id', 'account_id', 'alias_text', 'alias_norm', 'created_at'],
  planned_items: [
    'id', 'date', 'title', 'amount_minor', 'currency', 'account_id',
    'category', 'done', 'revision',
  ],
  recurring_items: [
    'id', 'title', 'amount_minor', 'currency', 'account_id', 'category',
    'frequency', 'interval_count', 'day_of_month', 'month_of_year',
    'next_due_date', 'active', 'end_date', 'revision',
  ],
  transfers: ['id'],
  operations: [
    'id', 'date', 'account_id', 'kind', 'store', 'item', 'category',
    'subcategory', 'amount_minor', 'receipt_id', 'source', 'planned_item_id',
    'recurring_item_id', 'transfer_id', 'comment', 'receipt_url', 'fiscal_receipt_id',
  ],
  recurring_period_fulfillments: [
    'recurring_item_id', 'period_due_date', 'outcome', 'evidence_quantity', 'fulfilled_at',
  ],
  imported_receipt_items: [
    'id', 'receipt_id', 'line_no', 'operation_id', 'account_id',
    'amount_minor', 'currency', 'imported_at',
  ],
  operation_fulfillment_links: [
    'operation_id', 'planned_item_id', 'recurring_item_id', 'period_due_date',
    'fulfillment_type', 'linked_at',
  ],
};

// D1 rejects a statement with more than 100 bound parameters. Chunk size
// must shrink as the table gets wider (accounts: 12 columns → 8 rows).
export const D1_MAX_BOUND_PARAMS = 100;

export function insertChunkSize(columnCount: number): number {
  if (columnCount < 1) return 1;
  return Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnCount));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const OP_KINDS = new Set(['expense', 'income', 'refund', 'transfer_out', 'transfer_in']);
const OP_SOURCES = new Set(['manual', 'receipt', 'planned', 'recurring', 'agent']);
const RECEIPT_STATUSES = new Set(['uploaded', 'parsed', 'confirmed']);
const FULFILL_OUTCOMES = new Set(['materialized', 'linked', 'skipped']);
const FULFILL_TYPES = new Set(['materialized', 'linked']);

export type BackupTables = Record<UserTableName, Record<string, unknown>[]>;

export type BackupDocument = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exported_at: string;
  tables: BackupTables;
};

export type BackupImportResult = {
  ok: true;
  imported: Record<UserTableName, number>;
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function rowInvalid(table: string, index: number, field: string): never {
  throw new ValidationError('BACKUP_ROW_INVALID', { table, index, field });
}

function refInvalid(table: string, field: string, value: string | number): never {
  throw new ValidationError('BACKUP_REFERENCE_INVALID', { table, field, value });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSafeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function asFlag(value: unknown): 0 | 1 | null {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireIsoDate(table: string, index: number, field: string, value: unknown): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    rowInvalid(table, index, field);
  }
  const [year, month, day] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    dt.getUTCFullYear() !== year
    || dt.getUTCMonth() !== month! - 1
    || dt.getUTCDate() !== day
    || year! < 1
  ) {
    rowInvalid(table, index, field);
  }
  return value;
}

function requireIsoMoment(table: string, index: number, field: string, value: unknown): string {
  if (typeof value !== 'string' || !ISO_MOMENT.test(value)) {
    rowInvalid(table, index, field);
  }
  const hour = Number(value.slice(11, 13));
  if (hour > 23) rowInvalid(table, index, field);
  return value;
}

function requireCurrency(table: string, index: number, field: string, value: unknown): string {
  if (typeof value !== 'string') rowInvalid(table, index, field);
  const upper = value.trim().toUpperCase();
  if (!CURRENCY.test(upper)) rowInvalid(table, index, field);
  return upper;
}

function requireId(table: string, index: number, field: string, value: unknown): number {
  const id = asSafeInt(value);
  if (id === null || id < 1) rowInvalid(table, index, field);
  return id;
}

function optionalId(table: string, index: number, field: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return requireId(table, index, field, value);
}

function requireNonEmpty(table: string, index: number, field: string, value: unknown): string {
  const text = asTrimmedString(value);
  if (text === null) rowInvalid(table, index, field);
  return text;
}

function pickRow(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    out[col] = row[col] ?? null;
  }
  return out;
}

function uniqueOrFail(table: string, field: string, values: Array<string | number>): Set<string | number> {
  const seen = new Set<string | number>();
  for (const value of values) {
    if (seen.has(value)) refInvalid(table, field, value);
    seen.add(value);
  }
  return seen;
}

function normalizeRow(
  table: UserTableName,
  index: number,
  raw: unknown,
): Record<string, unknown> {
  if (!isPlainObject(raw)) rowInvalid(table, index, 'row');
  const columns = TABLE_COLUMNS[table];
  const extra = Object.keys(raw).filter((key) => !columns.includes(key));
  if (extra.length > 0) rowInvalid(table, index, extra[0]!);
  const row = pickRow(raw, columns);

  switch (table) {
    case 'settings': {
      row.key = requireNonEmpty(table, index, 'key', row.key);
      if (typeof row.value !== 'string') rowInvalid(table, index, 'value');
      return row;
    }
    case 'accounts': {
      row.id = requireId(table, index, 'id', row.id);
      row.name = requireNonEmpty(table, index, 'name', row.name);
      const bank = asOptionalString(row.bank);
      if (bank === undefined) rowInvalid(table, index, 'bank');
      row.bank = bank;
      const type = asOptionalString(row.type);
      if (type === undefined) rowInvalid(table, index, 'type');
      row.type = type;
      row.owner = requireNonEmpty(table, index, 'owner', row.owner);
      row.country = requireNonEmpty(table, index, 'country', row.country);
      row.currency = requireCurrency(table, index, 'currency', row.currency);
      const balance = asSafeInt(row.balance_minor);
      if (balance === null) rowInvalid(table, index, 'balance_minor');
      row.balance_minor = balance;
      row.balance_updated_at = requireIsoMoment(table, index, 'balance_updated_at', row.balance_updated_at);
      const sort = asSafeInt(row.sort);
      if (sort === null || Math.abs(sort) > 1_000_000_000) rowInvalid(table, index, 'sort');
      row.sort = sort;
      const archived = asFlag(row.archived);
      if (archived === null) rowInvalid(table, index, 'archived');
      row.archived = archived;
      const accountNumber = asOptionalString(row.account_number);
      if (accountNumber === undefined) rowInvalid(table, index, 'account_number');
      row.account_number = accountNumber;
      return row;
    }
    case 'fx_rates': {
      row.code = requireCurrency(table, index, 'code', row.code);
      const rate = asSafeInt(row.rate_e9);
      if (rate === null || rate <= 0) rowInvalid(table, index, 'rate_e9');
      row.rate_e9 = rate;
      row.updated_at = requireIsoMoment(table, index, 'updated_at', row.updated_at);
      return row;
    }
    case 'receipts': {
      row.id = requireId(table, index, 'id', row.id);
      row.r2_key = requireNonEmpty(table, index, 'r2_key', row.r2_key);
      if (typeof row.status !== 'string' || !RECEIPT_STATUSES.has(row.status)) {
        rowInvalid(table, index, 'status');
      }
      if (row.parsed_json !== null && row.parsed_json !== undefined && typeof row.parsed_json !== 'string') {
        rowInvalid(table, index, 'parsed_json');
      }
      row.parsed_json = row.parsed_json ?? null;
      if (row.error !== null && row.error !== undefined && typeof row.error !== 'string') {
        rowInvalid(table, index, 'error');
      }
      row.error = row.error ?? null;
      row.created_at = requireIsoMoment(table, index, 'created_at', row.created_at);
      return row;
    }
    case 'pending_account_strings': {
      row.id = requireId(table, index, 'id', row.id);
      row.raw_string = requireNonEmpty(table, index, 'raw_string', row.raw_string);
      row.raw_norm = requireNonEmpty(table, index, 'raw_norm', row.raw_norm);
      row.first_seen_at = requireIsoMoment(table, index, 'first_seen_at', row.first_seen_at);
      return row;
    }
    case 'account_aliases': {
      row.id = requireId(table, index, 'id', row.id);
      row.account_id = requireId(table, index, 'account_id', row.account_id);
      row.alias_text = requireNonEmpty(table, index, 'alias_text', row.alias_text);
      row.alias_norm = requireNonEmpty(table, index, 'alias_norm', row.alias_norm);
      row.created_at = requireIsoMoment(table, index, 'created_at', row.created_at);
      return row;
    }
    case 'planned_items': {
      row.id = requireId(table, index, 'id', row.id);
      row.date = requireIsoDate(table, index, 'date', row.date);
      row.title = requireNonEmpty(table, index, 'title', row.title);
      const amount = asSafeInt(row.amount_minor);
      if (amount === null || amount === 0) rowInvalid(table, index, 'amount_minor');
      row.amount_minor = amount;
      row.currency = requireCurrency(table, index, 'currency', row.currency);
      row.account_id = requireId(table, index, 'account_id', row.account_id);
      const category = asOptionalString(row.category);
      if (category === undefined) rowInvalid(table, index, 'category');
      row.category = category;
      const done = asFlag(row.done);
      if (done === null) rowInvalid(table, index, 'done');
      row.done = done;
      if (row.revision !== null && row.revision !== undefined && typeof row.revision !== 'string') {
        rowInvalid(table, index, 'revision');
      }
      row.revision = typeof row.revision === 'string' && row.revision.trim() ? row.revision.trim() : null;
      return row;
    }
    case 'recurring_items': {
      row.id = requireId(table, index, 'id', row.id);
      row.title = requireNonEmpty(table, index, 'title', row.title);
      const amount = asSafeInt(row.amount_minor);
      if (amount === null || amount === 0) rowInvalid(table, index, 'amount_minor');
      row.amount_minor = amount;
      row.currency = requireCurrency(table, index, 'currency', row.currency);
      row.account_id = requireId(table, index, 'account_id', row.account_id);
      const category = asOptionalString(row.category);
      if (category === undefined) rowInvalid(table, index, 'category');
      row.category = category;
      if (typeof row.frequency !== 'string' || !FREQUENCIES.has(row.frequency)) {
        rowInvalid(table, index, 'frequency');
      }
      const interval = asSafeInt(row.interval_count);
      if (interval === null || interval < 1 || interval > 365) rowInvalid(table, index, 'interval_count');
      row.interval_count = interval;
      const nextDue = requireIsoDate(table, index, 'next_due_date', row.next_due_date);
      row.next_due_date = nextDue;
      if (row.end_date !== null && row.end_date !== undefined) {
        const endDate = requireIsoDate(table, index, 'end_date', row.end_date);
        if (endDate < nextDue) rowInvalid(table, index, 'end_date');
        row.end_date = endDate;
      } else {
        row.end_date = null;
      }
      const active = asFlag(row.active);
      if (active === null) rowInvalid(table, index, 'active');
      row.active = active;
      if (row.revision !== null && row.revision !== undefined && typeof row.revision !== 'string') {
        rowInvalid(table, index, 'revision');
      }
      row.revision = typeof row.revision === 'string' && row.revision.trim() ? row.revision.trim() : null;

      const day = row.day_of_month === null || row.day_of_month === undefined
        ? null
        : asSafeInt(row.day_of_month);
      if (row.day_of_month !== null && row.day_of_month !== undefined && day === null) {
        rowInvalid(table, index, 'day_of_month');
      }
      if (day !== null && (day < 1 || day > 31)) rowInvalid(table, index, 'day_of_month');
      const month = row.month_of_year === null || row.month_of_year === undefined
        ? null
        : asSafeInt(row.month_of_year);
      if (row.month_of_year !== null && row.month_of_year !== undefined && month === null) {
        rowInvalid(table, index, 'month_of_year');
      }
      if (month !== null && (month < 1 || month > 12)) rowInvalid(table, index, 'month_of_year');

      if (row.frequency === 'daily' || row.frequency === 'weekly') {
        if (day !== null || month !== null) rowInvalid(table, index, 'day_of_month');
      } else if (row.frequency === 'monthly') {
        if (day === null || month !== null) rowInvalid(table, index, 'day_of_month');
      } else if (day === null || month === null) {
        rowInvalid(table, index, 'month_of_year');
      } else {
        const dueMonth = Number(String(row.next_due_date).slice(5, 7));
        if (month !== dueMonth) rowInvalid(table, index, 'month_of_year');
      }
      row.day_of_month = day;
      row.month_of_year = month;
      return row;
    }
    case 'transfers': {
      row.id = requireId(table, index, 'id', row.id);
      return row;
    }
    case 'operations': {
      row.id = requireId(table, index, 'id', row.id);
      row.date = requireIsoDate(table, index, 'date', row.date);
      row.account_id = requireId(table, index, 'account_id', row.account_id);
      if (typeof row.kind !== 'string' || !OP_KINDS.has(row.kind)) rowInvalid(table, index, 'kind');
      const store = asOptionalString(row.store);
      if (store === undefined) rowInvalid(table, index, 'store');
      row.store = store;
      row.item = requireNonEmpty(table, index, 'item', row.item);
      const category = asOptionalString(row.category);
      if (category === undefined) rowInvalid(table, index, 'category');
      row.category = category;
      const subcategory = asOptionalString(row.subcategory);
      if (subcategory === undefined) rowInvalid(table, index, 'subcategory');
      if (subcategory !== null && category === null) rowInvalid(table, index, 'subcategory');
      row.subcategory = subcategory;
      const amount = asSafeInt(row.amount_minor);
      if (amount === null || amount === 0) rowInvalid(table, index, 'amount_minor');
      row.amount_minor = amount;
      if (
        (row.kind === 'expense' || row.kind === 'transfer_out') && amount >= 0
      ) rowInvalid(table, index, 'amount_minor');
      if (
        (row.kind === 'income' || row.kind === 'refund' || row.kind === 'transfer_in') && amount <= 0
      ) rowInvalid(table, index, 'amount_minor');
      if (typeof row.source !== 'string' || !OP_SOURCES.has(row.source)) {
        rowInvalid(table, index, 'source');
      }
      row.receipt_id = optionalId(table, index, 'receipt_id', row.receipt_id);
      row.planned_item_id = optionalId(table, index, 'planned_item_id', row.planned_item_id);
      row.recurring_item_id = optionalId(table, index, 'recurring_item_id', row.recurring_item_id);
      row.transfer_id = optionalId(table, index, 'transfer_id', row.transfer_id);
      if (row.source === 'receipt') {
        if (row.receipt_id === null) rowInvalid(table, index, 'receipt_id');
      } else if (row.receipt_id !== null) {
        rowInvalid(table, index, 'receipt_id');
      }
      if (row.planned_item_id !== null && row.source !== 'planned') {
        rowInvalid(table, index, 'planned_item_id');
      }
      if (row.recurring_item_id !== null && row.source !== 'recurring') {
        rowInvalid(table, index, 'recurring_item_id');
      }
      const isTransfer = row.kind === 'transfer_out' || row.kind === 'transfer_in';
      if (isTransfer !== (row.transfer_id !== null)) rowInvalid(table, index, 'transfer_id');
      const comment = asOptionalString(row.comment);
      if (comment === undefined) rowInvalid(table, index, 'comment');
      row.comment = comment;
      const receiptUrl = asOptionalString(row.receipt_url);
      if (receiptUrl === undefined) rowInvalid(table, index, 'receipt_url');
      if (receiptUrl !== null && parseHttpUrl(receiptUrl) === null) {
        rowInvalid(table, index, 'receipt_url');
      }
      row.receipt_url = receiptUrl;
      const fiscalReceiptId = asOptionalString(row.fiscal_receipt_id);
      if (fiscalReceiptId === undefined) rowInvalid(table, index, 'fiscal_receipt_id');
      if (fiscalReceiptId !== null && fiscalReceiptId.length > FISCAL_RECEIPT_ID_MAX_LENGTH) {
        rowInvalid(table, index, 'fiscal_receipt_id');
      }
      row.fiscal_receipt_id = fiscalReceiptId;
      return row;
    }
    case 'recurring_period_fulfillments': {
      row.recurring_item_id = requireId(table, index, 'recurring_item_id', row.recurring_item_id);
      row.period_due_date = requireIsoDate(table, index, 'period_due_date', row.period_due_date);
      if (typeof row.outcome !== 'string' || !FULFILL_OUTCOMES.has(row.outcome)) {
        rowInvalid(table, index, 'outcome');
      }
      const qty = asSafeInt(row.evidence_quantity);
      if (qty === null || qty < 1 || qty > 100) rowInvalid(table, index, 'evidence_quantity');
      row.evidence_quantity = qty;
      row.fulfilled_at = requireIsoMoment(table, index, 'fulfilled_at', row.fulfilled_at);
      return row;
    }
    case 'imported_receipt_items': {
      row.id = requireId(table, index, 'id', row.id);
      row.receipt_id = requireNonEmpty(table, index, 'receipt_id', row.receipt_id);
      const line = asSafeInt(row.line_no);
      if (line === null || line < 1) rowInvalid(table, index, 'line_no');
      row.line_no = line;
      row.operation_id = requireId(table, index, 'operation_id', row.operation_id);
      row.account_id = requireId(table, index, 'account_id', row.account_id);
      const amount = asSafeInt(row.amount_minor);
      if (amount === null) rowInvalid(table, index, 'amount_minor');
      row.amount_minor = amount;
      row.currency = requireCurrency(table, index, 'currency', row.currency);
      row.imported_at = requireIsoMoment(table, index, 'imported_at', row.imported_at);
      return row;
    }
    case 'operation_fulfillment_links': {
      row.operation_id = requireId(table, index, 'operation_id', row.operation_id);
      row.planned_item_id = optionalId(table, index, 'planned_item_id', row.planned_item_id);
      row.recurring_item_id = optionalId(table, index, 'recurring_item_id', row.recurring_item_id);
      if (row.period_due_date !== null && row.period_due_date !== undefined) {
        row.period_due_date = requireIsoDate(table, index, 'period_due_date', row.period_due_date);
      } else {
        row.period_due_date = null;
      }
      if (typeof row.fulfillment_type !== 'string' || !FULFILL_TYPES.has(row.fulfillment_type)) {
        rowInvalid(table, index, 'fulfillment_type');
      }
      row.linked_at = requireIsoMoment(table, index, 'linked_at', row.linked_at);
      const planned = row.planned_item_id !== null;
      const recurring = row.recurring_item_id !== null && row.period_due_date !== null;
      if (planned === recurring || (row.recurring_item_id !== null) !== (row.period_due_date !== null)) {
        rowInvalid(table, index, 'planned_item_id');
      }
      return row;
    }
    default: {
      const _never: never = table;
      throw new ValidationError('BACKUP_TABLE_INVALID', { table: String(_never) });
    }
  }
}

function assertReferences(tables: BackupTables): void {
  const accountIds = uniqueOrFail('accounts', 'id', tables.accounts.map((r) => r.id as number));
  const receiptIds = uniqueOrFail('receipts', 'id', tables.receipts.map((r) => r.id as number));
  uniqueOrFail('receipts', 'r2_key', tables.receipts.map((r) => r.r2_key as string));
  const plannedIds = uniqueOrFail('planned_items', 'id', tables.planned_items.map((r) => r.id as number));
  const recurringIds = uniqueOrFail(
    'recurring_items',
    'id',
    tables.recurring_items.map((r) => r.id as number),
  );
  const transferIds = uniqueOrFail('transfers', 'id', tables.transfers.map((r) => r.id as number));
  const operationIds = uniqueOrFail('operations', 'id', tables.operations.map((r) => r.id as number));
  uniqueOrFail('settings', 'key', tables.settings.map((r) => r.key as string));
  uniqueOrFail('fx_rates', 'code', tables.fx_rates.map((r) => r.code as string));
  uniqueOrFail('account_aliases', 'alias_norm', tables.account_aliases.map((r) => r.alias_norm as string));
  uniqueOrFail(
    'pending_account_strings',
    'raw_norm',
    tables.pending_account_strings.map((r) => r.raw_norm as string),
  );
  uniqueOrFail(
    'imported_receipt_items',
    'receipt_id+line_no',
    tables.imported_receipt_items.map((r) => `${r.receipt_id}:${r.line_no}`),
  );
  uniqueOrFail(
    'recurring_period_fulfillments',
    'recurring_item_id+period_due_date',
    tables.recurring_period_fulfillments.map((r) => `${r.recurring_item_id}:${r.period_due_date}`),
  );
  uniqueOrFail(
    'operation_fulfillment_links',
    'operation_id',
    tables.operation_fulfillment_links.map((r) => r.operation_id as number),
  );

  const settingKeys = new Set(tables.settings.map((r) => r.key as string));
  if (!settingKeys.has('base_currency') || !settingKeys.has('low_balance_threshold_minor')) {
    throw new ValidationError('BACKUP_ROW_INVALID', {
      table: 'settings',
      index: 0,
      field: 'key',
    });
  }

  for (const row of tables.account_aliases) {
    if (!accountIds.has(row.account_id as number)) {
      refInvalid('account_aliases', 'account_id', row.account_id as number);
    }
  }
  for (const row of tables.planned_items) {
    if (!accountIds.has(row.account_id as number)) {
      refInvalid('planned_items', 'account_id', row.account_id as number);
    }
  }
  for (const row of tables.recurring_items) {
    if (!accountIds.has(row.account_id as number)) {
      refInvalid('recurring_items', 'account_id', row.account_id as number);
    }
  }
  for (const row of tables.operations) {
    if (!accountIds.has(row.account_id as number)) {
      refInvalid('operations', 'account_id', row.account_id as number);
    }
    if (row.receipt_id !== null && !receiptIds.has(row.receipt_id as number)) {
      refInvalid('operations', 'receipt_id', row.receipt_id as number);
    }
    if (row.planned_item_id !== null && !plannedIds.has(row.planned_item_id as number)) {
      refInvalid('operations', 'planned_item_id', row.planned_item_id as number);
    }
    if (row.recurring_item_id !== null && !recurringIds.has(row.recurring_item_id as number)) {
      refInvalid('operations', 'recurring_item_id', row.recurring_item_id as number);
    }
    if (row.transfer_id !== null && !transferIds.has(row.transfer_id as number)) {
      refInvalid('operations', 'transfer_id', row.transfer_id as number);
    }
  }
  const fulfillmentKeys = new Set(
    tables.recurring_period_fulfillments.map((r) => `${r.recurring_item_id}:${r.period_due_date}:${r.outcome}`),
  );
  for (const row of tables.recurring_period_fulfillments) {
    if (!recurringIds.has(row.recurring_item_id as number)) {
      refInvalid('recurring_period_fulfillments', 'recurring_item_id', row.recurring_item_id as number);
    }
  }
  for (const row of tables.imported_receipt_items) {
    if (!operationIds.has(row.operation_id as number)) {
      refInvalid('imported_receipt_items', 'operation_id', row.operation_id as number);
    }
    if (!accountIds.has(row.account_id as number)) {
      refInvalid('imported_receipt_items', 'account_id', row.account_id as number);
    }
  }
  for (const row of tables.operation_fulfillment_links) {
    if (!operationIds.has(row.operation_id as number)) {
      refInvalid('operation_fulfillment_links', 'operation_id', row.operation_id as number);
    }
    if (row.planned_item_id !== null && !plannedIds.has(row.planned_item_id as number)) {
      refInvalid('operation_fulfillment_links', 'planned_item_id', row.planned_item_id as number);
    }
    if (row.recurring_item_id !== null) {
      if (!recurringIds.has(row.recurring_item_id as number)) {
        refInvalid('operation_fulfillment_links', 'recurring_item_id', row.recurring_item_id as number);
      }
      const key = `${row.recurring_item_id}:${row.period_due_date}:${row.fulfillment_type}`;
      if (!fulfillmentKeys.has(key)) {
        refInvalid('operation_fulfillment_links', 'period_due_date', String(row.period_due_date));
      }
    }
  }
}

export function parseBackupDocument(body: unknown): BackupDocument {
  if (!isPlainObject(body)) throw new ValidationError('REQUEST_BODY_INVALID');
  if (body.confirm !== true) throw new ValidationError('BACKUP_CONFIRM_REQUIRED');

  const source = isPlainObject(body.backup) ? body.backup : body;
  if (source.format !== BACKUP_FORMAT) throw new ValidationError('BACKUP_FORMAT_INVALID');
  if (source.version !== BACKUP_VERSION) throw new ValidationError('BACKUP_VERSION_UNSUPPORTED');
  if (typeof source.exported_at === 'string') {
    if (!ISO_MOMENT.test(source.exported_at) && !ISO_DATE.test(source.exported_at)) {
      throw new ValidationError('BACKUP_FORMAT_INVALID');
    }
  } else if (source.exported_at !== undefined) {
    throw new ValidationError('BACKUP_FORMAT_INVALID');
  }

  if (!isPlainObject(source.tables)) throw new ValidationError('BACKUP_FORMAT_INVALID');
  const unknownTables = Object.keys(source.tables).filter(
    (name) => !USER_TABLES.includes(name as UserTableName),
  );
  if (unknownTables.length > 0) {
    throw new ValidationError('BACKUP_TABLE_INVALID', { table: unknownTables[0]! });
  }

  const tables = {} as BackupTables;
  for (const name of USER_TABLES) {
    const rows = source.tables[name];
    if (!Array.isArray(rows)) {
      throw new ValidationError('BACKUP_TABLE_INVALID', { table: name });
    }
    tables[name] = rows.map((row, index) => normalizeRow(name, index, row));
  }
  assertReferences(tables);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: typeof source.exported_at === 'string' ? source.exported_at : nowIso(),
    tables,
  };
}

function insertStatements(
  db: D1Database,
  table: UserTableName,
  rows: Record<string, unknown>[],
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const columns = TABLE_COLUMNS[table];
  const chunkSize = insertChunkSize(columns.length);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk
      .map(() => `(${columns.map(() => '?').join(', ')})`)
      .join(', ');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;
    const binds = chunk.flatMap((row) => columns.map((col) => row[col] ?? null));
    stmts.push(db.prepare(sql).bind(...binds));
  }
  return stmts;
}

export async function exportUserState(db: D1Database): Promise<BackupDocument> {
  const exportedAt = nowIso();
  const stmts = USER_TABLES.map((name) =>
    db.prepare(`SELECT ${TABLE_COLUMNS[name].join(', ')} FROM ${name}`),
  );
  const batchResults = await db.batch<Record<string, unknown>>(stmts);
  const tables = {} as BackupTables;
  USER_TABLES.forEach((name, index) => {
    const columns = TABLE_COLUMNS[name];
    tables[name] = (batchResults[index]?.results ?? []).map((row) => pickRow(row, columns));
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: exportedAt,
    tables,
  };
}

export function backupFilename(exportedAt: string, now = new Date()): string {
  const day = ISO_DATE.test(exportedAt.slice(0, 10))
    ? exportedAt.slice(0, 10)
    : now.toISOString().slice(0, 10);
  return `money-flow-backup-${day}.json`;
}

export async function importUserState(
  db: D1Database,
  tables: BackupTables,
): Promise<BackupImportResult> {
  const statements: D1PreparedStatement[] = DELETE_ORDER.map((name) =>
    db.prepare(`DELETE FROM ${name}`),
  );
  for (const name of INSERT_ORDER) {
    statements.push(...insertStatements(db, name, tables[name]));
  }
  await db.batch(statements);

  const imported = {} as Record<UserTableName, number>;
  for (const name of USER_TABLES) imported[name] = tables[name].length;
  return { ok: true, imported };
}

export type ResetUserStateResult = {
  ok: true;
  reset: true;
  defaults: {
    base_currency: string;
    low_balance_threshold_minor: string;
  };
};

export function parseResetConfirmation(body: unknown): void {
  if (!isPlainObject(body)) throw new ValidationError('REQUEST_BODY_INVALID');
  if (body.confirm !== true) throw new ValidationError('RESET_CONFIRM_REQUIRED');
  if (body.phrase !== RESET_CONFIRM_PHRASE) throw new ValidationError('RESET_PHRASE_REQUIRED');
}

export async function resetUserState(db: D1Database): Promise<ResetUserStateResult> {
  const statements: D1PreparedStatement[] = DELETE_ORDER
    .filter((name) => name !== 'settings')
    .map((name) => db.prepare(`DELETE FROM ${name}`));
  statements.push(
    db.prepare(
      `DELETE FROM settings
       WHERE key != 'auth_epoch'
         AND key NOT LIKE 'session_revoked:%'
         AND key NOT LIKE 'passkey_revoked:%'
         AND key NOT LIKE 'passkey_disabled:%'`,
    ),
  );
  statements.push(
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?), (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(
      EMPTY_INSTANCE_SETTINGS[0].key,
      EMPTY_INSTANCE_SETTINGS[0].value,
      EMPTY_INSTANCE_SETTINGS[1].key,
      EMPTY_INSTANCE_SETTINGS[1].value,
    ),
  );
  await db.batch(statements);
  return {
    ok: true,
    reset: true,
    defaults: {
      base_currency: EMPTY_INSTANCE_SETTINGS[0].value,
      low_balance_threshold_minor: EMPTY_INSTANCE_SETTINGS[1].value,
    },
  };
}
