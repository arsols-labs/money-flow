import { fractionDigits } from '../currency';
import { SAFE_MINOR_MAX, SAFE_MINOR_MIN } from '../money';
import {
  STATEMENT_IMPORT_MAX_ROWS,
  type DecimalSeparator,
  type ParsedStatement,
  type PendingAmount,
  type StatementDateFormat,
  type StatementRow,
  StatementLimitError,
  StatementParseError,
} from './types';

export function normalizeStatementText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function statementFingerprint(parts: {
  accountId: number;
  date: string;
  amountMinor: number;
  currency: string;
  description: string;
  bankTransactionId: string | null;
}): string {
  const bankId = parts.bankTransactionId?.trim() ?? '';
  if (bankId) return `bank:${parts.accountId}:${bankId}`;
  return [
    'row',
    parts.accountId,
    parts.date,
    parts.amountMinor,
    parts.currency,
    normalizeStatementText(parts.description),
  ].join(':');
}

/**
 * Identity of a statement line without the ledger account.
 * Preview does not know the account until the owner picks one, and commit
 * stores `statementFingerprint` with that account. Duplicate detection compares
 * this key so a second upload of the same file still matches.
 */
export function statementRowKey(parts: {
  date: string;
  amountMinor: number;
  currency: string;
  description: string;
  bankTransactionId: string | null;
}): string {
  const bankId = parts.bankTransactionId?.trim() ?? '';
  if (bankId) return `bank:${bankId}`;
  return [
    'row',
    parts.date,
    parts.amountMinor,
    parts.currency,
    normalizeStatementText(parts.description),
  ].join(':');
}

/** Strip the account id from a stored `statementFingerprint`. */
export function rowKeyFromStoredFingerprint(stored: string): string | null {
  const bank = /^bank:(\d+):([\s\S]+)$/.exec(stored);
  if (bank) return `bank:${bank[2]}`;
  const row = /^row:(\d+):([\s\S]+)$/.exec(stored);
  if (row) return `row:${row[2]}`;
  return null;
}

const DATE_FORMAT_CANDIDATES: StatementDateFormat[] = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'DD.MM.YYYY',
];

