import { loadCronScheduleConfig } from './cron-schedule';
import { isDemoMode } from './demo-flag';
import { diffDays, isIsoDateString } from './forecast/dates';
import { nextOccurrence, type RecurringRule } from './forecast/recurrence';
import type { Env } from './types';
import { resolveLocalDateAndHour } from '../shared/cron-schedule';

export const AUTO_SKIP_AFTER_DAYS_MIN = 1;
export const AUTO_SKIP_AFTER_DAYS_MAX = 365;
export const AUTO_SKIP_AFTER_DAYS_DEFAULT = 1;
export const MAX_AUTO_SKIP_PERIODS_PER_RUN = 366;

type AutoSkipRuleRow = RecurringRule & {
  revision: string | null;
  active: number;
  auto_skip_overdue: number;
  auto_skip_after_days: number;
};

export type RecurringAutoSkipResult = {
  status: 'ok' | 'skipped_demo' | 'skipped_schedule' | 'already_ran_today' | 'error';
  today: string;
  rulesChecked: number;
  rulesAdvanced: number;
  periodsSkipped: number;
  rulesDeactivated: number;
  error?: string;
};

export function isOccurrenceEligibleForAutoSkip(
  dueDate: string,
  autoSkipAfterDays: number,
  todayIso: string,
): boolean {
  if (
    !Number.isInteger(autoSkipAfterDays)
    || autoSkipAfterDays < AUTO_SKIP_AFTER_DAYS_MIN
    || autoSkipAfterDays > AUTO_SKIP_AFTER_DAYS_MAX
  ) {
    return false;
  }
  return diffDays(dueDate, todayIso) >= autoSkipAfterDays;
}

/**
 * Advances active opt-in recurring rules (`auto_skip_overdue = 1`) whose
 * current occurrence is at least `auto_skip_after_days` overdue relative to
 * `todayIso` (UTC YYYY-MM-DD by default).
 *
 * Uses the exact same skip semantics as `POST /recurring-items/:id/skip-period`:
 * inserts `outcome = 'skipped'` into `recurring_period_fulfillments` and shifts
 * `next_due_date` (or sets `active = 0` after `end_date`) atomically per period,
 * without creating financial operations or modifying account balances.
 */
