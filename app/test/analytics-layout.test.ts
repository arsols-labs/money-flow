import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_ANALYTICS_CONFIG,
  ANALYTICS_BLOCK_DEFS,
  ANALYTICS_STORAGE_KEY,
  ANALYTICS_FILTERS_STORAGE_KEY,
  loadAnalyticsConfig,
  saveAnalyticsConfig,
  resetAnalyticsConfig,
  moveBlock,
  reorderBlock,
  toggleBlockVisibility,
  setBlockColumn,
  cloneConfig,
  resolveAnalyticsBlockColumn,
  loadAnalyticsFilters,
  saveAnalyticsFilters,
  resetAnalyticsFilters,
  DEFAULT_ANALYTICS_FILTERS,
} from '../src/ui/analyticsLayout';

interface BlockItem {
  id: string;
  visible: boolean;
  column: string;
}

describe('analyticsLayout logic & persistence', () => {
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
    const config = loadAnalyticsConfig();
    expect(config).toEqual(DEFAULT_ANALYTICS_CONFIG);
    expect(config.length).toBe(9);
    expect(config.every((b: BlockItem) => b.visible)).toBe(true);
    expect(config.every((b: BlockItem) => b.column === 'auto')).toBe(true);
  });

  it('saves and reloads custom configuration under isolated key', () => {
    const custom = [
      { id: 'top_items', visible: true, column: 'left' },
      { id: 'metrics', visible: false, column: 'full' },
      { id: 'trend', visible: true, column: 'right' },
      { id: 'categories', visible: true, column: 'left' },
      { id: 'subcategories', visible: false, column: 'right' },
      { id: 'merchants', visible: true, column: 'right' },
      { id: 'recurring', visible: true, column: 'full' },
      { id: 'receipts', visible: true, column: 'left' },
      { id: 'fx_rates', visible: true, column: 'full' },
    ];
    saveAnalyticsConfig(custom);
    expect(store[ANALYTICS_STORAGE_KEY]).toBeDefined();
    const loaded = loadAnalyticsConfig();
    expect(loaded).toEqual(custom);
  });

  it('handles corrupted or invalid JSON gracefully', () => {
    store[ANALYTICS_STORAGE_KEY] = 'not-a-valid-json{{{';
    const config = loadAnalyticsConfig();
    expect(config).toEqual(DEFAULT_ANALYTICS_CONFIG);
  });

  it('supplements missing blocks and filters out obsolete ones', () => {
    const partial = [
      { id: 'top_items', visible: false, column: 'left' },
      { id: 'obsolete_analytics_block', visible: true, column: 'right' },
    ];
    saveAnalyticsConfig(partial as any);
    const loaded = loadAnalyticsConfig();

    // top_items preserved
    expect(loaded[0]).toEqual({ id: 'top_items', visible: false, column: 'left' });
    // obsolete block dropped
    expect(loaded.some((b: BlockItem) => b.id === 'obsolete_analytics_block')).toBe(false);
    // missing blocks added from defaults
    expect(loaded.length).toBe(9);
    expect(loaded.map((b: BlockItem) => b.id)).toContain('metrics');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('trend');
    expect(loaded.map((b: BlockItem) => b.id)).toContain('receipts');
  });

  it('validates column setting against allowedColumns', () => {
    const invalidCol = [
      { id: 'metrics', visible: true, column: 'invalid_column_name' },
    ];
    saveAnalyticsConfig(invalidCol as any);
    const loaded = loadAnalyticsConfig();
    // falls back to defaultColumn for metrics
    expect(loaded.find((b: BlockItem) => b.id === 'metrics')?.column).toBe(ANALYTICS_BLOCK_DEFS.metrics.defaultColumn);
  });

  it('resets configuration and cleans storage', () => {
    saveAnalyticsConfig([{ id: 'top_items', visible: false, column: 'left' }] as any);
    expect(store[ANALYTICS_STORAGE_KEY]).toBeDefined();

    const reset = resetAnalyticsConfig();
    expect(reset).toEqual(DEFAULT_ANALYTICS_CONFIG);
    expect(store[ANALYTICS_STORAGE_KEY]).toBeUndefined();
  });

  it('moves blocks up and down with boundary safeguards', () => {
    const initial = cloneConfig(DEFAULT_ANALYTICS_CONFIG);

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
    const initial = cloneConfig(DEFAULT_ANALYTICS_CONFIG);
    // Move last item to index 0
    const reordered = reorderBlock(initial, 8, 0);
    expect(reordered[0].id).toBe(initial[8].id);
    expect(reordered[1].id).toBe(initial[0].id);
    expect(reordered.length).toBe(9);

    // Out of bounds checks
    expect(reorderBlock(initial, -1, 2)).toEqual(initial);
    expect(reorderBlock(initial, 2, 99)).toEqual(initial);
    expect(reorderBlock(initial, 2, 2)).toEqual(initial);
  });

  it('toggles visibility cleanly', () => {
    const initial = cloneConfig(DEFAULT_ANALYTICS_CONFIG);
    const hidden = toggleBlockVisibility(initial, 'trend');
    expect(hidden.find((b: BlockItem) => b.id === 'trend')?.visible).toBe(false);

    const restored = toggleBlockVisibility(hidden, 'trend');
    expect(restored.find((b: BlockItem) => b.id === 'trend')?.visible).toBe(true);
  });

  it('updates desktop column', () => {
    const initial = cloneConfig(DEFAULT_ANALYTICS_CONFIG);
    const updated = setBlockColumn(initial, 'trend', 'left');
    expect(updated.find((b: BlockItem) => b.id === 'trend')?.column).toBe('left');

    const invalid = setBlockColumn(initial, 'trend', 'nonexistent_col' as any);
    expect(invalid.find((b: BlockItem) => b.id === 'trend')?.column).toBe('auto');
  });

  it('resolves block columns correctly including auto mode', () => {
    expect(resolveAnalyticsBlockColumn({ id: 'metrics', column: 'auto' })).toBe('full');
    expect(resolveAnalyticsBlockColumn({ id: 'trend', column: 'auto' })).toBe('full');
    expect(resolveAnalyticsBlockColumn({ id: 'top_items', column: 'auto' })).toBe('left');
    expect(resolveAnalyticsBlockColumn({ id: 'categories', column: 'auto' })).toBe('left');
    expect(resolveAnalyticsBlockColumn({ id: 'subcategories', column: 'auto' })).toBe('right');
    expect(resolveAnalyticsBlockColumn({ id: 'merchants', column: 'auto' })).toBe('right');
    expect(resolveAnalyticsBlockColumn({ id: 'recurring', column: 'auto' })).toBe('left');
    expect(resolveAnalyticsBlockColumn({ id: 'receipts', column: 'auto' })).toBe('right');
    expect(resolveAnalyticsBlockColumn({ id: 'fx_rates', column: 'auto' })).toBe('full');

    // Explicit overrides
    expect(resolveAnalyticsBlockColumn({ id: 'top_items', column: 'full' })).toBe('full');
    expect(resolveAnalyticsBlockColumn({ id: 'metrics', column: 'left' })).toBe('left');
  });

  it('handles analytics filters persistence and reset under mf_analytics_filters_v1', () => {
    const defaultFilters = loadAnalyticsFilters();
    expect(defaultFilters).toEqual(DEFAULT_ANALYTICS_FILTERS);

    const customFilters = {
      period: 'm1',
      q: 'coffee',
      cats: ['Кафе', 'Продукты'],
      merchants: ['Starbucks'],
      accounts: ['Main USD'],
      currencies: ['USD'],
      trendGranularity: 'month',
      topItemsKind: 'income',
      topItemsLimit: 20,
      recurringView: 'daily',
      recurringCat: 'Подписки',
      recurringSubcat: 'Музыка',
      topItemsOpen: false,
      categoriesOpen: false,
      subcategoriesOpen: true,
      merchantsOpen: false,
      recurringOpen: false,
      receiptsOpen: false,
    };
    saveAnalyticsFilters(customFilters);
    expect(store[ANALYTICS_FILTERS_STORAGE_KEY]).toBeDefined();
    expect(loadAnalyticsFilters()).toEqual(customFilters);

    const reset = resetAnalyticsFilters();
    expect(reset).toEqual(DEFAULT_ANALYTICS_FILTERS);
    expect(loadAnalyticsFilters()).toEqual(DEFAULT_ANALYTICS_FILTERS);
    expect(store[ANALYTICS_FILTERS_STORAGE_KEY]).toBeUndefined();
  });

  it('handles corrupted or non-boolean collapsible section states safely', () => {
    store[ANALYTICS_FILTERS_STORAGE_KEY] = JSON.stringify({
      topItemsOpen: 'false', // string instead of boolean
      categoriesOpen: 123,   // number instead of boolean
      receiptsOpen: null,    // null instead of boolean
    });

    const loaded = loadAnalyticsFilters();
    expect(loaded.topItemsOpen).toBe(true);
    expect(loaded.categoriesOpen).toBe(true);
    expect(loaded.receiptsOpen).toBe(true);
    expect(loaded.merchantsOpen).toBe(true);
  });
});
