import { Hono } from 'hono';
import type { Env } from './types';
import { ValidationError, fail, failCaught } from './api-error';
import { BodyTooLargeError, readLimitedJson } from './limited-body';
import { acceptStatementUpload, readUploadRequestBody } from './statement-uploads';
import { presetJson, STATEMENT_PRESETS } from '../shared/statement-import/presets';
import { templateAsPreset } from '../shared/statement-import/templates';
import { listStatementTemplates } from './statement-templates';
import { decodeStatementBytes, isPdfBytes } from '../shared/statement-import/parse';
import { parseStatementDate } from '../shared/statement-import/amounts';
import { normalizeIso4217CurrencyCode } from '../shared/currency';
import { isSafeMinor } from '../shared/money';
import {
  IMPORT_UNDO_PHRASE,
  STATEMENT_IMPORT_MAX_BODY_BYTES,
  STATEMENT_IMPORT_MAX_FILE_BYTES,
  STATEMENT_IMPORT_MAX_FILES,
  STATEMENT_IMPORT_MAX_ROWS,
  type CategoryMatchField,
  type CategoryMode,
  type CsvColumnMapping,
  type CsvDelimiter,
  type CsvParseOptions,
  type DecimalSeparator,
  type StatementDateFormat,
  type StatementEncoding,
  type StatementFormat,
  type StatementKind,
  type XlsColumnSpec,
  type XlsLayout,
} from '../shared/statement-import/types';
import {
  commitStatementImport,
  deleteCategoryRule,
  getImportBatch,
  insertCategoryRule,
  listCategoryRules,
  listImportBatches,
  patchCategoryRule,
  previewStatementImport,
  undoStatementImport,
  type CommitRowInput,
  type PreviewFileInput,
} from './statement-import';

const statementImportApi = new Hono<{ Bindings: Env }>();

const LIMITS = {
  max_body_bytes: STATEMENT_IMPORT_MAX_BODY_BYTES,
  max_file_bytes: STATEMENT_IMPORT_MAX_FILE_BYTES,
  max_files: STATEMENT_IMPORT_MAX_FILES,
  max_rows: STATEMENT_IMPORT_MAX_ROWS,
};

function asObject(value: unknown, code: 'REQUEST_BODY_INVALID' | 'IMPORT_ROW_INVALID' = 'REQUEST_BODY_INVALID'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(code);
  }
  return value as Record<string, unknown>;
}

async function readImportBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await readLimitedJson(request, STATEMENT_IMPORT_MAX_BODY_BYTES);
    return asObject(raw);
  } catch (error) {
    if (error instanceof BodyTooLargeError || error instanceof ValidationError && error.code === 'FILTER_TOO_LARGE') {
      throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'body', limit: STATEMENT_IMPORT_MAX_BODY_BYTES });
    }
    if (error instanceof SyntaxError) throw new ValidationError('INVALID_JSON');
    throw error;
  }
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('FIELD_TYPE_STRING', { field });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredString(value: unknown, field: string, max = 500): string {
  const text = optionalString(value, field);
  if (!text) throw new ValidationError('FIELD_REQUIRED', { field });
  if (text.length > max) throw new ValidationError('IMPORT_ROW_INVALID', { field });
  return text;
}

function categoryMode(value: unknown): CategoryMode {
  if (value !== 'manual' && value !== 'rules') {
    throw new ValidationError('IMPORT_ROW_INVALID', { field: 'category_mode' });
  }
  return value;
}

function decodeBase64(value: string, filename: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'content_base64 is not valid base64' });
  }
}

function fileFormat(value: unknown): StatementFormat | 'auto' {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'csv' || value === 'ofx' || value === 'qfx' || value === 'camt053' || value === 'xls' || value === 'pdf') return value;
  throw new ValidationError('IMPORT_FILE_INVALID', { filename: 'file', detail: 'format is not supported' });
}

function mappingFrom(value: unknown): CsvColumnMapping | null {
  if (value === undefined || value === null) return null;
  const raw = asObject(value, 'IMPORT_ROW_INVALID');
  const mapping: CsvColumnMapping = { date: '' };
  for (const key of ['date', 'amount', 'debit', 'credit', 'currency', 'description', 'merchant', 'counterparty', 'reference', 'balance'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !raw[key].trim()) {
      throw new ValidationError('IMPORT_ROW_INVALID', { field: key });
    }
    mapping[key] = raw[key].trim();
  }
  if (!mapping.date) throw new ValidationError('FIELD_REQUIRED', { field: 'date' });
  return mapping;
}

