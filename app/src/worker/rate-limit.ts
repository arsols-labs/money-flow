/**
 * Application-level rate limit for internet-exposed endpoints.
 * Admission uses the Workers Rate Limiting binding when present (per-location
 * atomic counters; no KV get-then-put). Isolate memory is the test / missing-
 * binding fallback. A bound limiter that throws fails closed.
 */

const memory = new Map<string, { count: number; resetAt: number }>();

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSec: number;
};

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export const RATE_LIMITS = {
  oauthRegister: { limit: 10, windowSec: 60 },
  authSetup: { limit: 8, windowSec: 60 },
  authLogin: { limit: 20, windowSec: 60 },
  mcpDispatch: { limit: 60, windowSec: 60 },
  mcpAudit: { limit: 40, windowSec: 60 },
} as const;

export function resetRateLimitMemoryForTests(): void {
  memory.clear();
}

function consumeMemory(key: string, limit: number, windowSec: number): RateLimitDecision {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const mem = memory.get(key);
  const resetAt = mem && mem.resetAt > now ? mem.resetAt : now + windowMs;
  const count = mem && mem.resetAt > now ? mem.count : 0;
  if (count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  }
  memory.set(key, { count: count + 1, resetAt });
  return { allowed: true, retryAfterSec: 0 };
}

export async function consumeRateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
  limiter?: RateLimitBinding | null,
): Promise<RateLimitDecision> {
  if (limiter) {
    try {
      const { success } = await limiter.limit({ key: bucket });
      return {
        allowed: Boolean(success),
        retryAfterSec: success ? 0 : Math.max(1, windowSec),
      };
    } catch {
      return { allowed: false, retryAfterSec: 1 };
    }
  }

  return consumeMemory(`rl:${bucket}`, limit, windowSec);
}

export function clientIpFromHeaders(header: (name: string) => string | undefined): string {
  const cf = header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const forwarded = header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return 'unknown';
}
