// Управление порядком, видимостью и расположением блоков экрана «Аналитика».
// Изолированное хранилище в localStorage под ключами mf_analytics_layout_v1 и mf_analytics_filters_v1.

export const ANALYTICS_STORAGE_KEY = 'mf_analytics_layout_v1';
export const ANALYTICS_FILTERS_STORAGE_KEY = 'mf_analytics_filters_v1';

export const ANALYTICS_BLOCK_DEFS = {
  metrics: {
    id: 'metrics',
    titleKey: 'analytics.blocks.metrics.title',
    descriptionKey: 'analytics.blocks.metrics.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'full',
  },
  trend: {
    id: 'trend',
    titleKey: 'analytics.blocks.trend.title',
    descriptionKey: 'analytics.blocks.trend.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'full',
  },
  top_items: {
    id: 'top_items',
    titleKey: 'analytics.blocks.top_items.title',
    descriptionKey: 'analytics.blocks.top_items.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'left',
  },
  categories: {
    id: 'categories',
    titleKey: 'analytics.blocks.categories.title',
    descriptionKey: 'analytics.blocks.categories.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'left',
  },
  subcategories: {
    id: 'subcategories',
    titleKey: 'analytics.blocks.subcategories.title',
    descriptionKey: 'analytics.blocks.subcategories.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'right',
  },
  merchants: {
    id: 'merchants',
    titleKey: 'analytics.blocks.merchants.title',
    descriptionKey: 'analytics.blocks.merchants.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'right',
  },
  recurring: {
    id: 'recurring',
    titleKey: 'analytics.blocks.recurring.title',
    descriptionKey: 'analytics.blocks.recurring.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'left',
  },
  receipts: {
    id: 'receipts',
    titleKey: 'analytics.blocks.receipts.title',
    descriptionKey: 'analytics.blocks.receipts.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'right',
  },
  fx_rates: {
    id: 'fx_rates',
    titleKey: 'analytics.blocks.fx_rates.title',
    descriptionKey: 'analytics.blocks.fx_rates.description',
    allowedColumns: ['auto', 'left', 'right', 'full'],
    defaultColumn: 'auto',
    autoColumn: 'full',
  },
};

export const DEFAULT_ANALYTICS_CONFIG = [
  { id: 'metrics', visible: true, column: 'auto' },
  { id: 'trend', visible: true, column: 'auto' },
  { id: 'top_items', visible: true, column: 'auto' },
  { id: 'categories', visible: true, column: 'auto' },
  { id: 'subcategories', visible: true, column: 'auto' },
  { id: 'merchants', visible: true, column: 'auto' },
  { id: 'recurring', visible: true, column: 'auto' },
  { id: 'receipts', visible: true, column: 'auto' },
  { id: 'fx_rates', visible: true, column: 'auto' },
];

export const DEFAULT_ANALYTICS_FILTERS = {
  period: 'd30',
  q: '',
  cats: [],
  merchants: [],
  accounts: [],
  currencies: [],
  trendGranularity: 'day',
  topItemsKind: 'expense',
  topItemsLimit: 10,
  recurringView: 'categories',
  recurringCat: '',
  recurringSubcat: '',
  topItemsOpen: true,
  categoriesOpen: true,
  subcategoriesOpen: true,
  merchantsOpen: true,
  recurringOpen: true,
  receiptsOpen: true,
};

/**
 * Определяет реальную колонку блока аналитики (с учётом режима 'auto').
 */
export function resolveAnalyticsBlockColumn(block) {
  if (!block) return 'left';
  if (block.column && block.column !== 'auto') {
    return block.column;
  }
  const def = ANALYTICS_BLOCK_DEFS[block.id];
  return def?.autoColumn || 'left';
}

export function cloneConfig(config) {
  return config.map((b) => ({ ...b }));
}

/**
 * Загружает конфигурацию блоков аналитики из localStorage с валидацией,
 * фильтрацией неизвестных ID и дополнением недостающих блоков.
 */
