import { ValidationError } from './api-error';
import { isDemoMode } from './demo-flag';
import { isIsoDateString } from './forecast/dates';
import {
  FX_AUTO_UPDATE_SETTING_KEY,
  handleScheduledFxRefresh,
  type ScheduledFxRefreshOutcome,
} from './fx-auto-update';
import {
  handleScheduledRecurringAutoSkip,
  type RecurringAutoSkipResult,
} from './recurring-auto-skip';
import type { Env } from './types';
import {
  CRON_DEFAULT_HOUR,
  CRON_DEFAULT_TIMEZONE,
  CRON_JOB_FX_REFRESH,
  CRON_JOB_RECURRING_AUTO_SKIP,
  CRON_LAST_RUN_FX_KEY,
  CRON_LAST_RUN_RECURRING_KEY,
  CRON_TIMEZONE_SETTING_KEY,
  FX_AUTO_UPDATE_HOUR_SETTING_KEY,
  RECURRING_AUTO_SKIP_HOUR_SETTING_KEY,
  formatCronHour,
  normalizeCronHour,
  normalizeCronTimezone,
  resolveLocalDateAndHour,
} from '../shared/cron-schedule';

export type CronJobName = typeof CRON_JOB_FX_REFRESH | typeof CRON_JOB_RECURRING_AUTO_SKIP;

export interface CronScheduleConfig {
  timezone: string;
  fxAutoUpdateHour: number;
  recurringAutoSkipHour: number;
  fxAutoUpdateEnabled: boolean;
  lastRunFxLocalDate: string | null;
  lastRunRecurringLocalDate: string | null;
}

export interface CronJobScheduleState {
  hour: number;
  time: string;
  last_run_local_date: string | null;
}

export interface CronScheduleState {
  timezone: string;
  fx_auto_update_hour: number;
  recurring_auto_skip_hour: number;
  fx_auto_update_enabled: boolean;
  demo_mode: boolean;
  jobs: {
    fx_refresh: CronJobScheduleState;
    recurring_auto_skip: CronJobScheduleState;
  };
}

export interface CronSchedulePatch {
  timezone?: string;
  fx_auto_update_hour?: number;
  recurring_auto_skip_hour?: number;
}

export interface ScheduledDispatchResult {
  demo_mode: boolean;
  timezone: string;
  local_date: string;
  local_hour: number;
  fx_refresh: ScheduledFxRefreshOutcome;
  recurring_auto_skip: RecurringAutoSkipResult;
}

const CRON_PATCH_ALLOWED_KEYS = new Set([
  'timezone',
  'fx_auto_update_hour',
  'recurring_auto_skip_hour',
]);

function lastRunSettingKey(job: CronJobName): string {
  return job === CRON_JOB_FX_REFRESH ? CRON_LAST_RUN_FX_KEY : CRON_LAST_RUN_RECURRING_KEY;
}

export async function loadCronScheduleConfig(db: D1Database): Promise<CronScheduleConfig> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)')
    .bind(
      CRON_TIMEZONE_SETTING_KEY,
      FX_AUTO_UPDATE_HOUR_SETTING_KEY,
      RECURRING_AUTO_SKIP_HOUR_SETTING_KEY,
      FX_AUTO_UPDATE_SETTING_KEY,
      CRON_LAST_RUN_FX_KEY,
      CRON_LAST_RUN_RECURRING_KEY,
    )
    .all<{ key: string; value: string }>();

  const values = new Map<string, string>();
  for (const row of results ?? []) {
    values.set(row.key, row.value);
  }

  const lastFx = values.get(CRON_LAST_RUN_FX_KEY) ?? null;
  const lastRecurring = values.get(CRON_LAST_RUN_RECURRING_KEY) ?? null;

  return {
    timezone: normalizeCronTimezone(values.get(CRON_TIMEZONE_SETTING_KEY)) ?? CRON_DEFAULT_TIMEZONE,
    fxAutoUpdateHour:
      normalizeCronHour(values.get(FX_AUTO_UPDATE_HOUR_SETTING_KEY)) ?? CRON_DEFAULT_HOUR,
    recurringAutoSkipHour:
      normalizeCronHour(values.get(RECURRING_AUTO_SKIP_HOUR_SETTING_KEY)) ?? CRON_DEFAULT_HOUR,
    fxAutoUpdateEnabled: values.get(FX_AUTO_UPDATE_SETTING_KEY) === '1',
    lastRunFxLocalDate: lastFx && isIsoDateString(lastFx) ? lastFx : null,
    lastRunRecurringLocalDate: lastRecurring && isIsoDateString(lastRecurring) ? lastRecurring : null,
  };
}

