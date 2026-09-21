// S2-1: Логика страницы согласия (Consent Page) и CSRF-защиты (issue #261)

import { timingSafeEqualString } from './crypto-eq';
import { escapeHtml } from './html';

export interface ConsentPageData {
  clientId: string;
  clientName: string;
  clientHost: string;
  redirectUri: string;
  scope: string[];
  state: string;
  csrfToken: string;
  resource?: string | string[];
  responseType?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  actionUrl?: string;
}

/**
 * Minimal submit-once handler for the consent form.
 * Keep byte-identical with CONSENT_SUBMIT_ONCE_CSP_HASH (verified in tests).
 * Preserves the clicked `action` in a hidden field before disabling buttons
 * (disabled submitters are omitted from form data in some browsers).
 */
export const CONSENT_SUBMIT_ONCE_JS =
  "document.getElementById('consent-form').addEventListener('submit',function(e){var f=e.currentTarget;if(f.getAttribute('data-busy')==='1'){e.preventDefault();return;}f.setAttribute('data-busy','1');var s=e.submitter;if(s&&s.name){var h=document.createElement('input');h.type='hidden';h.name=s.name;h.value=s.value;f.appendChild(h);}var bs=f.querySelectorAll('button');for(var i=0;i<bs.length;i++){bs[i].disabled=true;}var a=f.querySelector('.btn-allow');if(a&&(!s||s.value==='allow')){a.textContent='Подтверждаем…';}});";

/** CSP `script-src` hash of {@link CONSENT_SUBMIT_ONCE_JS} (SHA-256, base64). */
export const CONSENT_SUBMIT_ONCE_CSP_HASH = 'sha256-4ow1BBW1yb3WDAPVVpTtkrIBABtAmXdCFiwzyyFHsJg=';

/**
 * Создаёт подписанный одноразовый CSRF-токен для формы согласия с коротким сроком жизни.
 */
export async function createConsentCsrfToken(
  secret: string,
  params: { clientId: string; redirectUri: string; state: string }
): Promise<string> {
  const timestamp = Date.now();
  const payload = `${params.clientId}|${params.redirectUri}|${params.state}|${timestamp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${timestamp}.${sigHex}`;
}

/**
 * Проверяет подпись и срок жизни CSRF-токена формы согласия.
 */
