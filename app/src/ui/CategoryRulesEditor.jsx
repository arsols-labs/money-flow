// Category rules for statement import. Lives in the Data section with the importer.
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronUp, Pencil, Trash2, X } from 'lucide-react';
import { api } from './api';
import { useRefreshNonce } from './RefreshContext';
import {
  categoryCatalog,
  emptyRuleDraft,
  nextRulePriority,
  priorityMove,
  rulePayload,
  validateRuleDraft,
} from './statementImportState';

function catalogWithRules(current, rules) {
  const operations = [];
  for (const category of current.categories) {
    const subs = current.byCategory[category] || [];
    if (subs.length === 0) operations.push({ category });
    else subs.forEach((subcategory) => operations.push({ category, subcategory }));
  }
  return categoryCatalog({ operations, rules });
}

function optionsWithCurrent(options, current) {
  if (current && !options.includes(current)) return [current, ...options];
  return options;
}

export function CategoryTextField({ label, value, options, onChange, disabled, placeholder, listId }) {
  return (
    <>
      <input
        className="statement-category-input"
        list={listId}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={200}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {options.map((option) => <option key={option} value={option} />)}
      </datalist>
    </>
  );
}

function RuleForm({ draft, setDraft, catalog, busy, editing, onSubmit, onCancel }) {
  const { t } = useTranslation();
  const categories = optionsWithCurrent(catalog.categories, draft.category);
  const subs = optionsWithCurrent(catalog.byCategory[draft.category] || [], draft.subcategory);
  return (
    <form
      className="data-form statement-rule-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="data-form-field">
        <span>{t('data.statementImport.rulePattern')}</span>
        <input
          value={draft.pattern}
          onChange={(event) => setDraft({ ...draft, pattern: event.target.value })}
          disabled={busy}
          placeholder={t('data.statementImport.rulePatternPlaceholder')}
          autoComplete="off"
        />
      </label>
      <label className="data-form-field">
        <span>{t('data.statementImport.ruleMatch')}</span>
        <select
          value={draft.matchField}
          onChange={(event) => setDraft({ ...draft, matchField: event.target.value })}
          disabled={busy}
        >
          <option value="merchant">{t('data.statementImport.matchField.merchant')}</option>
          <option value="description">{t('data.statementImport.matchField.description')}</option>
          <option value="any">{t('data.statementImport.matchField.any')}</option>
        </select>
      </label>
      <label className="data-form-field">
        <span>{t('data.statementImport.ruleCategory')}</span>
        <CategoryTextField
          label={t('data.statementImport.ruleCategory')}
          value={draft.category}
          options={categories}
          listId="rule-category-list"
          placeholder={t('data.statementImport.newCategory')}
          disabled={busy}
          onChange={(category) => setDraft({
            ...draft,
            category,
            subcategory: category.trim() ? draft.subcategory : '',
          })}
        />
      </label>
      <label className="data-form-field">
        <span>{t('data.statementImport.ruleSubcategory')}</span>
        <CategoryTextField
          label={t('data.statementImport.ruleSubcategory')}
          value={draft.subcategory}
          options={subs}
          listId="rule-subcategory-list"
          placeholder={t('data.statementImport.newSubcategory')}
          disabled={busy || !draft.category.trim()}
          onChange={(subcategory) => setDraft({ ...draft, subcategory })}
        />
      </label>
      <label className="data-form-field">
        <span>{t('data.statementImport.rulePriority')}</span>
        <input
          type="number"
          min="0"
          max="1000000"
          step="1"
          value={draft.priority}
          onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
          disabled={busy}
        />
      </label>
      <p className="data-hint">{t('data.statementImport.priorityHint')}</p>
      {categories.length === 0 && (
        <p className="data-hint">{t('data.statementImport.categoriesEmpty')}</p>
      )}
      <div className="data-form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('common.saving') : (editing ? t('data.statementImport.ruleSave') : t('data.statementImport.ruleAdd'))}
        </button>
        {editing && (
          <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

function DeleteRuleModal({ rule, busy, error, onClose, onConfirm }) {
  const { t } = useTranslation();
  return (
    <div className="mcp-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-rule-delete-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mcp-modal-header">
          <div className="mcp-modal-title" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={16} />
            <span id="category-rule-delete-title">{t('data.statementImport.ruleDeleteTitle')}</span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose} disabled={busy} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <div className="mcp-modal-body">
          <p>{t('data.statementImport.ruleDeleteWarning', { pattern: rule.pattern })}</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="mcp-modal-footer">
          <button type="button" className="link-btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button
            type="button"
            className="btn-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? t('common.saving') : t('data.statementImport.ruleDelete')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CategoryRulesPanel({
  rules,
  catalog,
  draft,
  setDraft,
  editingId,
  busy,
  error,
  formError,
  pendingDelete,
  onSubmit,
  onCancelEdit,
  onEdit,
  onAskDelete,
  onCloseDelete,
  onConfirmDelete,
  onMove,
}) {
  const { t } = useTranslation();
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  return (
    <div className="statement-rules">
      <h3>{t('data.statementImport.rulesTitle')}</h3>
      <p className="data-hint">{t('data.statementImport.rulesHint')}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {sorted.length === 0 ? (
        <p className="data-hint">{t('data.statementImport.rulesEmpty')}</p>
      ) : (
        <ol className="statement-rule-list">
          {sorted.map((rule, index) => (
            <li key={rule.id} className="statement-rule">
              <div className="statement-rule-main">
                <strong>{rule.pattern}</strong>
                <span>{t(`data.statementImport.matchField.${rule.match_field}`)}</span>
                <span>
                  {rule.subcategory ? `${rule.category} / ${rule.subcategory}` : rule.category}
                </span>
                <span>{t('data.statementImport.rulePriority')}: {rule.priority}</span>
              </div>
              <div className="statement-rule-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('data.statementImport.ruleMoveUp', { pattern: rule.pattern })}
                  onClick={() => onMove(rule, 'up')}
                  disabled={busy || index === 0}
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('data.statementImport.ruleMoveDown', { pattern: rule.pattern })}
                  onClick={() => onMove(rule, 'down')}
                  disabled={busy || index === sorted.length - 1}
                >
                  <ChevronDown size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('data.statementImport.ruleEdit', { pattern: rule.pattern })}
                  onClick={() => onEdit(rule)}
                  disabled={busy}
                >
                  <Pencil size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  aria-label={t('data.statementImport.ruleDelete')}
                  onClick={() => onAskDelete(rule)}
                  disabled={busy}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <RuleForm
        draft={draft}
        setDraft={setDraft}
        catalog={catalog}
        busy={busy}
        editing={editingId !== null}
        onSubmit={onSubmit}
        onCancel={onCancelEdit}
      />
      {pendingDelete && (
        <DeleteRuleModal
          rule={pendingDelete}
          busy={busy}
          error={formError}
          onClose={onCloseDelete}
          onConfirm={onConfirmDelete}
        />
      )}
    </div>
  );
}

export default function CategoryRulesEditor() {
  const { t } = useTranslation();
  const nonce = useRefreshNonce();
  const [rules, setRules] = useState([]);
  const [catalog, setCatalog] = useState({ categories: [], byCategory: {} });
  const [draft, setDraft] = useState(() => emptyRuleDraft());
  const [editingId, setEditingId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      api.listOperations(),
      api.listPlannedItems(),
      api.listRecurringItems(),
      api.listCategoryRules(),
    ]).then(([operations, planned, recurring, loaded]) => {
      if (cancelled) return;
      const nextRules = loaded.rules || [];
      setRules(nextRules);
      setCatalog(categoryCatalog({
        operations: operations.operations || [],
        planned: planned.planned_items || [],
        recurring: recurring.recurring_items || [],
        rules: nextRules,
      }));
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : t('data.statementImport.rulesLoadFailed'));
    });
    return () => { cancelled = true; };
  }, [nonce, t]);

  const resetDraft = (nextRules) => {
    setEditingId(null);
    setDraft(emptyRuleDraft(nextRulePriority(nextRules)));
  };

  const onSubmit = async () => {
    const problem = validateRuleDraft(draft);
    if (problem === 'pattern') {
      setFormError(t('data.statementImport.ruleInvalidPattern'));
      return;
    }
    if (problem === 'category') {
      setFormError(t('data.statementImport.ruleInvalidCategory'));
      return;
    }
    if (problem === 'subcategory') {
      setFormError(t('errors.SUBCATEGORY_REQUIRES_CATEGORY'));
      return;
    }
    if (problem) {
      setFormError(t('errors.CATEGORY_RULE_INVALID', { field: problem }));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const payload = rulePayload(draft);
      if (editingId === null) {
        const created = await api.createCategoryRule(payload);
        const next = [...rules, created.rule];
        setRules(next);
        setCatalog((current) => catalogWithRules(current, next));
        resetDraft(next);
      } else {
        const updated = await api.updateCategoryRule(editingId, payload);
        const next = rules.map((rule) => (rule.id === editingId ? updated.rule : rule));
        setRules(next);
        resetDraft(next);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('data.statementImport.rulesLoadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onMove = async (rule, direction) => {
    const patches = priorityMove(rules, rule.id, direction);
    if (patches.length === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      let next = rules;
      for (const patch of patches) {
        const updated = await api.updateCategoryRule(patch.id, { priority: patch.priority });
        next = next.map((item) => (item.id === patch.id ? updated.rule : item));
      }
      setRules(next);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('data.statementImport.rulesLoadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.deleteCategoryRule(pendingDelete.id);
      const next = rules.filter((rule) => rule.id !== pendingDelete.id);
      setRules(next);
      setPendingDelete(null);
      if (editingId === pendingDelete.id) resetDraft(next);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('data.statementImport.rulesLoadFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CategoryRulesPanel
      rules={rules}
      catalog={catalog}
      draft={draft}
      setDraft={setDraft}
      editingId={editingId}
      busy={busy}
      error={error}
      formError={formError}
      pendingDelete={pendingDelete}
      onSubmit={onSubmit}
      onCancelEdit={() => resetDraft(rules)}
      onEdit={(rule) => {
        setEditingId(rule.id);
        setDraft({
          pattern: rule.pattern,
          matchField: rule.match_field,
          category: rule.category,
          subcategory: rule.subcategory || '',
          priority: rule.priority,
        });
        setFormError(null);
      }}
      onAskDelete={(rule) => { setPendingDelete(rule); setFormError(null); }}
      onCloseDelete={() => { if (!busy) setPendingDelete(null); }}
      onConfirmDelete={onConfirmDelete}
      onMove={onMove}
    />
  );
}
