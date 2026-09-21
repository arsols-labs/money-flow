// Hono helpers and typed errors for the #513 API error envelope.
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  AppError,
  type ApiErrorCode,
  type ApiErrorParams,
  apiErrorBody,
} from '../shared/api-errors';

export { AppError };

/** Client-visible domain rejection. Default 400; 409 for expected conflicts. */
export class ValidationError extends AppError {
  constructor(code: ApiErrorCode, params?: ApiErrorParams, status: ContentfulStatusCode = 400) {
    super(code, status, params);
    this.name = 'ValidationError';
  }
}

/** Auth / passkey failures. Status defaults to 400. */
export class AuthError extends AppError {
  constructor(code: ApiErrorCode, status: ContentfulStatusCode = 400, params?: ApiErrorParams) {
    super(code, status, params);
    this.name = 'AuthError';
  }
}

export function fail(
  c: Context,
  code: ApiErrorCode,
  status: ContentfulStatusCode,
  params?: ApiErrorParams,
) {
  return c.json(apiErrorBody(code, params), status);
}

export function failFrom(c: Context, error: AppError) {
  return fail(c, error.code, error.status as ContentfulStatusCode, error.params);
}

/** Re-throw unknown errors; return the envelope for coded domain errors. */
export function failCaught(c: Context, error: unknown) {
  if (error instanceof AppError) return failFrom(c, error);
  throw error;
}
