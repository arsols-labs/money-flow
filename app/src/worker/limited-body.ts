import { ValidationError } from './api-error';

/** Analytics filter POST — reject before buffering a huge JSON document. */
export const ANALYTICS_MAX_JSON_BYTES = 16_384;
/** MCP JSON-RPC envelope, including tools/call arguments. */
export const MCP_MAX_JSON_BYTES = 65_536;

export class BodyTooLargeError extends ValidationError {
  constructor(field = 'body') {
    super('FILTER_TOO_LARGE', { field });
  }
}

function contentLengthBytes(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Bound JSON bodies by declared Content-Length first, then by streamed bytes.
 * Callers must use the returned text — the request body is consumed.
 */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const declared = contentLengthBytes(request.headers);
  if (declared !== null && declared > maxBytes) {
    throw new BodyTooLargeError('content-length');
  }

  const reader = request.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BodyTooLargeError('body');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return '';
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function readLimitedJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readLimitedText(request, maxBytes);
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as unknown;
}
