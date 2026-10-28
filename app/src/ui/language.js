// Interface language selection.
//
// A separate module without i18next: tests and i18n initialization depend on it.
// A first visit with no mf_lang uses the browser/region language, otherwise en.
// A manual choice in the menu writes mf_lang and is no longer overridden by detection.

export const LANGUAGE_STORAGE_KEY = 'mf_lang';
export const DEFAULT_LANGUAGE = 'en';
export const SUPPORTED_LANGUAGES = /** @type {const} */ (['en', 'ru', 'de', 'fr', 'es', 'pt', 'sr']);

/** @type {Record<typeof SUPPORTED_LANGUAGES[number], string>} */
const INTL_LOCALES = {
  en: 'en-US',
  ru: 'ru-RU',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  pt: 'pt-PT',
  sr: 'sr-RS',
};

/**
 * @param {unknown} value
 * @returns {value is typeof SUPPORTED_LANGUAGES[number]}
 */
export function isSupportedLanguage(value) {
  return SUPPORTED_LANGUAGES.some((lng) => lng === value);
}

/**
 * Map a BCP 47 / locale tag to a supported language.
 * `sr-RS`, `sr-Latn`, `pt-BR` → language prefix; unknown → null.
 * @param {unknown} tag
 * @returns {typeof SUPPORTED_LANGUAGES[number] | null}
 */
export function mapLocaleTag(tag) {
  if (typeof tag !== 'string') return null;
  const normalized = tag.trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return null;
  if (isSupportedLanguage(normalized)) return normalized;
  const prefix = normalized.split('-')[0];
  return isSupportedLanguage(prefix) ? prefix : null;
}

/**
 * Accept-Language ranges, highest q first. Equal q keeps header order.
 * Ranges with q <= 0 are dropped. `*` is kept so mapLocaleTag can skip it.
 * @param {unknown} header
 * @returns {string[]}
 */
export function acceptLanguageTags(header) {
  if (typeof header !== 'string') return [];
  /** @type {{ tag: string, q: number, index: number }[]} */
  const ranges = [];
  for (const part of header.split(',')) {
    const pieces = part.split(';');
    const tag = (pieces[0] ?? '').trim();
    if (!tag) continue;
    let q = 1;
    for (const param of pieces.slice(1)) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      if (key !== 'q') continue;
      const parsed = Number(param.slice(eq + 1).trim());
      if (Number.isFinite(parsed)) q = parsed;
    }
    if (!(q > 0)) continue;
    ranges.push({ tag, q, index: ranges.length });
  }
  ranges.sort((a, b) => (b.q - a.q) || (a.index - b.index));
  return ranges.map((range) => range.tag);
}

/**
 * Explicit preference when mapLocaleTag accepts it; otherwise the first
 * matching Accept-Language range; otherwise English.
 * An unmapped preference is ignored, same as an invalid stored mf_lang.
 * @param {{ preference?: unknown, acceptLanguage?: unknown }} [input]
 * @returns {typeof SUPPORTED_LANGUAGES[number]}
 */
export function resolveRequestLanguage(input = {}) {
  const fromPreference = mapLocaleTag(input.preference);
  if (fromPreference) return fromPreference;
  for (const tag of acceptLanguageTags(input.acceptLanguage)) {
    const mapped = mapLocaleTag(tag);
    if (mapped) return mapped;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * @typedef {{
 *   languages?: readonly string[] | null,
 *   language?: string | null,
 *   intlLocale?: string | null,
 * }} BrowserLanguageHints
 */

/**
 * Detect a supported language from browser/region locale tags.
 * Order: `languages`, then `language`, then Intl resolved locale.
 * @param {BrowserLanguageHints} [hints]
 * @returns {typeof SUPPORTED_LANGUAGES[number]}
 */
export function detectBrowserLanguage(hints = {}) {
  const languages = hints.languages ?? (
    typeof navigator !== 'undefined' && Array.isArray(navigator.languages)
      ? navigator.languages
      : undefined
  );
  const language = hints.language ?? (
    typeof navigator !== 'undefined' ? navigator.language : undefined
  );
  const intlTag = hints.intlLocale ?? (
    typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : undefined
  );

  const candidates = [];
  if (Array.isArray(languages)) candidates.push(...languages);
  if (language) candidates.push(language);
  if (intlTag) candidates.push(intlTag);

  for (const tag of candidates) {
    const mapped = mapLocaleTag(tag);
    if (mapped) return mapped;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Stored manual preference, or null when missing/invalid/unavailable.
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @returns {typeof SUPPORTED_LANGUAGES[number] | null}
 */
export function peekStoredLanguage(storage) {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (!store) return null;
  try {
    const stored = store.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Manual pick wins; otherwise browser/region detect; otherwise `en`.
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @param {BrowserLanguageHints} [hints]
 * @returns {typeof SUPPORTED_LANGUAGES[number]}
 */
export function resolveInitialLanguage(storage, hints) {
  return peekStoredLanguage(storage) ?? detectBrowserLanguage(hints);
}

/**
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @returns {typeof SUPPORTED_LANGUAGES[number]}
 */
export function readStoredLanguage(storage) {
  return peekStoredLanguage(storage) ?? DEFAULT_LANGUAGE;
}

/**
 * @param {string} lng
 * @param {Pick<Storage, 'setItem'> | null | undefined} [storage]
 */
export function persistLanguage(lng, storage) {
  if (!isSupportedLanguage(lng)) return;
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (!store) return;
  try {
    store.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    // quota / private mode — the language lasts for the session
  }
}

/**
 * Persist a manual language pick. Detected defaults must not call this.
 * @param {string} lng
 * @param {Pick<Storage, 'setItem'> | null | undefined} [storage]
 */
export function chooseLanguage(lng, storage) {
  persistLanguage(lng, storage);
}

/**
 * @param {string} lng
 * @param {{ documentElement?: { lang: string } } | null | undefined} [doc]
 */
export function applyDocumentLanguage(lng, doc) {
  if (!isSupportedLanguage(lng)) return;
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  if (!target?.documentElement) return;
  target.documentElement.lang = lng;
}

/**
 * Locale tag for Intl date/number formatting.
 * @param {string} [lng]
 * @returns {string}
 */
export function intlLocale(lng) {
  return (lng && INTL_LOCALES[lng]) || 'en-US';
}
