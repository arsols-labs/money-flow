import { CURRENCY_TABLES } from './currency-tables';
import { ValidationError } from './api-error';
import { loadCronScheduleConfig } from './cron-schedule';
import { isDemoMode, DEMO_SESSION_TTL_SECONDS } from './demo-flag';
import { divideRoundHalfEven } from './forecast/fx';
import { loadCurrencyCatalog } from './rules-store';
import { formatCronHour, formatUtcEquivalentForHour } from '../shared/cron-schedule';

export const FX_AUTO_UPDATE_SETTING_KEY = 'fx_auto_update';
export const FX_PROVIDER_ID = 'exchangerate-api';
export const FX_PROVIDER_NAME = 'ExchangeRate-API';
export const FX_PROVIDER_ATTRIBUTION_URL = 'https://www.exchangerate-api.com';
export const FX_PROVIDER_ENDPOINT_BASE = 'https://open.er-api.com/v6/latest';
export const FX_CRON_SCHEDULE_UTC = '02:00';
export const FX_REFRESH_COOLDOWN_SECONDS = 60;
export const FX_FETCH_TIMEOUT_MS = 10_000;

const FX_META_KV_KEY = 'fx_refresh:meta';
const FX_COOLDOWN_KV_KEY = 'fx_refresh:cooldown';
const MAX_RATE_E9 = BigInt(Number.MAX_SAFE_INTEGER);
const POSITIVE_DECIMAL_OR_SCI_RE = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

export type FxRefreshTrigger = 'cron' | 'manual';
export type FxRefreshStatus = 'ok' | 'partial' | 'error';

export interface FxRefreshMeta {
  last_run_at: string | null;
  last_status: FxRefreshStatus | null;
  last_error: string | null;
  last_trigger: FxRefreshTrigger | null;
  provider_updated_at?: string | null;
}

export interface FxAutoUpdateState extends FxRefreshMeta {
  enabled: boolean;
  provider: string;
  provider_name: string;
  provider_url: string;
  schedule_utc: string;
  schedule_hour: number;
  schedule_timezone: string;
  schedule_time: string;
}

export interface FxRefreshUpdatedItem {
  code: string;
  rate_e9: number;
  rate: string;
  updated_at: string;
}

export interface FxRefreshSkippedItem {
  code: string;
  reason: 'provider_unsupported' | 'invalid_rate';
}

export interface FxRefreshResult {
  anchor_currency: string;
  provider: string;
  provider_name: string;
  provider_url: string;
  provider_updated_at: string | null;
  trigger: FxRefreshTrigger;
  updated: FxRefreshUpdatedItem[];
  skipped: FxRefreshSkippedItem[];
  updated_at: string;
}

export interface FxCatalogAndTargets {
  fxAnchorCode: string;
  targetCodes: string[];
}

export interface RefreshFxRatesOptions {
  kv?: KVNamespace;
  demoScopeKey?: string | null;
  trigger?: FxRefreshTrigger;
  fetcher?: typeof fetch;
  now?: () => Date;
  preloaded?: FxCatalogAndTargets;
}

export interface HandleScheduledFxRefreshOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
}

export type ScheduledFxRefreshOutcome =
  | { ran: false; reason: 'demo_mode' | 'disabled' | 'before_scheduled_hour' | 'already_ran_today' }
  | { ran: true; ok: true; updated: number; skipped: number }
  | { ran: true; ok: false; error: string };

