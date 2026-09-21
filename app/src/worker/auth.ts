import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type { Env } from './types';
import { AuthError } from './api-error';
import { timingSafeEqualString } from './crypto-eq';

const RP_NAME = 'Money Flow v2';
const USER_NAME = 'alex';
const USER_ID = new Uint8Array(new TextEncoder().encode('money-flow-v2-owner'));
const KV_CREDENTIALS = 'webauthn_credentials';
const KV_CHALLENGE_REG = 'webauthn_challenge_reg';
const KV_CHALLENGE_AUTH = 'webauthn_challenge_auth';
const CHALLENGE_TTL = 300;
const SESSION_TTL_SECONDS = 90 * 24 * 3600;
export const SESSION_COOKIE = 'mf_session';
export const CEREMONY_COOKIE = 'mf_wa_ceremony';
export const STEP_UP_MAX_AGE_SECONDS = 10 * 60;
const KV_AUTH_EPOCH = 'auth_epoch';
const D1_AUTH_EPOCH = 'auth_epoch';
const D1_SESSION_REVOKED = 'session_revoked:';
const D1_PASSKEY_REVOKED = 'passkey_revoked:';
const D1_PASSKEY_DISABLED = 'passkey_disabled:';

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function credentialLifeKey(id: string): string {
  return `webauthn_cred:${id}`;
}

function credentialCounterKey(id: string): string {
  return `webauthn_cred_counter:${id}`;
}

type CredentialLifecycle = {
  disabled?: boolean;
  revoked?: boolean;
  version: number;
};

export const MAX_PASSKEYS_COUNT = 10;

/**
 * Stable Cloudflare preview aliases used by this repository.
 * Not `*.workers.dev` — ephemeral branch hosts are allowed only when they
 * are the request edge host (same-origin).
 */
export const CANONICAL_PREVIEW_HOSTS = [
  // Public cut: no private preview allowlist. Self-host sets APP_DOMAIN via setup.
] as const;

/**
 * Валидация хоста для защиты от Host Header Injection и Origin Spoofing.
 * Разрешены только:
 * 1. Edge-хост запроса (гарантируется Cloudflare)
 * 2. Явно сконфигурированный env.APP_DOMAIN
 * 3. Канонические staging/dev preview-алиасы этого проекта
 * 4. Localhost / 127.0.0.1 для локальной разработки
 */
export function isAllowedHost(
  hostname: string,
  edgeHostname: string,
  appDomain?: string,
): boolean {
  const h = hostname.toLowerCase();
  const edge = edgeHostname.toLowerCase();

  // 1. Совпадение с edge-хостом Cloudflare
  if (h === edge) return true;

  // 2. Совпадение с APP_DOMAIN
  if (appDomain) {
    let configured = appDomain.trim().toLowerCase();
    try {
      if (configured.includes('://')) configured = new URL(configured).hostname;
      else configured = configured.split(':')[0];
    } catch {}
    if (h === configured) return true;
  }

  // 3. Только известные staging/dev preview-алиасы — не весь *.workers.dev
  if ((CANONICAL_PREVIEW_HOSTS as readonly string[]).includes(h)) {
    return true;
  }

  // 4. Loopback only when the Worker edge is also loopback (local wrangler).
  // A production/preview host must not trust Origin: http://localhost:any-port.
  if (isLoopbackHost(h) && isLoopbackHost(edge)) {
    return true;
  }

  return false;
}

export type RequestLike = {
  url: string;
  header?: (name: string) => string | undefined;
  headers?: Headers | { get: (name: string) => string | null };
};

export type OriginContext = {
  req: RequestLike;
  env?: Env;
};

function getHeader(req: RequestLike, name: string): string | undefined {
  if (typeof req.header === 'function') {
    return req.header(name);
  }
  if (req.headers && typeof req.headers.get === 'function') {
    return req.headers.get(name) ?? undefined;
  }
  return undefined;
}

/**
 * Безопасное определение Origin запроса.
 */
