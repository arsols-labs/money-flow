// Currency sign in the header and flag+code in the list — UI standard v2, 2026-08-21.
//
// The sign comes from ICU, not from our own table: the owner's currency list is open
// (RSD today, any other tomorrow), and maintaining a copy of the catalog
// is guaranteed to fall behind it. The test pins down behavior, not a table:
// what the function does when there is no sign, when the "sign" is actually long, and what
// is returned instead of a flag for supranational codes.
import { describe, expect, it } from 'vitest';
import {
  currencySymbol, currencyFlag, GENERIC_CURRENCY_SIGN, GENERIC_CURRENCY_FLAG,
} from '../src/ui/currency-sign.js';

describe('currencySymbol', () => {
  it('returns a single-character sign for currencies that have one', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('RUB')).toBe('₽');
    expect(currencySymbol('GBP')).toBe('£');
  });

  it('does not depend on the case of the code', () => {
    expect(currencySymbol('usd')).toBe('$');
    expect(currencySymbol('eur')).toBe('€');
  });

  // Owner's requirement: "if there is no symbol, put some unique
  // single-character sign". ¤ (U+00A4) is the standard "currency" placeholder,
  // it is not used by any real currency and therefore will not be confused with one.
  it('substitutes ¤ when there is no sign or it is longer than two glyphs', () => {
    // RSD has no sign of its own in CLDR — ICU returns the code itself.
    expect(currencySymbol('RSD')).toBe(GENERIC_CURRENCY_SIGN);
    expect(currencySymbol('XAU')).toBe(GENERIC_CURRENCY_SIGN);
    expect(currencySymbol('')).toBe(GENERIC_CURRENCY_SIGN);
    expect(currencySymbol(null)).toBe(GENERIC_CURRENCY_SIGN);
    // A code that certainly does not exist must not crash the header with an exception.
    expect(currencySymbol('ZZZ')).toBe(GENERIC_CURRENCY_SIGN);
  });

  it('never returns the currency code itself instead of a sign', () => {
    for (const code of ['USD', 'EUR', 'RSD', 'XAU', 'KZT', 'AMD', 'ZZZ']) {
      expect(currencySymbol(code)).not.toBe(code);
    }
  });

  it('the sign fits in one or two glyphs — the header button will not blow out', () => {
    for (const code of ['USD', 'EUR', 'RUB', 'PLN', 'SEK', 'RSD', 'JPY']) {
      expect([...currencySymbol(code)].length).toBeLessThanOrEqual(2);
    }
  });
});

describe('currencyFlag', () => {
  it('builds a flag from the first two letters of the code', () => {
    expect(currencyFlag('USD')).toBe('🇺🇸');
    expect(currencyFlag('RUB')).toBe('🇷🇺');
    expect(currencyFlag('RSD')).toBe('🇷🇸');
    expect(currencyFlag('gbp')).toBe('🇬🇧');
  });

  // The euro is not a country: the first two letters of the ISO code EUR give a nonexistent
  // region EU…, so the flag is set explicitly.
  it('the euro gets the EU flag', () => {
    expect(currencyFlag('EUR')).toBe('🇪🇺');
  });

  // Codes starting with X are supranational (metals, SDR, test codes). They have no region,
  // and drawing a "country flag XA" would mean inventing something that does not exist.
  it('supranational codes get a neutral mark', () => {
    expect(currencyFlag('XAU')).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag('XDR')).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag('')).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag(null)).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag('E')).toBe(GENERIC_CURRENCY_FLAG);
  });
});
