// Controls the order, visibility, and placement of blocks on the "Pulse" dashboard.
// Isolated localStorage under the key mf_dashboard_layout_v1.

export const DASHBOARD_STORAGE_KEY = 'mf_dashboard_layout_v1';
export const PULSE_FILTERS_STORAGE_KEY = 'mf_pulse_filters_v1';

export const DASHBOARD_BLOCK_DEFS = {
  metrics: {
    id: 'metrics',
    titleKey: 'dashboard.blocks.metrics.title',
    descriptionKey: 'dashboard.blocks.metrics.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'left',
  },
  warnings: {
    id: 'warnings',
    titleKey: 'dashboard.blocks.warnings.title',
    descriptionKey: 'dashboard.blocks.warnings.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'left',
  },
  forecast: {
    id: 'forecast',
    titleKey: 'dashboard.blocks.forecast.title',
    descriptionKey: 'dashboard.blocks.forecast.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'full',
  },
  upcoming: {
    id: 'upcoming',
    titleKey: 'dashboard.blocks.upcoming.title',
    descriptionKey: 'dashboard.blocks.upcoming.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'right',
  },
  accounts: {
    id: 'accounts',
    titleKey: 'dashboard.blocks.accounts.title',
    descriptionKey: 'dashboard.blocks.accounts.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'right',
  },
  fx_rates: {
    id: 'fx_rates',
    titleKey: 'dashboard.blocks.fx_rates.title',
    descriptionKey: 'dashboard.blocks.fx_rates.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'full',
  },
};

export const DEFAULT_DASHBOARD_CONFIG = [
  { id: 'metrics', visible: true, column: 'auto' },
  { id: 'warnings', visible: true, column: 'auto' },
  { id: 'forecast', visible: true, column: 'auto' },
  { id: 'upcoming', visible: true, column: 'auto' },
  { id: 'accounts', visible: true, column: 'auto' },
  { id: 'fx_rates', visible: true, column: 'auto' },
];

export const DEFAULT_PULSE_FILTERS = {
  forecastPeriod: 'month',
  forecastGroupMode: 'country',
  spentPeriod: 'today',
  warningsFilter: 'all',
  upcomingRange: 'month',
  upcomingFilter: 'all',
  accountsGroupMode: 'owner',
  upcomingOpen: true,
  accountsOpen: true,
};

/**
 * Resolves a block's actual column (taking the 'auto' mode into account).
 */
export function resolveBlockColumn(block) {
  if (!block) return 'left';
  if (block.column && block.column !== 'auto') {
    return block.column;
  }
  const def = DASHBOARD_BLOCK_DEFS[block.id];
  return def?.autoColumn || 'left';
}

export function cloneConfig(config) {
  return config.map((b) => ({ ...b }));
}

/**
 * Loads the configuration from localStorage with safe validation,
 * filtering of unknown IDs, and filling in of missing blocks.
 */
export function loadDashboardConfig() {
  if (typeof localStorage === 'undefined') {
    return cloneConfig(DEFAULT_DASHBOARD_CONFIG);
  }

  try {
    const raw = localStorage.getItem(DASHBOARD_STORAGE_KEY);
    if (!raw) return cloneConfig(DEFAULT_DASHBOARD_CONFIG);

    const parsed = JSON.parse(raw);
    const blocks = Array.isArray(parsed) ? parsed : parsed?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return cloneConfig(DEFAULT_DASHBOARD_CONFIG);
    }

    const seen = new Set();
    const result = [];

    for (const item of blocks) {
      if (!item || typeof item.id !== 'string') continue;
      const def = DASHBOARD_BLOCK_DEFS[item.id];
      if (!def || seen.has(item.id)) continue;
      seen.add(item.id);

      const column = def.allowedColumns.includes(item.column)
        ? item.column
        : def.defaultColumn;

      result.push({
        id: item.id,
        visible: typeof item.visible === 'boolean' ? item.visible : true,
        column,
      });
    }

    // Add new blocks that were not in the saved configuration
    for (const defItem of DEFAULT_DASHBOARD_CONFIG) {
      if (!seen.has(defItem.id)) {
        result.push({ ...defItem });
      }
    }

    return result.length > 0 ? result : cloneConfig(DEFAULT_DASHBOARD_CONFIG);
  } catch {
    return cloneConfig(DEFAULT_DASHBOARD_CONFIG);
  }
}

/**
 * Saves the configuration to localStorage.
 */