export function resolveOrigin(c: OriginContext): string {
  let edgeOrigin = 'http://localhost:8787';
  let edgeHost = 'localhost';
  try {
    const u = new URL(c.req.url);
    edgeOrigin = u.origin;
    edgeHost = u.hostname;
  } catch {}

  // 1. Origin header (браузер шлёт при POST / WebAuthn verify)
  const originHeader = getHeader(c.req, 'origin');
  if (originHeader) {
    try {
      const u = new URL(originHeader);
      if (isAllowedHost(u.hostname, edgeHost, c.env?.APP_DOMAIN)) {
        return u.origin;
      }
    } catch {}
  }

  // 2. Host / X-Forwarded-Host (например, в wrangler dev при rewrite url)
  const hostHeader = getHeader(c.req, 'x-forwarded-host') || getHeader(c.req, 'host');
  if (hostHeader) {
    const hostWithoutPort = hostHeader.split(':')[0].trim();
    if (isAllowedHost(hostWithoutPort, edgeHost, c.env?.APP_DOMAIN)) {
      const proto =
        getHeader(c.req, 'x-forwarded-proto') ||
        (c.req.url.startsWith('https:') ? 'https' : 'http');
      return `${proto}://${hostHeader.trim()}`;
    }
  }

  // 3. Edge URL origin
  if (edgeHost && isAllowedHost(edgeHost, edgeHost, c.env?.APP_DOMAIN)) {
    return edgeOrigin;
  }

  // 4. Fallback на сконфигурированный APP_DOMAIN
  if (c.env?.APP_DOMAIN) {
    const domain = c.env.APP_DOMAIN.trim();
    return domain.startsWith('http://') || domain.startsWith('https://')
      ? domain.replace(/\/$/, '')
      : `https://${domain}`;
  }

  return edgeOrigin;
}

/**
 * Безопасное определение WebAuthn Relying Party ID.
 * RP ID не должен содержать схему (https://) или порт (:8787).
 */
export function resolveRpID(c: OriginContext): string {
  let edgeHost = 'localhost';
  try {
    edgeHost = new URL(c.req.url).hostname;
  } catch {}

  // 1. Origin header
  const originHeader = getHeader(c.req, 'origin');
  if (originHeader) {
    try {
      const originHost = new URL(originHeader).hostname;
      if (isAllowedHost(originHost, edgeHost, c.env?.APP_DOMAIN)) {
        return originHost;
      }
    } catch {}
  }

  // 2. Host / X-Forwarded-Host
  const hostHeader = getHeader(c.req, 'x-forwarded-host') || getHeader(c.req, 'host');
  if (hostHeader) {
    const rawHost = hostHeader.split(':')[0].trim();
    if (isAllowedHost(rawHost, edgeHost, c.env?.APP_DOMAIN)) {
      return rawHost;
    }
  }

  // 3. Edge URL hostname
  if (edgeHost && isAllowedHost(edgeHost, edgeHost, c.env?.APP_DOMAIN)) {
    return edgeHost;
  }

  // 4. Configured APP_DOMAIN
  if (c.env?.APP_DOMAIN) {
    try {
      const d = c.env.APP_DOMAIN.includes('://')
        ? new URL(c.env.APP_DOMAIN).hostname
        : c.env.APP_DOMAIN.split(':')[0].trim();
      if (d) return d;
    } catch {}
  }

  return 'localhost';
}

/**
 * Проверка допустимости origin для CORS.
 * Loopback is exact-origin only (scheme+host+port). Other hosts still use the
 * allowlist, never a wildcard of localhost ports.
 */
export function isAllowedOrigin(origin: string | undefined, c: OriginContext): boolean {
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    let edgeUrl: URL | null = null;
    try {
      edgeUrl = new URL(c.req.url);
    } catch {}
    if (isLoopbackHost(originUrl.hostname)) {
      return edgeUrl !== null && originUrl.origin === edgeUrl.origin;
    }
    const edgeHost = edgeUrl?.hostname || 'localhost';
    return isAllowedHost(originUrl.hostname, edgeHost, c.env?.APP_DOMAIN);
  } catch {
    return false;
  }
}

export interface StoredCredential {
  id: string; // base64url credential id
  publicKey: string; // base64url
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  disabled?: boolean;
}

async function readLifecycle(env: Env, id: string): Promise<CredentialLifecycle | null> {
  return (await env.KV.get<CredentialLifecycle>(credentialLifeKey(id), 'json')) ?? null;
}

