// Collapsible Data section for D1 rule management (#/settings, #/data/rules, #/data/settings).
// Collapsed by default inside DataDashboard; expanded automatically when deep-linked.
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Download, Play, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { RULE_DOMAINS, MATCH_TYPES, MATCH_FIELDS } from '../shared/rules/types';
import { api } from './api';
import { DataSection } from './components';
import { useRefresh, useRefreshNonce } from './RefreshContext';
import {
  getReadinessEntries,
  isOptionalRuleDomain,
  loadRuntimeConfig,
  useRuntimeConfig,
} from './runtimeConfig';

const EMPTY_SET_FORM = {
  set_key: '',
  scope_country: 'SHARED',
  scope_locale: '',
  label: '',
  description: '',
  effective_from: '',
  effective_to: '',
  priority: '100',
  allow_shared_fallback: true,
};

const EMPTY_ENTRY_FORM = {
  entry_key: '',
  match_type: 'exact',
  match_field: 'merchant',
  pattern: '',
  priority: '100',
  enabled: true,
  payload_json: '{}',
};

export default function RulesSettingsSection({ expanded = false, onToggle = () => {} }) {
  const { t } = useTranslation();
  const refreshAll = useRefresh();
  const nonce = useRefreshNonce();
  const runtime = useRuntimeConfig();
  const readinessEntries = getReadinessEntries(runtime);

  const [domain, setDomain] = useState('currency_standards');
  const [countryFilter, setCountryFilter] = useState('');
  const [localeFilter, setLocaleFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [search, setSearch] = useState('');

  const [ruleSets, setRuleSets] = useState([]);
  const [selectedSetId, setSelectedSetId] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [policies, setPolicies] = useState([]);

  const [setForm, setSetForm] = useState(EMPTY_SET_FORM);
  const [entryForm, setEntryForm] = useState(EMPTY_ENTRY_FORM);
  const [editingEntryId, setEditingEntryId] = useState(null);

  const [previewSample, setPreviewSample] = useState('');
  const [previewResult, setPreviewResult] = useState(null);

  const [policyForm, setPolicyForm] = useState({
    recurring_item_id: '',
    policy_type: 'analytical_skip_only',
    scope_country: 'SHARED',
  });

  const [bundleJson, setBundleJson] = useState('');
  const [bundleReplace, setBundleReplace] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showPolicies, setShowPolicies] = useState(false);
  const [showBundle, setShowBundle] = useState(false);

  const loadSets = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listRuleSets({
        domain,
        ...(countryFilter.trim() ? { scope_country: countryFilter.trim().toUpperCase() } : {}),
        ...(localeFilter.trim() ? { scope_locale: localeFilter.trim().toLowerCase() } : {}),
        ...(stateFilter ? { state: stateFilter } : {}),
      });
      setRuleSets(res.rule_sets || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [domain, countryFilter, localeFilter, stateFilter]);

  const loadDetail = useCallback(async (setId) => {
    if (!setId) {
      setSelectedDetail(null);
      return;
    }
    try {
      const detail = await api.getRuleSet(setId);
      setSelectedDetail(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadPolicies = useCallback(async () => {
    try {
      const res = await api.listRecurringPolicies();
      setPolicies(res.policies || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    loadSets();
  }, [expanded, loadSets, nonce]);

  useEffect(() => {
    if (!expanded) return;
    loadPolicies();
  }, [expanded, loadPolicies, nonce]);

  useEffect(() => {
    if (selectedSetId) loadDetail(selectedSetId);
  }, [selectedSetId, loadDetail]);

  const afterMutation = async (msg, nextSelectedId = selectedSetId) => {
    setStatusMsg(msg || null);
    setError(null);
    await Promise.all([
      loadSets(),
      loadPolicies(),
      nextSelectedId ? loadDetail(nextSelectedId) : Promise.resolve(),
      loadRuntimeConfig(),
    ]);
    refreshAll();
  };

  const handleCreateSet = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.createRuleSet({
        domain,
        set_key: setForm.set_key.trim(),
        scope_country: setForm.scope_country.trim().toUpperCase() || 'SHARED',
        scope_locale: setForm.scope_locale.trim().toLowerCase(),
        label: setForm.label.trim(),
        description: setForm.description.trim() || null,
        effective_from: setForm.effective_from.trim() || null,
        effective_to: setForm.effective_to.trim() || null,
        priority: Number(setForm.priority) || 100,
        allow_shared_fallback: setForm.allow_shared_fallback,
      });
      const createdId = res.rule_set?.id ?? null;
      setSetForm(EMPTY_SET_FORM);
      setShowCreate(false);
      if (createdId) setSelectedSetId(createdId);
      await afterMutation(null, createdId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runSetLifecycle = async (action, ruleSet) => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'activate') {
        await api.activateRuleSet(ruleSet.id, ruleSet.revision);
      } else if (action === 'retire') {
        await api.retireRuleSet(ruleSet.id, ruleSet.revision);
      } else if (action === 'clone') {
        const cloned = await api.cloneRuleSet(ruleSet.id);
        if (cloned.rule_set?.id) setSelectedSetId(cloned.rule_set.id);
      } else if (action === 'delete') {
        await api.deleteRuleSet(ruleSet.id, ruleSet.revision);
        if (selectedSetId === ruleSet.id) setSelectedSetId(null);
      }
      await afterMutation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEntry = async (e) => {
    e.preventDefault();
    if (!selectedDetail?.rule_set) return;
    let payload;
    try {
      payload = JSON.parse(entryForm.payload_json);
    } catch {
      setError(t('errors.INVALID_JSON'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.upsertRuleEntry(
        selectedDetail.rule_set.id,
        {
          entry_key: entryForm.entry_key.trim(),
          match_type: entryForm.match_type,
          match_field: entryForm.match_field,
          pattern: entryForm.pattern,
          priority: Number(entryForm.priority) || 100,
          enabled: entryForm.enabled,
          payload,
          set_revision: selectedDetail.rule_set.revision,
        },
        editingEntryId,
      );
      setEntryForm(EMPTY_ENTRY_FORM);
      setEditingEntryId(null);
      await afterMutation(null, selectedDetail.rule_set.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEntry = async (entryId) => {
    if (!selectedDetail?.rule_set) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteRuleEntry(selectedDetail.rule_set.id, entryId, selectedDetail.rule_set.revision);
      await afterMutation(null, selectedDetail.rule_set.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.previewRuleMatch({
        domain,
        sample: previewSample,
        scope_country: countryFilter.trim().toUpperCase() || undefined,
        scope_locale: localeFilter.trim().toLowerCase() || undefined,
      });
      setPreviewResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleExportBundle = async () => {
    setBusy(true);
    setError(null);
    try {
      const bundle = await api.exportRulesBundle();
      setBundleJson(JSON.stringify(bundle, null, 2));
      setShowBundle(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleImportBundle = async () => {
    let parsed;
    try {
      parsed = JSON.parse(bundleJson);
    } catch {
      setError(t('errors.INVALID_JSON'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.importRulesBundle({
        ...parsed,
        replace_existing: bundleReplace,
      });
      await afterMutation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePolicy = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createRecurringPolicy({
        recurring_item_id: Number(policyForm.recurring_item_id),
        policy_type: policyForm.policy_type,
        scope_country: policyForm.scope_country.trim().toUpperCase() || 'SHARED',
        state: 'active',
      });
      setPolicyForm({ recurring_item_id: '', policy_type: 'analytical_skip_only', scope_country: 'SHARED' });
      await afterMutation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePolicy = async (policy, nextState) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateRecurringPolicyState(policy.id, { state: nextState });
      await afterMutation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const q = search.trim().toLowerCase();
  const visibleSets = ruleSets.filter((s) => {
    if (!q) return true;
    return [s.set_key, s.label, s.scope_country, s.scope_locale, s.state]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  return (
    <DataSection
      id="rules"
      sectionId="settings"
      className="rules-settings-section"
      title={t('rulesSettings.title')}
      expanded={expanded}
      onToggle={onToggle}
      actions={
        <span className="data-hint">
          {t('rulesSettings.epochLabel', { epoch: runtime.rules_epoch || 0 })}
        </span>
      }
    >
      <p className="data-hint">{t('rulesSettings.description')}</p>

      <div className="rules-readiness" aria-label={t('rulesSettings.readinessTitle')}>
        {readinessEntries.map((item) => {
          const optional = isOptionalRuleDomain(item.domain);
          const statusClass = item.configured
            ? 'chip--active'
            : optional
              ? ''
              : 'rules-chip--missing';
          const statusLabel = item.configured
            ? t('rulesSettings.configured')
            : optional
              ? t('rulesSettings.notAddedYet')
              : t('rulesSettings.missing');
          const domainLabel = t(`rulesSettings.domains.${item.domain}`, { defaultValue: item.domain });
          return (
            <span key={item.domain} className={`chip${statusClass ? ` ${statusClass}` : ''}`}>
              {domainLabel}: {statusLabel}
            </span>
          );
        })}
      </div>

      <div className="rules-filter-row">
        <label className="data-form-field">
          <span>{t('rulesSettings.domainLabel')}</span>
          <select value={domain} onChange={(e) => { setDomain(e.target.value); setSelectedSetId(null); setPreviewResult(null); }}>
            {RULE_DOMAINS.map((d) => (
              <option key={d} value={d}>
                {t(`rulesSettings.domains.${d}`, { defaultValue: d })}
              </option>
            ))}
          </select>
        </label>
        <label className="data-form-field">
          <span>{t('rulesSettings.countryLabel')}</span>
          <input value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} placeholder="SHARED" maxLength={8} />
        </label>
        <label className="data-form-field">
          <span>{t('rulesSettings.localeLabel')}</span>
          <input value={localeFilter} onChange={(e) => setLocaleFilter(e.target.value)} placeholder="all" maxLength={12} />
        </label>
        <label className="data-form-field">
          <span>{t('rulesSettings.stateLabel')}</span>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">{t('common.all')}</option>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="retired">retired</option>
          </select>
        </label>
        <label className="data-form-field">
          <span>{t('rulesSettings.searchPlaceholder')}</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('rulesSettings.searchPlaceholder')} />
        </label>
      </div>

      <div className="backup-actions">
        <button type="button" className="btn-secondary" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={14} /> {t('rulesSettings.createSetTitle')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => loadRuntimeConfig().then(loadSets)} disabled={busy}>
          <RefreshCw size={14} /> {t('shell.refresh')}
        </button>
        <button type="button" className="btn-secondary" onClick={handleExportBundle} disabled={busy}>
          <Download size={14} /> {t('rulesSettings.exportBundle')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setShowBundle((v) => !v)}>
          <Upload size={14} /> {t('rulesSettings.bundleTitle')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setShowPolicies((v) => !v)}>
          {t('rulesSettings.recurringPoliciesTitle')}
        </button>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {statusMsg && <p className="data-hint" role="status">{statusMsg}</p>}

      {showCreate && (
        <form className="data-form" onSubmit={handleCreateSet}>
          <label className="data-form-field">
            <span>{t('rulesSettings.setKeyLabel')}</span>
            <input value={setForm.set_key} onChange={(e) => setSetForm({ ...setForm, set_key: e.target.value })} required />
          </label>
          <label className="data-form-field">
            <span>{t('rulesSettings.labelField')}</span>
            <input value={setForm.label} onChange={(e) => setSetForm({ ...setForm, label: e.target.value })} required />
          </label>
          <label className="data-form-field">
            <span>{t('rulesSettings.countryLabel')}</span>
            <input value={setForm.scope_country} onChange={(e) => setSetForm({ ...setForm, scope_country: e.target.value })} required />
          </label>
          <label className="data-form-field">
            <span>{t('rulesSettings.localeLabel')}</span>
            <input value={setForm.scope_locale} onChange={(e) => setSetForm({ ...setForm, scope_locale: e.target.value })} placeholder="all" />
          </label>
          <label className="data-form-field">
            <span>{t('rulesSettings.effectiveFromLabel')}</span>
            <input value={setForm.effective_from} onChange={(e) => setSetForm({ ...setForm, effective_from: e.target.value })} placeholder="YYYY-MM-DD" />
          </label>
          <label className="data-form-field">
            <span>{t('rulesSettings.effectiveToLabel')}</span>
            <input value={setForm.effective_to} onChange={(e) => setSetForm({ ...setForm, effective_to: e.target.value })} placeholder="YYYY-MM-DD" />
          </label>
          <label className="data-form-field">
            <span>{t('rulesSettings.priorityLabel')}</span>
            <input type="number" value={setForm.priority} onChange={(e) => setSetForm({ ...setForm, priority: e.target.value })} />
          </label>
          <div className="data-form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>{t('rulesSettings.createSetBtn')}</button>
            <button type="button" className="link-btn" onClick={() => setShowCreate(false)}>{t('common.cancel')}</button>
          </div>
        </form>
      )}

      {visibleSets.length === 0 ? (
        <p className="data-hint">{t('rulesSettings.noSets')}</p>
      ) : (
        <ul className="data-list">
          {visibleSets.map((set) => {
            const expanded = selectedSetId === set.id;
            return (
              <li key={set.id} className="data-row rules-set-row">
                <div className="data-row-top">
                  <button
                    type="button"
                    className="link-btn rules-set-toggle"
                    onClick={() => setSelectedSetId(expanded ? null : set.id)}
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <strong>{set.label}</strong>
                    <span className="data-hint">
                      {' '}· {set.set_key} · v{set.version} · {set.state} · {set.scope_country}/{set.scope_locale || 'all'}
                    </span>
                  </button>
                  <div className="statement-template-actions">
                    {set.state === 'draft' && (
                      <>
                        <button type="button" className="link-btn" onClick={() => runSetLifecycle('activate', set)} disabled={busy}>
                          {t('rulesSettings.activate')}
                        </button>
                        <button type="button" className="link-btn" onClick={() => runSetLifecycle('delete', set)} disabled={busy}>
                          {t('common.delete')}
                        </button>
                      </>
                    )}
                    {set.state === 'active' && (
                      <>
                        <button type="button" className="link-btn" onClick={() => runSetLifecycle('clone', set)} disabled={busy}>
                          {t('rulesSettings.clone')}
                        </button>
                        <button type="button" className="link-btn" onClick={() => runSetLifecycle('retire', set)} disabled={busy}>
                          {t('rulesSettings.retire')}
                        </button>
                      </>
                    )}
                    {set.state === 'retired' && (
                      <button type="button" className="link-btn" onClick={() => runSetLifecycle('clone', set)} disabled={busy}>
                        {t('rulesSettings.clone')}
                      </button>
                    )}
                  </div>
                </div>
                {expanded && selectedDetail?.rule_set?.id === set.id && (
                  <div className="rules-set-detail">
                    {(selectedDetail.entries || []).length === 0 ? (
                      <p className="data-hint">{t('rulesSettings.noEntries')}</p>
                    ) : (
                      <ul className="data-list">
                        {selectedDetail.entries.map((entry) => (
                          <li key={entry.id} className="data-row">
                            <div className="data-row-top">
                              <div className="data-row-main">
                                <span className="data-row-title">
                                  <code>{entry.match_type}</code> · <code>{entry.match_field}</code> · <code>{entry.pattern}</code>
                                </span>
                                <pre className="rules-payload-preview">{JSON.stringify(entry.payload)}</pre>
                              </div>
                              {set.state === 'draft' && (
                                <div className="statement-template-actions">
                                  <button
                                    type="button"
                                    className="link-btn"
                                    onClick={() => {
                                      setEditingEntryId(entry.id);
                                      setEntryForm({
                                        entry_key: entry.entry_key || '',
                                        match_type: entry.match_type,
                                        match_field: entry.match_field,
                                        pattern: entry.pattern,
                                        priority: String(entry.priority ?? 100),
                                        enabled: Boolean(entry.enabled),
                                        payload_json: JSON.stringify(entry.payload, null, 2),
                                      });
                                    }}
                                  >
                                    {t('common.edit')}
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label={t('common.delete')}
                                    onClick={() => handleDeleteEntry(entry.id)}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {set.state === 'draft' && (
                      <form className="data-form" onSubmit={handleSaveEntry}>
                        <label className="data-form-field">
                          <span>{t('rulesSettings.entryKeyLabel')}</span>
                          <input value={entryForm.entry_key} onChange={(e) => setEntryForm({ ...entryForm, entry_key: e.target.value })} required />
                        </label>
                        <label className="data-form-field">
                          <span>{t('rulesSettings.matchTypeLabel')}</span>
                          <select value={entryForm.match_type} onChange={(e) => setEntryForm({ ...entryForm, match_type: e.target.value })}>
                            {MATCH_TYPES.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </label>
                        <label className="data-form-field">
                          <span>{t('rulesSettings.matchFieldLabel')}</span>
                          <select value={entryForm.match_field} onChange={(e) => setEntryForm({ ...entryForm, match_field: e.target.value })}>
                            {MATCH_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                          </select>
                        </label>
                        <label className="data-form-field">
                          <span>{t('rulesSettings.patternLabel')}</span>
                          <input value={entryForm.pattern} onChange={(e) => setEntryForm({ ...entryForm, pattern: e.target.value })} required />
                        </label>
                        <label className="data-form-field">
                          <span>{t('rulesSettings.payloadJsonLabel')}</span>
                          <textarea rows={3} value={entryForm.payload_json} onChange={(e) => setEntryForm({ ...entryForm, payload_json: e.target.value })} />
                        </label>
                        <div className="data-form-actions">
                          <button type="submit" className="btn-primary" disabled={busy}>{t('rulesSettings.saveEntry')}</button>
                          {editingEntryId && (
                            <button type="button" className="link-btn" onClick={() => { setEditingEntryId(null); setEntryForm(EMPTY_ENTRY_FORM); }}>
                              {t('common.cancel')}
                            </button>
                          )}
                        </div>
                      </form>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form className="data-form rules-preview-form" onSubmit={handlePreview}>
        <label className="data-form-field">
          <span>{t('rulesSettings.previewTitle')} — {t('rulesSettings.sampleLabel')}</span>
          <input value={previewSample} onChange={(e) => setPreviewSample(e.target.value)} placeholder={t('rulesSettings.samplePlaceholder')} />
        </label>
        <div className="data-form-actions">
          <button type="submit" className="btn-secondary" disabled={busy}>
            <Play size={14} /> {t('rulesSettings.runPreview')}
          </button>
        </div>
        {previewResult && (
          <pre className="rules-payload-preview">{JSON.stringify(previewResult, null, 2)}</pre>
        )}
      </form>

      {showBundle && (
        <div className="rules-bundle-panel">
          <h3>{t('rulesSettings.bundleTitle')}</h3>
          <textarea
            rows={8}
            className="rules-bundle-textarea"
            value={bundleJson}
            onChange={(e) => setBundleJson(e.target.value)}
            placeholder='{"schema_version":1,"rule_sets":[],"recurring_policies":[]}'
          />
          <label className="data-hint">
            <input type="checkbox" checked={bundleReplace} onChange={(e) => setBundleReplace(e.target.checked)} />
            {' '}{t('rulesSettings.replaceExistingLabel')}
          </label>
          <div className="backup-actions">
            <button type="button" className="btn-primary" onClick={handleImportBundle} disabled={busy || !bundleJson.trim()}>
              {t('rulesSettings.importBundle')}
            </button>
          </div>
        </div>
      )}

      {showPolicies && (
        <div className="rules-policies-panel">
          <h3>{t('rulesSettings.recurringPoliciesTitle')}</h3>
          <form className="data-form" onSubmit={handleCreatePolicy}>
            <label className="data-form-field">
              <span>{t('rulesSettings.recurringItemIdLabel')}</span>
              <input
                type="number"
                value={policyForm.recurring_item_id}
                onChange={(e) => setPolicyForm({ ...policyForm, recurring_item_id: e.target.value })}
                required
              />
            </label>
            <label className="data-form-field">
              <span>{t('rulesSettings.policyTypeLabel')}</span>
              <select value={policyForm.policy_type} onChange={(e) => setPolicyForm({ ...policyForm, policy_type: e.target.value })}>
                <option value="analytical_skip_only">analytical_skip_only</option>
              </select>
            </label>
            <label className="data-form-field">
              <span>{t('rulesSettings.countryLabel')}</span>
              <input value={policyForm.scope_country} onChange={(e) => setPolicyForm({ ...policyForm, scope_country: e.target.value })} />
            </label>
            <div className="data-form-actions">
              <button type="submit" className="btn-primary" disabled={busy}>{t('rulesSettings.addPolicy')}</button>
            </div>
          </form>
          {policies.length === 0 ? (
            <p className="data-hint">{t('rulesSettings.noPolicies')}</p>
          ) : (
            <ul className="data-list">
              {policies.map((p) => (
                <li key={p.id} className="data-row">
                  <div className="data-row-top">
                    <span>
                      #{p.recurring_item_id} · {p.policy_type} · {p.scope_country} · {p.state}
                    </span>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => handleTogglePolicy(p, p.state === 'active' ? 'retired' : 'active')}
                      disabled={busy}
                    >
                      {p.state === 'active' ? t('rulesSettings.retire') : t('rulesSettings.activate')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </DataSection>
  );
}
