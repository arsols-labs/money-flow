import { apiErrorMessage } from '../shared/api-errors';
import { isOleWorkbook, isPdfBytes, isPdfName, detectTextFormat, looksLikePdf } from '../shared/statement-import/parse';
import {
  BUILTIN_TEMPLATES,
  builtinTemplateById,
  isBuiltinTemplateId,
} from '../shared/statement-import/templates';
import type { StatementTemplate } from '../shared/statement-import/template-schema';
import {
  IMPORT_UNDO_PHRASE,
  STATEMENT_IMPORT_MAX_FILE_BYTES,
  STATEMENT_IMPORT_MAX_FILES,
  STATEMENT_IMPORT_MAX_ROWS,
  type CategoryMode,
  type StatementKind,
} from '../shared/statement-import/types';
import { ValidationError } from './api-error';
import {
  commitStatementImport,
  getImportBatch,
  previewStatementImport,
  undoStatementImport,
  type CommitRowInput,
} from './statement-import';
import {
  deleteStatementTemplate,
  getStatementTemplate,
  insertStatementTemplate,
  listStatementTemplates,
  parseStatementTemplate,
  templateJson,
  updateStatementTemplate,
  type StoredStatementTemplate,
} from './statement-templates';
import {
  base64ToBytes,
  consumeStatementUploads,
  createStatementUploadSlot,
  readStatementUpload,
  STATEMENT_UPLOAD_TTL_SECONDS,
} from './statement-uploads';

export const STATEMENT_IMPORT_VIEW_PATH = '#/data/import';

export const STATEMENT_READ_TOOL_NAMES = [
  'template_list',
  'template_get',
  'statement_import_preview',
] as const;

export const STATEMENT_WRITE_TOOL_NAMES = [
  'template_create',
  'template_update',
  'template_delete',
  'statement_import_upload_create',
  'statement_import_commit',
  'statement_import_undo',
] as const;

export const STATEMENT_NO_AUTO_CONFIRM = ['template_delete', 'statement_import_undo'] as const;

export const STATEMENT_INLINE_TOOLS = new Set(['statement_import_preview', 'statement_import_commit']);

export const STATEMENT_MUTATION_TOOLS = new Set([
  'template_create',
  'template_update',
  'template_delete',
  'statement_import_commit',
  'statement_import_undo',
]);

const WRITE_OUTPUT = {
  resultType: { type: 'string' },
  requestState: { type: 'string' },
  description: { type: 'string' },
  written: { type: 'boolean' },
  tool: { type: 'string' },
  idempotency_key: { type: 'string' },
  arguments: { type: 'object' },
  error: { type: 'string' },
};

