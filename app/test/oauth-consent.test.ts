import { describe, expect, it } from 'vitest';
import { LANGUAGE_STORAGE_KEY } from '../src/ui/language.js';
import de from '../src/ui/locales/de.json';
import en from '../src/ui/locales/en.json';
import es from '../src/ui/locales/es.json';
import fr from '../src/ui/locales/fr.json';
import pt from '../src/ui/locales/pt.json';
import ru from '../src/ui/locales/ru.json';
import sr from '../src/ui/locales/sr.json';
import { escapeHtml } from '../src/worker/html';
import {
  CONSENT_SUBMIT_ONCE_CSP_HASH,
  CONSENT_SUBMIT_ONCE_JS,
  renderConsentHtml,
} from '../src/worker/oauth-consent';
import {
  CONSENT_CSP,
  buildConsentCsp,
  consentFormActionDirective,
} from '../src/worker/security-headers';

const CATALOGS = { en, ru, de, fr, es, pt, sr } as const;

function consentPage(options?: Parameters<typeof renderConsentHtml>[1]) {
  return renderConsentHtml({
    clientId: 'https://client.example/oauth.json',
    clientName: 'Test',
    clientHost: 'client.example',
    redirectUri: 'https://example.com/callback',
    scope: ['read', 'write'],
    state: 'st',
    csrfToken: '1.abc',
  }, options);
}

describe('consent submit-once (#559)', () => {
  it('keeps CSP sha256 hash byte-identical to CONSENT_SUBMIT_ONCE_JS', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CONSENT_SUBMIT_ONCE_JS));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(`sha256-${b64}`).toBe(CONSENT_SUBMIT_ONCE_CSP_HASH);
    expect(CONSENT_CSP).toContain(`'${CONSENT_SUBMIT_ONCE_CSP_HASH}'`);
    expect(CONSENT_CSP).not.toContain("script-src 'none'");
  });

  it('embeds submit-once script and form id without escaping the handler body', () => {
    const html = renderConsentHtml({
      clientId: 'test-client',
      clientName: 'Test',
      clientHost: 'local / pre-registered',
      redirectUri: 'https://example.com/callback',
      scope: ['read', 'write'],
      state: 'st',
      csrfToken: '1.abc',
    });
    expect(html).toContain('id="consent-form"');
    expect(html).toContain(`<script>${CONSENT_SUBMIT_ONCE_JS}</script>`);
    expect(html.indexOf('<script>')).toBeGreaterThan(html.indexOf('</form>'));
    expect(html).toContain('button:disabled');
    expect(html).toContain('data-busy');
    expect(CONSENT_SUBMIT_ONCE_JS).toContain("getAttribute('data-submitting-label')");
    expect(/^[\u0000-\u007f]*$/.test(CONSENT_SUBMIT_ONCE_JS)).toBe(true);
  });
});

