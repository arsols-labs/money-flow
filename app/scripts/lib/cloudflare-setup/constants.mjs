/** Shared constants for the stranger Cloudflare setup path. */

export {
  PRIVATE_FORBIDDEN_CONTENT_PATTERNS,
  RESERVED_PRODUCTION_D1_NAMES,
  RESERVED_PRODUCTION_HOST_MARKERS,
  RESERVED_PRODUCTION_RATE_LIMIT_IDS,
  RESERVED_PRODUCTION_RESOURCE_IDS,
  RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT,
  RESERVED_PRODUCTION_WORKERS_DEV_LABELS,
} from './private-reserved-names.mjs';

export const DEFAULT_WORKER_NAME = 'money-flow';
export const LOCAL_CONFIG_NAME = 'wrangler.local.jsonc';
export const STATE_FILE_NAME = '.setup-state.json';
export const TEMPLATE_CONFIG_NAME = 'wrangler.template.jsonc';
export const MIN_NODE_MAJOR = 20;

export const HOSTNAME_MODES = /** @type {const} */ (['workers-dev', 'custom']);

export const COMPATIBILITY_DATE = '2026-08-08';
export const COMPATIBILITY_FLAGS = Object.freeze(['global_fetch_strictly_public']);

export const ASSETS_CONFIG = Object.freeze({
  directory: 'dist/client',
  binding: 'ASSETS',
  not_found_handling: 'single-page-application',
  run_worker_first: ['/api/*', '/mcp', '/mcp/*', '/.well-known/*'],
});

export const RATE_LIMIT_BINDINGS = Object.freeze([
  { name: 'RATE_LIMIT_OAUTH_REGISTER', limit: 10, period: 60 },
  { name: 'RATE_LIMIT_AUTH_SETUP', limit: 8, period: 60 },
  { name: 'RATE_LIMIT_AUTH_LOGIN', limit: 20, period: 60 },
  { name: 'RATE_LIMIT_MCP_DISPATCH', limit: 60, period: 60 },
]);
