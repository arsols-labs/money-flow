// Collapsed / expanded state of blocks on the "Data" screen (issue #260).
//
// Stored in localStorage, not in D1 settings: a write on every header click
// and extending SETTINGS_WRITABLE_KEYS costs more than it is worth (decision
// of 2026-08-12). The stated price is per-device state:
// expanded on the phone, still collapsed on the laptop.
//
// Block order is NOT duplicated here — it is set by JSX order in Data.jsx and
// lives next to the render. The key list exists only to
// drop junk from storage and keep out of screen state anything the code
// no longer has.

export const DATA_SECTION_KEYS = ['operations', 'receipts', 'planned', 'recurring', 'rates', 'accounts'];

export const DATA_SECTIONS_STORAGE_KEY = 'money-flow-v2.data-sections.expanded';

/**
 * Parses a saved value. Anything that does not look like an array of known
 * keys yields an empty set: a corrupt record must return the screen to the
 * default (everything collapsed), not crash it. Keys come back in
 * DATA_SECTION_KEYS order — so serialization is stable and does not depend on the
 * order in which blocks were expanded.
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
  // A key that is no longer in the code (a block was renamed or removed) is silently
  // dropped — otherwise it would sit in storage forever.
  return DATA_SECTION_KEYS.filter((key) => parsed.includes(key));
}

export function serializeExpanded(keys) {
  return JSON.stringify(DATA_SECTION_KEYS.filter((key) => keys.includes(key)));
}

/**
 * Storage may be missing entirely, and in Safari private mode reading the
 * `localStorage` property itself throws SecurityError — it does not return null.
 * So the try wraps the property read, not only the method call.
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
    // The write throws both when storage is blocked and when the quota is exhausted.
    // Block state is a convenience, not owner data: we continue silently
    // without saving, and the screen does not break because of it.
  }
}

export function toggleExpanded(keys, key) {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

/**
 * Resolves a section key from a deep link (issue #278).
 * For example, '#/data/rates' -> 'rates', '#/data/accounts' -> 'accounts'.
 * Unknown or malformed hashes yield null.
 */
export function sectionFromHash(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  const match = hash.match(/^#\/data\/([a-z]+)$/);
  if (!match) return null;
  const key = match[1];
  return DATA_SECTION_KEYS.includes(key) ? key : null;
}

