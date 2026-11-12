// Statement import on the Data screen, next to Backup.
// Preview is read-only. Commit and undo go through the PR1 statement-import API.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Upload, X } from 'lucide-react';
import { CLOSING_BALANCE_MISMATCH_WARNING } from '../shared/statement-import/types';
import { api } from './api';
import { formatMinor } from './money';
import { useRefresh, useRefreshNonce } from './RefreshContext';
import CategoryRulesEditor, { CategoryTextField } from './CategoryRulesEditor';
import { StatementTemplatesPanel } from './StatementTemplatesPanel';
import {
  IMPORT_UNDO_PHRASE,
  PRESET_AUTO,
  PRESET_GENERIC,
  DEFAULT_MAPPING,
  DEFAULT_OPTIONS,
  buildCommitPayload,
  buildPreviewRequest,
  bytesToBase64,
  canCommit,
  categoryCatalog,
  commitBlockers,
  createIdempotencyKey,
  describeImportBatch,
  describeStatementRows,
  duplicateReasonKey,
  existingExpenseDuplicateRows,
  encodedBodyBytes,
  fileAdmissionError,
  formatByteCount,
  idempotencyForPayload,
  interpretCommit,
  limitScopeKey,
  mappingReady,
  matchLabelKey,
  previewFailureDetail,
  preselectDateFormat,
  base64ToText,
  previewRequestProblems,
  rowsFromPreview,
  statementGroups,
  summarizeCommit,
  summarizeRemoval,
  undoPhraseMatches,
  usesGenericMapping,
  withCategory,
  withInclude,
  withStatementAccount,
} from './statementImportState';
import {
  STATEMENT_IMPORT_MAX_BODY_BYTES,
  STATEMENT_IMPORT_MAX_FILE_BYTES,
  STATEMENT_IMPORT_MAX_FILES,
  STATEMENT_IMPORT_MAX_ROWS,
} from '../shared/statement-import/types';

const FALLBACK_LIMITS = {
  max_body_bytes: STATEMENT_IMPORT_MAX_BODY_BYTES,
  max_file_bytes: STATEMENT_IMPORT_MAX_FILE_BYTES,
  max_files: STATEMENT_IMPORT_MAX_FILES,
  max_rows: STATEMENT_IMPORT_MAX_ROWS,
};

const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD'];

function errorText(err, fallback) {
  return err instanceof Error && err.message ? err.message : fallback;
}

function formatWhen(iso, language) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return iso;
  }
}

function parserWarningText(warning, t) {
  if (warning === CLOSING_BALANCE_MISMATCH_WARNING) return t('data.statementImport.closingBalanceMismatch');
  return t('data.statementImport.parserNote', { detail: warning });
}

