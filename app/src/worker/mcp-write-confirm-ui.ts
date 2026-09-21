/**
 * MCP Apps — подтверждение write (MRTR).
 * Кнопка в чате повторяет tools/call с requestState. Без неё записи нет.
 */

import { MCP_WIDGET_RPC_SCRIPT } from './mcp-widget-rpc';

export function getWriteConfirmHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Подтверждение записи — Money Flow</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #2563eb;
      --danger: #dc2626;
      --success: #059669;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --card-bg: #1e293b;
        --card-border: #334155;
        --text: #f8fafc;
        --text-muted: #94a3b8;
        --accent: #3b82f6;
        --danger: #f87171;
        --success: #34d399;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 12px;
      font-size: 13px;
      line-height: 1.45;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 14px;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      color: var(--danger);
      margin-bottom: 8px;
    }
    .desc { color: var(--text); margin-bottom: 12px; white-space: pre-wrap; }
    .muted { color: var(--text-muted); font-size: 12px; margin-bottom: 12px; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    #confirmBtn { background: var(--accent); color: #fff; }
    #confirmBtn:disabled { opacity: 0.5; cursor: default; }
    .ok { color: var(--success); font-weight: 600; }
    .err { color: var(--danger); }
  </style>
</head>
<body data-app="write-confirm">
  <div class="card">
    <div class="badge" id="badge">ЗАПИСЬ НЕ ВЫПОЛНЕНА</div>
    <div class="desc" id="desc">Нет запроса на подтверждение.</div>
    <div class="muted" id="hint">Это не факт. Курс, операция или баланс не изменятся, пока вы не подтвердите.</div>
    <button type="button" id="confirmBtn" disabled>Подтвердить</button>
    <div id="status" style="margin-top:10px;"></div>
  </div>
  <script>
    (function () {
${MCP_WIDGET_RPC_SCRIPT}
      let pending = null;

      function pendingFromToolResult(result) {
        const accepted = acceptRpcResult(result);
        return accepted && typeof accepted === 'object' ? accepted.structuredContent || null : null;
      }

      window.addEventListener('message', (event) => {
        const msg = acceptParentMessage(event);
        if (!msg) return;
        if (msg.id !== undefined && pendingRequests.has(msg.id)) {
          const { resolve, reject } = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          if (msg.error) reject(msg.error);
          else resolve(acceptRpcResult(msg.result));
          return;
        }
        if (msg.method === 'ui/notifications/tool-result') {
          applyPending(pendingFromToolResult(msg.params));
        }
      });

      function applyPending(sc) {
        if (!sc || !sc.requestState || sc.written !== false) return;
        pending = sc;
        document.getElementById('desc').textContent = sc.description || 'Подтвердите запись.';
        document.getElementById('confirmBtn').disabled = false;
      }

      async function confirmWrite() {
        if (!pending || !pending.requestState) return;
        const btn = document.getElementById('confirmBtn');
        const status = document.getElementById('status');
        btn.disabled = true;
        status.textContent = 'Отправка…';
        try {
          const res = await sendRequest('tools/call', {
            name: pending.tool,
            arguments: Object.assign({}, pending.arguments || {}, {
              requestState: pending.requestState,
              idempotency_key: pending.idempotency_key
            })
          });
          if (res?.isError || res?.structuredContent?.written !== true) {
            throw new Error(res?.structuredContent?.error || res?.content?.[0]?.text || 'Запись не подтверждена');
          }
          document.getElementById('badge').textContent = 'ЗАПИСЬ ВЫПОЛНЕНА';
          document.getElementById('badge').style.color = 'var(--success)';
          status.className = 'ok';
          status.textContent = 'Готово. Это факт: данные записаны.';
        } catch (err) {
          status.className = 'err';
          status.textContent = err.message || String(err);
          btn.disabled = false;
        }
      }

      document.getElementById('confirmBtn').addEventListener('click', confirmWrite);

      (async function initialize() {
        try {
          await sendRequest('ui/initialize', {
            clientInfo: { name: 'money-flow-write-confirm', version: '1.0.0' },
            protocolVersion: '2026-01-26'
          }).catch(() => null);
          sendNotification('ui/notifications/initialized', {});
        } catch (e) {}
      })();
    })();
  </script>
</body>
</html>`;
}
