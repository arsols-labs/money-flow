// Управление порядком, видимостью и расположением блоков экрана «Данные».
// Изолированное хранилище в localStorage под ключами mf_data_layout_v1 и mf_data_filters_v1.
import { readExpanded, writeExpanded } from './dataSections';

export const DATA_STORAGE_KEY = 'mf_data_layout_v1';
export const DATA_FILTERS_STORAGE_KEY = 'mf_data_filters_v1';

export const DATA_BLOCK_DEFS = {
  operations: {
    id: 'operations',
    titleKey: 'data.blocks.operations.title',
    descriptionKey: 'data.blocks.operations.description',
    allowedColumns: ['full'],
    defaultColumn: 'full',
    autoColumn: 'full',
  },
  receipts: {
    id: 'receipts',
    titleKey: 'data.blocks.receipts.title',
    descriptionKey: 'data.blocks.receipts.description',
    allowedColumns: ['full'],
    defaultColumn: 'full',
    autoColumn: 'full',
  },
  accounts: {
    id: 'accounts',
    titleKey: 'data.blocks.accounts.title',
    descriptionKey: 'data.blocks.accounts.description',
    allowedColumns: ['full'],
    defaultColumn: 'full',
    autoColumn: 'full',
  },
  planned: {
    id: 'planned',
    titleKey: 'data.blocks.planned.title',
    descriptionKey: 'data.blocks.planned.description',
    allowedColumns: ['full'],
    defaultColumn: 'full',
    autoColumn: 'full',
  },
  recurring: {
    id: 'recurring',
    titleKey: 'data.blocks.recurring.title',
    descriptionKey: 'data.blocks.recurring.description',
    allowedColumns: ['full'],
    defaultColumn: 'full',
    autoColumn: 'full',
  },
  rates: {
    id: 'rates',
    titleKey: 'data.blocks.rates.title',
    descriptionKey: 'data.blocks.rates.description',
    allowedColumns: ['full'],
    defaultColumn: 'full',
    autoColumn: 'full',
  },
  forecast: {
    id: 'forecast',
    titleKey: 'data.blocks.forecast.title',
    descriptionKey: 'data.blocks.forecast.description',
    allowedColumns: ['full'],
    defaultColumn: 'full',
    autoColumn: 'full',
  },
};

export const DEFAULT_DATA_CONFIG = [
  { id: 'operations', visible: true, column: 'full' },
  { id: 'receipts', visible: true, column: 'full' },
  { id: 'accounts', visible: true, column: 'full' },
  { id: 'planned', visible: true, column: 'full' },
  { id: 'recurring', visible: true, column: 'full' },
  { id: 'rates', visible: true, column: 'full' },
  { id: 'forecast', visible: true, column: 'full' },
];

export const DEFAULT_DATA_FILTERS = {
  search: '',
  operationsOpen: false,
  receiptsOpen: false,
  accountsOpen: false,
  plannedOpen: false,
  recurringOpen: false,
  ratesOpen: false,
  archivedAccountsOpen: false,
  donePlannedOpen: false,
  pausedRecurringOpen: false,
  operationsLimit: 10,
};

/**
 * Определяет реальную колонку блока (с учётом режима 'auto').
 */
export function resolveDataBlockColumn(block) {
  if (!block) return 'full';
  if (block.column && block.column !== 'auto') {
    return block.column;
  }
  const def = DATA_BLOCK_DEFS[block.id];
  return def?.autoColumn || 'full';
}

export function cloneConfig(config) {
  return config.map((b) => ({ ...b }));
}

/**
 * Загружает конфигурацию блоков экрана «Данные» из localStorage с валидацией,
 * фильтрацией неизвестных ID и дополнением недостающих блоков.
 */
export function loadDataConfig() {
  if (typeof localStorage === 'undefined') {
    return cloneConfig(DEFAULT_DATA_CONFIG);
  }

  try {
    const raw = localStorage.getItem(DATA_STORAGE_KEY);
    if (!raw) return cloneConfig(DEFAULT_DATA_CONFIG);

    const parsed = JSON.parse(raw);
    const blocks = Array.isArray(parsed) ? parsed : parsed?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return cloneConfig(DEFAULT_DATA_CONFIG);
    }

    const seen = new Set();
    const result = [];

    for (const item of blocks) {
      if (!item || typeof item.id !== 'string') continue;
      const def = DATA_BLOCK_DEFS[item.id];
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
    for (const defItem of DEFAULT_DATA_CONFIG) {
      if (!seen.has(defItem.id)) {
        result.push({ ...defItem });
      }
    }

    return result.length > 0 ? result : cloneConfig(DEFAULT_DATA_CONFIG);
  } catch {
    return cloneConfig(DEFAULT_DATA_CONFIG);
  }
}

/**
 * Сохраняет конфигурацию экрана «Данные» в localStorage.
 */
export function saveDataConfig(config) {
  if (typeof localStorage === 'undefined' || !Array.isArray(config)) return;
  try {
    const payload = {
      version: 1,
      blocks: config.map(({ id, visible, column }) => ({ id, visible, column })),
    };
    localStorage.setItem(DATA_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

/**
 * Сбрасывает конфигурацию экрана «Данные» к эталонному значению и очищает хранилище.
 */
export function resetDataConfig() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(DATA_STORAGE_KEY);
    } catch {}
  }
  return cloneConfig(DEFAULT_DATA_CONFIG);
}

/**
 * Загружает фильтры и состояния блоков экрана «Данные» из localStorage.
 */
