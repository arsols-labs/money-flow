// S2-2: Device and passkey management (issue #507)

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  KeyRound, Plus, Trash2, Edit2, CheckCircle2, AlertCircle,
  AlertTriangle, X, Shield,
} from 'lucide-react';
import { api } from './api';
import { CollapsibleSection } from './components';
import { intlLocale } from './language';

async function withStepUp(action) {
  try {
    return await action();
  } catch (err) {
    if (err?.code !== 'STEP_UP_REQUIRED') throw err;
    const options = await api.loginOptions();
    const response = await startAuthentication({ optionsJSON: options });
    await api.loginVerify(response);
    return action();
  }
}

function guessLabel(fallback) {
  if (typeof navigator === 'undefined') return fallback;
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return fallback;
}

function formatDateTime(iso, locale, emptyLabel) {
  if (!iso) return emptyLabel;
  const trimmed = String(iso).trim();
  const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(trimmed);
  const normalized = hasZone
    ? trimmed
    : trimmed.includes('T')
      ? `${trimmed}Z`
      : trimmed.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Belgrade',
  });
}

function AddPasskeyModal({ onClose, onCreated }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(() => guessLabel(t('access.passkeys.deviceFallback')));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await withStepUp(async () => {
        const options = await api.registerPasskeyOptions();
        const response = await startRegistration({ optionsJSON: options });
        await api.registerPasskeyVerify(response, label.trim());
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err?.message || t('access.passkeys.registerFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-modal-backdrop" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-header">
          <div className="mcp-modal-title">
            <KeyRound size={16} />
            <span>{t('access.passkeys.addTitle')}</span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mcp-modal-body">
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
              {t('access.passkeys.addDescription')}
            </p>

            <label className="data-form-field">
              <span>{t('access.passkeys.deviceName')}</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('access.passkeys.deviceNamePlaceholder')}
                disabled={busy}
                autoFocus
              />
            </label>

            {error && <div className="data-form-error">{error}</div>}
          </div>

          <div className="mcp-modal-footer">
            <button type="button" className="link-btn" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !label.trim()}>
              {busy ? t('access.passkeys.registering') : t('access.passkeys.register')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RenamePasskeyModal({ passkey, onClose, onRenamed }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(passkey?.label || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.updatePasskey(passkey.id, { label: label.trim() });
      onRenamed();
      onClose();
    } catch (err) {
      setError(err?.message || t('access.passkeys.renameFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-modal-backdrop" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-header">
          <div className="mcp-modal-title">
            <Edit2 size={16} />
            <span>{t('access.passkeys.renameTitle')}</span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mcp-modal-body">
            <label className="data-form-field">
              <span>{t('access.passkeys.newDeviceName')}</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('access.passkeys.deviceNamePlaceholder')}
                disabled={busy}
                autoFocus
              />
            </label>

            {error && <div className="data-form-error">{error}</div>}
          </div>

          <div className="mcp-modal-footer">
            <button type="button" className="link-btn" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !label.trim() || label.trim() === passkey.label}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ConfirmLastPasskeyModal({ passkey, action, onClose, onConfirm }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const isDelete = action === 'delete';

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-modal-backdrop" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-header">
          <div className="mcp-modal-title" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={16} />
            <span>{t('access.passkeys.lastActiveTitle')}</span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <div className="mcp-modal-body">
          <div className="notice-banner notice-banner--warning">
            <AlertCircle size={16} />
            <div>
              {isDelete
                ? t('access.passkeys.lastActiveBodyDelete', { label: passkey.label })
                : t('access.passkeys.lastActiveBodyDisable', { label: passkey.label })}
            </div>
          </div>

          <p style={{ fontSize: 13, color: 'var(--text)', margin: '12px 0 0', lineHeight: 1.5 }}>
            {t('access.passkeys.setupTokenRequired')}
          </p>
        </div>

        <div className="mcp-modal-footer">
          <button type="button" className="link-btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-danger-outline"
            style={{ background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy
              ? t('common.saving')
              : isDelete
                ? t('access.passkeys.confirmDelete')
                : t('access.passkeys.confirmDisable')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PasskeysSection({
  open,
  onToggle,
  refreshNonce,
  demoMode = false,
}) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const [passkeys, setPasskeys] = useState([]);
  const [total, setTotal] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [renamingPasskey, setRenamingPasskey] = useState(null);
  const [confirmLastTarget, setConfirmLastTarget] = useState(null); // { passkey, action: 'delete' | 'disable' }

  const loadPasskeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPasskeys();
      setPasskeys(res.passkeys || []);
      setTotal(res.total ?? (res.passkeys || []).length);
      setActiveCount(res.active_count ?? (res.passkeys || []).filter((p) => !p.disabled).length);
    } catch (err) {
      setError(err?.message || t('access.passkeys.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadPasskeys();
  }, [loadPasskeys, refreshNonce]);

  const isOnlyActive = (passkey) => {
    if (passkey.disabled) return false;
    return activeCount === 1;
  };

  const handleToggleDisabled = async (passkey) => {
    const nextDisabled = !passkey.disabled;
    if (nextDisabled && isOnlyActive(passkey)) {
      setConfirmLastTarget({ passkey, action: 'disable' });
      return;
    }

    setBusyId(passkey.id);
    try {
      await withStepUp(() => api.updatePasskey(passkey.id, { disabled: nextDisabled }));
      await loadPasskeys();
    } catch (err) {
      alert(`${t('common.actionFailed')}: ${err?.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (passkey) => {
    if (isOnlyActive(passkey)) {
      setConfirmLastTarget({ passkey, action: 'delete' });
      return;
    }

    if (!window.confirm(t('access.passkeys.deleteConfirm', { label: passkey.label }))) {
      return;
    }

    setBusyId(passkey.id);
    try {
      await withStepUp(() => api.deletePasskey(passkey.id));
      await loadPasskeys();
    } catch (err) {
      alert(`${t('common.actionFailed')}: ${err?.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmLastAction = async () => {
    if (!confirmLastTarget) return;
    const { passkey, action } = confirmLastTarget;
    setBusyId(passkey.id);
    try {
      await withStepUp(async () => {
        if (action === 'delete') {
          await api.deletePasskey(passkey.id, { confirm_last: true });
        } else {
          await api.updatePasskey(passkey.id, { disabled: true, confirm_last: true });
        }
      });
      await loadPasskeys();
    } catch (err) {
      alert(`${t('common.actionFailed')}: ${err?.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const addAction = demoMode ? null : (
    <button
      type="button"
      className="topbar-btn topbar-btn--primary"
      onClick={(e) => {
        e.stopPropagation();
        setShowAddModal(true);
      }}
      disabled={total >= 10}
      title={total >= 10 ? t('access.passkeys.limitReached') : t('access.passkeys.addThisDevice')}
    >
      <Plus size={14} />
      <span>{t('access.passkeys.add')}</span>
    </button>
  );

  return (
    <>
      {showAddModal && (
        <AddPasskeyModal
          onClose={() => setShowAddModal(false)}
          onCreated={loadPasskeys}
        />
      )}

      {renamingPasskey && (
        <RenamePasskeyModal
          passkey={renamingPasskey}
          onClose={() => setRenamingPasskey(null)}
          onRenamed={loadPasskeys}
        />
      )}

      {confirmLastTarget && (
        <ConfirmLastPasskeyModal
          passkey={confirmLastTarget.passkey}
          action={confirmLastTarget.action}
          onClose={() => setConfirmLastTarget(null)}
          onConfirm={handleConfirmLastAction}
        />
      )}

      <CollapsibleSection
        title={t('access.passkeys.sectionTitle')}
        subtitle={String(total)}
        open={open}
        onToggle={onToggle}
        actions={addAction}
        collapsedActions={addAction}
      >
        {error && (
          <div className="notice-banner notice-banner--danger" style={{ marginBottom: 12 }}>
            <AlertCircle size={16} />
            <div>{error}</div>
          </div>
        )}

        {loading && !passkeys.length ? (
          <div className="loading-state">{t('access.passkeys.loading')}</div>
        ) : passkeys.length === 0 ? (
          <div className="empty-state">
            <KeyRound size={32} style={{ opacity: 0.4, marginBottom: 8 }} />
            <div>{t('access.passkeys.empty')}</div>
            <div className="empty-state-sub">
              {demoMode ? t('auth.demoPasskeysDisabled') : t('access.passkeys.emptyHint')}
            </div>
            {!demoMode && <button
              type="button"
              className="topbar-btn topbar-btn--primary"
              style={{ marginTop: 12 }}
              onClick={() => setShowAddModal(true)}
            >
              <Plus size={14} />
              <span>{t('access.passkeys.addPasskey')}</span>
            </button>}
          </div>
        ) : (
          <div className="passkeys-list">
            {passkeys.map((pk) => {
              const onlyActive = isOnlyActive(pk);
              const isBusy = busyId === pk.id;
              return (
                <div
                  key={pk.id}
                  className={`passkey-card ${pk.disabled ? 'passkey-card--disabled' : ''}`}
                >
                  <div className="passkey-header">
                    <div className="passkey-title-group">
                      <div className="passkey-icon-wrapper">
                        <KeyRound size={16} />
                      </div>
                      <div className="passkey-name" title={pk.label}>
                        {pk.label}
                      </div>
                      <span
                        className={`passkey-status-badge ${
                          pk.disabled
                            ? 'passkey-status-badge--disabled'
                            : 'passkey-status-badge--active'
                        }`}
                      >
                        {pk.disabled ? (
                          <>
                            <AlertCircle size={11} />
                            <span>{t('access.passkeys.disabled')}</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle2 size={11} />
                            <span>{t('access.passkeys.active')}</span>
                          </>
                        )}
                      </span>
                    </div>

                    <div className="passkey-actions">
                      <button
                        type="button"
                        className="link-btn passkey-action-btn"
                        onClick={() => setRenamingPasskey(pk)}
                        disabled={isBusy}
                        title={t('access.passkeys.renameTitle')}
                      >
                        <Edit2 size={13} />
                        <span>{t('access.passkeys.rename')}</span>
                      </button>

                      <button
                        type="button"
                        className={`passkey-toggle-btn ${
                          pk.disabled ? 'passkey-toggle-btn--enable' : ''
                        }`}
                        onClick={() => handleToggleDisabled(pk)}
                        disabled={isBusy}
                        title={
                          onlyActive
                            ? t('access.passkeys.onlyActiveHint')
                            : pk.disabled
                            ? t('access.passkeys.enable')
                            : t('access.passkeys.disable')
                        }
                      >
                        <span>{pk.disabled ? t('access.passkeys.enable') : t('access.passkeys.disable')}</span>
                      </button>

                      <button
                        type="button"
                        className="btn-danger-outline passkey-delete-btn"
                        onClick={() => handleDelete(pk)}
                        disabled={isBusy}
                        title={
                          onlyActive
                            ? t('access.passkeys.onlyActiveHint')
                            : t('access.passkeys.deleteTitle')
                        }
                      >
                        <Trash2 size={13} />
                        <span>{t('common.delete')}</span>
                      </button>
                    </div>
                  </div>

                  <div className="passkey-meta-grid">
                    <div>
                      <span className="meta-label">{t('access.passkeys.added')}</span>
                      <span className="meta-value">{formatDateTime(pk.created_at, locale, t('access.passkeys.neverUsed'))}</span>
                    </div>
                    <div>
                      <span className="meta-label">{t('access.passkeys.lastSignIn')}</span>
                      <span className="meta-value">{formatDateTime(pk.last_used_at, locale, t('access.passkeys.neverUsed'))}</span>
                    </div>
                    <div>
                      <span className="meta-label">{t('access.passkeys.keyId')}</span>
                      <span className="meta-value" title={pk.id}>
                        {pk.id ? `${pk.id.slice(0, 14)}…` : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>
    </>
  );
}
