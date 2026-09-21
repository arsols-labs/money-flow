import { describe, expect, it } from 'vitest';
import {
  expenseLooksLikeDuplicate,
  extractExpenseOrderTokens,
  isAnalyticalSkipOnlyRecurringId,
} from '../src/shared/booking-guards';

describe('booking guards', () => {
  it('treats production analytical ids 16 and 17 as skip-only', () => {
    expect(isAnalyticalSkipOnlyRecurringId(16)).toBe(true);
    expect(isAnalyticalSkipOnlyRecurringId(17)).toBe(true);
    expect(isAnalyticalSkipOnlyRecurringId(1)).toBe(false);
    expect(isAnalyticalSkipOnlyRecurringId(18)).toBe(false);
  });

  it('extracts Wolt/order tokens and matches a recent duplicate', () => {
    expect(extractExpenseOrderTokens(['Wolt order ABC12345', 'note'])).toEqual(['abc12345']);
    const existing = {
      id: 9,
      date: '2026-09-20',
      account_id: 1,
      store: 'Wolt',
      amount_minor: -283169,
      item: 'Wolt order ABC12345',
      comment: null,
      fiscal_receipt_id: null,
    };
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-21',
      account_id: 1,
      store: 'Cafe',
      amount_minor: -100,
      item: 'Dinner',
      comment: 'wolt ABC12345',
      fiscal_receipt_id: null,
    }, existing)).toBe(true);
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Wolt',
      amount_minor: -283169,
      item: 'Cash',
      comment: null,
      fiscal_receipt_id: null,
    }, existing)).toBe(true);
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Maxi',
      amount_minor: -400,
      item: 'Bread',
      comment: null,
      fiscal_receipt_id: null,
    }, existing)).toBe(false);
  });

  it('treats shared fiscal_receipt_id as line-level identity, not a whole-receipt duplicate', () => {
    const existing = {
      id: 11,
      date: '2026-09-20',
      account_id: 1,
      store: 'Aroma',
      amount_minor: -25000,
      item: 'Espresso',
      comment: null,
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    };
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Aroma',
      amount_minor: -18000,
      item: 'Croissant',
      comment: null,
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    }, existing)).toBe(false);
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Aroma',
      amount_minor: -25000,
      item: 'Latte',
      comment: null,
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    }, existing)).toBe(false);
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Aroma',
      amount_minor: -25000,
      item: 'espresso',
      comment: 'same line again',
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    }, existing)).toBe(true);
  });

  it('does not treat a PFR id as a Wolt/order token', () => {
    expect(extractExpenseOrderTokens(['JDEKKL35-GESE6HO0-136069'])).toEqual([]);
    const existing = {
      id: 12,
      date: '2026-09-20',
      account_id: 1,
      store: 'Visitor',
      amount_minor: -1000,
      item: 'Ticket',
      comment: null,
      fiscal_receipt_id: 'M7S63ZDG-M7S63ZDG-17091',
    };
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-21',
      account_id: 1,
      store: 'Other',
      amount_minor: -200,
      item: 'Snack',
      comment: null,
      fiscal_receipt_id: 'M7S63ZDG-M7S63ZDG-17091',
    }, existing)).toBe(false);
  });
});
