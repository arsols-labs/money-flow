import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MCP_SECTIONS_STORAGE_KEY,
  DEFAULT_MCP_SECTIONS_STATE,
  loadMcpSectionsState,
  saveMcpSectionsState,
  isWriteTool,
  filterAndSortAuditLogs,
  paginateAuditLogs,
} from '../src/ui/mcpAccessHelper';

describe('mcpAccessHelper logic & persistence', () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = String(val);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    });
  });

  describe('Sections state persistence', () => {
    it('loads default sections state when storage is empty', () => {
      const state = loadMcpSectionsState();
      expect(state).toEqual(DEFAULT_MCP_SECTIONS_STATE);
      expect(state.passkeysOpen).toBe(true);
      expect(state.connectionsOpen).toBe(true);
      expect(state.auditOpen).toBe(true);
    });

    it('saves and reloads custom sections state', () => {
      saveMcpSectionsState({ passkeysOpen: false, connectionsOpen: false, auditOpen: true });
      const loaded = loadMcpSectionsState();
      expect(loaded.passkeysOpen).toBe(false);
      expect(loaded.connectionsOpen).toBe(false);
      expect(loaded.auditOpen).toBe(true);
    });

    it('gracefully handles corrupted JSON in storage', () => {
      store[MCP_SECTIONS_STORAGE_KEY] = '{ corrupted json';
      const state = loadMcpSectionsState();
      expect(state).toEqual(DEFAULT_MCP_SECTIONS_STATE);
    });
  });

  describe('isWriteTool', () => {
    it('identifies modifying tools correctly', () => {
      expect(isWriteTool('operation_add')).toBe(true);
      expect(isWriteTool('operation_update')).toBe(true);
      expect(isWriteTool('operation_delete')).toBe(true);
      expect(isWriteTool('transfer_add')).toBe(true);
      expect(isWriteTool('balance_correct')).toBe(true);
      expect(isWriteTool('planned_item_add')).toBe(true);
      expect(isWriteTool('recurring_item_skip_period')).toBe(true);
      expect(isWriteTool('recurring_item_cancel_period_fulfillment')).toBe(true);
    });

    it('identifies read-only tools correctly', () => {
      expect(isWriteTool('accounts_list')).toBe(false);
      expect(isWriteTool('analytics_get')).toBe(false);
      expect(isWriteTool('fx_rates_list')).toBe(false);
      expect(isWriteTool('operations_list')).toBe(false);
      expect(isWriteTool('')).toBe(false);
      expect(isWriteTool(null as unknown as string)).toBe(false);
    });
  });

  describe('filterAndSortAuditLogs', () => {
    const mockLogs = [
      {
        id: '1',
        created_at: '2026-09-09T10:00:00Z',
        client_id: 'c1',
        client_name: 'Cursor AI',
        client_host: 'cursor.sh',
        tool_name: 'accounts_list',
        status: 'success',
        result_summary: 'Найдено 4 счёта',
      },
      {
        id: '2',
        created_at: '2026-09-09T11:30:00Z',
        client_id: 'c2',
        client_name: 'Gemini Assistant',
        client_host: 'gemini.google.com',
        tool_name: 'operation_add',
        status: 'error',
        result_summary: 'Ошибка валидации суммы',
      },
      {
        id: '3',
        created_at: '2026-09-09T12:00:00Z',
        client_id: 'c1',
        client_name: 'Cursor AI',
        client_host: 'cursor.sh',
        tool_name: 'analytics_get',
        status: 'success',
        result_summary: 'Потрачено 1200 EUR',
      },
      {
        id: '4',
        created_at: '2026-09-09T09:00:00Z',
        client_id: 'c3',
        client_name: 'Claude Desktop',
        client_host: 'claude.ai',
        tool_name: 'operation_add',
        status: 'pending',
        result_summary: 'Ожидает подтверждения',
      },
    ];

    it('filters by status correctly', () => {
      const errors = filterAndSortAuditLogs(mockLogs, { statusFilter: 'error' });
      expect(errors).toHaveLength(1);
      expect(errors[0].id).toBe('2');

      const successes = filterAndSortAuditLogs(mockLogs, { statusFilter: 'success' });
      expect(successes).toHaveLength(2);
    });

    it('filters by client correctly', () => {
      const c1Logs = filterAndSortAuditLogs(mockLogs, { clientFilter: 'c1' });
      expect(c1Logs).toHaveLength(2);
      expect(c1Logs.every((l) => l.client_id === 'c1')).toBe(true);
    });

    it('filters by tool name correctly', () => {
      const opLogs = filterAndSortAuditLogs(mockLogs, { toolFilter: 'operation_add' });
      expect(opLogs).toHaveLength(2);
      expect(opLogs.every((l) => l.tool_name === 'operation_add')).toBe(true);
    });

    it('searches across client, tool and result text', () => {
      const searchCursor = filterAndSortAuditLogs(mockLogs, { search: 'cursor' });
      expect(searchCursor).toHaveLength(2);

      const searchSummary = filterAndSortAuditLogs(mockLogs, { search: 'валидации' });
      expect(searchSummary).toHaveLength(1);
      expect(searchSummary[0].id).toBe('2');
    });

    it('sorts by time descending by default', () => {
      const sorted = filterAndSortAuditLogs(mockLogs, { sortField: 'created_at', sortDir: 'desc' });
      expect(sorted[0].id).toBe('3'); // 12:00
      expect(sorted[1].id).toBe('2'); // 11:30
      expect(sorted[2].id).toBe('1'); // 10:00
      expect(sorted[3].id).toBe('4'); // 09:00
    });

    it('sorts by time ascending when requested', () => {
      const sorted = filterAndSortAuditLogs(mockLogs, { sortField: 'created_at', sortDir: 'asc' });
      expect(sorted[0].id).toBe('4'); // 09:00
      expect(sorted[3].id).toBe('3'); // 12:00
    });

    it('sorts by client name', () => {
      const sorted = filterAndSortAuditLogs(mockLogs, { sortField: 'client_name', sortDir: 'asc' });
      expect(sorted[0].client_name).toBe('Claude Desktop');
      expect(sorted[sorted.length - 1].client_name).toBe('Gemini Assistant');
    });

    it('sorts by tool name', () => {
      const sorted = filterAndSortAuditLogs(mockLogs, { sortField: 'tool_name', sortDir: 'asc' });
      expect(sorted[0].tool_name).toBe('accounts_list');
      expect(sorted[sorted.length - 1].tool_name).toBe('operation_add');
    });
  });

  describe('paginateAuditLogs', () => {
    const items = Array.from({ length: 35 }, (_, i) => ({ id: String(i + 1) }));

    it('slices items according to visibleCount', () => {
      const p10 = paginateAuditLogs(items, 10, 10);
      expect(p10).toHaveLength(10);
      expect(p10[0].id).toBe('1');
      expect(p10[9].id).toBe('10');

      const p20 = paginateAuditLogs(items, 10, 20);
      expect(p20).toHaveLength(20);
    });

    it('returns all items when limit is "all"', () => {
      const all = paginateAuditLogs(items, 'all', 10);
      expect(all).toHaveLength(35);
    });
  });
});
