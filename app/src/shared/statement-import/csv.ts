import { normalizeIso4217CurrencyCode } from '../currency';
import {
  assertRowBudget,
  chooseStatementDateFormat,
  descriptionHasFlag,
  kindFromSignedAmount,
  parseMajorToMinor,
  parseStatementDate,
} from './amounts';
import {
  type CsvColumnMapping,
  type CsvParseOptions,
  type ParsedStatement,
  type StatementDateFormat,
  type StatementRow,
  StatementLimitError,
  StatementParseError,
} from './types';

export function parseCsvTable(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (quoted) throw new StatementParseError('CSV has an unterminated quote');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim().length > 0));
}

function headerName(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/^["']+|["']+$/g, '')
    .replace(/[:*]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findHeaderRow(rows: string[][], names: string[]): number {
  const wanted = names.map(headerName);
  for (let index = 0; index < rows.length; index += 1) {
    const have = new Set(rows[index]!.map(headerName));
    if (wanted.every((name) => have.has(name))) return index;
  }
  return -1;
}

function cellAt(row: string[], index: number): string {
  return (row[index] ?? '').trim();
}

export function parseCsvStatement(
  text: string,
  mapping: CsvColumnMapping,
  options: CsvParseOptions,
): ParsedStatement {
  if (!mapping.date?.trim()) throw new StatementParseError('CSV mapping needs a date column');
  if (!mapping.amount?.trim() && !(mapping.debit?.trim() && mapping.credit?.trim())) {
    throw new StatementParseError('CSV mapping needs amount or both debit and credit');
  }
  const table = parseCsvTable(text, options.delimiter);
  const mappedNames = [
    mapping.date,
    mapping.amount,
    mapping.debit,
    mapping.credit,
    mapping.currency,
    mapping.description,
    mapping.merchant,
    mapping.counterparty,
    mapping.reference,
    mapping.balance,
  ].filter((name): name is string => Boolean(name?.trim()));
  const skipRows = Math.max(0, options.skipRows ?? 0);
  const searchFrom = Math.min(skipRows, table.length);
  const headerSearch = options.headerSearch !== false;
  let headerIndex = -1;
  if (options.hasHeader) {
    if (headerSearch) {
      const found = findHeaderRow(table.slice(searchFrom), mappedNames);
      headerIndex = found < 0 ? -1 : found + searchFrom;
    } else if (searchFrom < table.length) {
      headerIndex = searchFrom;
    }
  }
  if (options.hasHeader && headerIndex < 0) {
    throw new StatementParseError('CSV header row was not found');
  }
  const header = options.hasHeader ? table[headerIndex]! : [];
  const indexOf = (name: string | undefined): number => {
    if (!name?.trim()) return -1;
    if (!options.hasHeader) {
      const numeric = Number(name);
      return Number.isInteger(numeric) && numeric >= 1 ? numeric - 1 : -1;
    }
    return header.findIndex((cell) => headerName(cell) === headerName(name));
  };
  const dateCol = indexOf(mapping.date);
  const amountCol = indexOf(mapping.amount);
  const debitCol = indexOf(mapping.debit);
  const creditCol = indexOf(mapping.credit);
  const currencyCol = indexOf(mapping.currency);
  const descriptionCol = indexOf(mapping.description);
  const merchantCol = indexOf(mapping.merchant);
  const counterpartyCol = indexOf(mapping.counterparty);
  const referenceCol = indexOf(mapping.reference);
  const balanceCol = indexOf(mapping.balance);
  if (dateCol < 0) throw new StatementParseError('CSV date column was not found');
  if (amountCol < 0 && (debitCol < 0 || creditCol < 0)) {
    throw new StatementParseError('CSV amount columns were not found');
  }

  const rows: StatementRow[] = [];
  const warnings: string[] = [];
  let previousBalance: number | null = null;
  const start = options.hasHeader ? headerIndex + 1 : searchFrom;
  const dateSamples: string[] = [];
  for (let index = start; index < table.length && dateSamples.length < 24; index += 1) {
    const sample = cellAt(table[index]!, dateCol);
    if (sample) dateSamples.push(sample);
  }
  const dateChoice = chooseStatementDateFormat(dateSamples, options.dateFormat);
  if (dateChoice.format === null) {
    throw new StatementParseError(dateChoice.candidate
      ? `invalid date "${dateChoice.example}"; the dates look like ${dateChoice.candidate}`
      : `invalid date "${dateChoice.example}"; set the date format`);
  }
  const dateFormat = dateChoice.format;
  if (dateChoice.overridden) warnings.push(`using date format ${dateFormat}`);
  const currencyFallback = normalizeIso4217CurrencyCode(options.defaultCurrency || '');
  const deferCurrency = currencyCol < 0 && !currencyFallback;
  for (let index = start; index < table.length; index += 1) {
    const source = table[index]!;
    const sourceIndex = index + 1;
    try {
      const description = descriptionCol >= 0 ? cellAt(source, descriptionCol) : '';
      const merchant = merchantCol >= 0 ? cellAt(source, merchantCol) : '';
      const counterparty = counterpartyCol >= 0 ? cellAt(source, counterpartyCol) : '';
      const reference = referenceCol >= 0 ? cellAt(source, referenceCol) : '';
      const currencyText = currencyCol >= 0 ? cellAt(source, currencyCol) : '';
      const currency = normalizeIso4217CurrencyCode(currencyText || '') || currencyFallback;
      const amountText = amountCol >= 0 ? cellAt(source, amountCol) : '';
      const debitText = debitCol >= 0 ? cellAt(source, debitCol) : '';
      const creditText = creditCol >= 0 ? cellAt(source, creditCol) : '';
      const balanceText = balanceCol >= 0 ? cellAt(source, balanceCol) : '';

      if (amountCol >= 0 && !amountText && options.skipEmptyAmount) {
        if (balanceText && currency) {
          previousBalance = parseMajorToMinor(balanceText, options.decimalSeparator, currency);
        }
        continue;
      }
      if (!currency && !deferCurrency) throw new StatementParseError('currency is missing or not an ISO 4217 code');

      let amountMinor = 0;
      let pendingAmount: StatementRow['pendingAmount'];
      if (amountCol >= 0) {
        if (!amountText) throw new StatementParseError('amount is empty');
        if (currency) amountMinor = parseMajorToMinor(amountText, options.decimalSeparator, currency);
        else pendingAmount = { text: amountText, mode: 'amount', decimalSeparator: options.decimalSeparator };
      } else if (debitText && creditText) {
        throw new StatementParseError('both debit and credit are filled');
      } else if (debitText) {
        if (currency) {
          const debit = parseMajorToMinor(debitText, options.decimalSeparator, currency);
          amountMinor = debit > 0 ? -debit : debit;
        } else pendingAmount = { text: debitText, mode: 'debit', decimalSeparator: options.decimalSeparator };
      } else if (creditText) {
        if (currency) {
          const credit = parseMajorToMinor(creditText, options.decimalSeparator, currency);
          amountMinor = credit < 0 ? -credit : credit;
        } else pendingAmount = { text: creditText, mode: 'credit', decimalSeparator: options.decimalSeparator };
      } else {
        continue;
      }
      if (currency && amountMinor === 0) {
        warnings.push(`row ${sourceIndex} skipped: amount is zero`);
        continue;
      }
      if (!currency && pendingAmount && amountLooksZero(pendingAmount.text)) {
        warnings.push(`row ${sourceIndex} skipped: amount is zero`);
        continue;
      }

      const date = parseStatementDate(cellAt(source, dateCol), dateFormat);
      const rowWarnings: string[] = [];
      let balanceMinor: number | null = null;
      let pendingBalanceText: string | undefined;
      if (balanceText && currency) {
        balanceMinor = parseMajorToMinor(balanceText, options.decimalSeparator, currency);
        if (
          options.checkRunningBalance
          && previousBalance !== null
          && previousBalance + amountMinor !== balanceMinor
        ) {
          rowWarnings.push('running balance does not match the previous balance plus this amount');
        }
        previousBalance = balanceMinor;
      } else if (balanceText) {
        pendingBalanceText = balanceText;
      }
      const text = description || merchant || counterparty || 'Statement line';
      const flags = options.descriptionFlags ?? [];
      rows.push({
        sourceIndex,
        date,
        valueDate: null,
        amountMinor,
        currency: currency || '',
        description: text,
        merchant: merchant || null,
        counterparty: counterparty || null,
        reference: reference || null,
        bankTransactionId: reference || null,
        balanceMinor,
        kind: kindFromSignedAmount(amountMinor),
        warnings: rowWarnings,
        possibleOwnAccountTransfer: flags.some((flag) => descriptionHasFlag(text, flag.pattern)),
        ...(pendingAmount ? { pendingAmount, pendingBalanceText } : {}),
      });
      assertRowBudget(rows.length);
    } catch (error) {
      if (error instanceof StatementLimitError) throw error;
      const detail = error instanceof Error ? error.message : 'invalid row';
      warnings.push(`row ${sourceIndex} skipped: ${detail}`);
    }
  }
  if (rows.length === 0) {
    const detail = warnings.slice(0, 3).join('; ');
    throw new StatementParseError(detail
      ? `CSV has no transaction rows: ${detail}`
      : 'CSV has no transaction rows');
  }
  const currencies = new Set(rows.map((row) => row.currency).filter(Boolean));
  return {
    accountRef: null,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    rows,
    warnings,
    dateFormat,
    checkRunningBalance: Boolean(options.checkRunningBalance),
  };
}

function amountLooksZero(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 && /^0+$/.test(digits);
}

/** Date format a generic CSV should preselect, or null when the header cannot be read. */
export function suggestCsvDateFormat(
  text: string,
  mapping: CsvColumnMapping,
  options: CsvParseOptions,
): StatementDateFormat | null {
  try {
    const parsed = parseCsvStatement(text, mapping, options);
    return parsed.dateFormat ?? null;
  } catch (error) {
    if (!(error instanceof StatementParseError)) return null;
    const match = /the dates look like ([A-Z0-9./-]+)/.exec(error.message);
    const candidate = match?.[1];
    if (
      candidate === 'YYYY-MM-DD'
      || candidate === 'YYYY/MM/DD'
      || candidate === 'MM/DD/YYYY'
      || candidate === 'DD/MM/YYYY'
      || candidate === 'DD.MM.YYYY'
    ) return candidate;
    return null;
  }
}
