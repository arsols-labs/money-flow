// Deterministic text-layer PDF statements powered purely by D1 `pdf_layouts`.
// No OCR, no network, no hardcoded bank rules. unpdf returns glyph coordinates.
import { extractTextItems, type StructuredTextItem } from 'unpdf';
import {
  fractionDigits,
  getRuntimeCurrencyCatalog,
  normalizeCurrencyCodeSyntax,
  type CurrencyCatalog,
} from '../currency';
import { compileBoundedRegex } from '../rules/matcher';
import type { PdfBalanceRule, PdfColumnRules, PdfLayoutPayload } from '../rules/types';
import {
  assertRowBudget,
  descriptionHasFlag,
  kindFromSignedAmount,
  parseMajorToMinor,
  parseStatementDate,
} from './amounts';
import {
  CLOSING_BALANCE_MISMATCH_WARNING,
  type ParsedStatement,
  type StatementDateFormat,
  type StatementRow,
  StatementParseError,
} from './types';

export type { PdfLayoutId } from './pdf-preset';

export interface PdfGlyph {
  text: string;
  x: number;
  width: number;
}

export interface PdfLine {
  page: number;
  y: number;
  glyphs: PdfGlyph[];
  text: string;
}

export function foldPdfText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isEncryptedPdfError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : '';
  return name === 'PasswordException' || /encrypt|password/i.test(`${name} ${message}`);
}

const COLUMN_GAP = 1.25;

function lineText(glyphs: Array<PdfGlyph & { y: number }>): string {
  const sorted = [...glyphs].sort((a, b) => a.x - b.x || a.y - b.y);
  let text = '';
  let cursor = Number.NEGATIVE_INFINITY;
  for (const glyph of sorted) {
    const gap = glyph.x - cursor;
    if (text.length > 0 && gap > COLUMN_GAP && !text.endsWith(' ') && !glyph.text.startsWith(' ')) {
      text += ' ';
    }
    text += glyph.text;
    cursor = Math.max(cursor, glyph.x + Math.max(glyph.width, 0));
  }
  return text.replace(/[ \t]+/g, ' ').trim();
}

function groupPage(items: StructuredTextItem[], page: number): PdfLine[] {
  const glyphs: Array<PdfGlyph & { y: number }> = [];
  for (const item of items) {
    if (!item.str) continue;
    glyphs.push({ text: item.str, x: item.x, width: item.width, y: item.y });
  }
  glyphs.sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Array<Array<PdfGlyph & { y: number }>> = [];
  for (const glyph of glyphs) {
    const group = groups.find((candidate) => Math.abs(candidate[0]!.y - glyph.y) <= 2);
    if (group) group.push(glyph);
    else groups.push([glyph]);
  }
  return groups
    .map((group) => ({
      page,
      y: group.reduce((sum, glyph) => sum + glyph.y, 0) / group.length,
      glyphs: group.map(({ text, x, width }) => ({ text, x, width })),
      text: lineText(group),
    }))
    .filter((line) => line.text.length > 0);
}

export async function readPdfLines(bytes: Uint8Array): Promise<PdfLine[]> {
  let extracted: { items: StructuredTextItem[][] };
  try {
    extracted = await extractTextItems(new Uint8Array(bytes));
  } catch (error) {
    if (isEncryptedPdfError(error)) {
      throw new StatementParseError('PDF is encrypted', 'PDF_ENCRYPTED');
    }
    throw new StatementParseError('PDF could not be read');
  }
  const lines = extracted.items.flatMap((items, page) => groupPage(items, page));
  if (!lines.some((line) => /[A-Za-z0-9]/.test(line.text))) {
    throw new StatementParseError('PDF has no text layer', 'PDF_NO_TEXT_LAYER');
  }
  return lines;
}

export function detectPdfLayout(
  lines: readonly PdfLine[],
  layouts: readonly PdfLayoutPayload[],
): PdfLayoutPayload | null {
  const docFolded = foldPdfText(lines.map((line) => line.text).join('\n'));
  for (const layout of layouts) {
    const { include_all: incAll = [], include_any: incAny = [], exclude_any: excAny = [] } = layout.detect;
    const allOk = incAll.every((marker) => docFolded.includes(foldPdfText(marker)));
    if (!allOk) continue;
    const anyOk = incAny.length === 0 || incAny.some((marker) => docFolded.includes(foldPdfText(marker)));
    if (!anyOk) continue;
    const excluded = excAny.some((marker) => docFolded.includes(foldPdfText(marker)));
    if (excluded) continue;
    return layout;
  }
  return null;
}

