// One JSON file per known bank. Register the file here. Adding a bank is that
// file plus this import. test/statement-template-files.test.mjs fails when a
// bank JSON file in templates/ is not imported.
import usBofa from './templates/us-bofa.json';
import usBofaPdf from './templates/us-bofa-pdf.json';
import rsBps from './templates/rs-bps.json';
import rsBpsPdf from './templates/rs-bps-pdf.json';
import { pdfLayoutsForTemplate, type PdfLayoutId } from './pdf-preset';
import {
  validateStatementTemplate,
  type StatementTemplate,
  type XlsTemplateLayout,
} from './template-schema';
import type {
  CsvColumnMapping,
  CsvParseOptions,
  XlsHeaderAliases,
  XlsLayout,
} from './types';

export interface CsvPreset {
  id: string;
  label: string;
  format: 'csv';
  mapping: CsvColumnMapping;
  options: CsvParseOptions;
}

export interface XlsPreset {
  id: string;
  label: string;
  format: 'xls';
  layout: XlsLayout;
}

export interface OfxPreset {
  id: string;
  label: string;
  format: 'ofx';
}

export interface PdfPreset {
  id: string;
  label: string;
  format: 'pdf';
  /** Null accepts every known text-layer layout. A bank id accepts only that bank. */
  layouts: readonly PdfLayoutId[] | null;
}

export type StatementPreset = CsvPreset | XlsPreset | OfxPreset | PdfPreset;

const BUILTIN_SOURCES = [usBofa, usBofaPdf, rsBps, rsBpsPdf];

function loadBuiltin(raw: unknown): StatementTemplate {
  const result = validateStatementTemplate(raw);
  if (!result.ok) {
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : 'unknown';
    throw new Error(`Built-in statement template ${id} is invalid`);
  }
  return result.value;
}

export const BUILTIN_TEMPLATES: readonly StatementTemplate[] = BUILTIN_SOURCES.map(loadBuiltin);

const HEADER_ROLES = ['valueDate', 'transactionDate', 'currency', 'credit', 'debit', 'description'] as const;

export function isBuiltinTemplateId(id: string): boolean {
  return BUILTIN_TEMPLATES.some((template) => template.id === id);
}

export function builtinTemplateById(id: string): StatementTemplate | null {
  return BUILTIN_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function builtinXlsHeaderAliases(): XlsHeaderAliases {
  const merged: Record<(typeof HEADER_ROLES)[number], string[]> = {
    valueDate: [],
    transactionDate: [],
    currency: [],
    credit: [],
    debit: [],
    description: [],
  };
  for (const template of BUILTIN_TEMPLATES) {
    if (template.format !== 'xls' || !template.xls) continue;
    for (const role of HEADER_ROLES) {
      for (const alias of template.xls.headerAliases[role]) {
        if (!merged[role].includes(alias)) merged[role].push(alias);
      }
    }
  }
  return merged;
}

export function builtinAccountAliases(): readonly string[] {
  const aliases: string[] = [];
  for (const template of BUILTIN_TEMPLATES) {
    for (const alias of template.xls?.accountAliases ?? []) {
      if (!aliases.includes(alias)) aliases.push(alias);
    }
  }
  return aliases;
}

function csvOptions(layout: NonNullable<StatementTemplate['csv']>): CsvParseOptions {
  const options: CsvParseOptions = {
    delimiter: layout.options.delimiter,
    decimalSeparator: layout.options.decimalSeparator,
    dateFormat: layout.options.dateFormat,
    encoding: layout.options.encoding,
    hasHeader: layout.options.hasHeader,
  };
  if (layout.options.defaultCurrency) options.defaultCurrency = layout.options.defaultCurrency;
  if (layout.options.skipEmptyAmount) options.skipEmptyAmount = true;
  if (layout.options.checkRunningBalance) options.checkRunningBalance = true;
  if (layout.options.headerSearch === false) options.headerSearch = false;
  if (layout.options.skipRows) options.skipRows = layout.options.skipRows;
  if (layout.options.descriptionFlags && layout.options.descriptionFlags.length > 0) {
    options.descriptionFlags = layout.options.descriptionFlags;
  }
  return options;
}

function xlsLayout(layout: XlsTemplateLayout): XlsLayout {
  return {
    sheetName: layout.sheetName ?? null,
    columns: layout.columns,
    dateFormat: layout.dateFormat,
    decimalSeparator: layout.decimalSeparator,
    accountLabel: layout.accountLabel ?? null,
    descriptionFlags: layout.descriptionFlags ?? [],
    headerAliases: layout.headerAliases,
    headerVariants: layout.headerVariants,
    accountAliases: layout.accountAliases,
  };
}

/** A stored template the parser can run. PDF presets select a known text-layer layout. */
export function templateAsPreset(template: StatementTemplate): StatementPreset | null {
  if (template.format === 'csv' && template.csv) {
    return {
      id: template.id,
      label: template.label,
      format: 'csv',
      mapping: template.csv.mapping,
      options: csvOptions(template.csv),
    };
  }
  if (template.format === 'xls' && template.xls) {
    return {
      id: template.id,
      label: template.label,
      format: 'xls',
      layout: xlsLayout(template.xls),
    };
  }
  if (template.format === 'ofx') {
    return { id: template.id, label: template.label, format: 'ofx' };
  }
  if (template.format === 'pdf' && template.pdf?.textLayer) {
    return {
      id: template.id,
      label: template.label,
      format: 'pdf',
      layouts: pdfLayoutsForTemplate(template.id),
    };
  }
  return null;
}

export function builtinPresets(): StatementPreset[] {
  return BUILTIN_TEMPLATES.map((template) => {
    const preset = templateAsPreset(template);
    if (!preset) throw new Error(`Built-in statement template ${template.id} cannot be used as a preset`);
    return preset;
  });
}
