import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import FiscalReceiptsSection from '../src/ui/FiscalReceiptsSection.jsx';
import PurchaseOrderCard from '../src/ui/PurchaseOrderCard.jsx';
import FiscalReceiptCard from '../src/ui/FiscalReceiptCard.jsx';
import BackupSection from '../src/ui/BackupSection.jsx';
import i18n from '../src/ui/i18n.js';

const order = {
  id: 4,
  provider: 'wolt',
  provider_order_id: 'synthorder0001',
  order_date: '2026-11-01',
  order_total_minor: 1334,
  order_total_currency: 'RSD',
  order_total_source: 'provider_document',
  order_total_reference: null,
  note: null,
  components: [
    {
      id: 1,
      component_type: 'service_fee',
      target_kind: 'expected',
      pfr_canonical: null,
      label: 'service fee',
      expected_amount_minor: 84,
      expected_currency: 'RSD',
      resolved: false,
      conflict: false,
      reason: null,
      operation_ids: [],
    },
    {
      id: 2,
      component_type: 'goods',
      target_kind: 'pfr',
      pfr_canonical: 'AAAAAAAA-BBBBBBBB-1',
      label: null,
      expected_amount_minor: null,
      expected_currency: null,
      resolved: false,
      conflict: true,
      reason: 'conflict',
      operation_ids: [7],
    },
  ],
  posted: [{ currency: 'RSD', posted_total_minor: 1250, operation_ids: [8] }],
  expected_missing: [{ currency: 'RSD', amount_minor: 84 }],
  not_counted: [],
  status: 'partial',
  conflict: true,
};

describe('purchase order UI', () => {
  it('exposes status text, conflict, and an expandable control', () => {
    const html = renderToStaticMarkup(React.createElement(PurchaseOrderCard as any, { order }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    expect(html).toContain(i18n.t('data.orders.status.partial'));
    expect(html).toContain(i18n.t('data.orders.conflict'));
    expect(html).toContain(i18n.t('data.orders.reason.conflict'));
    expect(html).toContain('data-conflict="true"');
    expect(html).toContain(i18n.t('data.orders.unlink'));
  });

  it('renders each receipt once and keeps the conflict reason inside the order', () => {
    const nested = {
      id: 'pfr:goods',
      grouping: 'fiscal_id',
      fiscal_receipt_id: 'BBBBBBBB-CCCCCCCC-9',
      date: '2026-11-01',
      store: 'Nested shop',
      account_id: 1,
      account_name: 'Card',
      account_currency: 'RSD',
      receipt_url: null,
      total_minor: -1000,
      positions_count: 1,
      lines: [{ id: 1, item: 'Nested goods line', category: null, subcategory: null, amount_minor: -1000, kind: 'expense', comment: null, receipt_url: null }],
    };
    const conflict = {
      ...nested,
      id: 'pfr:conflict',
      fiscal_receipt_id: 'AAAAAAAA-BBBBBBBB-1',
      store: 'Conflict shop',
      lines: [{ ...nested.lines[0], id: 7, item: 'Conflict only once' }],
    };
    const html = renderToStaticMarkup(React.createElement(
      'div',
      null,
      React.createElement(PurchaseOrderCard as any, { order, nestedCards: [nested] }),
      React.createElement(FiscalReceiptCard as any, { receipt: conflict }),
    ));
    expect(html.match(/Nested shop/g)).toHaveLength(1);
    expect(html.match(/Conflict shop/g)).toHaveLength(1);
    expect(html).toContain(i18n.t('data.orders.reason.conflict'));
    expect(html.match(/class="receipt"/g)).toHaveLength(2);
  });

  it('renders the receipts section and the compat export warning', () => {
    const receipts = renderToStaticMarkup(React.createElement(
      RefreshProvider,
      null,
      React.createElement(FiscalReceiptsSection as any, {
        accounts: [{ id: 1, name: 'RSD card', currency: 'RSD' }],
        expanded: false,
        onToggle: () => {},
        search: '',
      }),
    ));
    expect(receipts).toContain(i18n.t('data.blocks.receipts.title'));
    const backup = renderToStaticMarkup(React.createElement(
      RefreshProvider,
      null,
      React.createElement(BackupSection as any),
    ));
    expect(backup).toContain(i18n.t('data.backup.downloadCompat'));
    expect(backup).toContain(i18n.t('data.backup.compatWarning', { orders: 0, components: 0 }));
  });
});
