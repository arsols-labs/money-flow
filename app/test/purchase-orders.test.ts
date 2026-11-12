import { describe, expect, it } from 'vitest';
import { canonicalizePfr } from '../src/shared/fiscal-receipts';
import {
  orderSearchState,
  partitionReceiptCards,
  projectOrders,
  type OrderComponentRow,
  type OrderLedgerOp,
  type OrderRow,
} from '../src/shared/purchase-orders';
import { groupFiscalReceipts } from '../src/shared/fiscal-receipts';

const EPOCH = '11111111-1111-4111-8111-111111111111';

function order(partial: Partial<OrderRow> & Pick<OrderRow, 'id'>): OrderRow {
  return {
    provider: 'wolt',
    provider_order_id: 'synthorder0001',
    order_date: '2026-11-01',
    order_total_minor: 1334,
    order_total_currency: 'RSD',
    order_total_source: 'provider_document',
    order_total_reference: null,
    note: null,
    ...partial,
  };
}

function pfrComponent(partial: Partial<OrderComponentRow> & Pick<OrderComponentRow, 'id' | 'pfr_canonical'>): OrderComponentRow {
  return {
    order_id: 1,
    component_type: 'goods',
    target_kind: 'pfr',
    ledger_epoch: EPOCH,
    expected_amount_minor: null,
    expected_currency: null,
    label: null,
    ...partial,
  };
}

describe('canonicalizePfr', () => {
  it('maps case, NBSP, tabs, and spaces onto one document', () => {
    const variants = [
      'aaaaaaaa-bbbbbbbb-1',
      ' AAAAAAAA-BBBBBBBB-1 ',
      'AAAAAAAA-BBBBBBBB-1',
      'AAAAAAAA\u00A0BBBBBBBB-1'.replace(' ', ''),
      '\tAAAAAAAA  BBBBBBBB-1\t',
      'AAAAAAAA\u00A0\u00A0BBBBBBBB-1',
    ];
    const valueOf = (input: string) => {
      const parsed = canonicalizePfr(input);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.value;
    };
    expect(valueOf('aaaaaaaa-bbbbbbbb-1')).toBe(valueOf(' AAAAAAAA-BBBBBBBB-1 '));
    expect(valueOf('AAAAAAAA\u00A0BBBBBBBB-1')).toBe('AAAAAAAA BBBBBBBB-1');
    expect(valueOf('AAAAAAAA  BBBBBBBB-1')).toBe('AAAAAAAA BBBBBBBB-1');
    expect(valueOf('\tAAAAAAAA\tBBBBBBBB-1')).toBe('AAAAAAAA BBBBBBBB-1');
    expect(valueOf('\uFF21AAAAAAAA-BBBBBBBB-1')).toBe('AAAAAAAAA-BBBBBBBB-1');
    expect(valueOf('  ')).toBeNull();
    expect(canonicalizePfr(null)).toEqual({ ok: true, value: null });
    expect(canonicalizePfr('A'.repeat(129)).ok).toBe(false);
    expect(variants.every((item) => {
      const parsed = canonicalizePfr(item);
      return parsed.ok && (parsed.value === 'AAAAAAAA-BBBBBBBB-1' || parsed.value === 'AAAAAAAA BBBBBBBB-1');
    })).toBe(true);
  });
});

