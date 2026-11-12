import { describe, expect, it } from 'vitest';
import {
  createExpenseDuplicateIndex,
  expenseLooksLikeDuplicate,
  extractExpenseOrderTokens,
  isAnalyticalSkipOnlyRecurringId,
  type ExpenseDuplicateCandidate,
} from '../src/shared/booking-guards';
import { canonicalFiscalIdentity } from '../src/shared/fiscal-identity';

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
      store: 'Corner Cafe',
      amount_minor: -25000,
      item: 'Espresso',
      comment: null,
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    };
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Corner Cafe',
      amount_minor: -18000,
      item: 'Croissant',
      comment: null,
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    }, existing)).toBe(false);
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Corner Cafe',
      amount_minor: -25000,
      item: 'Latte',
      comment: null,
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    }, existing)).toBe(false);
    expect(expenseLooksLikeDuplicate({
      date: '2026-09-20',
      account_id: 1,
      store: 'Corner Cafe',
      amount_minor: -25000,
      item: 'espresso',
      comment: 'same line again',
      fiscal_receipt_id: 'JDEKKL35-GESE6HO0-136069',
    }, existing)).toBe(true);
  });

  it('accepts a courier fee that shares an order id with a different seller receipt', () => {
    // Synthetic ids only. A 6+ character token is what ORDER_HINT extracts;
    // a shorter code does not, which is why earlier fees were not collided.
    expect(extractExpenseOrderTokens(['Wolt order AB12'])).toEqual([]);
    expect(extractExpenseOrderTokens([
      'Delivery order SYNTH77',
      'Wolt order SYNTH77',
    ])).toEqual(['synth77']);

    const seller = (amount: number, item: string, id: number) => ({
      id,
      date: '2026-10-06',
      account_id: 7,
      store: 'Apoteka Synth',
      amount_minor: amount,
      item,
      comment: 'Delivery order SYNTH77',
      fiscal_receipt_id: 'SYNTH-PFR-SELLER-001',
      receipt_url: 'https://receipts.example.test/seller/synth-001',
    });
    const goodsA = seller(-18900, 'Goods A', 101);
    const goodsB = seller(-79900, 'Goods B', 102);
    const fee: ExpenseDuplicateCandidate = {
      date: '2026-10-06',
      account_id: 7,
      store: 'Wolt d.o.o.',
      amount_minor: -8398,
      item: 'Delivery fee',
      comment: 'Wolt order SYNTH77',
      fiscal_receipt_id: 'SYNTH-PFR-COURIER-002',
      receipt_url: 'https://receipts.example.test/courier/synth-002',
    };

    expect(expenseLooksLikeDuplicate(fee, goodsA)).toBe(false);
    expect(expenseLooksLikeDuplicate(fee, goodsB)).toBe(false);
    expect(createExpenseDuplicateIndex([goodsA, goodsB]).find(fee)).toBeUndefined();

    const sameOrderWithoutDistinctReceipt: ExpenseDuplicateCandidate = {
      ...fee,
      fiscal_receipt_id: null,
      receipt_url: null,
    };
    expect(expenseLooksLikeDuplicate(sameOrderWithoutDistinctReceipt, {
      ...goodsA,
      fiscal_receipt_id: null,
      receipt_url: null,
    })).toBe(true);

    const earlierStyleFee: ExpenseDuplicateCandidate = {
      ...fee,
      amount_minor: -15453,
      comment: 'Wolt order AB12',
    };
    expect(expenseLooksLikeDuplicate(earlierStyleFee, goodsA)).toBe(false);
    expect(expenseLooksLikeDuplicate({
      ...fee,
      comment: null,
    }, goodsA)).toBe(false);
  });

  it('still rejects a real duplicate after a distinct delivery fee is allowed', () => {
    const existing = {
      id: 201,
      date: '2026-10-06',
      account_id: 7,
      store: 'Wolt d.o.o.',
      amount_minor: -8398,
      item: 'Delivery fee',
      comment: 'Wolt order SYNTH77',
      fiscal_receipt_id: 'SYNTH-PFR-COURIER-002',
      receipt_url: 'https://receipts.example.test/courier/synth-002',
    };
    expect(expenseLooksLikeDuplicate({
      date: '2026-10-06',
      account_id: 7,
      store: 'Wolt d.o.o.',
      amount_minor: -8398,
      item: 'Delivery fee',
      comment: 'posted again',
      fiscal_receipt_id: 'SYNTH-PFR-COURIER-002',
      receipt_url: 'https://receipts.example.test/courier/synth-002',
    }, existing)).toBe(true);
    expect(expenseLooksLikeDuplicate({
      date: '2026-10-06',
      account_id: 7,
      store: 'Wolt d.o.o.',
      amount_minor: -8398,
      item: 'Relabeled fee',
      comment: null,
      fiscal_receipt_id: 'SYNTH-PFR-OTHER-003',
      receipt_url: 'https://receipts.example.test/courier/synth-003',
    }, existing)).toBe(true);
    const index = createExpenseDuplicateIndex([existing]);
    expect(index.find({
      date: '2026-10-06',
      account_id: 7,
      store: 'Apoteka Synth',
      amount_minor: -18900,
      item: 'Goods A',
      comment: 'Delivery order SYNTH77',
      fiscal_receipt_id: 'SYNTH-PFR-SELLER-001',
      receipt_url: 'https://receipts.example.test/seller/synth-001',
    })).toBeUndefined();
  });

  it('does not treat URL variants or an arbitrary URL as a distinct fiscal document', () => {
    const sellerPfr = 'SYNTHPFR-SELLER01-189';
    const courierPfr = 'SYNTHPFR-COURIER1-8398';
    const encodedSeller = btoa(`ref=${sellerPfr}`);
    const plainSellerUrl = `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(sellerPfr)}`;
    const variantSellerUrls = [
      `https://suf.purs.gov.rs/v/?utm_source=mail&vl=${encodeURIComponent(sellerPfr)}&fbclid=track`,
      `https://suf.purs.gov.rs/v/?fbclid=track&vl=${encodeURIComponent(sellerPfr)}&utm_source=mail`,
      `HTTP://WWW.SUF.PURS.GOV.RS/v/?vl=SYNTHPFR-SELLER01-%31%38%39`,
      `http://www.purs.gov.rs/V/?vl=${encodeURIComponent(sellerPfr)}`,
      `https://tap.sandbox.suf.purs.gov.rs/v/?vl=${encodedSeller}`,
      plainSellerUrl,
    ];
    const goods = {
      id: 301,
      date: '2026-10-06',
      account_id: 7,
      store: 'Apoteka Synth',
      amount_minor: -18900,
      item: 'Goods A',
      comment: 'Delivery order SYNTH77',
      fiscal_receipt_id: null,
      receipt_url: plainSellerUrl,
    };
    const fee = (receiptUrl: string, fiscalReceiptId: string | null = null): ExpenseDuplicateCandidate => ({
      date: '2026-10-06',
      account_id: 7,
      store: 'Wolt d.o.o.',
      amount_minor: -8398,
      item: 'Delivery fee',
      comment: 'Wolt order SYNTH77',
      fiscal_receipt_id: fiscalReceiptId,
      receipt_url: receiptUrl,
    });

    for (const receiptUrl of variantSellerUrls) {
      expect(canonicalFiscalIdentity({ receipt_url: receiptUrl }), receiptUrl).toEqual({
        kind: 'pfr',
        value: sellerPfr,
      });
      expect(expenseLooksLikeDuplicate(fee(receiptUrl), goods), receiptUrl).toBe(true);
    }

    expect(expenseLooksLikeDuplicate({
      date: '2026-10-06',
      account_id: 7,
      store: 'Apoteka Synth',
      amount_minor: -18900,
      item: 'Goods A',
      comment: 'posted again',
      fiscal_receipt_id: sellerPfr,
      receipt_url: 'https://cdn.example/wrapped-copy',
    }, {
      ...goods,
      fiscal_receipt_id: sellerPfr.toLowerCase(),
      receipt_url: 'https://evil.example/other-receipt',
    })).toBe(true);

    expect(expenseLooksLikeDuplicate(fee('https://tracking.example/click?id=1'), {
      ...goods,
      receipt_url: 'https://not-a-fiscal-host.example/receipt/abc',
    })).toBe(true);

    expect(expenseLooksLikeDuplicate(fee(
      `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(sellerPfr)}`,
    ), {
      ...goods,
      fiscal_receipt_id: sellerPfr,
      receipt_url: null,
    })).toBe(true);

    expect(expenseLooksLikeDuplicate(fee(
      'https://tracking.example/unparsed',
      null,
    ), {
      ...goods,
      fiscal_receipt_id: sellerPfr,
      receipt_url: null,
    })).toBe(true);

    const distinctFee = fee(
      `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(courierPfr)}`,
      courierPfr,
    );
    expect(expenseLooksLikeDuplicate(distinctFee, {
      ...goods,
      fiscal_receipt_id: sellerPfr,
      receipt_url: plainSellerUrl,
    })).toBe(false);
    expect(expenseLooksLikeDuplicate({
      ...distinctFee,
      comment: 'Delivery order SYNTH77',
      item: 'Goods B',
      store: 'Apoteka Synth',
      amount_minor: -79900,
      fiscal_receipt_id: sellerPfr,
      receipt_url: 'https://suf.purs.gov.rs/v/?utm_medium=qr&vl=' + encodeURIComponent(sellerPfr),
    }, {
      ...goods,
      fiscal_receipt_id: sellerPfr,
      receipt_url: plainSellerUrl,
    })).toBe(false);
  });

  it('does not let an opaque verification URL exempt a shared order id', () => {
    const sellerOpaque = 'SYNTHOPAQUESELLER01';
    const courierOpaque = 'SYNTHOPAQUECOURIER02';
    const sellerPfr = 'SYNTHPFR-SELLER01-189';
    const courierPfr = 'SYNTHPFR-COURIER1-8398';
    const opaqueUrl = `https://suf.purs.gov.rs/v/?vl=${sellerOpaque}`;
    const goods = {
      id: 401,
      date: '2026-10-06',
      account_id: 7,
      store: 'Apoteka Synth',
      amount_minor: -18900,
      item: 'Goods A',
      comment: 'Delivery order SYNTH77',
      fiscal_receipt_id: null,
      receipt_url: opaqueUrl,
    };
    const fee = (receiptUrl: string, fiscalReceiptId: string | null = null): ExpenseDuplicateCandidate => ({
      date: '2026-10-06',
      account_id: 7,
      store: 'Wolt d.o.o.',
      amount_minor: -8398,
      item: 'Delivery fee',
      comment: 'Wolt order SYNTH77',
      fiscal_receipt_id: fiscalReceiptId,
      receipt_url: receiptUrl,
    });

    expect(expenseLooksLikeDuplicate(fee(
      `http://www.suf.purs.gov.rs/v/?fbclid=z&vl=${courierOpaque}&utm_source=qr`,
    ), goods)).toBe(true);
    expect(expenseLooksLikeDuplicate(fee(
      `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(sellerPfr)}`,
    ), goods)).toBe(true);
    expect(expenseLooksLikeDuplicate(fee(
      `HTTP://WWW.PURS.GOV.RS/v/?vl=${sellerOpaque}&utm_medium=copy`,
    ), goods)).toBe(true);
    expect(expenseLooksLikeDuplicate({
      ...fee(opaqueUrl),
      comment: null,
    }, goods)).toBe(true);
    expect(canonicalFiscalIdentity({ receipt_url: opaqueUrl })).toEqual({
      kind: 'url',
      value: `https://suf.purs.gov.rs/v?vl=${encodeURIComponent(sellerOpaque)}`,
    });

    expect(expenseLooksLikeDuplicate(fee(
      `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(courierPfr)}`,
      courierPfr,
    ), {
      ...goods,
      fiscal_receipt_id: sellerPfr,
      receipt_url: `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(sellerPfr)}`,
    })).toBe(false);
    expect(expenseLooksLikeDuplicate({
      date: '2026-10-06',
      account_id: 7,
      store: 'Apoteka Synth',
      amount_minor: -79900,
      item: 'Goods B',
      comment: 'Delivery order SYNTH77',
      fiscal_receipt_id: sellerPfr,
      receipt_url: opaqueUrl,
    }, {
      ...goods,
      fiscal_receipt_id: sellerPfr,
      amount_minor: -18900,
      item: 'Goods A',
    })).toBe(false);
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
