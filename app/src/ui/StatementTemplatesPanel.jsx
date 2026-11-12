import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';
import { api } from './api';
import { useRefreshNonce } from './RefreshContext';
import { BUILTIN_TEMPLATES } from '../shared/statement-import/templates';
import {
  inspectTemplateDocument,
  slugTemplateId,
  templateFileName,
  templateFromMapping,
} from './statementImportState';

function builtinRows() {
  return BUILTIN_TEMPLATES.map((document) => ({
    source: 'builtin',
    readonly: true,
    document,
    created_at: null,
    updated_at: null,
  }));
}

function errorText(err, fallback) {
  return err?.message || fallback;
}

function downloadTemplate(document) {
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = templateFileName(document.id);
  link.click();
  URL.revokeObjectURL(url);
}

export function StatementTemplatesPanel({
  showSave = false,
  mapping,
  options,
  onChanged,
}) {
  const { t } = useTranslation();
  const nonce = useRefreshNonce();
  const [templates, setTemplates] = useState(builtinRows);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [renameId, setRenameId] = useState(null);
  const [renameLabel, setRenameLabel] = useState('');
  const fileRef = useRef(null);

  const load = () => {
    api.listStatementTemplates().then((body) => {
      setTemplates(body.templates || []);
    }).catch((err) => {
      setError(errorText(err, t('data.statementImport.templatesLoadFailed')));
    });
  };

  useEffect(() => {
    load();
  }, [nonce]);

  const takenIds = () => templates.map((row) => row.document?.id).filter(Boolean);

  const afterWrite = async (text) => {
    setMessage(text);
    setError(null);
    load();
    if (onChanged) await onChanged();
  };

  const onSave = async () => {
    const label = name.trim();
    if (!label) {
      setError(t('data.statementImport.templateNameRequired'));
      return;
    }
    const id = slugTemplateId(label, takenIds());
    const document = templateFromMapping({ id, label, mapping, options });
    const inspected = inspectTemplateDocument(document);
    if (!inspected.ok) {
      setError(t('data.statementImport.templateSchemaErrors', { detail: inspected.detail }));
      return;
    }
    setBusy('save');
    setError(null);
    try {
      await api.createStatementTemplate(inspected.document);
      setName('');
      await afterWrite(t('data.statementImport.templateSaved', { label }));
    } catch (err) {
      setError(errorText(err, t('data.statementImport.templatesLoadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const onDuplicate = async (row) => {
    const label = `${row.document.label}`.trim();
    const copyLabel = `${label} copy`.slice(0, 120);
    const id = slugTemplateId(copyLabel, takenIds());
    const document = { ...JSON.parse(JSON.stringify(row.document)), id, label: copyLabel };
    const inspected = inspectTemplateDocument(document);
    if (!inspected.ok) {
      setError(t('data.statementImport.templateSchemaErrors', { detail: inspected.detail }));
      return;
    }
    setBusy(row.document.id);
    setError(null);
    try {
      await api.createStatementTemplate(inspected.document);
      await afterWrite(t('data.statementImport.templateSaved', { label: copyLabel }));
    } catch (err) {
      setError(errorText(err, t('data.statementImport.templatesLoadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const onRename = async (row) => {
    const label = renameLabel.trim();
    if (!label) {
      setError(t('data.statementImport.templateNameRequired'));
      return;
    }
    setBusy(row.document.id);
    setError(null);
    try {
      await api.updateStatementTemplate(row.document.id, { label });
      setRenameId(null);
      await afterWrite(t('data.statementImport.templateSaved', { label }));
    } catch (err) {
      setError(errorText(err, t('data.statementImport.templatesLoadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setBusy(pendingDelete.document.id);
    setError(null);
    try {
      await api.deleteStatementTemplate(pendingDelete.document.id);
      setPendingDelete(null);
      await afterWrite(null);
      setMessage(null);
    } catch (err) {
      setError(errorText(err, t('data.statementImport.templatesLoadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const onImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('import');
    setError(null);
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        setError(t('data.statementImport.templateJsonInvalid'));
        return;
      }
      const inspected = inspectTemplateDocument(parsed);
      if (!inspected.ok) {
        setError(t('data.statementImport.templateSchemaErrors', { detail: inspected.detail }));
        return;
      }
      await api.createStatementTemplate(inspected.document);
      await afterWrite(t('data.statementImport.templateSaved', { label: inspected.document.label }));
    } catch (err) {
      setError(errorText(err, t('data.statementImport.templatesLoadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const builtin = templates.filter((row) => row.source === 'builtin');
  const mine = templates.filter((row) => row.source === 'user');

  return (
    <div className="statement-templates">
      <h3>{t('data.statementImport.templatesTitle')}</h3>
      <p className="data-hint">{t('data.statementImport.templatesHint')}</p>
      {showSave && (
        <div className="statement-template-save">
          <label className="data-form-field">
            <span>{t('data.statementImport.templateSaveName')}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('data.statementImport.templateSaveNamePlaceholder')}
              maxLength={120}
              autoComplete="off"
            />
          </label>
          <button type="button" className="btn-secondary" onClick={onSave} disabled={Boolean(busy)}>
            {t('data.statementImport.templateSaveMapping')}
          </button>
        </div>
      )}
      <div className="backup-actions">
        <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
          {t('data.statementImport.templateImport')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label={t('data.statementImport.templateImport')}
          onChange={onImport}
        />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="data-hint" role="status">{message}</p>}
      <h3>{t('data.statementImport.templatesBuiltin')}</h3>
      <ul className="statement-template-list">
        {builtin.map((row) => (
          <TemplateRow
            key={row.document.id}
            row={row}
            busy={busy}
            renameId={renameId}
            renameLabel={renameLabel}
            onExport={() => downloadTemplate(row.document)}
            onDuplicate={() => onDuplicate(row)}
          />
        ))}
      </ul>
      <h3>{t('data.statementImport.templatesMine')}</h3>
      {mine.length === 0 ? (
        <p className="data-hint">{t('data.statementImport.templatesEmpty')}</p>
      ) : (
        <ul className="statement-template-list">
          {mine.map((row) => (
            <TemplateRow
              key={row.document.id}
              row={row}
              busy={busy}
              renameId={renameId}
              renameLabel={renameLabel}
              onRenameLabel={setRenameLabel}
              onStartRename={() => { setRenameId(row.document.id); setRenameLabel(row.document.label); }}
              onRename={() => onRename(row)}
              onCancelRename={() => setRenameId(null)}
              onExport={() => downloadTemplate(row.document)}
              onDelete={() => setPendingDelete(row)}
            />
          ))}
        </ul>
      )}
      {pendingDelete && (
        <div className="mcp-modal-backdrop" onClick={() => busy ? undefined : setPendingDelete(null)}>
          <div
            className="mcp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="statement-template-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mcp-modal-header">
              <div className="mcp-modal-title" style={{ color: 'var(--danger)' }}>
                <AlertTriangle size={16} />
                <span id="statement-template-delete-title">{t('data.statementImport.templateDeleteTitle')}</span>
              </div>
              <button type="button" className="mcp-modal-close" onClick={() => setPendingDelete(null)} aria-label={t('common.close')}>
                <X size={16} />
              </button>
            </div>
            <div className="mcp-modal-body">
              <p>{t('data.statementImport.templateDeleteWarning', { label: pendingDelete.document.label })}</p>
            </div>
            <div className="mcp-modal-actions">
              <button type="button" className="link-btn" onClick={() => setPendingDelete(null)} disabled={Boolean(busy)}>{t('common.cancel')}</button>
              <button type="button" className="btn-primary" onClick={onDelete} disabled={Boolean(busy)}>
                {t('data.statementImport.templateDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateRow({
  row,
  busy,
  renameId,
  renameLabel,
  onRenameLabel,
  onStartRename,
  onRename,
  onCancelRename,
  onExport,
  onDuplicate,
  onDelete,
}) {
  const { t } = useTranslation();
  const document = row.document;
  const renaming = renameId === document.id;
  const pdf = document.format === 'pdf';
  return (
    <li className="statement-template-row">
      <div>
        <strong>{document.label}</strong>
        <span className="statement-template-meta"> {document.id} · {document.format}</span>
        {row.readonly && <span className="statement-template-badge"> {t('data.statementImport.templateReadonly')}</span>}
        {pdf && <p className="data-hint">{t('data.statementImport.templatePdfLater')}</p>}
        {renaming && (
          <label className="data-form-field">
            <span>{t('data.statementImport.templateSaveName')}</span>
            <input value={renameLabel} onChange={(event) => onRenameLabel(event.target.value)} maxLength={120} />
          </label>
        )}
      </div>
      <div className="statement-template-actions">
        <button type="button" className="link-btn" onClick={onExport} disabled={Boolean(busy)}>
          {t('data.statementImport.templateExport')}
        </button>
        {row.readonly ? (
          <button type="button" className="link-btn" onClick={onDuplicate} disabled={Boolean(busy)}>
            {t('data.statementImport.templateDuplicate')}
          </button>
        ) : renaming ? (
          <>
            <button type="button" className="link-btn" onClick={onRename} disabled={Boolean(busy)}>
              {t('data.statementImport.templateRenameAction')}
            </button>
            <button type="button" className="link-btn" onClick={onCancelRename} disabled={Boolean(busy)}>
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="link-btn" onClick={onStartRename} disabled={Boolean(busy)}>
              {t('data.statementImport.templateRename')}
            </button>
            <button type="button" className="link-btn" onClick={onDelete} disabled={Boolean(busy)}>
              {t('common.delete')}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
