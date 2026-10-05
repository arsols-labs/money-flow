// Expanding recurring payments into dates (issue #198, S1-4) — moved from
// archive/v2-codex (app/src/worker/readmodel/forecast.ts) and adapted to the
// v2 schema: there the day anchor was taken by default from the rule's
// `start_date` (a column we do not have); here the anchor day/month are read
// directly from the `day_of_month`/`month_of_year` columns — CHECK
// `recurring_items_rule_anchors` (migrations/0001_initial_schema.sql)
// guarantees they are filled for monthly/yearly and empty for daily/weekly.
// One anchor per rule, not "the anchor from the last clamped date" — otherwise
// 31 January, once clamped to 28 February, would forever remain the 28th.
import { addDays, clampedDate, diffDays, parseIsoDate } from './dates';

export interface RecurringRule {
  id: number;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval_count: number;
  day_of_month: number | null;
  month_of_year: number | null;
  next_due_date: string;
  end_date: string | null;
}

/** Expansion ceiling: it can be hit only by invalid input. */
const MAX_OCCURRENCES = 1000;

/**
 * Day anchor of a monthly/yearly rule. CHECK `recurring_items_rule_anchors`
 * guarantees the column is filled for these frequencies at the D1 level itself
 * — here this is only a guard against a corrupt row (a manual DB edit, a
 * migration race), not the normal path: reaching NULL where the schema does
 * not allow it, a loud failure is better than a NaN that quietly leaked into
 * forecast dates.
 */
function requiredDayOfMonth(r: RecurringRule): number {
  if (r.day_of_month === null) {
    throw new RangeError(
      `recurrence: day_of_month обязателен для frequency=${r.frequency} (правило #${r.id}), но пуст — строка нарушает CHECK recurring_items_rule_anchors`,
    );
  }
  return r.day_of_month;
}

/** Symmetric to requiredDayOfMonth, but for the month anchor of a yearly rule. */
function requiredMonthOfYear(r: RecurringRule): number {
  if (r.month_of_year === null) {
    throw new RangeError(
      `recurrence: month_of_year обязателен для frequency=yearly (правило #${r.id}), но пуст — строка нарушает CHECK recurring_items_rule_anchors`,
    );
  }
  return r.month_of_year;
}

/**
 * Estimates the number of FULL periods between fromDate and targetDate —
 * certainly NOT MORE than actually needed (rounding down, with a margin of −1
 * period for the month-day clamp), so as not to skip any valid occurrence.
 * The remainder is finished by the ordinary nextOccurrence loop in expandRecurring.
 */
export function periodsToSkip(r: RecurringRule, fromDate: string, targetDate: string): number {
  if (fromDate >= targetDate) return 0;
  switch (r.frequency) {
    case 'daily':
      return Math.floor(diffDays(fromDate, targetDate) / r.interval_count);
    case 'weekly':
      return Math.floor(diffDays(fromDate, targetDate) / (7 * r.interval_count));
    case 'monthly':
    case 'yearly': {
      const f = parseIsoDate(fromDate);
      const t = parseIsoDate(targetDate);
      const monthsBetween = (t.year - f.year) * 12 + (t.month - f.month);
      const periodMonths = r.frequency === 'monthly' ? r.interval_count : 12 * r.interval_count;
      return Math.max(0, Math.floor(monthsBetween / periodMonths) - 1);
    }
  }
}

/**
 * Jumps DIRECTLY `periods` full periods ahead of fromDate — O(1), WITHOUT
 * calling nextOccurrence in a loop. Correct for ALL forms of the rule:
 * daily/weekly are pure day arithmetic; monthly/yearly because the day anchor
 * is FIXED (the `day_of_month` column, the same one nextOccurrence reads), and
 * clamping 29–31 to a short month does not change the month arithmetic. A jump
 * of k periods is equivalent to k successive nextOccurrence calls.
 */
function advanceByPeriods(r: RecurringRule, fromDate: string, periods: number): string {
  if (periods <= 0) return fromDate;
  switch (r.frequency) {
    case 'daily':
      return addDays(fromDate, r.interval_count * periods);
    case 'weekly':
      return addDays(fromDate, 7 * r.interval_count * periods);
    case 'monthly':
    case 'yearly': {
      const d = parseIsoDate(fromDate);
      const periodMonths = r.frequency === 'monthly' ? r.interval_count : 12 * r.interval_count;
      const total = d.year * 12 + (d.month - 1) + periodMonths * periods;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      return clampedDate(year, month, requiredDayOfMonth(r));
    }
  }
}

