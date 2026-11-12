// Deterministic text-layer PDF statements. No OCR, no network, no native modules.
// unpdf's PDF.js build runs on Cloudflare Workers and returns glyph positions.
import { extractTextItems, type StructuredTextItem } from 'unpdf';
import { type PdfLayoutId } from './pdf-preset';
import {
  CLOSING_BALANCE_MISMATCH_WARNING,
  type ParsedStatement,
  type StatementRow,
  StatementParseError,
} from './types';
import {
  assertRowBudget,
  kindFromSignedAmount,
  parseMajorToMinor,
} from './amounts';

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

const US_AMOUNT = /-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/;
const EU_AMOUNT = /(?:\d{1,3}(?:\.\d{3})+|\d+)?,\d{2}-?/;

export function foldPdfText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isEncryptedPdfError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : '';
  return name === 'PasswordException' || /encrypt|password/i.test(`${name} ${message}`);
}

/** A column gap, not kerning. Oracle draws each cell as its own run with no space glyph between them. */
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
  return groups.map((group) => ({
    page,
    y: group.reduce((sum, glyph) => sum + glyph.y, 0) / group.length,
    glyphs: group.map(({ text, x, width }) => ({ text, x, width })),
    text: lineText(group),
  })).filter((line) => line.text.length > 0);
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

export function detectPdfLayout(lines: PdfLine[]): PdfLayoutId | null {
  const text = foldPdfText(lines.map((line) => line.text).join('\n'));
  if (text.includes('promene u periodu')) return 'bps-fx';
  if (text.includes('izvod broj') || text.includes('ukupno za izvod')) return 'bps-izvod';
  if (
    (text.includes('adv safebalance') || text.includes('ending balance'))
    && (text.includes('deposits and other additions') || text.includes('withdrawals and other subtractions'))
  ) {
    return 'bofa';
  }
  return null;
}

function isoDate(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new StatementParseError(`invalid date ${day}.${month}.${year}`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new StatementParseError(`invalid date ${day}.${month}.${year}`);
  }
  const monthText = String(month).padStart(2, '0');
  const dayText = String(day).padStart(2, '0');
  return `${year}-${monthText}-${dayText}`;
}

function century(year: number): number {
  return year >= 70 ? 1900 + year : 2000 + year;
}

function parseSigned(raw: string, decimal: '.' | ',', currency: string): number {
  let text = raw.trim();
  let negative = false;
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1);
  }
  const minor = parseMajorToMinor(text, decimal, currency);
  return negative ? -Math.abs(minor) : minor;
}

function textsMatching(line: PdfLine, pattern: RegExp): string[] {
  const exact = new RegExp(`^${pattern.source}$`);
  const fromGlyphs = line.glyphs
    .map((glyph) => glyph.text.trim())
    .filter((text) => exact.test(text));
  if (fromGlyphs.length > 0) return fromGlyphs;
  return [...line.text.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match[0]);
}

function glyphCenter(line: PdfLine, amount: string): number | null {
  const glyph = line.glyphs.find((item) => item.text.trim() === amount);
  if (!glyph) return null;
  return glyph.x + Math.max(glyph.width, 0) / 2;
}

function makeRow(
  sourceIndex: number,
  date: string,
  amountMinor: number,
  currency: string,
  description: string,
  extras: { reference?: string | null; balance?: number | null } = {},
): StatementRow {
  assertRowBudget(sourceIndex);
  const text = description.replace(/\s+/g, ' ').trim() || 'Statement line';
  return {
    sourceIndex,
    date,
    valueDate: null,
    amountMinor,
    currency,
    description: text,
    merchant: null,
    counterparty: null,
    reference: extras.reference ?? null,
    bankTransactionId: extras.reference ?? null,
    balanceMinor: extras.balance ?? null,
    kind: kindFromSignedAmount(amountMinor),
    warnings: [],
    possibleOwnAccountTransfer: false,
  };
}

function noteClosing(statement: ParsedStatement, opening: number | null, closing: number | null): void {
  if (opening === null || closing === null) return;
  const sum = statement.rows.reduce((total, row) => total + row.amountMinor, 0);
  if (opening + sum !== closing) statement.warnings.push(CLOSING_BALANCE_MISMATCH_WARNING);
}

