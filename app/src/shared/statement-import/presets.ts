import type { StatementPreset } from './templates';

export type { CsvPreset, OfxPreset, PdfPreset, StatementPreset, XlsPreset } from './templates';

export function presetJson(
  preset: StatementPreset,
  source: 'd1' | 'user' = 'user',
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
