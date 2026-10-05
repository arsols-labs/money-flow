// Parsing money input on the client (S1-2, issue #196).
//
// Why this is tested at all, even though "CRUD and UI are smoke" per the spec: this is
// where the user types amounts by hand, and an error here silently distorts the balance
// the whole forecast rests on. `19.99 * 100 === 1998.9999999999998` is exactly
// the case the tests must pin down forever.
//
// It runs in the same workerd pool as the other v2 tests; no DOM is
// needed here — money.js works with strings and Intl.
import './use-ru-i18n';
import { describe, expect, it } from 'vitest';
import {
  parseAmountToMinor,
  minorToInputString,
  normalizeRateInput,
  fractionDigits,
  formatMajor,
  formatMajorCompact,
} from '../src/ui/money.js';

describe('fractionDigits', () => {
  it('knows the scale of ordinary currencies', () => {
    expect(fractionDigits('USD')).toBe(2);
    expect(fractionDigits('EUR')).toBe(2);
    expect(fractionDigits('RUB')).toBe(2);
    expect(fractionDigits('JPY')).toBe(0);
    expect(fractionDigits('KWD')).toBe(3);
    expect(fractionDigits('CLF')).toBe(4);
  });

  // A separate test, because this is not an abstract edge: the owner has
  // dinar accounts, and CLDR (that is, Intl) reports 0 fraction digits for RSD contrary to
  // ISO 4217. The answer must come from our table, not from the browser ICU.
  it('gives RSD two digits — ISO 4217, not CLDR', () => {
    expect(fractionDigits('RSD')).toBe(2);
  });

  it('does not throw on an unknown code and returns two digits', () => {
    expect(fractionDigits('ZZZ')).toBe(2);
    expect(fractionDigits('')).toBe(2);
    expect(fractionDigits(undefined)).toBe(2);
  });
});

describe('parseAmountToMinor', () => {
  it.each([
    ['19.99', 'USD', 1999],
    // A comma — as it is typed on a Russian keyboard layout.
    ['19,99', 'USD', 1999],
    ['0.05', 'USD', 5],
    ['.5', 'USD', 50],
    ['1 200.5', 'USD', 120050],
    ['  1200  ', 'USD', 120000],
    ['-5.5', 'USD', -550],
    ['0', 'USD', 0],
    ['-0.00', 'USD', 0],
    // A currency with no fractional part: the minor unit equals the major unit.
    ['1200', 'JPY', 1200],
  ])('%s (%s) → %i', (input, currency, expected) => {
    expect(parseAmountToMinor(input, currency)).toBe(expected);
  });

  it('does not lose cents on float-unsafe values', () => {
    // For each of these values `Number(x) * 100` produces a tail like
    // 1998.9999999999998 or 823.9999999999999 — string parsing must
    // yield a clean integer.
    for (const [input, expected] of [
      ['19.99', 1999],
      ['0.07', 7],
      ['1.1', 110],
      ['8.24', 824],
      ['35.41', 3541],
    ] as const) {
      expect(parseAmountToMinor(input, 'USD')).toBe(expected);
    }
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['letters', 'abc'],
    ['two dots', '1.2.3'],
    ['a lone minus', '-'],
    ['a lone dot', '.'],
    ['extra digit for a two-decimal currency', '1.999'],
  ])('rejects: %s', (_label, input) => {
    expect(() => parseAmountToMinor(input, 'USD')).toThrow();
  });

  it('rejects an amount beyond an exact integer instead of rounding silently', () => {
    expect(() => parseAmountToMinor('999999999999999999', 'USD')).toThrow(/Слишком большая/);
  });

  it('for a currency with no fractional part an extra digit is an error', () => {
    expect(() => parseAmountToMinor('1200.5', 'JPY')).toThrow();
  });
});

describe('minorToInputString', () => {
  it.each([
    [1999, 'USD', '19.99'],
    [5, 'USD', '0.05'],
    [0, 'USD', '0.00'],
    [-550, 'USD', '-5.50'],
    [1200, 'JPY', '1200'],
  ])('%i (%s) → %s', (minor, currency, expected) => {
    expect(minorToInputString(minor, currency)).toBe(expected);
  });

  it('round-trip: string → minor → string does not change the value', () => {
    for (const value of ['19.99', '0.05', '-5.50', '1200.00']) {
      const minor = parseAmountToMinor(value, 'USD');
      expect(parseAmountToMinor(minorToInputString(minor, 'USD'), 'USD')).toBe(minor);
    }
  });
});

describe('formatMajorCompact (issue #582)', () => {
  it('keeps thousands grouping instead of stripping the group as cents', () => {
    // The old axis formatter: formatMajor(v).replace(/[.,]\d+/, '') —
    // on en-US `$17,521.60` turned into `$17.60`.
    const fullEn = formatMajor(17521.60, 'USD', 'en-US');
    expect(fullEn.replace(/[.,]\d+/, '')).toBe('$17.60');
    expect(formatMajorCompact(17521.60, 'USD', 'en-US')).toBe('$17,522');
    expect(formatMajorCompact(5000, 'USD', 'en-US')).toBe('$5,000');
    expect(formatMajorCompact(0, 'USD', 'en-US')).toBe('$0');
  });

  it('keeps grouping in ru-RU compact labels', () => {
    const compact = formatMajorCompact(17521.60, 'USD', 'ru-RU');
    expect(compact).toMatch(/17/);
    expect(compact).toMatch(/522/);
    expect(compact.replace(/\s/g, '')).not.toMatch(/^17[.,]60/);
  });
});

describe('normalizeRateInput', () => {
  it('accepts a rate with nine digits and normalizes a comma', () => {
    expect(normalizeRateInput('0.0092')).toBe('0.0092');
    expect(normalizeRateInput(' 0,0092 ')).toBe('0.0092');
    expect(normalizeRateInput('0.000000001')).toBe('0.000000001');
    expect(normalizeRateInput('1')).toBe('1');
  });

  it.each([
    ['zero', '0'],
    ['zero with a zero fraction', '0.000'],
    ['negative', '-1'],
    ['ten digits after the dot', '0.0000000001'],
    ['exponent', '1e5'],
    ['letters', 'abc'],
    ['empty', ''],
  ])('rejects: %s', (_label, input) => {
    expect(() => normalizeRateInput(input)).toThrow();
  });
});
