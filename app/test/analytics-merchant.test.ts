// Merchant labels in Analytics. Synthetic store strings only: no receipt rows.
import { describe, expect, it } from 'vitest';
import { MERCHANT_RULES, normMerchant } from '../src/worker/analytics';

const CASES: readonly [string, string][] = [
  ['GUBERNIJA', 'GUBERNIJA'],
  ['Gubernija d.o.o.', 'Gubernija d.o.o.'],
  ['Uber', 'Uber'],
  ['UBER EATS', 'Uber'],
  ['Uber Eats', 'Uber'],
  ['UBER *TRIP', 'Uber'],
  ['UBER* TRIP HELP.UBER.COM', 'Uber'],
  ['UPPER*TRIP', 'UPPER*TRIP'],
  ['Pošta Srbije', 'Pošta Srbije'],
  ['POSTA SRBIJE', 'Pošta Srbije'],
  ['ПОШТА', 'Pošta Srbije'],
  ['ПОШТА СРБИЈЕ', 'Pošta Srbije'],
  ['Sample Toy Shop', 'Sample Toy Shop'],
  ['Губернија', 'Губернија'],
  ['Макси', 'Макси'],
  ['DR.MAX', 'Dr. Max'],
  ['Dr.Max', 'Dr. Max'],
  ['DR. MAX', 'Dr. Max'],
  ['dr. max pharmacy', 'Dr. Max'],
  ['DR.MAX PHARMACY', 'Dr. Max'],
  ['A.B. DR.MAX', 'Dr. Max'],
  // The dot in DR.MAX is literal. A letter glued on the right is not that needle;
  // MAXI then matches on its own boundary.
  ['DRXMAX', 'DRXMAX'],
  ['DR.MAXI', 'Maxi'],
  ['DR. MAXI', 'Maxi'],
  ['PINEAPPLE', 'PINEAPPLE'],
  ['ХПОШТА', 'ХПОШТА'],
  // `_` and `-` are not Unicode letters or digits, so they are boundaries.
  ['UBER_TRIP', 'Uber'],
  ['UBER-TRIP', 'Uber'],
  ['UBER1', 'UBER1'],
  ['1UBER', '1UBER'],
];

const STORE_SHAPES: readonly [string, string, string][] = MERCHANT_RULES.flatMap(
  ([needle, canon]) => [
    ['alone', needle, canon],
    ['lower case', needle.toLowerCase(), canon],
    ['word before', `PAY ${needle}`, canon],
    ['word after', `${needle} DOO`, canon],
    ['punctuation before', `SQ*${needle}`, canon],
    ['dot after', `${needle}.RS`, canon],
  ],
);

describe('normMerchant', () => {
  it.each(CASES)('maps %j to %j', (raw, expected) => {
    expect(normMerchant(raw)).toBe(expected);
  });

  it.each(STORE_SHAPES)('%s %j maps to %j', (_shape, raw, canon) => {
    expect(normMerchant(raw)).toBe(canon);
  });

  it.each(MERCHANT_RULES)('does not match %j glued inside letters', (needle, canon) => {
    expect(normMerchant(`Q${needle}Z`)).not.toBe(canon);
  });

  it('keeps the unmatched comma cut and 28-character truncation', () => {
    expect(normMerchant('LOCAL KIOSK, BRANCH 2')).toBe('LOCAL KIOSK');
    expect(normMerchant('Z'.repeat(40))).toBe(`${'Z'.repeat(27)}…`);
    expect(normMerchant(null)).toBe('—');
    expect(normMerchant(undefined)).toBe('—');
    expect(normMerchant('')).toBe('—');
    expect(normMerchant('   ')).toBe('—');
  });
});
