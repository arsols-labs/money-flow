// Загрузка данных прогноза из D1 (issue #198, S1-4). Единственное место, где
// движок прогноза говорит с базой — buildForecast (build.ts) сам D1 не видит
// вовсе, это принципиально: ядро тестируется без базы, вся I/O здесь.
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
 * Счета для прогноза. Архивные исключены: архив в v2 — признак строки,
 * «убрать из списка», а не списание денег (тот же принцип, что у
 * `currenciesInUse` в api.ts) — но прогноз проецирует БУДУЩЕЕ конкретного
 * набора счетов на экране, и архивный в этот набор не входит. У справочника
 * валют (`currenciesInUse`) другая задача — не терять курс, которым архивный
 * счёт всё ещё может воспользоваться после разархивации, — поэтому там учёт
 * архивных верен, а здесь был бы ошибкой: прогноз рисовал бы баланс счёта,
 * которого владелец на экране не видит.
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

/** code -> rate_e9, как хранится в fx_rates (migrations/0001_initial_schema.sql). */
export async function loadRates(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare('SELECT code, rate_e9 FROM fx_rates').all<{ code: string; rate_e9: number }>();
  return new Map(results.map((r) => [r.code, r.rate_e9]));
}

// low_balance_threshold_minor хранится строкой (settings — key/value, шапка
// 0001_initial_schema.sql); формат — неотрицательное целое, тот же, что
// принимает PUT /settings/:key (api.ts). Мусор в базе (ручная правка, будущая
// миграция) не должен ронять /forecast — сводим к дефолту 0.
function normalizeThresholdMinor(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Настройки прогноза. Отсутствие ключа или непригодное значение не роняют
 * эндпоинт — базовая валюта дефолтится в 'USD', порог в 0 (тот же дефолт, что
 * задаёт сама миграция 0001, но здесь это ЗАЩИТА на случай, если строку
 * settings когда-нибудь удалят или испортят, а не расчёт на дефолт).
 */
export async function loadForecastSettings(
  db: D1Database,
): Promise<{ baseCurrency: string; lowBalanceThresholdMinor: number }> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN ('base_currency', 'low_balance_threshold_minor')`)
    .all<{ key: string; value: string }>();
  const raw = new Map(results.map((r) => [r.key, r.value]));
  return {
    // Нормализация общая с `readBaseCurrency` в api.ts — см. shared/currency.ts.
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
 * Просроченные регулярные платежи (`next_due_date <= asOfDate`):
 * В отличие от плановых (где отметка «выполнено» создаёт операцию по #267),
 * регулярные платежи не должны молча исчезать в полночь срока (#279).
 * Если срок наступил, а операция ещё не создана, все наступившие периоды
 * проецируются единой суммой (overdueCount × amount_minor) на ближайший
 * день прогнозного ряда (addDays(asOfDate, 1)). Последующие даты расписания
 * на горизонте до limitDate остаются на своих местах.
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

  // Детерминированный порядок: дата, затем вид (алфавитно 'planned' <
  // 'recurring'), затем id источника — иначе порядок внутри одной даты
  // зависел бы от порядка ответа D1, который ничем не гарантирован.
  const compare = (a: ForecastFlow, b: ForecastFlow) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.source_id - b.source_id;
  };
  flows.sort(compare);
  payments.sort(compare);
  return { flows, payments };
}