export function statementMcpToolDefinitions(notes: { mrtr: string; noAutoConfirm: string }) {
  return [
    {
      name: 'template_list',
      description: 'List built-in statement templates and the templates saved in this ledger. Built-in templates are read-only.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { templates: { type: 'array' }, error: { type: 'string' } } },
    },
    {
      name: 'template_get',
      description: 'Read one statement template by id, including its document. Built-in templates are read-only.',
      inputSchema: {
        type: 'object',
        properties: { template_id: { type: 'string', description: 'Template id, for example us-bofa or rs-bps' } },
        required: ['template_id'],
      },
      outputSchema: { type: 'object', properties: { source: { type: 'string' }, document: { type: 'object' }, error: { type: 'string' } } },
    },
    {
      name: 'statement_import_preview',
      description: `Parse one CSV, Excel 97 .xls, OFX/QFX, or text-layer PDF statement with the shared statement-import service. PDF is detected from %PDF bytes or a .pdf name before CSV, for inline content, content_base64, and upload_id. A scan returns PDF_NO_TEXT_LAYER. An unrecognized layout returns PDF_UNKNOWN_LAYOUT. An encrypted file returns PDF_ENCRYPTED. Returns the detected template, account mapping, rows, duplicates, and totals. A successful preview includes requestState for statement_import_commit. An empty parse or a parser failure is an error, not an empty success. Inline content and content_base64 accept at most ${STATEMENT_IMPORT_MAX_FILE_BYTES} raw bytes (1 MiB), the same cap as the upload PUT and the Data screen. At most ${STATEMENT_IMPORT_MAX_ROWS} rows. Base64 makes the JSON body larger; that overhead is allowed. Upload is a raw PUT of the same size, not a larger file. Scans and photos are not accepted.`,
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          content: { type: 'string', description: 'UTF-8 text for CSV or OFX. Mutually exclusive with content_base64 and upload_id.' },
          content_base64: { type: 'string', description: `Base64 of the file. Decoded size must be at most ${STATEMENT_IMPORT_MAX_FILE_BYTES} bytes (1 MiB), the same raw cap as upload_id.` },
          upload_id: { type: 'string', description: 'Id from statement_import_upload_create after the client PUT the bytes.' },
          template_id: { type: 'string', description: 'Built-in or saved template id. Omitted templates are detected when exactly one template matches.' },
          account_id: { type: 'number' },
          category_mode: { type: 'string', enum: ['manual', 'rules'] },
          idempotency_key: { type: 'string', description: 'Key statement_import_commit must repeat with requestState. Generated when omitted.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          detected_template: { type: 'object' },
          account_mapping: { type: 'array' },
          rows: { type: 'array' },
          duplicates: { type: 'number' },
          totals: { type: 'array' },
          requestState: { type: 'string' },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
    {
      name: 'template_create',
      description: 'Create a user statement template, or copy a built-in or saved template (copy_from) and save it under a new id. The document is checked with the same strict template schema as the app. Built-in templates are not edited in place. auto_confirm is accepted: an authenticated client may pass auto_confirm true to save immediately. ' + notes.mrtr,
      inputSchema: {
        type: 'object',
        properties: {
          copy_from: { type: 'string', description: 'Template id to copy. Use this to edit a built-in template: the copy is yours.' },
          id: { type: 'string', description: 'New template id. Required with copy_from.' },
          label: { type: 'string' },
          document: { type: 'object', description: 'Full template document. Omit when copy_from is set.' },
          idempotency_key: { type: 'string' },
          requestState: { type: 'string' },
        },
        required: ['idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, template: { type: 'object' } } },
    },
    {
      name: 'template_update',
      description: 'Update a user statement template (label and/or document). Built-in templates are read-only; copy one with template_create copy_from. auto_confirm is accepted only when this MCP client created the template and it has not been used in an import batch. Otherwise a human confirmation through requestState is required. ' + notes.mrtr,
      inputSchema: {
        type: 'object',
        properties: {
          template_id: { type: 'string' },
          label: { type: 'string' },
          document: { type: 'object' },
          idempotency_key: { type: 'string' },
          requestState: { type: 'string' },
        },
        required: ['template_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, template: { type: 'object' } } },
    },
    {
      name: 'template_delete',
      description: 'Delete a user statement template. Built-in templates cannot be deleted. ' + notes.noAutoConfirm + 'Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        properties: {
          template_id: { type: 'string' },
          idempotency_key: { type: 'string' },
          requestState: { type: 'string' },
        },
        required: ['template_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, template_id: { type: 'string' } } },
    },
    {
      name: 'statement_import_upload_create',
      description: `Create a one-time upload slot so the client can PUT raw bytes instead of base64 inside the JSON call. The raw cap is ${STATEMENT_IMPORT_MAX_FILE_BYTES} bytes (1 MiB), the same cap as inline content, and the row cap is ${STATEMENT_IMPORT_MAX_ROWS}. Returns upload_url. The client PUT the raw file once within ${STATEMENT_UPLOAD_TTL_SECONDS / 60} minutes, then passes upload_id to statement_import_preview or statement_import_commit. The token expires and a second PUT is refused. Bytes are stored in D1 until preview or commit consumes them, or until a later call deletes expired rows. This does not write the ledger.`,
      inputSchema: {
        type: 'object',
        properties: { filename: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        properties: {
          upload_id: { type: 'string' },
          upload_url: { type: 'string' },
          expires_at: { type: 'string' },
          max_file_bytes: { type: 'number' },
          written: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
    },
    {
      name: 'statement_import_commit',
      description: 'Book the statement preview. Pass requestState from statement_import_preview, or pass the file again with auto_confirm true. Duplicates are skipped. The result includes added, skipped_duplicates, batch_id, and where to view or undo the batch. auto_confirm is accepted for an authenticated client. ' + notes.mrtr,
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          content: { type: 'string' },
          content_base64: { type: 'string' },
          upload_id: { type: 'string' },
          template_id: { type: 'string' },
          account_id: { type: 'number' },
          category_mode: { type: 'string', enum: ['manual', 'rules'] },
          idempotency_key: { type: 'string' },
          requestState: { type: 'string' },
        },
        required: ['idempotency_key'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          ...WRITE_OUTPUT,
          added: { type: 'number' },
          skipped_duplicates: { type: 'number' },
          batch_id: { type: 'number' },
          view_path: { type: 'string' },
        },
      },
    },
    {
      name: 'statement_import_undo',
      description: `Undo a whole statement import batch. Requires phrase "${IMPORT_UNDO_PHRASE}". ` + notes.noAutoConfirm + 'Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        properties: {
          batch_id: { type: 'number' },
          phrase: { type: 'string', description: `Must be exactly ${IMPORT_UNDO_PHRASE}` },
          idempotency_key: { type: 'string' },
          requestState: { type: 'string' },
        },
        required: ['batch_id', 'phrase', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, batch_id: { type: 'number' }, undone: { type: 'boolean' } } },
    },
  ];
}

interface CatalogTemplate {
  id: string;
  label: string;
  source: 'builtin' | 'user';
  document: StatementTemplate;
}

function limits() {
  return {
    max_file_bytes: STATEMENT_IMPORT_MAX_FILE_BYTES,
    max_files: STATEMENT_IMPORT_MAX_FILES,
    max_rows: STATEMENT_IMPORT_MAX_ROWS,
    inline_max_bytes: STATEMENT_IMPORT_MAX_FILE_BYTES,
  };
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof ValidationError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.message) return { code: 'IMPORT_FILE_INVALID', message: error.message };
  return { code: 'IMPORT_FILE_INVALID', message: 'Statement import failed' };
}

export async function templateUpdateAutoConfirmDecision(
  db: D1Database,
  clientId: string,
  templateId: unknown,
): Promise<'allow' | 'deny' | 'skip'> {
  if (typeof templateId !== 'string' || !templateId.trim()) return 'skip';
  const stored = await getStatementTemplate(db, templateId.trim());
  if (!stored) return 'skip';
  const sameClient = clientId !== 'anonymous' && stored.createdByClientId === clientId;
  if (stored.createdVia === 'mcp' && sameClient && stored.usedBatchId == null) return 'allow';
  return 'deny';
}

export async function readStatementTemplateTool(
  db: D1Database,
  name: 'template_list' | 'template_get',
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === 'template_list') {
    const stored = await listStatementTemplates(db);
    return {
      templates: [
        ...BUILTIN_TEMPLATES.map((template) => ({
          id: template.id,
          label: template.label,
          format: template.format,
          source: 'builtin',
          readonly: true,
          used: false,
        })),
        ...stored.map((row) => ({
          id: row.templateId,
          label: row.label,
          format: row.format,
          source: 'user',
          readonly: false,
          created_via: row.createdVia,
          used: row.usedBatchId != null,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        })),
      ],
    };
  }
  const templateId = typeof args.template_id === 'string' ? args.template_id.trim() : '';
  if (!templateId) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  const builtin = builtinTemplateById(templateId);
  if (builtin) return templateJson(builtin, 'builtin');
  const stored = await getStatementTemplate(db, templateId);
  if (!stored) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  return templateJson(stored.document, 'user', stored);
}

async function catalog(db: D1Database): Promise<CatalogTemplate[]> {
  const stored = await listStatementTemplates(db);
  return [
    ...BUILTIN_TEMPLATES.map((document) => ({ id: document.id, label: document.label, source: 'builtin' as const, document })),
    ...stored.map((row) => ({ id: row.templateId, label: row.label, source: 'user' as const, document: row.document })),
  ];
}

function headerCells(line: string): Set<string> {
  return new Set(line.split(/[,;\t|]/).map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase()));
}

function csvTemplateMatches(text: string, template: StatementTemplate): boolean {
  if (template.format !== 'csv' || !template.csv) return false;
  const names = Object.values(template.csv.mapping).filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (names.length === 0) return false;
  const wanted = names.map((name) => name.toLowerCase());
  return text.split(/\r?\n/).slice(0, 40).some((line) => {
    const cells = headerCells(line);
    return wanted.every((name) => cells.has(name));
  });
}

function statementText(bytes: Uint8Array): string | null {
  if (isOleWorkbook(bytes) || isPdfBytes(bytes)) return null;
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
}

function detectTemplateId(
  templates: CatalogTemplate[],
  text: string | null,
  bytes: Uint8Array | null,
  explicitFormat: string | null,
  filename: string | null,
): string | null {
  if (looksLikePdf({ filename, text, bytes })) return null;
  const ole = bytes ? isOleWorkbook(bytes) : false;
  const format = explicitFormat && explicitFormat !== 'auto'
    ? explicitFormat
    : ole ? 'xls' : (text ? detectTextFormat(text) : null);
  if (format === 'xls') {
    const xls = templates.filter((template) => template.document.format === 'xls');
    return xls.length === 1 ? xls[0]!.id : null;
  }
  if (format === 'csv' && text) {
    const matches = templates.filter((template) => csvTemplateMatches(text, template.document));
    return matches.length === 1 ? matches[0]!.id : null;
  }
  return null;
}

function assertTransportSize(byteLength: number): void {
  if (byteLength > STATEMENT_IMPORT_MAX_FILE_BYTES) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'file', limit: STATEMENT_IMPORT_MAX_FILE_BYTES });
  }
}

