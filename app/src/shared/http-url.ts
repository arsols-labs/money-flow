/** Fiscal/verification URLs (PURS QR and similar) can exceed typical 2 KiB caps. */
export const RECEIPT_URL_MAX_LENGTH = 4096;

/**
 * Accept only http(s) URLs so a stored value is safe to render as <a href>.
 * Empty/whitespace → null. Invalid protocol, unparseable string, or over-max
 * length → null (callers that need a 400 should distinguish before calling).
 */
export function parseHttpUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > RECEIPT_URL_MAX_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}
