import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '../src/ui/i18n.js';
import ResetSection, { RESET_CONFIRM_PHRASE } from '../src/ui/ResetSection.jsx';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import { tabFromHash } from '../src/ui/Shell.jsx';

describe('Reset UI (issue #579)', () => {
  it('renders the reset section next to the typed-confirm action', () => {
    const html = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(ResetSection)),
    );
    expect(html).toContain('id="reset"');
    expect(html).toContain(i18n.t('data.reset.title'));
    expect(html).toContain(i18n.t('data.reset.hint'));
    expect(html).toContain(i18n.t('data.reset.scopeNote'));
    expect(html).toContain(i18n.t('data.reset.action'));
    expect(RESET_CONFIRM_PHRASE).toBe('RESET');
  });

  it('treats #/data/reset as the Data screen deep-link', () => {
    expect(tabFromHash('#/data/reset')).toBe('data');
    expect(tabFromHash('#/data/backup')).toBe('data');
  });
});
