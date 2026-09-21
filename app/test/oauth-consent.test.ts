import { describe, expect, it } from 'vitest';
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
    expect(html).toContain('button:disabled');
    expect(html).toContain('data-busy');
  });
});

describe('consent form-action CSP (#561)', () => {
  it('allows the redirect_uri origin so post-Allow 302 can leave Money Flow', () => {
    expect(consentFormActionDirective('https://grok.com/connectors-oauth-exchange-code/')).toBe(
      "form-action 'self' https://grok.com",
    );
    expect(consentFormActionDirective('http://127.0.0.1:54321/callback')).toBe(
      "form-action 'self' http://127.0.0.1:54321",
    );
    const csp = buildConsentCsp('https://grok.com/connectors-oauth-exchange-code/');
    expect(csp).toContain("form-action 'self' https://grok.com");
    expect(csp).not.toContain('connectors-oauth-exchange-code');
  });

  it('falls back to self-only for missing or unsafe redirect URIs', () => {
    expect(consentFormActionDirective()).toBe("form-action 'self'");
    expect(consentFormActionDirective('not-a-url')).toBe("form-action 'self'");
    expect(consentFormActionDirective('https://user:pass@evil.example/cb')).toBe("form-action 'self'");
    expect(CONSENT_CSP).toContain("form-action 'self'");
    expect(CONSENT_CSP).not.toMatch(/form-action 'self' https:/);
  });
});
