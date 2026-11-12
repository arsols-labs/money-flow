// Pure state for the Data-screen statement import flow.
// The worker API in statement-import.ts owns parsing and the ledger write.
// This module only shapes requests, row edits, totals, and the idempotency key.
import { statementFingerprint } from '../shared/statement-import/amounts';
import { suggestCsvDateFormat } from '../shared/statement-import/csv';
import { fractionDigits } from '../shared/currency';
import { formatTemplateErrors, validateStatementTemplate } from '../shared/statement-import/template-schema';
import { IMPORT_UNDO_PHRASE } from '../shared/statement-import/types';

export { IMPORT_UNDO_PHRASE };

export const PRESET_AUTO = 'auto';
export const PRESET_GENERIC = 'generic';

export const STATEMENT_FILE_EXTENSIONS = ['.csv', '.ofx', '.qfx', '.xml', '.xls', '.pdf'];

const KNOWN_PRESET_FORMAT = {
  'us-bofa': 'csv',
  'us-bofa-pdf': 'pdf',
  'rs-bps': 'xls',
  'rs-bps-pdf': 'pdf',
};

export const DEFAULT_MAPPING = {
  date: 'Date',
  amount: 'Amount',
  debit: '',
  credit: '',
  currency: '',
  description: 'Description',
  merchant: '',
  counterparty: '',
  reference: '',
  balance: '',
};

export const DEFAULT_OPTIONS = {
  delimiter: ',',
  decimalSeparator: '.',
  dateFormat: 'YYYY-MM-DD',
  encoding: 'utf-8',
  hasHeader: true,
  defaultCurrency: '',
  headerSearch: true,
  skipRows: 0,
};

