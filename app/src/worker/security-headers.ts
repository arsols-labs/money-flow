import { CONSENT_SUBMIT_ONCE_CSP_HASH } from './oauth-consent';

/** Applied on Worker-handled responses (API, consent, MCP). SPA assets skip this. */
export const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' } as const;

/**
 * Base `form-action` for the consent document.
 *
 * Chrome applies `form-action` to the POST and to every later hop. A registered
 * https callback may answer 301, 302, or 308 with a different https origin.
 * Pinning only the registered origin blocks that hop. `https:` allows it.
 * The Worker still redirects only to the redirect_uri the provider accepted
 * for this client; this directive does not choose the Location. Loopback HTTP
 * stays limited to localhost and 127.0.0.1 on any port. A custom-scheme
 * redirect adds only its scheme, never a path.
 */
export const CONSENT_FORM_ACTION =
  "form-action 'self' https: http://localhost:* http://127.0.0.1:*";

const UNSAFE_FORM_ACTION_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'blob:',
  'file:',
  'about:',
  'vbscript:',
]);

/**
 * `form-action` for one consent response. `redirectUri` is the URI already
 * accepted for this client. HTTP(S) uses {@link CONSENT_FORM_ACTION}. A
 * registered custom scheme is appended as a scheme source.
 */
export function consentFormActionDirective(redirectUri?: string): string {
  const scheme = customSchemeFormActionSource(redirectUri);
  return scheme ? `${CONSENT_FORM_ACTION} ${scheme}` : CONSENT_FORM_ACTION;
}

function customSchemeFormActionSource(redirectUri?: string): string | null {
  if (!redirectUri) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:' || url.protocol === 'https:') return null;
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return null;
  if (UNSAFE_FORM_ACTION_PROTOCOLS.has(url.protocol)) return null;
  return url.protocol;
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
 * Default consent CSP. Prefer {@link buildConsentCsp} with the request
 * redirect_uri so a custom-scheme client is included.
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
