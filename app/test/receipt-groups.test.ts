import { describe, expect, it } from 'vitest';
import {
  areReceiptsSameCalendarDate,
  buildDatedReceiptFeed,
  nestManualGroupsInReceiptList,
  projectManualGroup,
  receiptCardKey,
  receiptGroupRenameTarget,
  resolveReceiptGroupDate,
  resolveReceiptGroupPlace,
  type ReceiptGroup,
  type ReceiptIdentityOperation,
} from '../src/shared/receipt-groups';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function op(overrides: Partial<ReceiptIdentityOperation> & Pick<ReceiptIdentityOperation, 'id'>): ReceiptIdentityOperation {
  return {
    date: '2026-11-01',
    account_id: 1,
    kind: 'expense',
    store: 'Synth shop',
    item: 'Goods',
    category: null,
    subcategory: null,
    amount_minor: -1000,
    comment: null,
    receipt_url: 'https://receipts.example/synth',
    fiscal_receipt_id: null,
    account_name: 'Synth RSD',
    currency: 'RSD',
    receipt_identity_token: null,
    ...overrides,
  };
}

describe('manual receipt group projection', () => {
  it('sums each operation once, keeps refund signs, and does not invent a document total', () => {
    const operations = [
      op({ id: 1, fiscal_receipt_id: 'SYNTH-PFR-1', amount_minor: -1000, receipt_url: null }),
      op({ id: 2, fiscal_receipt_id: 'SYNTH-PFR-1', amount_minor: -250, item: 'Fee', receipt_url: null }),
      op({ id: 3, kind: 'refund', fiscal_receipt_id: 'SYNTH-PFR-2', amount_minor: 400, item: 'Refund', receipt_url: null }),
    ];
    const group = projectManualGroup(
      { id: 7, display_name: null },
      [
        { order_id: 7, receipt_key: 'pfr:SYNTH-PFR-1', ledger_epoch: EPOCH },
        { order_id: 7, receipt_key: 'pfr:SYNTH-PFR-2', ledger_epoch: EPOCH },
      ],
      operations,
      EPOCH,
    );
    expect(group.name).toBe('Synth shop');
    expect(group.place).toBe('Synth shop');
    expect(group.date).toBe('2026-11-01');
    expect(group.number).toBe(7);
    expect(group.subtotals).toEqual([
      { currency: 'RSD', posted_minor: -850, document_minor: null, document_known: false },
    ]);
    expect(group.total_currency).toBe('RSD');
    expect(group.total_minor).toBe(-850);
    expect(group.missing_rates).toEqual([]);
    expect(group.multi_currency).toBe(false);
    expect(group.incomplete).toBe(false);
    expect(group.receipts.find((receipt) => receipt.receipt_key === 'pfr:SYNTH-PFR-1')?.operation_ids).toEqual([1, 2]);
  });

  it('converts mixed currencies to the base currency and sums the exact per-receipt converted amounts', () => {
    const operations = [
      op({ id: 1, currency: 'EUR', account_name: 'Synth EUR', amount_minor: -100, fiscal_receipt_id: 'SYNTH-EUR-1', receipt_url: null }),
      op({ id: 2, currency: 'EUR', account_name: 'Synth EUR', amount_minor: -100, fiscal_receipt_id: 'SYNTH-EUR-2', receipt_url: null }),
      op({ id: 3, currency: 'USD', account_name: 'Synth USD', amount_minor: -50, fiscal_receipt_id: 'SYNTH-USD-1', receipt_url: null }),
    ];
    const group = projectManualGroup(
      { id: 4, display_name: 'Mixed FX' },
      [
        { order_id: 4, receipt_key: 'pfr:SYNTH-EUR-1', ledger_epoch: EPOCH },
        { order_id: 4, receipt_key: 'pfr:SYNTH-EUR-2', ledger_epoch: EPOCH },
        { order_id: 4, receipt_key: 'pfr:SYNTH-USD-1', ledger_epoch: EPOCH },
      ],
      operations,
      EPOCH,
      {
        baseCurrency: 'USD',
        ratesE9: new Map([['EUR', 1_004_000_000]]),
      },
    );
    expect(group.multi_currency).toBe(true);
    expect(group.incomplete).toBe(false);
    expect(group.missing_rates).toEqual([]);
    expect(group.base_currency).toBe('USD');
    expect(group.total_currency).toBe('USD');
    expect(group.receipts.map((receipt) => receipt.base_minor)).toEqual([-100, -100, -50]);
    expect(group.total_minor).toBe(-250);
  });

  it('names a missing needed exchange rate and marks a mixed-currency total incomplete without inventing a total', () => {
    const operations = [
      op({ id: 1, currency: 'RSD', amount_minor: -1000, receipt_identity_token: TOKEN_A, fiscal_receipt_id: null }),
      op({ id: 2, currency: 'USD', account_name: 'Synth USD', amount_minor: -50, receipt_identity_token: TOKEN_B }),
    ];
    const group = projectManualGroup(
      { id: 5, display_name: 'Missing FX' },
      [
        { order_id: 5, receipt_key: `op:${TOKEN_A}`, ledger_epoch: EPOCH },
        { order_id: 5, receipt_key: `op:${TOKEN_B}`, ledger_epoch: EPOCH },
      ],
      operations,
      EPOCH,
      {
        baseCurrency: 'USD',
        ratesE9: new Map(),
      },
    );
    expect(group.multi_currency).toBe(true);
    expect(group.incomplete).toBe(true);
    expect(group.missing_rates).toEqual(['RSD']);
    expect(group.total_currency).toBe('USD');
    expect(group.total_minor).toBeNull();
    expect(group.receipts.find((r) => r.receipt_key === `op:${TOKEN_A}`)?.base_minor).toBeNull();
    expect(group.receipts.find((r) => r.receipt_key === `op:${TOKEN_B}`)?.base_minor).toBe(-50);
  });

  it('keeps currencies apart and marks a blank currency incomplete', () => {
    const operations = [
      op({ id: 1, currency: 'RSD', amount_minor: -100, receipt_identity_token: TOKEN_A, fiscal_receipt_id: null }),
      op({ id: 2, currency: 'USD', account_name: 'Synth USD', amount_minor: -50, receipt_identity_token: TOKEN_B }),
      op({ id: 3, currency: '', amount_minor: -5, receipt_identity_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    ];
    const group = projectManualGroup(
      { id: 3, display_name: 'Market run' },
      [
        { order_id: 3, receipt_key: `op:${TOKEN_A}`, ledger_epoch: EPOCH },
        { order_id: 3, receipt_key: `op:${TOKEN_B}`, ledger_epoch: EPOCH },
        { order_id: 3, receipt_key: 'op:cccccccc-cccc-4ccc-8ccc-cccccccccccc', ledger_epoch: EPOCH },
      ],
      operations,
      EPOCH,
    );
    expect(group.multi_currency).toBe(true);
    expect(group.incomplete).toBe(true);
    expect(group.subtotals.map((row) => row.currency)).toEqual([null, 'RSD', 'USD']);
    expect(group.subtotals.every((row) => row.document_known === false && row.document_minor === null)).toBe(true);
  });

  it('does not count an epoch mismatch, a missing token, or an ambiguous PFR', () => {
    const operations = [
      op({ id: 1, fiscal_receipt_id: 'synth-pfr-9', receipt_url: null }),
      op({ id: 2, fiscal_receipt_id: 'SYNTH-PFR-9', receipt_url: null, amount_minor: -20 }),
      op({ id: 4, receipt_identity_token: TOKEN_A }),
    ];
    const group = projectManualGroup(
      { id: 9, display_name: null },
      [
        { order_id: 9, receipt_key: 'pfr:SYNTH-PFR-9', ledger_epoch: EPOCH },
        { order_id: 9, receipt_key: `op:${TOKEN_B}`, ledger_epoch: EPOCH },
        { order_id: 9, receipt_key: `op:${TOKEN_A}`, ledger_epoch: '22222222-2222-4222-8222-222222222222' },
      ],
      operations,
      EPOCH,
    );
    expect(group.receipts.map((receipt) => receipt.resolution)).toEqual(['epoch_changed', 'missing', 'ambiguous']);
    expect(group.subtotals).toEqual([]);
    expect(group.incomplete).toBe(true);
  });

  it('uses the stored token, not the reusable operation id, as the card key', () => {
    const card = {
      id: 'op:4',
      grouping: 'single_op' as const,
      fiscal_receipt_id: null,
      date: '2026-11-01',
      store: 'Synth',
      account_id: 1,
      account_name: 'Synth',
      account_currency: 'RSD',
      receipt_url: 'https://receipts.example/4',
      total_minor: -100,
      positions_count: 1,
      lines: [{ id: 4, item: 'Goods', category: null, subcategory: null, amount_minor: -100, kind: 'expense', comment: null, receipt_url: 'https://receipts.example/4' }],
    };
    expect(receiptCardKey(card, new Map([[4, TOKEN_A]]))).toBe(`op:${TOKEN_A}`);
    expect(receiptCardKey(card, new Map([[4, null]]))).toBeNull();
  });

  it('titles a restaurant kitchen + bar visit with the restaurant and a pharmacy + Wolt delivery with the pharmacy', () => {
    expect(resolveReceiptGroupPlace([
      { store: 'Restoran Synth Kitchen' },
      { store: 'Restoran Synth Bar' },
    ])).toBe('Restoran Synth');
    expect(resolveReceiptGroupPlace([
      { store: 'Ресторан Синт — кухня' },
      { store: 'Ресторан Синт — бар' },
    ])).toBe('Ресторан Синт');
    expect(resolveReceiptGroupPlace([
      { store: 'Wolt d.o.o.' },
      { store: 'Apoteka Synth' },
    ])).toBe('Apoteka Synth');
    expect(resolveReceiptGroupPlace([
      { store: 'Apoteka Synth' },
      { store: 'Wolt' },
    ])).toBe('Apoteka Synth');
    expect(resolveReceiptGroupPlace([
      { store: 'Apoteka Synth' },
      { store: 'Pekara Synth' },
    ], 'Typed visit name')).toBe('Typed visit name');
    expect(resolveReceiptGroupPlace([
      { store: 'Apoteka Synth' },
      { store: 'Pekara Synth' },
    ])).toBeNull();
    expect(resolveReceiptGroupPlace([
      { store: 'Wolt' },
      { store: 'Wolt d.o.o.' },
    ])).toBeNull();
    expect(resolveReceiptGroupPlace([
      { store: 'Apoteka Synth' },
      { store: null },
    ])).toBeNull();
  });

  it('accepts same calendar date with different times of day and rejects different calendar dates', () => {
    expect(areReceiptsSameCalendarDate([
      { date: '2026-11-07T11:20:00Z' },
      { date: '2026-11-07T21:45:00Z' },
    ])).toEqual({ ok: true, date: '2026-11-07' });
    expect(areReceiptsSameCalendarDate([
      { date: '2026-11-07' },
      { date: '2026-11-08' },
    ])).toEqual({ ok: false, date: null });
  });

  it('places an older multi-date group on its latest member date and sorts groups with ordinary receipts by date', () => {
    const operations = [
      op({ id: 1, date: '2026-11-02', fiscal_receipt_id: 'SYNTH-OLD-1', receipt_url: null }),
      op({ id: 2, date: '2026-11-05', fiscal_receipt_id: 'SYNTH-OLD-2', receipt_url: null }),
    ];
    const olderGroup = projectManualGroup(
      { id: 12, display_name: null },
      [
        { order_id: 12, receipt_key: 'pfr:SYNTH-OLD-1', ledger_epoch: EPOCH },
        { order_id: 12, receipt_key: 'pfr:SYNTH-OLD-2', ledger_epoch: EPOCH },
      ],
      operations,
      EPOCH,
    );
    expect(olderGroup.date).toBe('2026-11-05');
    expect(resolveReceiptGroupDate([{ date: '2026-11-02' }, { date: '2026-11-05' }])).toBe('2026-11-05');

    const feed = buildDatedReceiptFeed(
      [
        {
          group: olderGroup,
          nested: [{ date: '2026-11-02' }, { date: '2026-11-05' }],
        },
      ],
      [
        { id: 'pfr:NEWEST', date: '2026-11-08' },
        { id: 'pfr:MIDDLE', date: '2026-11-04' },
        { id: 'pfr:OLDEST', date: '2026-11-01' },
      ],
    );
    expect(feed.map((item) => `${item.kind}:${item.id}:${item.date}`)).toEqual([
      'receipt:pfr:NEWEST:2026-11-08',
      'group:manual-12:2026-11-05',
      'receipt:pfr:MIDDLE:2026-11-04',
      'receipt:pfr:OLDEST:2026-11-01',
    ]);
  });
});

function manualGroup(id: number, operationIds: number[], date = '2026-11-01'): ReceiptGroup {
  return {
    id,
    kind: 'manual',
    name: 'Synth shop',
    place: 'Synth shop',
    date,
    number: id,
    receipts: [{
      receipt_key: `op:key-${id}`,
      resolution: 'resolved',
      operation_ids: operationIds,
      fiscal_receipt_id: null,
      date,
      store: 'Synth shop',
      currency: 'RSD',
      posted_minor: -1000,
      base_minor: -10,
    }],
    subtotals: [],
    base_currency: 'USD',
    total_minor: -1000,
    total_currency: 'RSD',
    missing_rates: [],
    incomplete: false,
    multi_currency: false,
  };
}

describe('receipt group rename target and analytics nesting', () => {
  it('stores a typed name and falls back to a resolved place without inventing one', () => {
    const cards = [{ store: 'Apoteka Synth' }, { store: 'Wolt' }];
    expect(receiptGroupRenameTarget(cards, '  Weekend market  ')).toEqual({
      displayName: 'Weekend market',
      place: 'Weekend market',
    });
    expect(receiptGroupRenameTarget(cards, null)).toEqual({
      displayName: null,
      place: 'Apoteka Synth',
    });
    expect(receiptGroupRenameTarget(cards, '   ')).toEqual({
      displayName: null,
      place: 'Apoteka Synth',
    });
    expect(receiptGroupRenameTarget([{ store: 'Wolt' }, { store: 'Glovo' }], null)).toBeNull();
    expect(receiptGroupRenameTarget([{ store: '' }, { store: 'Apoteka Synth' }], '')).toBeNull();
  });

  it('nests grouped lines once, keeps a later loose receipt first, and leaves whole-card totals alone', () => {
    const member = {
      id: 'receipt-member',
      date: '2026-11-01',
      store: 'Synth shop',
      merchant: 'Member shop',
      receipt_total_minor: 999,
      receipt_total_base_minor: 888,
      positions_count: 1,
      lines: [{ id: 4, amount_minor: -1000, converted_minor: -10 }],
    };
    const loose = {
      id: 'receipt-later',
      date: '2026-11-12',
      store: 'Later shop',
      merchant: 'Later shop',
      receipt_total_minor: 500,
      receipt_total_base_minor: 5,
      positions_count: 1,
      lines: [{ id: 99, amount_minor: -500, converted_minor: -5 }],
    };
    const split = {
      id: 'receipt-split',
      date: '2026-11-01',
      store: 'Synth shop',
      merchant: 'Split shop',
      receipt_total_minor: 300,
      receipt_total_base_minor: 3,
      positions_count: 2,
      lines: [
        { id: 7, amount_minor: -200, converted_minor: -2 },
        { id: 8, amount_minor: -100, converted_minor: -1 },
      ],
    };
    const feed = nestManualGroupsInReceiptList(
      [member, loose, split],
      [manualGroup(8, [4, 7]), manualGroup(15, [404], '2026-11-03')],
    );
    expect(feed.map((item) => `${item.kind}:${item.date}:${item.kind === 'receipt' ? item.value.id : item.value.group.id}`)).toEqual([
      'receipt:2026-11-12:receipt-later',
      'group:2026-11-01:8',
      'receipt:2026-11-01:receipt-split::loose',
    ]);
    const grouped = feed[1];
    expect(grouped?.kind).toBe('group');
    if (grouped?.kind !== 'group') return;
    expect(grouped.value.nested.map((card) => card.id)).toEqual(['receipt-member', 'receipt-split::group-8']);
    expect(grouped.value.nested[0]).toBe(member);
    expect(member.receipt_total_minor).toBe(999);
    const looseEntry = feed[0];
    expect(looseEntry?.kind).toBe('receipt');
    if (looseEntry?.kind !== 'receipt') return;
    expect(looseEntry.value.id).toBe('receipt-later');
    expect(split.receipt_total_minor).toBe(300);
    const splitPiece = grouped.value.nested[1];
    expect(splitPiece?.lines.map((line) => line.id)).toEqual([7]);
    expect(splitPiece?.receipt_total_minor).toBe(200);
  });
});