async function writeLifecycle(env: Env, id: string, next: Omit<CredentialLifecycle, 'version'>): Promise<void> {
  const prev = await readLifecycle(env, id);
  // Tombstones are sticky and monotonic: no metadata write may clear revocation.
  if (prev?.revoked || next.revoked) {
    await env.KV.put(
      credentialLifeKey(id),
      JSON.stringify({
        disabled: true,
        revoked: true,
        version: (prev?.version ?? 0) + 1,
      }),
    );
    return;
  }
  await env.KV.put(
    credentialLifeKey(id),
    JSON.stringify({
      disabled: Boolean(next.disabled),
      revoked: false,
      version: (prev?.version ?? 0) + 1,
    }),
  );
}

async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(key, value).run();
}

async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

async function settingValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function getCredentials(env: Env): Promise<StoredCredential[]> {
  const list = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  const merged: StoredCredential[] = [];
  for (const cred of list) {
    if (await settingValue(env, `${D1_PASSKEY_REVOKED}${cred.id}`)) continue;
    const life = await readLifecycle(env, cred.id);
    if (life?.revoked) continue;
    const d1Disabled = await settingValue(env, `${D1_PASSKEY_DISABLED}${cred.id}`);
    const counterRec = await env.KV.get<{ counter: number; lastUsedAt?: string }>(
      credentialCounterKey(cred.id),
      'json',
    );
    merged.push({
      ...cred,
      disabled: d1Disabled === '1' || Boolean(life?.disabled) || Boolean(cred.disabled),
      counter: counterRec?.counter ?? cred.counter,
      lastUsedAt: counterRec?.lastUsedAt ?? cred.lastUsedAt,
    });
  }
  return merged;
}

function listedCredential(cred: StoredCredential): StoredCredential {
  const { disabled: _disabled, ...rest } = cred;
  return rest;
}

/**
 * Persist the live passkey list without writing lifecycle keys.
 * Missing ids are treated as deletes only when the incoming set is a subset
 * of the current list. A stale snapshot cannot re-add a removed or tombstoned id.
 */
export async function saveCredentials(env: Env, creds: StoredCredential[]): Promise<void> {
  const current = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  const currentIds = new Set(current.map((item) => item.id));
  const incomingIds = new Set(creds.map((item) => item.id));
  const adding = [...incomingIds].filter((id) => !currentIds.has(id));
  const isBootstrap = currentIds.size === 0;
  const isEnroll = adding.length === 1 && [...currentIds].every((id) => incomingIds.has(id));

  const kept: StoredCredential[] = [];
  for (const cred of creds) {
    const life = await readLifecycle(env, cred.id);
    if (life?.revoked) continue;
    if (await settingValue(env, `${D1_PASSKEY_REVOKED}${cred.id}`)) continue;
    if (!currentIds.has(cred.id) && !isEnroll && !isBootstrap) continue;
    const prev = current.find((item) => item.id === cred.id);
    const disabled = Boolean(cred.disabled ?? prev?.disabled);
    kept.push({
      ...(prev ?? cred),
      label: cred.label,
      transports: cred.transports ?? prev?.transports,
      disabled,
    });
    if (disabled) {
      await putSetting(env, `${D1_PASSKEY_DISABLED}${cred.id}`, '1');
    } else {
      await deleteSetting(env, `${D1_PASSKEY_DISABLED}${cred.id}`);
    }
  }
  await env.KV.put(KV_CREDENTIALS, JSON.stringify(kept));
}

export async function addCredential(env: Env, cred: StoredCredential): Promise<void> {
  if (await settingValue(env, `${D1_PASSKEY_REVOKED}${cred.id}`)) {
    throw new AuthError('PASSKEY_NOT_FOUND');
  }
  const life = await readLifecycle(env, cred.id);
  if (life?.revoked) throw new AuthError('PASSKEY_NOT_FOUND');
  const current = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  if (current.some((item) => item.id === cred.id)) return;
  current.push(listedCredential(cred));
  await env.KV.put(KV_CREDENTIALS, JSON.stringify(current));
  await writeLifecycle(env, cred.id, { disabled: false, revoked: false });
}

