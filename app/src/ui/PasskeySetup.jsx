import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startRegistration } from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { api } from './api';
import { AuthScreen } from './components';
import { consumeSetupTokenFromSearch } from '../shared/setup-token-query';

function guessLabel(fallback) {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  return fallback;
}

/**
 * Bootstrap token may arrive in a URL fragment (`#token=`). Query `?token=` is
 * stripped and ignored so the reusable SETUP_TOKEN is not taken from the URL.
 */
export function consumeSetupTokenQuery() {
  if (typeof window === 'undefined') return { token: '', discardedQueryToken: false };
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const { token, nextUrl, discardedQueryToken } = consumeSetupTokenFromSearch(window.location.href);
  if (nextUrl !== current) {
    window.history.replaceState(null, '', nextUrl);
  }
  return { token, discardedQueryToken };
}

// Инлайн-форма регистрации passkey: используется и на экране логина,
// и на отдельной странице /setup/passkey. Токен — только из password-поля
// (или одноразово перенесён из фрагмента #token=).
export function RegisterForm({ initialToken = '', onSuccess }) {
  const { t } = useTranslation();
  const [token, setToken] = useState(initialToken);
  const [label, setLabel] = useState(() => guessLabel(t('access.passkeys.deviceFallback')));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.registerOptions(token);
      const response = await startRegistration({ optionsJSON: options });
      await api.registerVerify(token, response, label);
      onSuccess(label);
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        className="auth-input"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={t('auth.setupTokenPlaceholder')}
        autoComplete="off"
      />
      <input
        className="auth-input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('auth.deviceNamePlaceholder')}
      />
      <button className="btn-passkey" onClick={register} disabled={!token || busy}>
        <KeyRound size={18} />
        {busy ? t('auth.registering') : t('auth.registerThisDevice')}
      </button>
      {error && <div className="auth-error">{error}</div>}
    </>
  );
}

export default function PasskeySetup() {
  const { t } = useTranslation();
  const [fromQuery] = useState(() => {
    const { token, discardedQueryToken } = consumeSetupTokenQuery();
    return { token, migrated: Boolean(token), discardedQueryToken };
  });
  const [done, setDone] = useState(null);

  return (
    <AuthScreen>
        <div className="eyebrow">{t('auth.setupEyebrow')}</div>
        <h1>{t('auth.setupTitle')}</h1>
        {done ? (
          <>
            <p className="auth-hint">{t('auth.setupSuccess', { label: done })}</p>
            <a className="btn-passkey" href="/">{t('auth.openDashboard')}</a>
          </>
        ) : (
          <>
            {fromQuery.discardedQueryToken && (
              <p className="auth-hint">{t('auth.setupTokenQueryIgnored')}</p>
            )}
            {fromQuery.migrated && (
              <p className="auth-hint">{t('auth.setupTokenQueryRemoved')}</p>
            )}
            <RegisterForm initialToken={fromQuery.token} onSuccess={setDone} />
          </>
        )}
    </AuthScreen>
  );
}
