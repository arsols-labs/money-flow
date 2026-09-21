// Reset / start-from-scratch on the Data screen (issue #579).
// Lives next to Backup; `#/data/reset` only scrolls here.
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, RotateCcw, X } from 'lucide-react';
import { api } from './api';
import { useRefresh } from './RefreshContext';

export const RESET_CONFIRM_PHRASE = 'RESET';

function ResetConfirmModal({ phrase, onPhraseChange, onClose, onConfirm, busy, error }) {
  const { t } = useTranslation();
  const ready = phrase === RESET_CONFIRM_PHRASE;
  return (
    <div className="mcp-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-reset-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcp-modal-header">
          <div className="mcp-modal-title" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={16} />
            <span id="data-reset-title">{t('data.reset.confirmTitle')}</span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </div>
        <div className="mcp-modal-body">
          <div className="notice-banner notice-banner--warning">
            <AlertCircle size={16} />
            <div>{t('data.reset.confirmWarning')}</div>
          </div>
          <label className="data-form-field" style={{ marginTop: 12 }}>
            <span>{t('data.reset.typePhrase', { phrase: RESET_CONFIRM_PHRASE })}</span>
            <input
              value={phrase}
              onChange={(e) => onPhraseChange(e.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-label={t('data.reset.typePhrase', { phrase: RESET_CONFIRM_PHRASE })}
            />
          </label>
          {error && (
            <p className="form-error" role="alert" style={{ marginTop: 12 }}>{error}</p>
          )}
        </div>
        <div className="mcp-modal-footer">
          <button type="button" className="link-btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-danger-outline"
            style={{ background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
            onClick={onConfirm}
            disabled={busy || !ready}
          >
            {busy ? t('common.saving') : t('data.reset.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ResetSection() {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    if (hash === '#/data/reset') {
      document.getElementById('reset')?.scrollIntoView({ block: 'start' });
    }
  }, []);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setPhrase('');
    setError(null);
  };

  const handleReset = async () => {
    if (phrase !== RESET_CONFIRM_PHRASE) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetData();
      setOpen(false);
      setPhrase('');
      setMessage(t('data.reset.ok'));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('data.reset.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-section backup-section" id="reset">
      <div className="data-section-header">
        <h2>{t('data.reset.title')}</h2>
      </div>
      <p className="data-hint">{t('data.reset.hint')}</p>
      <p className="data-hint backup-scope-note">{t('data.reset.scopeNote')}</p>
      <div className="backup-actions">
        <button
          type="button"
          className="btn-danger"
          onClick={() => { setOpen(true); setMessage(null); setError(null); }}
        >
          <RotateCcw size={14} />
          {t('data.reset.action')}
        </button>
      </div>
      {message && <p className="backup-status" role="status">{message}</p>}
      {error && !open && <p className="form-error" role="alert">{error}</p>}
      {open && (
        <ResetConfirmModal
          phrase={phrase}
          onPhraseChange={setPhrase}
          onClose={close}
          onConfirm={handleReset}
          busy={busy}
          error={error}
        />
      )}
    </section>
  );
}
