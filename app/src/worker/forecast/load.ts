// Loading forecast data from D1 (issue #198, S1-4). The only place where the
// forecast engine talks to the database — buildForecast (build.ts) does not
// see D1 at all, and that is deliberate: the core is tested without a
// database, and all I/O lives here.
import { expandRecurringRule, type RecurringRule } from './recurrence';
import { addDays } from './dates';
import { normalizeIso4217CurrencyCode } from '../../shared/currency';
import { scaledMinor } from '../../shared/money';

export interface ForecastAccount {
  id: number;
  name: string;
  owner: string;
  country: string;
  currency: string;
  balance_minor: number;
  balance_updated_at: string;
}

export interface ForecastFlow {
  account_id: number;
  date: string;
  amount_minor: number;
  currency: string;
  title: string;
  kind: 'planned' | 'recurring';
  source_id: number;
}

export interface ScheduledPayment extends ForecastFlow {
  /** Past recurring periods only may be grouped; date is the earliest due date. */
  occurrence_count: number;
}

/**
 * Accounts for the forecast. Archived ones are excluded: archive in v2 is a
 * row flag, "hide from the list", not a write-off of money (the same principle
 * as `currenciesInUse` in api.ts) — but the forecast projects the FUTURE of a
 * specific set of accounts on screen, and an archived account is not in that
 * set. The currency directory (`currenciesInUse`) has a different job — not
 * to lose a rate an archived account may still use after it is unarchived —
 * so counting archived accounts is correct there and would be a mistake here:
 * the forecast would draw the balance of an account the owner does not see
 * on screen.
 */
export async function loadAccounts(db: D1Database): Promise<ForecastAccount[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, owner, country, currency, balance_minor, balance_updated_at
       FROM accounts WHERE archived = 0 ORDER BY sort ASC, id ASC`,
    )
    .all<ForecastAccount>();
  return results;
}

/** code -> rate_e9, as stored in fx_rates (migrations/0001_initial_schema.sql). */
export async function loadRates(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare('SELECT code, rate_e9 FROM fx_rates').all<{ code: string; rate_e9: number }>();
  return new Map(results.map((r) => [r.code, r.rate_e9]));
}

// low_balance_threshold_minor is stored as a string (settings is key/value, the
// header of 0001_initial_schema.sql); the format is a non-negative integer, the
// same one PUT /settings/:key accepts (api.ts). Garbage in the database (a
// manual edit, a future migration) must not take down /forecast — fall back to 0.
function normalizeThresholdMinor(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Forecast settings. A missing key or an unusable value does not take down
 * the endpoint — the base currency defaults to 'USD', the threshold to 0 (the
 * same default migration 0001 itself sets, but here this is a GUARD in case the
 * settings row is someday deleted or corrupted, not a reliance on the default).
 */
export async function loadForecastSettings(
  db: D1Database,
): Promise<{ baseCurrency: string; lowBalanceThresholdMinor: number }> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN ('base_currency', 'low_balance_threshold_minor')`)
    .all<{ key: string; value: string }>();
  const raw = new Map(results.map((r) => [r.key, r.value]));
  return {
    // Normalization is shared with `readBaseCurrency` in api.ts — see shared/currency.ts.
    baseCurrency: normalizeIso4217CurrencyCode(raw.get('base_currency')) ?? 'USD',
    lowBalanceThresholdMinor: normalizeThresholdMinor(raw.get('low_balance_threshold_minor')) ?? 0,
  };
}

interface PlannedFlowRow {
  id: number;
  date: string;
  title: string;
  amount_minor: number;
  currency: string;
  account_id: number;
}

interface RecurringFlowRow {
  id: number;
  title: string;
  amount_minor: number;
  currency: string;
  account_id: number;
  frequency: RecurringRule['frequency'];
  interval_count: number;
  day_of_month: number | null;
  month_of_year: number | null;
  next_due_date: string;
  end_date: string | null;
}

/**
 * Forecast flows and the actual payment schedule share the same source rows.
 * Payment dates are never taken from the projected cash-flow dates.
 * Each output has its own horizon; source rows cover the larger one.
 *
 * Overdue recurring payments (`next_due_date <= asOfDate`):
 * Unlike planned items (where the "done" mark creates an operation per #267),
 * recurring payments must not silently disappear at midnight on the due date
 * (#279). If the due date has arrived and the operation has not been created
 * yet, every elapsed period is projected as a single amount
 * (overdueCount × amount_minor) onto the nearest day of the forecast series
 * (addDays(asOfDate, 1)). Later schedule dates on the horizon up to limitDate
 * stay in their own places.
 */
