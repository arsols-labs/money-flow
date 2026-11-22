import { compileBoundedRegex } from './rules/matcher';
import type { FiscalFormatPayload, ResolvedRuleEntry } from './rules/types';

/**
 * Canonical fiscal-document identity for duplicate detection.
 *
 * All verification URL hosts, query parameters, paths, and fiscal-id patterns
 * are supplied dynamically from active D1 `fiscal_formats` rules.
 */

export type FiscalDocumentIdentity =
  | { kind: 'pfr'; value: string; format_id?: string }
  | { kind: 'url'; value: string; format_id: string };

export class MissingFiscalFormatConfigError extends Error {
  readonly code = 'MISSING_CONFIGURATION';
  readonly domain = 'fiscal_formats';

  constructor(message = 'No active fiscal_formats rules are configured in D1 rules.') {
    super(message);
    this.name = 'MissingFiscalFormatConfigError';
  }
}

export function normalizeFiscalReceiptId(value: string | null | undefined, uppercase = true): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return uppercase ? trimmed.toUpperCase() : trimmed;
}

function unwrapFormats(
  formats: ReadonlyArray<FiscalFormatPayload | ResolvedRuleEntry<FiscalFormatPayload>>,
): FiscalFormatPayload[] {
  return formats.map((item) => ('payload' in item ? item.payload : item));
}

function hostMatchesFormat(hostname: string, format: FiscalFormatPayload): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const allowSubdomains = format.allow_subdomains ?? true;
  for (const rawAllowed of format.allowed_hosts) {
    const allowed = rawAllowed.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (host === allowed) return true;
    if (allowSubdomains && host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function findFiscalIdInText(text: string | null | undefined, format: FiscalFormatPayload): string | null {
  if (!text || !format.pfr_in_text_pattern) return null;
  const regex = compileBoundedRegex(format.pfr_in_text_pattern, 'u');
  if (!regex) return null;
  const match = text.slice(0, 4096).match(regex);
  if (!match?.[0]) return null;
  return (format.pfr_canonical_uppercase ?? true) ? match[0].toUpperCase() : match[0];
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

function canonicalOpaqueToken(
  token: string,
  format: FiscalFormatPayload,
): string | null {
  if (format.vl_token_pattern) {
    const tokenRe = compileBoundedRegex(format.vl_token_pattern, 'u');
    if (tokenRe && !tokenRe.test(token)) return null;
  }
  const decoded = (format.vl_base64_scan ?? true) ? decodeBase64Payload(token) : null;
  if (decoded && decoded.length >= 8 && !findFiscalIdInText(decoded, format)) return decoded;
  if (token.length >= 8 && !findFiscalIdInText(token, format)) return token;
  return null;
}

export function matchFiscalFormatForUrl(
  value: string | null | undefined,
  formats: ReadonlyArray<FiscalFormatPayload | ResolvedRuleEntry<FiscalFormatPayload>> = [],
): FiscalFormatPayload | null {
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

  for (const format of unwrapFormats(formats)) {
    const allowedPorts = format.allowed_ports ?? [80, 443];
    if (url.port && !allowedPorts.includes(Number(url.port))) continue;
    if (hostMatchesFormat(url.hostname, format)) return format;
  }
  return null;
}

export function identityFromReceiptUrl(
  value: string | null | undefined,
  formats: ReadonlyArray<FiscalFormatPayload | ResolvedRuleEntry<FiscalFormatPayload>> = [],
): FiscalDocumentIdentity | null {
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

  for (const format of unwrapFormats(formats)) {
    const allowedPorts = format.allowed_ports ?? [80, 443];
    if (url.port && !allowedPorts.includes(Number(url.port))) continue;
    if (!hostMatchesFormat(url.hostname, format)) continue;

    const queryParam = format.query_param?.trim() ?? '';
    const paramVal = queryParam ? (rawQueryValue(url.search, queryParam)?.trim() ?? '') : '';
    const decoded = paramVal && (format.vl_base64_scan ?? true) ? decodeBase64Payload(paramVal) : null;
    const pfr = findFiscalIdInText(paramVal, format)
      ?? findFiscalIdInText(decoded, format)
      ?? findFiscalIdInText(`${url.pathname}${url.search}`, format);
    if (pfr) return { kind: 'pfr', value: pfr, format_id: format.id };

    const expectedPath = (format.canonical_path ?? '/').replace(/\/+$/, '') || '/';
    const actualPath = (url.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    if (actualPath !== expectedPath.toLowerCase()) continue;

    if (!queryParam) {
      return {
        kind: 'url',
        value: `${format.canonical_scheme}://${format.canonical_host}${expectedPath}`,
        format_id: format.id,
      };
    }

    const token = paramVal ? canonicalOpaqueToken(paramVal, format) : null;
    if (!token) continue;
    return {
      kind: 'url',
      value: `${format.canonical_scheme}://${format.canonical_host}${expectedPath}?${encodeURIComponent(queryParam)}=${encodeURIComponent(token)}`,
      format_id: format.id,
    };
  }
  return null;
}

export function canonicalFiscalIdentity(
  input: {
    fiscal_receipt_id?: string | null;
    receipt_url?: string | null;
  },
  formats: ReadonlyArray<FiscalFormatPayload | ResolvedRuleEntry<FiscalFormatPayload>> = [],
): FiscalDocumentIdentity | null {
  const explicit = normalizeFiscalReceiptId(input.fiscal_receipt_id);
  if (explicit) return { kind: 'pfr', value: explicit };
  return identityFromReceiptUrl(input.receipt_url, formats);
}

/**
 * Requires at least one active fiscal format rule when validating a verification URL.
 */
export function requireFiscalUrlIdentity(
  receiptUrl: string,
  formats: ReadonlyArray<FiscalFormatPayload | ResolvedRuleEntry<FiscalFormatPayload>>,
): FiscalDocumentIdentity | null {
  const list = unwrapFormats(formats);
  if (list.length === 0) {
    throw new MissingFiscalFormatConfigError();
  }
  return identityFromReceiptUrl(receiptUrl, list);
}

/**
 * True only when both sides have a fiscal id and those ids differ.
 * An opaque verification URL is not a fiscal id, so it cannot make two
 * expenses distinct.
 */
export function fiscalDocumentsAreDistinct(
  left: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
  right: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
  formats: ReadonlyArray<FiscalFormatPayload | ResolvedRuleEntry<FiscalFormatPayload>> = [],
): boolean {
  const a = canonicalFiscalIdentity(left, formats);
  const b = canonicalFiscalIdentity(right, formats);
  if (!a || !b || a.kind !== 'pfr' || b.kind !== 'pfr') return false;
  return a.value !== b.value;
}

/** Equal normalized verification URLs, and only when neither side resolved to a fiscal id. */
export function normalizedVerificationUrlsMatch(
  left: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
  right: { fiscal_receipt_id?: string | null; receipt_url?: string | null },
  formats: ReadonlyArray<FiscalFormatPayload | ResolvedRuleEntry<FiscalFormatPayload>> = [],
): boolean {
  const a = canonicalFiscalIdentity(left, formats);
  const b = canonicalFiscalIdentity(right, formats);
  return Boolean(a && b && a.kind === 'url' && b.kind === 'url' && a.value === b.value);
}
