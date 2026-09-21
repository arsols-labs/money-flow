import {
  HOSTNAME_MODES,
  RESERVED_PRODUCTION_HOST_MARKERS,
  RESERVED_PRODUCTION_RATE_LIMIT_IDS,
  RESERVED_PRODUCTION_RESOURCE_IDS,
  RESERVED_PRODUCTION_D1_NAMES,
  RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT,
  RESERVED_PRODUCTION_WORKERS_DEV_LABELS,
} from './constants.mjs';

const WORKER_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.(?!-)[a-z0-9-]+)+$/i;

export function validateWorkerName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'Worker name is required.' };
  }
  if (name.length > 63) {
    return { ok: false, error: 'Worker name must be at most 63 characters.' };
  }
  if (!WORKER_NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        'Worker name must be lowercase letters, digits, and hyphens, and must start and end with a letter or digit.',
    };
  }
  return { ok: true, value: name };
}

export function normalizeHostnameMode(input) {
  if (input == null || input === '') return null;
  const raw = String(input).trim().toLowerCase();
  if (['1', 'a', 'workers-dev', 'workers.dev', 'workersdev', 'subdomain', 'free'].includes(raw)) {
    return 'workers-dev';
  }
  if (['2', 'b', 'custom', 'domain', 'custom-domain', 'hostname'].includes(raw)) {
    return 'custom';
  }
  return null;
}

export function validateHostnameMode(input) {
  const mode = normalizeHostnameMode(input);
  if (!mode) {
    return {
      ok: false,
      error: `Hostname mode must be one of: ${HOSTNAME_MODES.join(', ')}.`,
    };
  }
  return { ok: true, value: mode };
}

function isReservedProductionWorkersDevHost(host) {
  if (host === RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT) return true;
  if (!host.endsWith(`.${RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT}`)) return false;
  const label = host.slice(0, -(RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT.length + 1));
  return RESERVED_PRODUCTION_WORKERS_DEV_LABELS.some(
    (reserved) => label === reserved || label.endsWith(`-${reserved}`),
  );
}

export function isReservedProductionHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  const host = hostname.trim().toLowerCase().replace(/:\d+$/, '');
  if (RESERVED_PRODUCTION_HOST_MARKERS.some((marker) => host === marker || host.endsWith(`.${marker}`))) {
    return true;
  }
  return isReservedProductionWorkersDevHost(host);
}

export function isReservedProductionResourceId(id) {
  if (typeof id !== 'string') return false;
  return RESERVED_PRODUCTION_RESOURCE_IDS.includes(id.trim().toLowerCase());
}

export function isReservedProductionRateLimitId(id) {
  if (id == null) return false;
  return RESERVED_PRODUCTION_RATE_LIMIT_IDS.includes(String(id).trim());
}

/**
 * Reserved production Worker, preview-alias, or D1 names that setup
 * must never create-over or delete.
 * @param {string} name
 */
export function isReservedProductionName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const normalized = name.trim().toLowerCase();
  if (RESERVED_PRODUCTION_D1_NAMES.includes(normalized)) return true;
  return RESERVED_PRODUCTION_WORKERS_DEV_LABELS.some(
    (reserved) => normalized === reserved || normalized.endsWith(`-${reserved}`),
  );
}

export function reservedProductionNameError(name, label = 'name') {
  return `${label} "${name}" is on the reserved production names list. Refusing.`;
}

/**
 * Stable workers.dev host: exactly `${workerName}.${oneLabel}.workers.dev`.
 * Rejects versioned deploy URLs, preview aliases, and reserved production hosts.
 * @param {string} host
 * @param {string} [workerName]
 */
export function isStableWorkersDevHost(host, workerName) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (isReservedProductionHostname(normalized)) return false;
  const labels = normalized.split('.');
  if (labels.length !== 4) return false;
  if (labels[2] !== 'workers' || labels[3] !== 'dev') return false;
  if (!WORKER_NAME_RE.test(labels[0]) || !WORKER_NAME_RE.test(labels[1])) return false;
  if (workerName && labels[0] !== String(workerName).toLowerCase()) return false;
  return true;
}

export function validateAppDomain(appDomain) {
  if (typeof appDomain !== 'string' || appDomain.trim().length === 0) {
    return { ok: false, error: 'APP_DOMAIN is required.' };
  }
  const host = appDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (isReservedProductionHostname(host)) {
    return {
      ok: false,
      error:
        'APP_DOMAIN is a reserved production host. Use your own domain or workers.dev.',
    };
  }
  return { ok: true, value: host };
}

export function validateHostname(hostname, { mode } = {}) {
  if (mode === 'workers-dev') {
    if (hostname == null || hostname === '') return { ok: true, value: null };
  }
  if (typeof hostname !== 'string' || hostname.trim().length === 0) {
    return { ok: false, error: 'Custom hostname is required for hostname mode "custom".' };
  }
  const host = hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!HOSTNAME_RE.test(host)) {
    return {
      ok: false,
      error: 'Hostname must be a dotted domain such as app.example.com (no path or scheme).',
    };
  }
  if (isReservedProductionHostname(host)) {
    return {
      ok: false,
      error:
        'That hostname is reserved for production. Use your own domain or workers.dev.',
    };
  }
  return { ok: true, value: host };
}

export function validateResourceId(id, label = 'resource id') {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, error: `${label} is missing.` };
  }
  if (isReservedProductionResourceId(id)) {
    return {
      ok: false,
      error: `${label} matches a reserved production binding id. Refusing to write it into a local config.`,
    };
  }
  return { ok: true, value: id.trim() };
}

export function parseNodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  return Number.isFinite(major) ? major : 0;
}
