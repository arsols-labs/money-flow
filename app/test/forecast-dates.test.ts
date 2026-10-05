// Unit tests of the financial date calendar (issue #198). Ported from
// archive/v2-codex (app/test/dates.test.ts): only the entry point changed
// (src/worker/forecast/dates.ts) and isoDayOfWeek was removed — nothing in v2
// uses it, so there is no reason to carry dead code.
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
  it('epoch day: 1970-01-01 = 0, the reverse conversion round-trips', () => {
    expect(isoDateToEpochDay('1970-01-01')).toBe(0);
    expect(epochDayToIsoDate(0)).toBe('1970-01-01');
    expect(epochDayToIsoDate(isoDateToEpochDay('2026-07-23'))).toBe('2026-07-23');
    expect(epochDayToIsoDate(isoDateToEpochDay('2000-02-29'))).toBe('2000-02-29');
  });

  it('addDays across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    expect(addDays('2026-07-23', 180)).toBe('2027-01-19');
  });

  it('diffDays', () => {
    expect(diffDays('2026-07-23', '2026-07-30')).toBe(7);
    expect(diffDays('2026-07-30', '2026-07-23')).toBe(-7);
  });

  it('clamps 29–31 to the last day of the month', () => {
    expect(clampedDate(2026, 2, 31)).toBe('2026-02-28');
    expect(clampedDate(2024, 2, 30)).toBe('2024-02-29');
    expect(clampedDate(2026, 4, 31)).toBe('2026-04-30');
    expect(clampedDate(2026, 1, 31)).toBe('2026-01-31');
    expect(() => clampedDate(2026, 1, 0)).toThrow(RangeError);
    expect(() => clampedDate(2026, 1, 32)).toThrow(RangeError);
  });

  it('isIsoDateString rejects nonexistent dates and garbage', () => {
    expect(isIsoDateString('2026-07-23')).toBe(true);
    expect(isIsoDateString('2026-02-30')).toBe(false);
    expect(isIsoDateString('2023-02-29')).toBe(false); // not a leap year
    expect(isIsoDateString('2026-13-01')).toBe(false);
    expect(isIsoDateString('2026-7-3')).toBe(false);
    expect(isIsoDateString('20260723')).toBe(false);
    expect(isIsoDateString(null)).toBe(false);
  });

  it('daysInMonth', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28); // a century year is not a leap year
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400 — a leap year
  });

  it('formatIsoDate refuses outside 0001–9999 instead of emitting a non-ISO string', () => {
    // Year 0 and a negative year produced '0000-…' / '00-1-…': such a string does not
    // match ISO_DATE_RE and compares lexicographically with every
    // other date incorrectly — that is, it quietly breaks any `date <= limit`.
    expect(() => formatIsoDate({ year: 0, month: 1, day: 1 })).toThrow(RangeError);
    expect(() => formatIsoDate({ year: -1, month: 1, day: 1 })).toThrow(RangeError);
    expect(() => formatIsoDate({ year: 10000, month: 1, day: 1 })).toThrow(RangeError);
    expect(formatIsoDate({ year: 1, month: 1, day: 1 })).toBe('0001-01-01');
    expect(formatIsoDate({ year: 9999, month: 12, day: 31 })).toBe('9999-12-31');
    // The same barrier on derived functions: stepping past the edge of the calendar is a refusal.
    expect(() => addDays('9999-12-31', 1)).toThrow(RangeError);
    expect(() => addDays('0001-01-01', -1)).toThrow(RangeError);
  });
});

describe('year zero is rejected on input, not on output', () => {
  it('isIsoDateString does not let 0000 through, in agreement with formatIsoDate', () => {
    // Previously the regex and daysInMonth accepted year 0000, the date passed
    // validation and was stored (SQLite also considers date('0000-01-01')
    // valid), and it failed later — on addDays/forecast, when
    // formatIsoDate reached its 0001–9999 boundary.
    expect(isIsoDateString('0000-01-01')).toBe(false);
    expect(isIsoDateString('0000-12-31')).toBe(false);
    expect(isIsoDateString('0001-01-01')).toBe(true);
    expect(isIsoDateString('9999-12-31')).toBe(true);
    // The boundary is one: whatever passed validation formats without an exception.
    expect(() => addDays('0001-01-01', 0)).not.toThrow();
  });
});
