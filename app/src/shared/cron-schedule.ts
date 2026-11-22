/**
 * Shared cron schedule & timezone contract for Worker dispatcher, REST API, MCP, and UI.
 * Single source of truth for validation, normalization, defaults, and timezone math.
 */

export const CRON_TIMEZONE_SETTING_KEY = 'cron_timezone';
export const FX_AUTO_UPDATE_HOUR_SETTING_KEY = 'fx_auto_update_hour';
export const RECURRING_AUTO_SKIP_HOUR_SETTING_KEY = 'recurring_auto_skip_hour';
export const CRON_LAST_RUN_LOCAL_DATE_PREFIX = 'cron_last_run_local_date:';

export const CRON_JOB_FX_REFRESH = 'fx_refresh';
export const CRON_JOB_RECURRING_AUTO_SKIP = 'recurring_auto_skip';

export const CRON_LAST_RUN_FX_KEY = `${CRON_LAST_RUN_LOCAL_DATE_PREFIX}${CRON_JOB_FX_REFRESH}`;
export const CRON_LAST_RUN_RECURRING_KEY = `${CRON_LAST_RUN_LOCAL_DATE_PREFIX}${CRON_JOB_RECURRING_AUTO_SKIP}`;

export const CRON_DEFAULT_TIMEZONE = 'UTC';
export const CRON_DEFAULT_HOUR = 2;
export const CRON_HOUR_MIN = 0;
export const CRON_HOUR_MAX = 23;

export const CRON_SCHEDULE_SETTING_KEYS = [
  CRON_TIMEZONE_SETTING_KEY,
  FX_AUTO_UPDATE_HOUR_SETTING_KEY,
  RECURRING_AUTO_SKIP_HOUR_SETTING_KEY,
] as const;

export function isReservedCronSettingKey(key: string): boolean {
  return key.startsWith(CRON_LAST_RUN_LOCAL_DATE_PREFIX);
}

let cachedZones: string[] | null = null;
let cachedZoneMap: Map<string, string> | null = null;

function ensureZoneCatalog(): { list: string[]; map: Map<string, string> } {
  if (cachedZones && cachedZoneMap) {
    return { list: cachedZones, map: cachedZoneMap };
  }
  const intlZones =
    typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone').filter(
          (z) => z !== CRON_DEFAULT_TIMEZONE && !/^etc\/gmt/i.test(z),
        )
      : [];
  const list = [CRON_DEFAULT_TIMEZONE, ...intlZones];
  const map = new Map<string, string>();
  for (const zone of list) {
    map.set(zone.toLowerCase(), zone);
  }
  cachedZones = list;
  cachedZoneMap = map;
  return { list, map };
}

/**
 * Returns the supported IANA timezone catalog with `'UTC'` first.
 * Note: V8 `Intl.supportedValuesOf('timeZone')` omits `'UTC'`, so it is prepended explicitly.
 */
export function listSupportedCronTimezones(): string[] {
  return [...ensureZoneCatalog().list];
}

/**
 * Validates and canonicalizes an IANA timezone string.
 * Accepts `'UTC'` / `'Etc/UTC'`, canonical IANA names (case-insensitively),
 * and slash-delimited IANA links (excluding `Etc/GMT*` POSIX-sign zones).
 * Rejects abbreviations (`CET`, `EST`, `PST`, `GMT`), numeric offsets (`+02:00`),
 * overly long strings, and invalid zones.
 */
export function normalizeCronTimezone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 64 || /\s/.test(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  if (lower === 'utc' || lower === 'etc/utc') {
    return CRON_DEFAULT_TIMEZONE;
  }

  if (/^etc\/gmt/i.test(trimmed)) {
    return null;
  }

  const { map } = ensureZoneCatalog();
  const direct = map.get(lower);
  if (direct) return direct;

  if (!trimmed.includes('/')) {
    return null;
  }

  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
    if (!resolved) return null;
    if (resolved === CRON_DEFAULT_TIMEZONE || resolved.toLowerCase() === 'etc/utc') {
      return CRON_DEFAULT_TIMEZONE;
    }
    return map.get(resolved.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalizes a local execution hour (`0..23`) from integer number or decimal digit string.
 */
export function normalizeCronHour(input: unknown): number | null {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < CRON_HOUR_MIN || input > CRON_HOUR_MAX) {
      return null;
    }
    return input;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!/^\d{1,2}$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < CRON_HOUR_MIN || parsed > CRON_HOUR_MAX) {
      return null;
    }
    return parsed;
  }
  return null;
}

export function formatCronHour(hour: number): string {
  const normalized = normalizeCronHour(hour) ?? CRON_DEFAULT_HOUR;
  return `${String(normalized).padStart(2, '0')}:00`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getCalendarFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function extractCalendarParts(now: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = getCalendarFormatter(timeZone).formatToParts(now);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { year, month, day, hour, minute };
}

/**
 * Resolves the local calendar date (`YYYY-MM-DD`) and local hour (`0..23`) for `now` in `timeZone`.
 */
export function resolveLocalDateAndHour(
  now: Date,
  timeZone: string,
): { localDate: string; localHour: number } {
  const canonicalZone = normalizeCronTimezone(timeZone) ?? CRON_DEFAULT_TIMEZONE;
  const { year, month, day, hour } = extractCalendarParts(now, canonicalZone);
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return {
    localDate: `${yyyy}-${mm}-${dd}`,
    localHour: hour,
  };
}

/**
 * Computes the current UTC `HH:MM` equivalent for a configured local hour in `timeZone` at `now`.
 */
export function formatUtcEquivalentForHour(
  timeZone: string,
  hour: number,
  now: Date = new Date(),
): string {
  const normalizedHour = normalizeCronHour(hour) ?? CRON_DEFAULT_HOUR;
  const canonicalZone = normalizeCronTimezone(timeZone) ?? CRON_DEFAULT_TIMEZONE;
  if (canonicalZone === CRON_DEFAULT_TIMEZONE) {
    return formatCronHour(normalizedHour);
  }
  const local = extractCalendarParts(now, canonicalZone);
  const localAsUtcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const realUtcMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
  );
  const offsetMinutes = Math.round((localAsUtcMs - realUtcMs) / 60_000);
  const totalUtcMinutes = (((normalizedHour * 60 - offsetMinutes) % 1440) + 1440) % 1440;
  const utcHour = Math.floor(totalUtcMinutes / 60);
  const utcMinute = totalUtcMinutes % 60;
  return `${String(utcHour).padStart(2, '0')}:${String(utcMinute).padStart(2, '0')}`;
}
