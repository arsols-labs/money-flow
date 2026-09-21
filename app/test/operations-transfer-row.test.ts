import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TransferRow } from '../src/ui/OperationsSection.jsx';
import { formatMinor } from '../src/ui/money.js';
import i18n from '../src/ui/i18n.js';

const accounts = [
  { id: 1, name: 'Наличные', archived: false },
  { id: 2, name: 'Карта', archived: false },
];

const out = {
  id: 101,
  date: '2026-08-18',
  account_id: 1,
  amount_minor: -12345,
  currency: 'RSD',
  category: 'Переводы',
  subcategory: 'Между счетами',
  item: 'Пополнение карты',
  store: 'Мой банк',
};

const inn = {
  id: 102,
  date: '2026-08-18',
  account_id: 2,
  amount_minor: 12345,
  currency: 'RSD',
  category: 'Переводы',
  subcategory: 'Между счетами',
  item: 'Пополнение карты',
  store: 'Мой банк',
};

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(
    React.createElement(
      'ul',
      null,
      React.createElement(TransferRow, {
        out,
        inn,
        accounts,
        expanded: false,
        onToggle: () => {},
        onDelete: () => {},
        ...props,
      }),
    ),
  ).replaceAll('\u00A0', ' ');
}

describe('TransferRow', () => {
  it('использует общую оболочку строки вместо нативной кнопки', () => {
    const html = render({});

    expect(html).toContain('class="data-row data-row--transfer"');
    expect(html).toContain('class="data-row-top"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('<button type="button" class="data-row-main"');
  });

  it('в раскрытии показывает обе стороны перевода и детали на токенах секции', () => {
    const html = render({ expanded: true });

    expect(html).toContain('Наличные → Карта');
    expect(html).toContain(formatMinor(Math.abs(out.amount_minor), out.currency).replaceAll('\u00A0', ' '));
    expect(html).toContain(i18n.t('data.operations.debitAccount', { account: 'Наличные' }));
    expect(html).toContain(i18n.t('data.operations.creditAccount', { account: 'Карта' }));
    expect(html).toContain('Переводы / Между счетами · Пополнение карты · Мой банк');
    expect(html).toContain('class="transfer-detail-card"');
    expect(html).toContain('class="btn-danger"');
    expect(html).toContain(i18n.t('common.deleteTransfer'));
  });

  it('в свёрнутой строке показывает i18n-ссылку, а не полный URL', () => {
    const url = 'https://suf.purs.gov.rs/v/?vl=' + 'B'.repeat(80);
    const html = render({
      out: { ...out, receipt_url: url },
      inn: { ...inn, receipt_url: url },
    });
    expect(html).toContain(`>${i18n.t('common.link')}</a>`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/>https:\/\/suf\.purs/);
  });
});
