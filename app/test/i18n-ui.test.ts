import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import Shell from '../src/ui/Shell.jsx';
import i18n from '../src/ui/i18n.js';

describe('language switch on Shell chrome (issue #512)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders English tab labels by default and Russian after changeLanguage', async () => {
    await i18n.changeLanguage('en');
    const enHtml = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Shell, { theme: 'dark', setTheme: () => {} })),
    );
    expect(enHtml).toContain('Pulse');
    expect(enHtml).toContain('Analytics');
    expect(enHtml).toContain('Data');
    expect(enHtml).toContain('Access');
    expect(enHtml).toContain('aria-label="Main navigation"');
    expect(enHtml).not.toContain('undefined');

    await i18n.changeLanguage('ru');
    const ruHtml = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Shell, { theme: 'dark', setTheme: () => {} })),
    );
    expect(ruHtml).toContain('Пульс');
    expect(ruHtml).toContain('Аналитика');
    expect(ruHtml).toContain('Данные');
    expect(ruHtml).toContain('Доступ');
    expect(ruHtml).toContain('aria-label="Основная навигация"');
    expect(ruHtml).not.toContain('undefined');
  });

  it('renders de/fr/es/pt/sr tab labels after changeLanguage', async () => {
    const cases = [
      { lng: 'de', tabs: ['Pulse', 'Analytics', 'Daten', 'Zugang'], nav: 'Hauptnavigation' },
      { lng: 'fr', tabs: ['Pulse', 'Analytics', 'Données', 'Accès'], nav: 'Navigation principale' },
      { lng: 'es', tabs: ['Pulse', 'Analytics', 'Datos', 'Acceso'], nav: 'Navegación principal' },
      { lng: 'pt', tabs: ['Pulse', 'Analytics', 'Dados', 'Acesso'], nav: 'Navegação principal' },
      { lng: 'sr', tabs: ['Pulse', 'Analytics', 'Podaci', 'Pristup'], nav: 'Glavna navigacija' },
    ] as const;

    for (const { lng, tabs, nav } of cases) {
      await i18n.changeLanguage(lng);
      const html = renderToStaticMarkup(
        React.createElement(RefreshProvider, null, React.createElement(Shell, { theme: 'dark', setTheme: () => {} })),
      );
      for (const tab of tabs) expect(html, lng).toContain(tab);
      expect(html, lng).toContain(`aria-label="${nav}"`);
      expect(html, lng).not.toContain('undefined');
    }
  });
});