interface PdfYearWindow {
  startYear: number;
  endYear: number | null;
}

function expandPdfYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{2,4}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isInteger(num)) return null;
  if (trimmed.length === 2) return num >= 70 ? 1900 + num : 2000 + num;
  if (num >= 1970 && num <= 2100) return num;
  return null;
}

function parsePdfDateFlexible(
  raw: string,
  preferred: StatementDateFormat,
  yearWindow: PdfYearWindow | null,
  prevMonth?: { value: number | null; activeYear: number | null },
): string {
  const trimmed = raw.trim();
  // Support MM/DD/YY (2-digit year)
  const shortSlash = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(trimmed);
  if (shortSlash) {
    const yy = Number(shortSlash[3]);
    const fullYear = yy >= 70 ? 1900 + yy : 2000 + yy;
    const expanded = preferred === 'DD/MM/YYYY'
      ? `${shortSlash[1]}/${shortSlash[2]}/${fullYear}`
      : `${shortSlash[1]}/${shortSlash[2]}/${fullYear}`;
    return parseStatementDate(expanded, preferred);
  }
  // Support DD.MM. (day + month, optional trailing dot) when year came from document header
  const dayMonthDot = /^(\d{2})\.(\d{2})\.?$/.exec(trimmed);
  if (dayMonthDot && yearWindow) {
    const month = Number(dayMonthDot[2]);
    let resolvedYear = yearWindow.startYear;
    if (yearWindow.endYear !== null && yearWindow.endYear > yearWindow.startYear) {
      resolvedYear = month >= 7 ? yearWindow.startYear : yearWindow.endYear;
    } else if (prevMonth) {
      if (prevMonth.activeYear === null) prevMonth.activeYear = yearWindow.startYear;
      if (prevMonth.value !== null && month < prevMonth.value) {
        prevMonth.activeYear += 1;
      }
      prevMonth.value = month;
      resolvedYear = prevMonth.activeYear;
    }
    return parseStatementDate(`${dayMonthDot[1]}.${dayMonthDot[2]}.${resolvedYear}`, 'DD.MM.YYYY');
  }
  return parseStatementDate(trimmed, preferred);
}

function findBalanceMinor(
  lines: readonly PdfLine[],
  rule: PdfBalanceRule | null | undefined,
  defaultSep: '.' | ',',
  currency: string,
  currencyCatalog: CurrencyCatalog,
): number | null {
  if (!rule) return null;
  const prefixes = (rule.label_prefixes ?? []).map(foldPdfText).filter(Boolean);
  const compiled = rule.pattern ? compileBoundedRegex(rule.pattern, 'u') : null;
  const sep = rule.decimal_separator ?? defaultSep;
  const amountToken = sep === ','
    ? /(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}-?/g
    : /-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/g;

  for (const line of lines) {
    const folded = foldPdfText(line.text);
    if (prefixes.length > 0 && !prefixes.some((p) => folded.includes(p))) continue;

    let rawAmount: string | null = null;
    if (compiled) {
      const m = compiled.exec(line.text);
      if (m) rawAmount = (m[1] ?? m[0] ?? '').trim() || null;
    } else {
      const matches = [...line.text.matchAll(amountToken)];
      const last = matches[matches.length - 1];
      if (last?.[0]) rawAmount = last[0];
    }
    if (!rawAmount) continue;

    const magnitude = parseMajorToMinor(rawAmount, sep, currency, currencyCatalog);
    let signed = magnitude;
    if ((rule.negate_if_contains ?? []).some((m) => folded.includes(foldPdfText(m)))) {
      signed = -Math.abs(magnitude);
    } else if ((rule.positive_if_contains ?? []).some((m) => folded.includes(foldPdfText(m)))) {
      signed = Math.abs(magnitude);
    }
    return signed;
  }
  return null;
}

function isNoiseLine(folded: string, layout: PdfLayoutPayload): boolean {
  if (!folded) return true;
  if ((layout.noise_prefixes ?? []).some((p) => folded.startsWith(foldPdfText(p)))) return true;
  if ((layout.noise_contains ?? []).some((c) => folded.includes(foldPdfText(c)))) return true;
  return false;
}