function optionsFrom(value: unknown): Partial<CsvParseOptions> | null {
  if (value === undefined || value === null) return null;
  const raw = asObject(value, 'IMPORT_ROW_INVALID');
  const options: Partial<CsvParseOptions> = {};
  if (raw.delimiter !== undefined) {
    if (raw.delimiter !== ',' && raw.delimiter !== ';' && raw.delimiter !== '\t' && raw.delimiter !== '|') {
      throw new ValidationError('IMPORT_ROW_INVALID', { field: 'delimiter' });
    }
    options.delimiter = raw.delimiter as CsvDelimiter;
  }
  if (raw.decimal_separator !== undefined || raw.decimalSeparator !== undefined) {
    const mark = raw.decimal_separator ?? raw.decimalSeparator;
    if (mark !== '.' && mark !== ',') throw new ValidationError('IMPORT_ROW_INVALID', { field: 'decimal_separator' });
    options.decimalSeparator = mark as DecimalSeparator;
  }
  if (raw.date_format !== undefined || raw.dateFormat !== undefined) {
    const format = raw.date_format ?? raw.dateFormat;
    const allowed: StatementDateFormat[] = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD'];
    if (typeof format !== 'string' || !allowed.includes(format as StatementDateFormat)) {
      throw new ValidationError('IMPORT_ROW_INVALID', { field: 'date_format' });
    }
    options.dateFormat = format as StatementDateFormat;
  }
  if (raw.encoding !== undefined) {
    if (raw.encoding !== 'utf-8' && raw.encoding !== 'windows-1252' && raw.encoding !== 'iso-8859-1') {
      throw new ValidationError('IMPORT_ROW_INVALID', { field: 'encoding' });
    }
    options.encoding = raw.encoding as StatementEncoding;
  }
  if (raw.has_header !== undefined || raw.hasHeader !== undefined) {
    const flag = raw.has_header ?? raw.hasHeader;
    if (typeof flag !== 'boolean') throw new ValidationError('FIELD_TYPE_BOOLEAN', { field: 'has_header' });
    options.hasHeader = flag;
  }
  if (raw.default_currency !== undefined || raw.defaultCurrency !== undefined) {
    const code = normalizeIso4217CurrencyCode(raw.default_currency ?? raw.defaultCurrency);
    if (!code) throw new ValidationError('INVALID_CURRENCY');
    options.defaultCurrency = code;
  }
  if (raw.skip_empty_amount !== undefined) {
    if (typeof raw.skip_empty_amount !== 'boolean') {
      throw new ValidationError('FIELD_TYPE_BOOLEAN', { field: 'skip_empty_amount' });
    }
    options.skipEmptyAmount = raw.skip_empty_amount;
  }
  if (raw.check_running_balance !== undefined) {
    if (typeof raw.check_running_balance !== 'boolean') {
      throw new ValidationError('FIELD_TYPE_BOOLEAN', { field: 'check_running_balance' });
    }
    options.checkRunningBalance = raw.check_running_balance;
  }
  if (raw.header_search !== undefined || raw.headerSearch !== undefined) {
    const flag = raw.header_search ?? raw.headerSearch;
    if (typeof flag !== 'boolean') throw new ValidationError('FIELD_TYPE_BOOLEAN', { field: 'header_search' });
    options.headerSearch = flag;
  }
  if (raw.skip_rows !== undefined || raw.skipRows !== undefined) {
    const skip = raw.skip_rows ?? raw.skipRows;
    if (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0 || skip > 50) {
      throw new ValidationError('IMPORT_ROW_INVALID', { field: 'skip_rows' });
    }
    options.skipRows = skip;
  }
  return options;
}

function columnSpec(value: unknown, field: string): XlsColumnSpec {
  const raw = asObject(value, 'IMPORT_ROW_INVALID');
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 1 || raw.index > 64) {
    throw new ValidationError('IMPORT_ROW_INVALID', { field });
  }
  if (typeof raw.header !== 'string' || !raw.header.trim()) {
    throw new ValidationError('IMPORT_ROW_INVALID', { field });
  }
  return { index: raw.index, header: raw.header.trim() };
}