function nowIsoSecond(now: () => Date = () => new Date()): string {
  return now().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Formats integer `rate_e9` back into a human decimal string without floats. */
export function formatRateE9(rateE9: number): string {
  const digits = BigInt(rateE9).toString().padStart(10, '0');
  const intPart = digits.slice(0, -9);
  const fracPart = digits.slice(-9).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function metaKvKey(demoScopeKey?: string | null): string {
  return demoScopeKey ? `fx_refresh:demo:${demoScopeKey}:meta` : FX_META_KV_KEY;
}

function cooldownKvKey(demoScopeKey?: string | null): string {
  return demoScopeKey ? `fx_refresh:demo:${demoScopeKey}:cooldown` : FX_COOLDOWN_KV_KEY;
}

/**
 * Inverts a provider quote given as `foreign_units_per_1_anchor` into Money Flow's
 * stored integer `rate_e9 = roundHalfEven(10^9 / providerRate)`.
 * Uses exact decimal/BigInt arithmetic only — no floating-point division.
 */
export function invertProviderRateToE9(providerRate: unknown): bigint | null {
  let raw: string;
  if (typeof providerRate === 'number') {
    if (!Number.isFinite(providerRate) || providerRate <= 0) return null;
    raw = String(providerRate);
  } else if (typeof providerRate === 'string') {
    raw = providerRate.trim();
    if (!raw) return null;
  } else {
    return null;
  }

  const match = POSITIVE_DECIMAL_OR_SCI_RE.exec(raw);
  if (!match) return null;

  const intPart = match[1] ?? '';
  const fracPart = match[2] ?? match[3] ?? '';
  const expPart = match[4] ? Number(match[4]) : 0;
  if (!Number.isSafeInteger(expPart) || Math.abs(expPart) > 60) return null;

  const combinedDigits = intPart + fracPart;
  const withoutLeadingZeros = combinedDigits.replace(/^0+/, '');
  if (!withoutLeadingZeros) return null;

  const trailingZeroMatch = withoutLeadingZeros.match(/0+$/);
  const trailingZeros = trailingZeroMatch ? trailingZeroMatch[0].length : 0;
  const sigDigits = trailingZeros > 0
    ? withoutLeadingZeros.slice(0, withoutLeadingZeros.length - trailingZeros)
    : withoutLeadingZeros;
  if (sigDigits.length > 60) return null;

  const netExp = expPart - fracPart.length + trailingZeros;
  const shiftFromNine = 9 - netExp;
  if (Math.abs(shiftFromNine) > 80) return null;

  const divisorBase = BigInt(sigDigits);
  let dividend: bigint;
  let divisor: bigint;
  if (shiftFromNine >= 0) {
    dividend = 10n ** BigInt(shiftFromNine);
    divisor = divisorBase;
  } else {
    dividend = 1n;
    divisor = divisorBase * (10n ** BigInt(-shiftFromNine));
  }

  const rateE9 = divideRoundHalfEven(dividend, divisor);
  if (rateE9 <= 0n || rateE9 > MAX_RATE_E9) return null;
  return rateE9;
}

export async function isFxAutoUpdateEnabled(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(FX_AUTO_UPDATE_SETTING_KEY)
    .first<{ value: string | null }>();
  return row?.value === '1';
}

export function parseBooleanSettingFlag(input: unknown): '1' | '0' | null {
  if (input === true || input === 1) return '1';
  if (input === false || input === 0) return '0';
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return '1';
    if (normalized === '0' || normalized === 'false') return '0';
  }
  return null;
}

export async function readFxRefreshMeta(
  kv?: KVNamespace,
  demoScopeKey?: string | null,
): Promise<FxRefreshMeta> {
  const empty: FxRefreshMeta = { last_run_at: null, last_status: null, last_error: null, last_trigger: null };
  if (!kv || typeof kv.get !== 'function') return empty;
  try {
    const raw = await kv.get<Partial<FxRefreshMeta>>(metaKvKey(demoScopeKey), 'json');
    if (!raw || typeof raw !== 'object') return empty;
    return {
      last_run_at: typeof raw.last_run_at === 'string' ? raw.last_run_at : null,
      last_status:
        raw.last_status === 'ok' || raw.last_status === 'partial' || raw.last_status === 'error'
          ? raw.last_status
          : null,
      last_error: typeof raw.last_error === 'string' ? raw.last_error : null,
      last_trigger: raw.last_trigger === 'cron' || raw.last_trigger === 'manual' ? raw.last_trigger : null,
      ...(typeof raw.provider_updated_at === 'string' || raw.provider_updated_at === null
        ? { provider_updated_at: raw.provider_updated_at }
        : {}),
    };
  } catch {
    return empty;
  }
}

async function writeFxRefreshMeta(
  kv: KVNamespace | undefined,
  meta: FxRefreshMeta,
  demoScopeKey?: string | null,
): Promise<void> {
  if (!kv || typeof kv.put !== 'function') return;
  try {
    const options = demoScopeKey ? { expirationTtl: DEMO_SESSION_TTL_SECONDS } : undefined;
    await kv.put(metaKvKey(demoScopeKey), JSON.stringify(meta), options);
  } catch {
    // Metadata persistence is best-effort and must not fail the refresh operation.
  }
}

export async function buildFxAutoUpdateState(
  db: D1Database,
  kv?: KVNamespace,
  demoScopeKey?: string | null,
): Promise<FxAutoUpdateState> {
  const [schedule, meta] = await Promise.all([
    loadCronScheduleConfig(db),
    readFxRefreshMeta(kv, demoScopeKey),
  ]);
  return {
    enabled: schedule.fxAutoUpdateEnabled,
    provider: FX_PROVIDER_ID,
    provider_name: FX_PROVIDER_NAME,
    provider_url: FX_PROVIDER_ATTRIBUTION_URL,
    schedule_utc: formatUtcEquivalentForHour(schedule.timezone, schedule.fxAutoUpdateHour),
    schedule_hour: schedule.fxAutoUpdateHour,
    schedule_timezone: schedule.timezone,
    schedule_time: formatCronHour(schedule.fxAutoUpdateHour),
    last_run_at: meta.last_run_at,
    last_status: meta.last_status,
    last_error: meta.last_error,
    last_trigger: meta.last_trigger,
    ...(meta.provider_updated_at !== undefined ? { provider_updated_at: meta.provider_updated_at } : {}),
  };
}

export async function enforceFxRefreshCooldown(
  kv: KVNamespace | undefined,
  demoScopeKey?: string | null,
  nowMs: number = Date.now(),
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return { allowed: true };
  }
  const key = cooldownKvKey(demoScopeKey);
  const existing = await kv.get<{ expires_at_ms?: number }>(key, 'json').catch(() => null);
  const expiresAtMs = typeof existing?.expires_at_ms === 'number' ? existing.expires_at_ms : 0;
  if (expiresAtMs > nowMs) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000)),
    };
  }
  const nextExpiresAtMs = nowMs + FX_REFRESH_COOLDOWN_SECONDS * 1000;
  await kv
    .put(
      key,
      JSON.stringify({ expires_at_ms: nextExpiresAtMs }),
      { expirationTtl: FX_REFRESH_COOLDOWN_SECONDS },
    )
    .catch(() => {});
  return { allowed: true };
}