export async function updateCredentialLabel(env: Env, id: string, label: string): Promise<StoredCredential | null> {
  if (!(await isCredentialListed(env, id))) return null;
  const current = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  const index = current.findIndex((item) => item.id === id);
  if (index === -1) return null;
  current[index] = { ...current[index]!, label };
  await env.KV.put(KV_CREDENTIALS, JSON.stringify(current));
  return current[index]!;
}

export async function setCredentialDisabled(env: Env, id: string, disabled: boolean): Promise<boolean> {
  if (!(await isCredentialListed(env, id))) return false;
  const life = await readLifecycle(env, id);
  if (life?.revoked || await settingValue(env, `${D1_PASSKEY_REVOKED}${id}`)) return false;
  await writeLifecycle(env, id, { disabled, revoked: false });
  if (disabled) {
    await putSetting(env, `${D1_PASSKEY_DISABLED}${id}`, '1');
  } else {
    await deleteSetting(env, `${D1_PASSKEY_DISABLED}${id}`);
  }
  const current = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  const index = current.findIndex((item) => item.id === id);
  if (index !== -1) {
    current[index] = { ...current[index]!, disabled };
    await env.KV.put(KV_CREDENTIALS, JSON.stringify(current));
  }
  return true;
}

export async function tombstoneCredential(env: Env, id: string): Promise<void> {
  await writeLifecycle(env, id, { disabled: true, revoked: true });
  await putSetting(env, `${D1_PASSKEY_REVOKED}${id}`, '1');
  await putSetting(env, `${D1_PASSKEY_DISABLED}${id}`, '1');
}

export async function removeCredential(env: Env, id: string): Promise<void> {
  await tombstoneCredential(env, id);
  const current = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  await env.KV.put(KV_CREDENTIALS, JSON.stringify(current.filter((item) => item.id !== id)));
}

async function isCredentialListed(env: Env, id: string): Promise<boolean> {
  if (await settingValue(env, `${D1_PASSKEY_REVOKED}${id}`)) return false;
  const life = await readLifecycle(env, id);
  if (life?.revoked) return false;
  const list = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  return list.some((item) => item.id === id);
}

export async function updateCredentialCounter(
  env: Env,
  id: string,
  counter: number,
  lastUsedAt: string,
): Promise<void> {
  await env.KV.put(credentialCounterKey(id), JSON.stringify({ counter, lastUsedAt }));
}

export async function isCredentialActive(env: Env, id: string): Promise<boolean> {
  if (await settingValue(env, `${D1_PASSKEY_REVOKED}${id}`)) return false;
  if (await settingValue(env, `${D1_PASSKEY_DISABLED}${id}`)) return false;
  const life = await readLifecycle(env, id);
  if (life?.revoked || life?.disabled) return false;
  const list = (await env.KV.get<StoredCredential[]>(KV_CREDENTIALS, 'json')) ?? [];
  const listed = list.find((c) => c.id === id);
  if (!listed) return false;
  if (!life && listed.disabled) return false;
  return true;
}

export function isLastActiveCredential(creds: StoredCredential[], targetId: string): boolean {
  const remainingActive = creds.filter((c) => c.id !== targetId && !c.disabled);
  return remainingActive.length === 0;
}

export async function hasCredentials(env: Env): Promise<boolean> {
  const creds = await getCredentials(env);
  return creds.some((c) => !c.disabled);
}

// ---------- registration (гейт: SETUP_TOKEN) ----------

export async function registrationOptions(env: Env, rpID: string) {
  const creds = await getCredentials(env);
  if (creds.length >= MAX_PASSKEYS_COUNT) {
    throw new AuthError('PASSKEY_LIMIT_REACHED');
  }
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: env.AUTH_USER_NAME || USER_NAME,
    userID: USER_ID,
    attestationType: 'none',
    excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  const ceremonyId = crypto.randomUUID();
  await env.KV.put(`${KV_CHALLENGE_REG}:${ceremonyId}`, options.challenge, { expirationTtl: CHALLENGE_TTL });
  await env.KV.delete(KV_CHALLENGE_REG);
  return Object.assign(options, { ceremonyId });
}

