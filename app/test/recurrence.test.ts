// Helpers for the "Planned"/"Recurring" sections (S1-3, issue #197).
//
// describeRecurrence is the only place where a rule's day and month are read from
// next_due_date, not from separate form fields (day_of_month/month_of_year
// are derived by the server and the form does not send them) — a bug here shows the owner
// a wrong human-readable description of the rule that is actually stored.
import './use-ru-i18n';
import { describe, expect, it } from 'vitest';
import {
  describeRecurrence,
  describeDueDate,
  FREQUENCY_OPTIONS,
  formatDayMonth,
  intervalUnitLabel,
  todayDateString,
} from '../src/ui/recurrence.js';


describe('describeRecurrence', () => {
  it('daily, interval 1', () => {
    expect(describeRecurrence({ frequency: 'daily', interval_count: 1, next_due_date: '2026-09-01' }))
      .toBe('каждый день');
  });

  it('daily, interval N with inflection (5 → genitive plural)', () => {
    expect(describeRecurrence({ frequency: 'daily', interval_count: 5, next_due_date: '2026-09-01' }))
      .toBe('раз в 5 дней');
  });

  it('daily, interval 3 with inflection (2–4 → paucal)', () => {
    expect(describeRecurrence({ frequency: 'daily', interval_count: 3, next_due_date: '2026-09-01' }))
      .toBe('раз в 3 дня');
  });

  it('weekly, interval 1', () => {
    expect(describeRecurrence({ frequency: 'weekly', interval_count: 1, next_due_date: '2026-09-01' }))
      .toBe('каждую неделю');
  });

  it('weekly, interval 2 (every 2 weeks)', () => {
    expect(describeRecurrence({ frequency: 'weekly', interval_count: 2, next_due_date: '2026-09-01' }))
      .toBe('раз в 2 недели');
  });

  it('weekly, interval 21 (inflection follows the last digit, not the whole number)', () => {
    expect(describeRecurrence({ frequency: 'weekly', interval_count: 21, next_due_date: '2026-09-01' }))
      .toBe('раз в 21 неделю');
  });

  it('monthly, day of month without clamping', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 1, day_of_month: 15, next_due_date: '2026-09-15' }))
      .toBe('каждый месяц 15 числа');
  });

  it('monthly, interval N plus day of month', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 2, day_of_month: 1, next_due_date: '2026-09-01' }))
      .toBe('раз в 2 месяца 1 числа');
  });

  it('monthly, day_of_month clamped to the actual day (the 31st → February 28)', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 1, day_of_month: 31, next_due_date: '2026-02-28' }))
      .toBe('каждый месяц 31 числа (в этом месяце — 28-го)');
  });

  it('yearly, the day and month are taken from next_due_date', () => {
    expect(describeRecurrence({ frequency: 'yearly', interval_count: 1, day_of_month: 29, next_due_date: '2028-02-29' }))
      .toBe('каждый год 29 февраля');
  });

  it('yearly, interval N', () => {
    expect(describeRecurrence({ frequency: 'yearly', interval_count: 5, day_of_month: 1, next_due_date: '2026-01-01' }))
      .toBe('раз в 5 лет 1 января');
  });

  // The yearly rule has its own wording: its month is always the same,
  // only the day is clamped, so "this month" would be wrong — it refers to
  // the next payment, not the current month.
  it('yearly, day_of_month clamped to the actual day (February 29 → the 28th in a non-leap year)', () => {
    expect(describeRecurrence({ frequency: 'yearly', interval_count: 1, day_of_month: 29, next_due_date: '2027-02-28' }))
      .toBe('каждый год 29 февраля (ближайший раз — 28-го)');
  });

  it('does not throw without next_due_date and without day_of_month', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 1 })).toBe('каждый месяц');
  });
});

describe('intervalUnitLabel', () => {
  it('produces the correct form at the 1/2/5/11/21 boundaries', () => {
    expect(intervalUnitLabel('daily', 1)).toBe('день');
    expect(intervalUnitLabel('daily', 2)).toBe('дня');
    expect(intervalUnitLabel('daily', 5)).toBe('дней');
    expect(intervalUnitLabel('daily', 11)).toBe('дней');
    expect(intervalUnitLabel('daily', 21)).toBe('день');
  });

  it('knows all four frequencies', () => {
    expect(intervalUnitLabel('weekly', 5)).toBe('недель');
    expect(intervalUnitLabel('monthly', 5)).toBe('месяцев');
    expect(intervalUnitLabel('yearly', 5)).toBe('лет');
  });
});

describe('FREQUENCY_OPTIONS', () => {
  it('contains all four API contract values in the right order', () => {
    expect(FREQUENCY_OPTIONS.map((o) => o.value)).toEqual(['daily', 'weekly', 'monthly', 'yearly']);
  });
});

describe('formatDayMonth', () => {
  const currentYear = new Date().getFullYear();

  it('a date in the current year omits the year', () => {
    expect(formatDayMonth(`${currentYear}-09-15`)).toBe('15 сентября');
  });

  it('a date outside the current year shows the year', () => {
    expect(formatDayMonth(`${currentYear + 1}-09-15`)).toBe(`15 сентября ${currentYear + 1}`);
  });

  it('an empty or invalid value does not throw', () => {
    expect(formatDayMonth('')).toBe('');
    expect(formatDayMonth(undefined)).toBe('');
  });
});

describe('todayDateString', () => {
  it('returns the YYYY-MM-DD format', () => {
    expect(todayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('describeDueDate', () => {
  const base = '2026-08-15';

  it('a past date — overdue tone, text "overdue ..."', () => {
    expect(describeDueDate('2026-08-12', base)).toEqual({
      text: 'просрочен 12 августа',
      tone: 'overdue',
    });
    expect(describeDueDate('2026-08-14', base)).toEqual({
      text: 'просрочен 14 августа',
      tone: 'overdue',
    });
  });

  it('today — today tone, text "today, ..."', () => {
    expect(describeDueDate('2026-08-15', base)).toEqual({
      text: 'сегодня, 15 августа',
      tone: 'today',
    });
  });

  it('tomorrow — tomorrow tone, text "tomorrow, ..."', () => {
    expect(describeDueDate('2026-08-16', base)).toEqual({
      text: 'завтра, 16 августа',
      tone: 'tomorrow',
    });
  });

  it('a date in 2–3 days — soon tone, text "in N days · ..."', () => {
    expect(describeDueDate('2026-08-17', base)).toEqual({
      text: 'через 2 дня · 17 августа',
      tone: 'soon',
    });
    expect(describeDueDate('2026-08-18', base)).toEqual({
      text: 'через 3 дня · 18 августа',
      tone: 'soon',
    });
  });

  it('a future date (> 3 days) — future tone, text "next ..."', () => {
    expect(describeDueDate('2026-08-22', base)).toEqual({
      text: 'следующий 22 августа',
      tone: 'future',
    });
    expect(describeDueDate('2026-09-12', base)).toEqual({
      text: 'следующий 12 сентября',
      tone: 'future',
    });
  });

  it('empty and invalid dates are handled without throwing', () => {
    expect(describeDueDate('', base)).toEqual({ text: '', tone: 'future' });
    expect(describeDueDate(undefined, base)).toEqual({ text: '', tone: 'future' });
  });
});

