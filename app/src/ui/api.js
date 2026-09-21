import i18n from './i18n';
import { parseApiError } from '../shared/api-errors';

function localizeApiError(body, status) {
  const parsed = parseApiError(body);
  if (parsed) {
    const key = `errors.${parsed.code}`;
    if (i18n.exists(key)) return i18n.t(key, parsed.params || {});
    return parsed.message;
  }
  return `HTTP ${status}`;
}

async function request(path, options = {}) {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'X-Money-Flow': '1' },
    credentials: 'same-origin',
    ...options,
  });
  let body = null;
  try {
    body = await resp.json();
  } catch {
    /* not json */
  }
  if (!resp.ok) {
    const parsed = parseApiError(body);
    const err = new Error(localizeApiError(body, resp.status));
    err.status = resp.status;
    err.code = parsed?.code;
    err.params = parsed?.params;
    throw err;
  }
  return body;
}

export const api = {
  me: () => request('/api/auth/me'),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  loginOptions: () => request('/api/auth/login/options', { method: 'POST' }),
  loginVerify: (response) =>
    request('/api/auth/login/verify', { method: 'POST', body: JSON.stringify({ response }) }),
  registerOptions: (token) =>
    request('/api/auth/register/options', { method: 'POST', body: JSON.stringify({ token }) }),
  registerVerify: (token, response, label) =>
    request('/api/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({ token, response, label }),
    }),

  listAccounts: () => request('/api/v2/accounts'),
  createAccount: (payload) =>
    request('/api/v2/accounts', { method: 'POST', body: JSON.stringify(payload) }),
  updateAccount: (id, patch) =>
    request(`/api/v2/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAccount: (id) => request(`/api/v2/accounts/${id}`, { method: 'DELETE' }),
  // «Сверился с банком, сумма та же» — переставляет balance_updated_at, не
  // трогая сумму (issue #223). Тела у запроса нет: подтверждать нечего, кроме
  // самого факта проверки.
  confirmAccountBalance: (id) =>
    request(`/api/v2/accounts/${id}/confirm-balance`, { method: 'POST' }),
  // Алиасы счетов — привязка виртуальных карт к реальному счёту (issue #339).
  // Список алиасов приходит внутри GET /accounts (поле `aliases`), поэтому
  // отдельного list-вызова здесь нет; добавление/удаление — отдельные эндпоинты.
  addAccountAlias: (id, aliasText) =>
    request(`/api/v2/accounts/${id}/aliases`, {
      method: 'POST',
      body: JSON.stringify({ alias_text: aliasText }),
    }),
  deleteAccountAlias: (id, aliasId) =>
    request(`/api/v2/accounts/${id}/aliases/${aliasId}`, { method: 'DELETE' }),

  listFxRates: () => request('/api/v2/fx-rates'),
  putFxRate: (code, rate) =>
    request(`/api/v2/fx-rates/${code}`, { method: 'PUT', body: JSON.stringify({ rate }) }),
  deleteFxRate: (code) => request(`/api/v2/fx-rates/${code}`, { method: 'DELETE' }),

  listPlannedItems: () => request('/api/v2/planned-items'),
  createPlannedItem: (payload) =>
    request('/api/v2/planned-items', { method: 'POST', body: JSON.stringify(payload) }),
  updatePlannedItem: (id, patch) =>
    request(`/api/v2/planned-items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePlannedItem: (id) => request(`/api/v2/planned-items/${id}`, { method: 'DELETE' }),

  listRecurringItems: () => request('/api/v2/recurring-items'),
  createRecurringItem: (payload) =>
    request('/api/v2/recurring-items', { method: 'POST', body: JSON.stringify(payload) }),
  updateRecurringItem: (id, patch) =>
    request(`/api/v2/recurring-items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteRecurringItem: (id) => request(`/api/v2/recurring-items/${id}`, { method: 'DELETE' }),
  closeRecurringItemPeriod: (id, payload = {}) =>
    request(`/api/v2/recurring-items/${id}/close-period`, { method: 'POST', body: JSON.stringify(payload) }),
  skipRecurringItemPeriod: (id) =>
    request(`/api/v2/recurring-items/${id}/skip-period`, { method: 'POST' }),

  // Операции — траты, доходы и возвраты (S1-5a). Счёт обязателен, валюта не
  // передаётся вовсе (она у счёта), сумма правит баланс счёта на сервере:
  // после любого из этих вызовов счета надо перечитать.
  listOperations: () => request('/api/v2/operations'),
  createOperation: (payload) =>
    request('/api/v2/operations', { method: 'POST', body: JSON.stringify(payload) }),
  updateOperation: (id, patch) =>
    request(`/api/v2/operations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteOperation: (id) => request(`/api/v2/operations/${id}`, { method: 'DELETE' }),

  createTransfer: (payload) =>
    request('/api/v2/transfers', { method: 'POST', body: JSON.stringify(payload) }),
  updateTransfer: (id, payload) =>
    request(`/api/v2/transfers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteTransfer: (id) => request(`/api/v2/transfers/${id}`, { method: 'DELETE' }),

  // days необязателен — сервер сам подставит горизонт по умолчанию (365).
  getForecast: (days) =>
    request(`/api/v2/forecast${days ? `?days=${days}` : ''}`),
  getAnalytics: (payload = {}) =>
    request('/api/v2/analytics', { method: 'POST', body: JSON.stringify(payload) }),
  getSettings: () => request('/api/v2/settings'),
  putSetting: (key, value) =>
    request(`/api/v2/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  exportBackup: () => request('/api/v2/backup/export'),
  importBackup: (backup) =>
    request('/api/v2/backup/import', {
      method: 'POST',
      body: JSON.stringify({ ...backup, confirm: true }),
    }),
  resetData: () =>
    request('/api/v2/data/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, phrase: 'RESET' }),
    }),

  // MCP Access & Audit (S2-2)
  getMcpAccess: () => request('/api/v2/mcp/access'),
  createMcpClient: (payload) =>
    request('/api/v2/mcp/access/clients', { method: 'POST', body: JSON.stringify(payload) }),
  revokeMcpToken: (tokenId) =>
    request(`/api/v2/mcp/access/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' }),
  revokeMcpClient: (clientId) =>
    request(`/api/v2/mcp/access/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
  getMcpAudit: () => request('/api/v2/mcp/audit'),

  // Passkeys Management (issue #507)
  listPasskeys: () => request('/api/v2/passkeys'),
  registerPasskeyOptions: () =>
    request('/api/v2/passkeys/register-options', { method: 'POST' }),
  registerPasskeyVerify: (response, label) =>
    request('/api/v2/passkeys/register-verify', {
      method: 'POST',
      body: JSON.stringify({ response, label }),
    }),
  updatePasskey: (id, patch) =>
    request(`/api/v2/passkeys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deletePasskey: (id, options = {}) =>
    request(
      `/api/v2/passkeys/${encodeURIComponent(id)}${options.confirm_last ? '?confirm_last=true' : ''}`,
      {
        method: 'DELETE',
        ...(options.confirm_last ? { body: JSON.stringify({ confirm_last: true }) } : {}),
      },
    ),
};

