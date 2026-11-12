import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { AnalyticsReceiptList } from '../src/ui/Analytics.jsx';
import FiscalReceiptCard from '../src/ui/FiscalReceiptCard.jsx';
import FiscalReceiptsSection, { ReceiptGroupToolbar } from '../src/ui/FiscalReceiptsSection.jsx';
import PurchaseOrderCard from '../src/ui/PurchaseOrderCard.jsx';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import i18n from '../src/ui/i18n.js';
import { measuredHeightVariable, publishMeasuredHeight } from '../src/ui/measuredSticky.js';

const receipt = {
  id: 'op:4',
  grouping: 'single_op',
  fiscal_receipt_id: null,
  date: '2026-11-01',
  store: 'Synth shop',
  account_id: 1,
  account_name: 'Synth RSD',
  account_currency: 'RSD',
  receipt_url: 'https://receipts.example/synth',
  total_minor: -1000,
  positions_count: 1,
  membershipKey: 'op:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  lines: [{
    id: 4, item: 'Goods', category: null, subcategory: null, amount_minor: -1000, kind: 'expense', comment: null, receipt_url: null,
  }],
};

describe('receipt group UI', () => {
  it('puts a labeled checkbox outside the disclosure button', () => {
    const html = renderToStaticMarkup(React.createElement(FiscalReceiptCard as any, {
      receipt,
      selection: {
        key: receipt.membershipKey,
        checked: false,
        onChange: () => {},
      },
    }));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(i18n.t('data.receiptGroups.select', { label: 'Synth shop ' + i18n.t('data.receipts.noPfr') }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    const checkbox = html.indexOf('type="checkbox"');
    const button = html.indexOf('<button');
    expect(checkbox).toBeGreaterThan(-1);
    expect(checkbox).toBeLessThan(button);
  });

  it('renders a manual group with its date, resolved place title, one readable total, parenthetical base amounts on receipts, and no order language', () => {
    const html = renderToStaticMarkup(React.createElement(PurchaseOrderCard as any, {
      manualGroup: {
        id: 8,
        kind: 'manual',
        name: null,
        place: 'Synth shop',
        date: '2026-11-01',
        number: 8,
        receipts: [{
          receipt_key: receipt.membershipKey,
          resolution: 'resolved',
          operation_ids: [4],
          fiscal_receipt_id: null,
          date: '2026-11-01',
          store: 'Synth shop',
          currency: 'RSD',
          posted_minor: -1000,
          base_minor: -10,
        }],
        subtotals: [{ currency: 'RSD', posted_minor: -1000, document_minor: null, document_known: false }],
        base_currency: 'USD',
        total_minor: -1000,
        total_currency: 'RSD',
        missing_rates: [],
        incomplete: false,
        multi_currency: false,
      },
      nestedCards: [receipt],
      onExcludeReceipt: () => {},
      onDeleteGroup: () => {},
      onRename: () => {},
    }));
    expect(html).toContain('Synth shop');
    expect(html).toContain('data-group-date="2026-11-01"');
    expect(html).toContain('class="receipt-date"');
    expect(html).toContain('class="receipt-group-title"');
    expect(html).toContain('class="receipt-total"');
    expect(html).not.toContain('class="receipt-group-total"');
    expect(html).toContain(i18n.t('data.receiptGroups.kind'));
    expect(html).toContain('(-$0.10)');
    expect(html.replaceAll(i18n.t('data.receiptGroups.kind'), '')).not.toContain(i18n.t('data.receiptGroups.group'));
    expect(html).not.toContain('receipt-group-rename');
    expect(html).not.toContain(i18n.t('data.orders.unknownTotal'));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(i18n.t('data.receiptGroups.exclude'));
    expect(html).toContain(i18n.t('data.receiptGroups.deleteGroup'));
    expect(html).toContain('data-group-kind="manual"');
    const titleAt = html.indexOf('class="receipt-group-title"');
    const kindAt = html.indexOf('class="receipt-group-kind"');
    const totalAt = html.indexOf('class="receipt-total"');
    expect(titleAt).toBeGreaterThan(-1);
    expect(kindAt).toBeGreaterThan(titleAt);
    expect(totalAt).toBeGreaterThan(kindAt);
  });

  it('titles pharmacy + Wolt delivery with the pharmacy and restaurant kitchen + bar with the restaurant in Russian', async () => {
    const prevLang = i18n.language;
    await i18n.changeLanguage('ru');
    try {
      const pharmacyGroupHtml = renderToStaticMarkup(React.createElement(PurchaseOrderCard as any, {
        manualGroup: {
          id: 11,
          kind: 'manual',
          name: null,
          place: null,
          date: '2026-11-09',
          number: 11,
          receipts: [
            {
              receipt_key: 'pfr:SYNTH-PHARM',
              resolution: 'resolved',
              operation_ids: [10],
              fiscal_receipt_id: 'SYNTH-PHARM',
              date: '2026-11-09',
              store: 'Apoteka Benu',
              currency: 'RSD',
              posted_minor: -1400,
              base_minor: -14,
            },
            {
              receipt_key: 'pfr:SYNTH-WOLT',
              resolution: 'resolved',
              operation_ids: [11],
              fiscal_receipt_id: 'SYNTH-WOLT',
              date: '2026-11-09',
              store: 'Wolt',
              currency: 'RSD',
              posted_minor: -200,
              base_minor: -2,
            },
          ],
          subtotals: [{ currency: 'RSD', posted_minor: -1600, document_minor: null, document_known: false }],
          base_currency: 'USD',
          total_minor: -1600,
          total_currency: 'RSD',
          missing_rates: [],
          incomplete: false,
          multi_currency: false,
        },
        nestedCards: [
          { ...receipt, id: 'pfr:SYNTH-PHARM', store: 'Apoteka Benu', date: '2026-11-09', membershipKey: 'pfr:SYNTH-PHARM' },
          { ...receipt, id: 'pfr:SYNTH-WOLT', store: 'Wolt', date: '2026-11-09', membershipKey: 'pfr:SYNTH-WOLT' },
        ],
        onExcludeReceipt: () => {},
        onDeleteGroup: () => {},
      }));
      expect(pharmacyGroupHtml).toContain('Apoteka Benu');
      expect(pharmacyGroupHtml).toContain('data-group-date="2026-11-09"');
      expect(pharmacyGroupHtml).toContain('Группа чеков');
      expect(pharmacyGroupHtml).toContain('Исключить');
      expect(pharmacyGroupHtml).toContain('Удалить группу');

      const restaurantGroupHtml = renderToStaticMarkup(React.createElement(PurchaseOrderCard as any, {
        manualGroup: {
          id: 12,
          kind: 'manual',
          name: null,
          place: null,
          date: '2026-11-10',
          number: 12,
          receipts: [
            {
              receipt_key: 'pfr:SYNTH-REST-K',
              resolution: 'resolved',
              operation_ids: [12],
              fiscal_receipt_id: 'SYNTH-REST-K',
              date: '2026-11-10',
              store: 'Balkan Bistro - Kitchen',
              currency: 'RSD',
              posted_minor: -2500,
              base_minor: -25,
            },
            {
              receipt_key: 'pfr:SYNTH-REST-B',
              resolution: 'resolved',
              operation_ids: [13],
              fiscal_receipt_id: 'SYNTH-REST-B',
              date: '2026-11-10',
              store: 'Balkan Bistro - Bar',
              currency: 'RSD',
              posted_minor: -900,
              base_minor: -9,
            },
          ],
          subtotals: [{ currency: 'RSD', posted_minor: -3400, document_minor: null, document_known: false }],
          base_currency: 'USD',
          total_minor: -3400,
          total_currency: 'RSD',
          missing_rates: [],
          incomplete: false,
          multi_currency: false,
        },
        nestedCards: [
          { ...receipt, id: 'pfr:SYNTH-REST-K', store: 'Balkan Bistro - Kitchen', date: '2026-11-10', membershipKey: 'pfr:SYNTH-REST-K' },
          { ...receipt, id: 'pfr:SYNTH-REST-B', store: 'Balkan Bistro - Bar', date: '2026-11-10', membershipKey: 'pfr:SYNTH-REST-B' },
        ],
        onExcludeReceipt: () => {},
        onDeleteGroup: () => {},
      }));
      expect(restaurantGroupHtml).toContain('Balkan Bistro');
      expect(restaurantGroupHtml).toContain('data-group-date="2026-11-10"');
    } finally {
      await i18n.changeLanguage(prevLang);
    }
  });

  it('names a missing exchange rate on its own warning line and marks the total incomplete', () => {
    const html = renderToStaticMarkup(React.createElement(PurchaseOrderCard as any, {
      manualGroup: {
        id: 9,
        kind: 'manual',
        name: 'Trip',
        number: 9,
        receipts: [{
          receipt_key: receipt.membershipKey,
          resolution: 'resolved',
          operation_ids: [4],
          fiscal_receipt_id: null,
          currency: 'RSD',
          posted_minor: -1000,
          base_minor: null,
        }],
        subtotals: [{ currency: 'RSD', posted_minor: -1000, document_minor: null, document_known: false }],
        base_currency: 'USD',
        total_minor: null,
        total_currency: 'USD',
        missing_rates: ['RSD'],
        incomplete: true,
        multi_currency: true,
      },
      nestedCards: [receipt],
      onExcludeReceipt: () => {},
      onDeleteGroup: () => {},
    }));
    expect(html).toContain(i18n.t('data.receiptGroups.totalIncomplete'));
    expect(html).toContain(i18n.t('data.receiptGroups.missingRate', { currencies: 'RSD' }));
    expect(html).toContain('class="receipt-group-warning"');
    const titleAt = html.indexOf('class="receipt-group-title"');
    const warningAt = html.indexOf('class="receipt-group-warning"');
    const totalAt = html.indexOf('class="receipt-total"');
    const totalEnd = html.indexOf('</div>', totalAt);
    expect(warningAt).toBeGreaterThan(titleAt);
    expect(warningAt).toBeLessThan(totalAt);
    expect(html.slice(totalAt, totalEnd)).not.toContain('receipt-group-warning');
    expect(html.slice(totalAt, totalEnd)).not.toContain('Trip');
  });

  it('shows a pencil after the title only while the group is expanded, outside the expand control', () => {
    const manualGroup = {
      id: 8,
      kind: 'manual',
      name: null,
      place: 'Synth shop',
      date: '2026-11-01',
      number: 8,
      receipts: [{
        receipt_key: receipt.membershipKey,
        resolution: 'resolved',
        operation_ids: [4],
        fiscal_receipt_id: null,
        date: '2026-11-01',
        store: 'Synth shop',
        currency: 'RSD',
        posted_minor: -1000,
        base_minor: -10,
      }],
      subtotals: [{ currency: 'RSD', posted_minor: -1000, document_minor: null, document_known: false }],
      base_currency: 'USD',
      total_minor: -1000,
      total_currency: 'RSD',
      missing_rates: [],
      incomplete: false,
      multi_currency: false,
    };
    const html = renderToStaticMarkup(React.createElement(PurchaseOrderCard as any, {
      manualGroup,
      nestedCards: [receipt],
      forceOpen: true,
      onRename: () => {},
    }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('class="receipt-group-rename"');
    expect(html).toContain(i18n.t('data.receiptGroups.editTitle'));
    expect(html).not.toContain(i18n.t('data.receiptGroups.deleteGroup'));
    const toggleAt = html.indexOf('class="receipt-group-toggle"');
    const toggleEnd = html.indexOf('</button>', toggleAt);
    const pencilAt = html.indexOf('class="receipt-group-rename"');
    const titleAt = html.indexOf('class="receipt-group-title"');
    expect(pencilAt).toBeGreaterThan(toggleEnd);
    expect(pencilAt).toBeGreaterThan(titleAt);
    expect(html.slice(toggleAt, toggleEnd)).not.toContain('receipt-group-rename');
  });

  it('has no Provider or Order number form on the Receipts screen', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(FiscalReceiptsSection as any, {
          accounts: [{ id: 1, name: 'Synth RSD', currency: 'RSD' }],
          expanded: true,
          onToggle: () => {},
          search: '',
        }),
      ),
    );
    expect(html).not.toContain(i18n.t('data.orders.provider'));
    expect(html).not.toContain(i18n.t('data.orders.providerOrderId'));
    expect(html).not.toContain(i18n.t('data.orders.create'));
  });

  it('keeps the Group control, and the open grouping fields, on one sticky bar', () => {
    const idle = renderToStaticMarkup(React.createElement(ReceiptGroupToolbar, { selecting: false }));
    expect(idle).toContain('class="receipt-group-toolbar"');
    expect(idle).toContain(i18n.t('data.receiptGroups.group'));
    expect(idle).not.toContain(i18n.t('data.receiptGroups.confirm'));
    const open = renderToStaticMarkup(React.createElement(ReceiptGroupToolbar, {
      selecting: true,
      groupName: 'Market',
      selectedCount: 2,
      selectedHidden: 0,
    }));
    expect(open).toContain(i18n.t('data.receiptGroups.name'));
    expect(open).toContain(i18n.t('data.receiptGroups.selected', { count: 2 }));
    expect(open).toContain(i18n.t('data.receiptGroups.confirm'));
    expect(open).toContain(i18n.t('data.receiptGroups.cancel'));
    expect(open).not.toContain(i18n.t('data.receiptGroups.group'));
    const css = (env.PALETTE_CSS as string).replace(/\/\*[\s\S]*?\*\//g, '');
    const start = css.indexOf('.receipt-group-toolbar');
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toContain('position: sticky');
    expect(block).toContain('top: calc(var(--appbar-h) + var(--data-filter-bar-h))');
    expect(block).not.toMatch(/top:\s*\d+px/);
    expect(css).not.toContain('grid-template-columns: minmax(56px, auto) minmax(0, 1fr) 18px');
  });

  it('publishes a measured filter-bar height and ignores a zero height', () => {
    expect(measuredHeightVariable(87.6)).toBe('88px');
    expect(measuredHeightVariable(0)).toBeNull();
    expect(measuredHeightVariable(-4)).toBeNull();
    expect(measuredHeightVariable(Number.NaN)).toBeNull();
    const target = { style: { props: {} as Record<string, string>, setProperty(name: string, value: string) { this.props[name] = value; } } };
    publishMeasuredHeight({ offsetHeight: 64 }, '--data-filter-bar-h', target);
    expect(target.style.props['--data-filter-bar-h']).toBe('64px');
    publishMeasuredHeight({ offsetHeight: 0 }, '--data-filter-bar-h', target);
    expect(target.style.props['--data-filter-bar-h']).toBe('64px');
  });

  it('shows analytics receipt groups in the same date order without a Group button or a duplicate loose card', () => {
    const member = {
      id: 'manual_2026-11-01_1_member',
      date: '2026-11-01',
      store: 'Member shop',
      merchant: 'Member shop',
      account_name: 'Synth',
      account_currency: 'RSD',
      receipt_total_minor: 1000,
      receipt_total_base_minor: 10,
      positions_count: 1,
      lines: [{
        id: 4, item: 'Goods', category: null, subcategory: null, amount_minor: -1000, kind: 'expense', converted_minor: -10, comment: null, receipt_url: null,
      }],
    };
    const later = {
      ...member,
      id: 'manual_2026-11-12_1_later',
      date: '2026-11-12',
      store: 'Later shop',
      merchant: 'Later shop',
      lines: [{ ...member.lines[0], id: 99, item: 'Later goods' }],
    };
    const group = {
      id: 8,
      kind: 'manual',
      name: null,
      place: 'Member shop',
      date: '2026-11-01',
      number: 8,
      receipts: [{
        receipt_key: 'op:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        resolution: 'resolved',
        operation_ids: [4],
        fiscal_receipt_id: null,
        date: '2026-11-01',
        store: 'Member shop',
        currency: 'RSD',
        posted_minor: -1000,
        base_minor: -10,
      }],
      subtotals: [{ currency: 'RSD', posted_minor: -1000, document_minor: null, document_known: false }],
      base_currency: 'USD',
      total_minor: -1000,
      total_currency: 'RSD',
      missing_rates: [],
      incomplete: false,
      multi_currency: false,
    };
    const waiting = renderToStaticMarkup(React.createElement(AnalyticsReceiptList as any, {
      receipts: [member, later],
      receiptGroups: null,
      baseCurrency: 'USD',
    }));
    expect(waiting).toContain('skeleton-wrap');
    expect(waiting).not.toContain('Member shop');
    const html = renderToStaticMarkup(React.createElement(AnalyticsReceiptList as any, {
      receipts: [member, later],
      receiptGroups: [group],
      baseCurrency: 'USD',
      onRename: () => {},
    }));
    const laterAt = html.indexOf('Later shop');
    const groupAt = html.indexOf('data-group-kind="manual"');
    expect(laterAt).toBeGreaterThan(-1);
    expect(laterAt).toBeLessThan(groupAt);
    expect(html.replaceAll(i18n.t('data.receiptGroups.kind'), '')).not.toContain(i18n.t('data.receiptGroups.group'));
    expect(html).not.toContain('receipt-group-toolbar');
    expect(html).toContain(i18n.t('data.receiptGroups.kind'));
    expect(html.match(/class="receipt"/g)?.length).toBe(2);
  });
});