async function loadStatementFile(
  db: D1Database,
  args: Record<string, unknown>,
): Promise<{ filename: string; text: string | null; bytes: Uint8Array | null; uploadId: string | null }> {
  const sources = [args.content, args.content_base64, args.upload_id].filter((value) => value !== undefined && value !== null && value !== '');
  if (sources.length !== 1) {
    throw new ValidationError('IMPORT_FILE_INVALID', {
      filename: 'file',
      detail: 'provide exactly one of content, content_base64, or upload_id',
    });
  }
  const filename = typeof args.filename === 'string' && args.filename.trim()
    ? args.filename.trim().slice(0, 200)
    : 'statement.csv';
  if (typeof args.upload_id === 'string' && args.upload_id.trim()) {
    const stored = await readStatementUpload(db, args.upload_id.trim());
    assertTransportSize(stored.bytes.byteLength);
    const text = statementText(stored.bytes);
    return { filename: filename === 'statement.csv' ? stored.filename : filename, text, bytes: stored.bytes, uploadId: args.upload_id.trim() };
  }
  if (typeof args.content_base64 === 'string') {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(args.content_base64);
    } catch {
      throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'content_base64 is not valid base64' });
    }
    assertTransportSize(bytes.byteLength);
    if (bytes.byteLength === 0) {
      throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'file is empty' });
    }
    const text = statementText(bytes);
    return { filename, text, bytes, uploadId: null };
  }
  if (typeof args.content !== 'string') {
    throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'content must be a string' });
  }
  const bytes = new TextEncoder().encode(args.content);
  assertTransportSize(bytes.byteLength);
  if (!args.content.trim()) {
    throw new ValidationError('IMPORT_FILE_INVALID', { filename, detail: 'file is empty' });
  }
  const pdf = isPdfBytes(bytes) || args.content.startsWith('%PDF') || isPdfName(filename);
  return { filename, text: pdf ? null : args.content, bytes, uploadId: null };
}

