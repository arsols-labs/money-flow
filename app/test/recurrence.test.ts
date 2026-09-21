// Помощники секций «Плановые»/«Регулярные» (S1-3, issue #197).
//
// describeRecurrence — единственное место, где день/месяц правила читаются из
// next_due_date, а не из отдельных полей формы (day_of_month/month_of_year
// сервер выводит сам и форма их не шлёт) — ошибка здесь показывает владельцу
// неверную человеческую расшифровку правила, которое реально хранится.
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
  it('daily, интервал 1', () => {
    expect(describeRecurrence({ frequency: 'daily', interval_count: 1, next_due_date: '2026-09-01' }))
      .toBe('каждый день');
  });

  it('daily, интервал N со склонением (5 → дней)', () => {
    expect(describeRecurrence({ frequency: 'daily', interval_count: 5, next_due_date: '2026-09-01' }))
      .toBe('раз в 5 дней');
  });

  it('daily, интервал 3 со склонением (2–4 → дня)', () => {
    expect(describeRecurrence({ frequency: 'daily', interval_count: 3, next_due_date: '2026-09-01' }))
      .toBe('раз в 3 дня');
  });

  it('weekly, интервал 1', () => {
    expect(describeRecurrence({ frequency: 'weekly', interval_count: 1, next_due_date: '2026-09-01' }))
      .toBe('каждую неделю');
  });

  it('weekly, интервал 2 (раз в 2 недели)', () => {
    expect(describeRecurrence({ frequency: 'weekly', interval_count: 2, next_due_date: '2026-09-01' }))
      .toBe('раз в 2 недели');
  });

  it('weekly, интервал 21 (склонение по последней цифре, не по числу целиком)', () => {
    expect(describeRecurrence({ frequency: 'weekly', interval_count: 21, next_due_date: '2026-09-01' }))
      .toBe('раз в 21 неделю');
  });

  it('monthly, день месяца без прижатия', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 1, day_of_month: 15, next_due_date: '2026-09-15' }))
      .toBe('каждый месяц 15 числа');
  });

  it('monthly, интервал N + день месяца', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 2, day_of_month: 1, next_due_date: '2026-09-01' }))
      .toBe('раз в 2 месяца 1 числа');
  });

  it('monthly, day_of_month прижат к фактическому дню (31-е → 28 февраля)', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 1, day_of_month: 31, next_due_date: '2026-02-28' }))
      .toBe('каждый месяц 31 числа (в этом месяце — 28-го)');
  });

  it('yearly, день и месяц берутся из next_due_date', () => {
    expect(describeRecurrence({ frequency: 'yearly', interval_count: 1, day_of_month: 29, next_due_date: '2028-02-29' }))
      .toBe('каждый год 29 февраля');
  });

  it('yearly, интервал N', () => {
    expect(describeRecurrence({ frequency: 'yearly', interval_count: 5, day_of_month: 1, next_due_date: '2026-01-01' }))
      .toBe('раз в 5 лет 1 января');
  });

  // Формулировка у годового правила своя: месяц у него один и тот же всегда,
  // прижимается только день, поэтому «в этом месяце» было бы неверно — речь о
  // ближайшем платеже, а не о текущем месяце.
  it('yearly, day_of_month прижат к фактическому дню (29 февраля → 28-е в невисокосный год)', () => {
    expect(describeRecurrence({ frequency: 'yearly', interval_count: 1, day_of_month: 29, next_due_date: '2027-02-28' }))
      .toBe('каждый год 29 февраля (ближайший раз — 28-го)');
  });

  it('без next_due_date и без day_of_month не падает', () => {
    expect(describeRecurrence({ frequency: 'monthly', interval_count: 1 })).toBe('каждый месяц');
  });
});

describe('intervalUnitLabel', () => {
  it('монтирует правильную форму на границах 1/2/5/11/21', () => {
    expect(intervalUnitLabel('daily', 1)).toBe('день');
    expect(intervalUnitLabel('daily', 2)).toBe('дня');
    expect(intervalUnitLabel('daily', 5)).toBe('дней');
    expect(intervalUnitLabel('daily', 11)).toBe('дней');
    expect(intervalUnitLabel('daily', 21)).toBe('день');
  });

  it('знает все четыре периодичности', () => {
    expect(intervalUnitLabel('weekly', 5)).toBe('недель');
    expect(intervalUnitLabel('monthly', 5)).toBe('месяцев');
    expect(intervalUnitLabel('yearly', 5)).toBe('лет');
  });
});

describe('FREQUENCY_OPTIONS', () => {
  it('содержит все четыре значения контракта API в правильном порядке', () => {
    expect(FREQUENCY_OPTIONS.map((o) => o.value)).toEqual(['daily', 'weekly', 'monthly', 'yearly']);
  });
});

describe('formatDayMonth', () => {
  const currentYear = new Date().getFullYear();

  it('дата в текущем году — без года', () => {
    expect(formatDayMonth(`${currentYear}-09-15`)).toBe('15 сентября');
  });

  it('дата не в текущем году — год показан', () => {
    expect(formatDayMonth(`${currentYear + 1}-09-15`)).toBe(`15 сентября ${currentYear + 1}`);
  });

  it('пустое/некорректное значение не падает', () => {
    expect(formatDayMonth('')).toBe('');
    expect(formatDayMonth(undefined)).toBe('');
  });
});

describe('todayDateString', () => {
  it('возвращает формат YYYY-MM-DD', () => {
    expect(todayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('describeDueDate', () => {
  const base = '2026-08-15';

  it('дата в прошлом — тон overdue, текст «просрочен ...»', () => {
    expect(describeDueDate('2026-08-12', base)).toEqual({
      text: 'просрочен 12 августа',
      tone: 'overdue',
    });
    expect(describeDueDate('2026-08-14', base)).toEqual({
      text: 'просрочен 14 августа',
      tone: 'overdue',
    });
  });

  it('дата сегодня — тон today, текст «сегодня, ...»', () => {
    expect(describeDueDate('2026-08-15', base)).toEqual({
      text: 'сегодня, 15 августа',
      tone: 'today',
    });
  });

  it('дата завтра — тон tomorrow, текст «завтра, ...»', () => {
    expect(describeDueDate('2026-08-16', base)).toEqual({
      text: 'завтра, 16 августа',
      tone: 'tomorrow',
    });
  });

  it('дата через 2-3 дня — тон soon, текст «через N дня · ...»', () => {
    expect(describeDueDate('2026-08-17', base)).toEqual({
      text: 'через 2 дня · 17 августа',
      tone: 'soon',
    });
    expect(describeDueDate('2026-08-18', base)).toEqual({
      text: 'через 3 дня · 18 августа',
      tone: 'soon',
    });
  });

  it('дата в будущем (> 3 дней) — тон future, текст «следующий ...»', () => {
    expect(describeDueDate('2026-08-22', base)).toEqual({
      text: 'следующий 22 августа',
      tone: 'future',
    });
    expect(describeDueDate('2026-09-12', base)).toEqual({
      text: 'следующий 12 сентября',
      tone: 'future',
    });
  });

  it('пустые и некорректные даты обрабатываются без падения', () => {
    expect(describeDueDate('', base)).toEqual({ text: '', tone: 'future' });
    expect(describeDueDate(undefined, base)).toEqual({ text: '', tone: 'future' });
  });
});

