import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { isoBase64URL, isoCBOR, isoUint8Array } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import app from '../src/worker/index';
import {
  createSessionCookie,
  getCredentials,
  saveCredentials,
  type StoredCredential,
} from '../src/worker/auth';
import type { Env } from '../src/worker/types';

function encodeDerInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const slice = bytes.slice(start);
  const needsZero = (slice[0] & 0x80) !== 0;
  const len = slice.length + (needsZero ? 1 : 0);
  const res = new Uint8Array(2 + len);
  res[0] = 0x02;
  res[1] = len;
  if (needsZero) {
    res[2] = 0x00;
    res.set(slice, 3);
  } else {
    res.set(slice, 2);
  }
  return res;
}

function p1363ToDer(signature: Uint8Array): Uint8Array {
  const r = encodeDerInteger(signature.slice(0, 32));
  const s = encodeDerInteger(signature.slice(32, 64));
  const totalLen = r.length + s.length;
  const res = new Uint8Array(2 + totalLen);
  res[0] = 0x30;
  res[1] = totalLen;
  res.set(r, 2);
  res.set(s, 2 + r.length);
  return res;
}

function toBuffer(arr: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
}

async function generateTestKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

async function createMockRegistrationResponse(options: {
  rpID: string;
  origin: string;
  challenge: string;
  keyPair: CryptoKeyPair;
  credentialId: Uint8Array;
}): Promise<RegistrationResponseJSON> {
  const { rpID, origin, challenge, keyPair, credentialId } = options;

  const clientData = {
    type: 'webauthn.create',
    challenge,
    origin,
    crossOrigin: false,
  };
  const clientDataBytes = new TextEncoder().encode(JSON.stringify(clientData));

  const exported = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const rawPub = new Uint8Array(exported as ArrayBuffer);
  const x = rawPub.slice(1, 33);
  const y = rawPub.slice(33, 65);

  const coseKey = new Map<number, number | Uint8Array>();
  coseKey.set(1, 2);
  coseKey.set(3, -7);
  coseKey.set(-1, 1);
  coseKey.set(-2, x);
  coseKey.set(-3, y);
  const encodedCoseKey = isoCBOR.encode(coseKey as any);

  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpID)));
  const flagByte = 0x41; // UP + AT
  const signCount = new Uint8Array(4);
  const aaguid = new Uint8Array(16);
  const credIdLen = new Uint8Array([0x00, credentialId.length]);

  const authData = isoUint8Array.concat([
    rpIdHash,
    new Uint8Array([flagByte]),
    signCount,
    aaguid,
    credIdLen,
    toBuffer(credentialId),
    encodedCoseKey,
  ]);

  const attestationMap = new Map<string | number, unknown>();
  attestationMap.set('fmt', 'none');
  attestationMap.set('attStmt', new Map());
  attestationMap.set('authData', toBuffer(authData));
  const attestationObject = isoCBOR.encode(attestationMap as any);

  return {
    id: isoBase64URL.fromBuffer(toBuffer(credentialId)),
    rawId: isoBase64URL.fromBuffer(toBuffer(credentialId)),
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(toBuffer(clientDataBytes)),
      attestationObject: isoBase64URL.fromBuffer(toBuffer(attestationObject)),
    },
    type: 'public-key',
    clientExtensionResults: {},
  };
}

async function createMockAuthenticationResponse(options: {
  rpID: string;
  origin: string;
  challenge: string;
  keyPair: CryptoKeyPair;
  credentialId: Uint8Array;
  counter: number;
}): Promise<AuthenticationResponseJSON> {
  const { rpID, origin, challenge, keyPair, credentialId, counter } = options;

  const clientData = {
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false,
  };
  const clientDataBytes = new TextEncoder().encode(JSON.stringify(clientData));
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));

  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpID)));
  const flagByte = 0x01; // UP
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, false);

  const authData = isoUint8Array.concat([
    rpIdHash,
    new Uint8Array([flagByte]),
    counterBytes,
  ]);

  const dataToSign = isoUint8Array.concat([authData, clientDataHash]);
  const p1363Sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, dataToSign),
  );
  const derSignature = p1363ToDer(p1363Sig);

  return {
    id: isoBase64URL.fromBuffer(toBuffer(credentialId)),
    rawId: isoBase64URL.fromBuffer(toBuffer(credentialId)),
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(toBuffer(clientDataBytes)),
      authenticatorData: isoBase64URL.fromBuffer(toBuffer(authData)),
      signature: isoBase64URL.fromBuffer(toBuffer(derSignature)),
      userHandle: undefined,
    },
    type: 'public-key',
    clientExtensionResults: {},
  };
}

