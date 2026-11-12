import { createExpenseDuplicateIndex, type ExpenseDuplicateCandidate } from '../shared/booking-guards';
import { normalizeAlias, resolveAccount } from './account-aliases';
import { D1_MAX_BOUND_PARAMS } from './backup';
import { ValidationError } from './api-error';
import { addDays } from './forecast/dates';
import { DUPLICATE_EXPENSE_LOOKBACK_DAYS } from './duplicate-expense';
import { SAFE_MINOR_MAX, SAFE_MINOR_MIN } from '../shared/money';
import { matchCategoryRule, type CategoryRule } from '../shared/statement-import/categories';
import {
  materializeAccountCurrency,
  rowKeyFromStoredFingerprint,
  statementFingerprint,
  statementRowKey,
} from '../shared/statement-import/amounts';
import { parseStatementFile } from '../shared/statement-import/parse';
import { presetById, type StatementPreset } from '../shared/statement-import/presets';
import { isBuiltinTemplateId, templateAsPreset } from '../shared/statement-import/templates';
import { getStatementTemplate } from './statement-templates';
import {
  STATEMENT_IMPORT_MAX_FILES,
  STATEMENT_IMPORT_MAX_ROWS,
  StatementLimitError,
  StatementParseError,
  type CategoryMatchField,
  type CategoryMode,
  type CsvColumnMapping,
  type CsvParseOptions,
  type StatementEncoding,
  type StatementFormat,
  type StatementKind,
  type XlsLayout,
} from '../shared/statement-import/types';

export interface PreviewFileInput {
  filename: string;
  format: StatementFormat | 'auto';
  presetId: string | null;
  text: string | null;
  bytes: Uint8Array | null;
  encoding: StatementEncoding | null;
  mapping: CsvColumnMapping | null;
  options: Partial<CsvParseOptions> | null;
  xlsLayout: XlsLayout | null;
  accountId: number | null;
  accountHint: string | null;
}

export interface CommitRowInput {
  include: boolean;
  accountId: number;
  date: string;
  amountMinor: number;
  currency: string;
  kind: StatementKind;
  item: string;
  store: string | null;
  category: string | null;
  subcategory: string | null;
  comment: string | null;
  bankTransactionId: string | null;
  statementDescription: string;
  fingerprint: string | null;
}