function skipRsdNoise(text: string): boolean {
  const name = foldPdfText(text).replace(/^['"]+/, '');
  return name.startsWith('strana')
    || name.includes('stampano')
    || name.includes('asseco see')
    || name.includes('ks2stampa')
    || name.includes('br.oper')
    || name.includes('br. oper')
    || name.startsWith('poziv za reklamaciju')
    || name.startsWith('vreme prijema')
    || name.startsWith('iznos transakcije')
    || name.startsWith('iznos u obracunskoj')
    || name.startsWith('prodaja ')
    || name.startsWith('ukupno')
    || name.startsWith('prethodno stanje')
    || name.startsWith('novo stanje')
    || name.startsWith('nerealizovani')
    || name.startsWith('kamatne');
}

function rsdAnchors(lines: PdfLine[]): { credit: number; debit: number; balance: number } | null {
  for (const line of lines) {
    let credit: number | null = null;
    let debit: number | null = null;
    let balance: number | null = null;
    for (const glyph of line.glyphs) {
      const name = foldPdfText(glyph.text);
      if (!name) continue;
      const center = glyph.x + Math.max(glyph.width, 0) / 2;
      if (name.includes('potraz')) credit = center;
      else if (name.includes('duguje')) debit = center;
      else if (name === 'stanje' || name.startsWith('stanje')) balance = center;
    }
    if (credit !== null && debit !== null) {
      return { credit, debit, balance: balance ?? debit + 70 };
    }
  }
  return null;
}

function labeledMinor(lines: PdfLine[], label: string, currency: string): number | null {
  for (const line of lines) {
    if (!foldPdfText(line.text).includes(label)) continue;
    const amounts = textsMatching(line, US_AMOUNT);
    const last = amounts[amounts.length - 1];
    if (!last) continue;
    return parseMajorToMinor(last, '.', currency);
  }
  return null;
}

function parseBpsIzvod(lines: PdfLine[]): ParsedStatement {
  const anchors = rsdAnchors(lines);
  const account = lines.map((line) => /Ra[čc]un:\s*([0-9][0-9-]*)/i.exec(line.text)?.[1]).find(Boolean) ?? null;
  const rows: StatementRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (foldPdfText(line.text).includes('ukupno za izvod')) break;
    const start = /^(\d+)\.\s*(\d{2})\.(\d{2})\.(\d{4})\b/.exec(line.text);
    if (!start) {
      index += 1;
      continue;
    }
    const block = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!;
      if (foldPdfText(next.text).includes('ukupno za izvod')) break;
      if (/^\d+\.\s*\d{2}\.\d{2}\.\d{4}\b/.test(next.text)) break;
      block.push(next);
      index += 1;
    }
    const amounts = textsMatching(line, US_AMOUNT);
    if (amounts.length === 0) continue;
    const located = amounts.map((amount) => ({
      amount,
      minor: Math.abs(parseMajorToMinor(amount, '.', 'RSD')),
      x: glyphCenter(line, amount),
    }));
    let balanceEntry = located.length > 1 ? located[located.length - 1]! : null;
    let moveEntry = located.length === 1 ? located[0]! : located[located.length - 2]!;
    if (anchors && located.length > 1) {
      balanceEntry = located.reduce((best, item) => {
        const bestDistance = best.x === null ? Number.POSITIVE_INFINITY : Math.abs(best.x - anchors.balance);
        const itemDistance = item.x === null ? Number.POSITIVE_INFINITY : Math.abs(item.x - anchors.balance);
        return itemDistance < bestDistance ? item : best;
      });
      moveEntry = located.find((item) => item !== balanceEntry) ?? moveEntry;
    }
    let signed = moveEntry.minor;
    if (anchors && moveEntry.x !== null) {
      const creditDistance = Math.abs(moveEntry.x - anchors.credit);
      const debitDistance = Math.abs(moveEntry.x - anchors.debit);
      signed = debitDistance < creditDistance ? -moveEntry.minor : moveEntry.minor;
    }
    const parts: string[] = [];
    const lead = line.text
      .replace(/^\d+\.\s*\d{2}\.\d{2}\.\d{4}/, '')
      .replace(/Kartica\s*:\s*[0-9*]+/i, '')
      .replace(new RegExp(US_AMOUNT.source, 'g'), ' ')
      .replace(/(^|\s)\d{3}\.(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (lead) parts.push(lead);
    let reference: string | null = null;
    let cardNumber: string | null = null;
    for (const extra of block) {
      const card = /Kartica\s*:\s*([0-9*]+)/i.exec(extra.text);
      if (card?.[1]) cardNumber = card[1];
      if (extra === line) continue;
      const folded = foldPdfText(extra.text);
      const complaint = /Poziv za reklamaciju:\s*(\S+)/i.exec(extra.text);
      if (complaint) reference = complaint[1] ?? null;
      if (skipRsdNoise(extra.text) || folded.startsWith('poziv za reklamaciju') || folded.startsWith('kartica')) continue;
      parts.push(extra.text.trim());
    }
    if (cardNumber) parts.unshift(`Kartica ${cardNumber}`);
    rows.push(makeRow(
      rows.length + 1,
      isoDate(Number(start[4]), Number(start[3]), Number(start[2])),
      signed,
      'RSD',
      parts.join(' '),
      { reference, balance: balanceEntry?.minor ?? null },
    ));
  }
  if (rows.length === 0) throw new StatementParseError('PDF statement has no transactions');
  const statement: ParsedStatement = {
    accountRef: account,
    currency: 'RSD',
    rows,
    warnings: [],
    dateFormat: 'DD.MM.YYYY',
  };
  noteClosing(
    statement,
    labeledMinor(lines, 'prethodno stanje', 'RSD'),
    labeledMinor(lines, 'novo stanje', 'RSD'),
  );
  return statement;
}

function parseBpsFx(lines: PdfLine[]): ParsedStatement {
  const document = lines.map((line) => line.text).join('\n');
  const currencyMatch = /\bu (USD|EUR)\b/i.exec(document);
  if (!currencyMatch) throw new StatementParseError('PDF currency is missing');
  const currency = currencyMatch[1]!.toUpperCase();
  const period = /PROMENE U PERIODU:\s*(\d{2})\.(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})\.(\d{2})/i.exec(document);
  if (!period) throw new StatementParseError('PDF statement period is missing');
  const start = { day: Number(period[1]), month: Number(period[2]), year: century(Number(period[3])) };
  const end = { day: Number(period[4]), month: Number(period[5]), year: century(Number(period[6])) };
  const account = /BROJ:\s*([0-9]+(?:-[0-9]+)*)/i.exec(document)?.[1] ?? null;
  let opening: number | null = null;
  let closing: number | null = null;
  const rows: StatementRow[] = [];

  const yearFor = (month: number, day: number): number => {
    if (start.year === end.year) return start.year;
    if (month > start.month || (month === start.month && day >= start.day)) return start.year;
    return end.year;
  };

  for (const line of lines) {
    const folded = foldPdfText(line.text);
    if (folded.includes('prethodno stanje')) {
      const amounts = textsMatching(line, EU_AMOUNT);
      const last = amounts[amounts.length - 1];
      if (last) opening = parseSigned(last, ',', currency);
      continue;
    }
    if (
      folded.startsWith('izvod br')
      || folded.includes('promene u periodu')
      || folded === `u ${currency.toLowerCase()}`
      || (folded.includes('datum') && folded.includes('saldo'))
      || folded.startsWith('strana')
      || folded.includes('stampano')
    ) {
      continue;
    }
    const date = /^(\d{2})\.(\d{2})(?!\.)/.exec(line.text);
    if (!date) {
      const current = rows[rows.length - 1];
      if (current && line.text.trim()) {
        current.description = `${current.description} ${line.text.trim()}`.replace(/\s+/g, ' ').trim();
      }
      continue;
    }
    const amounts = textsMatching(line, EU_AMOUNT);
    const movement = amounts.length >= 2 ? amounts[amounts.length - 2]! : amounts[0] ?? null;
    if (!movement) continue;
    const balanceText = amounts.length >= 2 ? amounts[amounts.length - 1]! : null;
    const balance = balanceText ? parseSigned(balanceText, ',', currency) : null;
    if (balance !== null) closing = balance;
    const description = line.text
      .replace(/^\d{2}\.\d{2}(?!\.)\s*/, '')
      .replace(new RegExp(EU_AMOUNT.source, 'g'), '')
      .replace(/\s+/g, ' ')
      .trim();
    rows.push(makeRow(
      rows.length + 1,
      isoDate(yearFor(Number(date[2]), Number(date[1])), Number(date[2]), Number(date[1])),
      parseSigned(movement, ',', currency),
      currency,
      description,
      { balance },
    ));
  }
  if (rows.length === 0) throw new StatementParseError('PDF statement has no transactions');
  const statement: ParsedStatement = {
    accountRef: account,
    currency,
    rows,
    warnings: [],
    dateFormat: 'DD.MM.YYYY',
  };
  noteClosing(statement, opening, closing);
  return statement;
}

function boaSection(text: string): number | null {
  const name = foldPdfText(text).replace(/\s*-\s*continued$/, '').trim();
  if (name === 'deposits and other additions') return 1;
  if (name === 'atm and debit card subtractions') return -1;
  if (name === 'withdrawals and other subtractions') return -1;
  if (name === 'other subtractions') return -1;
  if (name === 'service fees') return -1;
  return null;
}

function boaHardStop(text: string): boolean {
  const name = foldPdfText(text);
  return name.includes('important information')
    || name.includes('intentionally left blank')
    || name.includes('scam')
    || name.includes('braille')
    || name.includes('©')
    || name.includes('copyright');
}

function boaSoftSkip(text: string): boolean {
  const name = foldPdfText(text);
  return name.length === 0
    || name.includes('continued on the next page')
    || /page \d+ of \d+/.test(name)
    || name.startsWith('pull:')
    || name.includes('account #')
    || name.startsWith('date description')
    || name.startsWith('date transaction')
    || name.startsWith('transaction description')
    || name.startsWith('beginning balance')
    || name.startsWith('ending balance')
    || name.startsWith('total ')
    || /^(deposits and other additions|atm and debit card subtractions|withdrawals and other subtractions|other subtractions|service fees)\s+\$/.test(name);
}

function summaryMinor(lines: PdfLine[], label: string): number | null {
  for (const line of lines) {
    if (!foldPdfText(line.text).startsWith(label)) continue;
    const amounts = textsMatching(line, US_AMOUNT);
    const last = amounts[amounts.length - 1];
    if (!last) continue;
    return parseMajorToMinor(last, '.', 'USD');
  }
  return null;
}

function parseBofa(lines: PdfLine[]): ParsedStatement {
  const document = lines.map((line) => line.text).join('\n');
  const account = /Account number:\s*([0-9][0-9 ]*)/i.exec(document)?.[1]?.trim() ?? null;
  const rows: StatementRow[] = [];
  let section: number | null = null;
  let quiet = false;
  for (const line of lines) {
    const sectionSign = boaSection(line.text);
    if (sectionSign !== null) {
      section = sectionSign;
      quiet = false;
      continue;
    }
    if (boaHardStop(line.text)) {
      quiet = true;
      continue;
    }
    if (boaSoftSkip(line.text) || quiet) continue;
    const date = /^(\d{2})\/(\d{2})\/(\d{2})\b/.exec(line.text.trim());
    if (!date || section === null) {
      if (section !== null && rows.length > 0 && line.text.trim()) {
        const current = rows[rows.length - 1]!;
        current.description = `${current.description} ${line.text.trim()}`.replace(/\s+/g, ' ').trim();
      }
      continue;
    }
    const amountMatch = /(-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*$/.exec(line.text.trim());
    if (!amountMatch) continue;
    const parsed = parseMajorToMinor(amountMatch[1]!, '.', 'USD');
    const amountMinor = section < 0 ? -Math.abs(parsed) : Math.abs(parsed);
    const description = line.text.trim()
      .replace(/^\d{2}\/\d{2}\/\d{2}\s*/, '')
      .replace(/(-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*$/, '')
      .trim();
    rows.push(makeRow(
      rows.length + 1,
      isoDate(century(Number(date[3])), Number(date[1]), Number(date[2])),
      amountMinor,
      'USD',
      description,
    ));
  }
  if (rows.length === 0) throw new StatementParseError('PDF statement has no transactions');
  const statement: ParsedStatement = {
    accountRef: account,
    currency: 'USD',
    rows,
    warnings: [],
    dateFormat: 'MM/DD/YYYY',
  };
  noteClosing(statement, summaryMinor(lines, 'beginning balance'), summaryMinor(lines, 'ending balance'));
  return statement;
}

export async function parsePdfStatement(
  bytes: Uint8Array,
  layouts: readonly PdfLayoutId[] | null,
): Promise<{ statement: ParsedStatement; detectedPresetId: string }> {
  const lines = await readPdfLines(bytes);
  const layout = detectPdfLayout(lines);
  if (!layout || (layouts && !layouts.includes(layout))) {
    throw new StatementParseError('PDF layout is not recognized', 'PDF_UNKNOWN_LAYOUT');
  }
  const statement = layout === 'bps-izvod'
    ? parseBpsIzvod(lines)
    : layout === 'bps-fx'
      ? parseBpsFx(lines)
      : parseBofa(lines);
  return {
    statement,
    detectedPresetId: layout === 'bofa' ? 'us-bofa-pdf' : 'rs-bps-pdf',
  };
}
