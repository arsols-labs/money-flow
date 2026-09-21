/**
 * Public-cut overlay: empty reserved-resource inventory.
 * Private kitchen Worker/D1/KV/host names must not ship in the public tree.
 * Setup tests skip reserved-name cases when these inventories are empty.
 * PRIVATE_FORBIDDEN_CONTENT_PATTERNS still reject accidental kitchen fingerprints
 * in generated setup output.
 */
export const RESERVED_PRODUCTION_RESOURCE_IDS = Object.freeze([]);

export const RESERVED_PRODUCTION_HOST_MARKERS = Object.freeze([]);
export const RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT = '';
export const RESERVED_PRODUCTION_WORKERS_DEV_LABELS = Object.freeze([]);
export const RESERVED_PRODUCTION_D1_NAMES = Object.freeze([]);
export const RESERVED_PRODUCTION_RATE_LIMIT_IDS = Object.freeze([]);

export const PRIVATE_FORBIDDEN_CONTENT_PATTERNS = Object.freeze([
  /utgardar/i,
  /ar-solutions/i,
  /money-flow\.utgardar/i,
  /kitchen/i,
]);
