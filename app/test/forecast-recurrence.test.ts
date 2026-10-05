// Unit tests of recurring-payment expansion (issue #198, S1-4). Adapted
// from the golden tests in archive/v2-codex (app/test/readmodel.test.ts, describe
// 'forecast golden') to the v2 schema: RecurringRule has no start_date, the day anchor
// is taken directly from day_of_month/month_of_year (see the docblock in
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

describe('expandRecurring — monthly, day_of_month=31 (the main anchor case)', () => {
  it('clamps to 28/29/30 in a short month and RETURNS to 31 in a long one', () => {
    const dates = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 31, next_due_date: '2026-07-31' }),
      '2026-07-23', // asOf
      '2027-01-19', // limit
    );
    expect(dates).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30', // short month — clamped
      '2026-10-31', // returned to 31, did not stick on 30
      '2026-11-30',
      '2026-12-31',
    ]);
  });

  it('the anchor does not drift even through several short months in a row', () => {
    // day_of_month=31 through Feb/Apr (30) — each time it clamps anew to
    // ITS OWN short month, not to the previous clamped date.
    const dates = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 31, next_due_date: '2027-01-31' }),
      '2027-01-01',
      '2027-05-01',
    );
    expect(dates).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });
});

describe('expandRecurring — yearly, February 29', () => {
  it('non-leap years clamp to 28, a leap year returns 29', () => {
    const dates = expandRecurring(
      rule({ frequency: 'yearly', day_of_month: 29, month_of_year: 2, next_due_date: '2028-02-29' }),
      '2028-01-01',
      '2032-04-01',
    );
    expect(dates).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });
});

describe('expandRecurring — interval_count > 1 for all four frequencies', () => {
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

  it('monthly, interval_count=3 (quarterly)', () => {
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

describe('expandRecurring — end_date inclusive', () => {
  it('a payment ON the end_date is included, the next one is not', () => {
    const dates = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 15, next_due_date: '2026-01-15', end_date: '2026-03-15' }),
      '2026-01-01',
      '2026-12-01',
    );
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });

  it('an end_date earlier than limitDate limits the horizon more tightly than limitDate itself', () => {
    const dates = expandRecurring(
      rule({ frequency: 'daily', next_due_date: '2026-01-01', end_date: '2026-01-05' }),
      '2026-01-01',
      '2026-01-31',
    );
    expect(dates).toEqual(['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
  });

  it('end_date earlier than asOf — the rule has already closed, the list is empty', () => {
    const dates = expandRecurring(
      rule({ frequency: 'daily', next_due_date: '2026-01-01', end_date: '2026-01-05' }),
      '2026-06-01',
      '2026-12-01',
    );
    expect(dates).toEqual([]);
  });
});

// An oracle independent of recurrence.ts: expansion ONE step at a time, without
// periodsToSkip/advanceByPeriods — the very O(n) implementation the O(1)
// jump must reproduce bit for bit. It uses only dates.ts, so the
// check does not depend on the logic it is checking.
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

describe('expandRecurring — a very old next_due_date (years of inactivity)', () => {
  it('daily: the O(1) jump is equivalent to the naive step-by-step expansion', () => {
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

    // periodsToSkip really counts a huge number of periods instead of silently
    // truncating it to a small one — otherwise the jump would not be O(1).
    expect(periodsToSkip(r, r.next_due_date, asOf)).toBeGreaterThan(40000);
    expect(naiveExpand(r, asOf, limit)).toEqual(dates);
  });

  it('monthly: the jump is equivalent to the loop on a multi-year rule too', () => {
    const r = rule({ frequency: 'monthly', day_of_month: 15, next_due_date: '2019-03-15' });
    const asOf = '2026-07-23';
    const limit = '2026-09-30';

    const dates = expandRecurring(r, asOf, limit);
    expect(dates).toEqual(['2026-08-15', '2026-09-15']);
    expect(naiveExpand(r, asOf, limit)).toEqual(dates);
  });

  it('yearly: the jump is equivalent to the loop across several decades', () => {
    const r = rule({ frequency: 'yearly', day_of_month: 4, month_of_year: 7, next_due_date: '1990-07-04' });
    const asOf = '2026-01-01';
    const limit = '2028-12-31';

    const dates = expandRecurring(r, asOf, limit);
    expect(dates).toEqual(['2026-07-04', '2027-07-04', '2028-07-04']);
    expect(naiveExpand(r, asOf, limit)).toEqual(dates);
  });
});

describe('expandRecurring — the MAX_OCCURRENCES ceiling', () => {
  it('a loud RangeError instead of a silent truncation', () => {
    // MAX_OCCURRENCES counts occurrences AFTER the jump (periodsToSkip has already
    // brought cur almost up to asOf) — the ceiling can be hit only by a window
    // (asOf, limitDate] with more than 1000 daily occurrences: five years
    // of a daily rule without interval_count give 1827 days, and a forecast horizon of
    // 366 days cannot pass such a window — only an incorrect call can.
    const r = rule({ frequency: 'daily', next_due_date: '2020-01-01' });
    expect(() => expandRecurring(r, '2020-01-01', '2025-01-01')).toThrow(RangeError);
  });
});

describe('expandRecurringRule — overdue occurrences and debt (issue #279)', () => {
  it('anchor a month ago, asOf = today: 2 overdue (a month ago + today) and the following dates', () => {
    const r = rule({ frequency: 'monthly', day_of_month: 15, next_due_date: '2026-07-15' });
    const asOf = '2026-08-15';
    const limit = '2026-10-15';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(2); // 2026-07-15 and 2026-08-15
    expect(result.futureDates).toEqual(['2026-09-15', '2026-10-15']);
  });

  it('anchor yesterday, asOf = today, daily: 2 overdue (yesterday + today) and future dates', () => {
    const r = rule({ frequency: 'daily', next_due_date: '2026-08-14' });
    const asOf = '2026-08-15';
    const limit = '2026-08-18';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(2); // 2026-08-14 and 2026-08-15
    expect(result.futureDates).toEqual(['2026-08-16', '2026-08-17', '2026-08-18']);
  });

  it('a rule that is not overdue (next_due_date > asOf): overdueCount = 0, every date is in futureDates', () => {
    const r = rule({ frequency: 'monthly', day_of_month: 20, next_due_date: '2026-08-20' });
    const asOf = '2026-08-15';
    const limit = '2026-10-20';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(0);
    expect(result.futureDates).toEqual(['2026-08-20', '2026-09-20', '2026-10-20']);
  });

  it('end_date in the past: counts every period that fell due by end_date, 0 future dates', () => {
    const r = rule({ frequency: 'daily', next_due_date: '2026-01-01', end_date: '2026-01-05' });
    const asOf = '2026-06-01';
    const limit = '2026-12-01';

    const result = expandRecurringRule(r, asOf, limit);
    expect(result.overdueCount).toBe(5); // January 01, 02, 03, 04, 05
    expect(result.futureDates).toEqual([]);
  });

  it('years of inactivity: the O(1) overdueCount matches the exact number of days', () => {
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