function xlsLayoutFrom(value: unknown): XlsLayout | null {
  if (value === undefined || value === null) return null;
  const raw = asObject(value, 'IMPORT_ROW_INVALID');
  const columns = asObject(raw.columns, 'IMPORT_ROW_INVALID');
  const dateFormat = raw.date_format ?? raw.dateFormat;
  const decimal = raw.decimal_separator ?? raw.decimalSeparator;
  if (decimal !== '.' && decimal !== ',') throw new ValidationError('IMPORT_ROW_INVALID', { field: 'decimal_separator' });
  const allowed: StatementDateFormat[] = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD'];
  if (typeof dateFormat !== 'string' || !allowed.includes(dateFormat as StatementDateFormat)) {
    throw new ValidationError('IMPORT_ROW_INVALID', { field: 'date_format' });
  }
  return {
    sheetName: optionalString(raw.sheet_name ?? raw.sheetName, 'sheet_name'),
    columns: {
      valueDate: columnSpec(columns.value_date ?? columns.valueDate, 'value_date'),
      transactionDate: columnSpec(columns.transaction_date ?? columns.transactionDate, 'transaction_date'),
      currency: columnSpec(columns.currency, 'currency'),
      credit: columnSpec(columns.credit, 'credit'),
      debit: columnSpec(columns.debit, 'debit'),
      description: columnSpec(columns.description, 'description'),
    },
    dateFormat: dateFormat as StatementDateFormat,
    decimalSeparator: decimal,
    accountLabel: optionalString(raw.account_label ?? raw.accountLabel, 'account_label'),
    descriptionFlags: [],
  };
}

function previewFile(value: unknown, index: number): PreviewFileInput {
  const raw = asObject(value, 'IMPORT_ROW_INVALID');
  const filename = optionalString(raw.filename, 'filename') ?? `file-${index + 1}`;
  const content = raw.content;
  const encoded = raw.content_base64;
  if (content !== undefined && typeof content !== 'string') {
    throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'content must be a string' });
  }
  if (encoded !== undefined && typeof encoded !== 'string') {
    throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'content_base64 must be a string' });
  }
  if ((content === undefined || content === '') && (encoded === undefined || encoded === '')) {
    throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'file content is required' });
  }
  const bytes = typeof encoded === 'string' && encoded.length > 0 ? decodeBase64(encoded, filename) : null;
  const encoding = optionsFrom(raw.options)?.encoding ?? null;
  const text = typeof content === 'string'
    ? content
    : (bytes && raw.format !== 'xls' && !isPdfBytes(bytes) ? decodeStatementBytes(bytes, encoding ?? 'utf-8') : null);
  const size = bytes?.byteLength ?? (text ? new TextEncoder().encode(text).byteLength : 0);
  if (size > STATEMENT_IMPORT_MAX_FILE_BYTES) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'file', limit: STATEMENT_IMPORT_MAX_FILE_BYTES });
  }
  const accountId = raw.account_id;
  if (accountId !== undefined && accountId !== null && (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 1)) {
    throw new ValidationError('ACCOUNT_ID_REQUIRED');
  }
  return {
    filename,
    format: fileFormat(raw.format),
    presetId: optionalString(raw.preset_id ?? raw.presetId, 'preset_id'),
    text,
    bytes,
    encoding,
    mapping: mappingFrom(raw.mapping),
    options: optionsFrom(raw.options),
    xlsLayout: xlsLayoutFrom(raw.xls ?? raw.layout),
    accountId: typeof accountId === 'number' ? accountId : null,
    accountHint: optionalString(raw.account_hint ?? raw.accountHint, 'account_hint'),
  };
}

function commitFiles(value: unknown): Array<{ filename: string; preset_id: string | null }> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ValidationError('IMPORT_FILE_INVALID', { filename: 'files', detail: 'files must be an array' });
  }
  if (value.length > STATEMENT_IMPORT_MAX_FILES) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'files', limit: STATEMENT_IMPORT_MAX_FILES });
  }
  return value.map((item, index) => {
    const raw = asObject(item, 'IMPORT_ROW_INVALID');
    const filename = requiredString(raw.filename, 'filename', 200);
    const preset = optionalString(raw.preset_id ?? raw.presetId, 'preset_id');
    if (preset && preset.length > 64) {
      throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'preset_id is too long' });
    }
    void index;
    return { filename, preset_id: preset };
  });
}

