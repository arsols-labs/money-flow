// Collapsed-block state of the "Data" screen (issue #260).
//
// No DOM is needed here: parsing and writing are extracted as pure functions in
// dataSections.js, the same way account-form hints already are
// (accounts.js). The screen itself was checked live in the browser — the rule about browser
// checks of screens.
//
// These functions earned a separate test from one line of the requirement: "localStorage
// may be unavailable (private mode) — a missing store must not
// crash the screen". A store that throws is reproduced by hand exactly
// here, and never in the browser at hand.
import { describe, expect, it } from 'vitest';
import {
  DATA_SECTION_KEYS,
  DATA_SECTIONS_STORAGE_KEY,
  parseExpanded,
  serializeExpanded,
  readExpanded,
  writeExpanded,
  toggleExpanded,
  sectionFromHash,
} from '../src/ui/dataSections.js';

function fakeStorage(initial?: string) {
  const box: { value: string | null } = { value: initial ?? null };
  return {
    box,
    getItem: (key: string) => (key === DATA_SECTIONS_STORAGE_KEY ? box.value : null),
    setItem: (key: string, value: string) => {
      if (key === DATA_SECTIONS_STORAGE_KEY) box.value = value;
    },
  };
}

const throwingStorage = {
  getItem() { throw new Error('SecurityError: доступ к хранилищу запрещён'); },
  setItem() { throw new Error('QuotaExceededError'); },
};

describe('parseExpanded', () => {
  it('reads a saved set of keys', () => {
    expect(parseExpanded('["operations","accounts"]')).toEqual(['operations', 'accounts']);
  });

  it('returns keys in canonical order, not in write order', () => {
    expect(parseExpanded('["accounts","operations"]')).toEqual(['operations', 'accounts']);
  });

  it('an empty or missing value means everything is collapsed', () => {
    expect(parseExpanded(null)).toEqual([]);
    expect(parseExpanded('')).toEqual([]);
  });

  it('a broken record does not crash parsing and yields the default', () => {
    expect(parseExpanded('{не json')).toEqual([]);
    expect(parseExpanded('"operations"')).toEqual([]);
    expect(parseExpanded('null')).toEqual([]);
    expect(parseExpanded('{"operations":true}')).toEqual([]);
  });

  it('an unknown key is dropped — a block may have been renamed', () => {
    expect(parseExpanded('["expenses","operations"]')).toEqual(['operations']);
  });
});

describe('serializeExpanded', () => {
  it('writes only known keys, and in canonical order', () => {
    expect(serializeExpanded(['accounts', 'expenses', 'operations']))
      .toBe('["operations","accounts"]');
  });

  it('an empty set is valid JSON, not an empty string', () => {
    expect(serializeExpanded([])).toBe('[]');
  });
});

describe('readExpanded / writeExpanded', () => {
  it('write and read agree', () => {
    const storage = fakeStorage();
    writeExpanded(['planned'], storage);
    expect(storage.box.value).toBe('["planned"]');
    expect(readExpanded(storage)).toEqual(['planned']);
  });

  it('with no store it reads the default and silently does not write', () => {
    expect(readExpanded(null)).toEqual([]);
    expect(() => writeExpanded(['planned'], null)).not.toThrow();
  });

  it('a throwing store does not crash the screen', () => {
    // Safari private mode: touching localStorage throws SecurityError
    // instead of returning null. The task requirement is that the screen keeps working,
    // just without saving state.
    expect(readExpanded(throwingStorage)).toEqual([]);
    expect(() => writeExpanded(['rates'], throwingStorage)).not.toThrow();
  });
});

describe('toggleExpanded', () => {
  it('expands and collapses one block without touching the others', () => {
    expect(toggleExpanded([], 'rates')).toEqual(['rates']);
    expect(toggleExpanded(['rates', 'planned'], 'rates')).toEqual(['planned']);
  });

  it('does not mutate the original set', () => {
    const before = ['rates'];
    toggleExpanded(before, 'planned');
    expect(before).toEqual(['rates']);
  });
});

describe('DATA_SECTION_KEYS', () => {
  it('lists exactly six collapsible blocks — "Forecast" does not collapse', () => {
    expect(DATA_SECTION_KEYS).toEqual(['operations', 'receipts', 'planned', 'recurring', 'rates', 'accounts']);
  });
});

describe('sectionFromHash', () => {
  it('recognizes deep links of known sections', () => {
    expect(sectionFromHash('#/data/rates')).toBe('rates');
    expect(sectionFromHash('#/data/accounts')).toBe('accounts');
    expect(sectionFromHash('#/data/receipts')).toBe('receipts');
    expect(sectionFromHash('#/data/operations')).toBe('operations');
    expect(sectionFromHash('#/data/planned')).toBe('planned');
    expect(sectionFromHash('#/data/recurring')).toBe('recurring');
  });

  it('returns null for invalid or unknown hashes', () => {
    expect(sectionFromHash('#/data')).toBeNull();
    expect(sectionFromHash('#/data/')).toBeNull();
    expect(sectionFromHash('#/data/unknown')).toBeNull();
    expect(sectionFromHash('#/analytics')).toBeNull();
    expect(sectionFromHash('')).toBeNull();
    expect(sectionFromHash(null)).toBeNull();
    expect(sectionFromHash(undefined)).toBeNull();
  });
});

