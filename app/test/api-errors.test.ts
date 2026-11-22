import { describe, expect, it } from 'vitest';
import { parseApiError, API_ERROR_CODES, API_ERROR_MESSAGES, apiErrorBody, interpolateApiErrorMessage, isApiErrorCode, type ApiErrorParams } from '../src/shared/api-errors';
import { MissingCurrencyConfigError } from '../src/shared/currency';
import { failCaught } from '../src/worker/api-error';
import { localizeApiError } from '../src/ui/api';
import i18n from '../src/ui/i18n';
import en from '../src/ui/locales/en.json';
import ru from '../src/ui/locales/ru.json';
import de from '../src/ui/locales/de.json';
import fr from '../src/ui/locales/fr.json';
import es from '../src/ui/locales/es.json';
import pt from '../src/ui/locales/pt.json';
import sr from '../src/ui/locales/sr.json';

const LOCALES = { en, ru, de, fr, es, pt, sr } as const;

describe('API error catalog', () => {
  it('every catalog code has an English message and translation in every UI locale', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_MESSAGES[code].length, code).toBeGreaterThan(0);
      for (const [lng, dict] of Object.entries(LOCALES)) {
        const errors = dict.errors as Record<string, string>;
        expect(errors[code], `${lng}.errors.${code}`).toBeTypeOf('string');
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

  it('localizes MISSING_CONFIGURATION on actions without exposing raw rule domain ids', async () => {
    await i18n.changeLanguage('en');
    const domains: ApiErrorParams[] = [
      { domain: 'currency_standards' },
      { domain: 'currency_standards', currency: 'RSD' },
      { domain: 'pdf_layouts' },
      { domain: 'statement_templates' },
      { domain: 'fiscal_formats' },
    ];
    for (const params of domains) {
      const msg = localizeApiError(apiErrorBody('MISSING_CONFIGURATION', params), 422);
      expect(msg).not.toContain('currency_standards');
      expect(msg).not.toContain('pdf_layouts');
      expect(msg).not.toContain('statement_templates');
      expect(msg).not.toContain('fiscal_formats');
      expect(msg.length).toBeGreaterThan(10);
    }
    expect(localizeApiError(apiErrorBody('MISSING_CONFIGURATION', { domain: 'currency_standards', currency: 'RSD' }), 422)).toContain('RSD');

    await i18n.changeLanguage('ru');
    const ruPdf = localizeApiError(apiErrorBody('MISSING_CONFIGURATION', { domain: 'pdf_layouts' }), 422);
    expect(ruPdf).not.toContain('pdf_layouts');
    expect(ruPdf).toContain('PDF');
    await i18n.changeLanguage('en');

    const mockCtx = { json: (body: unknown, status: number) => ({ body, status }) } as any;
    const caught = failCaught(mockCtx, new MissingCurrencyConfigError('RSD')) as any;
    expect(caught.status).toBe(422);
    expect(caught.body.error.params?.currency).toBe('RSD');
    expect(localizeApiError(caught.body, 422)).toContain('RSD');
    expect(localizeApiError(caught.body, 422)).not.toContain('currency_standards');
  });
});