interface AccountHit {
  id: number;
  currency: string;
  balance_minor: number;
  account_number: string | null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function compactRef(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

export function statementImportLedgerGuard(db: D1Database, expectedChanges: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)
     SELECT 'statement-import-guard', 'guard', 'XX', 'USD', 'not-a-timestamp'
     WHERE changes() != ?`,
  ).bind(expectedChanges);
}

async function loadAccount(db: D1Database, id: number): Promise<AccountHit | null> {
  return db.prepare(
    'SELECT id, currency, balance_minor, account_number FROM accounts WHERE id = ?',
  ).bind(id).first<AccountHit>();
}

async function matchByText(
  db: D1Database,
  raw: string,
  accounts: AccountHit[],
): Promise<{ accountId: number; via: 'alias' | 'name' | 'iban' } | null> {
  const norm = normalizeAlias(raw);
  if (norm) {
    const alias = await db.prepare(
      'SELECT account_id FROM account_aliases WHERE alias_norm = ? LIMIT 1',
    ).bind(norm).first<{ account_id: number }>();
    if (alias) return { accountId: alias.account_id, via: 'alias' };
  }
  const resolved = await resolveAccount(db, raw);
  if (resolved !== null) return { accountId: resolved, via: 'name' };
  const compact = compactRef(raw);
  if (compact) {
    const byNumber = accounts.find((account) => account.account_number && compactRef(account.account_number) === compact);
    if (byNumber) return { accountId: byNumber.id, via: 'iban' };
    const compactAlias = normalizeAlias(compact);
    if (compactAlias && compactAlias !== norm) {
      const alias = await db.prepare(
        'SELECT account_id FROM account_aliases WHERE alias_norm = ? LIMIT 1',
      ).bind(compactAlias).first<{ account_id: number }>();
      if (alias) return { accountId: alias.account_id, via: 'alias' };
    }
  }
  return null;
}

async function resolveImportAccount(
  db: D1Database,
  explicitId: number | null,
  hint: string | null,
  statementRef: string | null,
  accounts: AccountHit[],
): Promise<{ account: AccountHit | null; via: 'explicit' | 'alias' | 'name' | 'iban' | null }> {
  if (explicitId !== null) {
    const account = accounts.find((row) => row.id === explicitId) ?? await loadAccount(db, explicitId);
    if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    return { account, via: 'explicit' };
  }
  for (const candidate of [hint, statementRef]) {
    if (!candidate?.trim()) continue;
    const hit = await matchByText(db, candidate, accounts);
    if (!hit) continue;
    const account = accounts.find((row) => row.id === hit.accountId) ?? await loadAccount(db, hit.accountId);
    if (account) return { account, via: hit.via };
  }
  return { account: null, via: null };
}

async function loadRules(db: D1Database): Promise<CategoryRule[]> {
  const { results } = await db.prepare(
    `SELECT id, pattern, match_field, category, subcategory, priority
     FROM category_rules ORDER BY priority, id`,
  ).all<CategoryRule>();
  return results;
}

async function loadAccounts(db: D1Database): Promise<AccountHit[]> {
  const { results } = await db.prepare(
    'SELECT id, currency, balance_minor, account_number FROM accounts',
  ).all<AccountHit>();
  return results;
}

interface DuplicateHit {
  operationId: number;
  batchId: number | null;
  batchCreatedAt: string | null;
  batchFiles: BatchFile[];
}

interface ImportedIdentity {
  byFingerprint: Map<string, DuplicateHit>;
  byRowKey: Map<string, DuplicateHit>;
  byBankId: Map<string, DuplicateHit>;
}

/** One query, no per-row bound parameters. Duplicate identity is matched in memory. */
async function loadImportedIdentities(db: D1Database): Promise<ImportedIdentity> {
  const { results } = await db.prepare(
    `SELECT o.id, o.import_fingerprint AS fingerprint, o.bank_transaction_id AS bank_id,
            b.id AS batch_id, b.created_at AS batch_created_at, b.files_json AS files_json
     FROM operations o
     LEFT JOIN import_batches b ON b.id = o.import_batch_id
     WHERE o.import_fingerprint IS NOT NULL OR o.bank_transaction_id IS NOT NULL`,
  ).all<{
    id: number;
    fingerprint: string | null;
    bank_id: string | null;
    batch_id: number | null;
    batch_created_at: string | null;
    files_json: string | null;
  }>();
  const byFingerprint = new Map<string, DuplicateHit>();
  const byRowKey = new Map<string, DuplicateHit>();
  const byBankId = new Map<string, DuplicateHit>();
  const remember = (map: Map<string, DuplicateHit>, key: string, hit: DuplicateHit) => {
    if (!map.has(key)) map.set(key, hit);
  };
  for (const row of results) {
    const hit: DuplicateHit = {
      operationId: row.id,
      batchId: row.batch_id,
      batchCreatedAt: row.batch_created_at,
      batchFiles: parseBatchFiles(row.files_json),
    };
    if (row.fingerprint) {
      remember(byFingerprint, row.fingerprint, hit);
      const key = rowKeyFromStoredFingerprint(row.fingerprint);
      if (key) remember(byRowKey, key, hit);
    }
    const bankId = row.bank_id?.trim() ?? '';
    if (bankId) remember(byBankId, bankId, hit);
  }
  return { byFingerprint, byRowKey, byBankId };
}

/** Three bound parameters (account and date window), not one parameter per row. */
async function expenseWindow(
  db: D1Database,
  accountId: number,
  dates: string[],
): Promise<Array<ExpenseDuplicateCandidate & { id: number }>> {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const from = addDays(sorted[0]!, -DUPLICATE_EXPENSE_LOOKBACK_DAYS);
  const to = addDays(sorted[sorted.length - 1]!, 1);
  const { results } = await db.prepare(
    `SELECT id, date, account_id, store, item, comment, fiscal_receipt_id, receipt_url, amount_minor
     FROM operations
     WHERE kind = 'expense' AND account_id = ? AND date >= ? AND date <= ?`,
  ).bind(accountId, from, to).all<ExpenseDuplicateCandidate & { id: number }>();
  return results;
}

async function presetForFile(db: D1Database, presetId: string | null): Promise<StatementPreset | null> {
  if (!presetId) return null;
  const builtin = presetById(presetId);
  if (builtin) return builtin;
  const stored = await getStatementTemplate(db, presetId);
  if (!stored) throw new StatementParseError(`unknown preset "${presetId}"`);
  const preset = templateAsPreset(stored.document);
  if (!preset) throw new StatementParseError(`preset ${presetId} cannot be used for import yet`);
  return preset;
}

export async function previewStatementImport(
  db: D1Database,
  categoryMode: CategoryMode,
  files: PreviewFileInput[],
) {
  if (files.length > STATEMENT_IMPORT_MAX_FILES) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'files', limit: STATEMENT_IMPORT_MAX_FILES });
  }
  const accounts = await loadAccounts(db);
  const rules = categoryMode === 'rules' ? await loadRules(db) : [];
  const parsedFiles = [];
  let rowCount = 0;
  for (const file of files) {
    let parsed;
    try {
      const preset = await presetForFile(db, file.presetId);
      parsed = await parseStatementFile({
        format: file.format,
        filename: file.filename,
        text: file.text,
        bytes: file.bytes,
        encoding: file.encoding,
        presetId: file.presetId,
        preset,
        mapping: file.mapping,
        options: file.options,
        xlsLayout: file.xlsLayout,
      });
    } catch (error) {
      if (error instanceof StatementLimitError) {
        throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'rows', limit: error.limit });
      }
      if (error instanceof StatementParseError) {
        if (
          error.code === 'PDF_NO_TEXT_LAYER'
          || error.code === 'PDF_UNKNOWN_LAYOUT'
          || error.code === 'PDF_ENCRYPTED'
        ) {
          throw new ValidationError(error.code, { filename: file.filename });
        }
        throw new ValidationError('IMPORT_FILE_INVALID', { filename: file.filename, detail: error.message });
      }
      throw error;
    }
    rowCount += parsed.statements.reduce((sum, statement) => sum + statement.rows.length, 0);
    if (rowCount > STATEMENT_IMPORT_MAX_ROWS) {
      throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'rows', limit: STATEMENT_IMPORT_MAX_ROWS });
    }
    const statements = [];
    for (const statement of parsed.statements) {
      const matched = await resolveImportAccount(db, file.accountId, file.accountHint, statement.accountRef, accounts);
      if (statement.rows.some((row) => !row.currency)) {
        if (!matched.account) throw new ValidationError('IMPORT_CURRENCY_REQUIRED');
        materializeAccountCurrency(statement, matched.account.currency);
      }
      statements.push({ statement, matched });
    }
    parsedFiles.push({ file, parsed, statements });
  }

  const flat: Array<{
    accountId: number | null;
    date: string;
    amountMinor: number;
    currency: string;
    description: string;
    merchant: string | null;
    store: string | null;
    bankTransactionId: string | null;
    kind: 'expense' | 'income';
    fingerprint: string;
    rowKey: string;
  }> = [];
  for (const entry of parsedFiles) {
    for (const { statement, matched } of entry.statements) {
      for (const row of statement.rows) {
        const accountId = matched.account?.id ?? 0;
        flat.push({
          accountId: matched.account?.id ?? null,
          date: row.date,
          amountMinor: row.amountMinor,
          currency: row.currency,
          description: row.description,
          merchant: row.merchant,
          store: row.merchant || row.counterparty,
          bankTransactionId: row.bankTransactionId,
          kind: row.kind,
          fingerprint: statementFingerprint({
            accountId,
            date: row.date,
            amountMinor: row.amountMinor,
            currency: row.currency,
            description: row.description,
            bankTransactionId: row.bankTransactionId,
          }),
          rowKey: statementRowKey({
            date: row.date,
            amountMinor: row.amountMinor,
            currency: row.currency,
            description: row.description,
            bankTransactionId: row.bankTransactionId,
          }),
        });
      }
    }
  }
  const imported = await loadImportedIdentities(db);
  const expenseByAccount = new Map<number, Array<ExpenseDuplicateCandidate & { id: number }>>();
  const datesByAccount = new Map<number, string[]>();
  for (const row of flat) {
    if (row.kind !== 'expense' || row.accountId === null) continue;
    const dates = datesByAccount.get(row.accountId) ?? [];
    dates.push(row.date);
    datesByAccount.set(row.accountId, dates);
  }
  for (const [accountId, dates] of datesByAccount) {
    expenseByAccount.set(accountId, await expenseWindow(db, accountId, dates));
  }
  const expenseIndexByAccount = new Map<number, ReturnType<typeof createExpenseDuplicateIndex>>();
  for (const [accountId, rows] of expenseByAccount) {
    expenseIndexByAccount.set(accountId, createExpenseDuplicateIndex(rows));
  }

  const seenFingerprints = new Map<string, true>();
  const seenRowKeys = new Map<string, true>();
  const seenBanks = new Map<string, true>();
  const batchExpenses = createExpenseDuplicateIndex();
  let cursor = 0;

  const filesJson = parsedFiles.map(({ file, parsed, statements }) => ({
    filename: file.filename,
    format: parsed.format,
    preset_id: file.presetId ?? parsed.detectedPresetId ?? null,
    encoding: parsed.encodingNote,
    warnings: parsed.warnings,
    statements: statements.map(({ statement, matched }) => ({
      account_ref: statement.accountRef,
      statement_currency: statement.currency,
      account_id: matched.account?.id ?? null,
      account_currency: matched.account?.currency ?? null,
      match: matched.via,
      warnings: statement.warnings,
      date_format: statement.dateFormat ?? null,
      rows: statement.rows.map((row) => {
        const identity = flat[cursor]!;
        cursor += 1;
        const accountId = identity.accountId;
        let duplicate = false;
        let duplicateOf: number | null = null;
        let duplicateInBatch = false;
        let duplicateReason: string | null = null;
        let duplicateHit: DuplicateHit | null = null;
        const bankId = row.bankTransactionId?.trim() ?? '';
        if (bankId) {
          const existing = imported.byBankId.get(bankId);
          if (existing !== undefined) {
            duplicate = true;
            duplicateOf = existing.operationId;
            duplicateHit = existing;
            duplicateReason = 'bank_transaction_id';
          } else if (seenBanks.has(bankId)) {
            duplicate = true;
            duplicateInBatch = true;
            duplicateReason = 'bank_transaction_id';
          }
          seenBanks.set(bankId, true);
        }
        if (!duplicate) {
          const existing = imported.byFingerprint.get(identity.fingerprint)
            ?? imported.byRowKey.get(identity.rowKey);
          if (existing !== undefined) {
            duplicate = true;
            duplicateOf = existing.operationId;
            duplicateHit = existing;
            duplicateReason = 'fingerprint';
          } else if (seenFingerprints.has(identity.fingerprint) || seenRowKeys.has(identity.rowKey)) {
            duplicate = true;
            duplicateInBatch = true;
            duplicateReason = 'fingerprint';
          }
        }
        seenFingerprints.set(identity.fingerprint, true);
        seenRowKeys.set(identity.rowKey, true);
        if (!duplicate && row.kind === 'expense' && accountId !== null) {
          const candidate: ExpenseDuplicateCandidate = {
            date: row.date,
            account_id: accountId,
            store: identity.store,
            amount_minor: row.amountMinor,
            item: row.description,
            comment: null,
            fiscal_receipt_id: null,
            receipt_url: null,
          };
          const hit = expenseIndexByAccount.get(accountId)?.find(candidate);
          const batchHit = batchExpenses.find(candidate);
          if (hit) {
            duplicate = true;
            duplicateOf = hit.id;
            duplicateReason = 'expense_duplicate';
          } else if (batchHit) {
            duplicate = true;
            duplicateInBatch = true;
            duplicateReason = 'expense_duplicate';
          }
          batchExpenses.add({ ...candidate, id: -row.sourceIndex });
        }
        const rule = categoryMode === 'rules'
          ? matchCategoryRule(row, rules)
          : null;
        return {
          index: row.sourceIndex,
          date: row.date,
          value_date: row.valueDate,
          amount_minor: row.amountMinor,
          currency: row.currency,
          description: row.description,
          merchant: row.merchant,
          counterparty: row.counterparty,
          reference: row.reference,
          bank_transaction_id: row.bankTransactionId,
          balance_minor: row.balanceMinor,
          kind: row.kind,
          fingerprint: identity.fingerprint,
          duplicate,
          duplicate_of_operation_id: duplicateOf,
          duplicate_in_batch: duplicateInBatch,
          duplicate_reason: duplicateReason,
          duplicate_batch_id: duplicateHit?.batchId ?? null,
          duplicate_batch_created_at: duplicateHit?.batchCreatedAt ?? null,
          duplicate_batch_files: duplicateHit?.batchFiles ?? [],
          possible_own_account_transfer: row.possibleOwnAccountTransfer,
          currency_mismatch: Boolean(matched.account && matched.account.currency !== row.currency),
          currency_from_account: Boolean(row.currencyFromAccount),
          proposed_category: rule?.category ?? null,
          proposed_subcategory: rule?.subcategory ?? null,
          category_rule_id: rule?.id ?? null,
          warnings: row.warnings,
        };
      }),
    })),
  }));

  return { category_mode: categoryMode, files: filesJson };
}

interface BatchFile {
  filename: string;
  preset_id: string | null;
}

interface BatchRow {
  id: number;
  idempotency_key: string;
  category_mode: CategoryMode;
  status: 'committed' | 'undone';
  file_count: number;
  row_count: number;
  created_at: string;
  undone_at: string | null;
  files_json?: string | null;
}

function parseBatchFiles(raw: string | null | undefined): BatchFile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const files: BatchFile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { filename?: unknown; preset_id?: unknown };
      if (typeof record.filename !== 'string' || !record.filename.trim()) continue;
      files.push({
        filename: record.filename.trim(),
        preset_id: typeof record.preset_id === 'string' && record.preset_id.trim()
          ? record.preset_id.trim()
          : null,
      });
    }
    return files;
  } catch {
    return [];
  }
}

function batchJson(row: BatchRow) {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    category_mode: row.category_mode,
    status: row.status,
    file_count: row.file_count,
    row_count: row.row_count,
    created_at: row.created_at,
    undone_at: row.undone_at,
    files: parseBatchFiles(row.files_json),
  };
}

async function operationsForBatch(db: D1Database, batchId: number) {
  const { results } = await db.prepare(
    `SELECT o.id, o.date, o.item AS description, o.category, o.subcategory, o.kind,
            o.amount_minor, o.account_id, o.import_fingerprint AS fingerprint,
            a.name AS account_name, a.currency AS currency
     FROM operations o
     LEFT JOIN accounts a ON a.id = o.account_id
     WHERE o.import_batch_id = ?
     ORDER BY o.date, o.id`,
  ).bind(batchId).all<{
    id: number;
    date: string;
    description: string | null;
    category: string | null;
    subcategory: string | null;
    kind: string;
    amount_minor: number;
    account_id: number;
    fingerprint: string | null;
    account_name: string | null;
    currency: string | null;
  }>();
  return results;
}

/** Columns bound once per imported operation, before the idempotency key. */
const STATEMENT_IMPORT_BINDS_PER_ROW = 11;

/**
 * D1 allows at most 5 terms in a compound SELECT and 100 bound parameters.
 * The compound-select limit is the one that binds: 5 rows use 56 parameters.
 */
export function statementImportInsertChunkRows(): number {
  const paramChunk = Math.max(1, Math.floor((D1_MAX_BOUND_PARAMS - 1) / STATEMENT_IMPORT_BINDS_PER_ROW));
  return Math.min(5, paramChunk);
}

/**
 * Statements inside the single atomic db.batch for a commit.
 * D1 counts that batch as one query against the Worker subrequest limit.
 */
export function statementImportCommitStatementCount(
  freshRows: number,
  accountCount: number,
  templateUpdates = 0,
): number {
  const chunk = statementImportInsertChunkRows();
  const inserts = freshRows === 0 ? 0 : Math.ceil(freshRows / chunk);
  return 1 + accountCount * 2 + inserts + templateUpdates;
}

function insertOperationChunk(
  db: D1Database,
  idempotencyKey: string,
  rows: CommitRowInput[],
): D1PreparedStatement {
  const selects = rows.map(() =>
    `SELECT ? AS date, ? AS account_id, ? AS kind, ? AS store, ? AS item, ? AS category, ? AS subcategory, ? AS amount_minor, ? AS comment, ? AS bank_transaction_id, ? AS import_fingerprint`,
  ).join(' UNION ALL ');
  const sql = `
    INSERT INTO operations (
      date, account_id, kind, store, item, category, subcategory, amount_minor,
      receipt_id, source, comment, receipt_url, fiscal_receipt_id,
      import_batch_id, bank_transaction_id, import_fingerprint
    )
    SELECT v.date, v.account_id, v.kind, v.store, v.item, v.category, v.subcategory, v.amount_minor,
           NULL, 'manual', v.comment, NULL, NULL,
           b.id, v.bank_transaction_id, v.import_fingerprint
    FROM (${selects}) AS v
    JOIN import_batches AS b ON b.idempotency_key = ?`;
  const binds: Array<string | number | null> = [];
  for (const row of rows) {
    binds.push(
      row.date,
      row.accountId,
      row.kind,
      row.store,
      row.item,
      row.category,
      row.subcategory,
      row.amountMinor,
      row.comment,
      row.bankTransactionId,
      statementFingerprint({
        accountId: row.accountId,
        date: row.date,
        amountMinor: row.amountMinor,
        currency: row.currency,
        description: row.statementDescription,
        bankTransactionId: row.bankTransactionId,
      }),
    );
  }
  binds.push(idempotencyKey);
  return db.prepare(sql).bind(...binds);
}

export async function commitStatementImport(
  db: D1Database,
  input: {
    idempotencyKey: string;
    categoryMode: CategoryMode;
    fileCount: number;
    filesJson: string | null;
    rows: CommitRowInput[];
  },
) {
  const existing = await db.prepare(
    'SELECT * FROM import_batches WHERE idempotency_key = ?',
  ).bind(input.idempotencyKey).first<BatchRow>();
  if (existing) {
    const inserted = existing.status === 'committed' ? await operationsForBatch(db, existing.id) : [];
    return {
      written: false,
      idempotent_replay: true,
      batch: batchJson(existing),
      inserted,
      skipped: [],
    };
  }

  const included = input.rows.filter((row) => row.include);
  if (included.length === 0) throw new ValidationError('IMPORT_EMPTY');
  if (included.length > STATEMENT_IMPORT_MAX_ROWS) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'rows', limit: STATEMENT_IMPORT_MAX_ROWS });
  }
  const accounts = await loadAccounts(db);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  for (const row of included) {
    if (row.currency) continue;
    const account = byId.get(row.accountId);
    if (!account) throw new ValidationError('IMPORT_CURRENCY_REQUIRED');
    row.currency = account.currency;
  }
  for (const [index, row] of included.entries()) {
    const fingerprint = statementFingerprint({
      accountId: row.accountId,
      date: row.date,
      amountMinor: row.amountMinor,
      currency: row.currency,
      description: row.statementDescription,
      bankTransactionId: row.bankTransactionId,
    });
    if (row.fingerprint !== null && row.fingerprint !== fingerprint) {
      throw new ValidationError('IMPORT_FINGERPRINT_MISMATCH', { index });
    }
    row.fingerprint = fingerprint;
  }

  const imported = await loadImportedIdentities(db);
  const skipped: Array<{ fingerprint: string; reason: 'duplicate' }> = [];
  const fresh: CommitRowInput[] = [];
  const seen = new Set<string>();
  const seenKeys = new Set<string>();
  const batchExpenses = createExpenseDuplicateIndex();
  for (const row of included) {
    const fingerprint = row.fingerprint!;
    const rowKey = statementRowKey({
      date: row.date,
      amountMinor: row.amountMinor,
      currency: row.currency,
      description: row.statementDescription,
      bankTransactionId: row.bankTransactionId,
    });
    const bankId = row.bankTransactionId?.trim() ?? '';
    const candidate: ExpenseDuplicateCandidate = {
      date: row.date,
      account_id: row.accountId,
      store: row.store,
      amount_minor: row.amountMinor,
      item: row.statementDescription,
      comment: row.comment,
      fiscal_receipt_id: null,
      receipt_url: null,
    };
    const batchExpense = row.kind === 'expense' && batchExpenses.find(candidate) !== undefined;
    if (
      seen.has(fingerprint)
      || seenKeys.has(rowKey)
      || (bankId && seen.has(`bank:${bankId}`))
      || imported.byFingerprint.has(fingerprint)
      || imported.byRowKey.has(rowKey)
      || (bankId && imported.byBankId.has(bankId))
      || batchExpense
    ) {
      skipped.push({ fingerprint, reason: 'duplicate' });
      continue;
    }
    seen.add(fingerprint);
    seenKeys.add(rowKey);
    if (bankId) seen.add(`bank:${bankId}`);
    if (row.kind === 'expense') batchExpenses.add({ ...candidate, id: -fresh.length - 1 });
    fresh.push(row);
  }

  if (fresh.length === 0) {
    return { written: false, idempotent_replay: false, batch: null, inserted: [], skipped };
  }

  const datesByAccount = new Map<number, string[]>();
  for (const row of fresh) {
    const account = byId.get(row.accountId);
    if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND');
    if (account.currency !== row.currency) {
      throw new ValidationError('IMPORT_CURRENCY_MISMATCH', {
        rowCurrency: row.currency,
        accountCurrency: account.currency,
      });
    }
    if (row.kind === 'expense') {
      const dates = datesByAccount.get(row.accountId) ?? [];
      dates.push(row.date);
      datesByAccount.set(row.accountId, dates);
    }
  }
  for (const [accountId, dates] of datesByAccount) {
    const window = createExpenseDuplicateIndex(await expenseWindow(db, accountId, dates));
    for (const row of fresh) {
      if (row.accountId !== accountId || row.kind !== 'expense') continue;
      const hit = window.find({
        date: row.date,
        account_id: accountId,
        store: row.store,
        amount_minor: row.amountMinor,
        item: row.statementDescription,
        comment: row.comment,
        fiscal_receipt_id: null,
        receipt_url: null,
      });
      if (hit) throw new ValidationError('DUPLICATE_EXPENSE', { existingOperationId: hit.id }, 409);
    }
  }

  if (input.categoryMode === 'rules') {
    const rules = await loadRules(db);
    for (const row of fresh) {
      if (row.category) continue;
      const rule = matchCategoryRule({
        description: row.statementDescription,
        merchant: row.store,
        counterparty: null,
      }, rules);
      if (!rule) continue;
      row.category = rule.category;
      row.subcategory = rule.subcategory;
    }
  }

  const deltas = new Map<number, number>();
  for (const row of fresh) {
    const next = (deltas.get(row.accountId) ?? 0) + row.amountMinor;
    if (!Number.isSafeInteger(next)) throw new ValidationError('BALANCE_OUT_OF_SAFE_RANGE');
    deltas.set(row.accountId, next);
  }
  for (const [accountId, delta] of deltas) {
    const account = byId.get(accountId)!;
    const resulting = account.balance_minor + delta;
    if (!Number.isSafeInteger(resulting) || resulting > SAFE_MINOR_MAX || resulting < SAFE_MINOR_MIN) {
      throw new ValidationError('BALANCE_OUT_OF_SAFE_RANGE');
    }
  }

  const createdAt = nowIso();
  const usedTemplateIds = [...new Set(
    parseBatchFiles(input.filesJson)
      .map((file) => file.preset_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && !isBuiltinTemplateId(id)),
  )];
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO import_batches (
         idempotency_key, category_mode, status, file_count, row_count, created_at, undone_at, files_json
       ) VALUES (?, ?, 'committed', ?, ?, ?, NULL, ?)`,
    ).bind(
      input.idempotencyKey,
      input.categoryMode,
      input.fileCount,
      fresh.length,
      createdAt,
      input.filesJson,
    ),
  ];
  for (const [accountId, delta] of deltas) {
    statements.push(db.prepare(
      `UPDATE accounts
       SET balance_minor = balance_minor + ?1
       WHERE id = ?2 AND (balance_minor + ?1) BETWEEN ?3 AND ?4`,
    ).bind(delta, accountId, SAFE_MINOR_MIN, SAFE_MINOR_MAX));
    statements.push(statementImportLedgerGuard(db, 1));
  }
  // D1's SQLite is built with SQLITE_MAX_COMPOUND_SELECT = 5. Each row is one
  // SELECT in the UNION ALL, so a larger chunk fails with "too many terms in
  // compound SELECT". That error was reported as a balance-range failure.
  // Bound parameters still cap the chunk (the idempotency key is the extra bind).
  // One db.batch() is one Worker subrequest. 2000 rows are 400 insert
  // statements plus the batch row and the per-account balance updates.
  const chunkSize = statementImportInsertChunkRows();
  for (let offset = 0; offset < fresh.length; offset += chunkSize) {
    statements.push(insertOperationChunk(db, input.idempotencyKey, fresh.slice(offset, offset + chunkSize)));
  }
  for (const templateId of usedTemplateIds) {
    statements.push(db.prepare(
      `UPDATE statement_templates
       SET used_batch_id = (SELECT id FROM import_batches WHERE idempotency_key = ?)
       WHERE template_id = ? AND used_batch_id IS NULL`,
    ).bind(input.idempotencyKey, templateId));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE/i.test(message)) {
      const raced = await db.prepare(
        'SELECT * FROM import_batches WHERE idempotency_key = ?',
      ).bind(input.idempotencyKey).first<BatchRow>();
      if (raced) {
        const inserted = raced.status === 'committed' ? await operationsForBatch(db, raced.id) : [];
        return {
          written: false,
          idempotent_replay: true,
          batch: batchJson(raced),
          inserted,
          skipped: [],
        };
      }
      throw new ValidationError('IMPORT_FINGERPRINT_MISMATCH');
    }
    throw new ValidationError('BALANCE_OUT_OF_SAFE_RANGE');
  }
  const batch = await db.prepare(
    'SELECT * FROM import_batches WHERE idempotency_key = ?',
  ).bind(input.idempotencyKey).first<BatchRow>();
  if (!batch) throw new ValidationError('LEDGER_EFFECT_MISSING');
  const inserted = await operationsForBatch(db, batch.id);
  if (inserted.length !== fresh.length) throw new ValidationError('LEDGER_EFFECT_MISSING');
  return { written: true, idempotent_replay: false, batch: batchJson(batch), inserted, skipped };
}

