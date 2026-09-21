import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_MESSAGES,
  apiErrorBody,
  interpolateApiErrorMessage,
  isApiErrorCode,
  parseApiError,
} from '../src/shared/api-errors';
import en from '../src/ui/locales/en.json';
import ru from '../src/ui/locales/ru.json';
import de from '../src/ui/locales/de.json';
import fr from '../src/ui/locales/fr.json';
import es from '../src/ui/locales/es.json';
import pt from '../src/ui/locales/pt.json';
import sr from '../src/ui/locales/sr.json';

const ERROR_LOCALES = { en, ru, de, fr, es, pt, sr } as const;

describe('API error catalog (issue #513, #548)', () => {
  it('every catalog code has an English message and matching i18n keys', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_MESSAGES[code].length, code).toBeGreaterThan(0);
      for (const [lng, dict] of Object.entries(ERROR_LOCALES)) {
        expect((dict.errors as Record<string, string>)[code], `${lng}.errors.${code}`).toBeTypeOf('string');
      }
    }
  });

  it('builds the documented envelope and interpolates params', () => {
    expect(apiErrorBody('ACCOUNT_NOT_FOUND')).toEqual({
      error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' },
    });
    expect(apiErrorBody('RATE_IN_USE', { code: 'RSD' }).error).toEqual({
      code: 'RATE_IN_USE',
      message: interpolateApiErrorMessage(API_ERROR_MESSAGES.RATE_IN_USE, { code: 'RSD' }),
      params: { code: 'RSD' },
    });
    expect(apiErrorBody('RATE_IN_USE', { code: 'RSD' }).error.message).toContain('RSD');
  });

  it('parseApiError accepts the envelope and leftover string errors', () => {
    expect(parseApiError({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Unauthorized',
    });
    expect(parseApiError({ error: 'legacy string' })).toEqual({
      code: 'OPERATION_FAILED',
      message: 'legacy string',
    });
    expect(isApiErrorCode('ACCOUNT_NOT_FOUND')).toBe(true);
    expect(isApiErrorCode('not-a-code')).toBe(false);
  });
});