export async function runRecurringAutoSkip(
  db: D1Database,
  options: { todayIso?: string } = {},
): Promise<RecurringAutoSkipResult> {
  const today = options.todayIso ?? new Date().toISOString().slice(0, 10);
  if (!isIsoDateString(today)) {
    throw new RangeError(`runRecurringAutoSkip: invalid todayIso date ${JSON.stringify(today)}`);
  }

  const candidateResult = await db
    .prepare(
      `SELECT id, revision, frequency, interval_count, day_of_month, month_of_year,
              next_due_date, end_date, active, auto_skip_overdue, auto_skip_after_days
         FROM recurring_items
        WHERE active = 1 AND auto_skip_overdue = 1 AND next_due_date < ?
        ORDER BY next_due_date ASC, id ASC`,
    )
    .bind(today)
    .all<AutoSkipRuleRow>();

  const candidates = candidateResult.results ?? [];
  let rulesAdvanced = 0;
  let periodsSkipped = 0;
  let rulesDeactivated = 0;

  for (const initialRow of candidates) {
    let current: AutoSkipRuleRow = initialRow;
    let skippedForRule = 0;

    while (
      current.active === 1
      && current.auto_skip_overdue === 1
      && skippedForRule < MAX_AUTO_SKIP_PERIODS_PER_RUN
      && isOccurrenceEligibleForAutoSkip(current.next_due_date, current.auto_skip_after_days, today)
    ) {
      const dueDate = current.next_due_date;
      const nextDate = nextOccurrence(current, dueDate);
      if (nextDate <= dueDate) {
        break;
      }
      const isFinished = current.end_date !== null && nextDate > current.end_date;

      const casWhere = `id = ? AND revision IS ? AND frequency = ? AND interval_count = ?
        AND day_of_month IS ? AND month_of_year IS ?
        AND next_due_date = ? AND end_date IS ? AND active = 1
        AND auto_skip_overdue = 1 AND auto_skip_after_days = ?`;
      const updateStmt = isFinished
        ? db
            .prepare(
              `UPDATE recurring_items SET active = 0
                WHERE ${casWhere}
                RETURNING id, revision, frequency, interval_count, day_of_month, month_of_year,
                          next_due_date, end_date, active, auto_skip_overdue, auto_skip_after_days`,
            )
            .bind(
              current.id,
              current.revision,
              current.frequency,
              current.interval_count,
              current.day_of_month,
              current.month_of_year,
              dueDate,
              current.end_date,
              current.auto_skip_after_days,
            )
        : db
            .prepare(
              `UPDATE recurring_items SET next_due_date = ?
                WHERE ${casWhere}
                RETURNING id, revision, frequency, interval_count, day_of_month, month_of_year,
                          next_due_date, end_date, active, auto_skip_overdue, auto_skip_after_days`,
            )
            .bind(
              nextDate,
              current.id,
              current.revision,
              current.frequency,
              current.interval_count,
              current.day_of_month,
              current.month_of_year,
              dueDate,
              current.end_date,
              current.auto_skip_after_days,
            );

      const fulfillmentStmt = db
        .prepare(
          `INSERT OR IGNORE INTO recurring_period_fulfillments
             (recurring_item_id, period_due_date, outcome, fulfilled_at)
           SELECT ?, ?, 'skipped', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE changes() = 1`,
        )
        .bind(current.id, dueDate);

      const batchResults = await db.batch<AutoSkipRuleRow>([updateStmt, fulfillmentStmt]);
      const updated = batchResults[0]?.results?.[0];
      if (!updated) {
        break;
      }

      skippedForRule += 1;
      periodsSkipped += Number(batchResults[1]?.meta?.changes ?? 0);
      if (isFinished) {
        rulesDeactivated += 1;
      }
      current = updated;
    }

    if (skippedForRule > 0) {
      rulesAdvanced += 1;
    }
  }

  return {
    status: 'ok',
    today,
    rulesChecked: candidates.length,
    rulesAdvanced,
    periodsSkipped,
    rulesDeactivated,
  };
}

export async function handleScheduledRecurringAutoSkip(
  env: Pick<Env, 'DB' | 'DEMO_MODE'>,
  options: { todayIso?: string; now?: () => Date } = {},
): Promise<RecurringAutoSkipResult> {
  const now = options.now ? options.now() : new Date();
  let today = options.todayIso ?? now.toISOString().slice(0, 10);
  if (isDemoMode(env)) {
    return {
      status: 'skipped_demo',
      today,
      rulesChecked: 0,
      rulesAdvanced: 0,
      periodsSkipped: 0,
      rulesDeactivated: 0,
    };
  }

  try {
    if (!options.todayIso) {
      const schedule = await loadCronScheduleConfig(env.DB);
      today = resolveLocalDateAndHour(now, schedule.timezone).localDate;
    }
    const result = await runRecurringAutoSkip(env.DB, { todayIso: today });
    console.log(
      JSON.stringify({
        event: 'recurring.cron.auto_skip',
        today: result.today,
        rulesChecked: result.rulesChecked,
        rulesAdvanced: result.rulesAdvanced,
        periodsSkipped: result.periodsSkipped,
        rulesDeactivated: result.rulesDeactivated,
      }),
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: 'recurring.cron.failed',
        today,
        error: detail,
      }),
    );
    return {
      status: 'error',
      today,
      rulesChecked: 0,
      rulesAdvanced: 0,
      periodsSkipped: 0,
      rulesDeactivated: 0,
      error: detail,
    };
  }
}
