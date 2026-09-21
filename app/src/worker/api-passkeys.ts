// API для управления устройствами и passkeys пользователя (issue #507)

import { Hono } from 'hono';
import type { Env } from './types';
import {
  MAX_PASSKEYS_COUNT,
  getCredentials,
  updateCredentialLabel,
  setCredentialDisabled,
  removeCredential,
  isLastActiveCredential,
  registrationOptions,
  registrationVerify,
  resolveOrigin,
  resolveRpID,
  parseCeremonyId,
  ceremonyCookie,
  requireFreshAuth,
  bumpAuthEpoch,
  createSessionCookie,
} from './auth';
import { AppError, fail, failCaught } from './api-error';

const passkeysApi = new Hono<{ Bindings: Env }>();

/**
 * Список всех passkeys текущего пользователя (с метаданными и статусом).
 */
passkeysApi.get('/', async (c) => {
  const creds = await getCredentials(c.env);
  const passkeys = creds.map((k) => ({
    id: k.id,
    label: k.label,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt ?? null,
    disabled: Boolean(k.disabled),
    transports: k.transports ?? [],
  }));

  return c.json({
    passkeys,
    total: passkeys.length,
    active_count: passkeys.filter((p) => !p.disabled).length,
    max_limit: MAX_PASSKEYS_COUNT,
  });
});

/**
 * Генерация options для регистрации нового passkey авторизованным пользователем.
 */
passkeysApi.post('/register-options', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    await requireFreshAuth(c.env, c.req.header('Cookie'), body.token);
    const options = await registrationOptions(c.env, resolveRpID(c));
    const secure = resolveOrigin(c).startsWith('https');
    c.header('Set-Cookie', ceremonyCookie(options.ceremonyId, secure));
    return c.json(options);
  } catch (err: unknown) {
    if (err instanceof AppError) return failCaught(c, err);
    return fail(c, 'PASSKEY_OPTIONS_FAILED', 400);
  }
});

/**
 * Верификация и сохранение нового passkey от авторизованного пользователя.
 */
passkeysApi.post('/register-verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.response) {
    return fail(c, 'PASSKEY_RESPONSE_REQUIRED', 400);
  }

  try {
    await requireFreshAuth(c.env, c.req.header('Cookie'), body.token);
    const verified = await registrationVerify(
      c.env,
      resolveRpID(c),
      resolveOrigin(c),
      body.response,
      body.label ?? '',
      parseCeremonyId(c.req.header('Cookie')),
    );
    if (!verified) {
      return fail(c, 'PASSKEY_VERIFICATION_FAILED', 400);
    }
    const epoch = await bumpAuthEpoch(c.env);
    const creds = await getCredentials(c.env);
    const newest = creds[creds.length - 1];
    const secure = resolveOrigin(c).startsWith('https');
    c.header('Set-Cookie', await createSessionCookie(c.env, secure, {
      epoch,
      ...(newest?.id ? { cid: newest.id } : {}),
    }));
    return c.json({ verified: true });
  } catch (err: unknown) {
    if (err instanceof AppError) return failCaught(c, err);
    return fail(c, 'PASSKEY_VERIFICATION_FAILED', 400);
  }
});

/**
 * Обновление passkey: переименование (label) или отключение/включение (disabled).
 */
passkeysApi.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const creds = await getCredentials(c.env);
  const cred = creds.find((k) => k.id === id);

  if (!cred) {
    return fail(c, 'PASSKEY_NOT_FOUND', 404);
  }

  if (typeof body.label === 'string') {
    const trimmed = body.label.trim();
    if (!trimmed) {
      return fail(c, 'PASSKEY_LABEL_EMPTY', 400);
    }
    if (trimmed.length > 64) {
      return fail(c, 'PASSKEY_LABEL_TOO_LONG', 400);
    }
    const updated = await updateCredentialLabel(c.env, id, trimmed);
    if (!updated) return fail(c, 'PASSKEY_NOT_FOUND', 404);
    cred.label = updated.label;
  }

  let factorChanged = false;
  if (typeof body.disabled === 'boolean') {
    await requireFreshAuth(c.env, c.req.header('Cookie'), body.token);
    if (body.disabled && !cred.disabled) {
      const isLast = isLastActiveCredential(creds, id);
      if (isLast && !body.confirm_last) {
        return fail(c, 'PASSKEY_CONFIRM_LAST', 400);
      }
    }
    if (cred.disabled !== body.disabled) factorChanged = true;
    if (!(await setCredentialDisabled(c.env, id, body.disabled))) {
      return fail(c, 'PASSKEY_NOT_FOUND', 404);
    }
    cred.disabled = body.disabled;
  }

  if (factorChanged) {
    const epoch = await bumpAuthEpoch(c.env);
    const secure = resolveOrigin(c).startsWith('https');
    c.header('Set-Cookie', await createSessionCookie(c.env, secure, { epoch }));
  }

  return c.json({
    passkey: {
      id: cred.id,
      label: cred.label,
      created_at: cred.createdAt,
      last_used_at: cred.lastUsedAt ?? null,
      disabled: Boolean(cred.disabled),
    },
  });
});

/**
 * Удаление passkey.
 */
passkeysApi.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  let confirmLast = c.req.query('confirm_last') === 'true' || body.confirm_last === true;
  await requireFreshAuth(c.env, c.req.header('Cookie'), body.token);

  const creds = await getCredentials(c.env);
  const credIndex = creds.findIndex((k) => k.id === id);

  if (credIndex === -1) {
    return fail(c, 'PASSKEY_NOT_FOUND', 404);
  }

  const cred = creds[credIndex];
  if (!cred.disabled) {
    const isLast = isLastActiveCredential(creds, id);
    if (isLast && !confirmLast) {
      return fail(c, 'PASSKEY_CONFIRM_LAST', 400);
    }
  }

  await removeCredential(c.env, id);
  const epoch = await bumpAuthEpoch(c.env);
  const secure = resolveOrigin(c).startsWith('https');
  c.header('Set-Cookie', await createSessionCookie(c.env, secure, { epoch }));

  return c.json({ success: true });
});

export default passkeysApi;
