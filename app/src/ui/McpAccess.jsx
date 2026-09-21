// S2-2: Access screen and MCP call log (issue #262)

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Shield, ShieldAlert, KeyRound, ExternalLink, Trash2, CheckCircle2,
  AlertCircle, Clock, Globe, Plus, Copy, Check, X, Search,
  ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';
import { api } from './api';
import { useRefreshNonce } from './RefreshContext';
import { CollapsibleSection } from './components';
import PasskeysSection from './PasskeysSection';
import { plural } from './money';
import { intlLocale } from './language';
import {
  loadMcpSectionsState,
  saveMcpSectionsState,
  isWriteTool,
  filterAndSortAuditLogs,
  paginateAuditLogs,
} from './mcpAccessHelper';

function formatDateTime(iso, locale) {
  if (!iso) return '—';
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

function StatusCell({ status }) {
  const { t } = useTranslation();
  const [showTooltip, setShowTooltip] = useState(false);
  const cellRef = useRef(null);

  useEffect(() => {
    if (!showTooltip) return;
    const handleOutside = (e) => {
      if (cellRef.current && !cellRef.current.contains(e.target)) {
        setShowTooltip(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setShowTooltip(false);
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showTooltip]);

  const isSuccess = status === 'success';
  const isPending = status === 'pending';
  const label = isSuccess
    ? t('access.audit.success')
    : isPending
      ? t('access.audit.pending')
      : t('access.audit.errors');
  const Icon = isSuccess ? CheckCircle2 : isPending ? Clock : AlertCircle;
  const statusClass = isSuccess ? 'status-icon--success' : isPending ? 'status-icon--pending' : 'status-icon--error';

  return (
    <td className="audit-status-cell" ref={cellRef}>
      <div className="status-cell-wrap">
        <button
          type="button"
          className={`status-icon-btn ${statusClass}`}
          onClick={() => setShowTooltip((v) => !v)}
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
          onFocus={() => setShowTooltip(true)}
          onBlur={() => setShowTooltip(false)}
          aria-label={t('access.audit.statusLabel', { label })}
          title={label}
        >
          <Icon size={16} />
        </button>
        {showTooltip && (
          <div className="status-popover" role="tooltip">
            <span className="status-popover-text">{label}</span>
          </div>
        )}
      </div>
    </td>
  );
}

function ResultCell({ result }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!result) {
    return <td className="audit-result-cell audit-result-cell--empty">—</td>;
  }

  const isLong = result.length > 70 || result.includes('\n');

  const handleCopy = (e) => {
    e.stopPropagation();
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <td className="audit-result-cell">
      <div className="audit-result-content">
        <div className={`audit-result-text ${expanded ? 'audit-result-text--expanded' : ''}`}>
          {result}
        </div>
        <div className="audit-result-actions">
          {isLong && (
            <button
              type="button"
              className="btn-result-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t('common.collapse') : t('common.expand')}
            </button>
          )}
          <button
            type="button"
            className={`btn-copy-result ${copied ? 'btn-copy-result--copied' : ''}`}
            onClick={handleCopy}
            title={copied ? t('common.copied') : t('common.copy')}
            aria-label={copied ? t('common.copied') : t('common.copy')}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? t('common.copied') : t('common.copy')}</span>
          </button>
        </div>
      </div>
    </td>
  );
}

function SortableTh({ field, sortField, sortDir, onSort, label, title }) {
  const { t } = useTranslation();
  const isActive = sortField === field;
  return (
    <th
      className="sortable-th"
      onClick={() => onSort(field)}
      title={title || t('access.audit.sortBy', { label })}
    >
      <div className="th-sort-content">
        <span>{label}</span>
        {isActive ? (
          sortDir === 'asc' ? (
            <ArrowUp size={12} className="th-sort-icon th-sort-icon--active" />
          ) : (
            <ArrowDown size={12} className="th-sort-icon th-sort-icon--active" />
          )
        ) : (
          <ArrowUpDown size={12} className="th-sort-icon" />
        )}
      </div>
    </th>
  );
}

function CreateClientModal({ onClose, onCreated }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [createdCredentials, setCreatedCredentials] = useState(null);
  const [copiedField, setCopiedField] = useState(null);

  const handleCopy = (field, text) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createMcpClient({ name: name.trim() });
      setCreatedCredentials(res);
      onCreated();
    } catch (err) {
      setError(err.message || t('access.connect.createFailed'));
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
            <span>{createdCredentials ? t('access.connect.createdTitle') : t('access.connect.title')}</span>
          </div>
          <button type="button" className="mcp-modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {createdCredentials ? (
          <>
            <div className="mcp-modal-body">
              <div className="notice-banner notice-banner--success">
                <CheckCircle2 size={16} />
                <div>
                  {t('access.connect.clientRegistered', { name: createdCredentials.clientName })}
                </div>
              </div>

              <div className="notice-banner notice-banner--warning">
                <AlertCircle size={16} />
                <div>
                  {t('access.connect.secretWarning')}
                </div>
              </div>

              <div className="mcp-credential-box">
                <span className="mcp-credential-label">{t('access.connect.mcpEndpoint')}</span>
                <div className="mcp-credential-row">
                  <span className="mcp-credential-value">{window.location.origin}/mcp</span>
                  <button
                    type="button"
                    className={`btn-copy ${copiedField === 'url' ? 'btn-copy--success' : ''}`}
                    onClick={() => handleCopy('url', `${window.location.origin}/mcp`)}
                  >
                    {copiedField === 'url' ? <Check size={12} /> : <Copy size={12} />}
                    <span>{copiedField === 'url' ? t('common.copied') : t('common.copy')}</span>
                  </button>
                </div>
              </div>

              <div className="mcp-credential-box">
                <span className="mcp-credential-label">Client ID</span>
                <div className="mcp-credential-row">
                  <span className="mcp-credential-value">{createdCredentials.clientId}</span>
                  <button
                    type="button"
                    className={`btn-copy ${copiedField === 'clientId' ? 'btn-copy--success' : ''}`}
                    onClick={() => handleCopy('clientId', createdCredentials.clientId)}
                  >
                    {copiedField === 'clientId' ? <Check size={12} /> : <Copy size={12} />}
                    <span>{copiedField === 'clientId' ? t('common.copied') : t('common.copy')}</span>
                  </button>
                </div>
              </div>

              <div className="mcp-credential-box">
                <span className="mcp-credential-label">Client Secret</span>
                <div className="mcp-credential-row">
                  <span className="mcp-credential-value">{createdCredentials.clientSecret}</span>
                  <button
                    type="button"
                    className={`btn-copy ${copiedField === 'secret' ? 'btn-copy--success' : ''}`}
                    onClick={() => handleCopy('secret', createdCredentials.clientSecret)}
                  >
                    {copiedField === 'secret' ? <Check size={12} /> : <Copy size={12} />}
                    <span>{copiedField === 'secret' ? t('common.copied') : t('common.copy')}</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="mcp-modal-footer">
              <button type="button" className="btn-primary" onClick={onClose}>
                {t('common.done')}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="mcp-modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                {t('access.connect.intro')}
              </p>

              <label className="data-form-field">
                <span>{t('access.connect.appName')}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('access.connect.appNamePlaceholder')}
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
              <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
                {busy ? t('access.connect.creating') : t('access.connect.issueKeys')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function McpAccess({ demoMode = false }) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const refreshNonce = useRefreshNonce();
  const [clients, setClients] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [revokingId, setRevokingId] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Collapsible sections persisted in localStorage
  const [sectionsState, setSectionsState] = useState(loadMcpSectionsState);

  const toggleSection = (key) => {
    setSectionsState((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveMcpSectionsState(next);
      return next;
    });
  };

  // Filters, search, sort, and pagination for the call log
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | success | error | pending
  const [clientFilter, setClientFilter] = useState('all');
  const [toolFilter, setToolFilter] = useState('all');
  const [sortField, setSortField] = useState('created_at');
  const [sortDir, setSortDir] = useState('desc');
  const [limit, setLimit] = useState(10);
  const [visibleCount, setVisibleCount] = useState(10);

  const changeLimit = (n) => {
    setLimit(n);
    setVisibleCount(n === 'all' ? Number.MAX_SAFE_INTEGER : n);
  };

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'created_at' ? 'desc' : 'asc');
    }
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accessRes, auditRes] = await Promise.all([
        api.getMcpAccess(),
        api.getMcpAudit(),
      ]);
      setClients(accessRes.clients || []);
      setLogs(auditRes.logs || []);
    } catch (err) {
      setError(err.message || t('access.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData, refreshNonce]);

  const handleRevokeToken = async (tokenId) => {
    if (!window.confirm(t('access.token.revokeConfirm'))) {
      return;
    }
    setRevokingId(tokenId);
    try {
      await api.revokeMcpToken(tokenId);
      await loadData();
    } catch (err) {
      alert(`${t('access.token.revokeFailed')}: ${err.message}`);
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeClient = async (clientId, clientName) => {
    if (!window.confirm(t('access.token.revokeClientConfirm', { name: clientName }))) {
      return;
    }
    setRevokingId(clientId);
    try {
      await api.revokeMcpClient(clientId);
      await loadData();
    } catch (err) {
      alert(`${t('access.token.revokeClientFailed')}: ${err.message}`);
    } finally {
      setRevokingId(null);
    }
  };

  const activeClients = useMemo(() => clients.filter((c) => c.tokens && c.tokens.length > 0), [clients]);

  // Options for the filter dropdowns
  const clientOptions = useMemo(() => {
    const map = new Map();
    for (const l of logs) {
      if (l.client_id && !map.has(l.client_id)) {
        map.set(l.client_id, l.client_name || l.client_id);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [logs]);

  const toolOptions = useMemo(() => {
    const set = new Set();
    for (const l of logs) {
      if (l.tool_name) set.add(l.tool_name);
    }
    return Array.from(set).sort();
  }, [logs]);

  // Call-log statistics
  const successCount = useMemo(() => logs.filter((l) => l.status === 'success').length, [logs]);
  const errorCount = useMemo(() => logs.filter((l) => l.status === 'error').length, [logs]);
  const pendingCount = useMemo(() => logs.filter((l) => l.status === 'pending').length, [logs]);
  const successRate = logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 100;
  const errorRate = logs.length > 0 ? Math.round((errorCount / logs.length) * 100) : 0;

  // Filtered and sorted list
  const filteredLogs = useMemo(() => {
    return filterAndSortAuditLogs(logs, {
      search,
      statusFilter,
      clientFilter,
      toolFilter,
      sortField,
      sortDir,
    });
  }, [logs, search, statusFilter, clientFilter, toolFilter, sortField, sortDir]);

  // Paginated list for display
  const visibleLogs = useMemo(() => {
    return paginateAuditLogs(filteredLogs, limit, visibleCount);
  }, [filteredLogs, limit, visibleCount]);

  const hiddenCount = filteredLogs.length - visibleLogs.length;

  const hasActiveFilters = search.trim() !== '' || statusFilter !== 'all' || clientFilter !== 'all' || toolFilter !== 'all';

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setClientFilter('all');
    setToolFilter('all');
  };

  const connectAction = (
    <button
      type="button"
      className="topbar-btn topbar-btn--primary"
      onClick={(e) => {
        e.stopPropagation();
        setShowCreateModal(true);
      }}
      title={t('access.connect.newApp')}
    >
      <Plus size={14} />
      <span>{t('access.connect.connect')}</span>
    </button>
  );

  return (
    <div className="screen">
      {showCreateModal && (
        <CreateClientModal
          onClose={() => setShowCreateModal(false)}
          onCreated={loadData}
        />
      )}

      {error && (
        <div className="card notice-banner notice-banner--danger">
          <ShieldAlert size={18} />
          <div>{error}</div>
        </div>
      )}

      {loading && !clients.length && !logs.length ? (
        <div className="card loading-state">{t('access.loading')}</div>
      ) : (
        <>
          {/* Section 1: Devices and passkeys (issue #507) */}
          <PasskeysSection
            open={sectionsState.passkeysOpen}
            onToggle={() => toggleSection('passkeysOpen')}
            refreshNonce={refreshNonce}
            demoMode={demoMode}
          />

          {/* Section 2: Connections */}
          <CollapsibleSection
            title={t('access.connections.title')}
            subtitle={String(activeClients.length)}
            open={sectionsState.connectionsOpen}
            onToggle={() => toggleSection('connectionsOpen')}
            actions={connectAction}
            collapsedActions={connectAction}
          >
            {activeClients.length === 0 ? (
              <div className="empty-state">
                <Shield size={32} style={{ opacity: 0.4, marginBottom: 8 }} />
                <div>{t('access.connections.empty')}</div>
                <div className="empty-state-sub">
                  {t('access.connections.emptyHint')}
                </div>
                <button
                  type="button"
                  className="topbar-btn topbar-btn--primary"
                  style={{ marginTop: 12 }}
                  onClick={() => setShowCreateModal(true)}
                >
                  <Plus size={14} />
                  <span>{t('access.connect.connect')}</span>
                </button>
              </div>
            ) : (
              <div className="mcp-clients-list">
                {activeClients.map((client) => (
                  <div key={client.id} className="mcp-client-card">
                    <div className="mcp-client-header">
                      <div className="mcp-client-title-group">
                        <div className="mcp-client-name">{client.name}</div>
                        <div className="mcp-host-badge" title={t('access.connections.verifiedHost')}>
                          <Globe size={12} />
                          <span>{client.client_host}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn-danger-outline"
                        onClick={() => handleRevokeClient(client.id, client.name)}
                        disabled={revokingId === client.id}
                      >
                        <Trash2 size={13} />
                        <span>{t('access.connections.revokeAll')}</span>
                      </button>
                    </div>

                    {client.metadata_document_url && (
                      <div className="mcp-client-meta-url">
                        <a
                          href={client.metadata_document_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="external-meta-link"
                        >
                          <span>Client Metadata Document</span>
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    )}

                    <div className="mcp-tokens-list">
                      {client.tokens.map((token, idx) => {
                        const isWrite = token.scopes.includes('write');
                        return (
                          <div key={token.id || idx} className="mcp-token-row">
                            <div className="mcp-token-info">
                              <div className="mcp-token-scopes">
                                <span className={`scope-pill ${isWrite ? 'scope-pill--write' : 'scope-pill--read'}`}>
                                  {isWrite ? t('access.scope.readWrite') : t('access.scope.readOnly')}
                                </span>
                              </div>
                              <div className="mcp-token-meta-grid">
                                <div>
                                  <span className="meta-label">{t('access.token.connected')}</span>
                                  <span className="meta-value">{formatDateTime(token.created_at, locale)}</span>
                                </div>
                                <div>
                                  <span className="meta-label">{t('access.token.expires')}</span>
                                  <span className="meta-value">{token.expires_at ? formatDateTime(token.expires_at, locale) : t('access.token.neverExpires')}</span>
                                </div>
                                <div>
                                  <span className="meta-label">{t('access.token.used')}</span>
                                  <span className="meta-value">{token.last_used_at ? formatDateTime(token.last_used_at, locale) : t('access.token.neverUsed')}</span>
                                </div>
                                <div>
                                  <span className="meta-label">{t('access.token.from')}</span>
                                  <span className="meta-value">
                                    {[token.last_country, token.last_ip].filter(Boolean).join(' · ') || '—'}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="mcp-token-actions">
                              <button
                                type="button"
                                className="btn-revoke-single"
                                onClick={() => handleRevokeToken(token.id)}
                                disabled={revokingId === token.id}
                                title={t('access.token.revokeTitle')}
                              >
                                {t('access.token.revoke')}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* Section 2: Call log */}
          <CollapsibleSection
            title={t('access.audit.title')}
            subtitle={String(logs.length)}
            open={sectionsState.auditOpen}
            onToggle={() => toggleSection('auditOpen')}
          >
            {logs.length === 0 ? (
              <div className="empty-state">
                <Clock size={32} style={{ opacity: 0.4, marginBottom: 8 }} />
                <div>{t('access.audit.empty')}</div>
                <div className="empty-state-sub">
                  {t('access.audit.emptyHint')}
                </div>
              </div>
            ) : (
              <>
                {/* Toolbar: search, filters, and status statistics */}
                <div className="mcp-audit-toolbar">
                  <div className="mcp-audit-toolbar-top">
                    <div className="mcp-audit-search-box">
                      <Search size={14} className="mcp-audit-search-icon" />
                      <input
                        type="text"
                        className="mcp-audit-search-input"
                        placeholder={t('access.audit.searchPlaceholder')}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label={t('access.audit.searchAria')}
                      />
                      {search && (
                        <button
                          type="button"
                          className="mcp-audit-search-clear"
                          onClick={() => setSearch('')}
                          title={t('access.audit.clearSearch')}
                          aria-label={t('access.audit.clearSearch')}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>

                    <div className="mcp-audit-selects-row">
                      {clientOptions.length > 1 && (
                        <select
                          className="mcp-filter-select"
                          value={clientFilter}
                          onChange={(e) => setClientFilter(e.target.value)}
                          aria-label={t('access.audit.client')}
                        >
                          <option value="all">{t('access.audit.allClients')}</option>
                          {clientOptions.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      )}

                      {toolOptions.length > 1 && (
                        <select
                          className="mcp-filter-select"
                          value={toolFilter}
                          onChange={(e) => setToolFilter(e.target.value)}
                          aria-label={t('access.audit.tool')}
                        >
                          <option value="all">{t('access.audit.allTools')}</option>
                          {toolOptions.map((toolName) => (
                            <option key={toolName} value={toolName}>{toolName}</option>
                          ))}
                        </select>
                      )}

                      {hasActiveFilters && (
                        <button
                          type="button"
                          className="btn-reset-filters"
                          onClick={resetFilters}
                          title={t('access.audit.resetFiltersTitle')}
                        >
                          <X size={12} />
                          <span>{t('common.reset')}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* One horizontal scrolling row of status chips with inline statistics */}
                  <div className="mcp-status-filter-scroll" role="group" aria-label={t('access.audit.statusAria')}>
                    <button
                      type="button"
                      className={`mcp-status-chip ${statusFilter === 'all' ? 'mcp-status-chip--active' : ''}`}
                      onClick={() => setStatusFilter('all')}
                    >
                      <span className="mcp-status-chip-label">{t('common.all')}</span>
                      <span className="mcp-status-chip-count">{logs.length}</span>
                    </button>

                    {successCount > 0 && (
                      <button
                        type="button"
                        className={`mcp-status-chip ${statusFilter === 'success' ? 'mcp-status-chip--active' : ''}`}
                        onClick={() => setStatusFilter('success')}
                      >
                        <CheckCircle2 size={13} className="mcp-status-chip-icon mcp-status-chip-icon--success" />
                        <span className="mcp-status-chip-label">{t('access.audit.success')}</span>
                        <span className="mcp-status-chip-count">{successCount} ({successRate}%)</span>
                      </button>
                    )}

                    {errorCount > 0 && (
                      <button
                        type="button"
                        className={`mcp-status-chip ${statusFilter === 'error' ? 'mcp-status-chip--active' : ''}`}
                        onClick={() => setStatusFilter('error')}
                      >
                        <AlertCircle size={13} className="mcp-status-chip-icon mcp-status-chip-icon--error" />
                        <span className="mcp-status-chip-label">{t('access.audit.errors')}</span>
                        <span className="mcp-status-chip-count">{errorCount} ({errorRate}%)</span>
                      </button>
                    )}

                    {pendingCount > 0 && (
                      <button
                        type="button"
                        className={`mcp-status-chip ${statusFilter === 'pending' ? 'mcp-status-chip--active' : ''}`}
                        onClick={() => setStatusFilter('pending')}
                      >
                        <Clock size={13} className="mcp-status-chip-icon mcp-status-chip-icon--pending" />
                        <span className="mcp-status-chip-label">{t('access.audit.pending')}</span>
                        <span className="mcp-status-chip-count">{pendingCount}</span>
                      </button>
                    )}
                  </div>
                </div>

                {filteredLogs.length === 0 ? (
                  <div className="empty-state">
                    <Search size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
                    <div>{t('access.audit.noResults')}</div>
                    <div className="empty-state-sub">
                      {t('access.audit.noResultsHint')}
                    </div>
                    <button
                      type="button"
                      className="link-btn"
                      style={{ marginTop: 8 }}
                      onClick={resetFilters}
                    >
                      {t('access.audit.resetFilters')}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="mcp-audit-table-wrapper">
                      <table className="mcp-audit-table">
                        <thead>
                          <tr>
                            <th className="audit-th-status" aria-label={t('access.audit.statusLabel', { label: '' })} />
                            <SortableTh
                              field="created_at"
                              sortField={sortField}
                              sortDir={sortDir}
                              onSort={handleSort}
                              label={t('access.audit.time')}
                            />
                            <SortableTh
                              field="client_name"
                              sortField={sortField}
                              sortDir={sortDir}
                              onSort={handleSort}
                              label={t('access.audit.client')}
                            />
                            <SortableTh
                              field="tool_name"
                              sortField={sortField}
                              sortDir={sortDir}
                              onSort={handleSort}
                              label={t('access.audit.tool')}
                            />
                            <th>{t('access.audit.result')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleLogs.map((log) => (
                            <tr key={log.id}>
                              <StatusCell status={log.status} />
                              <td className="audit-time-cell">{formatDateTime(log.created_at, locale)}</td>
                              <td>
                                <div className="audit-client-cell">
                                  <span className="audit-client-name">{log.client_name}</span>
                                  <span className="audit-client-host">{log.client_host}</span>
                                </div>
                              </td>
                              <td className="audit-tool-cell">
                                <span className={`audit-tool-tag ${isWriteTool(log.tool_name) ? 'audit-tool-tag--write' : 'audit-tool-tag--read'}`}>
                                  <code>{log.tool_name}</code>
                                </span>
                              </td>
                              <ResultCell result={log.result_summary} />
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination and Show more */}
                    <div className="mcp-audit-pagination">
                      {hiddenCount > 0 && limit !== 'all' && (
                        <button
                          type="button"
                          className="btn-show-more-audit"
                          onClick={() => setVisibleCount((c) => c + 10)}
                        >
                          {t('common.showMore', { count: hiddenCount })}
                        </button>
                      )}
                      <div className="mcp-audit-pagination-row">
                        <label className="mcp-audit-limit-selector">
                          <span>{t('access.audit.showLimit')}</span>
                          <select
                            value={limit}
                            onChange={(e) => changeLimit(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                          >
                            <option value={10}>10</option>
                            <option value={20}>20</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                            <option value="all">{t('common.all')}</option>
                          </select>
                        </label>
                        <span>
                          {filteredLogs.length !== logs.length
                            ? t('access.audit.paginationTotal', {
                              shown: visibleLogs.length,
                              filtered: filteredLogs.length,
                              total: logs.length,
                            })
                            : t('access.audit.pagination', {
                              shown: visibleLogs.length,
                              filtered: filteredLogs.length,
                            })}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </CollapsibleSection>
        </>
      )}
    </div>
  );
}