async function listTargetFxCodes(
  db: D1Database,
  anchorCode: string,
  configuredCodes: ReadonlyMap<string, unknown>,
): Promise<string[]> {
  const inUseSql = CURRENCY_TABLES.map((table) => `SELECT currency AS code FROM ${table}`).join(' UNION ');
  const [{ results: inUseRows }, { results: existingRows }] = await Promise.all([
    db.prepare(inUseSql).all<{ code: string }>(),
    db.prepare('SELECT code FROM fx_rates').all<{ code: string }>(),
  ]);
  const merged = new Set<string>();
  for (const row of [...inUseRows, ...existingRows]) {
    if (typeof row.code !== 'string') continue;
    const upper = row.code.toUpperCase();
    if (upper !== anchorCode && configuredCodes.has(upper)) {
      merged.add(upper);
    }
  }
  return [...merged].sort();
}

export async function requireFxCatalogAndTargets(db: D1Database): Promise<FxCatalogAndTargets> {
  const currencyCatalog = await loadCurrencyCatalog(db);
  if (currencyCatalog.entries.size === 0 || !currencyCatalog.fxAnchorCode) {
    throw new ValidationError(
      'MISSING_CONFIGURATION',
      {
        domain: 'currency_standards',
        detail: 'Currency standards and an FX anchor must be configured in D1 before refreshing FX rates',
      },
      422,
    );
  }
  const targetCodes = await listTargetFxCodes(db, currencyCatalog.fxAnchorCode, currencyCatalog.entries);
  return { fxAnchorCode: currencyCatalog.fxAnchorCode, targetCodes };
}

function summarizeSkippedReasons(skipped: readonly FxRefreshSkippedItem[]): string {
  const unsupported = skipped.filter((s) => s.reason === 'provider_unsupported').map((s) => s.code);
  const invalid = skipped.filter((s) => s.reason === 'invalid_rate').map((s) => s.code);
  const parts: string[] = [];
  if (unsupported.length > 0) parts.push(`Skipped unsupported currencies: ${unsupported.join(', ')}`);
  if (invalid.length > 0) parts.push(`Skipped invalid provider rates: ${invalid.join(', ')}`);
  return parts.join('; ');
}

