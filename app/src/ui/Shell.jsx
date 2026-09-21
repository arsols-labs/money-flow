// Каркас приложения после входа: шапка, тема, навигация.
//
// Шапка и полоска разделов — один липкий блок `.appbar` (issue #329 и
// требование владельца 2026-08-21): базовая валюта, «Обновить», язык, тема и выбор
// раздела должны быть под рукой на любой глубине скролла, а не только полоска
// табов. Раздельными sticky-элементами это не делается: у них общий верх, и
// второй наезжал бы на первый.
//
// Строка-надпись «MONEY FLOW V2» из шапки убрана: она занимала целую строку
// липкого блока, ничего не сообщая (приложение и так одно), а высота липкого
// блока — это то, что он отъедает у контента на каждом экране.
//
// Высота блока меняется (перенос строки на узком экране), поэтому она не
// зашита в CSS числом, а измеряется и кладётся в `--appbar-h`: липкие панели
// фильтров внутри разделов встают ровно под шапкой по этой переменной.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ChartPie, DatabaseZap, Shield, MoreHorizontal, Check, RefreshCw, SlidersHorizontal, LogOut } from 'lucide-react';
import { ThemeDropdown, LanguageDropdown, BaseCurrencyDropdown, buildCurrencyOptions } from './components';
import { api } from './api';
import { useRefresh } from './RefreshContext';
import { resolveTheme, themePng32Url } from './theme';
import Analytics from './Analytics';
import Data from './Data';
import Pulse from './Pulse';
import McpAccess from './McpAccess';
import DemoBanner from './DemoBanner';

export const ALL_TABS = [
  { key: 'pulse', hash: '', titleKey: 'shell.tabs.pulse', icon: Activity },
  { key: 'analytics', hash: '#/analytics', titleKey: 'shell.tabs.analytics', icon: ChartPie },
  { key: 'data', hash: '#/data', titleKey: 'shell.tabs.data', icon: DatabaseZap },
  { key: 'access', hash: '#/access', titleKey: 'shell.tabs.access', icon: Shield },
];

export function tabFromHash(hash) {
  const h = hash ?? (typeof window !== 'undefined' ? window.location.hash : '');
  if (h.startsWith('#/analytics')) return 'analytics';
  if (h.startsWith('#/data') || h.startsWith('#/settings')) return 'data';
  if (h.startsWith('#/access')) return 'access';
  return 'pulse';
}

/**
 * @param {{ theme: string, setTheme: (theme: string) => void, resolvedTheme?: 'light' | 'dark' }} props
 */
