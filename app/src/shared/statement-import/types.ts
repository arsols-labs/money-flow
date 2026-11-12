/**
 * Caps for one statement-import request. The Data screen, inline MCP, and the
 * upload PUT all use the file and row constants. Do not declare a second cap.
 * 1048576 bytes is 1 MiB.
 */
export const STATEMENT_IMPORT_MAX_FILE_BYTES = 1_048_576;
export const STATEMENT_IMPORT_MAX_FILES = 8;
export const STATEMENT_IMPORT_MAX_ROWS = 2_000;

/** Base64 length of `rawBytes`, the overhead of putting a file inside JSON. */
export function base64LengthForBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * JSON preview body: every admitted file as base64, plus a 64 KiB envelope.
 * Derived from the file cap so a max-size file is not rejected as a body.
 */
export const STATEMENT_IMPORT_MAX_BODY_BYTES =
  base64LengthForBytes(STATEMENT_IMPORT_MAX_FILE_BYTES) * STATEMENT_IMPORT_MAX_FILES + 65_536;

/**
 * Raw bytes accepted inline in an MCP tools/call. Same ceiling as the shared
 * per-file cap. The upload PUT uses that same raw-byte cap.
 */
export const STATEMENT_IMPORT_INLINE_MAX_BYTES = STATEMENT_IMPORT_MAX_FILE_BYTES;

/**
 * MCP JSON body budget for one inline statement: base64 of the shared file
 * cap, plus a 64 KiB envelope for the tool arguments. Not a second file cap.
 */
export const STATEMENT_IMPORT_MCP_JSON_MAX_BYTES =
  base64LengthForBytes(STATEMENT_IMPORT_MAX_FILE_BYTES) + 65_536;

export const IMPORT_UNDO_PHRASE = 'UNDO IMPORT';

/** Preview warning when a printed closing balance disagrees with opening plus rows. */
export const CLOSING_BALANCE_MISMATCH_WARNING =
  'closing balance does not match opening balance plus the row amounts';

export type StatementFormat = 'csv' | 'ofx' | 'qfx' | 'camt053' | 'xls' | 'pdf';
export type StatementEncoding = 'utf-8' | 'windows-1252' | 'iso-8859-1';
export type CsvDelimiter = ',' | ';' | '\t' | '|';
export type DecimalSeparator = '.' | ',';
export type StatementDateFormat =
  | 'YYYY-MM-DD'
  | 'MM/DD/YYYY'
  | 'DD/MM/YYYY'
  | 'DD.MM.YYYY'
  | 'YYYY/MM/DD';

export type CategoryMatchField = 'merchant' | 'description' | 'any';
export type CategoryMode = 'manual' | 'rules';
export type StatementKind = 'expense' | 'income';

export interface CsvColumnMapping {
  date: string;
  amount?: string;
  debit?: string;
  credit?: string;
  currency?: string;
  description?: string;
  merchant?: string;
  counterparty?: string;
  reference?: string;
  balance?: string;
}

export interface DescriptionFlag {
  id: 'possible_own_account_transfer';
  /** Case-insensitive substring. Not a regular expression. */
  pattern: string;
}

export interface CsvParseOptions {
  delimiter: CsvDelimiter;
  decimalSeparator: DecimalSeparator;
  dateFormat: StatementDateFormat;
  encoding: StatementEncoding;
  hasHeader: boolean;
  defaultCurrency?: string | null;
  skipEmptyAmount?: boolean;
  checkRunningBalance?: boolean;
  descriptionFlags?: DescriptionFlag[];
  /** When true, scan every row after skipRows for the header names. Default true. */
  headerSearch?: boolean;
  /** Rows to ignore before the header search, or before the first data row. */
  skipRows?: number;
}

/** 1-based column index, matching a spreadsheet column number. */
export interface XlsColumnSpec {
  index: number;
  header: string;
}

export interface XlsHeaderAliases {
  valueDate: readonly string[];
  transactionDate: readonly string[];
  currency: readonly string[];
  credit: readonly string[];
  debit: readonly string[];
  description: readonly string[];
}

export interface XlsLayout {
  sheetName: string | null;
  columns: {
    valueDate: XlsColumnSpec;
    transactionDate: XlsColumnSpec;
    currency: XlsColumnSpec;
    credit: XlsColumnSpec;
    debit: XlsColumnSpec;
    description: XlsColumnSpec;
  };
  dateFormat: StatementDateFormat;
  decimalSeparator: DecimalSeparator;
  /** Preamble label whose neighbour cell is the account reference. */
  accountLabel: string | null;
  descriptionFlags: DescriptionFlag[];
  /** Header labels recognized anywhere on the header row. Built-in aliases apply when omitted. */
  headerAliases?: XlsHeaderAliases;
  headerVariants?: readonly XlsHeaderVariant[];
  accountAliases?: readonly string[];
}

export interface XlsHeaderVariant {
  id: string;
  columns: XlsLayout['columns'];
}

/** Amount text kept until a target account supplies the currency and its minor-unit scale. */
export interface PendingAmount {
  text: string;
  mode: 'amount' | 'debit' | 'credit';
  decimalSeparator: DecimalSeparator;
}

export interface StatementRow {
  sourceIndex: number;
  date: string;
  valueDate: string | null;
  amountMinor: number;
  /** Empty when the file and the template have no currency and an account has not been applied yet. */
  currency: string;
  description: string;
  merchant: string | null;
  counterparty: string | null;
  reference: string | null;
  bankTransactionId: string | null;
  balanceMinor: number | null;
  kind: StatementKind;
  warnings: string[];
  possibleOwnAccountTransfer: boolean;
  pendingAmount?: PendingAmount;
  pendingBalanceText?: string;
  currencyFromAccount?: boolean;
}

export interface ParsedStatement {
  accountRef: string | null;
  currency: string | null;
  rows: StatementRow[];
  warnings: string[];
  /** Format actually used, after a failed preferred format is replaced. */
  dateFormat?: StatementDateFormat | null;
  checkRunningBalance?: boolean;
}

export interface StatementParseResult {
  format: StatementFormat;
  encodingNote: string | null;
  statements: ParsedStatement[];
  warnings: string[];
  /** Set when auto-detect recognized a built-in PDF layout and the request named no preset. */
  detectedPresetId?: string | null;
}

export class StatementParseError extends Error {
  readonly code: string | null;

  constructor(message: string, code?: string | null) {
    super(message);
    this.name = 'StatementParseError';
    this.code = code ?? null;
  }
}

export class StatementLimitError extends Error {
  constructor(readonly scope: 'rows', readonly limit: number) {
    super(`Statement import rows exceed the limit of ${limit}`);
    this.name = 'StatementLimitError';
  }
}
