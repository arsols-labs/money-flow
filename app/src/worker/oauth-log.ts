/**
 * Structured OAuth logs for Workers Logs.
 * Drops token material, OAuth state, and redirect query strings before writing.
 * The OAuth error `code` (for example `invalid_grant`) is not token material.
 */

const SECRET_LOG_KEYS = new Set([
  'state',
  'secret',
  'access_token',
  'refresh_token',
  'authorization',
  'redirect_uri',
  'redirecturi',
  'redirectto',
  'redirect_to',
  'token',
  'code_verifier',
  'client_secret',
]);

/**
 * `userId:grantId:secret` from workers-oauth-provider.
 * Both the grant id and the secret are at least 8 characters, so file:line:column
 * stack frames are left alone. The grant id itself has no colons.
 */
const TOKEN_SHAPED = /\b[A-Za-z0-9_-]+:[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}\b/g;

function redactLogString(value: string): string {
  const withoutTokens = value.replace(TOKEN_SHAPED, '[redacted]');
  return withoutTokens.replace(/https?:\/\/[^\s'"]+/g, (url) => {
    try {
      const parsed = new URL(url);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '[redacted-url]';
    }
  });
}

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === 'string') return redactLogString(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_LOG_KEYS.has(key.toLowerCase())) continue;
      out[key] = sanitizeLogValue(inner);
    }
    return out;
  }
  return value;
}

export function errInfo(e: unknown): { name?: string; message: string; stack?: string } {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      stack: e.stack?.split('\n').slice(0, 5).join(' | '),
    };
  }
  return { message: String(e) };
}

export function logOAuth(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
): void {
  const safe = sanitizeLogValue(fields) as Record<string, unknown>;
  const line = JSON.stringify({ event, ...safe });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