export async function loadFlowsAndPayments(
  db: D1Database,
  eligibleAccountIds: Set<number>,
  asOfDate: string,
  limitDate: string,
  paymentLimit: string,
): Promise<{ flows: ForecastFlow[]; payments: ScheduledPayment[] }> {
  const flows: ForecastFlow[] = [];
  const payments: ScheduledPayment[] = [];
  const nearestDay = addDays(asOfDate, 1);
  const sourceLimit = limitDate > paymentLimit ? limitDate : paymentLimit;

  const { results: planned } = await db
    .prepare(
      `SELECT id, date, title, amount_minor, currency, account_id
       FROM planned_items
       WHERE done = 0 AND date <= ?1`,
    )
    .bind(sourceLimit)
    .all<PlannedFlowRow>();
  for (const p of planned) {
    if (!eligibleAccountIds.has(p.account_id)) continue;
    const flow: ForecastFlow = {
      account_id: p.account_id,
      date: p.date,
      amount_minor: p.amount_minor,
      currency: p.currency,
      title: p.title,
      kind: 'planned',
      source_id: p.id,
    };
    if (p.date > asOfDate && p.date <= limitDate) flows.push(flow);
    if (p.date <= paymentLimit) payments.push({ ...flow, occurrence_count: 1 });
  }

  const { results: recurring } = await db
    .prepare(
      `SELECT id, title, amount_minor, currency, account_id, frequency, interval_count,
              day_of_month, month_of_year, next_due_date, end_date
       FROM recurring_items
       WHERE active = 1 AND next_due_date <= ?1`,
    )
    .bind(sourceLimit)
    .all<RecurringFlowRow>();
  for (const r of recurring) {
    if (!eligibleAccountIds.has(r.account_id)) continue;
    const rule: RecurringRule = {
      id: r.id,
      frequency: r.frequency,
      interval_count: r.interval_count,
      day_of_month: r.day_of_month,
      month_of_year: r.month_of_year,
      next_due_date: r.next_due_date,
      end_date: r.end_date,
    };
    try {
      if (scaledMinor(r.amount_minor, 2) === null) continue;
      // The schedule separates past periods from today; the balance projection
      // below retains its existing tomorrow catch-up semantics (#279).
      const schedule = expandRecurringRule(rule, addDays(asOfDate, -1), paymentLimit);
      const payment = (date: string, count: number): ScheduledPayment | null => {
        const amount = scaledMinor(r.amount_minor, count);
        if (amount === null) return null;
        return {
          account_id: r.account_id, date, amount_minor: amount,
          currency: r.currency, title: r.title, kind: 'recurring', source_id: r.id,
          occurrence_count: count,
        };
      };
      if (schedule.overdueCount > 0) {
        const overduePayment = payment(r.next_due_date, schedule.overdueCount);
        if (overduePayment) payments.push(overduePayment);
      }
      for (const date of schedule.futureDates) {
        const nextPayment = payment(date, 1);
        if (nextPayment) payments.push(nextPayment);
      }

      const { overdueCount, futureDates } = expandRecurringRule(rule, asOfDate, limitDate);
      if (overdueCount > 0) {
        const overdueAmount = scaledMinor(r.amount_minor, overdueCount);
        if (overdueAmount !== null) {
          flows.push({
            account_id: r.account_id,
            date: nearestDay,
            amount_minor: overdueAmount,
            currency: r.currency,
            title: r.title,
            kind: 'recurring',
            source_id: r.id,
          });
        }
      }
      for (const date of futureDates) {
        flows.push({
          account_id: r.account_id,
          date,
          amount_minor: r.amount_minor,
          currency: r.currency,
          title: r.title,
          kind: 'recurring',
          source_id: r.id,
        });
      }
    } catch {
      // A single stored rule must not take down forecast for the owner.
      continue;
    }
  }

  // Deterministic order: date, then kind (alphabetically 'planned' <
  // 'recurring'), then source id — otherwise the order within one date would
  // depend on the D1 response order, which nothing guarantees.
  const compare = (a: ForecastFlow, b: ForecastFlow) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.source_id - b.source_id;
  };
  flows.sort(compare);
  payments.sort(compare);
  return { flows, payments };
}