describe('consent page locale', () => {
  for (const locale of Object.keys(CATALOGS) as Array<keyof typeof CATALOGS>) {
    it(`renders ${locale} from Accept-Language`, () => {
      const copy = CATALOGS[locale].oauth.consent;
      const html = consentPage({ acceptLanguage: locale });
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain(`<title>${escapeHtml(copy.title)}</title>`);
      expect(html).toContain(`>${escapeHtml(copy.deny)}</button>`);
      expect(html).toContain(`>${escapeHtml(copy.allow)}</button>`);
      expect(html).toContain(`data-submitting-label="${escapeHtml(copy.submitting)}"`);
      expect(html).toContain(escapeHtml(copy.scopeRead));
      expect(html).toContain(escapeHtml(copy.scopeWrite));
      expect(CONSENT_SUBMIT_ONCE_JS).not.toContain(copy.submitting);
    });
  }

  it('lets an mf_lang cookie override Accept-Language', () => {
    expect(LANGUAGE_STORAGE_KEY).toBe('mf_lang');
    const html = consentPage({
      cookieHeader: `mf_session=abc; ${LANGUAGE_STORAGE_KEY}=ru; theme=dark`,
      acceptLanguage: 'en-US,en;q=0.9',
    });
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain(`>${escapeHtml(ru.oauth.consent.allow)}</button>`);
    expect(html).toContain(`>${escapeHtml(ru.oauth.consent.deny)}</button>`);
    expect(html).not.toContain(`>${escapeHtml(en.oauth.consent.allow)}</button>`);
  });

  it('falls back to English for unknown or missing languages', () => {
    for (const acceptLanguage of ['ja', '*', '', undefined]) {
      const html = consentPage({ acceptLanguage });
      expect(html, String(acceptLanguage)).toContain('<html lang="en">');
      expect(html).toContain(`>${escapeHtml(en.oauth.consent.allow)}</button>`);
      expect(html).toContain(`>${escapeHtml(en.oauth.consent.deny)}</button>`);
    }
    const missing = renderConsentHtml({
      clientId: 'test-client',
      clientName: 'Test',
      clientHost: 'local / pre-registered',
      redirectUri: 'https://example.com/callback',
      scope: ['read'],
      state: 'st',
      csrfToken: '1.abc',
    });
    expect(missing).toContain('<html lang="en">');
  });

  it('maps region tags with the same rules as language.js', () => {
    const cases = [
      ['pt-BR', 'pt', pt],
      ['sr-Latn-RS', 'sr', sr],
      ['de-AT', 'de', de],
    ] as const;
    for (const [header, locale, catalog] of cases) {
      const html = consentPage({ acceptLanguage: header });
      expect(html, header).toContain(`<html lang="${locale}">`);
      expect(html).toContain(`>${escapeHtml(catalog.oauth.consent.allow)}</button>`);
      expect(html).toContain(`>${escapeHtml(catalog.oauth.consent.deny)}</button>`);
    }
  });

  it('ignores an unmapped mf_lang cookie and uses Accept-Language', () => {
    const html = consentPage({
      cookieHeader: `${LANGUAGE_STORAGE_KEY}=ja`,
      acceptLanguage: 'de-AT',
    });
    expect(html).toContain('<html lang="de">');
    expect(html).toContain(`>${escapeHtml(de.oauth.consent.allow)}</button>`);
  });

  it('escapes client name and host', () => {
    const html = renderConsentHtml({
      clientId: 'https://evil.example/meta',
      clientName: '"><img src=x onerror=alert(1)>',
      clientHost: '<script>alert(1)</script>',
      redirectUri: 'https://example.com/callback?q="1"',
      scope: ['read', '<write>'],
      state: 'st',
      csrfToken: '1.abc',
    }, { acceptLanguage: 'en' });
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;write&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>alert');
    expect(html.match(/<script>/g)).toEqual([`<script>`]);
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain('name="scope_control" value="1"');
    expect(html).toContain(`<script>${CONSENT_SUBMIT_ONCE_JS}</script>`);
  });
});

const FORM_ACTION =
  "form-action 'self' https: http://localhost:* http://127.0.0.1:*";

describe('consent form-action CSP (#561)', () => {
  it('allows any https callback and loopback ports without pinning the host', () => {
    const callbacks = [
      'https://chat.openai.com/connector_platform_oauth_redirect',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://oauth-redirect.googleusercontent.com/r/money-flow',
      'https://claude.ai/api/mcp/auth_callback',
      'https://www.example.com/cb',
      'http://127.0.0.1:54321/callback',
      'http://localhost:9999/cb',
    ];
    for (const uri of callbacks) {
      expect(consentFormActionDirective(uri), uri).toBe(FORM_ACTION);
    }
    const csp = buildConsentCsp('https://chat.openai.com/connector_platform_oauth_redirect');
    expect(csp).toContain(FORM_ACTION);
    expect(csp).not.toContain('chat.openai.com');
    expect(csp).not.toContain('chatgpt.com');
    expect(csp).not.toContain('connector_platform_oauth_redirect');
  });

  it('adds only the scheme of a custom-scheme redirect URI', () => {
    expect(consentFormActionDirective('vscode://vscode.git/callback')).toBe(
      `${FORM_ACTION} vscode:`,
    );
    expect(consentFormActionDirective('myapp://oauth/callback')).toBe(`${FORM_ACTION} myapp:`);
  });

  it('does not add a scheme for a missing, unparseable, or unsafe redirect URI', () => {
    expect(consentFormActionDirective()).toBe(FORM_ACTION);
    expect(consentFormActionDirective('not-a-url')).toBe(FORM_ACTION);
    expect(consentFormActionDirective('https://user:pass@evil.example/cb')).toBe(FORM_ACTION);
    expect(consentFormActionDirective('javascript:alert(1)')).toBe(FORM_ACTION);
    expect(consentFormActionDirective('data:text/html,hi')).toBe(FORM_ACTION);
    expect(CONSENT_CSP).toContain(FORM_ACTION);
  });
});