function dateParses(raw: string, format: StatementDateFormat): boolean {
  try {
    parseStatementDate(raw, format);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a date format from the first data cells.
 * The preferred format wins when it parses every sample.
 * Otherwise the first candidate that parses every sample wins, so an
 * ambiguous 01/02/2026 stays MM/DD/YYYY rather than DD/MM/YYYY.
 */
export function chooseStatementDateFormat(
  samples: string[],
  preferred: StatementDateFormat,
): { format: StatementDateFormat; overridden: boolean }
  | { format: null; candidate: StatementDateFormat | null; example: string } {
  const usable = samples.map((sample) => sample.trim()).filter(Boolean).slice(0, 24);
  if (usable.length === 0) return { format: preferred, overridden: false };
  const score = (format: StatementDateFormat) => usable.filter((sample) => dateParses(sample, format)).length;
  if (score(preferred) === usable.length) return { format: preferred, overridden: false };
  let bestFormat: StatementDateFormat | null = null;
  let best = 0;
  for (const format of DATE_FORMAT_CANDIDATES) {
    const parsed = score(format);
    if (parsed > best) {
      best = parsed;
      bestFormat = format;
    }
  }
  if (bestFormat && best === usable.length) {
    return { format: bestFormat, overridden: bestFormat !== preferred };
  }
  if (score(preferred) > 0) return { format: preferred, overridden: false };
  const example = usable[0]!;
  return { format: null, candidate: best > 0 ? bestFormat : null, example };
}

export function parseStatementDate(raw: string, format: StatementDateFormat): string {
  const text = raw.trim();
  let year: number;
  let month: number;
  let day: number;
  if (format === 'YYYY-MM-DD' || format === 'YYYY/MM/DD') {
    const sep = format === 'YYYY-MM-DD' ? '-' : '/';
    const match = new RegExp(`^(\\d{4})\\${sep}(\\d{2})\\${sep}(\\d{2})$`).exec(text);
    if (!match) throw new StatementParseError(`invalid date "${raw}"`);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (format === 'MM/DD/YYYY') {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    if (!match) throw new StatementParseError(`invalid date "${raw}"`);
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  } else if (format === 'DD/MM/YYYY' || format === 'DD.MM.YYYY') {
    const match = format === 'DD/MM/YYYY'
      ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text)
      : /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
    if (!match) throw new StatementParseError(`invalid date "${raw}"`);
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    throw new StatementParseError(`unsupported date format "${format}"`);
  }
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new StatementParseError(`invalid date "${raw}"`);
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new StatementParseError(`invalid date "${raw}"`);
  }
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Convert a major-unit amount string to integer minor units.
 * Thousands separators are the other mark (comma when the decimal mark is a dot).
 */
export function parseMajorToMinor(
  raw: string,
  decimalSeparator: DecimalSeparator,
  currency: string,
): number {
  let text = raw.trim().replace(/\u00a0/g, '').replace(/\s+/g, '');
  if (!text) throw new StatementParseError('empty amount');
  text = text.replace(/[€$£¥]/g, '');
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('+')) text = text.slice(1);
  if (text.startsWith('-') || text.startsWith('−')) {
    negative = !negative;
    text = text.slice(1);
  }
  if (/[eE]/.test(text)) throw new StatementParseError('amount exponent is not allowed');
  const thousands = decimalSeparator === '.' ? ',' : '.';
  const withoutThousands = text.split(thousands).join('');
  const pieces = withoutThousands.split(decimalSeparator);
  if (pieces.length > 2) throw new StatementParseError(`invalid amount "${raw}"`);
  const integer = pieces[0] === '' ? '0' : pieces[0]!;
  const fraction = pieces[1] ?? '';
  if (!/^\d+$/.test(integer) || (fraction !== '' && !/^\d+$/.test(fraction))) {
    throw new StatementParseError(`invalid amount "${raw}"`);
  }
  const scale = fractionDigits(currency);
  const padded = fraction.padEnd(scale + 1, '0');
  const kept = padded.slice(0, scale);
  const next = padded[scale] ?? '0';
  const digits = `${integer}${kept}`.replace(/^0+(?=\d)/, '') || '0';
  let minor = BigInt(digits);
  if (next >= '5') minor += 1n;
  if (negative) minor = -minor;
  if (minor > BigInt(SAFE_MINOR_MAX) || minor < BigInt(SAFE_MINOR_MIN)) {
    throw new StatementParseError('amount is outside the safe integer range');
  }
  return Number(minor);
}

function signedMinor(pending: PendingAmount, currency: string): number {
  const magnitude = parseMajorToMinor(pending.text, pending.decimalSeparator, currency);
  if (pending.mode === 'debit') return magnitude > 0 ? -magnitude : magnitude;
  if (pending.mode === 'credit') return magnitude < 0 ? -magnitude : magnitude;
  return magnitude;
}

/** Fill an empty currency from the target account and scale amounts to that currency. */
export function materializeAccountCurrency(statement: ParsedStatement, currency: string): void {
  let previous: number | null = null;
  const kept: StatementRow[] = [];
  for (const row of statement.rows) {
    if (!row.currency && row.pendingAmount) {
      const amountMinor = signedMinor(row.pendingAmount, currency);
      if (amountMinor === 0) continue;
      row.amountMinor = amountMinor;
      row.kind = kindFromSignedAmount(amountMinor);
      row.currency = currency;
      row.currencyFromAccount = true;
      if (row.pendingBalanceText) {
        row.balanceMinor = parseMajorToMinor(row.pendingBalanceText, row.pendingAmount.decimalSeparator, currency);
        if (
          statement.checkRunningBalance
          && previous !== null
          && previous + amountMinor !== row.balanceMinor
        ) {
          row.warnings = [
            ...row.warnings,
            'running balance does not match the previous balance plus this amount',
          ];
        }
        previous = row.balanceMinor;
      }
      delete row.pendingAmount;
      delete row.pendingBalanceText;
    } else if (row.balanceMinor !== null) {
      previous = row.balanceMinor;
    }
    kept.push(row);
  }
  statement.rows = kept;
  const currencies = new Set(kept.map((row) => row.currency).filter(Boolean));
  if (currencies.size === 1) statement.currency = [...currencies][0]!;
}

export function assertRowBudget(count: number, limit = STATEMENT_IMPORT_MAX_ROWS): void {
  if (count > limit) throw new StatementLimitError('rows', limit);
}

export function kindFromSignedAmount(amountMinor: number): 'expense' | 'income' {
  return amountMinor < 0 ? 'expense' : 'income';
}

export function descriptionHasFlag(description: string, pattern: string): boolean {
  const needle = normalizeStatementText(pattern);
  if (!needle) return false;
  return normalizeStatementText(description).includes(needle);
}