export async function registrationVerify(
  env: Env,
  rpID: string,
  origin: string,
  response: RegistrationResponseJSON,
  label: string,
  ceremonyId?: string,
): Promise<boolean> {
  const expectedChallenge = await consumeCeremonyChallenge(env, KV_CHALLENGE_REG, ceremonyId);
  if (!expectedChallenge) throw new AuthError('PASSKEY_CHALLENGE_EXPIRED');

  let verification: VerifiedRegistrationResponse;
  verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    requireUserPresence: true,
  });
  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential } = verification.registrationInfo;
  const creds = await getCredentials(env);
  if (creds.length >= MAX_PASSKEYS_COUNT) {
    throw new AuthError('PASSKEY_LIMIT_REACHED');
  }
  await addCredential(env, {
    id: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    label: label || 'device',
    createdAt: new Date().toISOString(),
    disabled: false,
  });
  return true;
}

// ---------- authentication ----------

export async function authenticationOptions(env: Env, rpID: string) {
  const creds = await getCredentials(env);
  const activeCreds = creds.filter((c) => !c.disabled);
  if (!activeCreds.length) throw new AuthError('PASSKEY_NOT_REGISTERED');
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: activeCreds.map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: 'preferred',
  });
  const ceremonyId = crypto.randomUUID();
  await env.KV.put(`${KV_CHALLENGE_AUTH}:${ceremonyId}`, options.challenge, { expirationTtl: CHALLENGE_TTL });
  await env.KV.delete(KV_CHALLENGE_AUTH);
  return Object.assign(options, { ceremonyId });
}

export async function authenticationVerify(
  env: Env,
  rpID: string,
  origin: string,
  response: AuthenticationResponseJSON,
  ceremonyId?: string,
): Promise<string | false> {
  const expectedChallenge = await consumeCeremonyChallenge(env, KV_CHALLENGE_AUTH, ceremonyId);
  if (!expectedChallenge) throw new AuthError('PASSKEY_CHALLENGE_EXPIRED');

  const creds = await getCredentials(env);
  const cred = creds.find((c) => c.id === response.id);
  if (!cred || cred.disabled) return false;

  const verification: VerifiedAuthenticationResponse = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: cred.id,
      publicKey: isoBase64URL.toBuffer(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports,
    },
    requireUserVerification: false,
  });
  if (!verification.verified) return false;

  const lastUsedAt = new Date().toISOString();
  await updateCredentialCounter(env, cred.id, verification.authenticationInfo.newCounter, lastUsedAt);
  if (!(await isCredentialActive(env, cred.id))) return false;
  return cred.id;
}

async function consumeCeremonyChallenge(
  env: Env,
  prefix: string,
  ceremonyId: string | undefined,
): Promise<string | null> {
  if (!ceremonyId) return null;
  const key = `${prefix}:${ceremonyId}`;
  const expectedChallenge = await env.KV.get(key);
  if (!expectedChallenge) return null;
  await env.KV.delete(key);
  return expectedChallenge;
}

export function parseCeremonyId(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${CEREMONY_COOKIE}=([^;]+)`));
  return match?.[1];
}

export function ceremonyCookie(ceremonyId: string, secure: boolean): string {
  return [
    `${CEREMONY_COOKIE}=${ceremonyId}`,
    `Max-Age=${CHALLENGE_TTL}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearCeremonyCookie(secure: boolean): string {
  return [
    `${CEREMONY_COOKIE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

// ---------- session cookie (stateless, HMAC) ----------

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64u(new Uint8Array(sig));
}

const KV_SESSION_REVOKED = 'session_revoked:';

export type SessionClaims = {
  exp: number;
  sid?: string;
  epoch: number;
  cid?: string;
  iat: number;
};

export type SessionCookieOptions = {
  cid?: string;
  iat?: number;
  epoch?: number;
};

function parseEpoch(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function getAuthEpoch(env: Env): Promise<number> {
  try {
    const d1 = parseEpoch(await settingValue(env, D1_AUTH_EPOCH));
    let kv = 0;
    try {
      kv = parseEpoch(await env.KV.get(KV_AUTH_EPOCH));
    } catch {
      throw new AuthError('SESSION_STORE_UNAVAILABLE', 503);
    }
    return Math.max(d1, kv);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('SESSION_STORE_UNAVAILABLE', 503);
  }
}

export async function bumpAuthEpoch(env: Env): Promise<number> {
  const next = (await getAuthEpoch(env)) + 1;
  const value = String(next);
  await putSetting(env, D1_AUTH_EPOCH, value);
  await env.KV.put(KV_AUTH_EPOCH, value);
  return next;
}

export async function createSessionCookie(
  env: Env,
  secure: boolean,
  opts?: SessionCookieOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const epoch = opts?.epoch ?? (await getAuthEpoch(env));
  const payload = b64u(
    new TextEncoder().encode(
      JSON.stringify({
        exp: now + SESSION_TTL_SECONDS,
        sid: crypto.randomUUID(),
        epoch,
        iat: opts?.iat ?? now,
        ...(opts?.cid ? { cid: opts.cid } : {}),
      }),
    ),
  );
  const sig = await hmacSign(env.SESSION_SECRET, payload);
  const value = `${payload}.${sig}`;
  return [
    `${SESSION_COOKIE}=${value}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function parseSessionPayload(payload: string): SessionClaims | null {
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64));
    if (typeof json.exp !== 'number') return null;
    return {
      exp: json.exp,
      sid: typeof json.sid === 'string' ? json.sid : undefined,
      epoch: typeof json.epoch === 'number' && Number.isInteger(json.epoch) ? json.epoch : 0,
      cid: typeof json.cid === 'string' ? json.cid : undefined,
      iat: typeof json.iat === 'number' && Number.isInteger(json.iat) ? json.iat : 0,
    };
  } catch {
    return null;
  }
}