export default function Shell({ theme, setTheme, resolvedTheme, demoMode = false }) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [tab, setTab] = useState(tabFromHash);
  const [baseCurrency, setBaseCurrency] = useState(null);
  const [currencyOptions, setCurrencyOptions] = useState([]);
  const [pulseCustomizing, setPulseCustomizing] = useState(false);
  const [analyticsCustomizing, setAnalyticsCustomizing] = useState(false);
  const [dataCustomizing, setDataCustomizing] = useState(false);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getSettings(), api.listAccounts()])
      .then(([settings, accRes]) => {
        if (cancelled) return;
        const current = settings.base_currency ?? null;
        const options = buildCurrencyOptions(accRes.accounts, current);
        setBaseCurrency(current);
        setCurrencyOptions(options);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleBaseCurrencyChange = (code) => {
    setBaseCurrency(code);
    api.putSetting('base_currency', code).then(refresh).catch(() => {});
  };

  const logoTheme = resolveTheme(resolvedTheme ?? theme);
  const activeTab = ALL_TABS.find(t => t.key === tab) ?? ALL_TABS[0];
  const goTo = (t) => {
    if (typeof window !== 'undefined') window.location.hash = t.hash;
    setTab(t.key);
  };

  const appbarRef = useRef(null);
  const syncAppbarHeight = useCallback(() => {
    const el = appbarRef.current;
    if (!el || typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--appbar-h', `${Math.round(el.offsetHeight)}px`);
  }, []);

  useEffect(() => {
    syncAppbarHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncAppbarHeight);
      return () => window.removeEventListener('resize', syncAppbarHeight);
    }
    const ro = new ResizeObserver(syncAppbarHeight);
    if (appbarRef.current) ro.observe(appbarRef.current);
    return () => ro.disconnect();
  }, [syncAppbarHeight, tab]);

  return (
    <div className="app-shell">
      {/* Навигационная рельса (Navigation Rail) для Medium и Expanded (>= 600px) */}
      <aside className="nav-rail" aria-label={t('shell.nav.main')}>
        <a
          href="#"
          className="nav-rail-brand"
          title="Money Flow"
          onClick={(e) => { e.preventDefault(); goTo(ALL_TABS[0]); }}
        >
          <div className="nav-rail-logo" aria-hidden="true">
            <img
              className="nav-rail-logo-img"
              src={themePng32Url(logoTheme)}
              alt=""
              width={32}
              height={32}
              draggable={false}
            />
          </div>
        </a>

        <nav className="nav-rail-items">
          {ALL_TABS.map((navTab) => {
            const Icon = navTab.icon;
            const isActive = tab === navTab.key;
            const title = t(navTab.titleKey);
            return (
              <button
                key={navTab.key}
                type="button"
                className={`nav-rail-item ${isActive ? 'nav-rail-item--active' : ''}`}
                onClick={() => goTo(navTab)}
                aria-current={isActive ? 'page' : undefined}
                title={title}
              >
                <div className="nav-rail-icon-wrapper">
                  <Icon size={20} />
                </div>
                <span className="nav-rail-label">{title}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="app-main">
        <div className="container">
          <div className="appbar" ref={appbarRef}>
            {demoMode && <DemoBanner />}
            <header className="topbar">
              <h1>{t(activeTab.titleKey)}</h1>
              <div className="topbar-actions">
                {currencyOptions.length > 0 && (
                  <BaseCurrencyDropdown
                    currencies={currencyOptions}
                    value={baseCurrency}
                    onChange={handleBaseCurrencyChange}
                  />
                )}
                <button
                  type="button"
                  className="topbar-btn topbar-btn--icon"
                  onClick={refresh}
                  title={t('shell.refresh')}
                  aria-label={t('shell.refreshAll')}
                >
                  <RefreshCw size={15} />
                </button>
                {activeTab.key === 'pulse' && (
                  <button
                    type="button"
                    className="topbar-btn topbar-btn--icon"
                    onClick={() => setPulseCustomizing(true)}
                    title={t('shell.settings.pulse')}
                    aria-label={t('shell.settings.pulse')}
                  >
                    <SlidersHorizontal size={15} />
                  </button>
                )}
                {activeTab.key === 'analytics' && (
                  <button
                    type="button"
                    className="topbar-btn topbar-btn--icon"
                    onClick={() => setAnalyticsCustomizing(true)}
                    title={t('shell.settings.analytics')}
                    aria-label={t('shell.settings.analytics')}
                  >
                    <SlidersHorizontal size={15} />
                  </button>
                )}
                {activeTab.key === 'data' && (
                  <button
                    type="button"
                    className="topbar-btn topbar-btn--icon"
                    onClick={() => setDataCustomizing(true)}
                    title={t('shell.settings.data')}
                    aria-label={t('shell.settings.data')}
                  >
                    <SlidersHorizontal size={15} />
                  </button>
                )}
                <LanguageDropdown />
                <ThemeDropdown theme={theme} onChange={setTheme} />
                {activeTab.key === 'access' && (
                  <button
                    type="button"
                    className="topbar-btn topbar-btn--icon"
                    onClick={async () => {
                      try {
                        await api.logout();
                      } catch {
                        /* cookie is cleared even if the body is empty */
                      }
                      window.location.assign('/');
                    }}
                    title={t('auth.signOut')}
                    aria-label={t('auth.signOutAria')}
                  >
                    <LogOut size={15} />
                  </button>
                )}
              </div>
            </header>
          </div>

          {activeTab.key === 'data' && (
            <Data
              isCustomizing={dataCustomizing}
              onCustomizingChange={setDataCustomizing}
            />
          )}
          {activeTab.key === 'pulse' && (
            <Pulse
              isCustomizing={pulseCustomizing}
              onCustomizingChange={setPulseCustomizing}
            />
          )}
          {activeTab.key === 'analytics' && (
            <Analytics
              isCustomizing={analyticsCustomizing}
              onCustomizingChange={setAnalyticsCustomizing}
            />
          )}
          {activeTab.key === 'access' && <McpAccess demoMode={demoMode} />}
        </div>
      </div>

      {/* Нижняя панель навигации (Bottom Navigation Bar) для Compact (< 600px) */}
      <nav className="bottom-nav" aria-label={t('shell.nav.mobile')}>
        {ALL_TABS.map((navTab) => {
          const Icon = navTab.icon;
          const isActive = tab === navTab.key;
          return (
            <button
              key={navTab.key}
              type="button"
              className={`bottom-nav-item ${isActive ? 'bottom-nav-item--active' : ''}`}
              onClick={() => goTo(navTab)}
              aria-current={isActive ? 'page' : undefined}
            >
              <div className="bottom-nav-icon-wrapper">
                <Icon size={20} />
              </div>
              <span className="bottom-nav-label">{t(navTab.titleKey)}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}