describe('posted_total', () => {
  const goods = pfrComponent({ id: 1, pfr_canonical: 'AAAAAAAA-BBBBBBBB-1', component_type: 'goods' });
  const fee = pfrComponent({ id: 2, pfr_canonical: 'CCCCCCCC-DDDDDDDD-2', component_type: 'service_fee' });
  const ops = (extra: OrderLedgerOp[] = []): OrderLedgerOp[] => [
    { id: 10, kind: 'expense', amount_minor: -1000, currency: 'RSD', fiscal_receipt_id: 'aaaaaaaa-bbbbbbbb-1' },
    { id: 11, kind: 'expense', amount_minor: -250, currency: 'RSD', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' },
    { id: 12, kind: 'expense', amount_minor: -84, currency: 'RSD', fiscal_receipt_id: 'cccccccc-dddddddd-2' },
    ...extra,
  ];

  it('nets an expense of -12.50 and a fee of -0.84 to 13.34', () => {
    const [view] = projectOrders([order({ id: 1 })], [goods, fee], ops(), EPOCH);
    expect(view?.posted).toEqual([{ currency: 'RSD', posted_total_minor: 1334, operation_ids: [10, 11, 12] }]);
    expect(view?.status).toBe('complete');
    expect(view?.conflict).toBe(false);
  });

  it('subtracts a refund of +1.00 to 12.34 and does not count expected amounts', () => {
    const withRefund = ops([
      { id: 13, kind: 'refund', amount_minor: 100, currency: 'RSD', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' },
    ]);
    const mismatched = projectOrders([order({ id: 1 })], [goods, fee], withRefund, EPOCH)[0];
    expect(mismatched?.posted[0]?.posted_total_minor).toBe(1234);
    expect(mismatched?.status).toBe('mismatch');

    const expected: OrderComponentRow = {
      id: 3,
      order_id: 1,
      component_type: 'service_fee',
      target_kind: 'expected',
      pfr_canonical: null,
      ledger_epoch: EPOCH,
      expected_amount_minor: 84,
      expected_currency: 'RSD',
      label: 'service fee',
    };
    const partial = projectOrders(
      [order({ id: 1, order_total_minor: 1334 })],
      [goods, expected],
      ops().filter((op) => op.id !== 12),
      EPOCH,
    )[0];
    expect(partial?.posted[0]?.posted_total_minor).toBe(1250);
    expect(partial?.expected_missing).toEqual([{ currency: 'RSD', amount_minor: 84 }]);
    expect(partial?.status).toBe('partial');
    expect(partial?.posted[0]?.posted_total_minor).not.toBe(1334);
  });

  it('keeps conflict beside partial and lists income without counting it', () => {
    const second = order({ id: 2, provider_order_id: 'synthorder0002', order_total_minor: null, order_total_currency: null, order_total_source: null });
    const other = pfrComponent({ id: 4, order_id: 2, pfr_canonical: 'EEEEEEEE-FFFFFFFF-3' });
    const expected: OrderComponentRow = {
      id: 5,
      order_id: 1,
      component_type: 'delivery_fee',
      target_kind: 'expected',
      pfr_canonical: null,
      ledger_epoch: EPOCH,
      expected_amount_minor: 50,
      expected_currency: 'RSD',
      label: null,
    };
    const shared: OrderLedgerOp[] = [
      { id: 7, kind: 'expense', amount_minor: -1250, currency: 'RSD', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' },
      { id: 7, kind: 'expense', amount_minor: -1250, currency: 'RSD', fiscal_receipt_id: 'EEEEEEEE-FFFFFFFF-3' },
      { id: 8, kind: 'income', amount_minor: 10, currency: 'RSD', fiscal_receipt_id: 'CCCCCCCC-DDDDDDDD-2' },
      { id: 9, kind: 'income', amount_minor: 20, currency: 'RSD', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' },
    ];
    const views = projectOrders([order({ id: 1 }), second], [goods, fee, other, expected], shared, EPOCH);
    const first = views.find((item) => item.id === 1);
    expect(first?.status).toBe('partial');
    expect(first?.conflict).toBe(true);
    expect(first?.components.find((component) => component.id === 1)?.conflict).toBe(true);
    expect(first?.components.find((component) => component.id === 1)?.reason).toBe('conflict');
    expect(first?.posted[0]?.posted_total_minor).toBe(0);
    expect(first?.posted.every((row) => !row.operation_ids.includes(7) && !row.operation_ids.includes(9))).toBe(true);
    expect(first?.not_counted).toEqual([
      { operation_id: 8, kind: 'income', currency: 'RSD', reason: 'kind_not_counted' },
      { operation_id: 9, kind: 'income', currency: 'RSD', reason: 'kind_not_counted' },
    ]);
    const multi = projectOrders(
      [order({ id: 1 })],
      [goods, { ...fee, pfr_canonical: 'CCCCCCCC-DDDDDDDD-2' }],
      [
        { id: 10, kind: 'expense', amount_minor: -1250, currency: 'RSD', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' },
        { id: 12, kind: 'expense', amount_minor: -84, currency: 'EUR', fiscal_receipt_id: 'CCCCCCCC-DDDDDDDD-2' },
      ],
      EPOCH,
    )[0];
    expect(multi?.status).toBe('multi_currency');
    expect(multi?.posted).toHaveLength(2);
    expect(multi).not.toHaveProperty('blended_total_minor');
  });

  it('does not count an epoch mismatch', () => {
    const [view] = projectOrders([order({ id: 1 })], [goods], [
      { id: 10, kind: 'expense', amount_minor: -1250, currency: 'RSD', fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1' },
    ], '22222222-2222-4222-8222-222222222222');
    expect(view?.components[0]?.reason).toBe('epoch_changed');
    expect(view?.components[0]?.resolved).toBe(false);
    expect(view?.posted[0]?.posted_total_minor).toBe(0);
    expect(view?.status).toBe('partial');
  });
});

describe('receipt partition', () => {
  it('nests a resolved document and leaves a conflicting one in the normal list', () => {
    const groups = groupFiscalReceipts([
      {
        id: 1, date: '2026-11-01', account_id: 1, kind: 'expense', store: 'Shop', item: 'Goods',
        category: null, subcategory: null, amount_minor: -1250, comment: null, receipt_url: null,
        fiscal_receipt_id: 'aaaaaaaa-bbbbbbbb-1', account_name: 'Card', currency: 'RSD',
      },
      {
        id: 2, date: '2026-11-01', account_id: 1, kind: 'expense', store: 'Courier', item: 'Fee',
        category: null, subcategory: null, amount_minor: -84, comment: null, receipt_url: 'https://example.test/fee',
        fiscal_receipt_id: 'CCCCCCCC-DDDDDDDD-2', account_name: 'Card', currency: 'RSD',
      },
    ]);
    const projected = projectOrders(
      [order({ id: 1 })],
      [
        pfrComponent({ id: 1, pfr_canonical: 'AAAAAAAA-BBBBBBBB-1' }),
        pfrComponent({ id: 2, pfr_canonical: 'CCCCCCCC-DDDDDDDD-2', component_type: 'service_fee' }),
      ],
      [
        { id: 1, kind: 'expense', amount_minor: -1250, currency: 'RSD', fiscal_receipt_id: 'aaaaaaaa-bbbbbbbb-1' },
        { id: 2, kind: 'expense', amount_minor: -84, currency: 'RSD', fiscal_receipt_id: 'CCCCCCCC-DDDDDDDD-2' },
      ],
      EPOCH,
    );
    projected[0]!.components[1]!.conflict = true;
    projected[0]!.components[1]!.resolved = false;
    projected[0]!.components[1]!.reason = 'conflict';
    projected[0]!.conflict = true;
    projected[0]!.status = 'partial';
    const view = partitionReceiptCards(groups, projected);
    expect(view.nested[0]?.cards.map((card) => card.fiscal_receipt_id)).toEqual(['aaaaaaaa-bbbbbbbb-1']);
    expect(view.nested[0]).not.toHaveProperty('conflictCards');
    expect(view.ungrouped.map((card) => card.fiscal_receipt_id)).toEqual(['CCCCCCCC-DDDDDDDD-2']);
    const renderedIds = [
      ...view.nested.flatMap((item) => item.cards.map((card) => card.id)),
      ...view.ungrouped.map((card) => card.id),
    ];
    expect(renderedIds).toEqual([...new Set(renderedIds)]);
    expect(renderedIds).toHaveLength(groups.length);
    const search = orderSearchState(projected[0]!, view.nested[0]!.cards, 'goods');
    expect(search.visible).toBe(true);
  });
});
