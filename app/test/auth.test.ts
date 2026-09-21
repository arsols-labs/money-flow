import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { isoBase64URL, isoCBOR, isoUint8Array } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import app from '../src/worker/index';
import {
  registrationOptions,
  registrationVerify,
  authenticationOptions,
  authenticationVerify,
  hasCredentials,
} from '../src/worker/auth';
import type { Env } from '../src/worker/types';

// Helper: Convert P1363 (r || s, 64 bytes) to ASN.1 DER SEQUENCE of two INTEGERs
function encodeDerInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  const slice = bytes.slice(start);
  const needsZero = (slice[0] & 0x80) !== 0;
  const len = slice.length + (needsZero ? 1 : 0);
  const res = new Uint8Array(2 + len);
  res[0] = 0x02; // INTEGER
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
  res[0] = 0x30; // SEQUENCE
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

// Helper: Build mock registration response
async function createMockRegistrationResponse(options: {
  rpID: string;
  origin: string;
  challenge: string;
  keyPair: CryptoKeyPair;
  credentialId: Uint8Array;
  flags: { up: boolean; uv: boolean };
}): Promise<RegistrationResponseJSON> {
  const { rpID, origin, challenge, keyPair, credentialId, flags } = options;

  // 1. ClientDataJSON
  const clientData = {
    type: 'webauthn.create',
    challenge,
    origin,
    crossOrigin: false,
  };
  const clientDataBytes = new TextEncoder().encode(JSON.stringify(clientData));

  // 2. Export COSE public key (P-256 / ES256)
  const exported = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const rawPub = new Uint8Array(exported as ArrayBuffer);
  const x = rawPub.slice(1, 33);
  const y = rawPub.slice(33, 65);

  const coseKey = new Map<number, number | Uint8Array>();
  coseKey.set(1, 2); // kty: EC2
  coseKey.set(3, -7); // alg: ES256
  coseKey.set(-1, 1); // crv: P-256
  coseKey.set(-2, x);
  coseKey.set(-3, y);
  const encodedCoseKey = isoCBOR.encode(coseKey as any);

  // 3. Authenticator Data
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpID)));
  let flagByte = 0x40; // AT (Attested credential data present)
  if (flags.up) flagByte |= 0x01;
  if (flags.uv) flagByte |= 0x04;

  const signCount = new Uint8Array(4); // 0
  const aaguid = new Uint8Array(16); // 16 zeros
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

  // 4. Attestation Object (fmt: "none")
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

// Helper: Build mock authentication response
async function createMockAuthenticationResponse(options: {
  rpID: string;
  origin: string;
  challenge: string;
  keyPair: CryptoKeyPair;
  credentialId: Uint8Array;
  counter: number;
  flags: { up: boolean; uv: boolean };
}): Promise<AuthenticationResponseJSON> {
  const { rpID, origin, challenge, keyPair, credentialId, counter, flags } = options;

  // 1. ClientDataJSON
  const clientData = {
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false,
  };
  const clientDataBytes = new TextEncoder().encode(JSON.stringify(clientData));
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));

  // 2. Authenticator Data (37 bytes: 32 bytes rpIdHash + 1 byte flag + 4 bytes counter)
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpID)));
  let flagByte = 0x00;
  if (flags.up) flagByte |= 0x01;
  if (flags.uv) flagByte |= 0x04;

  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, false);

  const authData = isoUint8Array.concat([
    rpIdHash,
    new Uint8Array([flagByte]),
    counterBytes,
  ]);

  // 3. Signature: ECDSA over (authData || SHA-256(clientDataJSON))
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

