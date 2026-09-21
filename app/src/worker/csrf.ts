/** Browser mutation guards for cookie-authenticated /api/v2 routes. */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function edgeOriginFromRequestUrl(requestUrl: string): string | null {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return null;
  }
}

/** Exact scheme+host+port match — not hostname-only. */
export function originMatchesRequest(origin: string | undefined, requestUrl: string): boolean {
  if (!origin) return false;
  const edge = edgeOriginFromRequestUrl(requestUrl);
  if (!edge) return false;
  try {
    return new URL(origin).origin === edge;
  } catch {
    return false;
  }
}

export function isCrossSiteFetch(secFetchSite: string | undefined): boolean {
  return (secFetchSite || '').toLowerCase() === 'cross-site';
}

export function isJsonContentType(contentType: string | undefined): boolean {
  const ct = (contentType || '').toLowerCase();
  return ct.includes('application/json');
}

/**
 * Reject cookie-authenticated browser mutations that are not same-origin JSON
 * (or a custom non-safelisted header). Internal MCP fetches skip this.
 */
export function browserMutationRejection(
  method: string,
  requestUrl: string,
  headers: {
    origin?: string;
    secFetchSite?: string;
    contentType?: string;
    requestedWith?: string;
  },
): 'CSRF_ORIGIN_INVALID' | 'CSRF_REQUEST_REJECTED' | 'CONTENT_TYPE_INVALID' | null {
  const verb = method.toUpperCase();
  if (!MUTATING.has(verb)) return null;

  if (isCrossSiteFetch(headers.secFetchSite)) {
    return 'CSRF_REQUEST_REJECTED';
  }

  if (headers.origin && !originMatchesRequest(headers.origin, requestUrl)) {
    return 'CSRF_ORIGIN_INVALID';
  }

  if (verb === 'POST' || verb === 'PUT' || verb === 'PATCH') {
    const ct = headers.contentType || '';
    if (ct.length > 0 && !isJsonContentType(ct) && headers.requestedWith !== '1') {
      return 'CONTENT_TYPE_INVALID';
    }
  }

  return null;
}
