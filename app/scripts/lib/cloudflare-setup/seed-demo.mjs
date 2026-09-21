import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PRIVATE_FORBIDDEN_CONTENT_PATTERNS } from './constants.mjs';

export { buildDemoSeedSql } from './seed-demo-sql.mjs';

export const DEMO_SEED_RELATIVE_PATH = 'scripts/seed-demo.sql';

/** Patterns that must never appear in the stranger-safe demo seed. */
export const DEMO_SEED_FORBIDDEN = Object.freeze([
  ...PRIVATE_FORBIDDEN_CONTENT_PATTERNS,
  /[А-Яа-яЁё]/,
]);

export function demoSeedFilePath(cwd) {
  return path.join(cwd, DEMO_SEED_RELATIVE_PATH);
}

export function loadDemoSeedSql(fromPath) {
  return readFileSync(fromPath, 'utf8');
}

/**
 * @param {unknown} value
 * @param {{ emptyDefault?: boolean }} [options]
 * @returns {boolean | null} true/false, or null when the value is not a yes/no token
 */
export function parseYesNo(value, { emptyDefault } = {}) {
  if (value == null) {
    return emptyDefault === undefined ? null : emptyDefault;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '') {
    return emptyDefault === undefined ? null : emptyDefault;
  }
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  return null;
}

/**
 * Resolve --seed-demo / --no-seed-demo / SETUP_SEED_DEMO.
 * `null` means “ask, or default to no when non-interactive”.
 *
 * @param {{ flag?: boolean | null, envValue?: string | null }} [input]
 * @returns {boolean | null}
 */
export function resolveSeedDemoChoice({ flag = null, envValue = null } = {}) {
  if (flag === true || flag === false) return flag;
  if (envValue == null) return null;
  const trimmed = String(envValue).trim();
  if (trimmed === '') return null;
  const parsed = parseYesNo(trimmed);
  if (parsed === null) {
    throw new Error(
      `Invalid SETUP_SEED_DEMO value "${envValue}". Use yes, no, true, false, 1, or 0.`,
    );
  }
  return parsed;
}

export function assertDemoSeedIsStrangerSafe(sql) {
  for (const pattern of DEMO_SEED_FORBIDDEN) {
    if (pattern.test(sql)) {
      throw new Error(`Demo seed contains a forbidden pattern: ${pattern}`);
    }
  }
}