export interface ExpandedRecurring {
  overdueCount: number;
  futureDates: string[];
}

/**
 * Expands a recurring rule relative to asOfDate up to limitDate.
 *
 * Returns:
 * - `overdueCount`: the number of elapsed/overdue periods
 *   (`next_due_date <= cur <= min(asOfDate, hardEnd)`). Computed in O(1)
 *   (advanceByPeriods + periodsToSkip), without spending CPU on step-by-step
 *   loops across years.
 * - `futureDates`: the list of future payment dates in the window (asOfDate, hardEnd].
 *
 * `end_date` is the date of the LAST payment INCLUSIVE (docblock of migration
 * 0002_recurring_items_end_date.sql), hence `cur <= hardEnd`.
 */
export function expandRecurringRule(
  r: RecurringRule,
  asOfDate: string,
  limitDate: string,
): ExpandedRecurring {
  const hardEnd = r.end_date && r.end_date < limitDate ? r.end_date : limitDate;
  let cur = r.next_due_date;
  if (cur > hardEnd) return { overdueCount: 0, futureDates: [] };

  let overdueCount = 0;
  const effectivePastEnd = asOfDate < hardEnd ? asOfDate : hardEnd;

  if (cur <= effectivePastEnd) {
    const skipped = periodsToSkip(r, cur, effectivePastEnd);
    if (skipped > 0) {
      overdueCount += skipped;
      cur = advanceByPeriods(r, cur, skipped);
    }
    while (cur <= effectivePastEnd) {
      overdueCount += 1;
      const next = nextOccurrence(r, cur);
      if (next <= cur) {
        throw new RangeError('expandRecurring: nextOccurrence не сдвинул дату');
      }
      cur = next;
    }
  }

  const futureDates: string[] = [];
  let guard = 0;
  while (cur <= hardEnd) {
    // Silent truncation would return a short list with no sign at all — the
    // forecast would simply lose flows. A loud failure is better: the horizon
    // is limited to 366 days, so the ceiling can be hit only by a caller error.
    if (guard >= MAX_OCCURRENCES) {
      throw new RangeError(
        `expandRecurring: больше ${MAX_OCCURRENCES} вхождений до ${hardEnd}; окно или правило заданы неверно`,
      );
    }
    guard += 1;
    if (cur > asOfDate) futureDates.push(cur);
    const next = nextOccurrence(r, cur);
    if (next <= cur) {
      throw new RangeError('expandRecurring: nextOccurrence не сдвинул дату');
    }
    cur = next;
  }

  return { overdueCount, futureDates };
}

/**
 * Expands a recurring rule into future dates (asOf, limitDate].
 *
 * Wrapper over expandRecurringRule for call sites that need only future dates.
 */
export function expandRecurring(r: RecurringRule, asOfDate: string, limitDate: string): string[] {
  return expandRecurringRule(r, asOfDate, limitDate).futureDates;
}

export function nextOccurrence(r: RecurringRule, from: string): string {
  const d = parseIsoDate(from);
  switch (r.frequency) {
    case 'daily':
      return addDays(from, r.interval_count);
    case 'weekly':
      return addDays(from, 7 * r.interval_count);
    case 'monthly': {
      // 29–31 are clamped to the last day of the month. The anchor is the RULE's
      // day, not the already-clamped current date: otherwise 31 January becomes
      // 28 February and the rule forever stays the 28th, even though clamping
      // by contract applies only to a short month.
      const dom = requiredDayOfMonth(r);
      const total = d.year * 12 + (d.month - 1) + r.interval_count;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      return clampedDate(year, month, dom);
    }
    case 'yearly': {
      // The same anchor: otherwise 29 February, after the first non-leap year,
      // forever becomes the 28th. The month anchor is `month_of_year`, not the
      // month of the current date: CHECK `recurring_items_yearly_month_matches_anchor`
      // (migrations/0003_recurring_items_yearly_month_anchor.sql) keeps them
      // consistent on every UPDATE of the row, and that is exactly the
      // precondition used here.
      const dom = requiredDayOfMonth(r);
      const month = requiredMonthOfYear(r);
      return clampedDate(d.year + r.interval_count, month, dom);
    }
  }
}
