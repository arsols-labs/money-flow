// Pure helper functions for MCP Access & Audit (Issue #501)

export const MCP_SECTIONS_STORAGE_KEY = 'mf_mcp_access_sections_v1';

export const DEFAULT_MCP_SECTIONS_STATE = {
  passkeysOpen: true,
  connectionsOpen: true,
  auditOpen: true,
};

export function loadMcpSectionsState(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return { ...DEFAULT_MCP_SECTIONS_STATE };
  try {
    const raw = storage.getItem(MCP_SECTIONS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MCP_SECTIONS_STATE };
    const parsed = JSON.parse(raw);
    return {
      passkeysOpen: parsed.passkeysOpen !== false,
      connectionsOpen: parsed.connectionsOpen !== false,
      auditOpen: parsed.auditOpen !== false,
    };
  } catch {
    return { ...DEFAULT_MCP_SECTIONS_STATE };
  }
}

export function saveMcpSectionsState(state, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try {
    storage.setItem(MCP_SECTIONS_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function isWriteTool(toolName) {
  if (!toolName) return false;
  const t = String(toolName).toLowerCase();
  return (
    t.includes('_add') ||
    t.includes('_update') ||
    t.includes('_delete') ||
    t.includes('_correct') ||
    t.includes('_set') ||
    t.includes('_skip') ||
    t.includes('_close') ||
    t.includes('_fulfill') ||
    t.includes('_cancel')
  );
}

export function filterAndSortAuditLogs(
  logs = [],
  {
    search = '',
    statusFilter = 'all',
    clientFilter = 'all',
    toolFilter = 'all',
    sortField = 'created_at',
    sortDir = 'desc',
  } = {}
) {
  const q = search.trim().toLowerCase();

  return logs
    .filter((log) => {
      if (statusFilter !== 'all' && log.status !== statusFilter) return false;
      if (clientFilter !== 'all' && log.client_id !== clientFilter) return false;
      if (toolFilter !== 'all' && log.tool_name !== toolFilter) return false;
      if (q) {
        const hay = [
          log.client_name,
          log.client_host,
          log.tool_name,
          log.result_summary,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortField === 'created_at') {
        const timeA = new Date(a.created_at).getTime() || 0;
        const timeB = new Date(b.created_at).getTime() || 0;
        cmp = timeA - timeB;
      } else if (sortField === 'client_name') {
        cmp = (a.client_name || '').localeCompare(b.client_name || '', 'ru');
      } else if (sortField === 'tool_name') {
        cmp = (a.tool_name || '').localeCompare(b.tool_name || '', 'ru');
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
}

/**
 * @param {Array<any>} logs
 * @param {number | 'all'} [limit=10]
 * @param {number} [visibleCount=10]
 * @returns {Array<any>}
 */
export function paginateAuditLogs(logs = [], limit = 10, visibleCount = 10) {
  if (limit === 'all') return logs;
  const count = typeof visibleCount === 'number' ? visibleCount : 10;
  return logs.slice(0, count);
}