function PresetChoices({ presets }) {
  const { t } = useTranslation();
  const mine = presets.filter((preset) => preset.source === 'user');
  const builtin = presets.filter((preset) => preset.source !== 'user');
  const option = (preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>;
  return (
    <>
      <option value={PRESET_AUTO}>{t('data.statementImport.presetAuto')}</option>
      <option value={PRESET_GENERIC}>{t('data.statementImport.presetGeneric')}</option>
      {mine.length > 0 ? (
        <>
          <optgroup label={t('data.statementImport.templatesBuiltin')}>{builtin.map(option)}</optgroup>
          <optgroup label={t('data.statementImport.templatesMine')}>{mine.map(option)}</optgroup>
        </>
      ) : builtin.map(option)}
    </>
  );
}

function presetLabel(presetId, presets, t) {
  if (!presetId || presetId === PRESET_AUTO) return t('data.statementImport.presetAuto');
  if (presetId === PRESET_GENERIC) return t('data.statementImport.presetGeneric');
  return presets.find((preset) => preset.id === presetId)?.label || presetId;
}

function BatchDetails({ detail, presets, language }) {
  const { t } = useTranslation();
  const described = describeImportBatch(detail);
  const fileNames = described.files.map((file) => file.filename).filter(Boolean);
  const presetNames = [...new Set(described.files.map((file) => presetLabel(file.preset_id, presets, t)))];
  const accountNames = described.accounts.map((account) => account.name).filter(Boolean);
  const byCurrency = new Map();
  for (const total of described.totals) {
    const bucket = byCurrency.get(total.currency) ?? { currency: total.currency, expense: 0, income: 0 };
    if (total.kind === 'income') bucket.income += total.amountMinor;
    else bucket.expense += total.amountMinor;
    byCurrency.set(total.currency, bucket);
  }
  const undoStatus = detail.batch?.status === 'undone'
    ? t('data.statementImport.detailUndoUndone', { date: formatWhen(detail.batch?.undone_at, language) })
    : t('data.statementImport.detailUndoNotUndone');
  return (
    <div className="statement-batch-detail">
      <p className="statement-batch-line">{t('data.statementImport.detailUndoLine', { status: undoStatus })}</p>
      {[...byCurrency.values()].map((bucket) => (
        <p key={bucket.currency || 'none'} className="statement-batch-line">
          {t('data.statementImport.detailCurrencyLine', {
            currency: bucket.currency || t('common.emptyDash'),
            expenses: bucket.currency ? formatMinor(bucket.expense, bucket.currency) : String(bucket.expense),
            income: bucket.currency ? formatMinor(bucket.income, bucket.currency) : String(bucket.income),
          })}
        </p>
      ))}
      {fileNames.length > 0 ? (
        <p className="data-hint">{fileNames.join(', ')}</p>
      ) : (
        <p className="data-hint">{t('data.statementImport.detailFilesMissing')}</p>
      )}
      {presetNames.length > 0 && (
        <p className="data-hint">{t('data.statementImport.detailPreset', { preset: presetNames.join(', ') })}</p>
      )}
      {accountNames.length > 0 && (
        <p className="data-hint">{t('data.statementImport.detailAccount', { account: accountNames.join(', ') })}</p>
      )}
      {described.from && (
        <p className="data-hint">
          {described.from === described.to
            ? described.from
            : t('data.statementImport.detailRange', { from: described.from, to: described.to })}
        </p>
      )}
      {described.totals.length > 0 && (
        <>
          <h3>{t('data.statementImport.detailTotals')}</h3>
          <ul className="statement-summary">
            {described.totals.map((total) => (
              <li key={`${total.currency}:${total.kind}`}>
                {t(total.kind === 'income' ? 'data.statementImport.detailKindIncome' : 'data.statementImport.detailKindExpense', {
                  amount: total.currency ? formatMinor(total.amountMinor, total.currency) : String(total.amountMinor),
                })}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>{t('data.statementImport.detailOperations')}</h3>
      {described.emptyReason === 'undone' && (
        <p className="data-hint">{t('data.statementImport.detailNoOperationsUndone', {
          date: formatWhen(detail.batch?.undone_at, language),
        })}</p>
      )}
      {described.emptyReason === 'unlinked' && (
        <p className="data-hint">{t('data.statementImport.detailNoOperationsUnlinked', {
          count: detail.batch?.row_count ?? 0,
          unit: t('plural.row', { count: detail.batch?.row_count ?? 0 }),
        })}</p>
      )}
      {described.emptyReason === 'empty' && (
        <p className="data-hint">{t('data.statementImport.detailNoOperations')}</p>
      )}
      {described.operations.length > 0 && (
        <div className="statement-import-scroll">
          <table className="statement-import-table">
            <thead>
              <tr>
                <th>{t('data.statementImport.colDate')}</th>
                <th>{t('data.statementImport.colDescription')}</th>
                <th>{t('data.statementImport.colAmount')}</th>
                <th>{t('data.statementImport.colCurrency')}</th>
                <th>{t('data.statementImport.colCategory')}</th>
              </tr>
            </thead>
            <tbody>
              {described.operations.map((operation) => (
                <tr key={operation.id}>
                  <td>{operation.date}</td>
                  <td>{operation.description}</td>
                  <td>{operation.currency ? formatMinor(operation.amount_minor, operation.currency) : operation.amount_minor}</td>
                  <td>{operation.currency || t('common.emptyDash')}</td>
                  <td>{operation.category || t('data.statementImport.noCategory')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function optionsWithCurrent(options, current) {
  if (current && !options.includes(current)) return [current, ...options];
  return options;
}

function LimitAlert({ error }) {
  const { t } = useTranslation();
  if (!error) return null;
  if (error.code === 'unsupported') {
    return <p className="form-error" role="alert">{t('data.statementImport.unsupportedFile', { name: error.name })}</p>;
  }
  if (error.code === 'IMPORT_TOO_LARGE') {
    const scopeKey = limitScopeKey(error.scope);
    const scope = scopeKey ? t(scopeKey) : error.scope;
    const limit = error.scope === 'files' || error.scope === 'rows' ? error.limit : formatByteCount(error.limit);
    return (
      <p className="form-error" role="alert">
        {error.name ? `${error.name}: ` : ''}
        {t('errors.IMPORT_TOO_LARGE', { scope, limit })}
      </p>
    );
  }
  if (error.message) return <p className="form-error" role="alert">{error.message}</p>;
  return null;
}

function MappingFields({ mapping, setMapping, options, setOptions }) {
  const { t } = useTranslation();
  const setMap = (key) => (event) => setMapping({ ...mapping, [key]: event.target.value });
  const fields = [
    ['date', 'fieldDate'],
    ['amount', 'fieldAmount'],
    ['debit', 'fieldDebit'],
    ['credit', 'fieldCredit'],
    ['currency', 'fieldCurrency'],
    ['description', 'fieldDescription'],
    ['merchant', 'fieldMerchant'],
    ['counterparty', 'fieldCounterparty'],
    ['reference', 'fieldReference'],
    ['balance', 'fieldBalance'],
  ];
  return (
    <div className="statement-mapping">
      <h3>{t('data.statementImport.mappingTitle')}</h3>
      <p className="data-hint">{t('data.statementImport.mappingHint')}</p>
      <div className="statement-mapping-grid">
        {fields.map(([key, label]) => (
          <label key={key} className="data-form-field">
            <span>{t(`data.statementImport.${label}`)}</span>
            <input value={mapping[key]} onChange={setMap(key)} autoComplete="off" />
          </label>
        ))}
        <label className="data-form-field">
          <span>{t('data.statementImport.delimiter')}</span>
          <select value={options.delimiter} onChange={(event) => setOptions({ ...options, delimiter: event.target.value })}>
            <option value=",">{t('data.statementImport.delimiterComma')}</option>
            <option value=";">{t('data.statementImport.delimiterSemicolon')}</option>
            <option value={"\t"}>{t('data.statementImport.delimiterTab')}</option>
            <option value="|">{t('data.statementImport.delimiterPipe')}</option>
          </select>
        </label>
        <label className="data-form-field">
          <span>{t('data.statementImport.decimal')}</span>
          <select value={options.decimalSeparator} onChange={(event) => setOptions({ ...options, decimalSeparator: event.target.value })}>
            <option value=".">.</option>
            <option value=",">,</option>
          </select>
        </label>
        <label className="data-form-field">
          <span>{t('data.statementImport.dateFormat')}</span>
          <select value={options.dateFormat} onChange={(event) => setOptions({ ...options, dateFormat: event.target.value })}>
            {DATE_FORMATS.map((format) => <option key={format} value={format}>{format}</option>)}
          </select>
        </label>
        <label className="data-form-field">
          <span>{t('data.statementImport.encoding')}</span>
          <select value={options.encoding} onChange={(event) => setOptions({ ...options, encoding: event.target.value })}>
            <option value="utf-8">UTF-8</option>
            <option value="windows-1252">Windows-1252</option>
            <option value="iso-8859-1">ISO-8859-1</option>
          </select>
        </label>
        <label className="data-form-field">
          <span>{t('data.statementImport.defaultCurrency')}</span>
          <input
            value={options.defaultCurrency}
            onChange={(event) => setOptions({ ...options, defaultCurrency: event.target.value })}
            autoComplete="off"
            maxLength={3}
          />
        </label>
        <label className="data-form-field">
          <span>{t('data.statementImport.skipRows')}</span>
          <input
            type="number"
            min="0"
            max="50"
            value={options.skipRows ?? 0}
            onChange={(event) => setOptions({ ...options, skipRows: Number(event.target.value) })}
          />
        </label>
        <label className="statement-check">
          <input
            type="checkbox"
            checked={options.headerSearch !== false}
            onChange={(event) => setOptions({ ...options, headerSearch: event.target.checked })}
          />
          <span>{t('data.statementImport.headerSearch')}</span>
        </label>
        <label className="statement-check">
          <input
            type="checkbox"
            checked={options.hasHeader}
            onChange={(event) => setOptions({ ...options, hasHeader: event.target.checked })}
          />
          <span>{t('data.statementImport.hasHeader')}</span>
        </label>
      </div>
    </div>
  );
}

function PreviewTable({ group, rows, accounts, catalog, onAccount, onInclude, onCategory }) {
  const { t, i18n } = useTranslation();
  const account = accounts.find((item) => item.id === group.accountId);
  const matchKey = matchLabelKey(group.match);
  return (
    <div className="statement-file">
      <h3>{group.filename}</h3>
      <p className="data-hint">
        {group.accountId
          ? t('data.statementImport.accountMatched', { via: matchKey ? t(matchKey) : t('data.statementImport.match.explicit') })
          : (group.accountRef
            ? t('data.statementImport.accountUnmatched', { ref: group.accountRef })
            : t('data.statementImport.accountNone'))}
        {group.rows.every((row) => row.currencyFromAccount) && group.rows[0]?.currency
          ? ` · ${t('data.statementImport.currencyFromAccount', { currency: group.rows[0].currency })}`
          : (group.statementCurrency ? ` · ${t('data.statementImport.statementCurrency', { currency: group.statementCurrency })}` : '')}
      </p>
      <label className="data-form-field">
        <span>{t('data.statementImport.accountPick')}</span>
        <select
          value={group.accountId || ''}
          onChange={(event) => onAccount(group.key, event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">{t('data.statementImport.accountNone')}</option>
          {accounts.map((item) => (
            <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>
          ))}
        </select>
      </label>
      {account && group.rows.some((row) => row.currencyMismatch) && (
        <p className="form-error" role="alert">
          {t('data.statementImport.currencyMismatch', {
            row: group.rows.find((row) => row.currencyMismatch)?.currency || '',
            account: account.currency,
          })}
        </p>
      )}
      {[...group.fileWarnings, ...group.statementWarnings].map((warning) => (
        <p key={warning} className="data-hint">{parserWarningText(warning, t)}</p>
      ))}
      <div className="statement-import-scroll" tabIndex={0} role="region" aria-label={t('data.statementImport.previewRegion', { name: group.filename })}>
        <table className="statement-import-table">
          <thead>
            <tr>
              <th scope="col">{t('data.statementImport.colInclude')}</th>
              <th scope="col">{t('data.statementImport.colDate')}</th>
              <th scope="col">{t('data.statementImport.colDescription')}</th>
              <th scope="col">{t('data.statementImport.colAmount')}</th>
              <th scope="col">{t('data.statementImport.colCategory')}</th>
              <th scope="col">{t('data.statementImport.colSubcategory')}</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => {
              const reasonKey = duplicateReasonKey(row.duplicateReason);
              const categories = optionsWithCurrent(catalog.categories, row.category);
              const subs = optionsWithCurrent(catalog.byCategory[row.category] || [], row.subcategory);
              return (
                <tr key={row.key} data-included={row.include ? 'yes' : 'no'} data-duplicate={row.duplicate ? 'yes' : 'no'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.include}
                      aria-label={t('data.statementImport.includeRow', { date: row.date, description: row.description })}
                      onChange={(event) => onInclude(row.key, event.target.checked)}
                    />
                  </td>
                  <td>{row.date}</td>
                  <td>
                    <div>{row.description}</div>
                    {row.duplicate && (
                      <p className="statement-flag">
                        {t('data.statementImport.duplicate')}
                        {reasonKey ? ` · ${t(reasonKey)}` : ''}
                        {row.duplicateBatchId ? ` · ${t('data.statementImport.duplicateOfBatch', {
                          id: row.duplicateBatchId,
                          when: formatWhen(row.duplicateBatchCreatedAt, i18n.language),
                          files: row.duplicateBatchFiles?.length ? ` · ${row.duplicateBatchFiles.join(', ')}` : '',
                        })}` : ''}
                        {row.duplicateInBatch ? ` · ${t('data.statementImport.duplicateInBatch')}` : ''}
                      </p>
                    )}
                    {row.include && row.duplicateReason === 'expense_duplicate' && !row.duplicateInBatch && (
                      <p className="statement-flag" role="status">{t('data.statementImport.duplicateExpenseIncluded')}</p>
                    )}
                    {row.ownTransfer && <p className="statement-flag">{t('data.statementImport.ownTransfer')}</p>}
                    {row.currencyMismatch && (
                      <p className="statement-flag">
                        {t('data.statementImport.currencyMismatch', { row: row.currency, account: row.accountCurrency || '' })}
                      </p>
                    )}
                    {row.warnings.map((warning) => (
                      <p key={warning} className="statement-flag">{parserWarningText(warning, t)}</p>
                    ))}
                  </td>
                  <td>
                    <span className={`data-amount data-amount--${row.kind === 'income' ? 'income' : 'expense'}`}>
                      {formatMinor(row.amountMinor, row.currency)}
                    </span>
                  </td>
                  <td>
                    <CategoryTextField
                      label={t('data.statementImport.colCategory')}
                      value={row.category}
                      options={categories}
                      listId={`category-${row.key}`}
                      placeholder={t('data.statementImport.newCategory')}
                      onChange={(category) => onCategory(row.key, { category })}
                    />
                  </td>
                  <td>
                    <CategoryTextField
                      label={t('data.statementImport.colSubcategory')}
                      value={row.subcategory}
                      options={subs}
                      listId={`subcategory-${row.key}`}
                      placeholder={t('data.statementImport.newSubcategory')}
                      disabled={!String(row.category || '').trim()}
                      onChange={(subcategory) => onCategory(row.key, { subcategory })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function useDismissOnEscape(enabled, onClose) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, onClose]);
}

function ConfirmModal({ summary, idempotencyKey, expenseDuplicates = [], busy, error, result, onClose, onConfirm }) {
  const { t } = useTranslation();
  const duplicateRows = describeStatementRows(expenseDuplicates);
  const done = Boolean(result);
  useDismissOnEscape(!busy, onClose);
  return (
    <div className="mcp-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="statement-import-confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="mcp-modal-header">
          <div className="mcp-modal-title">
            <AlertTriangle size={16} />
            <span id="statement-import-confirm-title">
              {done ? t('data.statementImport.resultTitle') : t('data.statementImport.confirmTitle')}
            </span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <div className="mcp-modal-body">
          {done ? (
            <ul className="statement-summary" role="status">
              {result.kind === 'replay' && (
                <li>{t('data.statementImport.replay', { id: result.batchId })}</li>
              )}
              <li>{t('data.statementImport.resultImported', {
                count: result.inserted,
                unit: t('plural.row', { count: result.inserted }),
              })}</li>
              <li>{t('data.statementImport.resultSkipped', {
                count: result.skipped,
                unit: t('plural.row', { count: result.skipped }),
              })}</li>
              <li>{t('data.statementImport.resultErrors', { count: result.errors })}</li>
            </ul>
          ) : (
            <>
              <div className="notice-banner notice-banner--warning">
                <AlertCircle size={16} />
                <div>{t('data.statementImport.confirmHint')}</div>
              </div>
              {expenseDuplicates.length > 0 && (
                <p className="form-error" role="alert">
                  {t('data.statementImport.duplicateExpenseBeforeCommit', {
                    count: expenseDuplicates.length,
                    unit: t('plural.row', { count: expenseDuplicates.length }),
                    rows: duplicateRows,
                  })}
                </p>
              )}
              <ul className="statement-summary">
                {summary.groups.map((group) => (
                  <li key={`${group.accountId}:${group.currency}`}>
                    {t('data.statementImport.summaryLine', {
                      account: group.accountName || group.currency,
                      count: group.count,
                      unit: t('plural.row', { count: group.count }),
                      amount: formatMinor(group.amountMinor, group.currency),
                    })}
                  </li>
                ))}
              </ul>
              <p className="data-hint">{idempotencyKey}</p>
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="mcp-modal-footer">
          {done ? (
            <button type="button" className="btn-primary" onClick={onClose}>{t('common.done')}</button>
          ) : (
            <>
              <button type="button" className="link-btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
              <button type="button" className="btn-primary" onClick={onConfirm} disabled={busy}>
                {busy ? t('data.statementImport.confirming') : t('data.statementImport.confirmAction')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UndoModal({ batch, removal, phrase, onPhrase, busy, error, result, onClose, onConfirm }) {
  const { t } = useTranslation();
  const ready = undoPhraseMatches(phrase);
  const done = Boolean(result);
  useDismissOnEscape(!busy, onClose);
  return (
    <div className="mcp-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="statement-import-undo-title" onClick={(event) => event.stopPropagation()}>
        <div className="mcp-modal-header">
          <div className="mcp-modal-title" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={16} />
            <span id="statement-import-undo-title">
              {done
                ? t('data.statementImport.undoResultTitle')
                : t('data.statementImport.undoTitle', { id: batch.id })}
            </span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <div className="mcp-modal-body">
          {done ? (
            <ul className="statement-summary" role="status">
              <li>{t('data.statementImport.undoResultRemoved', {
                count: result.removed,
                unit: t('plural.row', { count: result.removed }),
              })}</li>
            </ul>
          ) : (
            <>
              <div className="notice-banner notice-banner--warning">
                <AlertCircle size={16} />
                <div>{t('data.statementImport.undoWarning')}</div>
              </div>
              <h3>{t('data.statementImport.undoWillRemove')}</h3>
              {removal == null ? null : removal.count === 0 ? (
                <p className="data-hint">{t('data.statementImport.undoEmpty')}</p>
              ) : (
                <ul className="statement-summary">
                  {removal.groups.map((group) => (
                    <li key={`${group.accountId}:${group.currency}`}>
                      {t('data.statementImport.undoLine', {
                        account: group.accountName || String(group.accountId),
                        count: group.count,
                        amount: group.currency ? formatMinor(group.amountMinor, group.currency) : String(group.amountMinor),
                      })}
                    </li>
                  ))}
                </ul>
              )}
              <label className="data-form-field">
                <span>{t('data.statementImport.undoPhrase', { phrase: IMPORT_UNDO_PHRASE })}</span>
                <input
                  value={phrase}
                  onChange={(event) => onPhrase(event.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  aria-label={t('data.statementImport.undoPhrase', { phrase: IMPORT_UNDO_PHRASE })}
                />
              </label>
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="mcp-modal-footer">
          {done ? (
            <button type="button" className="btn-primary" onClick={onClose}>{t('common.done')}</button>
          ) : (
            <>
              <button type="button" className="link-btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
              <button type="button" className="btn-danger" onClick={onConfirm} disabled={busy || !ready || removal == null}>
                {busy ? t('data.statementImport.undoing') : t('data.statementImport.undoAction')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function StatementImportView({
  limits,
  presets,
  presetId,
  onPreset,
  categoryMode,
  onCategoryMode,
  files,
  onAddFiles,
  onRemoveFile,
  onFilePreset,
  onFileAccount = () => {},
  mapping,
  setMapping,
  options,
  setOptions,
  rows,
  accounts,
  catalog,
  onAccount,
  onInclude,
  onCategory,
  onPreview,
  onClear,
  onReview,
  busy,
  localError,
  message,
  history,
  openBatchId,
  batchDetail,
  onToggleBatch,
  onAskUndo,
  confirmOpen,
  summary,
  idempotencyKey,
  confirmError,
  onCloseConfirm,
  onConfirm,
  undoBatch,
  undoRemoval,
  undoPhrase,
  onUndoPhrase,
  undoError,
  onCloseUndo,
  onUndo,
  expanded = false,
  onToggleExpanded = () => {},
  confirmResult = /** @type {any} */ (null),
  undoResult = /** @type {any} */ (null),
  onTemplatesChanged = undefined,
}) {
  const { t, i18n } = useTranslation();
  const groups = statementGroups(rows);
  const blockers = commitBlockers(rows);
  const freshCount = rows.filter((row) => !row.duplicate).length;
  const duplicateCount = rows.filter((row) => row.duplicate).length;
  const expenseDuplicates = existingExpenseDuplicateRows(rows);
  const showMapping = usesGenericMapping(presetId, files);
  const fileRef = useRef(null);
  return (
    <section className="data-section backup-section statement-import-section" id="import">
      <div className="data-section-header">
        <h2>
          <button
            type="button"
            className="data-section-toggle"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-controls="statement-import-body"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{t('data.statementImport.title')}</span>
          </button>
        </h2>
      </div>
      <div id="statement-import-body" className="data-section-body" hidden={!expanded}>
      <p className="data-hint">{t('data.statementImport.hint')}</p>
      <p className="data-hint">
        {t('data.statementImport.limits', {
          files: limits.max_files,
          fileSize: formatByteCount(limits.max_file_bytes),
          rows: limits.max_rows,
          bodySize: formatByteCount(limits.max_body_bytes),
        })}
      </p>
      <div className="statement-import-toolbar">
        <label className="data-form-field">
          <span>{t('data.statementImport.preset')}</span>
          <select value={presetId} onChange={(event) => onPreset(event.target.value)}>
            <PresetChoices presets={presets} />
          </select>
        </label>
        <label className="data-form-field">
          <span>{t('data.statementImport.categoryMode')}</span>
          <select value={categoryMode} onChange={(event) => onCategoryMode(event.target.value)}>
            <option value="manual">{t('data.statementImport.modeManual')}</option>
            <option value="rules">{t('data.statementImport.modeRules')}</option>
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>
          <Upload size={14} />
          {t('data.statementImport.addFiles')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.ofx,.qfx,.xml,.xls,.pdf,text/csv,application/xml,application/pdf"
          multiple
          hidden
          onChange={(event) => {
            const selected = [...(event.target.files || [])];
            event.target.value = '';
            if (selected.length) onAddFiles(selected);
          }}
        />
      </div>
      {localError && <LimitAlert error={localError} />}
      {files.length === 0 ? (
        <p className="data-hint">{t('data.statementImport.noFiles')}</p>
      ) : (
        <ul className="statement-file-list">
          {files.map((file) => (
            <li key={file.id}>
              <span className="statement-file-name">{t('data.statementImport.fileMeta', { name: file.name, size: formatByteCount(file.size) })}</span>
              <label className="data-form-field">
                <select aria-label={t('data.statementImport.presetForFile', { name: file.name })} value={file.presetId} onChange={(event) => onFilePreset(file.id, event.target.value)}>
                  <PresetChoices presets={presets} />
                </select>
              </label>
              <label className="data-form-field">
                <select
                  aria-label={t('data.statementImport.accountForFile', { name: file.name })}
                  value={file.accountId || ''}
                  onChange={(event) => onFileAccount(file.id, event.target.value ? Number(event.target.value) : null)}
                >
                  <option value="">{t('data.statementImport.accountNone')}</option>
                  {accounts.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="link-btn" onClick={() => onRemoveFile(file.id)}>
                {t('data.statementImport.removeFile', { name: file.name })}
              </button>
            </li>
          ))}
        </ul>
      )}
      {showMapping && (
        <MappingFields mapping={mapping} setMapping={setMapping} options={options} setOptions={setOptions} />
      )}
      {showMapping && !mappingReady(mapping) && (
        <p className="form-error" role="alert">{t('data.statementImport.mappingDateRequired')}</p>
      )}
      <StatementTemplatesPanel
        showSave={showMapping && mappingReady(mapping)}
        mapping={mapping}
        options={options}
        onChanged={onTemplatesChanged}
      />
      <div className="backup-actions">
        <button type="button" className="btn-primary" onClick={onPreview} disabled={busy || files.length === 0}>
          {busy === 'preview' ? t('data.statementImport.previewing') : t('data.statementImport.preview')}
        </button>
        {rows.length > 0 && (
          <button type="button" className="btn-secondary" onClick={onClear} disabled={Boolean(busy)}>
            {t('data.statementImport.clearPreview')}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <p className="statement-batch-line" role="status">
          {t('data.statementImport.previewCounts', {
            fresh: freshCount,
            freshUnit: t('plural.row', { count: freshCount }),
            duplicates: duplicateCount,
            duplicateUnit: t('plural.row', { count: duplicateCount }),
          })}
        </p>
      )}
      {groups.map((group) => (
        <PreviewTable
          key={group.key}
          group={group}
          rows={rows}
          accounts={accounts}
          catalog={catalog}
          onAccount={onAccount}
          onInclude={onInclude}
          onCategory={onCategory}
        />
      ))}
      {rows.length > 0 && (
        <div className="backup-actions">
          <button type="button" className="btn-primary" onClick={onReview} disabled={!canCommit(rows) || Boolean(busy)}>
            {t('data.statementImport.review')}
          </button>
        </div>
      )}
      {rows.length > 0 && blockers.included === 0 && <p className="data-hint">{t('data.statementImport.nothingToImport')}</p>}
      {blockers.missingAccount > 0 && (
        <p className="form-error" role="alert">
          {t('data.statementImport.blockedAccount', { count: blockers.missingAccount, unit: t('plural.row', { count: blockers.missingAccount }) })}
        </p>
      )}
      {blockers.currencyMismatch > 0 && (
        <p className="form-error" role="alert">
          {t('data.statementImport.blockedMismatch', { count: blockers.currencyMismatch, unit: t('plural.row', { count: blockers.currencyMismatch }) })}
        </p>
      )}
      {blockers.subcategoryWithoutCategory > 0 && (
        <p className="form-error" role="alert">
          {t('data.statementImport.blockedSubcategory', { count: blockers.subcategoryWithoutCategory, unit: t('plural.row', { count: blockers.subcategoryWithoutCategory }) })}
        </p>
      )}
      {accounts.length === 0 && <p className="data-hint">{t('data.statementImport.noAccounts')}</p>}
      {message && <p className="backup-status" role="status">{message}</p>}

      <h3>{t('data.statementImport.historyTitle')}</h3>
      {history.length === 0 ? (
        <p className="data-hint">{t('data.statementImport.historyEmpty')}</p>
      ) : (
        <ul className="statement-history">
          {history.map((batch) => {
            const open = openBatchId === batch.id;
            const detail = open ? batchDetail : null;
            return (
              <li key={batch.id}>
                <div className="statement-history-row">
                  <div>
                    <strong>{t('data.statementImport.batchTitle', { id: batch.id })}</strong>
                    <p className="data-hint">
                      {t('data.statementImport.batchMeta', {
                        files: batch.file_count,
                        fileUnit: t('plural.file', { count: batch.file_count }),
                        rows: batch.row_count,
                        unit: t('plural.row', { count: batch.row_count }),
                        status: t(`data.statementImport.status.${batch.status}`),
                        date: formatWhen(batch.created_at, i18n.language),
                      })}
                    </p>
                  </div>
                  <div className="statement-history-actions">
                    <button type="button" className="btn-secondary" onClick={() => onToggleBatch(batch)}>
                      {open ? t('data.statementImport.hideDetails') : t('data.statementImport.details')}
                    </button>
                    {batch.status === 'committed' && (
                      <button type="button" className="btn-danger" onClick={() => onAskUndo(batch)}>
                        {t('data.statementImport.undo')}
                      </button>
                    )}
                  </div>
                </div>
                {open && detail && (
                  <BatchDetails detail={detail} presets={presets} language={i18n.language} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <CategoryRulesEditor />
      </div>

      {confirmOpen && (
        <ConfirmModal
          summary={summary}
          idempotencyKey={idempotencyKey}
          expenseDuplicates={expenseDuplicates}
          busy={busy === 'commit'}
          error={confirmError}
          result={confirmResult}
          onClose={onCloseConfirm}
          onConfirm={onConfirm}
        />
      )}
      {undoBatch && (
        <UndoModal
          batch={undoBatch}
          removal={undoRemoval}
          phrase={undoPhrase}
          onPhrase={onUndoPhrase}
          busy={busy === 'undo'}
          error={undoError}
          result={undoResult}
          onClose={onCloseUndo}
          onConfirm={onUndo}
        />
      )}
    </section>
  );
}

async function readBrowserFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, size: bytes.byteLength, base64: bytesToBase64(bytes) };
}

export default function StatementImportSection({ accounts = [] }) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const nonce = useRefreshNonce();
  const [limits, setLimits] = useState(FALLBACK_LIMITS);
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState(PRESET_AUTO);
  const [categoryMode, setCategoryMode] = useState('manual');
  const [files, setFiles] = useState([]);
  const [mapping, setMapping] = useState(DEFAULT_MAPPING);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [rows, setRows] = useState([]);
  const [catalog, setCatalog] = useState({ categories: [], byCategory: {} });
  const [busy, setBusy] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [message, setMessage] = useState(null);
  const [history, setHistory] = useState([]);
  const [openBatchId, setOpenBatchId] = useState(null);
  const [batchDetail, setBatchDetail] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState(null);
  const [confirmResult, setConfirmResult] = useState(null);
  const [idempotency, setIdempotency] = useState(null);
  const [undoBatch, setUndoBatch] = useState(null);
  const [undoRemoval, setUndoRemoval] = useState(null);
  const [undoPhrase, setUndoPhrase] = useState('');
  const [undoError, setUndoError] = useState(null);
  const [undoResult, setUndoResult] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const fileSeq = useRef(0);

  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    if (hash === '#/data/import') {
      setExpanded(true);
      requestAnimationFrame(() => document.getElementById('import')?.scrollIntoView({ block: 'start' }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.statementImportPresets().then((body) => {
      if (cancelled) return;
      setPresets(body.presets || []);
      if (body.limits) setLimits(body.limits);
    }).catch((err) => {
      if (!cancelled) setLocalError({ message: errorText(err, t('data.statementImport.limitsFailed')) });
    });
    api.listStatementImports().then((body) => {
      if (!cancelled) setHistory(body.batches || []);
    }).catch((err) => {
      if (!cancelled) setLocalError({ message: errorText(err, t('data.statementImport.historyLoadFailed')) });
    });
    return () => { cancelled = true; };
  }, [nonce, t]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listOperations(),
      api.listPlannedItems(),
      api.listRecurringItems(),
      api.listCategoryRules(),
    ]).then(([operations, planned, recurring, rules]) => {
      if (cancelled) return;
      setCatalog(categoryCatalog({
        operations: operations.operations || [],
        planned: planned.planned_items || [],
        recurring: recurring.recurring_items || [],
        rules: rules.rules || [],
      }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [nonce]);

  const summary = useMemo(() => summarizeCommit(rows, accounts), [rows, accounts]);

  const discardPreview = () => setRows([]);

  const onPreset = (next) => {
    setFiles((current) => current.map((file) => (file.presetId === presetId ? { ...file, presetId: next } : file)));
    setPresetId(next);
    discardPreview();
  };

  const onAddFiles = async (selected) => {
    setLocalError(null);
    setMessage(null);
    const accepted = [];
    let existingCount = files.length;
    let existingBody = encodedBodyBytes(files);
    for (const file of selected) {
      let read;
      try {
        read = await readBrowserFile(file);
      } catch {
        setLocalError({ code: 'unsupported', name: file.name });
        return;
      }
      const admission = fileAdmissionError(read, {
        existingCount,
        existingBodyBytes: existingBody,
        limits,
      });
      if (admission) {
        setLocalError(admission);
        return;
      }
      fileSeq.current += 1;
      accepted.push({ id: `file-${fileSeq.current}`, ...read, presetId });
      existingCount += 1;
      existingBody += read.base64.length;
    }
    if (accepted.length) {
      setFiles((current) => [...current, ...accepted]);
      discardPreview();
    }
  };

  const onPreview = async () => {
    const problems = previewRequestProblems({ presetId, files, mapping, options });
    if (problems.includes('files')) {
      const message = t('data.statementImport.noFiles');
      console.error('statement import preview was not sent', message);
      setLocalError({ message });
      return;
    }
    if (problems.includes('date')) {
      const message = t('data.statementImport.mappingDateRequired');
      console.error('statement import preview was not sent', message);
      setLocalError({ message });
      return;
    }
    if (problems.includes('currency')) {
      const message = t('errors.INVALID_CURRENCY');
      console.error('statement import preview was not sent', message);
      setLocalError({ message });
      return;
    }
    let previewOptions = options;
    if (usesGenericMapping(presetId, files)) {
      const sample = files.find((file) => file.presetId === PRESET_GENERIC && file.base64);
      if (sample) {
        previewOptions = preselectDateFormat(base64ToText(sample.base64), mapping, options);
        if (previewOptions.dateFormat !== options.dateFormat) setOptions(previewOptions);
      }
    }
    setBusy('preview');
    setLocalError(null);
    setMessage(null);
    try {
      const preview = await api.previewStatementImport(buildPreviewRequest({
        categoryMode,
        files,
        mapping,
        options: previewOptions,
        presets,
      }));
      const detected = (preview.files || [])
        .flatMap((file) => file.statements || [])
        .map((statement) => statement.date_format)
        .find((format) => format && format !== previewOptions.dateFormat);
      if (detected && usesGenericMapping(presetId, files)) {
        previewOptions = { ...previewOptions, dateFormat: detected };
        setOptions(previewOptions);
      }
      const nextRows = rowsFromPreview(preview);
      if (nextRows.length === 0) {
        const detail = previewFailureDetail(preview) || t('data.statementImport.previewEmptyFallback');
        const message = t('data.statementImport.previewEmpty', { detail });
        console.error('statement import preview returned no rows', detail, preview);
        setRows([]);
        setLocalError({ message });
        return;
      }
      setRows(nextRows);
    } catch (err) {
      console.error('statement import preview failed', err);
      setRows([]);
      setLocalError({ message: errorText(err, t('data.statementImport.previewFailed')) });
    } finally {
      setBusy(null);
    }
  };

  const onReview = () => {
    if (!canCommit(rows)) return;
    const payload = buildCommitPayload(rows, {
      categoryMode,
      fileCount: files.length,
      idempotencyKey: '',
      files,
    });
    const { idempotency_key: ignored, ...withoutKey } = payload;
    void ignored;
    setIdempotency(idempotencyForPayload(idempotency, withoutKey));
    setConfirmError(null);
    setConfirmResult(null);
    setConfirmOpen(true);
  };

  const onConfirm = async () => {
    if (confirmResult) return;
    const key = idempotency?.key || createIdempotencyKey();
    setBusy('commit');
    setConfirmError(null);
    try {
      const payload = buildCommitPayload(rows, {
        categoryMode,
        fileCount: files.length,
        idempotencyKey: key,
        files,
      });
      const send = () => api.commitStatementImport(payload);
      let result;
      try {
        result = await send();
      } catch (err) {
        if (err && err.status) throw err;
        result = await send();
      }
      const outcome = interpretCommit(result);
      setConfirmResult({ ...outcome, errors: 0 });
      const listed = await api.listStatementImports();
      setHistory(listed.batches || []);
      refresh();
    } catch (err) {
      if (err && err.code === 'DUPLICATE_EXPENSE') {
        const flagged = existingExpenseDuplicateRows(rows);
        setConfirmError(t('data.statementImport.duplicateExpenseCommit', {
          rows: describeStatementRows(flagged) || t('data.statementImport.duplicateExpenseUnknownRow'),
          existingOperationId: err.params?.existingOperationId ?? '',
        }));
      } else {
        setConfirmError(errorText(err, t('data.statementImport.previewFailed')));
      }
    } finally {
      setBusy(null);
    }
  };

  const onToggleBatch = async (batch) => {
    if (openBatchId === batch.id) {
      setOpenBatchId(null);
      setBatchDetail(null);
      return;
    }
    setOpenBatchId(batch.id);
    setBatchDetail(null);
    try {
      const detail = await api.getStatementImport(batch.id);
      setBatchDetail(detail);
    } catch (err) {
      setLocalError({ message: errorText(err, t('data.statementImport.historyLoadFailed')) });
    }
  };

  const closeConfirm = () => {
    if (busy === 'commit') return;
    const finished = confirmResult;
    setConfirmOpen(false);
    setConfirmResult(null);
    setConfirmError(null);
    if (finished) {
      setFiles([]);
      setRows([]);
      setIdempotency(null);
    }
  };

  const closeUndo = () => {
    if (busy === 'undo') return;
    setUndoBatch(null);
    setUndoPhrase('');
    setUndoResult(null);
    setUndoError(null);
    setUndoRemoval(null);
  };

  const onAskUndo = async (batch) => {
    setUndoError(null);
    setUndoPhrase('');
    setUndoResult(null);
    setUndoRemoval(null);
    setUndoBatch(batch);
    try {
      const detail = batchDetail?.batch?.id === batch.id ? batchDetail : await api.getStatementImport(batch.id);
      const operations = Array.isArray(detail?.operations) ? detail.operations : [];
      setUndoRemoval(summarizeRemoval(operations, accounts));
    } catch (err) {
      setUndoRemoval(null);
      setUndoError(errorText(err, t('data.statementImport.historyLoadFailed')));
    }
  };

  const onUndo = async () => {
    if (undoResult) return;
    if (!undoBatch || !undoPhraseMatches(undoPhrase)) return;
    setBusy('undo');
    setUndoError(null);
    const removed = undoRemoval?.count ?? 0;
    try {
      await api.undoStatementImport(undoBatch.id);
      setUndoResult({ removed });
      const listed = await api.listStatementImports();
      setHistory(listed.batches || []);
      setOpenBatchId(null);
      setBatchDetail(null);
      refresh();
    } catch (err) {
      setUndoError(errorText(err, t('data.statementImport.historyLoadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const reloadPresets = async () => {
    const body = await api.statementImportPresets();
    setPresets(body.presets || []);
    if (body.limits) setLimits(body.limits);
  };

  return (
    <StatementImportView
      limits={limits}
      presets={presets}
      presetId={presetId}
      onPreset={onPreset}
      categoryMode={categoryMode}
      onCategoryMode={(mode) => { setCategoryMode(mode); discardPreview(); }}
      files={files}
      onAddFiles={onAddFiles}
      onRemoveFile={(id) => { setFiles((current) => current.filter((file) => file.id !== id)); discardPreview(); }}
      onFilePreset={(id, next) => { setFiles((current) => current.map((file) => (file.id === id ? { ...file, presetId: next } : file))); discardPreview(); }}
      onFileAccount={(id, accountId) => { setFiles((current) => current.map((file) => (file.id === id ? { ...file, accountId } : file))); discardPreview(); }}
      mapping={mapping}
      setMapping={(next) => { setMapping(next); discardPreview(); }}
      options={options}
      setOptions={(next) => { setOptions(next); discardPreview(); }}
      rows={rows}
      accounts={accounts}
      catalog={catalog}
      onAccount={(key, accountId) => setRows((current) => withStatementAccount(current, key, accountId, accounts))}
      onInclude={(key, include) => setRows((current) => withInclude(current, key, include))}
      onCategory={(key, patch) => setRows((current) => withCategory(current, key, patch))}
      onPreview={onPreview}
      onClear={() => setRows([])}
      onReview={onReview}
      busy={busy}
      localError={localError}
      message={message}
      history={history}
      openBatchId={openBatchId}
      batchDetail={batchDetail}
      onToggleBatch={onToggleBatch}
      onAskUndo={onAskUndo}
      confirmOpen={confirmOpen}
      summary={summary}
      idempotencyKey={idempotency?.key || ''}
      confirmError={confirmError}
      confirmResult={confirmResult}
      onCloseConfirm={closeConfirm}
      onConfirm={onConfirm}
      undoBatch={undoBatch}
      undoRemoval={undoRemoval}
      undoPhrase={undoPhrase}
      onUndoPhrase={setUndoPhrase}
      undoError={undoError}
      undoResult={undoResult}
      onCloseUndo={closeUndo}
      onUndo={onUndo}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((current) => !current)}
      onTemplatesChanged={reloadPresets}
    />
  );
}

