import React, { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import Login from './Login';
import PasskeySetup from './PasskeySetup';
import Shell from './Shell';
import DemoBanner from './DemoBanner';
import { RefreshProvider } from './RefreshContext';
import { resolveTheme } from './theme';

export default function App() {
  const isSetupRoute = window.location.pathname === '/setup/passkey';
  const [auth, setAuth] = useState({ state: 'checking', hasPasskeys: false });
  const [theme, setTheme] = useState(() => localStorage.getItem('mf_theme') || 'system');
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(theme));
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.publicConfig()
      .then((cfg) => {
        if (!cancelled) setDemoMode(Boolean(cfg && cfg.demoMode));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    localStorage.setItem('mf_theme', theme);
    const applyTheme = () => {
      const resolved = resolveTheme(theme);
      setResolvedTheme(resolved);
      document.documentElement.setAttribute('data-theme', resolved);
      document.getElementById('app-icon-svg')?.setAttribute('href', `/icons/icon-${resolved}.svg`);
      document.getElementById('app-icon-png')?.setAttribute('href', `/icons/icon-${resolved}-32.png`);
      document.getElementById('app-icon-apple')?.setAttribute('href', `/icons/apple-touch-${resolved}.png`);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content',
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    };
    applyTheme();
    if (theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = applyTheme;
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    }
  }, [theme]);

  const check = useCallback(async () => {
    try {
      const me = await api.me();
      setAuth({ state: me.authenticated ? 'authed' : 'anon', hasPasskeys: me.hasPasskeys });
    } catch {
      setAuth({ state: 'anon', hasPasskeys: false });
    }
  }, []);

  useEffect(() => {
    if (!isSetupRoute) check();
  }, [check, isSetupRoute]);

  if (isSetupRoute) {
    return (
      <div className="app">
        {demoMode && <DemoBanner />}
        <PasskeySetup demoMode={demoMode} />
      </div>
    );
  }

  return (
    <div className="app">
      {auth.state !== 'authed' && demoMode && <DemoBanner />}
      {auth.state === 'checking' && <div className="auth-screen" />}
      {auth.state === 'anon' && (
        <Login hasPasskeys={auth.hasPasskeys} onSuccess={check} demoMode={demoMode} />
      )}
      {auth.state === 'authed' && (
        <RefreshProvider>
          <Shell theme={theme} resolvedTheme={resolvedTheme} setTheme={setTheme} demoMode={demoMode} />
        </RefreshProvider>
      )}
    </div>
  );
}
