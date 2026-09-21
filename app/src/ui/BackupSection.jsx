// Резервное копирование на экране «Данные» (issue #515).
// Отдельного `#/settings` в v2 нет — секция живёт здесь, как остальные
// настройки данных. `#/settings` и `#/data/backup` только прокручивают сюда.
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Download, Upload, X } from 'lucide-react';
import { api } from './api';
import { useRefresh } from './RefreshContext';

function backupDownloadName(exportedAt) {
  const day = typeof exportedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(exportedAt)
    ? exportedAt.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return `money-flow-backup-${day}.json`;
}

function looksLikeBackup(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.format === 'money-flow-v2-backup'
    && value.tables
    && typeof value.tables === 'object',
  );
}

function RestoreConfirmModal({ filename, onClose, onConfirm, busy, error }) {
  const { t } = useTranslation();
  return (
    <div className="mcp-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-restore-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcp-modal-header">
          <div className="mcp-modal-title" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={16} />
            <span id="backup-restore-title">{t('data.backup.restoreTitle')}</span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </div>
        <div className="mcp-modal-body">
          <div className="notice-banner notice-banner--warning">
            <AlertCircle size={16} />
            <div>{t('data.backup.restoreWarning')}</div>
          </div>
          {filename && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '12px 0 0' }}>
              {filename}
            </p>
          )}
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
            disabled={busy}
          >
            {busy ? t('common.saving') : t('data.backup.confirmRestore')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BackupSection() {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const fileRef = useRef(null);
  const [downloading, setDownloading] = useState(false);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    if (hash === '#/settings' || hash === '#/data/backup') {
      document.getElementById('backup')?.scrollIntoView({ block: 'start' });
    }
  }, []);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    setMessage(null);
    try {
      const backup = await api.exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupDownloadName(backup.exported_at);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('data.backup.exportFailed'));
    } finally {
      setDownloading(false);
    }
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setMessage(null);
    try {
      const parsed = JSON.parse(await file.text());
      if (!looksLikeBackup(parsed)) {
        setError(t('data.backup.fileInvalid'));
        return;
      }
      setPending({ filename: file.name, backup: parsed });
    } catch {
      setError(t('data.backup.fileInvalid'));
    }
  };

  const handleRestore = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await api.importBackup(pending.backup);
      setPending(null);
      setMessage(t('data.backup.importOk'));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('data.backup.importFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-section backup-section" id="backup">
      <div className="data-section-header">
        <h2>{t('data.backup.title')}</h2>
      </div>
      <p className="data-hint">{t('data.backup.hint')}</p>
      <p className="data-hint backup-scope-note">{t('data.backup.scopeNote')}</p>
      <div className="backup-actions">
        <button type="button" className="btn-primary" onClick={handleDownload} disabled={downloading}>
          <Download size={14} />
          {downloading ? t('data.backup.downloading') : t('data.backup.download')}
        </button>
        <button type="button" className="btn-danger" onClick={() => fileRef.current?.click()}>
          <Upload size={14} />
          {t('data.backup.restore')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={handleFile}
        />
      </div>
      {message && <p className="backup-status" role="status">{message}</p>}
      {error && !pending && <p className="form-error" role="alert">{error}</p>}
      {pending && (
        <RestoreConfirmModal
          filename={pending.filename}
          onClose={() => { if (!busy) { setPending(null); setError(null); } }}
          onConfirm={handleRestore}
          busy={busy}
          error={error}
        />
      )}
    </section>
  );
}