export async function readCronScheduleState(
  db: D1Database,
  demoMode: boolean,
): Promise<CronScheduleState> {
  const config = await loadCronScheduleConfig(db);
  return {
    timezone: config.timezone,
    fx_auto_update_hour: config.fxAutoUpdateHour,
    recurring_auto_skip_hour: config.recurringAutoSkipHour,
    fx_auto_update_enabled: config.fxAutoUpdateEnabled,
    demo_mode: demoMode,
    jobs: {
      fx_refresh: {
        hour: config.fxAutoUpdateHour,
        time: formatCronHour(config.fxAutoUpdateHour),
        last_run_local_date: config.lastRunFxLocalDate,
      },
      recurring_auto_skip: {
        hour: config.recurringAutoSkipHour,
        time: formatCronHour(config.recurringAutoSkipHour),
        last_run_local_date: config.lastRunRecurringLocalDate,
      },
    },
  };
}

export function validateCronSchedulePatch(body: unknown): CronSchedulePatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('REQUEST_BODY_INVALID');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CRON_PATCH_ALLOWED_KEYS.has(key)) {
      throw new ValidationError('REQUEST_BODY_INVALID');
    }
  }

  const patch: CronSchedulePatch = {};
  if ('timezone' in record && record.timezone !== undefined) {
    const timezone = normalizeCronTimezone(record.timezone);
    if (timezone === null) {
      throw new ValidationError('SETTING_TIMEZONE_INVALID');
    }
    patch.timezone = timezone;
  }
  if ('fx_auto_update_hour' in record && record.fx_auto_update_hour !== undefined) {
    const hour = normalizeCronHour(record.fx_auto_update_hour);
    if (hour === null) {
      throw new ValidationError('SETTING_HOUR_INVALID');
    }
    patch.fx_auto_update_hour = hour;
  }
  if ('recurring_auto_skip_hour' in record && record.recurring_auto_skip_hour !== undefined) {
    const hour = normalizeCronHour(record.recurring_auto_skip_hour);
    if (hour === null) {
      throw new ValidationError('SETTING_HOUR_INVALID');
    }
    patch.recurring_auto_skip_hour = hour;
  }

  if (
    patch.timezone === undefined &&
    patch.fx_auto_update_hour === undefined &&
    patch.recurring_auto_skip_hour === undefined
  ) {
    throw new ValidationError('NO_PATCH_FIELDS');
  }

  return patch;
}