export async function refreshFxRatesFromProvider(
  db: D1Database,
  options: RefreshFxRatesOptions = {},
): Promise<FxRefreshResult> {
  const trigger: FxRefreshTrigger = options.trigger ?? 'manual';
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetcher ?? fetch;
  const runAt = nowIsoSecond(now);

  const { fxAnchorCode, targetCodes } = options.preloaded ?? await requireFxCatalogAndTargets(db);

  if (targetCodes.length === 0) {
    await writeFxRefreshMeta(
      options.kv,
      {
        last_run_at: runAt,
        last_status: 'ok',
        last_error: null,
        last_trigger: trigger,
        provider_updated_at: null,
      },
      options.demoScopeKey,
    );
    return {
      anchor_currency: fxAnchorCode,
      provider: FX_PROVIDER_ID,
      provider_name: FX_PROVIDER_NAME,
      provider_url: FX_PROVIDER_ATTRIBUTION_URL,
      provider_updated_at: null,
      trigger,
      updated: [],
      skipped: [],
      updated_at: runAt,
    };
  }

  let payload: Record<string, unknown> | null = null;
  let fetchErrorMessage = 'Provider request failed';
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(FX_FETCH_TIMEOUT_MS)
        : undefined;
    const response = await fetcher(`${FX_PROVIDER_ENDPOINT_BASE}/${encodeURIComponent(fxAnchorCode)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      fetchErrorMessage = `HTTP ${response.status}`;
    } else {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        fetchErrorMessage = 'Invalid JSON payload';
      }
    }
  } catch (error) {
    fetchErrorMessage = error instanceof Error ? error.message : String(error);
  }

  if (payload && payload.result === 'error' && payload['error-type'] === 'unsupported-code') {
    const detail = `Unsupported FX anchor code: ${fxAnchorCode}`;
    await writeFxRefreshMeta(
      options.kv,
      {
        last_run_at: runAt,
        last_status: 'error',
        last_error: detail,
        last_trigger: trigger,
      },
      options.demoScopeKey,
    );
    throw new ValidationError('FX_PROVIDER_UNSUPPORTED_ANCHOR', { currency: fxAnchorCode }, 422);
  }

  const rawRates =
    payload &&
    payload.result === 'success' &&
    String(payload.base_code ?? '').toUpperCase() === fxAnchorCode &&
    payload.rates &&
    typeof payload.rates === 'object' &&
    !Array.isArray(payload.rates)
      ? (payload.rates as Record<string, unknown>)
      : null;

  if (!rawRates) {
    const reason =
      payload && payload.result === 'error' && typeof payload['error-type'] === 'string'
        ? `Provider error: ${payload['error-type']}`
        : fetchErrorMessage;
    await writeFxRefreshMeta(
      options.kv,
      {
        last_run_at: runAt,
        last_status: 'error',
        last_error: reason,
        last_trigger: trigger,
      },
      options.demoScopeKey,
    );
    throw new ValidationError('FX_PROVIDER_UNAVAILABLE', undefined, 502);
  }

  const providerUpdatedAt =
    typeof payload?.time_last_update_utc === 'string' ? payload.time_last_update_utc : null;

  const updated: FxRefreshUpdatedItem[] = [];
  const skipped: FxRefreshSkippedItem[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const code of targetCodes) {
    if (!Object.prototype.hasOwnProperty.call(rawRates, code)) {
      skipped.push({ code, reason: 'provider_unsupported' });
      continue;
    }
    const rateE9Big = invertProviderRateToE9(rawRates[code]);
    if (rateE9Big === null) {
      skipped.push({ code, reason: 'invalid_rate' });
      continue;
    }
    const rateE9 = Number(rateE9Big);
    statements.push(
      db
        .prepare(
          `INSERT INTO fx_rates (code, rate_e9, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET rate_e9 = excluded.rate_e9, updated_at = excluded.updated_at`,
        )
        .bind(code, rateE9Big.toString(), runAt),
    );
    updated.push({
      code,
      rate_e9: rateE9,
      rate: formatRateE9(rateE9),
      updated_at: runAt,
    });
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  await writeFxRefreshMeta(
    options.kv,
    {
      last_run_at: runAt,
      last_status: skipped.length > 0 ? 'partial' : 'ok',
      last_error: skipped.length > 0 ? summarizeSkippedReasons(skipped) : null,
      last_trigger: trigger,
      provider_updated_at: providerUpdatedAt,
    },
    options.demoScopeKey,
  );

  return {
    anchor_currency: fxAnchorCode,
    provider: FX_PROVIDER_ID,
    provider_name: FX_PROVIDER_NAME,
    provider_url: FX_PROVIDER_ATTRIBUTION_URL,
    provider_updated_at: providerUpdatedAt,
    trigger,
    updated,
    skipped,
    updated_at: runAt,
  };
}

export async function handleScheduledFxRefresh(
  env: { DB: D1Database; KV?: KVNamespace; DEMO_MODE?: string },
  options: HandleScheduledFxRefreshOptions = {},
): Promise<ScheduledFxRefreshOutcome> {
  if (isDemoMode(env)) {
    return { ran: false, reason: 'demo_mode' };
  }

  try {
    const enabled = await isFxAutoUpdateEnabled(env.DB);
    if (!enabled) {
      return { ran: false, reason: 'disabled' };
    }
    const result = await refreshFxRatesFromProvider(env.DB, {
      kv: env.KV,
      trigger: 'cron',
      fetcher: options.fetcher,
      now: options.now,
    });
    console.log(
      JSON.stringify({
        event: 'fx.cron.refreshed',
        anchor: result.anchor_currency,
        updated: result.updated.length,
        skipped: result.skipped.length,
        updated_at: result.updated_at,
      }),
    );
    return { ran: true, ok: true, updated: result.updated.length, skipped: result.skipped.length };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: 'fx.cron.failed',
        error: detail,
      }),
    );
    return { ran: true, ok: false, error: detail };
  }
}