function makePdfRow(
  sourceIndex: number,
  date: string,
  amountMinor: number,
  currency: string,
  description: string,
  layout: PdfLayoutPayload,
  extra?: { balanceMinor?: number | null; bankTransactionId?: string | null },
): StatementRow {
  const cleanDescription = description.replace(/\s+/g, ' ').trim() || 'Statement line';
  const flags = layout.description_flags ?? [];
  const possibleOwnAccountTransfer = flags.some((flag) => {
    if (descriptionHasFlag(cleanDescription, flag.pattern)) return true;
    const re = compileBoundedRegex(flag.pattern, 'iu');
    return re ? re.test(cleanDescription) : false;
  });
  return {
    sourceIndex,
    date,
    valueDate: null,
    amountMinor,
    currency,
    description: cleanDescription,
    merchant: null,
    counterparty: null,
    reference: extra?.bankTransactionId ?? null,
    bankTransactionId: extra?.bankTransactionId ?? null,
    balanceMinor: extra?.balanceMinor ?? null,
    kind: kindFromSignedAmount(amountMinor),
    warnings: [],
    possibleOwnAccountTransfer,
  };
}

function noteClosing(statement: ParsedStatement, opening: number | null, closing: number | null): void {
  if (opening !== null && closing !== null) {
    const net = statement.rows.reduce((sum, row) => sum + row.amountMinor, 0);
    if (opening + net !== closing) statement.warnings.push(CLOSING_BALANCE_MISMATCH_WARNING);
  }
}

function extractAmountAndSign(
  match: RegExpExecArray,
  rawLine: string,
  layout: PdfLayoutPayload,
  currency: string,
  currencyCatalog: CurrencyCatalog,
  sectionSign: 1 | -1 | null,
): number | null {
  const debitRaw = layout.debit_group !== undefined ? (match[layout.debit_group] ?? '').trim() : '';
  const creditRaw = layout.credit_group !== undefined ? (match[layout.credit_group] ?? '').trim() : '';
  const amountRaw = layout.amount_group !== undefined ? (match[layout.amount_group] ?? '').trim() : '';

  if (debitRaw && !creditRaw) {
    const parsed = parseMajorToMinor(debitRaw, layout.decimal_separator, currency, currencyCatalog);
    return -Math.abs(parsed);
  }
  if (creditRaw && !debitRaw) {
    const parsed = parseMajorToMinor(creditRaw, layout.decimal_separator, currency, currencyCatalog);
    return Math.abs(parsed);
  }
  const source = amountRaw || debitRaw || creditRaw;
  if (!source) return null;

  const parsed = parseMajorToMinor(source, layout.decimal_separator, currency, currencyCatalog);
  const foldedLine = foldPdfText(rawLine);
  if ((layout.debit_indicators ?? []).some((ind) => foldedLine.includes(foldPdfText(ind)))) {
    return -Math.abs(parsed);
  }
  if ((layout.credit_indicators ?? []).some((ind) => foldedLine.includes(foldPdfText(ind)))) {
    return Math.abs(parsed);
  }
  if (sectionSign !== null && parsed > 0 && !source.trim().startsWith('-') && !source.trim().endsWith('-')) {
    return sectionSign < 0 ? -Math.abs(parsed) : Math.abs(parsed);
  }
  return parsed;
}

function findColumnCenters(
  lines: readonly PdfLine[],
  rules: PdfColumnRules | null | undefined,
): { creditX: number | null; debitX: number | null; balanceX: number | null } | null {
  if (!rules) return null;
  const matchHeaderX = (headers: readonly string[] | undefined): number | null => {
    if (!headers || headers.length === 0) return null;
    const foldedHeaders = headers.map(foldPdfText).filter(Boolean);
    for (const line of lines) {
      for (const glyph of line.glyphs) {
        const fg = foldPdfText(glyph.text);
        if (!fg) continue;
        if (foldedHeaders.some((h) => fg === h || fg.startsWith(h) || h === fg)) {
          return glyph.x + Math.max(glyph.width, 0) / 2;
        }
      }
    }
    return null;
  };
  const creditX = matchHeaderX(rules.credit_headers);
  const debitX = matchHeaderX(rules.debit_headers);
  const balanceX = matchHeaderX(rules.balance_headers);
  if (creditX === null && debitX === null) return null;
  return { creditX, debitX, balanceX };
}