export async function updateCronSchedule(
  db: D1Database,
  patch: CronSchedulePatch,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const upsertSql =
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

  if (patch.timezone !== undefined) {
    statements.push(db.prepare(upsertSql).bind(CRON_TIMEZONE_SETTING_KEY, patch.timezone));
  }
  if (patch.fx_auto_update_hour !== undefined) {
    statements.push(
      db.prepare(upsertSql).bind(FX_AUTO_UPDATE_HOUR_SETTING_KEY, String(patch.fx_auto_update_hour)),
    );
  }
  if (patch.recurring_auto_skip_hour !== undefined) {
    statements.push(
      db
        .prepare(upsertSql)
        .bind(RECURRING_AUTO_SKIP_HOUR_SETTING_KEY, String(patch.recurring_auto_skip_hour)),
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

/**
 * Atomically claims the daily execution slot for `job` on `localDate` (YYYY-MM-DD).
 * Uses SQLite conditional upsert so concurrent hourly ticks cannot double-execute.
 */
export async function claimDailyCronJob(
  db: D1Database,
  job: CronJobName,
  localDate: string,
): Promise<{ acquired: boolean; previousDate: string | null }> {
  if (!isIsoDateString(localDate)) {
    throw new RangeError(`claimDailyCronJob: invalid localDate ${JSON.stringify(localDate)}`);
  }
  const key = lastRunSettingKey(job);
  const existing = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string | null }>();
  const previousDate = existing?.value ?? null;

  const result = await db
    .prepare(
      `INSERT INTO settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE settings.value < excluded.value
          OR settings.value NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    )
    .bind(key, localDate)
    .run();

  return {
    acquired: Number(result.meta?.changes ?? 0) === 1,
    previousDate,
  };
}

/**
 * Rolls back a daily claim if the job failed so a subsequent hourly tick can retry,
 * using CAS on `settings.value = claimedDate` so newer days are never overwritten.
 */
export async function releaseDailyCronJob(
  db: D1Database,
  job: CronJobName,
  claimedDate: string,
  previousDate: string | null,
): Promise<void> {
  const key = lastRunSettingKey(job);
  if (previousDate && isIsoDateString(previousDate) && previousDate < claimedDate) {
    await db
      .prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
      .bind(previousDate, key, claimedDate)
      .run();
    return;
  }
  await db
    .prepare('DELETE FROM settings WHERE key = ? AND value = ?')
    .bind(key, claimedDate)
    .run();
}

async function safeReleaseDailyCronJob(
  db: D1Database,
  job: CronJobName,
  claimedDate: string,
  previousDate: string | null,
): Promise<void> {
  try {
    await releaseDailyCronJob(db, job, claimedDate, previousDate);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'cron.claim_release_failed', job, claimedDate, error: detail }));
  }
}

export async function dispatchScheduledJobs(
  env: Env,
  options: { now?: Date; fetcher?: typeof fetch } = {},
): Promise<ScheduledDispatchResult> {
  const now = options.now ?? new Date();
  if (isDemoMode(env)) {
    const utc = resolveLocalDateAndHour(now, CRON_DEFAULT_TIMEZONE);
    return {
      demo_mode: true,
      timezone: CRON_DEFAULT_TIMEZONE,
      local_date: utc.localDate,
      local_hour: utc.localHour,
      fx_refresh: { ran: false, reason: 'demo_mode' },
      recurring_auto_skip: {
        status: 'skipped_demo',
        today: utc.localDate,
        rulesChecked: 0,
        rulesAdvanced: 0,
        periodsSkipped: 0,
        rulesDeactivated: 0,
      },
    };
  }

  let config: CronScheduleConfig;
  try {
    config = await loadCronScheduleConfig(env.DB);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const utc = resolveLocalDateAndHour(now, CRON_DEFAULT_TIMEZONE);
    console.error(JSON.stringify({ event: 'cron.schedule_load_failed', error: detail }));
    return {
      demo_mode: false,
      timezone: CRON_DEFAULT_TIMEZONE,
      local_date: utc.localDate,
      local_hour: utc.localHour,
      fx_refresh: { ran: true, ok: false, error: detail },
      recurring_auto_skip: {
        status: 'error',
        today: utc.localDate,
        rulesChecked: 0,
        rulesAdvanced: 0,
        periodsSkipped: 0,
        rulesDeactivated: 0,
        error: detail,
      },
    };
  }

  const { localDate, localHour } = resolveLocalDateAndHour(now, config.timezone);

  const runFxJob = async (): Promise<ScheduledFxRefreshOutcome> => {
    if (!config.fxAutoUpdateEnabled) {
      return { ran: false, reason: 'disabled' };
    }
    if (localHour < config.fxAutoUpdateHour) {
      return { ran: false, reason: 'before_scheduled_hour' };
    }
    const claim = await claimDailyCronJob(env.DB, CRON_JOB_FX_REFRESH, localDate);
    if (!claim.acquired) {
      return { ran: false, reason: 'already_ran_today' };
    }
    try {
      const outcome = await handleScheduledFxRefresh(env, {
        fetcher: options.fetcher,
        now: () => now,
      });
      if (!outcome.ran || !outcome.ok) {
        await safeReleaseDailyCronJob(env.DB, CRON_JOB_FX_REFRESH, localDate, claim.previousDate);
      }
      return outcome;
    } catch (error) {
      await safeReleaseDailyCronJob(env.DB, CRON_JOB_FX_REFRESH, localDate, claim.previousDate);
      throw error;
    }
  };

  const runRecurringJob = async (): Promise<RecurringAutoSkipResult> => {
    if (localHour < config.recurringAutoSkipHour) {
      return {
        status: 'skipped_schedule',
        today: localDate,
        rulesChecked: 0,
        rulesAdvanced: 0,
        periodsSkipped: 0,
        rulesDeactivated: 0,
      };
    }
    const claim = await claimDailyCronJob(env.DB, CRON_JOB_RECURRING_AUTO_SKIP, localDate);
    if (!claim.acquired) {
      return {
        status: 'already_ran_today',
        today: localDate,
        rulesChecked: 0,
        rulesAdvanced: 0,
        periodsSkipped: 0,
        rulesDeactivated: 0,
      };
    }
    try {
      const outcome = await handleScheduledRecurringAutoSkip(env, { todayIso: localDate });
      if (outcome.status === 'error') {
        await safeReleaseDailyCronJob(
          env.DB,
          CRON_JOB_RECURRING_AUTO_SKIP,
          localDate,
          claim.previousDate,
        );
      }
      return outcome;
    } catch (error) {
      await safeReleaseDailyCronJob(
        env.DB,
        CRON_JOB_RECURRING_AUTO_SKIP,
        localDate,
        claim.previousDate,
      );
      throw error;
    }
  };

  const [fxSettled, recurringSettled] = await Promise.allSettled([runFxJob(), runRecurringJob()]);

  const fx_refresh: ScheduledFxRefreshOutcome =
    fxSettled.status === 'fulfilled'
      ? fxSettled.value
      : {
          ran: true,
          ok: false,
          error: fxSettled.reason instanceof Error ? fxSettled.reason.message : String(fxSettled.reason),
        };

  const recurring_auto_skip: RecurringAutoSkipResult =
    recurringSettled.status === 'fulfilled'
      ? recurringSettled.value
      : {
          status: 'error',
          today: localDate,
          rulesChecked: 0,
          rulesAdvanced: 0,
          periodsSkipped: 0,
          rulesDeactivated: 0,
          error:
            recurringSettled.reason instanceof Error
              ? recurringSettled.reason.message
              : String(recurringSettled.reason),
        };

  return {
    demo_mode: false,
    timezone: config.timezone,
    local_date: localDate,
    local_hour: localHour,
    fx_refresh,
    recurring_auto_skip,
  };
}