export function loadAnalyticsConfig() {
  if (typeof localStorage === 'undefined') {
    return cloneConfig(DEFAULT_ANALYTICS_CONFIG);
  }

  try {
    const raw = localStorage.getItem(ANALYTICS_STORAGE_KEY);
    if (!raw) return cloneConfig(DEFAULT_ANALYTICS_CONFIG);

    const parsed = JSON.parse(raw);
    const blocks = Array.isArray(parsed) ? parsed : parsed?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return cloneConfig(DEFAULT_ANALYTICS_CONFIG);
    }

    const seen = new Set();
    const result = [];

    for (const item of blocks) {
      if (!item || typeof item.id !== 'string') continue;
      const def = ANALYTICS_BLOCK_DEFS[item.id];
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

    // Добавляем недостающие блоки из конфигурации по умолчанию
    for (const defItem of DEFAULT_ANALYTICS_CONFIG) {
      if (!seen.has(defItem.id)) {
        result.push({ ...defItem });
      }
    }

    return result.length > 0 ? result : cloneConfig(DEFAULT_ANALYTICS_CONFIG);
  } catch {
    return cloneConfig(DEFAULT_ANALYTICS_CONFIG);
  }
}

/**
 * Сохраняет конфигурацию аналитики в localStorage.
 */
export function saveAnalyticsConfig(config) {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload = {
      version: 1,
      blocks: config.map(({ id, visible, column }) => ({ id, visible, column })),
    };
    localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

/**
 * Сбрасывает конфигурацию аналитики к эталонному значению и очищает хранилище.
 */
export function resetAnalyticsConfig() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(ANALYTICS_STORAGE_KEY);
    } catch {}
  }
  return cloneConfig(DEFAULT_ANALYTICS_CONFIG);
}

/**
 * Перемещает блок вверх или вниз в списке.
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
 * Перемещает блок из fromIndex в toIndex (drag-and-drop).
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
 * Переключает видимость блока (скрыть / вернуть).
 */
export function toggleBlockVisibility(config, id) {
  return config.map((b) => (b.id === id ? { ...b, visible: !b.visible } : { ...b }));
}

/**
 * Изменяет колонку размещения блока для широкого экрана.
 */
export function setBlockColumn(config, id, column, blockDefs = ANALYTICS_BLOCK_DEFS) {
  const def = blockDefs[id];
  if (!def || !def.allowedColumns.includes(column)) return cloneConfig(config);
  return config.map((b) => (b.id === id ? { ...b, column } : { ...b }));
}

/**
 * Загружает сохранённые фильтры экрана «Аналитика» из localStorage.
 */
