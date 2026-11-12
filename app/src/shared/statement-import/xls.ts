import { normalizeIso4217CurrencyCode } from '../currency';
import {
  assertRowBudget,
  descriptionHasFlag,
  kindFromSignedAmount,
  parseMajorToMinor,
  parseStatementDate,
} from './amounts';
import { builtinAccountAliases, builtinXlsHeaderAliases } from './templates';
import {
  type ParsedStatement,
  type StatementRow,
  type XlsHeaderAliases,
  type XlsLayout,
  StatementLimitError,
  StatementParseError,
} from './types';

interface XlsxSheet {
  [cell: string]: unknown;
}

interface XlsxModule {
  read: (data: Uint8Array, opts: { type: 'array'; cellDates?: boolean }) => {
    SheetNames: string[];
    Sheets: Record<string, XlsxSheet>;
  };
  utils: {
    sheet_to_json: (
      sheet: XlsxSheet,
      opts: { header: 1; raw: boolean; defval: string },
    ) => unknown[][];
  };
}

async function loadXlsx(): Promise<XlsxModule> {
  const mod = await import('xlsx');
  const loaded = ((mod as { default?: XlsxModule }).default ?? mod) as XlsxModule;
  if (typeof loaded.read !== 'function') {
    throw new StatementParseError('Excel reader is unavailable');
  }
  return loaded;
}

function cellText(row: unknown[], index: number): string {
  const value = row[index - 1];
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeHeaderLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[:*]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

type HeaderRole = 'valueDate' | 'transactionDate' | 'currency' | 'credit' | 'debit' | 'description';

interface HeaderMatch {
  role: HeaderRole;
  alias: string;
}

function matchList(aliases: XlsHeaderAliases): HeaderMatch[] {
  return (Object.entries(aliases) as Array<[HeaderRole, readonly string[]]>)
    .flatMap(([role, items]) => items.map((alias) => ({ role, alias: normalizeHeaderLabel(alias) })))
    .filter((entry) => entry.alias.length > 0)
    .sort((left, right) => right.alias.length - left.alias.length);
}

function resolvedAliases(layout: XlsLayout): XlsHeaderAliases {
  const base = layout.headerAliases ?? builtinXlsHeaderAliases();
  const merged: Record<HeaderRole, string[]> = {
    valueDate: [...base.valueDate],
    transactionDate: [...base.transactionDate],
    currency: [...base.currency],
    credit: [...base.credit],
    debit: [...base.debit],
    description: [...base.description],
  };
  for (const variant of layout.headerVariants ?? []) {
    for (const role of Object.keys(merged) as HeaderRole[]) {
      const header = normalizeHeaderLabel(variant.columns[role]?.header ?? '');
      if (!header || merged[role].some((alias) => normalizeHeaderLabel(alias) === header)) continue;
      merged[role].push(header);
    }
  }
  return merged;
}

function headerRole(cell: string, matches: readonly HeaderMatch[]): HeaderRole | null {
  const norm = normalizeHeaderLabel(cell);
  if (!norm) return null;
  for (const entry of matches) {
    if (norm === entry.alias) return entry.role;
  }
  return null;
}

interface ResolvedColumns {
  valueDate: number;
  transactionDate: number;
  currency: number;
  credit: number;
  debit: number;
  description: number;
}

function findByAliases(
  rows: unknown[][],
  matches: readonly HeaderMatch[],
): { headerIndex: number; columns: ResolvedColumns } | null {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const found = new Map<HeaderRole, number>();
    for (let cell = 0; cell < row.length; cell += 1) {
      const role = headerRole(String(row[cell] ?? ''), matches);
      if (!role || found.has(role)) continue;
      found.set(role, cell + 1);
    }
    const dateIndex = found.get('transactionDate') ?? found.get('valueDate');
    const currency = found.get('currency');
    const credit = found.get('credit');
    const debit = found.get('debit');
    const description = found.get('description');
    if (dateIndex === undefined || currency === undefined || credit === undefined || debit === undefined || description === undefined) {
      continue;
    }
    return {
      headerIndex: index,
      columns: {
        valueDate: found.get('valueDate') ?? dateIndex,
        transactionDate: found.get('transactionDate') ?? dateIndex,
        currency,
        credit,
        debit,
        description,
      },
    };
  }
  return null;
}

