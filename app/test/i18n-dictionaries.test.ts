import { describe, expect, it } from 'vitest';
import en from '../src/ui/locales/en.json';
import ru from '../src/ui/locales/ru.json';
import de from '../src/ui/locales/de.json';
import fr from '../src/ui/locales/fr.json';
import es from '../src/ui/locales/es.json';
import pt from '../src/ui/locales/pt.json';
import sr from '../src/ui/locales/sr.json';

const LOCALES = { ru, de, fr, es, pt, sr } as const;

function flatten(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) => (
    flatten(value, prefix ? `${prefix}.${key}` : key)
  ));
}

function values(obj: unknown, prefix = ''): Array<{ key: string, value: unknown }> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return prefix ? [{ key: prefix, value: obj }] : [];
  }
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) => (
    values(value, prefix ? `${prefix}.${key}` : key)
  ));
}

function interpolationTokens(text: string): string[] {
  return [...text.matchAll(/\{\{\s*[\w.]+\s*\}\}/g)].map((m) => m[0].replace(/\s+/g, '')).sort();
}

describe('i18n dictionaries (issues #512, #513, #548, #586)', () => {
  it('every English key exists in de/fr/es/pt/ru/sr (locales may add plural forms)', () => {
    const englishKeys = flatten(en);
    for (const [lng, dict] of Object.entries(LOCALES)) {
      const keys = new Set(flatten(dict));
      for (const key of englishKeys) {
        expect(keys.has(key), `${lng} missing ${key}`).toBe(true);
      }
    }
  });

  it('has no empty string values', () => {
    for (const { key, value } of [en, ...Object.values(LOCALES)].flatMap((dict) => values(dict))) {
      expect(value, key).toBeTypeOf('string');
      expect(String(value).length, key).toBeGreaterThan(0);
    }
  });

  it('keeps interpolation tokens identical to English', () => {
    const english = Object.fromEntries(values(en).map(({ key, value }) => [key, String(value)]));
    for (const [lng, dict] of Object.entries(LOCALES)) {
      for (const { key, value } of values(dict)) {
        if (!(key in english)) continue;
        expect(interpolationTokens(String(value)), `${lng} ${key}`).toEqual(
          interpolationTokens(english[key]),
        );
      }
    }
  });

  it('uses distinct financial terms in English for core Pulse labels', () => {
    expect(en.pulse.metrics.netWorth).toBe('Net Worth');
    expect(en.pulse.metrics.cashFlow).toBe('Cash Flow');
    expect(en.pulse.forecast.title).toBe('Balance Forecast');
    expect(en.analytics.recurring.title).toBe('Recurring');
    expect(en.shell.tabs.pulse).toBe('Pulse');
  });

  it('exposes native names for every supported language', () => {
    expect(en.language).toMatchObject({
      en: 'English',
      ru: 'Русский',
      de: 'Deutsch',
      fr: 'Français',
      es: 'Español',
      pt: 'Português',
      sr: 'Srpski',
    });
    for (const dict of Object.values(LOCALES)) {
      expect(dict.language.en).toBe('English');
      expect(dict.language.ru).toBe('Русский');
      expect(dict.language.de).toBe('Deutsch');
      expect(dict.language.fr).toBe('Français');
      expect(dict.language.es).toBe('Español');
      expect(dict.language.pt).toBe('Português');
      expect(dict.language.sr).toBe('Srpski');
    }
  });
});
