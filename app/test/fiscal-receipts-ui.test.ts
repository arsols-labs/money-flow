import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import FiscalReceiptsSection from '../src/ui/FiscalReceiptsSection.jsx';
import i18n from '../src/ui/i18n.js';

describe('Data fiscal receipts section (issue #557)', () => {
  it('renders the Чеки section title and empty state without throwing', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(FiscalReceiptsSection as any, {
          accounts: [{ id: 1, name: 'RSD card', currency: 'RSD' }],
          expanded: true,
          onToggle: () => {},
          search: '',
        }),
      ),
    );
    expect(html).toContain(i18n.t('data.blocks.receipts.title'));
  });
});
