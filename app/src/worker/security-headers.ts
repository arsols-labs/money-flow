import { CONSENT_SUBMIT_ONCE_CSP_HASH } from './oauth-consent';

/** Applied on Worker-handled responses (API, consent, MCP). SPA assets skip this. */
export const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' } as const;

/**
 * Consent form POST is same-origin (`'self'`), but browsers also apply
 * `form-action` to the post-submit navigation — including a 302 Location to
 * the OAuth client's redirect_uri. Without that origin, Chrome keeps the
 * consent window stuck on Money Flow while the server already issued the code
 * (#561 / Grok connectors).
 */
export function consentFormActionDirective(redirectUri?: string): string {
  if (!redirectUri) return "form-action 'self'";
  try {
    const url = new URL(redirectUri);
    if (url.username || url.password) return "form-action 'self'";
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return "form-action 'self'";
    // Origin only (scheme + host + port). Never interpolate path/query into CSP.
    return `form-action 'self' ${url.origin}`;
  } catch {
    return "form-action 'self'";
  }
}

export function buildConsentCsp(redirectUri?: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src '${CONSENT_SUBMIT_ONCE_CSP_HASH}'`,
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    consentFormActionDirective(redirectUri),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Default consent CSP (same-origin form only). Prefer {@link buildConsentCsp}
 * with the request redirect_uri on the consent HTML response.
 */
export const CONSENT_CSP = buildConsentCsp();

export function consentSecurityHeaders(redirectUri?: string): Record<string, string> {
  return {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': buildConsentCsp(redirectUri),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

export function workerSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