describe('WebAuthn User Verification & User Presence (#494)', () => {
  const RP_ID = 'example.com';
  const ORIGIN = 'https://example.com';

  beforeEach(async () => {
    await env.KV.delete('webauthn_credentials');
    await env.KV.delete('webauthn_challenge_reg');
    await env.KV.delete('webauthn_challenge_auth');
  });

  describe('registrationVerify', () => {
    it('succeeds when user presence is asserted but user verification is absent (up=1, uv=0)', async () => {
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      const options = await registrationOptions(env as unknown as Env, RP_ID);
      const response = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: options.challenge,
        keyPair,
        credentialId,
        flags: { up: true, uv: false },
      });

      const verified = await registrationVerify(
        env as unknown as Env,
        RP_ID,
        ORIGIN,
        response,
        'Test Passkey (UP only)',
        options.ceremonyId,
      );
      expect(verified).toBe(true);

      const hasCreds = await hasCredentials(env as unknown as Env);
      expect(hasCreds).toBe(true);
    });

    it('succeeds when both user presence and user verification are asserted (up=1, uv=1)', async () => {
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      const options = await registrationOptions(env as unknown as Env, RP_ID);
      const response = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: options.challenge,
        keyPair,
        credentialId,
        flags: { up: true, uv: true },
      });

      const verified = await registrationVerify(
        env as unknown as Env,
        RP_ID,
        ORIGIN,
        response,
        'Test Passkey (UP + UV)',
        options.ceremonyId,
      );
      expect(verified).toBe(true);
    });

    it('fails when user presence flag is absent (up=0)', async () => {
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      const options = await registrationOptions(env as unknown as Env, RP_ID);
      const response = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: options.challenge,
        keyPair,
        credentialId,
        flags: { up: false, uv: false },
      });

      await expect(
        registrationVerify(env as unknown as Env, RP_ID, ORIGIN, response, 'Invalid Passkey', options.ceremonyId),
      ).rejects.toThrow(/user was not present/i);
    });
  });

  describe('authenticationVerify', () => {
    it('succeeds when authenticating with UP only (up=1, uv=0)', async () => {
      // 1. Register a key first
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      const regOptions = await registrationOptions(env as unknown as Env, RP_ID);
      const regResponse = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: regOptions.challenge,
        keyPair,
        credentialId,
        flags: { up: true, uv: false },
      });
      await registrationVerify(env as unknown as Env, RP_ID, ORIGIN, regResponse, 'Passkey', regOptions.ceremonyId);

      // 2. Authenticate
      const authOpts = await authenticationOptions(env as unknown as Env, RP_ID);
      const authResponse = await createMockAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: authOpts.challenge,
        keyPair,
        credentialId,
        counter: 1,
        flags: { up: true, uv: false },
      });

      const verified = await authenticationVerify(env as unknown as Env, RP_ID, ORIGIN, authResponse, authOpts.ceremonyId);
      expect(verified).toBeTruthy();
    });

    it('succeeds when authenticating with UP and UV (up=1, uv=1)', async () => {
      // 1. Register
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      const regOptions = await registrationOptions(env as unknown as Env, RP_ID);
      const regResponse = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: regOptions.challenge,
        keyPair,
        credentialId,
        flags: { up: true, uv: true },
      });
      await registrationVerify(env as unknown as Env, RP_ID, ORIGIN, regResponse, 'Passkey', regOptions.ceremonyId);

      // 2. Authenticate
      const authOpts = await authenticationOptions(env as unknown as Env, RP_ID);
      const authResponse = await createMockAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: authOpts.challenge,
        keyPair,
        credentialId,
        counter: 1,
        flags: { up: true, uv: true },
      });

      const verified = await authenticationVerify(env as unknown as Env, RP_ID, ORIGIN, authResponse, authOpts.ceremonyId);
      expect(verified).toBeTruthy();
    });

    it('fails when authenticating without user presence (up=0)', async () => {
      // 1. Register
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      const regOptions = await registrationOptions(env as unknown as Env, RP_ID);
      const regResponse = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: regOptions.challenge,
        keyPair,
        credentialId,
        flags: { up: true, uv: false },
      });
      await registrationVerify(env as unknown as Env, RP_ID, ORIGIN, regResponse, 'Passkey', regOptions.ceremonyId);

      // 2. Authenticate with up=0
      const authOpts = await authenticationOptions(env as unknown as Env, RP_ID);
      const authResponse = await createMockAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: authOpts.challenge,
        keyPair,
        credentialId,
        counter: 1,
        flags: { up: false, uv: false },
      });

      await expect(
        authenticationVerify(env as unknown as Env, RP_ID, ORIGIN, authResponse, authOpts.ceremonyId),
      ).rejects.toThrow(/user not present/i);
    });
  });

  describe('HTTP API Endpoints', () => {
    it('allows complete registration and login flow with UP-only authenticator', async () => {
      const keyPair = await generateTestKeyPair();
      const credentialId = crypto.getRandomValues(new Uint8Array(16));

      const testEnv: Env = {
        ...(env as unknown as Env),
        SETUP_TOKEN: (env as unknown as Env).SETUP_TOKEN || 'test-setup-token',
      };

      // 1. Request registration options with valid SETUP_TOKEN
      const regOptionsRes = await app.request(
        `${ORIGIN}/api/auth/register/options`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: testEnv.SETUP_TOKEN }),
        },
        testEnv,
      );
      expect(regOptionsRes.status).toBe(200);
      const regOptions = await regOptionsRes.json<any>();
      expect(regOptions.authenticatorSelection.userVerification).toBe('preferred');

      // 2. Submit UP-only registration response
      const regPayload = await createMockRegistrationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: regOptions.challenge,
        keyPair,
        credentialId,
        flags: { up: true, uv: false },
      });

      const ceremonyCookie = (regOptionsRes.headers.get('Set-Cookie') || '').split(';')[0];
      const regVerifyRes = await app.request(
        `${ORIGIN}/api/auth/register/verify`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ceremonyCookie ? { Cookie: ceremonyCookie } : {}),
          },
          body: JSON.stringify({
            token: testEnv.SETUP_TOKEN,
            response: regPayload,
            label: 'Browser UP only',
          }),
        },
        testEnv,
      );
      expect(regVerifyRes.status).toBe(200);
      const regVerifyBody = await regVerifyRes.json<any>();
      expect(regVerifyBody.verified).toBe(true);

      // Session cookie is set on registration
      const setCookie = regVerifyRes.headers.get('Set-Cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('mf_session=');

      // 3. Request login options
      const loginOptionsRes = await app.request(
        `${ORIGIN}/api/auth/login/options`,
        {
          method: 'POST',
        },
        testEnv,
      );
      expect(loginOptionsRes.status).toBe(200);
      const loginOptions = await loginOptionsRes.json<any>();
      expect(loginOptions.userVerification).toBe('preferred');

      // 4. Submit UP-only login response
      const loginPayload = await createMockAuthenticationResponse({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: loginOptions.challenge,
        keyPair,
        credentialId,
        counter: 1,
        flags: { up: true, uv: false },
      });

      const loginCeremony = (loginOptionsRes.headers.get('Set-Cookie') || '').split(';')[0];
      const loginVerifyRes = await app.request(
        `${ORIGIN}/api/auth/login/verify`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(loginCeremony ? { Cookie: loginCeremony } : {}),
          },
          body: JSON.stringify({ response: loginPayload }),
        },
        testEnv,
      );
      expect(loginVerifyRes.status).toBe(200);
      const loginVerifyBody = await loginVerifyRes.json<any>();
      expect(loginVerifyBody.verified).toBe(true);

      const loginCookie = loginVerifyRes.headers.get('Set-Cookie');
      expect(loginCookie).toContain('mf_session=');

      // 5. Verify /api/auth/me with the login cookie
      const meRes = await app.request(
        `${ORIGIN}/api/auth/me`,
        {
          headers: { Cookie: loginCookie! },
        },
        testEnv,
      );
      expect(meRes.status).toBe(200);
      const meBody = await meRes.json<any>();
      expect(meBody.authenticated).toBe(true);
      expect(meBody.hasPasskeys).toBe(true);
    });
  });
});
