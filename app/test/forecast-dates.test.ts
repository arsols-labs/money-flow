// Unit-тесты календаря финансовых дат (issue #198). Портировано из
// archive/v2-codex (app/test/dates.test.ts): изменена только точка входа
// (src/worker/forecast/dates.ts) и убран isoDayOfWeek — в v2 его никто не
// использует, тащить мёртвый код незачем.
import { describe, expect, it } from 'vitest';
import {
  addDays,
  clampedDate,
  daysInMonth,
  diffDays,
  epochDayToIsoDate,
  formatIsoDate,
  isIsoDateString,
  isoDateToEpochDay,
} from '../src/worker/forecast/dates';

describe('dates', () => {
  it('epoch day: 1970-01-01 = 0, обратное преобразование сходится', () => {
    expect(isoDateToEpochDay('1970-01-01')).toBe(0);
    expect(epochDayToIsoDate(0)).toBe('1970-01-01');
    expect(epochDayToIsoDate(isoDateToEpochDay('2026-07-23'))).toBe('2026-07-23');
    expect(epochDayToIsoDate(isoDateToEpochDay('2000-02-29'))).toBe('2000-02-29');
  });

  it('addDays через границы месяца и года', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // високосный
    expect(addDays('2026-07-23', 180)).toBe('2027-01-19');
  });

  it('diffDays', () => {
    expect(diffDays('2026-07-23', '2026-07-30')).toBe(7);
    expect(diffDays('2026-07-30', '2026-07-23')).toBe(-7);
  });

  it('clamp 29–31 к последнему дню месяца', () => {
    expect(clampedDate(2026, 2, 31)).toBe('2026-02-28');
    expect(clampedDate(2024, 2, 30)).toBe('2024-02-29');
    expect(clampedDate(2026, 4, 31)).toBe('2026-04-30');
    expect(clampedDate(2026, 1, 31)).toBe('2026-01-31');
    expect(() => clampedDate(2026, 1, 0)).toThrow(RangeError);
    expect(() => clampedDate(2026, 1, 32)).toThrow(RangeError);
  });

  it('isIsoDateString отвергает несуществующие даты и мусор', () => {
    expect(isIsoDateString('2026-07-23')).toBe(true);
    expect(isIsoDateString('2026-02-30')).toBe(false);
    expect(isIsoDateString('2023-02-29')).toBe(false); // не високосный
    expect(isIsoDateString('2026-13-01')).toBe(false);
    expect(isIsoDateString('2026-7-3')).toBe(false);
    expect(isIsoDateString('20260723')).toBe(false);
    expect(isIsoDateString(null)).toBe(false);
  });

  it('daysInMonth', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28); // столетие не високосное
    expect(daysInMonth(2000, 2)).toBe(29); // 400 — високосное
  });

  it('formatIsoDate отказывает вне 0001–9999, а не выдаёт не-ISO строку', () => {
    // Год 0 и отрицательный давали '0000-…' / '00-1-…': такая строка не
    // совпадает с ISO_DATE_RE и лексикографически сравнивается со всеми
    // остальными датами неверно — то есть тихо ломает любое `date <= limit`.
    expect(() => formatIsoDate({ year: 0, month: 1, day: 1 })).toThrow(RangeError);
    expect(() => formatIsoDate({ year: -1, month: 1, day: 1 })).toThrow(RangeError);
    expect(() => formatIsoDate({ year: 10000, month: 1, day: 1 })).toThrow(RangeError);
    expect(formatIsoDate({ year: 1, month: 1, day: 1 })).toBe('0001-01-01');
    expect(formatIsoDate({ year: 9999, month: 12, day: 31 })).toBe('9999-12-31');
    // Тот же барьер на производных функциях: выход за край календаря — отказ.
    expect(() => addDays('9999-12-31', 1)).toThrow(RangeError);
    expect(() => addDays('0001-01-01', -1)).toThrow(RangeError);
  });
});

describe('год ноль отвергается на входе, а не на выводе', () => {
  it('isIsoDateString не пускает 0000, согласуясь с formatIsoDate', () => {
    // Раньше регулярка и daysInMonth принимали год 0000, дата проходила
    // валидацию и сохранялась (SQLite тоже считает date('0000-01-01')
    // корректной), а падало уже позже — на addDays/прогнозе, когда
    // formatIsoDate доходил до своей границы 0001–9999.
    expect(isIsoDateString('0000-01-01')).toBe(false);
    expect(isIsoDateString('0000-12-31')).toBe(false);
    expect(isIsoDateString('0001-01-01')).toBe(true);
    expect(isIsoDateString('9999-12-31')).toBe(true);
    // Граница едина: то, что прошло валидацию, форматируется без исключения.
    expect(() => addDays('0001-01-01', 0)).not.toThrow();
  });
});