export async function undoStatementImport(db: D1Database, id: number) {
  const batch = await db.prepare('SELECT * FROM import_batches WHERE id = ?').bind(id).first<BatchRow>();
  if (!batch) throw new ValidationError('IMPORT_BATCH_NOT_FOUND', undefined, 404);
  if (batch.status === 'undone') throw new ValidationError('IMPORT_ALREADY_UNDONE', undefined, 409);
  const linked = await db.prepare(
    `SELECT operation_id FROM operation_fulfillment_links
     WHERE operation_id IN (SELECT id FROM operations WHERE import_batch_id = ?)
     LIMIT 1`,
  ).bind(id).first<{ operation_id: number }>();
  if (linked) throw new ValidationError('IMPORT_BATCH_LINKED', undefined, 409);

  const { results: groups } = await db.prepare(
    `SELECT account_id FROM operations WHERE import_batch_id = ? GROUP BY account_id`,
  ).bind(id).all<{ account_id: number }>();
  const undoneAt = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (groups.length > 0) {
    statements.push(db.prepare(
      `UPDATE accounts
       SET balance_minor = balance_minor - (
         SELECT COALESCE(SUM(amount_minor), 0) FROM operations
         WHERE import_batch_id = ?1 AND account_id = accounts.id
       )
       WHERE id IN (SELECT account_id FROM operations WHERE import_batch_id = ?1)
         AND (
           balance_minor - (
             SELECT COALESCE(SUM(amount_minor), 0) FROM operations
             WHERE import_batch_id = ?1 AND account_id = accounts.id
           )
         ) BETWEEN ?2 AND ?3`,
    ).bind(id, SAFE_MINOR_MIN, SAFE_MINOR_MAX));
    statements.push(statementImportLedgerGuard(db, groups.length));
  }
  statements.push(db.prepare('DELETE FROM operations WHERE import_batch_id = ?').bind(id));
  statements.push(db.prepare(
    `UPDATE import_batches
     SET status = 'undone', undone_at = ?
     WHERE id = ? AND status = 'committed'`,
  ).bind(undoneAt, id));
  try {
    await db.batch(statements);
  } catch {
    throw new ValidationError('BALANCE_OUT_OF_SAFE_RANGE');
  }
  const updated = await db.prepare('SELECT * FROM import_batches WHERE id = ?').bind(id).first<BatchRow>();
  if (!updated || updated.status !== 'undone') throw new ValidationError('LEDGER_EFFECT_MISSING');
  const left = await db.prepare(
    'SELECT COUNT(*) AS n FROM operations WHERE import_batch_id = ?',
  ).bind(id).first<{ n: number }>();
  if ((left?.n ?? 0) !== 0) throw new ValidationError('LEDGER_EFFECT_MISSING');
  return { undone: true, batch: batchJson(updated) };
}