function headerMatches(row: unknown[], column: { index: number; header: string }): boolean {
  const have = normalizeHeaderLabel(cellText(row, column.index));
  const want = normalizeHeaderLabel(column.header);
  return want.length > 0 && (have === want || have.includes(want));
}

function findHeader(rows: unknown[][], layout: XlsLayout): { headerIndex: number; columns: ResolvedColumns } | null {
  const named = findByAliases(rows, matchList(resolvedAliases(layout)));
  if (named) return named;
  const columns = Object.values(layout.columns);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (columns.every((column) => headerMatches(row, column))) {
      return {
        headerIndex: index,
        columns: {
          valueDate: layout.columns.valueDate.index,
          transactionDate: layout.columns.transactionDate.index,
          currency: layout.columns.currency.index,
          credit: layout.columns.credit.index,
          debit: layout.columns.debit.index,
          description: layout.columns.description.index,
        },
      };
    }
  }
  return null;
}

function sniffDecimalSeparator(values: string[], fallback: '.' | ','): '.' | ',' {
  for (const raw of values) {
    const text = raw.replace(/\s+/g, '');
    if (!text) continue;
    if (/\d\.\d{3},\d/.test(text) || /^\d+,\d{1,2}$/.test(text)) return ',';
    if (/\d,\d{3}\.\d/.test(text) || /^\d+\.\d{1,2}$/.test(text)) return '.';
  }
  return fallback;
}

