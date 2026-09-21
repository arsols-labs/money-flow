// Unit-тесты развёртки регулярных платежей (issue #198, S1-4). Адаптировано
// из golden-тестов archive/v2-codex (app/test/readmodel.test.ts, describe
// 'forecast golden') под схему v2: у RecurringRule нет start_date, якорь дня
// берётся напрямую из day_of_month/month_of_year (см. докблок
// src/worker/forecast/recurrence.ts).
import { describe, expect, it } from 'vitest';
import { addDays, clampedDate, diffDays, parseIsoDate } from '../src/worker/forecast/dates';
import {
  expandRecurring,
  expandRecurringRule,
  periodsToSkip,
  type RecurringRule,
} from '../src/worker/forecast/recurrence';

function rule(overrides: Partial<RecurringRule> & Pick<RecurringRule, 'frequency'>): RecurringRule {
  return {
    id: 1,
    interval_count: 1,
    day_of_month: null,
    month_of_year: null,
    next_due_date: '2026-01-01',
    end_date: null,
    ...overrides,
  };
}

describe('expandRecurring — monthly, day_of_month=31 (главный кейс якоря)', () => {
  it('прижимает к 28/29/30 в коротком месяце и ВОЗВРАЩАЕТСЯ к 31 в длинном', () => {
    const dates = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 31, next_due_date: '2026-07-31' }),
      '2026-07-23', // asOf
      '2027-01-19', // limit
    );
    expect(dates).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30', // короткий месяц — прижато
      '2026-10-31', // вернулся к 31, а не застрял на 30
      '2026-11-30',
      '2026-12-31',
    ]);
  });

  it('якорь не дрейфует даже через несколько последовательных коротких месяцев', () => {
    // day_of_month=31 через фев/апр (30) — каждый раз заново прижимается к
    // СВОЕМУ короткому месяцу, а не к прошлой прижатой дате.
    const dates = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 31, next_due_date: '2027-01-31' }),
      '2027-01-01',
      '2027-05-01',
    );
    expect(dates).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });
});

describe('expandRecurring — yearly, 29 февраля', () => {
  it('невисокосные годы прижимают к 28, високосный возвращает 29', () => {
    const dates = expandRecurring(
      rule({ frequency: 'yearly', day_of_month: 29, month_of_year: 2, next_due_date: '2028-02-29' }),
      '2028-01-01',
      '2032-04-01',
    );
    expect(dates).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });
});

describe('expandRecurring — interval_count > 1 для всех четырёх частот', () => {
  it('daily, interval_count=3', () => {
    const dates = expandRecurring(
      rule({ frequency: 'daily', interval_count: 3, next_due_date: '2026-01-01' }),
      '2026-01-01',
      '2026-01-15',
    );
    expect(dates).toEqual(['2026-01-04', '2026-01-07', '2026-01-10', '2026-01-13']);
  });

  it('weekly, interval_count=2', () => {
    const dates = expandRecurring(
      rule({ frequency: 'weekly', interval_count: 2, next_due_date: '2026-01-05' }),
      '2026-01-01',
      '2026-02-15',
    );
    expect(dates).toEqual(['2026-01-05', '2026-01-19', '2026-02-02']);
  });

  it('monthly, interval_count=3 (квартально)', () => {
    const dates = expandRecurring(
      rule({ frequency: 'monthly', interval_count: 3, day_of_month: 15, next_due_date: '2026-01-15' }),
      '2026-01-01',
      '2026-12-01',
    );
    expect(dates).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  });

  it('yearly, interval_count=2', () => {
    const dates = expandRecurring(
      rule({ frequency: 'yearly', interval_count: 2, day_of_month: 1, month_of_year: 6, next_due_date: '2026-06-01' }),
      '2026-01-01',
      '2032-01-01',
    );
    expect(dates).toEqual(['2026-06-01', '2028-06-01', '2030-06-01']);
  });
});

describe('expandRecurring — end_date включительно', () => {
  it('платёж В ДЕНЬ end_date входит, следующий — нет', () => {
    const dates = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 15, next_due_date: '2026-01-15', end_date: '2026-03-15' }),
      '2026-01-01',
      '2026-12-01',
    );
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });

  it('end_date раньше limitDate ограничивает горизонт сильнее, чем сам limitDate', () => {
    const dates = expandRecurring(
      rule({ frequency: 'daily', next_due_date: '2026-01-01', end_date: '2026-01-05' }),
      '2026-01-01',
      '2026-01-31',
    );
    expect(dates).toEqual(['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
  });

  it('end_date раньше asOf — правило уже закрылось, список пуст', () => {
    const dates = expandRecurring(
      rule({ frequency: 'daily', next_due_date: '2026-01-01', end_date: '2026-01-05' }),
      '2026-06-01',
      '2026-12-01',
    );
    expect(dates).toEqual([]);
  });
});

// Независимый от recurrence.ts эталон: развёртка ОДНИМ шагом за раз, без
// periodsToSkip/advanceByPeriods — та самая O(n) реализация, которую O(1)-
// прыжок обязан воспроизводить бит в бит. Использует только dates.ts, чтобы
// проверка не зависела от логики, которую как раз проверяет.
function stepOnce(r: RecurringRule, from: string): string {
  switch (r.frequency) {
    case 'daily':
      return addDays(from, r.interval_count);
    case 'weekly':
      return addDays(from, 7 * r.interval_count);
    case 'monthly': {
      const d = parseIsoDate(from);
      const dom = r.day_of_month!;
      const total = d.year * 12 + (d.month - 1) + r.interval_count;
      return clampedDate(Math.floor(total / 12), (total % 12) + 1, dom);
    }
    case 'yearly': {
      const d = parseIsoDate(from);
      return clampedDate(d.year + r.interval_count, r.month_of_year!, r.day_of_month!);
    }
  }
}