function extractAmountsByColumn(
  line: PdfLine,
  centers: { creditX: number | null; debitX: number | null; balanceX: number | null },
  decimalSeparator: '.' | ',',
  currency: string,
  currencyCatalog: CurrencyCatalog,
): { amountMinor: number | null; balanceMinor: number | null } {
  const numRe = decimalSeparator === ','
    ? /^(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}-?$/
    : /^-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/;
  const buckets: Array<{ kind: 'credit' | 'debit' | 'balance'; x: number }> = [];
  if (centers.creditX !== null) buckets.push({ kind: 'credit', x: centers.creditX });
  if (centers.debitX !== null) buckets.push({ kind: 'debit', x: centers.debitX });
  if (centers.balanceX !== null) buckets.push({ kind: 'balance', x: centers.balanceX });

  let creditMinor: number | null = null;
  let debitMinor: number | null = null;
  let balanceMinor: number | null = null;

  for (const glyph of line.glyphs) {
    const token = glyph.text.trim();
    if (!token || !numRe.test(token)) continue;
    const gx = glyph.x + Math.max(glyph.width, 0) / 2;
    let best: { kind: 'credit' | 'debit' | 'balance'; dist: number } | null = null;
    for (const bucket of buckets) {
      const dist = Math.abs(gx - bucket.x);
      if (!best || dist < best.dist) best = { kind: bucket.kind, dist };
    }
    if (!best) continue;
    const parsed = Math.abs(parseMajorToMinor(token, decimalSeparator, currency, currencyCatalog));
    if (best.kind === 'credit' && parsed > 0) creditMinor = parsed;
    else if (best.kind === 'debit' && parsed > 0) debitMinor = -parsed;
    else if (best.kind === 'balance') balanceMinor = parseMajorToMinor(token, decimalSeparator, currency, currencyCatalog);
  }
  const amountMinor = creditMinor ?? debitMinor;
  return { amountMinor, balanceMinor };
}

