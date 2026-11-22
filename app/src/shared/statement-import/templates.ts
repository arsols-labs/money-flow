import type { StatementTemplate, XlsTemplateLayout } from './template-schema';
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
  /** Layout IDs accepted for this template (null accepts any configured D1 pdf_layout). */
  layouts: readonly string[] | null;
}

export type StatementPreset = CsvPreset | XlsPreset | OfxPreset | PdfPreset;

/** Shipped built-in statement templates are intentionally empty: all templates live in D1 rules. */
export const BUILTIN_TEMPLATES: readonly StatementTemplate[] = [];

const HEADER_ROLES = ['valueDate', 'transactionDate', 'currency', 'credit', 'debit', 'description'] as const;

export function isBuiltinTemplateId(_id: string): boolean {
  return false;
}

export function builtinTemplateById(_id: string): StatementTemplate | null {
  return null;
}

export function mergeXlsHeaderAliases(templates: readonly StatementTemplate[]): XlsHeaderAliases {
  const merged: Record<(typeof HEADER_ROLES)[number], string[]> = {
    valueDate: [],
    transactionDate: [],
    currency: [],
    credit: [],
    debit: [],
    description: [],
  };
  for (const template of templates) {
    if (template.format !== 'xls' || !template.xls) continue;
    for (const role of HEADER_ROLES) {
      for (const alias of template.xls.headerAliases[role] ?? []) {
        if (!merged[role].includes(alias)) merged[role].push(alias);
      }
    }
  }
  return merged;
}

export function mergeAccountAliases(templates: readonly StatementTemplate[]): string[] {
  const aliases: string[] = [];
  for (const template of templates) {
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

/** Converts a D1-stored statement template into a runnable parser preset. */
export function templateAsPreset(
  template: StatementTemplate,
  pdfLayoutIds: readonly string[] | null = null,
): StatementPreset | null {
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
      layouts: pdfLayoutIds,
    };
  }
  return null;
}

export function presetsFromTemplates(
  templates: readonly StatementTemplate[],
  pdfLayoutsByTemplate?: ReadonlyMap<string, readonly string[]>,
): StatementPreset[] {
  const result: StatementPreset[] = [];
  for (const template of templates) {
    const preset = templateAsPreset(template, pdfLayoutsByTemplate?.get(template.id) ?? null);
    if (preset) result.push(preset);
  }
  return result;
}
