// Разворот регулярных платежей в даты (issue #198, S1-4) — перенесено из
// archive/v2-codex (app/src/worker/readmodel/forecast.ts) и адаптировано под
// схему v2: там якорь дня по умолчанию брался из `start_date` правила
// (колонки, которой у нас нет), здесь день/месяц якоря читаются напрямую из
// колонок `day_of_month`/`month_of_year` — CHECK `recurring_items_rule_anchors`
// (migrations/0001_initial_schema.sql) гарантирует, что они заполнены для
// monthly/yearly и пусты для daily/weekly. Один якорь на правило, а не «якорь
// из последней прижатой даты», — иначе 31 января, один раз прижатое к 28
// февраля, навсегда осталось бы 28-м числом.
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

/** Потолок развёртки: упереться в него можно только неверным входом. */
const MAX_OCCURRENCES = 1000;

/**
 * День-якорь monthly/yearly правила. CHECK `recurring_items_rule_anchors`
 * гарантирует, что колонка заполнена для этих частот на уровне самой D1 — здесь
 * это лишь защита от битой строки (ручная правка БД, гонка миграций), а не
 * штатный путь: дошли до NULL там, где схема его не допускает, — громкий отказ
 * лучше, чем NaN, тихо просочившийся в даты прогноза.
 */
function requiredDayOfMonth(r: RecurringRule): number {
  if (r.day_of_month === null) {
    throw new RangeError(
      `recurrence: day_of_month обязателен для frequency=${r.frequency} (правило #${r.id}), но пуст — строка нарушает CHECK recurring_items_rule_anchors`,
    );
  }
  return r.day_of_month;
}

/** Симметрично requiredDayOfMonth, но для месяца-якоря yearly правила. */
function requiredMonthOfYear(r: RecurringRule): number {
  if (r.month_of_year === null) {
    throw new RangeError(
      `recurrence: month_of_year обязателен для frequency=yearly (правило #${r.id}), но пуст — строка нарушает CHECK recurring_items_rule_anchors`,
    );
  }
  return r.month_of_year;
}

/**
 * Оценивает количество ПОЛНЫХ периодов между fromDate и targetDate — заведомо
 * НЕ БОЛЬШЕ фактически нужного (округление вниз, с запасом −1 период на
 * clamp дня месяца), чтобы не перескочить ни одного валидного occurrence.
 * Остаток докручивает обычный цикл nextOccurrence в expandRecurring.
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
 * Прыгает НАПРЯМУЮ на `periods` полных периодов вперёд от fromDate — O(1),
 * БЕЗ вызова nextOccurrence в цикле. Корректно для ВСЕХ форм правила:
 * daily/weekly — чистая арифметика дней; monthly/yearly — потому что якорь
 * дня ФИКСИРОВАН (колонка `day_of_month`, та же, что берёт nextOccurrence), а
 * прижатие 29–31 к короткому месяцу не меняет месячную арифметику. Прыжок на
 * k периодов эквивалентен k последовательным nextOccurrence.
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
 * Разворачивает recurring-правило относительно asOfDate до limitDate.
 *
 * Возвращает:
 * - `overdueCount`: количество наступивших/просроченных периодов
 *   (`next_due_date <= cur <= min(asOfDate, hardEnd)`). Вычисляется за O(1)
 *   (advanceByPeriods + periodsToSkip), не тратя CPU на пошаговые циклы по годам.
 * - `futureDates`: список дат будущих платежей в окне (asOfDate, hardEnd].
 *
 * `end_date` — дата ПОСЛЕДНЕГО платежа ВКЛЮЧИТЕЛЬНО (докблок миграции
 * 0002_recurring_items_end_date.sql), отсюда `cur <= hardEnd`.
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
    // Молчаливое усечение возвращало бы короткий список без единого признака —
    // прогноз просто терял бы потоки. Лучше громкий отказ: горизонт ограничен
    // 366 днями, поэтому упереться в потолок можно только ошибкой вызывающего.
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
 * Разворачивает recurring в будущие даты (asOf, limitDate].
 *
 * Обёртка над expandRecurringRule для совместимости с местами, где нужны
 * только будущие даты.
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
      // 29–31 прижимаются к последнему дню месяца. Якорь — день ПРАВИЛА, а не
      // уже прижатой текущей даты: иначе 31 января превращается в 28 февраля
      // и дальше правило навсегда остаётся 28-м числом, хотя прижатие по
      // контракту действует только на короткий месяц.
      const dom = requiredDayOfMonth(r);
      const total = d.year * 12 + (d.month - 1) + r.interval_count;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      return clampedDate(year, month, dom);
    }
    case 'yearly': {
      // Тот же якорь: 29 февраля иначе после первого невисокосного года
      // навсегда становится 28-м. Месяц-якорь — `month_of_year`, а не месяц
      // текущей даты: CHECK `recurring_items_yearly_month_matches_anchor`
      // (migrations/0003_recurring_items_yearly_month_anchor.sql) держит их
      // согласованными на каждом UPDATE строки, это ровно то предусловие,
      // которое здесь используется.
      const dom = requiredDayOfMonth(r);
      const month = requiredMonthOfYear(r);
      return clampedDate(d.year + r.interval_count, month, dom);
    }
  }
}
