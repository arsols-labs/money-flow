import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '../src/ui/language.js';
import { MCP_WIDGET_I18N_SCRIPT, WIDGET_CATALOGS } from '../src/worker/mcp-widget-i18n';
import { getAnalyticsHtml } from '../src/worker/mcp-analytics-ui';
import { getPulseHtml } from '../src/worker/mcp-pulse-ui';
import { getWriteConfirmHtml } from '../src/worker/mcp-write-confirm-ui';

function runtime(navigatorLanguages: string[]) {
  const attrs: Record<string, string> = {};
  const sandbox: any = {
    window: {},
    navigator: { languages: navigatorLanguages, language: navigatorLanguages[0] },
    document: {
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
      querySelectorAll: () => [],
    },
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'navigator', 'document',
    `${MCP_WIDGET_I18N_SCRIPT}\nreturn { t, setWidgetLocale, hostLocaleCandidates, intlLocale };`);
  return { api: factory(sandbox.window, sandbox.navigator, sandbox.document), attrs };
}

describe('MCP widget i18n', () => {
  it('ships every key in all supported languages', () => {
    const enKeys = Object.keys(WIDGET_CATALOGS.en).sort();
    expect(Object.keys(WIDGET_CATALOGS).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
    for (const lng of SUPPORTED_LANGUAGES) {
      expect(Object.keys(WIDGET_CATALOGS[lng]).sort(), lng).toEqual(enKeys);
      for (const key of enKeys) expect(WIDGET_CATALOGS[lng][key].trim(), `${lng}:${key}`).not.toBe('');
    }
  });

  it('defaults to English when no supported locale is offered', () => {
    const { api, attrs } = runtime(['ja-JP']);
    expect(api.t('pulse.title')).toBe('Pulse');
    expect(attrs.lang).toBe('en');
    expect(api.intlLocale()).toBe('en-US');
  });

  it('prefers the host locale from ui/initialize over the browser', () => {
    const { api, attrs } = runtime(['fr-FR']);
    expect(api.t('pulse.title')).toBe('Pouls');
    api.setWidgetLocale(api.hostLocaleCandidates({ hostContext: { locale: 'de-DE' } }));
    expect(api.t('analytics.positions', { p: 3, r: 2 })).toBe('3 Positionen in 2 Belegen');
    expect(attrs.lang).toBe('de');
    api.setWidgetLocale(api.hostLocaleCandidates({ hostContext: { locale: 'sr-Latn-RS' } }));
    expect(api.t('confirm.button')).toBe('Potvrdi');
  });

  it('renders English markup by default and no hard-coded Russian outside catalogs', () => {
    for (const html of [getAnalyticsHtml(), getPulseHtml(), getWriteConfirmHtml()]) {
      expect(html).toContain('<html lang="en">');
      const withoutCatalog = html.replace(/const WIDGET_STRINGS = .*;\n/, '');
      expect(withoutCatalog).not.toMatch(/[\u0400-\u04FF]/);
    }
  });
});
