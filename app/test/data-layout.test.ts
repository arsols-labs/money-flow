import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_DATA_CONFIG,
  DATA_BLOCK_DEFS,
  DATA_STORAGE_KEY,
  DATA_FILTERS_STORAGE_KEY,
  loadDataConfig,
  saveDataConfig,
  resetDataConfig,
  moveBlock,
  reorderBlock,
  toggleBlockVisibility,
  setBlockColumn,
  cloneConfig,
  resolveDataBlockColumn,
  loadDataFilters,
  saveDataFilters,
  resetDataFilters,
  DEFAULT_DATA_FILTERS,
} from '../src/ui/dataLayout';

interface BlockItem {
  id: string;
  visible: boolean;
  column: string;
}

describe('dataLayout logic & persistence (Issue #493)', () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => { store[key] = String(val); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; },
    });
  });

  it('loads default configuration on empty storage', () => {
    const config = loadDataConfig();
    expect(config).toEqual(DEFAULT_DATA_CONFIG);
    expect(config.length).toBe(7);
    expect(config.every((b: BlockItem) => b.visible)).toBe(true);
    expect(config.every((b: BlockItem) => b.column === 'full')).toBe(true);
  });

  it('saves and reloads custom configuration under isolated key', () => {
    const custom = [
      { id: 'operations', visible: true, column: 'full' },
      { id: 'receipts', visible: true, column: 'full' },
      { id: 'accounts', visible: false, column: 'full' },
      { id: 'planned', visible: true, column: 'full' },
      { id: 'recurring', visible: true, column: 'full' },
      { id: 'rates', visible: true, column: 'full' },
      { id: 'forecast', visible: false, column: 'full' },
    ];
    saveDataConfig(custom);
    expect(store[DATA_STORAGE_KEY]).toBeDefined();
    const loaded = loadDataConfig();
    expect(loaded).toEqual(custom);
  });

  it('handles corrupted or invalid JSON gracefully', () => {
    store[DATA_STORAGE_KEY] = 'not-a-valid-json{{{';
    const config = loadDataConfig();
    expect(config).toEqual(DEFAULT_DATA_CONFIG);
  });

  it('supplements missing blocks and filters out obsolete ones', () => {
    const partial = [
      { id: 'operations', visible: false, column: 'full' },
      { id: 'obsolete_data_block', visible: true, column: 'right' },
      { id: 'audit', visible: true, column: 'full' }, // audit is now obsolete in Data
    ];
    saveDataConfig(partial as any);
    const loaded = loadDataConfig();

    // operations preserved
    expect(loaded[0]).toEqual({ id: 'operations', visible: false, column: 'full' });
    // obsolete block and audit dropped
    expect(loaded.some((b: BlockItem) => b.id === 'obsolete_data_block')).toBe(false);
    expect(loaded.some((b: BlockItem) => b.id === 'audit')).toBe(false);
    // missing blocks added from defaults
    expect(loaded.length).toBe(7);
    expect(loaded.map((b: BlockItem) => b.id)).toContain('receipts');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('accounts');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('planned');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('recurring');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('rates');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('forecast');
  });

  it('validates column setting against allowedColumns', () => {
    const invalidCol = [
      { id: 'operations', visible: true, column: 'invalid_column_name' },
    ];
    saveDataConfig(invalidCol as any);
    const loaded = loadDataConfig();
    // falls back to defaultColumn for operations ('full')
    expect(loaded.find((b: BlockItem) => b.id === 'operations')?.column).toBe('full');
  });

  it('resets configuration back to defaults and cleans up localStorage', () => {
    const custom = [
      { id: 'operations', visible: false, column: 'full' },
      { id: 'accounts', visible: true, column: 'full' },
    ];
    saveDataConfig(custom);
    expect(store[DATA_STORAGE_KEY]).toBeDefined();

    const reset = resetDataConfig();
    expect(reset).toEqual(DEFAULT_DATA_CONFIG);
    expect(store[DATA_STORAGE_KEY]).toBeUndefined();
  });

  it('reorders blocks correctly with moveBlock', () => {
    const initial = cloneConfig(DEFAULT_DATA_CONFIG);
    const movedDown = moveBlock(initial, 0, 'down');
    expect(movedDown[0].id).toBe(initial[1].id);
    expect(movedDown[1].id).toBe(initial[0].id);

    // Boundary check
    const cantMoveUp = moveBlock(initial, 0, 'up');
    expect(cantMoveUp).toEqual(initial);

    const lastIdx = initial.length - 1;
    const cantMoveDown = moveBlock(initial, lastIdx, 'down');
    expect(cantMoveDown).toEqual(initial);
  });

  it('reorders blocks with reorderBlock (drag-and-drop)', () => {
    const initial = cloneConfig(DEFAULT_DATA_CONFIG);
    // Move first item (operations) to 3rd position
    const reordered = reorderBlock(initial, 0, 2);
    expect(reordered[0].id).toBe(initial[1].id);
    expect(reordered[1].id).toBe(initial[2].id);
    expect(reordered[2].id).toBe(initial[0].id);
  });

  it('toggles block visibility correctly', () => {
    const initial = cloneConfig(DEFAULT_DATA_CONFIG);
    expect(initial[0].visible).toBe(true);

    const toggled = toggleBlockVisibility(initial, 'operations');
    expect(toggled.find((b: BlockItem) => b.id === 'operations')?.visible).toBe(false);

    const toggledBack = toggleBlockVisibility(toggled, 'operations');
    expect(toggledBack.find((b: BlockItem) => b.id === 'operations')?.visible).toBe(true);
  });

  it('sets block column layout', () => {
    const initial = cloneConfig(DEFAULT_DATA_CONFIG);
    const updated = setBlockColumn(initial, 'operations', 'full');
    expect(updated.find((b: BlockItem) => b.id === 'operations')?.column).toBe('full');

    // Disallowed column is ignored
    const unchanged = setBlockColumn(initial, 'operations', 'non_existent_column');
    expect(unchanged).toEqual(initial);
  });

  it('resolves autoColumn correctly', () => {
    expect(resolveDataBlockColumn({ id: 'operations', column: 'auto', visible: true })).toBe('full');
    expect(resolveDataBlockColumn({ id: 'receipts', column: 'auto', visible: true })).toBe('full');
    expect(resolveDataBlockColumn({ id: 'accounts', column: 'auto', visible: true })).toBe('full');
    expect(resolveDataBlockColumn({ id: 'recurring', column: 'auto', visible: true })).toBe('full');
    expect(resolveDataBlockColumn({ id: 'planned', column: 'auto', visible: true })).toBe('full');
    expect(resolveDataBlockColumn({ id: 'rates', column: 'auto', visible: true })).toBe('full');
    expect(resolveDataBlockColumn({ id: 'forecast', column: 'auto', visible: true })).toBe('full');
  });

  describe('filters and section expansion persistence (Issue #493)', () => {
    it('loads defaults when no filters stored', () => {
      const filters = loadDataFilters();
      expect(filters).toEqual(DEFAULT_DATA_FILTERS);
      expect(filters.search).toBe('');
      expect(filters.operationsOpen).toBe(false);
      expect(filters.receiptsOpen).toBe(false);
      expect(filters.accountsOpen).toBe(false);
      expect(filters.plannedOpen).toBe(false);
      expect(filters.recurringOpen).toBe(false);
      expect(filters.ratesOpen).toBe(false);
      expect(filters.operationsLimit).toBe(10);
    });

    it('migrates from legacy money-flow-v2.data-sections.expanded if modern key missing', () => {
      store['money-flow-v2.data-sections.expanded'] = JSON.stringify(['accounts', 'rates']);
      const filters = loadDataFilters();
      expect(filters.accountsOpen).toBe(true);
      expect(filters.ratesOpen).toBe(true);
      expect(filters.operationsOpen).toBe(false);
      expect(filters.plannedOpen).toBe(false);
      expect(filters.recurringOpen).toBe(false);
    });

    it('saves and reloads filters with section collapse states', () => {
      const customFilters = {
        ...DEFAULT_DATA_FILTERS,
        search: 'магазин',
        operationsOpen: false,
        accountsOpen: true,
        plannedOpen: false,
        recurringOpen: true,
        ratesOpen: false,
        archivedAccountsOpen: true,
        donePlannedOpen: true,
        pausedRecurringOpen: true,
        operationsLimit: 50 as const,
      };

      saveDataFilters(customFilters);
      expect(store[DATA_FILTERS_STORAGE_KEY]).toBeDefined();

      const loaded = loadDataFilters();
      expect(loaded).toEqual(customFilters);

      // Verify legacy key was also written back for compatibility
      expect(store['money-flow-v2.data-sections.expanded']).toBeDefined();
      const legacy = JSON.parse(store['money-flow-v2.data-sections.expanded']);
      expect(legacy).toContain('accounts');
      expect(legacy).toContain('recurring');
      expect(legacy).not.toContain('operations');
      expect(legacy).not.toContain('rates');
    });

    it('resets filters to defaults and removes storage key', () => {
      saveDataFilters({ ...DEFAULT_DATA_FILTERS, search: 'test', operationsLimit: 100 });
      expect(store[DATA_FILTERS_STORAGE_KEY]).toBeDefined();

      const reset = resetDataFilters();
      expect(reset).toEqual(DEFAULT_DATA_FILTERS);
      expect(store[DATA_FILTERS_STORAGE_KEY]).toBeUndefined();
    });
  });

  it('keeps data layout completely isolated from pulse and analytics', () => {
    store['mf_dashboard_layout_v1'] = JSON.stringify([{ id: 'metrics', visible: true }]);
    store['mf_analytics_layout_v1'] = JSON.stringify([{ id: 'trend', visible: true }]);

    saveDataConfig([{ id: 'operations', visible: false, column: 'left' }]);

    expect(store['mf_dashboard_layout_v1']).toBe(JSON.stringify([{ id: 'metrics', visible: true }]));
    expect(store['mf_analytics_layout_v1']).toBe(JSON.stringify([{ id: 'trend', visible: true }]));
  });
});
