import { ValidationError } from './api-error';
import { readLimitedBytes } from './limited-body';
import { STATEMENT_IMPORT_MAX_FILE_BYTES } from '../shared/statement-import/types';

/** One-time PUT URL lifetime. Expired rows are deleted on the next upload call. */
export const STATEMENT_UPLOAD_TTL_SECONDS = 10 * 60;

const UPLOAD_DOMAIN = 'money-flow:statement-upload:v1:';

export type StatementUploadFailure = 'expired' | 'already used' | 'unknown' | 'empty' | 'too large';

function nowIso(at = Date.now()): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const cleaned = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function uploadKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('statement upload signing is unavailable');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signStatementUploadToken(
  secret: string,
  payload: { id: string; exp: number },
): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ v: 1, ...payload })));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await uploadKey(secret),
    new TextEncoder().encode(`${UPLOAD_DOMAIN}${body}`),
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyStatementUploadToken(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<{ id: string; exp: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signatureValue] = parts;
  if (!body || !signatureValue) return null;
  const signature = base64UrlDecode(signatureValue);
  const payloadBytes = base64UrlDecode(body);
  if (!signature || !payloadBytes) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await uploadKey(secret),
    signature,
    new TextEncoder().encode(`${UPLOAD_DOMAIN}${body}`),
  );
  if (!valid) return null;
  let payload: { v?: unknown; id?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (payload.v !== 1 || typeof payload.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.id)) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  return { id: payload.id, exp: payload.exp };
}

export function statementUploadFilename(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'statement.csv';
  const base = raw.split(/[/\\]/).pop() ?? 'statement.csv';
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'statement.csv';
}

export async function purgeExpiredStatementUploads(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM statement_import_uploads WHERE expires_at <= ?').bind(nowIso(now)).run();
}

export async function createStatementUploadSlot(
  db: D1Database,
  secret: string,
  filename: unknown,
  origin: string,
): Promise<{ upload_id: string; upload_url: string; expires_at: string; max_file_bytes: number }> {
  await purgeExpiredStatementUploads(db);
  const id = crypto.randomUUID();
  const created = Date.now();
  const expiresAt = nowIso(created + STATEMENT_UPLOAD_TTL_SECONDS * 1000);
  const name = statementUploadFilename(filename);
  await db.prepare(
    `INSERT INTO statement_import_uploads (id, filename, content_base64, byte_length, expires_at, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?)`,
  ).bind(id, name, expiresAt, nowIso(created)).run();
  const exp = Math.floor(created / 1000) + STATEMENT_UPLOAD_TTL_SECONDS;
  const token = await signStatementUploadToken(secret, { id, exp });
  const uploadUrl = new URL(`/api/v2/statement-imports/uploads/${token}`, origin).toString();
  return {
    upload_id: id,
    upload_url: uploadUrl,
    expires_at: expiresAt,
    max_file_bytes: STATEMENT_IMPORT_MAX_FILE_BYTES,
  };
}

async function uploadFailure(db: D1Database, id: string, now: number): Promise<StatementUploadFailure> {
  const row = await db.prepare(
    'SELECT content_base64, expires_at FROM statement_import_uploads WHERE id = ?',
  ).bind(id).first<{ content_base64: string | null; expires_at: string }>();
  if (!row) return 'unknown';
  if (row.expires_at <= nowIso(now)) {
    await purgeExpiredStatementUploads(db, now);
    return 'expired';
  }
  if (row.content_base64 !== null) return 'already used';
  return 'unknown';
}

export async function acceptStatementUpload(
  db: D1Database,
  secret: string,
  token: string,
  bytes: Uint8Array,
  now = Date.now(),
): Promise<{ upload_id: string; filename: string; byte_length: number }> {
  await purgeExpiredStatementUploads(db, now);
  const verified = await verifyStatementUploadToken(secret, token, now);
  if (verified && verified.exp * 1000 <= now) {
    await purgeExpiredStatementUploads(db, now);
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: 'expired' });
  }
  if (!verified) {
    const decoded = token.split('.')[0] ?? '';
    const payloadBytes = base64UrlDecode(decoded);
    let id = '';
    if (payloadBytes) {
      try {
        const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { id?: unknown };
        if (typeof payload.id === 'string') id = payload.id;
      } catch {
        id = '';
      }
    }
    const reason = id ? await uploadFailure(db, id, now) : 'unknown';
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: reason === 'unknown' ? 'expired or unknown' : reason });
  }
  if (bytes.byteLength === 0) {
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: 'empty' });
  }
  if (bytes.byteLength > STATEMENT_IMPORT_MAX_FILE_BYTES) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'file', limit: STATEMENT_IMPORT_MAX_FILE_BYTES });
  }
  const stored = bytesToBase64(bytes);
  const updated = await db.prepare(
    `UPDATE statement_import_uploads
     SET content_base64 = ?, byte_length = ?
     WHERE id = ? AND content_base64 IS NULL AND expires_at > ?`,
  ).bind(stored, bytes.byteLength, verified.id, nowIso(now)).run();
  if ((updated.meta.changes ?? 0) < 1) {
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: await uploadFailure(db, verified.id, now) });
  }
  const row = await db.prepare(
    'SELECT filename FROM statement_import_uploads WHERE id = ?',
  ).bind(verified.id).first<{ filename: string }>();
  return { upload_id: verified.id, filename: row?.filename ?? 'statement.csv', byte_length: bytes.byteLength };
}

export async function readStatementUpload(
  db: D1Database,
  uploadId: string,
  now = Date.now(),
): Promise<{ filename: string; bytes: Uint8Array }> {
  await purgeExpiredStatementUploads(db, now);
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: 'unknown' });
  }
  const row = await db.prepare(
    `SELECT filename, content_base64, byte_length, expires_at
     FROM statement_import_uploads WHERE id = ?`,
  ).bind(uploadId).first<{
    filename: string;
    content_base64: string | null;
    byte_length: number | null;
    expires_at: string;
  }>();
  if (!row || row.expires_at <= nowIso(now)) {
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: 'expired or unknown' });
  }
  if (!row.content_base64 || row.byte_length === null) {
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: 'file has not been uploaded' });
  }
  if (row.byte_length > STATEMENT_IMPORT_MAX_FILE_BYTES) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'file', limit: STATEMENT_IMPORT_MAX_FILE_BYTES });
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(row.content_base64);
  } catch {
    throw new ValidationError('STATEMENT_UPLOAD_INVALID', { detail: 'stored file is unreadable' });
  }
  if (bytes.byteLength !== row.byte_length || bytes.byteLength > STATEMENT_IMPORT_MAX_FILE_BYTES) {
    throw new ValidationError('IMPORT_TOO_LARGE', { scope: 'file', limit: STATEMENT_IMPORT_MAX_FILE_BYTES });
  }
  return { filename: row.filename, bytes };
}

export async function consumeStatementUploads(db: D1Database, uploadIds: readonly string[]): Promise<void> {
  const ids = [...new Set(uploadIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  for (const id of ids) {
    await db.prepare('DELETE FROM statement_import_uploads WHERE id = ?').bind(id).run();
  }
}

export async function readUploadRequestBody(request: Request): Promise<Uint8Array> {
  return readLimitedBytes(request, STATEMENT_IMPORT_MAX_FILE_BYTES);
}
