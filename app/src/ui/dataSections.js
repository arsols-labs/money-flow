// Состояние «свёрнут / развёрнут» блоков экрана «Данные» (issue #260).
//
// Хранится в localStorage, а не в settings D1: запись на каждый клик по
// заголовку и расширение SETTINGS_WRITABLE_KEYS дороже пользы (решение
// владельца 2026-08-12). Названная цена — состояние своё на каждом устройстве:
// развернул на телефоне, на ноутбуке осталось свёрнуто.
//
// Порядок блоков здесь НЕ дублируется — он задан порядком JSX в Data.jsx и
// живёт там же, где рендер. Список ключей нужен только для того, чтобы
// отсеять мусор из хранилища и не тащить в состояние экрана то, чего в коде
// уже нет.

export const DATA_SECTION_KEYS = ['operations', 'receipts', 'planned', 'recurring', 'rates', 'accounts'];

export const DATA_SECTIONS_STORAGE_KEY = 'money-flow-v2.data-sections.expanded';

/**
 * Разбор сохранённого значения. Всё, что не похоже на массив известных
 * ключей, даёт пустой набор: испорченная запись обязана вернуть экран к
 * дефолту (всё свёрнуто), а не уронить его. Ключи возвращаются в порядке
 * DATA_SECTION_KEYS — так сериализация стабильна и не зависит от того, в каком
 * порядке владелец разворачивал блоки.
 */
export function parseExpanded(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Ключ, которого больше нет в коде (блок переименовали или убрали), молча
  // отбрасывается — иначе он висел бы в хранилище вечно.
  return DATA_SECTION_KEYS.filter((key) => parsed.includes(key));
}

export function serializeExpanded(keys) {
  return JSON.stringify(DATA_SECTION_KEYS.filter((key) => keys.includes(key)));
}

/**
 * Хранилища может не быть вовсе, а в приватном режиме Safari обращение к
 * самому свойству `localStorage` бросает SecurityError — не возвращает null.
 * Поэтому в try завёрнуто чтение свойства, а не только вызов метода.
 */
export function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readExpanded(storage = safeStorage()) {
  if (!storage) return [];
  try {
    return parseExpanded(storage.getItem(DATA_SECTIONS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function writeExpanded(keys, storage = safeStorage()) {
  if (!storage) return;
  try {
    storage.setItem(DATA_SECTIONS_STORAGE_KEY, serializeExpanded(keys));
  } catch {
    // Запись бросает и при запрете хранилища, и при исчерпанной квоте.
    // Состояние блоков — удобство, а не данные владельца: молча работаем
    // дальше без сохранения, экран от этого не ломается.
  }
}

export function toggleExpanded(keys, key) {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

/**
 * Определение ключа секции из дип-линка (issue #278).
 * Например, '#/data/rates' -> 'rates', '#/data/accounts' -> 'accounts'.
 * Неизвестные или некорректные хэши дают null.
 */
export function sectionFromHash(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  const match = hash.match(/^#\/data\/([a-z]+)$/);
  if (!match) return null;
  const key = match[1];
  return DATA_SECTION_KEYS.includes(key) ? key : null;
}