function excelSerialDate(raw: string): string | null {
  if (!/^\d{5}(\.\d+)?$/.test(raw)) return null;
  const serial = Math.floor(Number(raw));
  if (serial < 20000 || serial > 80000) return null;
  const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseFlexibleDate(raw: string, preferred: XlsLayout['dateFormat']): string {
  const serial = excelSerialDate(raw);
  if (serial) return serial;
  const formats = [preferred, 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'] as const;
  let last: unknown;
  for (const format of [...new Set(formats)]) {
    try {
      return parseStatementDate(raw, format);
    } catch (error) {
      last = error;
    }
  }
  if (last instanceof Error) throw last;
  throw new StatementParseError(`invalid date "${raw}"`);
}

function accountFromPreamble(rows: unknown[][], until: number, layout: XlsLayout): string | null {
  const labels = new Set((layout.accountAliases ?? builtinAccountAliases()).map((alias) => normalizeHeaderLabel(alias)));
  if (layout.accountLabel) labels.add(normalizeHeaderLabel(layout.accountLabel));
  for (let index = 0; index < until; index += 1) {
    const row = rows[index] ?? [];
    for (let cell = 0; cell < row.length; cell += 1) {
      const text = normalizeHeaderLabel(String(row[cell] ?? ''));
      if (!labels.has(text)) continue;
      for (let next = cell + 1; next < row.length; next += 1) {
        const value = String(row[next] ?? '').trim();
        if (value) return value;
      }
    }
  }
  return null;
}

const DEFAULT_XLS_LAYOUT: XlsLayout = {
  sheetName: null,
  columns: {
    valueDate: { index: 1, header: 'Value date' },
    transactionDate: { index: 2, header: 'Transaction date' },
    currency: { index: 3, header: 'Currency code' },
    credit: { index: 4, header: 'Credit' },
    debit: { index: 5, header: 'Debit' },
    description: { index: 6, header: 'Description' },
  },
  dateFormat: 'DD/MM/YYYY',
  decimalSeparator: '.',
  accountLabel: 'Account',
  descriptionFlags: [{ id: 'possible_own_account_transfer', pattern: 'otkup strane valute' }],
};

export async function parseXls(bytes: Uint8Array, layout: XlsLayout | null): Promise<ParsedStatement> {
  const effective = layout ?? DEFAULT_XLS_LAYOUT;
  const xlsx = await loadXlsx();
  let book: ReturnType<XlsxModule['read']>;
  try {
    book = xlsx.read(bytes, { type: 'array', cellDates: false });
  } catch {
    throw new StatementParseError('Excel workbook could not be read');
  }
  if (book.SheetNames.length === 0) throw new StatementParseError('Excel workbook has no sheet');
  const preferred = effective.sheetName && book.SheetNames.includes(effective.sheetName)
    ? [effective.sheetName, ...book.SheetNames.filter((name) => name !== effective.sheetName)]
    : book.SheetNames;
  let table: unknown[][] | null = null;
  let resolved: { headerIndex: number; columns: ResolvedColumns } | null = null;
  for (const sheetName of preferred) {
    const sheet = book.Sheets[sheetName];
    if (!sheet) continue;
    const candidate = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const header = findHeader(candidate, effective);
    if (!header) continue;
    table = candidate;
    resolved = header;
    break;
  }
  if (!table || !resolved) throw new StatementParseError('Excel header row was not found');
  const { headerIndex, columns } = resolved;
  const accountRef = accountFromPreamble(table, headerIndex, effective);
  const amountSamples: string[] = [];
  for (let index = headerIndex + 1; index < table.length && amountSamples.length < 20; index += 1) {
    const source = table[index] ?? [];
    amountSamples.push(cellText(source, columns.credit), cellText(source, columns.debit));
  }
  const decimalSeparator = sniffDecimalSeparator(amountSamples, effective.decimalSeparator);
  const rows: StatementRow[] = [];
  const warnings: string[] = [];
  for (let index = headerIndex + 1; index < table.length; index += 1) {
    const source = table[index] ?? [];
    const sourceIndex = index + 1;
    const blank = Object.values(columns).every((column) => cellText(source, column) === '');
    if (blank) continue;
    try {
      const currency = normalizeIso4217CurrencyCode(cellText(source, columns.currency));
      if (!currency) throw new StatementParseError('currency is missing or not an ISO 4217 code');
      const creditText = cellText(source, columns.credit);
      const debitText = cellText(source, columns.debit);
      if (!creditText && !debitText) continue;
      if (creditText && debitText) throw new StatementParseError('both credit and debit are filled');
      const magnitude = parseMajorToMinor(creditText || debitText, decimalSeparator, currency);
      const amountMinor = debitText ? (magnitude > 0 ? -magnitude : magnitude) : (magnitude < 0 ? -magnitude : magnitude);
      if (amountMinor === 0) {
        warnings.push(`row ${sourceIndex} skipped: amount is zero`);
        continue;
      }
      const transactionRaw = cellText(source, columns.transactionDate);
      const valueRaw = cellText(source, columns.valueDate);
      const date = parseFlexibleDate(transactionRaw || valueRaw, effective.dateFormat);
      const valueDate = valueRaw ? parseFlexibleDate(valueRaw, effective.dateFormat) : null;
      const description = cellText(source, columns.description) || 'Statement line';
      rows.push({
        sourceIndex,
        date,
        valueDate,
        amountMinor,
        currency,
        description,
        merchant: null,
        counterparty: null,
        reference: null,
        bankTransactionId: null,
        balanceMinor: null,
        kind: kindFromSignedAmount(amountMinor),
        warnings: [],
        possibleOwnAccountTransfer: effective.descriptionFlags.some((flag) => descriptionHasFlag(description, flag.pattern)),
      });
      assertRowBudget(rows.length);
    } catch (error) {
      if (error instanceof StatementLimitError) throw error;
      const detail = error instanceof Error ? error.message : 'invalid row';
      warnings.push(`row ${sourceIndex} skipped: ${detail}`);
    }
  }
  const currencies = new Set(rows.map((row) => row.currency));
  return {
    accountRef,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    rows,
    warnings,
  };
}