interface PreviewRowView {
  index: number;
  date: string;
  amount_minor: number;
  currency: string;
  description: string;
  kind: string;
  duplicate: boolean;
  duplicate_reason: string | null;
  account_id: number | null;
  currency_mismatch: boolean;
  fingerprint: string;
}

export interface PreparedStatementImport {
  ok: true;
  preview: Record<string, unknown>;
  confirmedArgs: Record<string, unknown>;
  description: string;
  uploadIds: string[];
}

export interface RejectedStatementImport {
  ok: false;
  code: string;
  message: string;
  preview: Record<string, unknown> | null;
}

function categoryModeOf(value: unknown): CategoryMode {
  if (value === undefined || value === 'manual') return 'manual';
  if (value === 'rules') return 'rules';
  throw new ValidationError('IMPORT_ROW_INVALID', { field: 'category_mode' });
}

export async function prepareStatementImport(
  db: D1Database,
  args: Record<string, unknown>,
  idempotencyKey: string,
): Promise<PreparedStatementImport | RejectedStatementImport> {
  try {
    const file = await loadStatementFile(db, args);
    const templates = await catalog(db);
    const explicit = typeof args.template_id === 'string' && args.template_id.trim() ? args.template_id.trim() : null;
    const format = typeof args.format === 'string' ? args.format : null;
    const templateId = explicit ?? detectTemplateId(templates, file.text, file.bytes, format, file.filename);
    const accountId = args.account_id;
    if (accountId !== undefined && accountId !== null && (typeof accountId !== 'number' || !Number.isInteger(accountId) || accountId < 1)) {
      throw new ValidationError('ACCOUNT_ID_REQUIRED');
    }
    const mode = categoryModeOf(args.category_mode);
    const preview = await previewStatementImport(db, mode, [{
      filename: file.filename,
      format: 'auto',
      presetId: templateId,
      text: file.text,
      bytes: file.bytes,
      encoding: null,
      mapping: null,
      options: null,
      xlsLayout: null,
      accountId: typeof accountId === 'number' ? accountId : null,
      accountHint: null,
    }]);
    return shapePreview(preview, templates, idempotencyKey, file.uploadId ? [file.uploadId] : []);
  } catch (error) {
    const parsed = failure(error);
    return { ok: false, code: parsed.code, message: parsed.message, preview: null };
  }
}