function commitRow(value: unknown, index: number): CommitRowInput {
  const raw = asObject(value, 'IMPORT_ROW_INVALID');
  if (raw.include !== undefined && typeof raw.include !== 'boolean') {
    throw new ValidationError('FIELD_TYPE_BOOLEAN', { field: 'include' });
  }
  const accountId = raw.account_id;
  if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 1) {
    throw new ValidationError('ACCOUNT_ID_REQUIRED');
  }
  let date: string;
  try {
    date = parseStatementDate(String(raw.date ?? ''), 'YYYY-MM-DD');
  } catch {
    throw new ValidationError('INVALID_ISO_DATE', { field: 'date' });
  }
  if (typeof raw.amount_minor !== 'number' || !isSafeMinor(raw.amount_minor) || raw.amount_minor === 0) {
    throw new ValidationError('FIELD_TYPE_INTEGER_MINOR', { field: 'amount_minor' });
  }
  const suppliedCurrency = raw.currency;
  const currencyBlank = suppliedCurrency === undefined || suppliedCurrency === null || String(suppliedCurrency).trim() === '';
  const currency = currencyBlank ? '' : normalizeIso4217CurrencyCode(suppliedCurrency);
  if (!currencyBlank && !currency) throw new ValidationError('INVALID_CURRENCY');
  const kind = raw.kind;
  if (kind !== 'expense' && kind !== 'income') throw new ValidationError('INVALID_KIND', { values: 'expense, income' });
  if (kind === 'expense' && raw.amount_minor > 0) throw new ValidationError('AMOUNT_MUST_BE_NEGATIVE', { kind: 'Expense' });
  if (kind === 'income' && raw.amount_minor < 0) throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', { kind: 'Income' });
  const description = requiredString(raw.statement_description ?? raw.description ?? raw.item, 'statement_description');
  const item = requiredString(raw.item ?? description, 'item');
  const category = optionalString(raw.category, 'category');
  const subcategory = optionalString(raw.subcategory, 'subcategory');
  if (subcategory && !category) throw new ValidationError('SUBCATEGORY_REQUIRES_CATEGORY');
  return {
    include: raw.include !== false,
    accountId,
    date,
    amountMinor: raw.amount_minor,
    currency: currency || '',
    kind: kind as StatementKind,
    item,
    store: optionalString(raw.store, 'store'),
    category,
    subcategory,
    comment: optionalString(raw.comment, 'comment'),
    bankTransactionId: optionalString(raw.bank_transaction_id, 'bank_transaction_id'),
    statementDescription: description,
    fingerprint: optionalString(raw.fingerprint, 'fingerprint'),
  };
}

function ruleFields(raw: Record<string, unknown>, partial: boolean) {
  const out: {
    pattern?: string;
    matchField?: CategoryMatchField;
    category?: string;
    subcategory?: string | null;
    priority?: number;
  } = {};
  if (raw.pattern !== undefined || !partial) out.pattern = requiredString(raw.pattern, 'pattern', 200);
  if (raw.match_field !== undefined || !partial) {
    const field = raw.match_field;
    if (field !== 'merchant' && field !== 'description' && field !== 'any') {
      throw new ValidationError('CATEGORY_RULE_INVALID', { field: 'match_field' });
    }
    out.matchField = field;
  }
  if (raw.category !== undefined || !partial) out.category = requiredString(raw.category, 'category', 200);
  if (raw.subcategory !== undefined) out.subcategory = optionalString(raw.subcategory, 'subcategory');
  if (raw.priority !== undefined || !partial) {
    const priority = raw.priority === undefined ? 100 : raw.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 1_000_000) {
      throw new ValidationError('CATEGORY_RULE_INVALID', { field: 'priority' });
    }
    out.priority = priority;
  }
  if (out.subcategory && out.category === undefined && !partial) {
    throw new ValidationError('SUBCATEGORY_REQUIRES_CATEGORY');
  }
  return out;
}

function parseId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

statementImportApi.get('/statement-imports/presets', async (c) => {
  const stored = await listStatementTemplates(c.env.DB);
  const userPresets = stored.flatMap((row) => {
    const preset = templateAsPreset(row.document);
    return preset ? [presetJson(preset, 'user')] : [];
  });
  return c.json({
    presets: [
      ...STATEMENT_PRESETS.map((preset) => presetJson(preset, 'builtin')),
      ...userPresets,
    ],
    limits: LIMITS,
  });
});

statementImportApi.get('/statement-imports', async (c) => {
  const batches = await listImportBatches(c.env.DB);
  return c.json({ batches });
});

statementImportApi.get('/statement-imports/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return fail(c, 'IMPORT_BATCH_NOT_FOUND', 404);
  const found = await getImportBatch(c.env.DB, id);
  if (!found) return fail(c, 'IMPORT_BATCH_NOT_FOUND', 404);
  return c.json(found);
});

