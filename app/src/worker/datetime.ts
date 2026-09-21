/**
 * Нормализует штамп из D1 (`datetime('now')` без пояса) в ISO-8601 UTC с `Z`.
 * Хранение не меняем: смесь форматов ломает лексический ORDER BY.
 */
export function toIsoUtc(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(trimmed)) {
    return trimmed;
  }

  const sqliteUtc = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(trimmed);
  if (sqliteUtc) {
    return `${sqliteUtc[1]}T${sqliteUtc[2]}Z`;
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return trimmed;
}