export function parsePdfWithLayout(
  lines: readonly PdfLine[],
  layout: PdfLayoutPayload,
  currencyCatalog: CurrencyCatalog = getRuntimeCurrencyCatalog(),
): ParsedStatement {
  const documentText = lines.map((line) => line.text).join('\n');

  let accountRef: string | null = null;
  if (layout.account_ref_pattern) {
    const re = compileBoundedRegex(layout.account_ref_pattern, 'iu');
    const m = re?.exec(documentText);
    if (m) accountRef = (m[1] ?? m[0] ?? '').trim() || null;
  }

  let yearWindow: PdfYearWindow | null = null;
  if (layout.year_pattern) {
    const re = compileBoundedRegex(layout.year_pattern, 'u');
    const m = re?.exec(documentText);
    if (m) {
      const startYear = expandPdfYear(m[1] ?? m[0]);
      const endYear = m[2] ? expandPdfYear(m[2]) : null;
      if (startYear !== null) {
        yearWindow = { startYear, endYear };
      }
    }
  }

  let defaultCurrency = normalizeCurrencyCodeSyntax(layout.currency_code ?? null);
  if (!defaultCurrency && layout.currency_pattern) {
    const re = compileBoundedRegex(layout.currency_pattern, 'iu');
    const m = re?.exec(documentText);
    if (m) defaultCurrency = normalizeCurrencyCodeSyntax(m[1] ?? m[0]);
  }
  if (!defaultCurrency) {
    throw new StatementParseError('PDF currency could not be determined from layout or document');
  }
  // Fail closed up front if configured currency has no currency_standards entry in D1.
  fractionDigits(defaultCurrency, currencyCatalog);

  const rowStartRe = compileBoundedRegex(layout.row_start_pattern, 'u');
  if (!rowStartRe) {
    throw new StatementParseError(`Invalid row_start_pattern in PDF layout "${layout.id}"`);
  }
  const rowLineRe = layout.row_line_pattern ? compileBoundedRegex(layout.row_line_pattern, 'u') : null;

  const startMarkers = (layout.section_start_markers ?? []).map(foldPdfText);
  const stopMarkers = (layout.section_stop_markers ?? []).map(foldPdfText);
  const sectionSigns = (layout.section_signs ?? []).map((rule) => ({
    marker: foldPdfText(rule.marker),
    sign: rule.sign,
  }));

  const rows: StatementRow[] = [];
  const prevMonthState = { value: null as number | null, activeYear: null as number | null };

  if (layout.row_mode === 'single_line_regex') {
    const hasStartGate = startMarkers.length > 0 || sectionSigns.length > 0;
    let inSection = !hasStartGate;
    let stopped = false;
    let sectionSign: 1 | -1 | null = null;

    for (const line of lines) {
      const folded = foldPdfText(line.text);
      const signMatch = sectionSigns.find((rule) => folded === rule.marker || folded.startsWith(rule.marker));
      if (signMatch) {
        sectionSign = signMatch.sign;
        inSection = true;
        stopped = false;
        continue;
      }
      if (startMarkers.some((m) => folded.includes(m))) {
        inSection = true;
        stopped = false;
        continue;
      }
      if (stopMarkers.some((m) => folded.includes(m))) {
        stopped = true;
        continue;
      }
      if (stopped || !inSection || isNoiseLine(folded, layout)) continue;

      const trimmed = line.text.trim();
      const match = rowStartRe.exec(trimmed);
      if (!match) {
        if (rows.length > 0 && trimmed) {
          const prev = rows[rows.length - 1]!;
          prev.description = `${prev.description} ${trimmed}`.replace(/\s+/g, ' ').trim();
        }
        continue;
      }

      const rowCurrency = layout.currency_group !== undefined
        ? normalizeCurrencyCodeSyntax(match[layout.currency_group] ?? '') ?? defaultCurrency
        : defaultCurrency;
      fractionDigits(rowCurrency, currencyCatalog);

      const dateRaw = match[layout.date_group ?? 1] ?? '';
      const date = parsePdfDateFlexible(dateRaw, layout.date_format, yearWindow, prevMonthState);
      const amountMinor = extractAmountAndSign(match, trimmed, layout, rowCurrency, currencyCatalog, sectionSign);
      if (amountMinor === null || amountMinor === 0) continue;

      let balanceMinor: number | null = null;
      if (layout.balance_group !== undefined && match[layout.balance_group]) {
        balanceMinor = parseMajorToMinor(match[layout.balance_group]!, layout.decimal_separator, rowCurrency, currencyCatalog);
      }
      const bankRef = layout.bank_ref_group !== undefined ? (match[layout.bank_ref_group]?.trim() || null) : null;
      let description = layout.description_group !== undefined
        ? (match[layout.description_group] ?? '').trim()
        : trimmed.replace(rowStartRe, '').trim();
      if (!description) description = trimmed;

      rows.push(makePdfRow(rows.length + 1, date, amountMinor, rowCurrency, description, layout, {
        balanceMinor,
        bankTransactionId: bankRef,
      }));
      assertRowBudget(rows.length);
    }
  } else {
    // 'dated_blocks' mode: collect lines from each `row_start_pattern` until the next `row_start_pattern` or stop marker.
    const hasStartGate = startMarkers.length > 0;
    let inSection = !hasStartGate;
    const blocks: PdfLine[][] = [];
    let currentBlock: PdfLine[] | null = null;
    const columnCenters = findColumnCenters(lines, layout.column_rules);

    for (const line of lines) {
      const folded = foldPdfText(line.text);
      if (!inSection) {
        if (startMarkers.some((m) => folded.includes(m))) inSection = true;
        continue;
      }
      if (stopMarkers.some((m) => folded.includes(m))) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
        inSection = false;
        continue;
      }
      if (isNoiseLine(folded, layout)) continue;

      const trimmed = line.text.trim();
      if (rowStartRe.test(trimmed)) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      }
    }
    if (currentBlock) blocks.push(currentBlock);

    for (const blockLines of blocks) {
      const headLine = blockLines[0]!;
      const blockTextLines = blockLines.map((item) => item.text.trim());
      const joined = blockTextLines.join('\n');
      const target = rowLineRe ?? rowStartRe;
      const match = target.exec(joined) ?? target.exec(blockTextLines[0]!) ?? rowStartRe.exec(blockTextLines[0]!);
      if (!match) continue;

      const rowCurrency = layout.currency_group !== undefined
        ? normalizeCurrencyCodeSyntax(match[layout.currency_group] ?? '') ?? defaultCurrency
        : defaultCurrency;
      fractionDigits(rowCurrency, currencyCatalog);

      const dateRaw = match[layout.date_group ?? 1] ?? '';
      const date = parsePdfDateFlexible(dateRaw, layout.date_format, yearWindow, prevMonthState);
      let amountMinor: number | null = null;
      let balanceMinor: number | null = null;

      if (columnCenters) {
        const byCols = extractAmountsByColumn(headLine, columnCenters, layout.decimal_separator, rowCurrency, currencyCatalog);
        amountMinor = byCols.amountMinor;
        balanceMinor = byCols.balanceMinor;
      }
      if (amountMinor === null) {
        amountMinor = extractAmountAndSign(match, joined, layout, rowCurrency, currencyCatalog, null);
      }
      if (amountMinor === null || amountMinor === 0) continue;

      if (balanceMinor === null && layout.balance_group !== undefined && match[layout.balance_group]) {
        balanceMinor = parseMajorToMinor(match[layout.balance_group]!, layout.decimal_separator, rowCurrency, currencyCatalog);
      }

      let bankRef = layout.bank_ref_group !== undefined ? (match[layout.bank_ref_group]?.trim() || null) : null;
      if (!bankRef && layout.column_rules?.ref_pattern) {
        const refRe = compileBoundedRegex(layout.column_rules.ref_pattern, 'iu');
        const refMatch = refRe?.exec(joined);
        if (refMatch) bankRef = (refMatch[1] ?? refMatch[0] ?? '').trim() || null;
      }

      let description = layout.description_group !== undefined && match[layout.description_group]
        ? match[layout.description_group]!.trim()
        : '';
      if (!description) {
        const extraHead = blockTextLines[0]!.replace(rowStartRe, '').replace(/\d{1,3}(?:,\d{3})*\.\d{2}/g, '').trim();
        const bodyParts = [extraHead, ...blockTextLines.slice(1)].filter(Boolean);
        let assembled = bodyParts.join(' ');
        for (const stripPattern of layout.column_rules?.strip_patterns ?? []) {
          const stripRe = compileBoundedRegex(stripPattern, 'giu');
          if (stripRe) assembled = assembled.replace(stripRe, ' ');
        }
        description = assembled.replace(/\s+/g, ' ').trim() || blockTextLines[0]!;
      }

      rows.push(makePdfRow(rows.length + 1, date, amountMinor, rowCurrency, description, layout, {
        balanceMinor,
        bankTransactionId: bankRef,
      }));
      assertRowBudget(rows.length);
    }
  }

  if (rows.length === 0) {
    throw new StatementParseError('PDF statement has no transactions');
  }

  const openingMinor = findBalanceMinor(lines, layout.opening_balance, layout.decimal_separator, defaultCurrency, currencyCatalog);
  const closingMinor = findBalanceMinor(lines, layout.closing_balance, layout.decimal_separator, defaultCurrency, currencyCatalog)
    ?? (layout.closing_balance ? null : (rows[rows.length - 1]?.balanceMinor ?? null));

  const statement: ParsedStatement = {
    accountRef: accountRef ?? layout.account_label ?? null,
    currency: defaultCurrency,
    rows,
    warnings: [],
    dateFormat: layout.date_format,
  };
  noteClosing(statement, openingMinor, closingMinor);
  return statement;
}

