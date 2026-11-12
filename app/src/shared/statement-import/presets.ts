import { builtinPresets, type StatementPreset } from './templates';

export type { CsvPreset, OfxPreset, PdfPreset, StatementPreset, XlsPreset } from './templates';

/**
 * Built-in bank presets are the JSON files under templates/.
 * Parsers do not branch on a bank id.
 */
export const STATEMENT_PRESETS: readonly StatementPreset[] = builtinPresets();

export function presetById(id: string): StatementPreset | null {
  return STATEMENT_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function presetJson(
  preset: StatementPreset,
  source: 'builtin' | 'user' = 'builtin',
): Record<string, unknown> {
  const body = preset.format === 'csv'
    ? {
      id: preset.id,
      label: preset.label,
      format: preset.format,
      mapping: preset.mapping,
      options: preset.options,
    }
    : preset.format === 'xls'
      ? {
        id: preset.id,
        label: preset.label,
        format: preset.format,
        layout: preset.layout,
      }
      : {
        id: preset.id,
        label: preset.label,
        format: preset.format,
      };
  return { ...body, source };
}
