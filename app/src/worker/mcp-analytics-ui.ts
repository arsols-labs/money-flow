/**
 * MCP Apps — Аналитика (Analytics) UI
 * SEP-1865: text/html;profile=mcp-app
 * Интерактивный интерфейс аналитики расходов и структуры трат внутри переписки.
 */

import { MCP_WIDGET_RPC_SCRIPT } from './mcp-widget-rpc';

export function getAnalyticsHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Аналитика — Money Flow</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #2563eb;
      --accent-light: #eff6ff;
      --accent-hover: #1d4ed8;
      --success-bg: #ecfdf5;
      --success-text: #059669;
      --success-border: #a7f3d0;
      --warning-bg: #fffbeb;
      --warning-text: #d97706;
      --warning-border: #fde68a;
      --danger-bg: #fef2f2;
      --danger-text: #dc2626;
      --danger-border: #fecaca;
      --bar-track: #f1f5f9;
      --bar-fill: #3b82f6;
      --bar-income: #10b981;
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
        --accent-hover: #60a5fa;
        --success-bg: rgba(6, 78, 59, 0.35);
        --success-text: #34d399;
        --success-border: rgba(5, 150, 105, 0.4);
        --warning-bg: rgba(120, 53, 15, 0.35);
        --warning-text: #fbbf24;
        --warning-border: rgba(217, 119, 6, 0.4);
        --danger-bg: rgba(127, 29, 29, 0.35);
        --danger-text: #f87171;
        --danger-border: rgba(220, 38, 38, 0.4);
        --bar-track: #334155;
        --bar-fill: #60a5fa;
        --bar-income: #34d399;
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
      --accent-hover: #60a5fa;
      --success-bg: rgba(6, 78, 59, 0.35);
      --success-text: #34d399;
      --success-border: rgba(5, 150, 105, 0.4);
      --warning-bg: rgba(120, 53, 15, 0.35);
      --warning-text: #fbbf24;
      --warning-border: rgba(217, 119, 6, 0.4);
      --danger-bg: rgba(127, 29, 29, 0.35);
      --danger-text: #f87171;
      --danger-border: rgba(220, 38, 38, 0.4);
      --bar-track: #334155;
      --bar-fill: #60a5fa;
      --bar-income: #34d399;
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
      --accent-hover: #1d4ed8;
      --success-bg: #ecfdf5;
      --success-text: #059669;
      --success-border: #a7f3d0;
      --warning-bg: #fffbeb;
      --warning-text: #d97706;
      --warning-border: #fde68a;
      --danger-bg: #fef2f2;
      --danger-text: #dc2626;
      --danger-border: #fecaca;
      --bar-track: #f1f5f9;
      --bar-fill: #3b82f6;
      --bar-income: #10b981;
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

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 2px;
      flex-wrap: wrap;
      gap: 8px;
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

    /* Period selector chips */
    .period-bar {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      align-items: center;
    }
    .chip {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      border-radius: 20px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .chip:hover {
      border-color: var(--accent);
      color: var(--text);
    }
    .chip.active {
      background: var(--accent-light);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }
    .filter-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
      margin-top: 4px;
    }
    .active-tag {
      background: var(--accent-light);
      border: 1px solid var(--accent);
      color: var(--accent);
      border-radius: 12px;
      padding: 2px 8px;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .active-tag-remove {
      cursor: pointer;
      font-weight: bold;
      opacity: 0.7;
    }
    .active-tag-remove:hover {
      opacity: 1;
    }

    /* Cards Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 8px;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 10px 12px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .card-label {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .card-value {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .card-sub {
      font-size: 10.5px;
      color: var(--text-muted);
    }
    .val-spent { color: var(--danger-text); }
    .val-income { color: var(--success-text); }

    /* Chart Section */
    .chart-card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chart-title {
      font-size: 12.5px;
      font-weight: 600;
    }
    .granularity-bar {
      display: flex;
      gap: 3px;
    }
    .gran-btn {
      background: var(--bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 10.5px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .gran-btn.active {
      background: var(--accent-light);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }
    .chart-svg-wrap {
      width: 100%;
      height: 130px;
      position: relative;
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    /* Breakdown sections */
    .breakdowns-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 10px;
    }
    .breakdown-card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 12px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .breakdown-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .breakdown-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-muted);
    }
    .breakdown-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .bar-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 6px;
      transition: background-color 0.15s;
    }
    .bar-row:hover {
      background-color: var(--accent-light);
    }
    .bar-row-header {
      display: flex;
      justify-content: space-between;
      font-size: 11.5px;
    }
    .bar-label {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 170px;
    }
    .bar-meta {
      font-weight: 600;
      text-align: right;
    }
    .bar-track {
      width: 100%;
      height: 5px;
      background-color: var(--bar-track);
      border-radius: 3px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background-color: var(--bar-fill);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    /* Top items table */
    .top-items-card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--card-border);
      font-size: 11.5px;
    }
    .item-row:last-child {
      border-bottom: none;
    }
    .item-name {
      font-weight: 500;
    }
    .item-amount {
      font-weight: 600;
      color: var(--danger-text);
    }

    /* Loading & Error */
    .loading-state, .error-state, .empty-state {
      text-align: center;
      padding: 28px 16px;
      color: var(--text-muted);
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
    }
    .spinner {
      display: inline-block;
      width: 22px;
      height: 22px;
      border: 2.5px solid var(--card-border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 6px;
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
          <span>📊 Аналитика</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn-icon" id="themeBtn" title="Переключить тему">🌓</button>
        <button class="btn-icon" id="refreshBtn" title="Обновить">🔄</button>
      </div>
    </div>

    <!-- Period Chips -->
    <div class="period-bar" id="periodBar">
      <button class="chip" data-period="d7">7 дней</button>
      <button class="chip active" data-period="d30">30 дней</button>
      <button class="chip" data-period="m0">Этот месяц</button>
      <button class="chip" data-period="m1">Прошлый месяц</button>
      <button class="chip" data-period="all">Всё время</button>
    </div>

    <!-- Active Filters -->
    <div class="filter-tags" id="activeFilterTags" style="display: none;"></div>

    <div id="contentArea">
      <div class="loading-state">
        <div class="spinner"></div>
        <div>Загрузка аналитики...</div>
      </div>
    </div>
  </div>

  <div id="chartTooltip" class="tooltip"></div>

  <script>
    (function() {
${MCP_WIDGET_RPC_SCRIPT}
      let currentPeriod = 'd30';
      let currentGranularity = 'day';
      let selectedCats = new Set();
      let selectedMerchants = new Set();
      let lastAnalyticsData = null;

      // Theme handler
      function setTheme(theme) {
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
        fetchAnalytics();
      });

      // Period change handler
      document.getElementById('periodBar').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-period]');
        if (!btn) return;
        const p = btn.getAttribute('data-period');
        if (p === currentPeriod) return;

        document.querySelectorAll('#periodBar .chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        currentPeriod = p;
        fetchAnalytics();
      });

      function formatYMD(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return \`\${y}-\${m}-\${day}\`;
      }

      function getPeriodDates(key) {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth();
        const today = new Date(y, m, now.getDate());

        switch (key) {
          case 'd7': {
            const start = new Date(today);
            start.setDate(today.getDate() - 6);
            return { start_date: formatYMD(start), end_date: formatYMD(today) };
          }
          case 'd30': {
            const start = new Date(today);
            start.setDate(today.getDate() - 29);
            return { start_date: formatYMD(start), end_date: formatYMD(today) };
          }
          case 'm0': {
            const start = new Date(y, m, 1);
            return { start_date: formatYMD(start), end_date: formatYMD(today) };
          }
          case 'm1': {
            const start = new Date(y, m - 1, 1);
            const end = new Date(y, m, 0);
            return { start_date: formatYMD(start), end_date: formatYMD(end) };
          }
          case 'all':
          default:
            return { start_date: null, end_date: null };
        }
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

        if (msg.method === 'ui/theme_changed' && typeof msg.params?.theme === 'string') {
          setTheme(msg.params.theme);
        }
      });

      // Formatters
      function formatMoney(minor, currency = 'USD') {
        if (minor === null || minor === undefined) return '0 $';
        const amount = minor / 100;
        return new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: currency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 2
        }).format(amount);
      }

      function formatDateTs(ts) {
        const d = new Date(ts);
        const day = String(d.getUTCDate()).padStart(2, '0');
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        return \`\${day}.\${month}\`;
      }

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // Render Active Filter Tags
      function renderFilterTags() {
        const container = document.getElementById('activeFilterTags');
        const tags = [];
        selectedCats.forEach(cat => {
          tags.push(\`<span class="active-tag">Категория: \${escapeHtml(cat)} <span class="active-tag-remove" data-type="cat" data-value="\${escapeHtml(cat)}">×</span></span>\`);
        });
        selectedMerchants.forEach(m => {
          tags.push(\`<span class="active-tag">Магазин: \${escapeHtml(m)} <span class="active-tag-remove" data-type="merchant" data-value="\${escapeHtml(m)}">×</span></span>\`);
        });

        if (tags.length > 0) {
          container.style.display = 'flex';
          container.innerHTML = tags.join('') + \`<button class="chip" id="clearAllFiltersBtn" style="font-size: 10px; padding: 2px 7px;">Сбросить все</button>\`;
          
          container.querySelectorAll('.active-tag-remove').forEach(el => {
            el.addEventListener('click', (e) => {
              const type = e.target.getAttribute('data-type');
              const val = e.target.getAttribute('data-value');
              if (type === 'cat') selectedCats.delete(val);
              if (type === 'merchant') selectedMerchants.delete(val);
              fetchAnalytics();
            });
          });

          const clearBtn = document.getElementById('clearAllFiltersBtn');
          if (clearBtn) {
            clearBtn.addEventListener('click', () => {
              selectedCats.clear();
              selectedMerchants.clear();
              fetchAnalytics();
            });
          }
        } else {
          container.style.display = 'none';
          container.innerHTML = '';
        }
      }

      // Render Analytics UI
      function renderAnalytics(data) {
        lastAnalyticsData = data;
        renderFilterTags();

        const stats = data.stats || {};
        const totalSpent = stats.total_spent_minor || 0;
        const totalIncome = stats.total_income_minor || 0;
        const avgReceipt = stats.avg_receipt_minor || 0;
        const perDay = stats.per_day_minor || 0;
        const receiptsCount = stats.receipts_count || 0;
        const positionsCount = stats.positions_count || 0;

        const categories = data.categories || [];
        const merchants = data.merchants || [];
        const topExpenses = (data.top_items && data.top_items.expense) || [];

        // Category breakdown HTML
        const maxCatVal = categories.length > 0 ? categories[0].value_minor : 1;
        const catRows = categories.slice(0, 7).map(c => {
          const pct = Math.max(2, Math.round((c.value_minor / (maxCatVal || 1)) * 100));
          const isSelected = selectedCats.has(c.label);
          return \`
            <div class="bar-row \${isSelected ? 'active-filter-row' : ''}" data-type="cat" data-value="\${escapeHtml(c.label)}">
              <div class="bar-row-header">
                <span class="bar-label">\${escapeHtml(c.label)}</span>
                <span class="bar-meta">\${formatMoney(c.value_minor)}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" style="width: \${pct}%;"></div>
              </div>
            </div>
          \`;
        }).join('');

        // Merchants breakdown HTML
        const maxMerchVal = merchants.length > 0 ? merchants[0].value_minor : 1;
        const merchRows = merchants.slice(0, 7).map(m => {
          const pct = Math.max(2, Math.round((m.value_minor / (maxMerchVal || 1)) * 100));
          const isSelected = selectedMerchants.has(m.label);
          return \`
            <div class="bar-row \${isSelected ? 'active-filter-row' : ''}" data-type="merchant" data-value="\${escapeHtml(m.label)}">
              <div class="bar-row-header">
                <span class="bar-label">\${escapeHtml(m.label)}</span>
                <span class="bar-meta">\${formatMoney(m.value_minor)}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" style="width: \${pct}%;"></div>
              </div>
            </div>
          \`;
        }).join('');

        // Top items HTML
        const topItemsRows = topExpenses.slice(0, 5).map(item => \`
          <div class="item-row">
            <span class="item-name">\${escapeHtml(item.label)} \${item.count > 1 ? \`<span style="color:var(--text-muted);font-size:10px;">(×\${item.count})</span>\` : ''}</span>
            <span class="item-amount">\${formatMoney(item.value_minor)}</span>
          </div>
        \`).join('');

        const content = \`
          <!-- Summary Cards -->
          <div class="metrics-grid">
            <div class="card">
              <div class="card-label">Потрачено</div>
              <div class="card-value val-spent">\${formatMoney(totalSpent)}</div>
              <div class="card-sub">\${positionsCount} поз. в \${receiptsCount} чек.</div>
            </div>

            <div class="card">
              <div class="card-label">В день</div>
              <div class="card-value">\${formatMoney(perDay)}</div>
              <div class="card-sub">Средний расход</div>
            </div>

            <div class="card">
              <div class="card-label">Средний чек</div>
              <div class="card-value">\${formatMoney(avgReceipt)}</div>
              <div class="card-sub">За операцию/чек</div>
            </div>

            <div class="card">
              <div class="card-label">Доходы</div>
              <div class="card-value val-income">\${formatMoney(totalIncome)}</div>
              <div class="card-sub">За период</div>
            </div>
          </div>

          <!-- Dynamic Spending Chart -->
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">Динамика расходов</div>
              <div class="granularity-bar" id="granularityBar">
                <button class="gran-btn \${currentGranularity === 'day' ? 'active' : ''}" data-gran="day">День</button>
                <button class="gran-btn \${currentGranularity === 'week' ? 'active' : ''}" data-gran="week">Неделя</button>
                <button class="gran-btn \${currentGranularity === 'month' ? 'active' : ''}" data-gran="month">Месяц</button>
              </div>
            </div>
            <div class="chart-svg-wrap" id="chartContainer"></div>
          </div>

          <!-- Breakdowns: Categories & Merchants -->
          <div class="breakdowns-grid">
            <div class="breakdown-card">
              <div class="breakdown-header">
                <span class="breakdown-title">Категории (\${categories.length})</span>
              </div>
              <div class="breakdown-list" id="catList">
                \${catRows || '<div class="card-sub" style="padding: 10px 0;">Нет данных по категориям</div>'}
              </div>
            </div>

            <div class="breakdown-card">
              <div class="breakdown-header">
                <span class="breakdown-title">Магазины (\${merchants.length})</span>
              </div>
              <div class="breakdown-list" id="merchList">
                \${merchRows || '<div class="card-sub" style="padding: 10px 0;">Нет данных по магазинам</div>'}
              </div>
            </div>
          </div>

          <!-- Top Expenses -->
          <div class="top-items-card">
            <div class="breakdown-header" style="margin-bottom: 6px;">
              <span class="breakdown-title">Топ покупок</span>
            </div>
            <div>
              \${topItemsRows || '<div class="card-sub" style="padding: 10px 0;">Нет данных о покупках</div>'}
            </div>
          </div>
        \`;

        document.getElementById('contentArea').innerHTML = content;

        // Attach listeners for filter clicks on categories and merchants
        document.querySelectorAll('#catList .bar-row').forEach(row => {
          row.addEventListener('click', () => {
            const val = row.getAttribute('data-value');
            if (selectedCats.has(val)) selectedCats.delete(val);
            else selectedCats.add(val);
            fetchAnalytics();
          });
        });

        document.querySelectorAll('#merchList .bar-row').forEach(row => {
          row.addEventListener('click', () => {
            const val = row.getAttribute('data-value');
            if (selectedMerchants.has(val)) selectedMerchants.delete(val);
            else selectedMerchants.add(val);
            fetchAnalytics();
          });
        });

        // Granularity click listener
        document.getElementById('granularityBar').addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-gran]');
          if (!btn) return;
          const gran = btn.getAttribute('data-gran');
          if (gran === currentGranularity) return;
          currentGranularity = gran;
          document.querySelectorAll('#granularityBar .gran-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderChart();
        });

        renderChart();
      }

      // Draw SVG Column / Area Chart
      function renderChart() {
        if (!lastAnalyticsData || !lastAnalyticsData.series) return;
        const series = lastAnalyticsData.series[currentGranularity] || [];
        const container = document.getElementById('chartContainer');
        if (!container) return;

        if (series.length === 0) {
          container.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;">Нет данных за выбранный период</div>';
          return;
        }

        const w = container.clientWidth || 660;
        const h = 130;
        const padL = 10;
        const padR = 10;
        const padT = 10;
        const padB = 20;

        const maxVal = Math.max(...series.map(s => s.total_minor), 100);
        const chartW = w - padL - padR;
        const chartH = h - padT - padB;

        const count = series.length;
        const colWidth = Math.max(3, Math.min(24, (chartW / count) * 0.7));
        const gap = (chartW - count * colWidth) / (count > 1 ? count - 1 : 1);

        const bars = series.map((s, i) => {
          const x = count === 1 ? padL + chartW / 2 - colWidth / 2 : padL + i * (colWidth + gap);
          const barHeight = Math.max(2, (s.total_minor / maxVal) * chartH);
          const y = padT + chartH - barHeight;
          return \`
            <rect x="\${x}" y="\${y}" width="\${colWidth}" height="\${barHeight}" rx="2" fill="var(--bar-fill)" opacity="0.85" data-idx="\${i}" />
          \`;
        }).join('');

        // Date labels (start, mid, end)
        const dateLabels = [
          \`<text x="\${padL}" y="\${h - 4}" font-size="9.5" fill="var(--text-muted)" text-anchor="start">\${formatDateTs(series[0].ts)}</text>\`,
          count > 2 ? \`<text x="\${w / 2}" y="\${h - 4}" font-size="9.5" fill="var(--text-muted)" text-anchor="middle">\${formatDateTs(series[Math.floor(count / 2)].ts)}</text>\` : '',
          count > 1 ? \`<text x="\${w - padR}" y="\${h - 4}" font-size="9.5" fill="var(--text-muted)" text-anchor="end">\${formatDateTs(series[count - 1].ts)}</text>\` : ''
        ].join('');

        container.innerHTML = \`
          <svg viewBox="0 0 \${w} \${h}">
            \${bars}
            \${dateLabels}
          </svg>
        \`;

        // Interactive hover
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
          tooltip.innerHTML = \`<strong>\${formatDateTs(s.ts)}</strong>: \${formatMoney(s.total_minor)}\`;
        };

        container.onmouseleave = () => {
          tooltip.style.display = 'none';
        };
      }

      // Load analytics via tools/call
      async function fetchAnalytics() {
        const dates = getPeriodDates(currentPeriod);
        const args = {
          start_date: dates.start_date,
          end_date: dates.end_date,
        };
        if (selectedCats.size > 0) args.cats = Array.from(selectedCats);
        if (selectedMerchants.size > 0) args.merchants = Array.from(selectedMerchants);

        document.getElementById('contentArea').innerHTML = \`
          <div class="loading-state">
            <div class="spinner"></div>
            <div>Загрузка аналитики...</div>
          </div>
        \`;

        try {
          const res = await sendRequest('tools/call', {
            name: 'analytics_get',
            arguments: args
          });

          let data = null;
          if (res?.structuredContent) {
            data = res.structuredContent;
          } else if (res?.content?.[0]?.text) {
            try { data = JSON.parse(res.content[0].text); } catch {}
          }

          if (data && (data.stats !== undefined || data.categories)) {
            renderAnalytics(data);
          } else {
            throw new Error('Некорректный формат ответа от analytics_get');
          }
        } catch (err) {
          document.getElementById('contentArea').innerHTML = \`
            <div class="error-state">
              <div style="font-size: 24px; margin-bottom: 6px;">⚠️</div>
              <div style="font-weight: 600; margin-bottom: 4px;">Ошибка загрузки аналитики</div>
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
            clientInfo: { name: 'money-flow-analytics-app', version: '1.0.0' },
            protocolVersion: '2026-01-26'
          }).catch(() => null);

          if (initRes?.theme) {
            setTheme(initRes.theme);
          }
          sendNotification('ui/notifications/initialized', {});
        } catch (e) {
          console.warn('Host initialization skipped/failed, proceeding to data load:', e);
        }

        fetchAnalytics();
      }

      initialize();
    })();
  </script>
</body>
</html>`;
}
