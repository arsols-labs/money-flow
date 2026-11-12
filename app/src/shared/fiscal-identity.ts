/**
 * Canonical fiscal-document identity for duplicate detection.
 *
 * A different receipt URL string is not a different document. Verification
 * links for one receipt vary by parameter order, tracking parameters,
 * percent-encoding, scheme, host case, host alias, and a trailing slash.
 * Only two explicit or extracted fiscal ids that differ are distinct
 * documents. A normalized verification URL can show that two links are the
 * same document. A different opaque `vl`, a PURS host, or any other URL
 * string is not a different document and does not bypass the order-id guard.
 */

const PFR_IN_TEXT = /[A-Za-z0-9]{8}-[A-Za-z0-9]{8}-[0-9]{1,12}/;
const CANONICAL_PURS_HOST = 'suf.purs.gov.rs';

export type FiscalDocumentIdentity =
  | { kind: 'pfr'; value: string }
  | { kind: 'url'; value: string };

export function normalizeFiscalReceiptId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
}

function isPursHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return host === 'purs.gov.rs' || host.endsWith('.purs.gov.rs');
}

function findPfr(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(PFR_IN_TEXT);
  return match ? match[0]!.toUpperCase() : null;
}

function decodeBase64Payload(value: string): string | null {
  const cleaned = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length < 4) return null;
  const padLength = cleaned.length % 4 === 0 ? 0 : 4 - (cleaned.length % 4);
  if (padLength > 0 && cleaned.endsWith('=')) return null;
  try {
    const binary = atob(cleaned + '='.repeat(padLength));
    if ([...binary].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 && char !== '\n' && char !== '\r' && char !== '\t';
    })) return null;
    const text = binary.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Percent-decode a query value without treating '+' as a space. */
function rawQueryValue(search: string, name: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const wanted = name.toLowerCase();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      key = rawKey;
    }
    if (key.toLowerCase() !== wanted) continue;
    if (eq === -1) return '';
    const raw = part.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function canonicalOpaqueToken(vl: string): string | null {
  const decoded = decodeBase64Payload(vl);
  if (decoded && decoded.length >= 8 && !findPfr(decoded)) return decoded;
  if (vl.length >= 8 && !findPfr(vl)) return vl;
  return null;
}

function identityFromReceiptUrl(value: string | null | undefined): FiscalDocumentIdentity | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  if (!isPursHost(url.hostname)) return null;

  const vl = rawQueryValue(url.search, 'vl')?.trim() ?? '';
  const decoded = vl ? decodeBase64Payload(vl) : null;
  const pfr = findPfr(vl) ?? findPfr(decoded) ?? findPfr(`${url.pathname}${url.search}`);
  if (pfr) return { kind: 'pfr', value: pfr };

  const path = (url.pathname.replace(/\/+$/, '') || '/').toLowerCase();
  if (path !== '/v') return null;
  const token = vl ? canonicalOpaqueToken(vl) : null;
  if (!token) return null;
  // Only `vl` identifies the verification link. Parameter order, tracking
  // parameters, scheme, host case, host alias, and a trailing slash do not.
  return { kind: 'url', value: `https://${CANONICAL_PURS_HOST}/v?vl=${encodeURIComponent(token)}` };
}

export function canonicalFiscalIdentity(input: {
  fiscal_receipt_id?: string | null;
  receipt_url?: string | null;
}): FiscalDocumentIdentity | null {
  const explicit = normalizeFiscalReceiptId(input.fiscal_receipt_id);
  if (explicit) return { kind: 'pfr', value: explicit };
  return identityFromReceiptUrl(input.receipt_url);
}

/**
 * True only when both sides have a fiscal id and those ids differ.
 * An opaque verification URL is not a fiscal id, so it cannot make two
 * expenses distinct.
 */
export function fiscalDocumentsAreDistinct(
  left: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
  right: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
): boolean {
  const a = canonicalFiscalIdentity(left);
  const b = canonicalFiscalIdentity(right);
  if (!a || !b || a.kind !== 'pfr' || b.kind !== 'pfr') return false;
  return a.value !== b.value;
}

/** Equal normalized verification URLs, and only when neither side resolved to a fiscal id. */
export function normalizedVerificationUrlsMatch(
  left: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
  right: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
): boolean {
  const a = canonicalFiscalIdentity(left);
  const b = canonicalFiscalIdentity(right);
  return Boolean(a && b && a.kind === 'url' && b.kind === 'url' && a.value === b.value);
}
