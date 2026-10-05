import { describe, expect, it } from 'vitest';
import { buildCurrencyOptions } from '../src/ui/components';

describe('buildCurrencyOptions (issue #403)', () => {
  it('collects unique account currencies and sorts them', () => {
    const accounts = [
      { currency: 'USD' },
      { currency: 'eur' }, // case is not normalized here — just a dedup by string
      { currency: 'RSD' },
      { currency: 'USD' }, // duplicate
      { currency: 'eur' },
    ];
    expect(buildCurrencyOptions(accounts, null)).toEqual(['RSD', 'USD', 'eur']);
  });

  it('drops empty/missing account currencies', () => {
    const accounts = [
      { currency: 'USD' },
      { currency: '' },
      { currency: null },
      {},
    ];
    expect(buildCurrencyOptions(accounts, null)).toEqual(['USD']);
  });

  it('adds the current base currency even if it is not among the accounts', () => {
    const accounts = [{ currency: 'RSD' }, { currency: 'EUR' }];
    // The current base came from settings but does not appear on any account (for example,
    // the currency was changed and the accounts are still in the old one). It must stay in the list.
    expect(buildCurrencyOptions(accounts, 'USD')).toEqual(['EUR', 'RSD', 'USD']);
  });

  it('does not duplicate the current base if it is already among the accounts', () => {
    const accounts = [{ currency: 'USD' }, { currency: 'EUR' }];
    expect(buildCurrencyOptions(accounts, 'USD')).toEqual(['EUR', 'USD']);
  });

  it('returns an empty list with no current base and accounts that have no currencies', () => {
    expect(buildCurrencyOptions([{}, { currency: '' }], null)).toEqual([]);
  });

  it('handles null/undefined instead of an account list', () => {
    expect(buildCurrencyOptions(null, 'USD')).toEqual(['USD']);
    expect(buildCurrencyOptions(undefined, null)).toEqual([]);
  });
});