export function formatByteCount(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${Math.ceil(bytes / 1024)} KiB`;
}

export function extensionOf(name) {
  const dot = String(name).lastIndexOf('.');
  return dot >= 0 ? String(name).slice(dot).toLowerCase() : '';
}

export function isAcceptedStatementName(name) {
  return STATEMENT_FILE_EXTENSIONS.includes(extensionOf(name));
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function presetFormat(presetId, presets) {
  if (presetId === PRESET_AUTO) return 'auto';
  if (presetId === PRESET_GENERIC) return 'csv';
  const found = (presets || []).find((preset) => preset.id === presetId);
  return found?.format || KNOWN_PRESET_FORMAT[presetId] || 'auto';
}

export function compactMapping(mapping) {
  const out = {};
  for (const key of ['date', 'amount', 'debit', 'credit', 'currency', 'description', 'merchant', 'counterparty', 'reference', 'balance']) {
    const value = String(mapping?.[key] ?? '').trim();
    if (value) out[key] = value;
  }
  return out;
}

export function compactOptions(options) {
  const out = {
    delimiter: options.delimiter,
    decimal_separator: options.decimalSeparator,
    date_format: options.dateFormat,
    encoding: options.encoding,
    has_header: Boolean(options.hasHeader),
  };
  const currency = String(options.defaultCurrency ?? '').trim().toUpperCase();
  if (currency) out.default_currency = currency;
  const skipRows = Number(options.skipRows);
  if (Number.isInteger(skipRows) && skipRows > 0) out.skip_rows = skipRows;
  if (options.headerSearch === false) out.header_search = false;
  return out;
}

export function mappingReady(mapping) {
  return Boolean(String(mapping?.date ?? '').trim());
}

export function usesGenericMapping(presetId, files) {
  if (presetId === PRESET_GENERIC) return true;
  return (files || []).some((file) => file.presetId === PRESET_GENERIC);
}

export function previewRequestProblems({ presetId, files, mapping, options }) {
  const problems = [];
  if (!files?.length) problems.push('files');
  if (usesGenericMapping(presetId, files) && !mappingReady(mapping)) problems.push('date');
  const currency = String(options?.defaultCurrency ?? '').trim();
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) problems.push('currency');
  return problems;
}

/**
 * @param {{ name: string, size: number, base64?: string }} incoming
 * @param {{ existingCount: number, existingBodyBytes: number, limits: { max_files: number, max_file_bytes: number, max_body_bytes: number } }} context
 */
export function fileAdmissionError(incoming, context) {
  if (!isAcceptedStatementName(incoming.name)) {
    return { code: 'unsupported', name: incoming.name };
  }
  const limits = context.limits;
  if (incoming.size > limits.max_file_bytes) {
    return { code: 'IMPORT_TOO_LARGE', scope: 'file', limit: limits.max_file_bytes, name: incoming.name };
  }
  if (context.existingCount + 1 > limits.max_files) {
    return { code: 'IMPORT_TOO_LARGE', scope: 'files', limit: limits.max_files, name: incoming.name };
  }
  const encoded = incoming.base64 ? incoming.base64.length : Math.ceil(incoming.size * 4 / 3);
  if (context.existingBodyBytes + encoded + 2048 > limits.max_body_bytes) {
    return { code: 'IMPORT_TOO_LARGE', scope: 'body', limit: limits.max_body_bytes, name: incoming.name };
  }
  return null;
}

export function encodedBodyBytes(files) {
  return (files || []).reduce((sum, file) => sum + String(file.base64 || '').length, 0);
}

export function buildPreviewFile(file, { mapping, options, presets }) {
  const presetId = file.presetId;
  const body = {
    filename: file.name,
    content_base64: file.base64,
    format: presetFormat(presetId, presets),
  };
  if (presetId !== PRESET_AUTO && presetId !== PRESET_GENERIC) body.preset_id = presetId;
  if (file.accountId) body.account_id = file.accountId;
  if (presetId === PRESET_GENERIC) {
    body.mapping = compactMapping(mapping);
    body.options = compactOptions(options);
  }
  return body;
}

export function buildPreviewRequest({ categoryMode, files, mapping, options, presets }) {
  return {
    category_mode: categoryMode,
    files: files.map((file) => buildPreviewFile(file, { mapping, options, presets })),
  };
}

export function previewFailureDetail(preview) {
  const notes = [];
  for (const file of preview?.files || []) {
    for (const warning of file.warnings || []) notes.push(`${file.filename}: ${warning}`);
    for (const statement of file.statements || []) {
      for (const warning of statement.warnings || []) notes.push(`${file.filename}: ${warning}`);
    }
  }
  return notes.slice(0, 3).join('; ');
}

export function rowsFromPreview(preview) {
  const rows = [];
  const files = preview?.files || [];
  files.forEach((file, fileIndex) => {
    (file.statements || []).forEach((statement, statementIndex) => {
      (statement.rows || []).forEach((row) => {
        rows.push({
          key: `${fileIndex}:${statementIndex}:${row.index}`,
          fileIndex,
          statementIndex,
          filename: file.filename,
          format: file.format,
          fileWarnings: file.warnings || [],
          statementWarnings: statement.warnings || [],
          accountRef: statement.account_ref,
          statementCurrency: statement.statement_currency,
          accountId: statement.account_id,
          accountCurrency: statement.account_currency,
          match: statement.match,
          index: row.index,
          date: row.date,
          amountMinor: row.amount_minor,
          currency: row.currency,
          description: row.description,
          merchant: row.merchant,
          counterparty: row.counterparty,
          bankTransactionId: row.bank_transaction_id,
          kind: row.kind,
          duplicate: Boolean(row.duplicate),
          duplicateInBatch: Boolean(row.duplicate_in_batch),
          duplicateReason: row.duplicate_reason,
          duplicateBatchId: row.duplicate_batch_id ?? null,
          duplicateBatchCreatedAt: row.duplicate_batch_created_at ?? null,
          duplicateBatchFiles: Array.isArray(row.duplicate_batch_files)
            ? row.duplicate_batch_files.map((file) => file?.filename).filter(Boolean)
            : [],
          ownTransfer: Boolean(row.possible_own_account_transfer),
          currencyMismatch: Boolean(row.currency_mismatch),
          currencyFromAccount: Boolean(row.currency_from_account),
          warnings: row.warnings || [],
          include: !row.duplicate,
          category: row.proposed_category || '',
          subcategory: row.proposed_subcategory || '',
          categoryRuleId: row.category_rule_id,
        });
      });
    });
  });
  return rows;
}

export function statementGroups(rows) {
  const groups = [];
  const index = new Map();
  for (const row of rows) {
    const key = `${row.fileIndex}:${row.statementIndex}`;
    let group = index.get(key);
    if (!group) {
      group = {
        key,
        filename: row.filename,
        format: row.format,
        fileWarnings: row.fileWarnings,
        statementWarnings: row.statementWarnings,
        accountRef: row.accountRef,
        statementCurrency: row.statementCurrency,
        accountId: row.accountId,
        match: row.match,
        rows: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
    group.accountId = row.accountId;
    group.match = row.match;
  }
  return groups;
}

function accountById(accounts, accountId) {
  return (accounts || []).find((account) => account.id === accountId) ?? null;
}

export function withInclude(rows, key, include) {
  return rows.map((row) => (row.key === key ? { ...row, include: Boolean(include) } : row));
}

export function withCategory(rows, key, patch) {
  return rows.map((row) => {
    if (row.key !== key) return row;
    const category = patch.category !== undefined ? patch.category : row.category;
    const subcategory = patch.subcategory !== undefined ? patch.subcategory : row.subcategory;
    return {
      ...row,
      category,
      subcategory: category ? subcategory : '',
    };
  });
}

export function withStatementAccount(rows, statementKey, accountId, accounts) {
  const account = accountById(accounts, accountId);
  return rows.map((row) => {
    if (`${row.fileIndex}:${row.statementIndex}` !== statementKey) return row;
    const next = {
      ...row,
      accountId: account ? account.id : null,
      accountCurrency: account?.currency ?? null,
      currencyMismatch: Boolean(account && account.currency !== row.currency),
      match: account ? 'explicit' : null,
    };
    if (row.currencyFromAccount && account) {
      if (fractionDigits(account.currency) === fractionDigits(row.currency)) {
        next.currency = account.currency;
        next.currencyMismatch = false;
      } else {
        next.currencyMismatch = true;
      }
    }
    return next;
  });
}

export function base64ToText(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export function preselectDateFormat(text, mapping, options) {
  if (!text || !mappingReady(mapping)) return options;
  const suggested = suggestCsvDateFormat(text, {
    date: mapping.date,
    amount: mapping.amount || undefined,
    debit: mapping.debit || undefined,
    credit: mapping.credit || undefined,
    description: mapping.description || undefined,
    balance: mapping.balance || undefined,
  }, {
    delimiter: options.delimiter || ',',
    decimalSeparator: options.decimalSeparator || '.',
    dateFormat: options.dateFormat || 'YYYY-MM-DD',
    encoding: options.encoding || 'utf-8',
    hasHeader: options.hasHeader !== false,
    defaultCurrency: options.defaultCurrency || null,
    headerSearch: options.headerSearch !== false,
    skipRows: Number(options.skipRows) || 0,
  });
  if (!suggested || suggested === options.dateFormat) return options;
  return { ...options, dateFormat: suggested };
}

export function commitBlockers(rows) {
  const included = rows.filter((row) => row.include);
  return {
    included: included.length,
    missingAccount: included.filter((row) => !row.accountId).length,
    currencyMismatch: included.filter((row) => row.currencyMismatch).length,
    subcategoryWithoutCategory: included.filter((row) => row.subcategory && !row.category).length,
  };
}

export function canCommit(rows) {
  const blockers = commitBlockers(rows);
  return blockers.included > 0
    && blockers.missingAccount === 0
    && blockers.currencyMismatch === 0
    && blockers.subcategoryWithoutCategory === 0;
}

export function summarizeCommit(rows, accounts) {
  const groups = [];
  const index = new Map();
  for (const row of rows) {
    if (!row.include) continue;
    const key = `${row.accountId}:${row.currency}`;
    let group = index.get(key);
    if (!group) {
      const account = accountById(accounts, row.accountId);
      group = {
        accountId: row.accountId,
        accountName: account?.name || '',
        currency: row.currency,
        count: 0,
        amountMinor: 0,
      };
      index.set(key, group);
      groups.push(group);
    }
    group.count += 1;
    group.amountMinor += row.amountMinor;
  }
  return {
    count: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  };
}

export function existingExpenseDuplicateRows(rows) {
  return (rows || []).filter((row) => (
    row.include
    && row.duplicateReason === 'expense_duplicate'
    && !row.duplicateInBatch
  ));
}

export function describeStatementRows(rows) {
  return (rows || []).map((row) => `${row.date} ${row.description}`.trim()).filter(Boolean).join(', ');
}

export function buildCommitRow(row) {
  const category = String(row.category || '').trim();
  const subcategory = String(row.subcategory || '').trim();
  return {
    include: true,
    account_id: row.accountId,
    date: row.date,
    amount_minor: row.amountMinor,
    currency: row.currency,
    kind: row.kind,
    item: row.description,
    store: row.merchant || row.counterparty || null,
    category: category || null,
    subcategory: category ? (subcategory || null) : null,
    statement_description: row.description,
    bank_transaction_id: row.bankTransactionId || null,
    fingerprint: statementFingerprint({
      accountId: row.accountId,
      date: row.date,
      amountMinor: row.amountMinor,
      currency: row.currency,
      description: row.description,
      bankTransactionId: row.bankTransactionId || null,
    }),
  };
}

export function buildCommitPayload(rows, { categoryMode, fileCount, idempotencyKey, files = [] }) {
  return {
    idempotency_key: idempotencyKey,
    category_mode: categoryMode,
    file_count: fileCount,
    files: (files || []).map((file) => ({
      filename: file.name,
      preset_id: file.presetId || null,
    })),
    rows: rows.filter((row) => row.include).map(buildCommitRow),
  };
}

export function describeImportBatch(detail) {
  const batch = detail?.batch || {};
  const operations = Array.isArray(detail?.operations) ? detail.operations : [];
  const files = Array.isArray(batch.files) ? batch.files : [];
  const dates = operations
    .map((operation) => operation.date)
    .filter((date) => typeof date === 'string' && date)
    .sort();
  const accounts = [];
  const seenAccounts = new Set();
  const totals = [];
  const totalIndex = new Map();
  for (const operation of operations) {
    const accountKey = `${operation.account_id}:${operation.account_name || ''}`;
    if (!seenAccounts.has(accountKey)) {
      seenAccounts.add(accountKey);
      accounts.push({
        id: operation.account_id,
        name: operation.account_name || '',
      });
    }
    const currency = operation.currency || '';
    const kind = operation.kind === 'income' ? 'income' : 'expense';
    const key = `${currency}:${kind}`;
    let bucket = totalIndex.get(key);
    if (!bucket) {
      bucket = { currency, kind, amountMinor: 0 };
      totalIndex.set(key, bucket);
      totals.push(bucket);
    }
    bucket.amountMinor += Number(operation.amount_minor) || 0;
  }
  let emptyReason = null;
  if (operations.length === 0) {
    if (batch.status === 'undone') emptyReason = 'undone';
    else if (Number(batch.row_count) > 0) emptyReason = 'unlinked';
    else emptyReason = 'empty';
  }
  return {
    files,
    accounts,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
    totals,
    operations,
    emptyReason,
  };
}

export function idempotencyForPayload(previous, payloadWithoutKey) {
  const digest = JSON.stringify(payloadWithoutKey);
  if (previous && previous.digest === digest) return previous;
  return { key: createIdempotencyKey(), digest };
}

export function interpretCommit(result) {
  const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
  if (result?.idempotent_replay) {
    return { kind: 'replay', batchId: result.batch?.id ?? null, skipped, inserted: 0 };
  }
  if (result?.written) {
    const inserted = Array.isArray(result.inserted) ? result.inserted.length : 0;
    return { kind: 'written', batchId: result.batch?.id ?? null, skipped, inserted };
  }
  return { kind: 'skipped', batchId: null, skipped, inserted: 0 };
}

export function undoPhraseMatches(value) {
  return value === IMPORT_UNDO_PHRASE;
}

export function summarizeRemoval(operations, accounts) {
  const groups = [];
  const index = new Map();
  for (const operation of operations || []) {
    const account = accountById(accounts, operation.account_id);
    const currency = operation.currency || account?.currency || '';
    const key = `${operation.account_id}:${currency}`;
    let group = index.get(key);
    if (!group) {
      group = {
        accountId: operation.account_id,
        accountName: operation.account_name || account?.name || '',
        currency,
        count: 0,
        amountMinor: 0,
      };
      index.set(key, group);
      groups.push(group);
    }
    group.count += 1;
    group.amountMinor += operation.amount_minor;
  }
  return { count: (operations || []).length, groups };
}

/**
 * @param {{
 *   operations?: Array<{ category?: string | null, subcategory?: string | null }>,
 *   planned?: Array<{ category?: string | null, subcategory?: string | null }>,
 *   recurring?: Array<{ category?: string | null, subcategory?: string | null }>,
 *   rules?: Array<{ category?: string | null, subcategory?: string | null }>,
 * }} [sources]
 * @returns {{ categories: string[], byCategory: Record<string, string[]> }}
 */
export function categoryCatalog({ operations = [], planned = [], recurring = [], rules = [] } = {}) {
  const byCategory = new Map();
  const add = (category, subcategory) => {
    const name = typeof category === 'string' ? category.trim() : '';
    if (!name) return;
    if (!byCategory.has(name)) byCategory.set(name, new Set());
    const sub = typeof subcategory === 'string' ? subcategory.trim() : '';
    if (sub) byCategory.get(name).add(sub);
  };
  for (const row of operations) add(row.category, row.subcategory);
  for (const row of planned) add(row.category, row.subcategory);
  for (const row of recurring) add(row.category, row.subcategory);
  for (const row of rules) add(row.category, row.subcategory);
  const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));
  const map = {};
  for (const category of categories) {
    map[category] = [...byCategory.get(category)].sort((a, b) => a.localeCompare(b));
  }
  return { categories, byCategory: map };
}

export function validateRuleDraft(draft) {
  const pattern = String(draft?.pattern ?? '').trim();
  if (!pattern || pattern.length > 200) return 'pattern';
  if (!['merchant', 'description', 'any'].includes(draft?.matchField)) return 'match_field';
  const category = String(draft?.category ?? '').trim();
  if (!category || category.length > 200) return 'category';
  const subcategory = String(draft?.subcategory ?? '').trim();
  if (subcategory && !category) return 'subcategory';
  const priority = Number(draft?.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) return 'priority';
  return null;
}

export function rulePayload(draft) {
  const subcategory = String(draft.subcategory ?? '').trim();
  return {
    pattern: String(draft.pattern).trim(),
    match_field: draft.matchField,
    category: String(draft.category).trim(),
    subcategory: subcategory || null,
    priority: Number(draft.priority),
  };
}

export function nextRulePriority(rules) {
  if (!rules?.length) return 100;
  return Math.max(...rules.map((rule) => rule.priority)) + 10;
}

export function priorityMove(rules, id, direction) {
  const sorted = [...(rules || [])].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const index = sorted.findIndex((rule) => rule.id === id);
  if (index < 0) return [];
  const nextIndex = direction === 'up' ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= sorted.length) return [];
  const current = sorted[index];
  const neighbor = sorted[nextIndex];
  if (current.priority !== neighbor.priority) {
    return [
      { id: current.id, priority: neighbor.priority },
      { id: neighbor.id, priority: current.priority },
    ];
  }
  const bumped = direction === 'up' ? Math.max(0, neighbor.priority - 1) : neighbor.priority + 1;
  if (bumped === current.priority || bumped > 1_000_000) return [];
  return [{ id: current.id, priority: bumped }];
}

export function slugTemplateId(label, taken) {
  const base = String(label || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'template';
  const used = new Set(taken || []);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    n += 1;
  }
  return id;
}

export function templateFromMapping({ id, label, mapping, options }) {
  const mapped = {};
  for (const key of ['date', 'amount', 'debit', 'credit', 'currency', 'description', 'merchant', 'counterparty', 'reference', 'balance']) {
    const value = String(mapping?.[key] ?? '').trim();
    if (value) mapped[key] = value;
  }
  const csvOptions = {
    delimiter: options?.delimiter || ',',
    decimalSeparator: options?.decimalSeparator || '.',
    dateFormat: options?.dateFormat || 'YYYY-MM-DD',
    encoding: options?.encoding || 'utf-8',
    hasHeader: options?.hasHeader !== false,
  };
  const currency = String(options?.defaultCurrency ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) csvOptions.defaultCurrency = currency;
  const skipRows = Number(options?.skipRows);
  if (Number.isInteger(skipRows) && skipRows > 0) csvOptions.skipRows = skipRows;
  if (options?.headerSearch === false) csvOptions.headerSearch = false;
  return {
    schemaVersion: 1,
    id,
    label: String(label || '').trim(),
    format: 'csv',
    csv: { mapping: mapped, options: csvOptions },
  };
}

export function inspectTemplateDocument(value) {
  const result = validateStatementTemplate(value);
  if (result.ok) return { ok: true, document: result.value };
  return { ok: false, detail: formatTemplateErrors(result.errors) };
}

export function templateFileName(id) {
  const safe = String(id || 'template').replace(/[^a-z0-9-]+/gi, '-');
  return `${safe || 'template'}.json`;
}

export function duplicateReasonKey(reason) {
  if (reason === 'bank_transaction_id' || reason === 'fingerprint' || reason === 'expense_duplicate') {
    return `data.statementImport.duplicateReason.${reason}`;
  }
  return null;
}

export function matchLabelKey(match) {
  if (match === 'explicit' || match === 'alias' || match === 'name' || match === 'iban') {
    return `data.statementImport.match.${match}`;
  }
  return null;
}

export function limitScopeKey(scope) {
  if (scope === 'file' || scope === 'files' || scope === 'rows' || scope === 'body') {
    return `data.statementImport.limitScope.${scope}`;
  }
  return null;
}

export function emptyRuleDraft(priority = 100) {
  return {
    pattern: '',
    matchField: 'any',
    category: '',
    subcategory: '',
    priority,
  };
}
