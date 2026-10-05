// Account form suggestions (issue #235): the default name and the search for a similar account.
//
// Neither suggestion forbids anything, and the cost of a mistake differs. The name is
// a starting value: if it overwrote what was typed by hand, the owner would lose that input
// silently. A similar account is a warning: a missed duplicate of the triple yields two
// accounts that look the same, and the forecast (S1-4) would show their balances drifting
// apart, while an extra warning on a name-only match trains the owner
// to ignore it — the rule allows identical names.
//
// The DOM is not needed here: the logic lives in pure functions in accounts.js, and the tests
// run in the same workerd pool as the other v2 tests. Form rendering
// was checked live in the browser (the rule about checking screens in the browser).
import { describe, expect, it } from 'vitest';
import { suggestAccountName, suggestedNameUpdate, findSimilarAccount } from '../src/ui/accounts.js';

describe('suggestAccountName', () => {
  it('builds "Type · Currency · Country"', () => {
    expect(suggestAccountName({ type: 'Наличные', currency: 'USD', country: 'США' }))
      .toBe('Наличные · USD · США');
  });

  it('uppercases the currency and trims leading and trailing whitespace', () => {
    expect(suggestAccountName({ type: '  Наличные ', currency: ' usd ', country: ' Global ' }))
      .toBe('Наличные · USD · Global');
  });

  it('does not put the owner into the name — the owner is the card label, not part of the name', () => {
    expect(suggestAccountName({ type: 'Наличные', currency: 'EUR', country: 'Global', owner: 'User' }))
      .toBe('Наличные · EUR · Global');
  });

  it('stays silent while the triple is incomplete', () => {
    expect(suggestAccountName({ type: 'Наличные', currency: 'USD', country: '' })).toBe('');
    expect(suggestAccountName({ type: '', currency: 'USD', country: 'США' })).toBe('');
    expect(suggestAccountName({ type: 'Наличные', currency: '   ', country: 'США' })).toBe('');
    expect(suggestAccountName({})).toBe('');
  });
});

describe('suggestedNameUpdate', () => {
  const full = { type: 'Наличные', currency: 'USD', country: 'США', name: '' };

  it('fills in the name while the owner has not touched it', () => {
    expect(suggestedNameUpdate(full, { touched: false })).toBe('Наличные · USD · США');
  });

  // The main test in this file: hand-typed input is never overwritten.
  it('does not overwrite manual input', () => {
    expect(suggestedNameUpdate({ ...full, name: 'Кошелёк' }, { touched: true })).toBeNull();
  });

  // Cleared to empty is manual input too: the suggestion sets a starting
  // value, not a format, and must not come back after it is deleted.
  it('does not restore a name that was cleared', () => {
    expect(suggestedNameUpdate({ ...full, name: '' }, { touched: true })).toBeNull();
  });

  it('does not touch the field when it already holds exactly the suggestion', () => {
    expect(suggestedNameUpdate({ ...full, name: 'Наличные · USD · США' }, { touched: false })).toBeNull();
  });

  it('updates the suggestion when the currency changes', () => {
    expect(suggestedNameUpdate({ ...full, currency: 'EUR', name: 'Наличные · USD · США' }, { touched: false }))
      .toBe('Наличные · EUR · США');
  });

  it('an incomplete triple does not clear what is already in the field', () => {
    expect(suggestedNameUpdate({ ...full, currency: '', name: 'Наличные · USD · США' }, { touched: false }))
      .toBeNull();
  });
});

describe('findSimilarAccount', () => {
  const accounts = [
    { id: 1, name: 'Кошелёк', owner: 'User', currency: 'USD', country: 'Global', archived: false },
    { id: 2, name: 'Основной', owner: 'User', currency: 'EUR', country: 'Германия', archived: false },
    { id: 3, name: 'Старый сейф', owner: 'User', currency: 'USD', country: 'США', archived: true },
  ];

  it('finds the account with the same triple (owner, currency, country)', () => {
    const found = findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: 'Global', name: 'Дома в сейфе' });
    expect(found?.name).toBe('Кошелёк');
  });

  it('compares case-insensitively, ignoring leading and trailing whitespace', () => {
    const found = findSimilarAccount(accounts, { owner: ' user ', currency: 'usd', country: 'GLOBAL ' });
    expect(found?.id).toBe(1);
  });

  it('a match on the name alone is not treated as a similar account', () => {
    // The name is the same, the triple is different (currency). The rule allows identical names,
    // so there is nothing to warn about here.
    expect(findSimilarAccount(accounts, { name: 'Кошелёк', owner: 'User', currency: 'EUR', country: 'Global' })).toBeNull();
  });

  it('tells accounts apart on each of the three dimensions', () => {
    expect(findSimilarAccount(accounts, { owner: 'Мария', currency: 'USD', country: 'Global' })).toBeNull();
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'EUR', country: 'Global' })).toBeNull();
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: 'США' })).toBeNull();
  });

  it('archived accounts do not count', () => {
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: 'США' })).toBeNull();
  });

  it('stays silent while the triple is incomplete', () => {
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: '' })).toBeNull();
    expect(findSimilarAccount(accounts, {})).toBeNull();
  });

  it('survives an empty list', () => {
    expect(findSimilarAccount([], { owner: 'User', currency: 'USD', country: 'Global' })).toBeNull();
    expect(findSimilarAccount(undefined, { owner: 'User', currency: 'USD', country: 'Global' })).toBeNull();
  });
});
