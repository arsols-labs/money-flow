import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startAuthentication } from '@simplewebauthn/browser';
import { Fingerprint } from 'lucide-react';
import { api } from './api';
import { AuthScreen } from './components';
import { RegisterForm } from './PasskeySetup';

export default function Login({ hasPasskeys, onSuccess, demoMode = false }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The registration form starts open when no passkey exists yet.
  const [showRegister, setShowRegister] = useState(!hasPasskeys);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.loginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.loginVerify(response);
      onSuccess();
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen>
        <div className="eyebrow">{t('auth.eyebrow')}</div>
        <h1>{t('auth.loginTitle')}</h1>

        {hasPasskeys && (
          <>
            <button className="btn-passkey" onClick={login} disabled={busy}>
              <Fingerprint size={18} />
              {busy ? t('auth.signingIn') : t('auth.signInWithPasskey')}
            </button>
            {error && <div className="auth-error">{error}</div>}
          </>
        )}

        {demoMode ? (
          <p className="auth-hint">{t('auth.demoPasskeysDisabled')}</p>
        ) : showRegister ? (
          <>
            {!hasPasskeys && (
              <p className="auth-hint">
                {t('auth.noPasskeysHint')}
              </p>
            )}
            <RegisterForm onSuccess={onSuccess} />
          </>
        ) : (
          <button className="link-btn" onClick={() => setShowRegister(true)}>
            {t('auth.newDeviceRegister')}
          </button>
        )}
    </AuthScreen>
  );
}