function shapePreview(
  preview: { category_mode: CategoryMode; files: Array<Record<string, any>> },
  templates: CatalogTemplate[],
  idempotencyKey: string,
  uploadIds: string[],
): PreparedStatementImport | RejectedStatementImport {
  const rows: PreviewRowView[] = [];
  const mapping: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const commitRows: CommitRowInput[] = [];
  let detectedFormat: string | null = null;
  let presetId: string | null = null;
  for (const file of preview.files) {
    detectedFormat = typeof file.format === 'string' ? file.format : detectedFormat;
    presetId = typeof file.preset_id === 'string' ? file.preset_id : presetId;
    if (Array.isArray(file.warnings)) warnings.push(...file.warnings.filter((item: unknown) => typeof item === 'string'));
    for (const statement of file.statements ?? []) {
      if (Array.isArray(statement.warnings)) {
        warnings.push(...statement.warnings.filter((item: unknown) => typeof item === 'string'));
      }
      mapping.push({
        filename: file.filename,
        account_ref: statement.account_ref ?? null,
        account_id: statement.account_id ?? null,
        match: statement.match ?? null,
        account_currency: statement.account_currency ?? null,
        statement_currency: statement.statement_currency ?? null,
      });
      for (const row of statement.rows ?? []) {
        const view: PreviewRowView = {
          index: row.index,
          date: row.date,
          amount_minor: row.amount_minor,
          currency: row.currency,
          description: row.description,
          kind: row.kind,
          duplicate: Boolean(row.duplicate),
          duplicate_reason: row.duplicate_reason ?? null,
          account_id: statement.account_id ?? null,
          currency_mismatch: Boolean(row.currency_mismatch),
          fingerprint: row.fingerprint,
        };
        rows.push(view);
        const account = statement.account_id;
        if (typeof account === 'number' && account > 0 && !view.currency_mismatch) {
          commitRows.push({
            include: true,
            accountId: account,
            date: row.date,
            amountMinor: row.amount_minor,
            currency: row.currency,
            kind: row.kind as StatementKind,
            item: row.description,
            store: row.merchant ?? null,
            category: row.proposed_category ?? null,
            subcategory: row.proposed_subcategory ?? null,
            comment: null,
            bankTransactionId: row.bank_transaction_id ?? null,
            statementDescription: row.description,
            fingerprint: row.fingerprint,
          });
        }
      }
    }
  }
  const template = presetId ? templates.find((item) => item.id === presetId) ?? null : null;
  const duplicates = rows.filter((row) => row.duplicate).length;
  const totals = new Map<string, { currency: string; rows: number; duplicates: number; amount_minor: number }>();
  for (const row of rows) {
    const bucket = totals.get(row.currency) ?? { currency: row.currency, rows: 0, duplicates: 0, amount_minor: 0 };
    bucket.rows += 1;
    if (row.duplicate) bucket.duplicates += 1;
    else if (!row.currency_mismatch && row.account_id !== null) bucket.amount_minor += row.amount_minor;
    totals.set(row.currency, bucket);
  }
  const publicPreview: Record<string, unknown> = {
    category_mode: preview.category_mode,
    detected_template: template ? { id: template.id, label: template.label, source: template.source, format: template.document.format } : null,
    detected_format: detectedFormat,
    account_mapping: mapping,
    rows,
    duplicates,
    totals: [...totals.values()],
    warnings,
    limits: limits(),
    committable: false,
  };
  if (rows.length === 0) {
    const detail = warnings[0] ?? (presetId ? `template ${presetId} matched no rows` : 'no statement rows were parsed');
    return {
      ok: false,
      code: 'IMPORT_NO_ROWS',
      message: apiErrorMessage('IMPORT_NO_ROWS', { detail }),
      preview: publicPreview,
    };
  }
  const blocked = rows.filter((row) => !row.duplicate && (row.account_id === null || row.currency_mismatch));
  if (blocked.length > 0) {
    const code = blocked.some((row) => row.currency_mismatch) ? 'IMPORT_CURRENCY_MISMATCH' : 'IMPORT_ACCOUNT_REQUIRED';
    const message = code === 'IMPORT_ACCOUNT_REQUIRED'
      ? apiErrorMessage('IMPORT_ACCOUNT_REQUIRED')
      : apiErrorMessage('IMPORT_CURRENCY_MISMATCH', {
        rowCurrency: blocked.find((row) => row.currency_mismatch)?.currency ?? '',
        accountCurrency: String(mapping.find((item) => item.account_currency)?.account_currency ?? ''),
      });
    return { ok: false, code, message, preview: publicPreview };
  }
  publicPreview.committable = true;
  const files = preview.files.map((file) => ({
    filename: String(file.filename),
    preset_id: typeof file.preset_id === 'string' ? file.preset_id : null,
  }));
  const description = `Confirm statement import of ${rows.length} row(s), ${duplicates} duplicate(s) skipped, from ${files.map((file) => file.filename).join(', ') || 'the file'}${template ? ` using template ${template.id}` : ''}.`;
  return {
    ok: true,
    preview: publicPreview,
    description,
    uploadIds,
    confirmedArgs: {
      idempotency_key: idempotencyKey,
      category_mode: preview.category_mode,
      file_count: files.length,
      files,
      rows: commitRows,
      upload_ids: uploadIds,
      duplicate_count: duplicates,
    },
  };
}