export function loadDataFilters() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_DATA_FILTERS };
  try {
    const raw = localStorage.getItem(DATA_FILTERS_STORAGE_KEY);
    if (!raw) {
      // Fallback на legacy хранилище раскрытых секций
      const legacyExpanded = readExpanded();
      if (Array.isArray(legacyExpanded) && legacyExpanded.length > 0) {
        return {
          ...DEFAULT_DATA_FILTERS,
          operationsOpen: legacyExpanded.includes('operations'),
          receiptsOpen: legacyExpanded.includes('receipts'),
          accountsOpen: legacyExpanded.includes('accounts'),
          plannedOpen: legacyExpanded.includes('planned'),
          recurringOpen: legacyExpanded.includes('recurring'),
          ratesOpen: legacyExpanded.includes('rates'),
        };
      }
      return { ...DEFAULT_DATA_FILTERS };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_DATA_FILTERS };

    const validLimits = [10, 20, 50, 100, 'all'];

    return {
      search: typeof parsed.search === 'string' ? parsed.search : DEFAULT_DATA_FILTERS.search,
      operationsOpen: typeof parsed.operationsOpen === 'boolean'
        ? parsed.operationsOpen
        : DEFAULT_DATA_FILTERS.operationsOpen,
      receiptsOpen: typeof parsed.receiptsOpen === 'boolean'
        ? parsed.receiptsOpen
        : DEFAULT_DATA_FILTERS.receiptsOpen,
      accountsOpen: typeof parsed.accountsOpen === 'boolean'
        ? parsed.accountsOpen
        : DEFAULT_DATA_FILTERS.accountsOpen,
      plannedOpen: typeof parsed.plannedOpen === 'boolean'
        ? parsed.plannedOpen
        : DEFAULT_DATA_FILTERS.plannedOpen,
      recurringOpen: typeof parsed.recurringOpen === 'boolean'
        ? parsed.recurringOpen
        : DEFAULT_DATA_FILTERS.recurringOpen,
      ratesOpen: typeof parsed.ratesOpen === 'boolean'
        ? parsed.ratesOpen
        : DEFAULT_DATA_FILTERS.ratesOpen,
      archivedAccountsOpen: typeof parsed.archivedAccountsOpen === 'boolean'
        ? parsed.archivedAccountsOpen
        : DEFAULT_DATA_FILTERS.archivedAccountsOpen,
      donePlannedOpen: typeof parsed.donePlannedOpen === 'boolean'
        ? parsed.donePlannedOpen
        : DEFAULT_DATA_FILTERS.donePlannedOpen,
      pausedRecurringOpen: typeof parsed.pausedRecurringOpen === 'boolean'
        ? parsed.pausedRecurringOpen
        : DEFAULT_DATA_FILTERS.pausedRecurringOpen,
      operationsLimit: validLimits.includes(parsed.operationsLimit)
        ? parsed.operationsLimit
        : DEFAULT_DATA_FILTERS.operationsLimit,
    };
  } catch {
    return { ...DEFAULT_DATA_FILTERS };
  }
}

/**
 * Сохраняет фильтры и состояния блоков экрана «Данные» в localStorage.
 */
export function saveDataFilters(filters) {
  if (typeof localStorage === 'undefined' || !filters) return;
  try {
    const payload = {
      search: filters.search ?? '',
      operationsOpen: Boolean(filters.operationsOpen),
      receiptsOpen: Boolean(filters.receiptsOpen),
      accountsOpen: Boolean(filters.accountsOpen),
      plannedOpen: Boolean(filters.plannedOpen),
      recurringOpen: Boolean(filters.recurringOpen),
      ratesOpen: Boolean(filters.ratesOpen),
      archivedAccountsOpen: Boolean(filters.archivedAccountsOpen),
      donePlannedOpen: Boolean(filters.donePlannedOpen),
      pausedRecurringOpen: Boolean(filters.pausedRecurringOpen),
      operationsLimit: filters.operationsLimit ?? 10,
    };
    localStorage.setItem(DATA_FILTERS_STORAGE_KEY, JSON.stringify(payload));

    // Синхронизируем с legacy хранилищем для совместимости с внешними читателями
    const openSections = [];
    if (payload.operationsOpen) openSections.push('operations');
    if (payload.receiptsOpen) openSections.push('receipts');
    if (payload.plannedOpen) openSections.push('planned');
    if (payload.recurringOpen) openSections.push('recurring');
    if (payload.ratesOpen) openSections.push('rates');
    if (payload.accountsOpen) openSections.push('accounts');
    writeExpanded(openSections);
  } catch {}
}

/**
 * Сбрасывает сохранённые фильтры экрана «Данные» к значениям по умолчанию.
 */
export function resetDataFilters() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(DATA_FILTERS_STORAGE_KEY);
    } catch {}
  }
  return { ...DEFAULT_DATA_FILTERS };
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
  if (fromIndex < 0 || fromIndex >= config.length || toIndex < 0 || toIndex >= config.length) {
    return cloneConfig(config);
  }
  if (fromIndex === toIndex) return cloneConfig(config);

  const next = cloneConfig(config);
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed);
  return next;
}

/**
 * Переключает видимость блока.
 */
export function toggleBlockVisibility(config, id) {
  if (!Array.isArray(config)) return [];
  return config.map((b) => (b.id === id ? { ...b, visible: !b.visible } : { ...b }));
}

/**
 * Изменяет колонку размещения блока для широкого экрана.
 */
export function setBlockColumn(config, id, column, blockDefs = DATA_BLOCK_DEFS) {
  const def = (blockDefs && blockDefs[id]) || DATA_BLOCK_DEFS[id];
  if (!def || !def.allowedColumns || !def.allowedColumns.includes(column)) return cloneConfig(config);
  return config.map((b) => (b.id === id ? { ...b, column } : { ...b }));
}