export async function listImportBatches(db: D1Database) {
  const { results } = await db.prepare(
    'SELECT * FROM import_batches ORDER BY id DESC',
  ).all<BatchRow>();
  return results.map(batchJson);
}

export async function getImportBatch(db: D1Database, id: number) {
  const batch = await db.prepare('SELECT * FROM import_batches WHERE id = ?').bind(id).first<BatchRow>();
  if (!batch) return null;
  return { batch: batchJson(batch), operations: await operationsForBatch(db, id) };
}

function ruleJson(row: CategoryRule & { created_at?: string }) {
  return {
    id: row.id,
    pattern: row.pattern,
    match_field: row.match_field,
    category: row.category,
    subcategory: row.subcategory,
    priority: row.priority,
    created_at: row.created_at ?? null,
  };
}

export async function listCategoryRules(db: D1Database) {
  const { results } = await db.prepare(
    'SELECT id, pattern, match_field, category, subcategory, priority, created_at FROM category_rules ORDER BY priority, id',
  ).all<CategoryRule & { created_at: string }>();
  return results.map(ruleJson);
}

export async function insertCategoryRule(
  db: D1Database,
  input: {
    pattern: string;
    matchField: CategoryMatchField;
    category: string;
    subcategory: string | null;
    priority: number;
  },
) {
  const row = await db.prepare(
    `INSERT INTO category_rules (pattern, match_field, category, subcategory, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id, pattern, match_field, category, subcategory, priority, created_at`,
  ).bind(input.pattern, input.matchField, input.category, input.subcategory, input.priority, nowIso())
    .first<CategoryRule & { created_at: string }>();
  return ruleJson(row!);
}

