import { expect } from 'vitest';
import { parseApiError, type ApiErrorPayload } from '../src/shared/api-errors';

export async function errorBody(res: Response): Promise<ApiErrorPayload> {
  const parsed = parseApiError(await res.json());
  expect(parsed, 'response should use { error: { code, message } }').not.toBeNull();
  return parsed!;
}

export async function errorOf(res: Response): Promise<string> {
  return (await errorBody(res)).message;
}

export async function expectErrorCode(res: Response, code: string): Promise<ApiErrorPayload> {
  const error = await errorBody(res);
  expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);
  return error;
}