export function saveDashboardConfig(config) {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload = {
      version: 1,
      blocks: config.map(({ id, visible, column }) => ({ id, visible, column })),
    };
    localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

/**
 * Resets the configuration to the factory value and clears storage.
 */
export function resetDashboardConfig() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(DASHBOARD_STORAGE_KEY);
    } catch {}
  }
  return cloneConfig(DEFAULT_DASHBOARD_CONFIG);
}

/**
 * Moves a block up or down in the list.
 */
export function moveBlock(config, index, direction) {
  if (!Array.isArray(config)) return [];
  const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
  const targetIndex = index + delta;

  if (index < 0 || index >= config.length || targetIndex < 0 || targetIndex >= config.length) {
    return cloneConfig(config);
  }

  const next = cloneConfig(config);
  const temp = next[index];
  next[index] = next[targetIndex];
  next[targetIndex] = temp;
  return next;
}

/**
 * Moves a block from fromIndex to toIndex (drag-and-drop).
 */
export function reorderBlock(config, fromIndex, toIndex) {
  if (!Array.isArray(config)) return [];
  if (
    fromIndex < 0 ||
    fromIndex >= config.length ||
    toIndex < 0 ||
    toIndex >= config.length ||
    fromIndex === toIndex
  ) {
    return cloneConfig(config);
  }

  const next = cloneConfig(config);
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed);
  return next;
}

/**
 * Toggles a block's visibility (hide / restore).
 */
export function toggleBlockVisibility(config, id) {
  return config.map((b) => (b.id === id ? { ...b, visible: !b.visible } : { ...b }));
}

/**
 * Changes a block's column placement for a wide screen.
 */
export function setBlockColumn(config, id, column, blockDefs = DASHBOARD_BLOCK_DEFS) {
  const def = (blockDefs && blockDefs[id]) || DASHBOARD_BLOCK_DEFS[id];
  if (!def || !def.allowedColumns || !def.allowedColumns.includes(column)) return cloneConfig(config);
  return config.map((b) => (b.id === id ? { ...b, column } : { ...b }));
}

/**
 * Loads saved filters for "Pulse" blocks from localStorage.
 */
export function loadPulseFilters() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PULSE_FILTERS };
  try {
    const raw = localStorage.getItem(PULSE_FILTERS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PULSE_FILTERS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PULSE_FILTERS };
    return {
      forecastPeriod: ['month', 'quarter', 'half', 'year'].includes(parsed.forecastPeriod)
        ? parsed.forecastPeriod
        : DEFAULT_PULSE_FILTERS.forecastPeriod,
      forecastGroupMode: ['country', 'account', 'user'].includes(parsed.forecastGroupMode)
        ? parsed.forecastGroupMode
        : DEFAULT_PULSE_FILTERS.forecastGroupMode,
      spentPeriod: ['today', 'yesterday', 'week', 'month'].includes(parsed.spentPeriod)
        ? parsed.spentPeriod
        : DEFAULT_PULSE_FILTERS.spentPeriod,
      warningsFilter: typeof parsed.warningsFilter === 'string' && parsed.warningsFilter
        ? parsed.warningsFilter
        : DEFAULT_PULSE_FILTERS.warningsFilter,
      upcomingRange: ['week', 'month'].includes(parsed.upcomingRange)
        ? parsed.upcomingRange
        : DEFAULT_PULSE_FILTERS.upcomingRange,
      upcomingFilter: ['all', 'income', 'expense'].includes(parsed.upcomingFilter)
        ? parsed.upcomingFilter
        : DEFAULT_PULSE_FILTERS.upcomingFilter,
      accountsGroupMode: ['owner', 'country'].includes(parsed.accountsGroupMode)
        ? parsed.accountsGroupMode
        : DEFAULT_PULSE_FILTERS.accountsGroupMode,
      upcomingOpen: typeof parsed.upcomingOpen === 'boolean'
        ? parsed.upcomingOpen
        : DEFAULT_PULSE_FILTERS.upcomingOpen,
      accountsOpen: typeof parsed.accountsOpen === 'boolean'
        ? parsed.accountsOpen
        : DEFAULT_PULSE_FILTERS.accountsOpen,
    };
  } catch {
    return { ...DEFAULT_PULSE_FILTERS };
  }
}

/**
 * Saves filters for "Pulse" blocks to localStorage.
 */
export function savePulseFilters(filters) {
  if (typeof localStorage === 'undefined' || !filters) return;
  try {
    localStorage.setItem(PULSE_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {}
}

/**
 * Resets the saved filters to their default values.
 */
export function resetPulseFilters() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(PULSE_FILTERS_STORAGE_KEY);
    } catch {}
  }
  return { ...DEFAULT_PULSE_FILTERS };
}