export async function patchCategoryRule(
  db: D1Database,
  id: number,
  input: {
    pattern?: string;
    matchField?: CategoryMatchField;
    category?: string;
    subcategory?: string | null;
    priority?: number;
  },
) {
  const current = await db.prepare(
    'SELECT id, pattern, match_field, category, subcategory, priority, created_at FROM category_rules WHERE id = ?',
  ).bind(id).first<CategoryRule & { created_at: string }>();
  if (!current) throw new ValidationError('CATEGORY_RULE_NOT_FOUND', undefined, 404);
  const next = {
    pattern: input.pattern ?? current.pattern,
    match_field: input.matchField ?? current.match_field,
    category: input.category ?? current.category,
    subcategory: input.subcategory === undefined ? current.subcategory : input.subcategory,
    priority: input.priority ?? current.priority,
  };
  if (next.subcategory && !next.category) throw new ValidationError('SUBCATEGORY_REQUIRES_CATEGORY');
  const row = await db.prepare(
    `UPDATE category_rules
     SET pattern = ?, match_field = ?, category = ?, subcategory = ?, priority = ?
     WHERE id = ?
     RETURNING id, pattern, match_field, category, subcategory, priority, created_at`,
  ).bind(next.pattern, next.match_field, next.category, next.subcategory, next.priority, id)
    .first<CategoryRule & { created_at: string }>();
  return ruleJson(row!);
}

export async function deleteCategoryRule(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM category_rules WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
