/**
 * MCP Apps — Пульс (Pulse) UI
 * SEP-1865: text/html;profile=mcp-app
 * Интерактивный пульт диагностики денежного потока внутри переписки.
 */

import { MCP_WIDGET_RPC_SCRIPT } from './mcp-widget-rpc';

export function getPulseHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Пульс — Money Flow</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #2563eb;
      --accent-light: #eff6ff;
      --success-bg: #ecfdf5;
      --success-text: #059669;
      --success-border: #a7f3d0;
      --warning-bg: #fffbeb;
      --warning-text: #d97706;
      --warning-border: #fde68a;
      --danger-bg: #fef2f2;
      --danger-text: #dc2626;
      --danger-border: #fecaca;
      --chart-grid: #e2e8f0;
      --chart-line: #2563eb;
      --chart-area: rgba(37, 99, 235, 0.12);
      --chart-lowest: #ef4444;
      --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.07), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --card-bg: #1e293b;
        --card-border: #334155;
        --text: #f8fafc;
        --text-muted: #94a3b8;
        --accent: #3b82f6;
        --accent-light: rgba(59, 130, 246, 0.15);
        --success-bg: rgba(6, 78, 59, 0.35);
        --success-text: #34d399;
        --success-border: rgba(5, 150, 105, 0.4);
        --warning-bg: rgba(120, 53, 15, 0.35);
        --warning-text: #fbbf24;
        --warning-border: rgba(217, 119, 6, 0.4);
        --danger-bg: rgba(127, 29, 29, 0.35);
        --danger-text: #f87171;
        --danger-border: rgba(220, 38, 38, 0.4);
        --chart-grid: #334155;
        --chart-line: #60a5fa;
        --chart-area: rgba(96, 165, 250, 0.15);
        --chart-lowest: #f87171;
        --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.25);
      }
    }

    body[data-theme="dark"] {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-light: rgba(59, 130, 246, 0.15);
      --success-bg: rgba(6, 78, 59, 0.35);
      --success-text: #34d399;
      --success-border: rgba(5, 150, 105, 0.4);
      --warning-bg: rgba(120, 53, 15, 0.35);
      --warning-text: #fbbf24;
      --warning-border: rgba(217, 119, 6, 0.4);
      --danger-bg: rgba(127, 29, 29, 0.35);
      --danger-text: #f87171;
      --danger-border: rgba(220, 38, 38, 0.4);
      --chart-grid: #334155;
      --chart-line: #60a5fa;
      --chart-area: rgba(96, 165, 250, 0.15);
      --chart-lowest: #f87171;
      --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.25);
    }

    body[data-theme="light"] {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #2563eb;
      --accent-light: #eff6ff;
      --success-bg: #ecfdf5;
      --success-text: #059669;
      --success-border: #a7f3d0;
      --warning-bg: #fffbeb;
      --warning-text: #d97706;
      --warning-border: #fde68a;
      --danger-bg: #fef2f2;
      --danger-text: #dc2626;
      --danger-border: #fecaca;
      --chart-grid: #e2e8f0;
      --chart-line: #2563eb;
      --chart-area: rgba(37, 99, 235, 0.12);
      --chart-lowest: #ef4444;
      --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.07), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      padding: 12px;
      font-size: 13px;
      line-height: 1.4;
      transition: background-color 0.2s, color 0.2s;
    }

    .container {
      max-width: 720px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 4px;
    }
    .title-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 9999px;
      background-color: var(--accent-light);
      color: var(--accent);
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-icon {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .btn-icon:hover {
      color: var(--text);
      border-color: var(--accent);
    }

    /* Cards Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 12px 14px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .card-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .card-value {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .card-sub {
      font-size: 11px;
      color: var(--text-muted);
    }
    .val-positive { color: var(--success-text); }
    .val-negative { color: var(--danger-text); }

    /* Warnings Banner */
    .warnings-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .alert {
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .alert-danger {
      background-color: var(--danger-bg);
      border: 1px solid var(--danger-border);
      color: var(--danger-text);
    }
    .alert-warning {
      background-color: var(--warning-bg);
      border: 1px solid var(--warning-border);
      color: var(--warning-text);
    }
    .alert-success {
      background-color: var(--success-bg);
      border: 1px solid var(--success-border);
      color: var(--success-text);
    }

    /* Chart Section */
    .chart-card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 14px;
      box-shadow: var(--shadow);
    }
    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .chart-title {
      font-size: 13px;
      font-weight: 600;
    }
    .chart-svg-wrap {
      width: 100%;
      height: 160px;
      position: relative;
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    /* Countries Bar */
    .countries-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .country-pill {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .country-code {
      font-weight: 700;
      color: var(--accent);
    }

    /* Accounts Collapsible */
    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .accounts-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 8px;
    }
    .account-item {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .acc-name {
      font-weight: 600;
      font-size: 12px;
    }
    .acc-meta {
      font-size: 11px;
      color: var(--text-muted);
    }
    .acc-bal {
      font-weight: 700;
      font-size: 12px;
      text-align: right;
    }

    /* Loading & Error */
    .loading-state, .error-state {
      text-align: center;
      padding: 32px 16px;
      color: var(--text-muted);
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
    }
    .spinner {
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 3px solid var(--card-border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 8px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Tooltip */
    .tooltip {
      position: absolute;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 11px;
      pointer-events: none;
      box-shadow: var(--shadow);
      display: none;
      z-index: 10;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="title-group">
        <div class="title">
          <span>⚡ Пульс</span>
          <span class="badge" id="horizonBadge">30 дней</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn-icon" id="themeBtn" title="Переключить тему">🌓</button>
        <button class="btn-icon" id="refreshBtn" title="Обновить данные">🔄 Обновить</button>
      </div>
    </div>

    <div id="contentArea">
      <div class="loading-state">
        <div class="spinner"></div>
        <div>Загрузка пульта диагностики...</div>
      </div>
    </div>
  </div>

  <div id="chartTooltip" class="tooltip"></div>

  <script>
    (function() {
${MCP_WIDGET_RPC_SCRIPT}
      let currentTheme = 'auto';

      // Theme handler
      function setTheme(theme) {
        currentTheme = theme;
        if (theme === 'dark' || theme === 'light') {
          document.body.setAttribute('data-theme', theme);
        } else {
          document.body.removeAttribute('data-theme');
        }
      }

      document.getElementById('themeBtn').addEventListener('click', () => {
        const isDark = document.body.getAttribute('data-theme') === 'dark' || 
          (!document.body.hasAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
        setTheme(isDark ? 'light' : 'dark');
      });

      document.getElementById('refreshBtn').addEventListener('click', () => {
        loadPulseData(30);
      });

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

        if (msg.method === 'ui/theme_changed' && typeof msg.params?.theme === 'string') {
          setTheme(msg.params.theme);
        }
      });

      // Formatters
      function formatMoney(minor, currency = 'USD') {
        if (minor === null || minor === undefined) return '—';
        const amount = minor / 100;
        return new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: currency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 2
        }).format(amount);
      }

      function formatDate(dateStr) {
        if (!dateStr) return '';
        const [y, m, d] = dateStr.split('-');
        return \`\${d}.\${m}\`;
      }

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // Render Pulse UI
      function renderPulse(data) {
        const baseCur = data.base_currency || 'USD';
        const horizon = data.horizon_days || 30;
        document.getElementById('horizonBadge').textContent = \`\${horizon} дней\`;

        const netWorth = data.net_worth_minor || 0;
        const cashFlow = data.cash_flow_minor || 0;
        const lowest = data.lowest;
        const warnings = data.warnings || [];
        const series = data.series || [];
        const accounts = data.accounts || [];
        const countries = data.countries || [];

        let warningsHtml = '';
        if (warnings.length > 0) {
          warningsHtml = warnings.map(w => {
            const cls = w.severity === 'danger' ? 'alert-danger' : 'alert-warning';
            const icon = w.severity === 'danger' ? '🚨' : '⚠️';
            return \`<div class="alert \${cls}">
              <span>\${icon}</span>
              <div>
                <strong>\${escapeHtml(w.dimension_label || w.dimension || 'Предупреждение')}:</strong> \${escapeHtml(w.message)}
                \${w.date ? \` (\${formatDate(w.date)})\` : ''}
              </div>
            </div>\`;
          }).join('');
        } else {
          warningsHtml = \`<div class="alert alert-success">
            <span>✅</span>
            <div>Все финансовые потоки в норме, кассовых разрывов не обнаружено.</div>
          </div>\`;
        }

        // Accounts list HTML
        const accountsHtml = accounts.map(a => \`
          <div class="account-item">
            <div>
              <div class="acc-name">\${escapeHtml(a.name)}</div>
              <div class="acc-meta">\${escapeHtml(a.owner || '')} \${a.country ? \`• \${escapeHtml(a.country)}\` : ''}</div>
            </div>
            <div>
              <div class="acc-bal">\${formatMoney(a.balance_minor, a.currency)}</div>
              \${a.currency !== baseCur && a.balance_base_minor !== null ? \`<div class="acc-meta">\${formatMoney(a.balance_base_minor, baseCur)}</div>\` : ''}
            </div>
          </div>
        \`).join('');

        // Country pills HTML
        const countryPillsHtml = countries.map(c => \`
          <div class="country-pill">
            <span class="country-code">\${escapeHtml(c)}</span>
          </div>
        \`).join('');

        const content = \`
          <!-- Metrics Grid -->
          <div class="metrics-grid">
            <div class="card">
              <div class="card-label">Net Worth (Капитал)</div>
              <div class="card-value">\${formatMoney(netWorth, baseCur)}</div>
              <div class="card-sub">Базовая валюта: \${escapeHtml(baseCur)}</div>
            </div>

            <div class="card">
              <div class="card-label">Поток за \${data.cash_flow_days || 30} дн.</div>
              <div class="card-value \${cashFlow >= 0 ? 'val-positive' : 'val-negative'}">
                \${cashFlow >= 0 ? '+' : ''}\${formatMoney(cashFlow, baseCur)}
              </div>
              <div class="card-sub">\${cashFlow >= 0 ? 'Приток капитала' : 'Отток капитала'}</div>
            </div>

            <div class="card">
              <div class="card-label">Минимум впереди</div>
              <div class="card-value \${lowest && lowest.amount_minor < 0 ? 'val-negative' : ''}">
                \${lowest ? formatMoney(lowest.amount_minor, baseCur) : '—'}
              </div>
              <div class="card-sub">\${lowest ? \`Дата минимума: \${formatDate(lowest.date)}\` : 'Без просадок'}</div>
            </div>
          </div>

          <!-- Diagnostics -->
          <div class="warnings-container">
            \${warningsHtml}
          </div>

          <!-- Forecast Chart -->
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">Прогноз баланса (\${horizon} дней)</div>
              <div class="countries-grid">\${countryPillsHtml}</div>
            </div>
            <div class="chart-svg-wrap" id="chartContainer">
              <!-- SVG Chart dynamically inserted -->
            </div>
          </div>

          <!-- Accounts -->
          <div>
            <div class="section-title">Счета и остатки (\${accounts.length})</div>
            <div class="accounts-list" style="margin-top: 6px;">
              \${accountsHtml}
            </div>
          </div>
        \`;

        document.getElementById('contentArea').innerHTML = content;
        renderSvgChart(series, lowest, baseCur);
      }

      // Draw responsive SVG chart
      function renderSvgChart(series, lowest, baseCur) {
        const container = document.getElementById('chartContainer');
        if (!container || !series || series.length === 0) return;

        const w = container.clientWidth || 660;
        const h = 150;
        const padL = 10;
        const padR = 10;
        const padT = 15;
        const padB = 25;

        const values = series.map(s => s.overall_minor / 100);
        let minVal = Math.min(...values);
        let maxVal = Math.max(...values);
        if (minVal === maxVal) {
          minVal -= 100;
          maxVal += 100;
        }
        const range = maxVal - minVal;

        const chartW = w - padL - padR;
        const chartH = h - padT - padB;

        const pts = series.map((s, i) => {
          const x = padL + (i / (series.length - 1)) * chartW;
          const y = padT + chartH - ((s.overall_minor / 100 - minVal) / range) * chartH;
          return { x, y, date: s.date, val: s.overall_minor };
        });

        const linePath = pts.map((p, i) => (i === 0 ? \`M \${p.x} \${p.y}\` : \`L \${p.x} \${p.y}\`)).join(' ');
        const areaPath = \`\${linePath} L \${pts[pts.length - 1].x} \${padT + chartH} L \${pts[0].x} \${padT + chartH} Z\`;

        // Baseline (zero line if visible)
        let zeroLine = '';
        if (minVal < 0 && maxVal > 0) {
          const zeroY = padT + chartH - ((0 - minVal) / range) * chartH;
          zeroLine = \`<line x1="\${padL}" y1="\${zeroY}" x2="\${w - padR}" y2="\${zeroY}" stroke="var(--danger-border)" stroke-dasharray="3,3" stroke-width="1.5" />\`;
        }

        // Lowest point marker
        let lowestMarker = '';
        if (lowest) {
          const lowIdx = series.findIndex(s => s.date === lowest.date);
          if (lowIdx >= 0) {
            const lp = pts[lowIdx];
            lowestMarker = \`
              <circle cx="\${lp.x}" cy="\${lp.y}" r="4.5" fill="var(--chart-lowest)" stroke="var(--card-bg)" stroke-width="2" />
            \`;
          }
        }

        // Date labels (start, mid, end)
        const dateLabels = [
          \`<text x="\${padL}" y="\${h - 6}" font-size="10" fill="var(--text-muted)" text-anchor="start">\${formatDate(series[0].date)}</text>\`,
          \`<text x="\${w / 2}" y="\${h - 6}" font-size="10" fill="var(--text-muted)" text-anchor="middle">\${formatDate(series[Math.floor(series.length / 2)].date)}</text>\`,
          \`<text x="\${w - padR}" y="\${h - 6}" font-size="10" fill="var(--text-muted)" text-anchor="end">\${formatDate(series[series.length - 1].date)}</text>\`
        ].join('');

        const svg = \`
          <svg viewBox="0 0 \${w} \${h}">
            <defs>
              <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--chart-line)" stop-opacity="0.25" />
                <stop offset="100%" stop-color="var(--chart-line)" stop-opacity="0.0" />
              </linearGradient>
            </defs>
            <path d="\${areaPath}" fill="url(#chartGrad)" />
            \${zeroLine}
            <path d="\${linePath}" fill="none" stroke="var(--chart-line)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            \${lowestMarker}
            \${dateLabels}
          </svg>
        \`;

        container.innerHTML = svg;

        // Interactive hover points
        const tooltip = document.getElementById('chartTooltip');
        container.onmousemove = (e) => {
          const rect = container.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const ratio = Math.max(0, Math.min(1, (mouseX - padL) / chartW));
          const idx = Math.round(ratio * (series.length - 1));
          const s = series[idx];
          if (!s) return;

          tooltip.style.display = 'block';
          tooltip.style.left = \`\${e.clientX + 10}px\`;
          tooltip.style.top = \`\${e.clientY - 25}px\`;
          tooltip.innerHTML = \`<strong>\${formatDate(s.date)}</strong>: \${formatMoney(s.overall_minor, baseCur)}\`;
        };

        container.onmouseleave = () => {
          tooltip.style.display = 'none';
        };
      }

      // Load data via MCP tools/call
      async function loadPulseData(days = 30) {
        document.getElementById('contentArea').innerHTML = \`
          <div class="loading-state">
            <div class="spinner"></div>
            <div>Загрузка прогноза и метрик Пульса...</div>
          </div>
        \`;

        try {
          const res = await sendRequest('tools/call', {
            name: 'forecast_get',
            arguments: { days }
          });

          let data = null;
          if (res?.structuredContent) {
            data = res.structuredContent;
          } else if (res?.content?.[0]?.text) {
            try { data = JSON.parse(res.content[0].text); } catch {}
          }

          if (data && (data.net_worth_minor !== undefined || data.series)) {
            renderPulse(data);
          } else {
            throw new Error('Некорректный формат ответа от forecast_get');
          }
        } catch (err) {
          document.getElementById('contentArea').innerHTML = \`
            <div class="error-state">
              <div style="font-size: 24px; margin-bottom: 6px;">⚠️</div>
              <div style="font-weight: 600; margin-bottom: 4px;">Ошибка загрузки данных Пульса</div>
              <div style="font-size: 11px;">\${escapeHtml(err.message || err)}</div>
              <button class="btn-icon" style="margin-top: 10px;" onclick="location.reload()">Повторить</button>
            </div>
          \`;
        }
      }

      // Lifecycle initialization
      async function initialize() {
        try {
          const initRes = await sendRequest('ui/initialize', {
            clientInfo: { name: 'money-flow-pulse-app', version: '1.0.0' },
            protocolVersion: '2026-01-26'
          }).catch(() => null);

          if (initRes?.theme) {
            setTheme(initRes.theme);
          }
          sendNotification('ui/notifications/initialized', {});
        } catch (e) {
          console.warn('Host initialization skipped/failed, proceeding to data load:', e);
        }

        loadPulseData(30);
      }

      initialize();
    })();
  </script>
</body>
</html>`;
}
