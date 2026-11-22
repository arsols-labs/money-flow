/**
 * MCP Apps widget localization and D1-backed money formatting runtime.
 *
 * Interface strings stay in the application language templates (`mcp-widget-locales.json`).
 * Currency formatting metadata (minor_digits, symbol) comes from D1 rule sets injected at
 * `resources/read` time; when a currency is not configured in D1, raw minor units and
 * the stored currency code are shown as-is.
 */

import { SUPPORTED_LANGUAGES } from '../ui/language.js';
import catalogs from './mcp-widget-locales.json';

export interface WidgetCurrencyMetaEntry {
  fraction_digits: number;
  symbol: string | null;
}

export interface WidgetRenderOptions {
  currencyMeta?: Record<string, WidgetCurrencyMetaEntry>;
}

export const WIDGET_CATALOGS = catalogs as Record<string, Record<string, string>>;

const WIDGET_INTL = {
  en: 'en-US',
  ru: 'ru-RU',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  pt: 'pt-PT',
  sr: 'sr-Latn-RS',
};

export function buildWidgetI18nScript(options: WidgetRenderOptions = {}): string {
  const currencyMeta = options.currencyMeta ?? {};
  return `
      const WIDGET_STRINGS = ${JSON.stringify(catalogs).replace(/</g, '\\u003c')};
      const WIDGET_LANGS = ${JSON.stringify(SUPPORTED_LANGUAGES)};
      const WIDGET_INTL = ${JSON.stringify(WIDGET_INTL)};
      const WIDGET_CURRENCY_META = ${JSON.stringify(currencyMeta).replace(/</g, '\\u003c')};
      let widgetLocale = 'en';

      function mapWidgetLocale(tag) {
        if (typeof tag !== 'string') return null;
        const norm = tag.trim().replace(/_/g, '-').toLowerCase();
        if (!norm) return null;
        const prefix = norm.split('-')[0];
        return WIDGET_LANGS.indexOf(prefix) >= 0 ? prefix : null;
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
        if (vars) {
          for (const name of Object.keys(vars)) {
            s = s.split('{' + name + '}').join(String(vars[name] ?? ''));
          }
        }
        return s;
      }

      function currencyDigitsFor(code, overrideMeta) {
        const upper = typeof code === 'string' ? code.trim().toUpperCase() : '';
        if (!upper) return null;
        const meta = (overrideMeta && overrideMeta[upper]) || WIDGET_CURRENCY_META[upper];
        if (meta && typeof meta.fraction_digits === 'number' && Number.isInteger(meta.fraction_digits)) {
          return meta.fraction_digits;
        }
        return null;
      }

      function formatWidgetMoney(minor, currency, overrideMeta) {
        if (minor === null || minor === undefined) return '—';
        const upper = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
        if (!upper) return String(minor);
        const digits = currencyDigitsFor(upper, overrideMeta);
        if (digits === null) {
          return String(minor) + ' ' + upper;
        }
        const scale = Math.pow(10, digits);
        const amount = Number(minor) / scale;
        const meta = (overrideMeta && overrideMeta[upper]) || WIDGET_CURRENCY_META[upper];
        try {
          return new Intl.NumberFormat(intlLocale(), {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits
          }).format(amount) + ' ' + ((meta && meta.symbol) || upper);
        } catch {
          return amount.toFixed(digits) + ' ' + upper;
        }
      }

      function applyI18n() {
        document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
        document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
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

      setWidgetLocale(hostLocaleCandidates(null));
`;
}

export const MCP_WIDGET_I18N_SCRIPT = buildWidgetI18nScript();
