import { isStableWorkersDevHost } from './validate.mjs';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const KV_ID_RE = /\b[0-9a-f]{32}\b/i;
const HTTPS_URL_RE = /https:\/\/[^\s)'"]+/g;

/**
 * @param {string} text
 * @returns {unknown | null}
 */
export function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = trimmed.search(/[\[{]/);
  if (start === -1) return null;
  const candidate = trimmed.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through: wrangler often prints a banner then a JSON object.
  }
  const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (lastBrace === -1) return null;
  try {
    return JSON.parse(candidate.slice(0, lastBrace + 1));
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function parseWhoamiAccountTable(text) {
  let accountId = null;
  let accountName = null;
  for (const line of String(text).split('\n')) {
    if (/account\s*name/i.test(line) && /account\s*id/i.test(line)) continue;
    const idMatch = line.match(/\b([0-9a-f]{32})\b/i);
    if (!idMatch) continue;
    accountId = idMatch[1];
    const name = line
      .replace(idMatch[0], ' ')
      .replace(/[│|├┤┌┐└┘┬┴┼─━═\-\+]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (name) accountName = name;
    break;
  }
  return { accountId, accountName };
}

export function parseWhoami(stdout) {
  const json = tryParseJson(stdout);
  if (json && typeof json === 'object') {
    const email = firstString(json.email, json.user?.email);
    const accounts = Array.isArray(json.accounts) ? json.accounts : [];
    return {
      email,
      accountId: firstString(json.account_id, json.accountId, accounts[0]?.id, accounts[0]?.account_id),
      accountName: firstString(json.account_name, json.accountName, accounts[0]?.name),
      loggedIn: Boolean(email || accounts.length || json.loggedIn),
    };
  }

  const text = String(stdout);
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  const loggedOut = /not logged in|not authenticated|login required/i.test(text);
  const apiTokenLogin = /logged in with an?\s+(?:user\s+)?api token/i.test(text);
  const hasAccountTable = /account\s*name/i.test(text) && /account\s*id/i.test(text);
  const table = parseWhoamiAccountTable(text);

  return {
    email: emailMatch ? emailMatch[0] : null,
    accountId: table.accountId,
    accountName: table.accountName,
    loggedIn: !loggedOut && Boolean(emailMatch || apiTokenLogin || hasAccountTable || table.accountId),
  };
}

export function parseD1List(stdout) {
  const json = tryParseJson(stdout);
  const rows = Array.isArray(json) ? json : Array.isArray(json?.databases) ? json.databases : [];
  if (rows.length > 0) {
    return rows.map((row) => ({
      name: firstString(row.name, row.database_name),
      id: firstString(row.uuid, row.database_id, row.id),
    })).filter((row) => row.name && row.id);
  }

  const results = [];
  for (const line of String(stdout).split('\n')) {
    const uuid = line.match(UUID_RE)?.[0];
    if (!uuid) continue;
    const name = line.replace(UUID_RE, '').replace(/[│|]/g, ' ').trim().split(/\s+/)[0];
    if (name) results.push({ name, id: uuid });
  }
  return results;
}

export function parseD1CreateOutput(stdout) {
  const json = tryParseJson(stdout);
  const binding = json?.d1_databases?.[0] ?? json;
  const fromJson = {
    name: firstString(binding?.database_name, binding?.name, json?.database_name),
    id: firstString(binding?.database_id, binding?.uuid, binding?.id, json?.database_id),
  };
  if (fromJson.id) return fromJson;

  return {
    name: String(stdout).match(/database['"]?\s*[:=]\s*['"]?([a-z0-9-]+)/i)?.[1] ?? null,
    id: String(stdout).match(UUID_RE)?.[0] ?? null,
  };
}

export function parseKvList(stdout) {
  const json = tryParseJson(stdout);
  const rows = Array.isArray(json) ? json : Array.isArray(json?.namespaces) ? json.namespaces : [];
  if (rows.length > 0) {
    return rows.map((row) => ({
      title: firstString(row.title, row.name),
      id: firstString(row.id, row.namespace_id),
    })).filter((row) => row.title && row.id);
  }

  // wrangler kv namespace list has no --json flag; fall back to table/banner text.
  const results = [];
  for (const line of String(stdout).split('\n')) {
    const id = line.match(KV_ID_RE)?.[0];
    if (!id) continue;
    const title = line.replace(KV_ID_RE, '').replace(/[│|]/g, ' ').trim().split(/\s+/)[0];
    if (title) results.push({ title, id });
  }
  return results;
}

export function parseKvCreateOutput(stdout) {
  const json = tryParseJson(stdout);
  const binding = json?.kv_namespaces?.[0] ?? json;
  const fromJson = {
    title: firstString(binding?.title, json?.title),
    id: firstString(binding?.id, binding?.namespace_id, json?.id),
  };
  if (fromJson.id) return fromJson;

  const id =
    String(stdout).match(/id["'\s:=]+([0-9a-f]{32})/i)?.[1] ??
    String(stdout).match(KV_ID_RE)?.[0] ??
    null;
  return { title: null, id };
}

export function parseWorkerList(stdout) {
  const json = tryParseJson(stdout);
  const rows = Array.isArray(json)
    ? json
    : Array.isArray(json?.result)
      ? json.result
      : Array.isArray(json?.workers)
        ? json.workers
        : Array.isArray(json?.scripts)
          ? json.scripts
          : [];
  if (rows.length > 0) {
    return rows
      .map((row) => {
        if (typeof row === 'string') return { name: row };
        const name = firstString(row.name, row.id, row.script, row.script_name);
        return name ? { name } : null;
      })
      .filter(Boolean);
  }

  const results = [];
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.replace(/[│|]/g, ' ').trim();
    if (!trimmed || /^(name|id|worker|#)/i.test(trimmed)) continue;
    const token = trimmed.split(/\s+/)[0];
    if (token && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(token)) {
      results.push({ name: token });
    }
  }
  return results;
}

export function parseSecretList(stdout) {
  const json = tryParseJson(stdout);
  if (Array.isArray(json)) {
    return json.map((row) => (typeof row === 'string' ? row : row?.name)).filter(Boolean);
  }
  if (Array.isArray(json?.secrets)) {
    return json.secrets.map((row) => row?.name ?? row).filter(Boolean);
  }
  return String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(SESSION_SECRET|SETUP_TOKEN)\b/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

/**
 * Prefer the stable `${workerName}.${subdomain}.workers.dev` host.
 * Versioned deploy URLs and reserved production and preview hosts are ignored.
 * @param {string} stdout
 * @param {{ workerName?: string }} [options]
 */
export function parseDeployUrls(stdout, { workerName } = {}) {
  const matches = String(stdout).match(HTTPS_URL_RE) ?? [];
  const urls = [...new Set(matches.map((url) => url.replace(/[.,;]+$/, '')))];
  const workersDev =
    urls.find((url) => {
      try {
        return isStableWorkersDevHost(new URL(url).host, workerName);
      } catch {
        return false;
      }
    }) ?? null;
  return { urls, workersDev };
}

export function isAuthError(stderr = '', stdout = '') {
  const text = `${stdout}\n${stderr}`;
  if (/you are logged in/i.test(text) && !/not logged in/i.test(text)) return false;
  return /not logged in|not authenticated|login required|unauthenticated/i.test(text);
}

export function isZoneError(stderr = '', stdout = '') {
  const text = `${stdout}\n${stderr}`;
  return /zone|custom domain|does not exist|not authorized.*domain|no such host/i.test(text);
}