export async function parsePdfStatement(
  bytes: Uint8Array,
  layouts: readonly PdfLayoutPayload[],
  options: {
    allowedLayoutIds?: readonly string[] | null;
    currencyCatalog?: CurrencyCatalog;
  } = {},
): Promise<{ statement: ParsedStatement; detectedPresetId: string; detectedLayoutId: string }> {
  if (layouts.length === 0) {
    throw new StatementParseError(
      'No active PDF layout rules are configured in D1 rules.',
      'MISSING_CONFIGURATION',
    );
  }
  const filteredLayouts = options.allowedLayoutIds && options.allowedLayoutIds.length > 0
    ? layouts.filter(
        (layout) => options.allowedLayoutIds!.includes(layout.id)
          || (layout.template_id != null && options.allowedLayoutIds!.includes(layout.template_id)),
      )
    : layouts;
  if (filteredLayouts.length === 0) {
    throw new StatementParseError(
      'No active PDF layout rules match the selected statement template.',
      'MISSING_CONFIGURATION',
    );
  }

  const lines = await readPdfLines(bytes);
  const matched = detectPdfLayout(lines, filteredLayouts);
  if (!matched) {
    throw new StatementParseError('PDF layout is not recognized', 'PDF_UNKNOWN_LAYOUT');
  }

  const statement = parsePdfWithLayout(lines, matched, options.currencyCatalog ?? getRuntimeCurrencyCatalog());
  return {
    statement,
    detectedPresetId: matched.template_id ?? matched.id,
    detectedLayoutId: matched.id,
  };
}