function naiveExpand(r: RecurringRule, asOfDate: string, limitDate: string): string[] {
  const hardEnd = r.end_date && r.end_date < limitDate ? r.end_date : limitDate;
  const out: string[] = [];
  let cur = r.next_due_date;
  let guard = 0;
  while (cur <= hardEnd) {
    if (guard >= 200000) throw new Error('naiveExpand: guard exceeded — тест сам сломан');
    guard += 1;
    if (cur > asOfDate) out.push(cur);
    cur = stepOnce(r, cur);
  }
  return out;
}

describe('expandRecurring — очень старый next_due_date (годы неактивности)', () => {
  it('daily: O(1)-прыжок эквивалентен наивному пошаговому развороту', () => {
    const r = rule({ frequency: 'daily', next_due_date: '1900-01-01' });
    const asOf = '2026-07-23';
    const limit = '2026-07-30';

    const dates = expandRecurring(r, asOf, limit);
    expect(dates).toEqual([
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
    ]);

    // periodsToSkip реально считает огромное число периодов, а не молча
    // усекает его до малого — иначе прыжок не был бы O(1).
    expect(periodsToSkip(r, r.next_due_date, asOf)).toBeGreaterThan(40000);
    expect(naiveExpand(r, asOf, limit)).toEqual(dates);
  });

  it('monthly: прыжок эквивалентен циклу и на многолетнем правиле', () => {
    const r = rule({ frequency: 'monthly', day_of_month: 15, next_due_date: '2019-03-15' });
    const asOf = '2026-07-23';
    const limit = '2026-09-30';

    const dates = expandRecurring(r, asOf, limit);
    expect(dates).toEqual(['2026-08-15', '2026-09-15']);
    expect(naiveExpand(r, asOf, limit)).toEqual(dates);
  });

  it('yearly: прыжок эквивалентен циклу через несколько десятилетий', () => {
    const r = rule({ frequency: 'yearly', day_of_month: 4, month_of_year: 7, next_due_date: '1990-07-04' });
    const asOf = '2026-01-01';
    const limit = '2028-12-31';

    const dates = expandRecurring(r, asOf, limit);
    expect(dates).toEqual(['2026-07-04', '2027-07-04', '2028-07-04']);
    expect(naiveExpand(r, asOf, limit)).toEqual(dates);
  });
});

describe('expandRecurring — потолок MAX_OCCURRENCES', () => {
  it('громкий RangeError вместо молчаливого усечения', () => {
    // MAX_OCCURRENCES считает вхождения ПОСЛЕ прыжка (periodsToSkip уже
    // довёл cur почти до asOf) — упереться в потолок можно только окном
    // (asOf, limitDate], где ежедневных вхождений больше 1000: пять лет
    // daily-правила без interval_count дают 1827 дней, горизонт прогноза в
    // 366 дней такое окно передать не может — только неверный вызов.
    const r = rule({ frequency: 'daily', next_due_date: '2020-01-01' });
    expect(() => expandRecurring(r, '2020-01-01', '2025-01-01')).toThrow(RangeError);
  });
});

describe('expandRecurringRule — просроченные вхождения и долг (issue #279)', () => {
  it('якорь месяц назад, asOf = сегодня: 2 просроченных (месяц назад + сегодня) и следующие даты', () => {
    const r = rule({ frequency: 'monthly', day_of_month: 15, next_due_date: '2026-07-15' });
    const asOf = '2026-08-15';
    const limit = '2026-10-15';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(2); // 2026-07-15 и 2026-08-15
    expect(result.futureDates).toEqual(['2026-09-15', '2026-10-15']);
  });

  it('якорь вчера, asOf = сегодня, daily: 2 просроченных (вчера + сегодня) и будущие даты', () => {
    const r = rule({ frequency: 'daily', next_due_date: '2026-08-14' });
    const asOf = '2026-08-15';
    const limit = '2026-08-18';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(2); // 2026-08-14 и 2026-08-15
    expect(result.futureDates).toEqual(['2026-08-16', '2026-08-17', '2026-08-18']);
  });

  it('непросроченное правило (next_due_date > asOf): overdueCount = 0, все даты в futureDates', () => {
    const r = rule({ frequency: 'monthly', day_of_month: 20, next_due_date: '2026-08-20' });
    const asOf = '2026-08-15';
    const limit = '2026-10-20';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(0);
    expect(result.futureDates).toEqual(['2026-08-20', '2026-09-20', '2026-10-20']);
  });

  it('end_date в прошлом: считает все наступившие до end_date периоды, 0 будущих дат', () => {
    const r = rule({ frequency: 'daily', next_due_date: '2026-01-01', end_date: '2026-01-05' });
    const asOf = '2026-06-01';
    const limit = '2026-12-01';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(5); // 01, 02, 03, 04, 05 января
    expect(result.futureDates).toEqual([]);
  });

  it('многолетняя неактивность: O(1)-расчёт overdueCount совпадает с точным числом дней', () => {
    const r = rule({ frequency: 'daily', next_due_date: '1900-01-01' });
    const asOf = '2026-07-23';
    const limit = '2026-07-30';

    const result = expandRecurringRule(r, asOf, limit);
    const expectedDays = diffDays('1900-01-01', asOf) + 1;
    expect(result.overdueCount).toBe(expectedDays);
    expect(result.futureDates).toEqual([
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
    ]);
  });
});