function copyTemplate(source: StatementTemplate, id: string, label: string | undefined): StatementTemplate {
  const next = structuredClone(source) as StatementTemplate;
  next.id = id;
  if (label !== undefined) next.label = label;
  return parseStatementTemplate(next);
}

export async function validateStatementWrite(
  name: string,
  args: Record<string, unknown>,
  db: D1Database | undefined,
  idempotencyKey: string,
): Promise<{ error?: string; description?: string; confirmedArgs?: Record<string, unknown>; uploadIds?: string[] }> {
  if (!db) return { error: 'Ledger storage is unavailable' };
  try {
    if (name === 'template_create') {
      const hasCopy = typeof args.copy_from === 'string' && args.copy_from.trim().length > 0;
      const hasDocument = args.document !== undefined;
      if (hasCopy === hasDocument) {
        return { error: 'Provide copy_from or document, not both' };
      }
      let document: StatementTemplate;
      if (hasCopy) {
        const sourceId = String(args.copy_from).trim();
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { error: 'id is required when copy_from is set' };
        const builtin = builtinTemplateById(sourceId);
        const stored = builtin ? null : await getStatementTemplate(db, sourceId);
        if (!builtin && !stored) return { error: `TEMPLATE_NOT_FOUND: ${apiErrorMessage('TEMPLATE_NOT_FOUND')}` };
        const label = typeof args.label === 'string' ? args.label : undefined;
        document = copyTemplate((builtin ?? stored!.document), id, label);
      } else {
        document = parseStatementTemplate(args.document);
      }
      if (isBuiltinTemplateId(document.id)) {
        return { error: `TEMPLATE_ID_RESERVED: ${apiErrorMessage('TEMPLATE_ID_RESERVED')}` };
      }
      return {
        description: `Confirm creating statement template "${document.label}" (${document.id})${hasCopy ? ` copied from ${String(args.copy_from).trim()}` : ''}`,
        confirmedArgs: { idempotency_key: idempotencyKey, document, created_by_client_id: null },
      };
    }
    if (name === 'template_update') {
      const templateId = typeof args.template_id === 'string' ? args.template_id.trim() : '';
      if (isBuiltinTemplateId(templateId)) {
        return { error: `TEMPLATE_READONLY: ${apiErrorMessage('TEMPLATE_READONLY')}` };
      }
      const current = await getStatementTemplate(db, templateId);
      if (!current) return { error: `TEMPLATE_NOT_FOUND: ${apiErrorMessage('TEMPLATE_NOT_FOUND')}` };
      const patch: { label?: string; document?: StatementTemplate } = {};
      if (args.document !== undefined) patch.document = parseStatementTemplate(args.document);
      if (args.label !== undefined) {
        if (typeof args.label !== 'string') return { error: 'label must be a string' };
        patch.label = args.label;
      }
      if (!patch.document && patch.label === undefined) return { error: 'label or document is required' };
      return {
        description: `Confirm updating statement template "${current.label}" (${templateId})`,
        confirmedArgs: { idempotency_key: idempotencyKey, template_id: templateId, ...patch },
      };
    }
    if (name === 'template_delete') {
      const templateId = typeof args.template_id === 'string' ? args.template_id.trim() : '';
      if (isBuiltinTemplateId(templateId)) {
        return { error: `TEMPLATE_READONLY: ${apiErrorMessage('TEMPLATE_READONLY')}` };
      }
      const current = await getStatementTemplate(db, templateId);
      if (!current) return { error: `TEMPLATE_NOT_FOUND: ${apiErrorMessage('TEMPLATE_NOT_FOUND')}` };
      return {
        description: `Confirm deleting user statement template "${current.label}" (${templateId}). Built-in templates are not affected.`,
        confirmedArgs: { idempotency_key: idempotencyKey, template_id: templateId },
      };
    }
    if (name === 'statement_import_undo') {
      const batchId = args.batch_id;
      if (typeof batchId !== 'number' || !Number.isInteger(batchId) || batchId < 1) return { error: 'Invalid batch_id' };
      if (args.phrase !== IMPORT_UNDO_PHRASE) {
        return { error: `phrase must be exactly ${IMPORT_UNDO_PHRASE}` };
      }
      const found = await getImportBatch(db, batchId);
      if (!found) return { error: `IMPORT_BATCH_NOT_FOUND: ${apiErrorMessage('IMPORT_BATCH_NOT_FOUND')}` };
      if (found.batch.status === 'undone') {
        return { error: `IMPORT_ALREADY_UNDONE: ${apiErrorMessage('IMPORT_ALREADY_UNDONE')}` };
      }
      return {
        description: `Confirm undoing import batch ${batchId}: remove ${found.operations.length} operation(s) from ${found.batch.file_count} file(s) and restore the affected balances. The whole batch is undone.`,
        confirmedArgs: { idempotency_key: idempotencyKey, batch_id: batchId, phrase: IMPORT_UNDO_PHRASE },
      };
    }
    if (name === 'statement_import_commit') {
      const prepared = await prepareStatementImport(db, args, idempotencyKey);
      if (!prepared.ok) return { error: `${prepared.code}: ${prepared.message}` };
      return {
        description: prepared.description,
        confirmedArgs: prepared.confirmedArgs,
        uploadIds: prepared.uploadIds,
      };
    }
    return { error: `Tool not found: ${name}` };
  } catch (error) {
    const parsed = failure(error);
    return { error: `${parsed.code}: ${parsed.message}` };
  }
}

