import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '../src/ui/i18n.js';
import BackupSection from '../src/ui/BackupSection.jsx';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import { tabFromHash } from '../src/ui/Shell.jsx';

describe('Backup UI (issue #515)', () => {
  it('renders download and restore actions', () => {
    const html = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(BackupSection)),
    );
    expect(html).toContain('id="backup"');
    expect(html).toContain(i18n.t('data.backup.title'));
    expect(html).toContain(i18n.t('data.backup.hint'));
    expect(html).toContain(i18n.t('data.backup.scopeNote'));
    expect(html).toContain(i18n.t('data.backup.download'));
    expect(html).toContain(i18n.t('data.backup.restore'));
    expect(html).toContain('type="file"');
  });

  it('treats #/settings as the Data screen deep-link', () => {
    expect(tabFromHash('#/settings')).toBe('data');
    expect(tabFromHash('#/data/backup')).toBe('data');
    expect(tabFromHash('#/access')).toBe('access');
  });
});
