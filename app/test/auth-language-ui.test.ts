import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import Login from '../src/ui/Login.jsx';
import PasskeySetup from '../src/ui/PasskeySetup.jsx';
import i18n from '../src/ui/i18n.js';
import { SUPPORTED_LANGUAGES } from '../src/ui/language.js';

describe('auth language switcher (issue #586)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows the shared language switcher on login and passkey setup', async () => {
    await i18n.changeLanguage('en');
    const loginHtml = renderToStaticMarkup(
      React.createElement(Login, { hasPasskeys: true, onSuccess: () => {} }),
    );
    const setupHtml = renderToStaticMarkup(React.createElement(PasskeySetup));

    for (const html of [loginHtml, setupHtml]) {
      expect(html).toContain('class="auth-screen"');
      expect(html).toContain('class="auth-lang"');
      expect(html).toContain('aria-label="Language"');
      expect(html).toContain('aria-haspopup="listbox"');
    }
  });

  it('renders Serbian auth copy after changeLanguage', async () => {
    await i18n.changeLanguage('sr');
    const html = renderToStaticMarkup(
      React.createElement(Login, { hasPasskeys: true, onSuccess: () => {} }),
    );
    expect(html).toContain('Finansijski horizont');
    expect(html).toContain('Prijava passkey-em');
    expect(html).toContain('aria-label="Jezik"');
    expect(html).not.toContain('undefined');
  });

  it('keeps the supported-language list aligned with the switcher', () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'ru', 'de', 'fr', 'es', 'pt', 'sr']);
  });
});