describe('Passkeys Management API (issue #507)', () => {
  const BASE_URL = 'https://example.com';
  const RP_ID = 'example.com';
  const ORIGIN = 'https://example.com';

  let testEnv: Env;
  let sessionCookie: string;

  beforeEach(async () => {
    await env.KV.delete('webauthn_credentials');
    await env.KV.delete('webauthn_challenge_reg');
    await env.KV.delete('webauthn_challenge_auth');
    const listed = await env.KV.list({ prefix: 'webauthn_cred' });
    await Promise.all(listed.keys.map((key) => env.KV.delete(key.name)));
    await env.DB.prepare(
      `DELETE FROM settings WHERE key = 'auth_epoch'
         OR key LIKE 'session_revoked:%'
         OR key LIKE 'passkey_revoked:%'
         OR key LIKE 'passkey_disabled:%'`,
    ).run();

    testEnv = {
      ...(env as unknown as Env),
      SESSION_SECRET: (env as unknown as Env).SESSION_SECRET || 'test-session-secret-for-passkeys-testing-minimum-32-chars',
      SETUP_TOKEN: (env as unknown as Env).SETUP_TOKEN || 'test-setup-token',
    };

    const cookieHeader = await createSessionCookie(testEnv, true);
    sessionCookie = cookieHeader.split(';')[0];
  });

  describe('GET /api/v2/passkeys', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request(`${BASE_URL}/api/v2/passkeys`, {}, testEnv);
      expect(res.status).toBe(401);
    });

    it('returns empty list and counts when no credentials exist', async () => {
      const res = await app.request(`${BASE_URL}/api/v2/passkeys`, {
        headers: { Cookie: sessionCookie },
      }, testEnv);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.passkeys).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.active_count).toBe(0);
      expect(data.max_limit).toBe(10);
    });

    it('returns formatted credentials without exposing publicKey', async () => {
      const mockCreds: StoredCredential[] = [
        {
          id: 'cred-1',
          publicKey: 'secret-public-key-b64',
          counter: 5,
          label: 'MacBook Pro',
          createdAt: '2026-09-01T10:00:00Z',
          lastUsedAt: '2026-09-09T12:00:00Z',
          disabled: false,
        },
        {
          id: 'cred-2',
          publicKey: 'secret-public-key-b64-2',
          counter: 2,
          label: 'Old iPhone',
          createdAt: '2026-09-02T10:00:00Z',
          disabled: true,
        },
      ];
      await saveCredentials(testEnv, mockCreds);

      const res = await app.request(`${BASE_URL}/api/v2/passkeys`, {
        headers: { Cookie: sessionCookie },
      }, testEnv);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.total).toBe(2);
      expect(data.active_count).toBe(1);
      expect(data.passkeys.length).toBe(2);

      const p1 = data.passkeys.find((p: any) => p.id === 'cred-1');
      expect(p1.label).toBe('MacBook Pro');
      expect(p1.disabled).toBe(false);
      expect(p1.last_used_at).toBe('2026-09-09T12:00:00Z');
      expect((p1 as any).publicKey).toBeUndefined();

      const p2 = data.passkeys.find((p: any) => p.id === 'cred-2');
      expect(p2.label).toBe('Old iPhone');
      expect(p2.disabled).toBe(true);
      expect(p2.last_used_at).toBeNull();
    });
  });

  describe('POST /api/v2/passkeys/register-options and register-verify', () => {
    it('allows an authenticated user to register a passkey in 1 click without SETUP_TOKEN', async () => {
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      // 1. Get options with session cookie (no SETUP_TOKEN needed)
      const optRes = await app.request(`${BASE_URL}/api/v2/passkeys/register-options`, {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      }, testEnv);
      expect(optRes.status).toBe(200);
      const options = await optRes.json<any>();
      expect(options.challenge).toBeDefined();

      // 2. Verify registration with session cookie
      const regPayload = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: options.challenge,
        keyPair,
        credentialId,
      });

      const ceremony = (optRes.headers.get('Set-Cookie') || '').split(';')[0];
      const verifyRes = await app.request(`${BASE_URL}/api/v2/passkeys/register-verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ceremony ? `${sessionCookie}; ${ceremony}` : sessionCookie,
        },
        body: JSON.stringify({
          response: regPayload,
          label: 'My Test Mac',
        }),
      }, testEnv);
      expect(verifyRes.status).toBe(200);
      const verifyData = await verifyRes.json<any>();
      expect(verifyData.verified).toBe(true);

      // 3. Check that it was saved and is active
      const creds = await getCredentials(testEnv);
      expect(creds.length).toBe(1);
      expect(creds[0].label).toBe('My Test Mac');
      expect(creds[0].disabled).toBe(false);
    });

    it('enforces limit of maximum 10 passkeys', async () => {
      // Seed 10 credentials
      const creds: StoredCredential[] = [];
      for (let i = 1; i <= 10; i++) {
        creds.push({
          id: `cred-${i}`,
          publicKey: `pub-${i}`,
          counter: i,
          label: `Device ${i}`,
          createdAt: new Date().toISOString(),
          disabled: false,
        });
      }
      await saveCredentials(testEnv, creds);

      const optRes = await app.request(`${BASE_URL}/api/v2/passkeys/register-options`, {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      }, testEnv);
      expect(optRes.status).toBe(400);
      const errData = await optRes.json<any>();
      expect(errData.error).toEqual({
        code: 'PASSKEY_LIMIT_REACHED',
        message: 'Limit reached: maximum 10 passkeys',
      });
    });
  });

  describe('PATCH /api/v2/passkeys/:id', () => {
    beforeEach(async () => {
      const mockCreds: StoredCredential[] = [
        {
          id: 'cred-1',
          publicKey: 'pub-1',
          counter: 1,
          label: 'MacBook',
          createdAt: new Date().toISOString(),
          disabled: false,
        },
        {
          id: 'cred-2',
          publicKey: 'pub-2',
          counter: 1,
          label: 'iPhone',
          createdAt: new Date().toISOString(),
          disabled: false,
        },
      ];
      await saveCredentials(testEnv, mockCreds);
    });

    it('renames a passkey with validation', async () => {
      // Empty label rejected
      const emptyRes = await app.request(`${BASE_URL}/api/v2/passkeys/cred-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ label: '   ' }),
      }, testEnv);
      expect(emptyRes.status).toBe(400);

      // Valid rename
      const renameRes = await app.request(`${BASE_URL}/api/v2/passkeys/cred-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ label: 'MacBook Pro 16"' }),
      }, testEnv);
      expect(renameRes.status).toBe(200);
      const data = await renameRes.json<any>();
      expect(data.passkey.label).toBe('MacBook Pro 16"');

      const creds = await getCredentials(testEnv);
      expect(creds.find((c) => c.id === 'cred-1')?.label).toBe('MacBook Pro 16"');
    });

    it('disables a passkey when another active passkey remains', async () => {
      const res = await app.request(`${BASE_URL}/api/v2/passkeys/cred-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ disabled: true }),
      }, testEnv);
      expect(res.status).toBe(200);
      const creds = await getCredentials(testEnv);
      expect(creds.find((c) => c.id === 'cred-1')?.disabled).toBe(true);
    });

    it('requires confirm_last when disabling the only active passkey', async () => {
      // First disable cred-2
      const creds = await getCredentials(testEnv);
      creds.find((c) => c.id === 'cred-2')!.disabled = true;
      await saveCredentials(testEnv, creds);

      // Attempt to disable cred-1 without confirmation
      const res = await app.request(`${BASE_URL}/api/v2/passkeys/cred-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ disabled: true }),
      }, testEnv);
      expect(res.status).toBe(400);
      const err = await res.json<any>();
      expect(err.error).toEqual({
        code: 'PASSKEY_CONFIRM_LAST',
        message:
          'This is the last active passkey. The next sign-in will require your SETUP_TOKEN. Confirm the action',
      });

      // Attempt to disable cred-1 WITH confirm_last: true
      const confirmedRes = await app.request(`${BASE_URL}/api/v2/passkeys/cred-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ disabled: true, confirm_last: true }),
      }, testEnv);
      expect(confirmedRes.status).toBe(200);
      const updatedCreds = await getCredentials(testEnv);
      expect(updatedCreds.find((c) => c.id === 'cred-1')?.disabled).toBe(true);
    });
  });

  describe('DELETE /api/v2/passkeys/:id', () => {
    beforeEach(async () => {
      const mockCreds: StoredCredential[] = [
        {
          id: 'cred-1',
          publicKey: 'pub-1',
          counter: 1,
          label: 'MacBook',
          createdAt: new Date().toISOString(),
          disabled: false,
        },
        {
          id: 'cred-2',
          publicKey: 'pub-2',
          counter: 1,
          label: 'iPhone',
          createdAt: new Date().toISOString(),
          disabled: false,
        },
      ];
      await saveCredentials(testEnv, mockCreds);
    });

    it('deletes a passkey without confirm_last if other active passkeys remain', async () => {
      const res = await app.request(`${BASE_URL}/api/v2/passkeys/cred-2`, {
        method: 'DELETE',
        headers: { Cookie: sessionCookie },
      }, testEnv);
      expect(res.status).toBe(200);
      const creds = await getCredentials(testEnv);
      expect(creds.length).toBe(1);
      expect(creds[0].id).toBe('cred-1');
    });

    it('requires confirm_last when deleting the only active passkey', async () => {
      // Delete cred-2 first
      const creds = await getCredentials(testEnv);
      await saveCredentials(testEnv, [creds[0]]);

      // Attempt to delete cred-1 without confirm_last
      const res = await app.request(`${BASE_URL}/api/v2/passkeys/cred-1`, {
        method: 'DELETE',
        headers: { Cookie: sessionCookie },
      }, testEnv);
      expect(res.status).toBe(400);
      const err = await res.json<any>();
      expect(err.error).toEqual({
        code: 'PASSKEY_CONFIRM_LAST',
        message:
          'This is the last active passkey. The next sign-in will require your SETUP_TOKEN. Confirm the action',
      });

      // Attempt with query parameter ?confirm_last=true
      const confirmRes = await app.request(`${BASE_URL}/api/v2/passkeys/cred-1?confirm_last=true`, {
        method: 'DELETE',
        headers: { Cookie: sessionCookie },
      }, testEnv);
      expect(confirmRes.status).toBe(200);
      const afterCreds = await getCredentials(testEnv);
      expect(afterCreds.length).toBe(0);
    });
  });

  describe('Authentication with disabled and active passkeys', () => {
    it('disables login for disabled passkey and tracks lastUsedAt upon active login', async () => {
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      // Register passkey first
      const optReg = await app.request(`${BASE_URL}/api/v2/passkeys/register-options`, {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      }, testEnv);
      const regOptions = await optReg.json<any>();

      const regPayload = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: regOptions.challenge,
        keyPair,
        credentialId,
      });

      const regCeremony = (optReg.headers.get('Set-Cookie') || '').split(';')[0];
      await app.request(`${BASE_URL}/api/v2/passkeys/register-verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: regCeremony ? `${sessionCookie}; ${regCeremony}` : sessionCookie,
        },
        body: JSON.stringify({ response: regPayload, label: 'Test Key' }),
      }, testEnv);

      // 1. Successful authentication
      const optRes = await app.request(`${BASE_URL}/api/auth/login/options`, { method: 'POST' }, testEnv);
      expect(optRes.status).toBe(200);
      const opts = await optRes.json<any>();

      const authPayload = await createMockAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: opts.challenge,
        keyPair,
        credentialId,
        counter: 1,
      });

      const loginCeremony = (optRes.headers.get('Set-Cookie') || '').split(';')[0];
      const verifyRes = await app.request(`${BASE_URL}/api/auth/login/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(loginCeremony ? { Cookie: loginCeremony } : {}),
        },
        body: JSON.stringify({ response: authPayload }),
      }, testEnv);
      expect(verifyRes.status).toBe(200);

      // Check that lastUsedAt was recorded
      const credsAfter = await getCredentials(testEnv);
      expect(credsAfter[0].lastUsedAt).toBeDefined();

      // 2. Disable the passkey
      credsAfter[0].disabled = true;
      await saveCredentials(testEnv, credsAfter);

      // 3. Options fails because no active passkeys exist
      const optRes2 = await app.request(`${BASE_URL}/api/auth/login/options`, { method: 'POST' }, testEnv);
      expect(optRes2.status).toBe(400);
      expect(await optRes2.json()).toEqual({
        error: {
          code: 'PASSKEY_NOT_REGISTERED',
          message: 'No passkey is registered — start with /setup/passkey',
        },
      });
    });
  });
});
