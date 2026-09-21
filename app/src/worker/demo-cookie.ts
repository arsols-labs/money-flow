export const DEMO_SESSION_COOKIE = 'mf_demo_sid';

const DEMO_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readDemoSessionId(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${DEMO_SESSION_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  let value = match[1].trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  return DEMO_SESSION_ID.test(value) ? value.toLowerCase() : null;
}

export function mergeCookieHeader(
  existing: string | null | undefined,
  name: string,
  value: string,
): string {
  const parts = (existing ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${name}=`));
  parts.push(`${name}=${value}`);
  return parts.join('; ');
}

export function demoSessionCookie(sessionId: string, secure: boolean, maxAgeSec: number): string {
  return [
    `${DEMO_SESSION_COOKIE}=${sessionId}`,
    `Max-Age=${maxAgeSec}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearDemoSessionCookie(secure: boolean): string {
  return [
    `${DEMO_SESSION_COOKIE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function responseClearsDemoCookie(response: Response): boolean {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  return cookies.some(
    (cookie) => cookie.startsWith(`${DEMO_SESSION_COOKIE}=`) && /max-age=0/i.test(cookie),
  );
}