function stampClient(confirmedArgs: Record<string, unknown>, clientId: string): Record<string, unknown> {
  if ('created_by_client_id' in confirmedArgs) {
    return { ...confirmedArgs, created_by_client_id: clientId };
  }
  return confirmedArgs;
}

export async function executeStatementMutation(
  db: D1Database,
  name: string,
  confirmedArgs: Record<string, unknown>,
  clientId: string,
): Promise<Record<string, unknown>> {
  const args = stampClient(confirmedArgs, clientId);
  if (name === 'template_create') {
    const document = parseStatementTemplate(args.document);
    const client = typeof args.created_by_client_id === 'string' ? args.created_by_client_id : null;
    const stored = await insertStatementTemplate(db, document, {
      createdVia: 'mcp',
      createdByClientId: client && client !== 'anonymous' ? client.slice(0, 200) : null,
    });
    return { template: templateJson(stored.document, 'user', stored), written: true };
  }
  if (name === 'template_update') {
    const patch: { label?: string; document?: StatementTemplate } = {};
    if (args.document !== undefined) patch.document = parseStatementTemplate(args.document);
    if (typeof args.label === 'string') patch.label = args.label;
    const stored = await updateStatementTemplate(db, String(args.template_id), patch);
    return { template: templateJson(stored.document, 'user', stored), written: true };
  }
  if (name === 'template_delete') {
    const templateId = String(args.template_id);
    await deleteStatementTemplate(db, templateId);
    return { template_id: templateId, deleted: true, written: true };
  }
  if (name === 'statement_import_undo') {
    const batchId = args.batch_id as number;
    const result = await undoStatementImport(db, batchId);
    return {
      undone: true,
      batch_id: batchId,
      removed: result.batch.row_count,
      view_path: STATEMENT_IMPORT_VIEW_PATH,
      written: true,
    };
  }
  if (name === 'statement_import_commit') {
    const rows = args.rows as CommitRowInput[];
    const uploadIds = Array.isArray(args.upload_ids) ? args.upload_ids.filter((id): id is string => typeof id === 'string') : [];
    const duplicateCount = typeof args.duplicate_count === 'number' ? args.duplicate_count : 0;
    if (!Array.isArray(rows) || rows.length === 0) {
      await consumeStatementUploads(db, uploadIds);
      return {
        written: false,
        added: 0,
        skipped_duplicates: duplicateCount,
        batch_id: null,
        view_path: STATEMENT_IMPORT_VIEW_PATH,
        undo_tool: null,
        idempotent_replay: false,
      };
    }
    const result = await commitStatementImport(db, {
      idempotencyKey: String(args.idempotency_key),
      categoryMode: args.category_mode as CategoryMode,
      fileCount: args.file_count as number,
      filesJson: JSON.stringify(args.files ?? []),
      rows,
    });
    await consumeStatementUploads(db, uploadIds);
    const batchId = result.batch?.id ?? null;
    return {
      written: result.written === true,
      added: result.inserted.length,
      skipped_duplicates: result.skipped.length,
      batch_id: batchId,
      view_path: STATEMENT_IMPORT_VIEW_PATH,
      undo_tool: batchId === null ? null : 'statement_import_undo',
      idempotent_replay: result.idempotent_replay,
    };
  }
  throw new ValidationError('IMPORT_FILE_INVALID', { filename: name, detail: 'unsupported statement tool' });
}

export async function createStatementUploadForMcp(
  db: D1Database,
  secret: string,
  filename: unknown,
  origin: string,
): Promise<Record<string, unknown>> {
  const slot = await createStatementUploadSlot(db, secret, filename, origin);
  return {
    ...slot,
    method: 'PUT',
    written: false,
    resultType: 'complete',
    description: `PUT the raw file once to upload_url before ${slot.expires_at}, then pass upload_id to statement_import_preview. The ledger was not changed.`,
  };
}

export function statementPreviewIdempotencyKey(args: Record<string, unknown>): string {
  if (typeof args.idempotency_key === 'string' && args.idempotency_key.trim()) return args.idempotency_key.trim();
  return crypto.randomUUID();
}

export async function consumePreparedUploads(db: D1Database, uploadIds: readonly string[]): Promise<void> {
  await consumeStatementUploads(db, uploadIds);
}

export function publicTemplate(stored: StoredStatementTemplate) {
  return templateJson(stored.document, 'user', stored);
}