export function loadAnalyticsFilters() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_ANALYTICS_FILTERS };
  try {
    const raw = localStorage.getItem(ANALYTICS_FILTERS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_ANALYTICS_FILTERS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_ANALYTICS_FILTERS };

    const validPeriods = ['d7', 'd30', 'm0', 'm1', 'all'];
    const validGranularities = ['day', 'week', 'month'];
    const validKinds = ['expense', 'income', 'refund'];
    const validViews = ['categories', 'daily', 'income'];

    return {
      period: validPeriods.includes(parsed.period) ? parsed.period : DEFAULT_ANALYTICS_FILTERS.period,
      q: typeof parsed.q === 'string' ? parsed.q : DEFAULT_ANALYTICS_FILTERS.q,
      cats: Array.isArray(parsed.cats) ? parsed.cats.filter((c) => typeof c === 'string') : [],
      merchants: Array.isArray(parsed.merchants) ? parsed.merchants.filter((m) => typeof m === 'string') : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter((a) => typeof a === 'string') : [],
      currencies: Array.isArray(parsed.currencies) ? parsed.currencies.filter((cur) => typeof cur === 'string') : [],
      trendGranularity: validGranularities.includes(parsed.trendGranularity)
        ? parsed.trendGranularity
        : DEFAULT_ANALYTICS_FILTERS.trendGranularity,
      topItemsKind: validKinds.includes(parsed.topItemsKind)
        ? parsed.topItemsKind
        : DEFAULT_ANALYTICS_FILTERS.topItemsKind,
      topItemsLimit: [10, 20, 50, 0].includes(parsed.topItemsLimit)
        ? parsed.topItemsLimit
        : DEFAULT_ANALYTICS_FILTERS.topItemsLimit,
      recurringView: validViews.includes(parsed.recurringView)
        ? parsed.recurringView
        : DEFAULT_ANALYTICS_FILTERS.recurringView,
      recurringCat: typeof parsed.recurringCat === 'string' ? parsed.recurringCat : '',
      recurringSubcat: typeof parsed.recurringSubcat === 'string' ? parsed.recurringSubcat : '',
      topItemsOpen: typeof parsed.topItemsOpen === 'boolean'
        ? parsed.topItemsOpen
        : DEFAULT_ANALYTICS_FILTERS.topItemsOpen,
      categoriesOpen: typeof parsed.categoriesOpen === 'boolean'
        ? parsed.categoriesOpen
        : DEFAULT_ANALYTICS_FILTERS.categoriesOpen,
      subcategoriesOpen: typeof parsed.subcategoriesOpen === 'boolean'
        ? parsed.subcategoriesOpen
        : DEFAULT_ANALYTICS_FILTERS.subcategoriesOpen,
      merchantsOpen: typeof parsed.merchantsOpen === 'boolean'
        ? parsed.merchantsOpen
        : DEFAULT_ANALYTICS_FILTERS.merchantsOpen,
      recurringOpen: typeof parsed.recurringOpen === 'boolean'
        ? parsed.recurringOpen
        : DEFAULT_ANALYTICS_FILTERS.recurringOpen,
      receiptsOpen: typeof parsed.receiptsOpen === 'boolean'
        ? parsed.receiptsOpen
        : DEFAULT_ANALYTICS_FILTERS.receiptsOpen,
    };
  } catch {
    return { ...DEFAULT_ANALYTICS_FILTERS };
  }
}

/**
 * Сохраняет фильтры «Аналитики» в localStorage.
 */
export function saveAnalyticsFilters(filters) {
  if (typeof localStorage === 'undefined' || !filters) return;
  try {
    const payload = {
      period: filters.period,
      q: filters.q,
      cats: Array.isArray(filters.cats) ? filters.cats : Array.from(filters.cats || []),
      merchants: Array.isArray(filters.merchants) ? filters.merchants : Array.from(filters.merchants || []),
      accounts: Array.isArray(filters.accounts) ? filters.accounts : Array.from(filters.accounts || []),
      currencies: Array.isArray(filters.currencies) ? filters.currencies : Array.from(filters.currencies || []),
      trendGranularity: filters.trendGranularity,
      topItemsKind: filters.topItemsKind,
      topItemsLimit: filters.topItemsLimit,
      recurringView: filters.recurringView,
      recurringCat: filters.recurringCat,
      recurringSubcat: filters.recurringSubcat,
      topItemsOpen: typeof filters.topItemsOpen === 'boolean' ? filters.topItemsOpen : true,
      categoriesOpen: typeof filters.categoriesOpen === 'boolean' ? filters.categoriesOpen : true,
      subcategoriesOpen: typeof filters.subcategoriesOpen === 'boolean' ? filters.subcategoriesOpen : true,
      merchantsOpen: typeof filters.merchantsOpen === 'boolean' ? filters.merchantsOpen : true,
      recurringOpen: typeof filters.recurringOpen === 'boolean' ? filters.recurringOpen : true,
      receiptsOpen: typeof filters.receiptsOpen === 'boolean' ? filters.receiptsOpen : true,
    };
    localStorage.setItem(ANALYTICS_FILTERS_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

/**
 * Сбрасывает сохранённые фильтры «Аналитики» к значениям по умолчанию.
 */
export function resetAnalyticsFilters() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(ANALYTICS_FILTERS_STORAGE_KEY);
    } catch {}
  }
  return { ...DEFAULT_ANALYTICS_FILTERS };
}
