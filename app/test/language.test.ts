// Выбор языка интерфейса (issue #511, #548, #586).
//
// Чистые функции без i18next: default `en`, ключ `mf_lang`.
import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_STORAGE_KEY,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  applyDocumentLanguage,
  chooseLanguage,
  detectBrowserLanguage,
  intlLocale,
  isSupportedLanguage,
  mapLocaleTag,
  peekStoredLanguage,
  persistLanguage,
  readStoredLanguage,
  resolveInitialLanguage,
} from '../src/ui/language.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    dump() {
      return { ...data };
    },
  };
}

describe('language storage (issue #511, #548, #586)', () => {
  it('держит en/ru/de/fr/es/pt/sr, default — en', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'ru', 'de', 'fr', 'es', 'pt', 'sr']);
    expect(LANGUAGE_STORAGE_KEY).toBe('mf_lang');
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('ru')).toBe(true);
    expect(isSupportedLanguage('de')).toBe(true);
    expect(isSupportedLanguage('fr')).toBe(true);
    expect(isSupportedLanguage('es')).toBe(true);
    expect(isSupportedLanguage('pt')).toBe(true);
    expect(isSupportedLanguage('sr')).toBe(true);
    expect(isSupportedLanguage('zh')).toBe(false);
    expect(isSupportedLanguage('EN')).toBe(false);
    expect(isSupportedLanguage(null)).toBe(false);
  });

  it('без записи и без storage возвращает en', () => {
    expect(readStoredLanguage(memoryStorage())).toBe('en');
    expect(readStoredLanguage(null)).toBe('en');
    expect(peekStoredLanguage(memoryStorage())).toBeNull();
    expect(peekStoredLanguage(null)).toBeNull();
  });

  it('читает сохранённый язык и отбрасывает мусор', () => {
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'ru' }))).toBe('ru');
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'en' }))).toBe('en');
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'de' }))).toBe('de');
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'fr' }))).toBe('fr');
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'es' }))).toBe('es');
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'pt' }))).toBe('pt');
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'sr' }))).toBe('sr');
    expect(readStoredLanguage(memoryStorage({ mf_lang: 'zh' }))).toBe('en');
    expect(readStoredLanguage(memoryStorage({ mf_lang: '' }))).toBe('en');
  });

  it('пишет только поддерживаемый язык', () => {
    const store = memoryStorage();
    persistLanguage('ru', store);
    expect(store.dump()).toEqual({ mf_lang: 'ru' });
    persistLanguage('en', store);
    expect(store.dump()).toEqual({ mf_lang: 'en' });
    persistLanguage('de', store);
    expect(store.dump()).toEqual({ mf_lang: 'de' });
    persistLanguage('sr', store);
    expect(store.dump()).toEqual({ mf_lang: 'sr' });
    persistLanguage('zh', store);
    expect(store.dump()).toEqual({ mf_lang: 'sr' });
  });

  it('не падает, если storage бросает', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(readStoredLanguage(broken)).toBe('en');
    expect(peekStoredLanguage(broken)).toBeNull();
    expect(() => persistLanguage('ru', broken)).not.toThrow();
  });

  it('ставит lang на documentElement только для поддерживаемых языков', () => {
    const doc = { documentElement: { lang: 'ru' } };
    applyDocumentLanguage('en', doc);
    expect(doc.documentElement.lang).toBe('en');
    applyDocumentLanguage('ru', doc);
    expect(doc.documentElement.lang).toBe('ru');
    applyDocumentLanguage('de', doc);
    expect(doc.documentElement.lang).toBe('de');
    applyDocumentLanguage('sr', doc);
    expect(doc.documentElement.lang).toBe('sr');
    applyDocumentLanguage('zh', doc);
    expect(doc.documentElement.lang).toBe('sr');
    applyDocumentLanguage('en', null);
  });

  it('maps language codes to Intl locale tags', () => {
    expect(intlLocale('ru')).toBe('ru-RU');
    expect(intlLocale('en')).toBe('en-US');
    expect(intlLocale('de')).toBe('de-DE');
    expect(intlLocale('fr')).toBe('fr-FR');
    expect(intlLocale('es')).toBe('es-ES');
    expect(intlLocale('pt')).toBe('pt-PT');
    expect(intlLocale('sr')).toBe('sr-RS');
    expect(intlLocale(undefined)).toBe('en-US');
    expect(intlLocale('zh')).toBe('en-US');
  });
});

describe('browser locale detect (issue #586)', () => {
  it('maps exact codes and language/region prefixes', () => {
    expect(mapLocaleTag('sr')).toBe('sr');
    expect(mapLocaleTag('sr-RS')).toBe('sr');
    expect(mapLocaleTag('sr_RS')).toBe('sr');
    expect(mapLocaleTag('sr-Latn')).toBe('sr');
    expect(mapLocaleTag('sr-Latn-RS')).toBe('sr');
    expect(mapLocaleTag('SR-CYRL')).toBe('sr');
    expect(mapLocaleTag('pt-BR')).toBe('pt');
    expect(mapLocaleTag('de-AT')).toBe('de');
    expect(mapLocaleTag('en-GB')).toBe('en');
    expect(mapLocaleTag('zh-CN')).toBeNull();
    expect(mapLocaleTag('')).toBeNull();
    expect(mapLocaleTag(null)).toBeNull();
  });

  it('detects the first supported browser/region tag, else English', () => {
    expect(detectBrowserLanguage({
      languages: ['sr-RS', 'en-US'],
      language: 'en-US',
    })).toBe('sr');
    expect(detectBrowserLanguage({
      languages: ['zh-CN', 'ja'],
      language: 'pt-PT',
    })).toBe('pt');
    expect(detectBrowserLanguage({
      languages: ['zh-CN'],
      language: 'ja-JP',
      intlLocale: 'fr-FR',
    })).toBe('fr');
    expect(detectBrowserLanguage({
      languages: ['zh-CN'],
      language: 'ja',
      intlLocale: 'ko-KR',
    })).toBe('en');
    expect(detectBrowserLanguage({
      languages: [],
      language: '',
      intlLocale: '',
    })).toBe('en');
  });

  it('prefers a stored manual pick over browser detect', () => {
    const stored = memoryStorage({ mf_lang: 'en' });
    expect(resolveInitialLanguage(stored, {
      languages: ['sr-RS'],
      language: 'sr-RS',
      intlLocale: 'sr-RS',
    })).toBe('en');
    expect(resolveInitialLanguage(memoryStorage(), {
      languages: ['sr-Latn-RS'],
      language: 'sr',
    })).toBe('sr');
    expect(resolveInitialLanguage(memoryStorage({ mf_lang: 'zh' }), {
      languages: ['de-DE'],
    })).toBe('de');
    expect(resolveInitialLanguage(null, {
      languages: ['es-ES'],
    })).toBe('es');
  });

  it('manual chooseLanguage writes storage; detect does not', () => {
    const store = memoryStorage();
    expect(detectBrowserLanguage({ languages: ['ru-RU'] })).toBe('ru');
    expect(store.dump()).toEqual({});
    chooseLanguage('sr', store);
    expect(store.dump()).toEqual({ mf_lang: 'sr' });
    expect(resolveInitialLanguage(store, { languages: ['de-DE'] })).toBe('sr');
  });
});