statementImportApi.put('/statement-imports/uploads/:token', async (c) => {
  try {
    const token = decodeURIComponent(c.req.param('token'));
    const bytes = await readUploadRequestBody(c.req.raw);
    const stored = await acceptStatementUpload(c.env.DB, c.env.SESSION_SECRET, token, bytes);
    return c.json(stored, 201);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return fail(c, 'IMPORT_TOO_LARGE', 400, { scope: 'file', limit: STATEMENT_IMPORT_MAX_FILE_BYTES });
    }
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementImportApi.post('/statement-imports/preview', async (c) => {
  try {
    const body = await readImportBody(c.req.raw);
    const mode = categoryMode(body.category_mode);
    if (!Array.isArray(body.files)) throw new ValidationError('IMPORT_FILE_INVALID', { filename: 'files', detail: 'files must be an array' });
    if (body.files.length > STATEMENT_IMPORT_MAX_FILES) {
      throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'files', limit: STATEMENT_IMPORT_MAX_FILES });
    }
    const files = body.files.map((file, index) => previewFile(file, index));
    const preview = await previewStatementImport(c.env.DB, mode, files);
    return c.json({ ...preview, limits: LIMITS });
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementImportApi.post('/statement-imports', async (c) => {
  try {
    const body = await readImportBody(c.req.raw);
    const idempotencyKey = requiredString(body.idempotency_key, 'idempotency_key', 200);
    const mode = categoryMode(body.category_mode);
    if (!Array.isArray(body.rows)) throw new ValidationError('IMPORT_ROW_INVALID', { field: 'rows' });
    if (body.rows.length > STATEMENT_IMPORT_MAX_ROWS) {
      throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'rows', limit: STATEMENT_IMPORT_MAX_ROWS });
    }
    const fileCount = body.file_count === undefined ? 0 : body.file_count;
    if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0 || fileCount > STATEMENT_IMPORT_MAX_FILES) {
      throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'files', limit: STATEMENT_IMPORT_MAX_FILES });
    }
    const rows = body.rows.map((row, index) => commitRow(row, index));
    const files = commitFiles(body.files);
    const result = await commitStatementImport(c.env.DB, {
      idempotencyKey,
      categoryMode: mode,
      fileCount,
      filesJson: files === null ? null : JSON.stringify(files),
      rows,
    });
    return c.json(result, result.written ? 201 : 200);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementImportApi.post('/statement-imports/:id/undo', async (c) => {
  try {
    const id = parseId(c.req.param('id'));
    if (id === null) return fail(c, 'IMPORT_BATCH_NOT_FOUND', 404);
    const body = await readImportBody(c.req.raw);
    if (body.confirm !== true) throw new ValidationError('IMPORT_UNDO_CONFIRM_REQUIRED');
    if (body.phrase !== IMPORT_UNDO_PHRASE) throw new ValidationError('IMPORT_UNDO_PHRASE_REQUIRED');
    const result = await undoStatementImport(c.env.DB, id);
    return c.json(result);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementImportApi.get('/category-rules', async (c) => {
  return c.json({ rules: await listCategoryRules(c.env.DB) });
});

statementImportApi.post('/category-rules', async (c) => {
  try {
    const body = await readImportBody(c.req.raw);
    const fields = ruleFields(body, false);
    const rule = await insertCategoryRule(c.env.DB, {
      pattern: fields.pattern!,
      matchField: fields.matchField!,
      category: fields.category!,
      subcategory: fields.subcategory ?? null,
      priority: fields.priority ?? 100,
    });
    return c.json({ rule }, 201);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementImportApi.patch('/category-rules/:id', async (c) => {
  try {
    const id = parseId(c.req.param('id'));
    if (id === null) return fail(c, 'CATEGORY_RULE_NOT_FOUND', 404);
    const body = await readImportBody(c.req.raw);
    const fields = ruleFields(body, true);
    if (Object.keys(fields).length === 0) throw new ValidationError('NO_PATCH_FIELDS');
    const rule = await patchCategoryRule(c.env.DB, id, fields);
    return c.json({ rule });
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementImportApi.delete('/category-rules/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return fail(c, 'CATEGORY_RULE_NOT_FOUND', 404);
  const removed = await deleteCategoryRule(c.env.DB, id);
  if (!removed) return fail(c, 'CATEGORY_RULE_NOT_FOUND', 404);
  return c.body(null, 204);
});

export default statementImportApi;
