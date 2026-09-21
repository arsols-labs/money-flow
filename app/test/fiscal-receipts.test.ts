import { describe, expect, it } from 'vitest';
import { groupFiscalReceipts, trimFiscalReceiptId } from '../src/shared/fiscal-receipts';

function op(overrides: Record<string, unknown>) {
  return {
    id: 1,
    date: '2026-09-15',
    account_id: 10,
    kind: 'expense',
    store: 'Maxi 722',
    item: 'Хлеб',
    category: 'Продукты',
    subcategory: null,
    amount_minor: -100,
    comment: null,
    receipt_url: null,
    fiscal_receipt_id: null,
    account_name: 'RSD card',
    currency: 'RSD',
    ...overrides,
  };
}

describe('groupFiscalReceipts (issue #557)', () => {
  it('groups the Maxi same-day visit into three fiscal cards by PFR', () => {
    const ops = [
      op({ id: 3401, item: 'Молоко', amount_minor: -800, fiscal_receipt_id: 'PFR-GROCERY' }),
      op({ id: 3402, item: 'Хлеб', amount_minor: -400, fiscal_receipt_id: 'PFR-GROCERY' }),
      op({ id: 3407, item: 'Сыр', amount_minor: -900, fiscal_receipt_id: 'PFR-GROCERY' }),
      op({ id: 3409, item: 'Торт', amount_minor: -1200, fiscal_receipt_id: 'PFR-CAKE' }),
      op({ id: 3408, item: 'Marlboro', amount_minor: -443, fiscal_receipt_id: 'PFR-TOBACCO' }),
    ];
    const groups = groupFiscalReceipts(ops);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.fiscal_receipt_id).sort()).toEqual([
      'PFR-CAKE',
      'PFR-GROCERY',
      'PFR-TOBACCO',
    ]);
    const grocery = groups.find((g) => g.fiscal_receipt_id === 'PFR-GROCERY')!;
    expect(grocery.grouping).toBe('fiscal_id');
    expect(grocery.positions_count).toBe(3);
    expect(grocery.total_minor).toBe(-2100);
    expect(grocery.id).toBe('pfr:PFR-GROCERY');
  });

  it('does not invent a PFR and keeps ops without id and without URL out of Чеки', () => {
    const groups = groupFiscalReceipts([
      op({ id: 1, item: 'Cash coffee', fiscal_receipt_id: null, receipt_url: null }),
      op({ id: 2, kind: 'transfer_out', fiscal_receipt_id: 'PFR-X' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('fallback without PFR is one card per operation when receipt_url is set', () => {
    const groups = groupFiscalReceipts([
      op({
        id: 11,
        store: 'Lidl',
        item: 'Foreign till',
        fiscal_receipt_id: '  ',
        receipt_url: 'https://example.com/drive/a',
      }),
      op({
        id: 12,
        store: 'Lidl',
        item: 'Same visit other line',
        fiscal_receipt_id: null,
        receipt_url: 'https://example.com/drive/b',
      }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.grouping === 'single_op')).toBe(true);
    expect(groups.every((g) => g.fiscal_receipt_id === null)).toBe(true);
    expect(groups.map((g) => g.id).sort()).toEqual(['op:11', 'op:12']);
  });

  it('trims fiscal ids and does not treat receipt_url as the grouping key', () => {
    expect(trimFiscalReceiptId('  ABC-1  ')).toBe('ABC-1');
    expect(trimFiscalReceiptId('')).toBeNull();
    const groups = groupFiscalReceipts([
      op({ id: 1, fiscal_receipt_id: 'PFR-1', receipt_url: 'https://a.example/1' }),
      op({ id: 2, fiscal_receipt_id: 'PFR-1', receipt_url: 'https://a.example/2' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.receipt_url).toBe('https://a.example/1');
    expect(groups[0]!.lines).toHaveLength(2);
  });
});