export async function verifyConsentCsrfToken(
  secret: string,
  token: string,
  params: { clientId: string; redirectUri: string; state: string },
  maxAgeMs: number = 10 * 60 * 1000 // 10 минут
): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  const [timestampStr, sigHex] = token.split('.');
  if (!timestampStr || !sigHex) return false;
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || Date.now() - timestamp > maxAgeMs || timestamp > Date.now() + 60000) {
    return false;
  }
  const payload = `${params.clientId}|${params.redirectUri}|${params.state}|${timestamp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expectedSig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expectedSigHex = Array.from(new Uint8Array(expectedSig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqualString(sigHex, expectedSigHex);
}

/**
 * Извлекает хост из Client ID Metadata Document URL для защиты от поддельных коннекторов (confused deputy).
 */
export function extractClientHost(clientId: string): string {
  try {
    const url = new URL(clientId);
    return url.host;
  } catch {
    return 'local / pre-registered';
  }
}

/**
 * Рендерит защищённую HTML-страницу согласия.
 */
export function renderConsentHtml(data: ConsentPageData): string {
  const isHttpsHost = data.clientId.startsWith('https://');
  const hostBadgeClass = isHttpsHost ? 'host-verified' : 'host-local';

  const scopesHtml = data.scope
    .map((s) => {
      const desc = s === 'read' ? 'Чтение данных (счета, операции, аналитика)' : s === 'write' ? 'Запись данных (создание и изменение операций)' : s;
      return `
        <label class="scope-item">
          <input type="checkbox" name="scope" value="${escapeHtml(s)}" checked />
          <div class="scope-text">
            <span class="scope-name">${escapeHtml(s)}</span>
            <span class="scope-desc">${escapeHtml(desc)}</span>
          </div>
        </label>
      `;
    })
    .join('');

  const resourcesHtml = data.resource
    ? Array.isArray(data.resource)
      ? data.resource.map((r) => `<input type="hidden" name="resource" value="${escapeHtml(r)}" />`).join('')
      : `<input type="hidden" name="resource" value="${escapeHtml(data.resource)}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Money Flow — Авторизация клиента</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #13151f;
      --border: #232738;
      --text: #f0f2f8;
      --text-muted: #8c93a8;
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --verified-bg: #064e3b;
      --verified-text: #34d399;
      --font: system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 1rem;
      max-width: 480px;
      width: 100%;
      padding: 2rem;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    h1 { font-size: 1.35rem; margin-bottom: 0.5rem; font-weight: 600; }
    .subtitle { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem; }
    .client-info {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1rem;
      margin-bottom: 1.5rem;
    }
    .client-name { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.25rem; }
    .client-host {
      display: inline-block;
      font-size: 0.75rem;
      font-family: monospace;
      padding: 0.2rem 0.5rem;
      border-radius: 0.375rem;
      margin-top: 0.25rem;
    }
    .host-verified { background: var(--verified-bg); color: var(--verified-text); }
    .host-local { background: #374151; color: #d1d5db; }
    .redirect-info {
      margin-top: 0.75rem;
      font-size: 0.8rem;
      color: var(--text-muted);
      word-break: break-all;
    }
    .scopes-header { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.75rem; }
    .scopes-list { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.75rem; }
    .scope-item {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      cursor: pointer;
    }
    .scope-item input { margin-top: 0.2rem; cursor: pointer; }
    .scope-text { display: flex; flex-direction: column; }
    .scope-name { font-weight: 600; font-size: 0.9rem; }
    .scope-desc { font-size: 0.8rem; color: var(--text-muted); }
    .actions { display: flex; gap: 0.75rem; }
    button {
      flex: 1;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 0.15s ease, opacity 0.15s ease;
    }
    button:disabled {
      opacity: 0.7;
      cursor: wait;
    }
    .btn-allow { background: var(--accent); color: #fff; }
    .btn-allow:hover:not(:disabled) { background: var(--accent-hover); }
    .btn-deny { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .btn-deny:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); color: var(--text); }
  </style>
  <script>${CONSENT_SUBMIT_ONCE_JS}</script>
</head>
<body>
  <div class="card">
    <h1>Авторизация приложения</h1>
    <p class="subtitle">Машинный клиент запрашивает доступ к вашему Money Flow</p>

    <div class="client-info">
      <div class="client-name">${escapeHtml(data.clientName)}</div>
      <span class="client-host ${hostBadgeClass}">Хост: ${escapeHtml(data.clientHost)}</span>
      <div class="redirect-info"><strong>Redirect URI:</strong> ${escapeHtml(data.redirectUri)}</div>
    </div>

    <form id="consent-form" method="POST" action="${escapeHtml(data.actionUrl || '/api/auth/oauth/authorize')}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(data.csrfToken)}" />
      <input type="hidden" name="client_id" value="${escapeHtml(data.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(data.redirectUri)}" />
      <input type="hidden" name="state" value="${escapeHtml(data.state)}" />
      <input type="hidden" name="response_type" value="${escapeHtml(data.responseType || 'code')}" />
      ${data.codeChallenge ? `<input type="hidden" name="code_challenge" value="${escapeHtml(data.codeChallenge)}" />` : ''}
      ${data.codeChallengeMethod ? `<input type="hidden" name="code_challenge_method" value="${escapeHtml(data.codeChallengeMethod)}" />` : ''}
      ${resourcesHtml}
      <input type="hidden" name="scope_control" value="1" />

      <div class="scopes-header">Запрашиваемые права (скоупы):</div>
      <div class="scopes-list">
        ${scopesHtml}
      </div>

      <div class="actions">
        <button type="submit" name="action" value="deny" class="btn-deny">Отклонить</button>
        <button type="submit" name="action" value="allow" class="btn-allow">Разрешить доступ</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

