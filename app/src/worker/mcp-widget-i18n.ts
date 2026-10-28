/**
 * MCP Apps widget localization.
 *
 * Widgets render inside the MCP host (ChatGPT, Claude, ...). The language the
 * user picked there is the selectable language for this surface, so the widget
 * follows it: `hostContext.locale` from the `ui/initialize` result (MCP Apps),
 * then `window.openai.locale`, then `navigator.languages`, then English.
 * Supported languages are the same seven as the web app (see ui/language.js).
 */

import { SUPPORTED_LANGUAGES } from '../ui/language.js';
import catalogs from './mcp-widget-locales.json';

export const WIDGET_CATALOGS = catalogs as Record<string, Record<string, string>>;

/** Inline script fragment: defines t(), applyI18n(), setWidgetLocale(), intlLocale(). */
export const MCP_WIDGET_I18N_SCRIPT = `
      const WIDGET_STRINGS = ${JSON.stringify(catalogs).replace(/</g, '\\u003c')};
      const WIDGET_LANGS = ${JSON.stringify(SUPPORTED_LANGUAGES)};
      const WIDGET_INTL = { en: 'en-US', ru: 'ru-RU', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-PT', sr: 'sr-Latn-RS' };
      let widgetLocale = 'en';

      function mapWidgetLocale(tag) {
        if (typeof tag !== 'string') return null;
        const norm = tag.trim().replace(/_/g, '-').toLowerCase();
        if (!norm) return null;
        const prefix = norm.split('-')[0];
        return WIDGET_LANGS.indexOf(prefix) >= 0 ? prefix : null;
      }

      function setWidgetLocale(candidates) {
        for (const tag of candidates) {
          const lng = mapWidgetLocale(tag);
          if (lng) { widgetLocale = lng; break; }
        }
        document.documentElement.setAttribute('lang', widgetLocale);
        applyI18n();
        return widgetLocale;
      }

      function hostLocaleCandidates(initRes) {
        const list = [];
        if (initRes && typeof initRes === 'object') {
          if (initRes.hostContext && typeof initRes.hostContext.locale === 'string') list.push(initRes.hostContext.locale);
          if (typeof initRes.locale === 'string') list.push(initRes.locale);
        }
        try { if (window.openai && typeof window.openai.locale === 'string') list.push(window.openai.locale); } catch {}
        try { (navigator.languages || [navigator.language]).forEach((l) => list.push(l)); } catch {}
        return list;
      }

      function intlLocale() {
        return WIDGET_INTL[widgetLocale] || 'en-US';
      }

      function t(key, vars) {
        const table = WIDGET_STRINGS[widgetLocale] || WIDGET_STRINGS.en;
        let s = table[key] ?? WIDGET_STRINGS.en[key] ?? key;
        if (vars) for (const name of Object.keys(vars)) s = s.split('{' + name + '}').join(String(vars[name]));
        return s;
      }

      function applyI18n() {
        document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
        document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
      }

      setWidgetLocale(hostLocaleCandidates(null));
`;