async function signedSessionClaims(env: Env, cookieHeader: string | undefined): Promise<SessionClaims | null> {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig) return null;
  const expected = await hmacSign(env.SESSION_SECRET, payload);
  if (!timingSafeEqualString(sig, expected)) return null;
  const parsed = parseSessionPayload(payload);
  if (!parsed || parsed.exp <= Date.now() / 1000) return null;
  return parsed;
}

export async function readSessionClaims(env: Env, cookieHeader: string | undefined): Promise<SessionClaims | null> {
  const parsed = await signedSessionClaims(env, cookieHeader);
  if (!parsed) return null;
  if (parsed.sid) {
    try {
      if (await settingValue(env, `${D1_SESSION_REVOKED}${parsed.sid}`)) return null;
      const revoked = await env.KV.get(`${KV_SESSION_REVOKED}${parsed.sid}`);
      if (revoked) return null;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('SESSION_STORE_UNAVAILABLE', 503);
    }
  }
  const epoch = await getAuthEpoch(env);
  if (parsed.epoch !== epoch) return null;
  if (parsed.cid && !(await isCredentialActive(env, parsed.cid))) return null;
  return parsed;
}

export function sessionIsFresh(claims: SessionClaims, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return nowSec - claims.iat <= STEP_UP_MAX_AGE_SECONDS;
}

export async function requireFreshAuth(
  env: Env,
  cookieHeader: string | undefined,
  setupToken?: unknown,
): Promise<SessionClaims> {
  const claims = await readSessionClaims(env, cookieHeader);
  if (!claims) throw new AuthError('UNAUTHORIZED', 401);
  if (typeof setupToken === 'string' && setupToken.length > 0 && env.SETUP_TOKEN) {
    if (timingSafeEqualString(setupToken, env.SETUP_TOKEN)) return claims;
  }
  if (sessionIsFresh(claims)) return claims;
  throw new AuthError('STEP_UP_REQUIRED', 403);
}

/** D1 is authoritative so a copied cookie fails at every location; KV is a cache. */
export async function revokeSessionCookie(env: Env, cookieHeader: string | undefined): Promise<void> {
  if (!cookieHeader) return;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig) return;
  const expected = await hmacSign(env.SESSION_SECRET, payload);
  if (!timingSafeEqualString(sig, expected)) return;
  const parsed = parseSessionPayload(payload);
  if (!parsed?.sid) return;
  const ttl = Math.max(60, parsed.exp - Math.floor(Date.now() / 1000));
  await putSetting(env, `${D1_SESSION_REVOKED}${parsed.sid}`, String(parsed.exp));
  await env.KV.put(`${KV_SESSION_REVOKED}${parsed.sid}`, '1', { expirationTtl: ttl });
}

export async function verifySessionCookie(env: Env, cookieHeader: string | undefined): Promise<boolean> {
  return (await readSessionClaims(env, cookieHeader)) !== null;
}
