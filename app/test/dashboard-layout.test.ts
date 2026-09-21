import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_DASHBOARD_CONFIG,
  DASHBOARD_BLOCK_DEFS,
  DASHBOARD_STORAGE_KEY,
  loadDashboardConfig,
  saveDashboardConfig,
  resetDashboardConfig,
  moveBlock,
  reorderBlock,
  toggleBlockVisibility,
  setBlockColumn,
  cloneConfig,
  resolveBlockColumn,
  loadPulseFilters,
  savePulseFilters,
  resetPulseFilters,
  DEFAULT_PULSE_FILTERS,
} from '../src/ui/dashboardLayout';

interface BlockItem {
  id: string;
  visible: boolean;
  column: string;
}

describe('dashboardLayout logic & persistence', () => {
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
    const config = loadDashboardConfig();
    expect(config).toEqual(DEFAULT_DASHBOARD_CONFIG);
    expect(config.length).toBe(6);
    expect(config.every((b: BlockItem) => b.visible)).toBe(true);
  });

  it('saves and reloads custom configuration', () => {
    const custom = [
      { id: 'accounts', visible: true, column: 'left' },
      { id: 'metrics', visible: false, column: 'right' },
      { id: 'forecast', visible: true, column: 'full' },
      { id: 'upcoming', visible: true, column: 'right' },
      { id: 'warnings', visible: false, column: 'left' },
      { id: 'fx_rates', visible: true, column: 'full' },
    ];
    saveDashboardConfig(custom);
    const loaded = loadDashboardConfig();
    expect(loaded).toEqual(custom);
  });

  it('handles corrupted or invalid JSON gracefully', () => {
    store[DASHBOARD_STORAGE_KEY] = 'not-a-valid-json{{{';
    const config = loadDashboardConfig();
    expect(config).toEqual(DEFAULT_DASHBOARD_CONFIG);
  });

  it('supplements missing blocks and filters out obsolete ones', () => {
    const partial = [
      { id: 'accounts', visible: false, column: 'left' },
      { id: 'obsolete_block_xyz', visible: true, column: 'right' },
    ];
    saveDashboardConfig(partial as any);
    const loaded = loadDashboardConfig();

    // accounts preserved with its settings
    expect(loaded[0]).toEqual({ id: 'accounts', visible: false, column: 'left' });
    // obsolete block dropped
    expect(loaded.some((b: BlockItem) => b.id === 'obsolete_block_xyz')).toBe(false);
    // missing blocks added from defaults
    expect(loaded.length).toBe(6);
    expect(loaded.map((b: BlockItem) => b.id)).toContain('metrics');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('forecast');
  });

  it('validates column setting against allowedColumns', () => {
    const invalidCol = [
      { id: 'accounts', visible: true, column: 'invalid_column_name' },
    ];
    saveDashboardConfig(invalidCol as any);
    const loaded = loadDashboardConfig();
    // falls back to defaultColumn for accounts
    expect(loaded.find((b: BlockItem) => b.id === 'accounts')?.column).toBe(DASHBOARD_BLOCK_DEFS.accounts.defaultColumn);
  });

  it('resets configuration and cleans storage', () => {
    saveDashboardConfig([{ id: 'accounts', visible: false, column: 'left' }] as any);
    expect(store[DASHBOARD_STORAGE_KEY]).toBeDefined();

    const reset = resetDashboardConfig();
    expect(reset).toEqual(DEFAULT_DASHBOARD_CONFIG);
    expect(store[DASHBOARD_STORAGE_KEY]).toBeUndefined();
  });

  it('moves blocks up and down with boundary safeguards', () => {
    const initial = cloneConfig(DEFAULT_DASHBOARD_CONFIG);

    // Moving first item up should do nothing
    const noopUp = moveBlock(initial, 0, 'up');
    expect(noopUp[0].id).toBe(initial[0].id);

    // Moving first item down swaps with second
    const movedDown = moveBlock(initial, 0, 'down');
    expect(movedDown[0].id).toBe(initial[1].id);
    expect(movedDown[1].id).toBe(initial[0].id);

    // Moving last item down should do nothing
    const lastIdx = initial.length - 1;
    const noopDown = moveBlock(initial, lastIdx, 'down');
    expect(noopDown[lastIdx].id).toBe(initial[lastIdx].id);

    // Moving last item up swaps with previous
    const movedUp = moveBlock(initial, lastIdx, 'up');
    expect(movedUp[lastIdx].id).toBe(initial[lastIdx - 1].id);
    expect(movedUp[lastIdx - 1].id).toBe(initial[lastIdx].id);
  });

  it('reorders blocks via arbitrary fromIndex to toIndex', () => {
    const initial = cloneConfig(DEFAULT_DASHBOARD_CONFIG);
    // Move last item to index 0
    const reordered = reorderBlock(initial, 5, 0);
    expect(reordered[0].id).toBe(initial[5].id);
    expect(reordered[1].id).toBe(initial[0].id);
    expect(reordered.length).toBe(6);

    // Out of bounds checks
    expect(reorderBlock(initial, -1, 2)).toEqual(initial);
    expect(reorderBlock(initial, 2, 99)).toEqual(initial);
    expect(reorderBlock(initial, 2, 2)).toEqual(initial);
  });

  it('toggles visibility cleanly', () => {
    const initial = cloneConfig(DEFAULT_DASHBOARD_CONFIG);
    const hidden = toggleBlockVisibility(initial, 'forecast');
    expect(hidden.find((b: BlockItem) => b.id === 'forecast')?.visible).toBe(false);

    const restored = toggleBlockVisibility(hidden, 'forecast');
    expect(restored.find((b: BlockItem) => b.id === 'forecast')?.visible).toBe(true);
  });

  it('updates desktop column', () => {
    const initial = cloneConfig(DEFAULT_DASHBOARD_CONFIG);
    const updated = setBlockColumn(initial, 'forecast', 'left');
    expect(updated.find((b: BlockItem) => b.id === 'forecast')?.column).toBe('left');

    const invalid = setBlockColumn(initial, 'forecast', 'nonexistent_col' as any);
    expect(invalid.find((b: BlockItem) => b.id === 'forecast')?.column).toBe('auto');
  });

  it('updates column with custom blockDefs', () => {
    const customConfig = [{ id: 'custom_block', visible: true, column: 'auto' }];
    const customDefs = {
      custom_block: { id: 'custom_block', allowedColumns: ['auto', 'left', 'full'] },
    };
    const updated = setBlockColumn(customConfig as any, 'custom_block', 'full', customDefs as any);
    expect(updated[0].column).toBe('full');
  });

  it('resolves block columns correctly including auto mode', () => {
    expect(resolveBlockColumn({ id: 'metrics', column: 'auto' })).toBe('left');
    expect(resolveBlockColumn({ id: 'warnings', column: 'auto' })).toBe('left');
    expect(resolveBlockColumn({ id: 'forecast', column: 'auto' })).toBe('full');
    expect(resolveBlockColumn({ id: 'upcoming', column: 'auto' })).toBe('right');
    expect(resolveBlockColumn({ id: 'accounts', column: 'auto' })).toBe('right');
    expect(resolveBlockColumn({ id: 'fx_rates', column: 'auto' })).toBe('full');

    // Explicit overrides
    expect(resolveBlockColumn({ id: 'forecast', column: 'left' })).toBe('left');
    expect(resolveBlockColumn({ id: 'metrics', column: 'full' })).toBe('full');
  });

  it('handles pulse filters persistence and reset', () => {
    const defaultFilters = loadPulseFilters();
    expect(defaultFilters).toEqual(DEFAULT_PULSE_FILTERS);

    const customFilters = {
      forecastPeriod: 'year',
      forecastGroupMode: 'account',
      spentPeriod: 'week',
      warningsFilter: 'country',
      upcomingRange: 'week',
      upcomingFilter: 'expense',
      accountsGroupMode: 'country',
      upcomingOpen: false,
      accountsOpen: false,
    };
    savePulseFilters(customFilters);
    expect(loadPulseFilters()).toEqual(customFilters);

    const reset = resetPulseFilters();
    expect(reset).toEqual(DEFAULT_PULSE_FILTERS);
    expect(loadPulseFilters()).toEqual(DEFAULT_PULSE_FILTERS);
  });
});
