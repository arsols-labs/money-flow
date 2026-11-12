import { parseCamt053 } from './camt053';
import { parseCsvStatement } from './csv';
import { parseOfx } from './ofx';
import { parsePdfStatement } from './pdf';
import { pdfLayoutsForTemplate } from './pdf-preset';
import { presetById, type CsvPreset, type StatementPreset, type XlsPreset } from './presets';
import {
  type CsvColumnMapping,
  type CsvParseOptions,
  type StatementEncoding,
  type StatementFormat,
  type StatementParseResult,
  type XlsLayout,
  StatementParseError,
} from './types';
import { parseXls } from './xls';

const WINDOWS_1252: Record<number, string> = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178',
};

export function decodeStatementBytes(bytes: Uint8Array, encoding: StatementEncoding): string {
  if (encoding === 'utf-8') return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  let out = '';
  for (const byte of bytes) {
    if (encoding === 'windows-1252' && WINDOWS_1252[byte]) out += WINDOWS_1252[byte];
    else out += String.fromCharCode(byte);
  }
  return out;
}

export function detectTextFormat(text: string): 'ofx' | 'camt053' | 'csv' {
  const head = text.slice(0, 8000);
  if (/<OFX|OFXHEADER/i.test(head)) return 'ofx';
  if (/BkToCstmrStmt|camt\.053/i.test(head)) return 'camt053';
  return 'csv';
}

export function isOleWorkbook(bytes: Uint8Array): boolean {
  return bytes.length > 8
    && bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0;
}

/** `%PDF` magic. Checked before CSV so a statement never falls through to column mapping. */
export function isPdfBytes(bytes: Uint8Array | null | undefined): boolean {
  return !!bytes
    && bytes.length >= 4
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46;
}

export function isPdfName(filename: string | null | undefined): boolean {
  return !!filename && filename.trim().toLowerCase().endsWith('.pdf');
}

export function looksLikePdf(input: {
  filename?: string | null;
  text?: string | null;
  bytes?: Uint8Array | null;
}): boolean {
  if (isPdfBytes(input.bytes)) return true;
  if (input.text?.startsWith('%PDF')) return true;
  return isPdfName(input.filename);
}

function csvPresetOrMapping(
  preset: CsvPreset | null,
  mapping: CsvColumnMapping | null,
  options: Partial<CsvParseOptions> | null,
): { mapping: CsvColumnMapping; options: CsvParseOptions } {
  const baseMapping = mapping ?? preset?.mapping;
  const baseOptions = { ...preset?.options, ...stripEmpty(options) };
  if (!baseMapping) throw new StatementParseError('CSV column mapping is required');
  if (!baseOptions.delimiter || !baseOptions.decimalSeparator || !baseOptions.dateFormat) {
    throw new StatementParseError('CSV options need delimiter, decimal separator, and date format');
  }
  return {
    mapping: baseMapping,
    options: {
      delimiter: baseOptions.delimiter,
      decimalSeparator: baseOptions.decimalSeparator,
      dateFormat: baseOptions.dateFormat,
      encoding: baseOptions.encoding ?? 'utf-8',
      hasHeader: baseOptions.hasHeader ?? true,
      defaultCurrency: baseOptions.defaultCurrency ?? null,
      skipEmptyAmount: baseOptions.skipEmptyAmount ?? false,
      checkRunningBalance: baseOptions.checkRunningBalance ?? false,
      descriptionFlags: baseOptions.descriptionFlags ?? [],
      headerSearch: baseOptions.headerSearch !== false,
      skipRows: baseOptions.skipRows ?? 0,
    },
  };
}

function stripEmpty(options: Partial<CsvParseOptions> | null): Partial<CsvParseOptions> {
  if (!options) return {};
  const out: Partial<CsvParseOptions> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export async function parseStatementFile(input: {
  format: StatementFormat | 'auto';
  filename?: string | null;
  text?: string | null;
  bytes?: Uint8Array | null;
  encoding?: StatementEncoding | null;
  presetId?: string | null;
  preset?: StatementPreset | null;
  mapping?: CsvColumnMapping | null;
  options?: Partial<CsvParseOptions> | null;
  xlsLayout?: XlsLayout | null;
}): Promise<StatementParseResult> {
  const preset = input.preset ?? (input.presetId ? presetById(input.presetId) : null);
  if (input.presetId && !preset) throw new StatementParseError(`unknown preset "${input.presetId}"`);
  const encoding = input.encoding ?? (preset?.format === 'csv' ? preset.options.encoding : 'utf-8');
  let format = input.format;
  // Magic bytes and a .pdf name win over CSV, including an explicit csv format.
  const fileIsPdf = looksLikePdf(input);
  if (fileIsPdf) format = 'pdf';
  else if (format === 'auto') {
    if (input.bytes && isOleWorkbook(input.bytes)) format = 'xls';
    else format = detectTextFormat(input.text ?? (input.bytes ? decodeStatementBytes(input.bytes, encoding) : ''));
  }
  if (!fileIsPdf && preset?.format === 'xls' && format !== 'xls') {
    throw new StatementParseError(`preset ${preset.id} expects an Excel file`);
  }
  if (!fileIsPdf && preset?.format === 'csv' && format !== 'csv') {
    throw new StatementParseError(`preset ${preset.id} expects a CSV file`);
  }
  if (!fileIsPdf && preset?.format === 'ofx' && format !== 'ofx' && format !== 'qfx') {
    throw new StatementParseError(`preset ${preset.id} expects an OFX or QFX file`);
  }
  if (preset?.format === 'pdf' && format !== 'pdf') {
    throw new StatementParseError(`preset ${preset.id} expects a PDF file`);
  }

  if (format === 'pdf') {
    if (!input.bytes && !(input.text && input.text.startsWith('%PDF'))) {
      throw new StatementParseError('PDF file bytes are required');
    }
    const bytes = input.bytes ?? new TextEncoder().encode(input.text ?? '');
    const parsed = await parsePdfStatement(bytes, pdfLayoutsForTemplate(preset?.id));
    return {
      format: 'pdf',
      encodingNote: null,
      statements: [parsed.statement],
      warnings: [],
      detectedPresetId: input.presetId ? null : parsed.detectedPresetId,
    };
  }

  if (format === 'xls' || preset?.format === 'xls') {
    const layout = input.xlsLayout ?? (preset?.format === 'xls' ? preset.layout : null);
    if (!input.bytes) throw new StatementParseError('Excel file bytes are required');
    const statement = await parseXls(input.bytes, layout);
    return { format: 'xls', encodingNote: null, statements: [statement], warnings: [] };
  }

  const text = input.text ?? (input.bytes ? decodeStatementBytes(input.bytes, encoding) : '');
  if (!text.trim()) throw new StatementParseError('file is empty');
  if (format === 'ofx' || format === 'qfx') {
    return {
      format: format === 'qfx' ? 'qfx' : 'ofx',
      encodingNote: encoding,
      statements: parseOfx(text),
      warnings: [],
    };
  }
  if (format === 'camt053') {
    return {
      format: 'camt053',
      encodingNote: encoding,
      statements: parseCamt053(text),
      warnings: [],
    };
  }
  const csv = csvPresetOrMapping(preset?.format === 'csv' ? preset : null, input.mapping ?? null, input.options ?? null);
  return {
    format: 'csv',
    encodingNote: csv.options.encoding,
    statements: [parseCsvStatement(text, csv.mapping, csv.options)],
    warnings: [],
  };
}

export function isXlsPreset(preset: CsvPreset | XlsPreset): preset is XlsPreset {
  return preset.format === 'xls';
}
