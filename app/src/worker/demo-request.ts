import { apiErrorBody, type ApiErrorCode } from '../shared/api-errors';
import {
  DEMO_SESSION_COOKIE,
  demoSessionCookie,
  mergeCookieHeader,
  readDemoSessionId,
  responseClearsDemoCookie,
} from './demo-cookie';
import { createDemoD1, type DemoLedgerStub } from './demo-db';
import { DEMO_SESSION_TTL_SECONDS, isDemoMode } from './demo-flag';
import { clientIpFromHeaders, consumeRateLimit, RATE_LIMITS } from './rate-limit';
import type { Env } from './types';

const DEMO_BOUND = Symbol('mf.demoBound');

type FetchFn = (
  request: Request,
  env?: Env,
  ctx?: ExecutionContext,
) => Response | Promise<Response>;

function jsonError(code: ApiErrorCode, status: number, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(apiErrorBody(code)), { status, headers });
}

export function isDemoBound(env: object | undefined): boolean {
  if (!env) return false;
  return Boolean((env as Record<symbol, unknown>)[DEMO_BOUND]);
}

function proxyDemoEnv(env: Env, db: D1Database): Env {
  return new Proxy(env, {
    get(target, prop) {
      if (prop === DEMO_BOUND) return true;
      if (prop === 'DB') return db;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Env;
}

function copyHeaders(response: Response): Headers {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    headers.append(key, value);
  });
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return headers;
}

async function withDemoCookie(response: Response, cookie: string): Promise<Response> {
  const headers = copyHeaders(response);
  headers.append('Set-Cookie', cookie);
  // Buffer before rewriting. A streamed body plus the original Content-Length
  // can leave the browser waiting until the connection dies, after the worker
  // has already committed the import.
  if (!response.body) {
    headers.delete('content-length');
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const body = await response.arrayBuffer();
  headers.set('content-length', String(body.byteLength));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function rejectNewDemoSession(request: Request, env: Env): Promise<Response | null> {
  const spec = RATE_LIMITS.demoSession;
  const ip = clientIpFromHeaders((name) => request.headers.get(name) ?? undefined);
  const decision = await consumeRateLimit(
    `demoSession:${ip}`,
    spec.limit,
    spec.windowSec,
    env.RATE_LIMIT_DEMO_SESSION,
  );
  if (decision.allowed) return null;
  const headers = new Headers({ 'Retry-After': String(decision.retryAfterSec) });
  return jsonError('RATE_LIMITED', 429, headers);
}

function ledgerStub(env: Env, sessionId: string): DemoLedgerStub | null {
  const namespace = env.DEMO_SESSION;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(sessionId)) as unknown as DemoLedgerStub;
}

/**
 * When DEMO_MODE=1, swap env.DB for the session Durable Object before any route runs.
 * Shared D1 is not queried. A missing DO binding fails closed.
 */
export async function maybeDemoFetch(
  request: Request,
  env: Env | undefined,
  ctx: ExecutionContext | undefined,
  next: FetchFn,
): Promise<Response> {
  if (!env || !isDemoMode(env) || isDemoBound(env)) {
    return next(request, env, ctx);
  }
  if (!env.DEMO_SESSION) return jsonError('DEMO_LEDGER_UNAVAILABLE', 503);

  const existing = readDemoSessionId(request.headers.get('Cookie'));
  let sessionId = existing;
  if (!sessionId) {
    const limited = await rejectNewDemoSession(request, env);
    if (limited) return limited;
    sessionId = crypto.randomUUID();
  }

  const stub = ledgerStub(env, sessionId);
  if (!stub) return jsonError('DEMO_LEDGER_UNAVAILABLE', 503);
  try {
    await stub.ensureReady();
  } catch (err) {
    console.error('demo ledger bootstrap failed', err);
    return jsonError('DEMO_LEDGER_UNAVAILABLE', 503);
  }

  const headers = new Headers(request.headers);
  headers.set('Cookie', mergeCookieHeader(request.headers.get('Cookie'), DEMO_SESSION_COOKIE, sessionId));
  const nextRequest = new Request(request, { headers });
  const bound = proxyDemoEnv(env, createDemoD1(stub));
  const response = await next(nextRequest, bound, ctx);
  if (responseClearsDemoCookie(response)) return response;
  const secure = new URL(request.url).protocol === 'https:';
  return await withDemoCookie(response, demoSessionCookie(sessionId, secure, DEMO_SESSION_TTL_SECONDS));
}
