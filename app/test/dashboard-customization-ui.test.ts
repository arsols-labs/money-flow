import './use-ru-i18n';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardSettingsModal from '../src/ui/DashboardSettingsModal';
import { PulseDashboard } from '../src/ui/Pulse';
import { DEFAULT_DASHBOARD_CONFIG, DASHBOARD_BLOCK_DEFS, DEFAULT_PULSE_FILTERS } from '../src/ui/dashboardLayout';

describe('DashboardSettingsModal & Pulse customization UI', () => {
  const mockConfig = [
    { id: 'metrics', visible: true, column: 'left' },
    { id: 'warnings', visible: false, column: 'left' },
    { id: 'forecast', visible: true, column: 'full' },
    { id: 'upcoming', visible: true, column: 'right' },
    { id: 'accounts', visible: true, column: 'right' },
    { id: 'fx_rates', visible: true, column: 'full' },
  ];

  const mockForecast = {
    base_currency: 'EUR',
    net_worth_minor: 100000,
    low_balance_threshold_minor: 50000,
    cash_flow_minor: 15000,
    cash_flow_days: 30,
    lowest: null,
    missing_rates: [],
    warnings: [],
    accounts: [{ id: 1, name: 'Main', currency: 'EUR', balance_minor: 100000, owner: 'Alex', country: 'FR' }],
    upcoming: [],
    countries: [],
    as_of: '2026-09-09',
  };

  it('renders DashboardSettingsModal with dialog role and all blocks', () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardSettingsModal, {
        open: true,
        onClose: () => {},
        config: mockConfig,
        onChange: () => {},
        onReset: () => {},
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Настройка дашборда');
    expect(html).toContain('Ключевые метрики');
    expect(html).toContain('График прогноза');
    expect(html).toContain('Счета');
    expect(html).toContain('Скрыт');
    expect(html).toContain('Сбросить');
    expect(html).toContain('Готово');
  });

  it('renders null when DashboardSettingsModal is not open', () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardSettingsModal, {
        open: false,
        onClose: () => {},
        config: mockConfig,
        onChange: () => {},
        onReset: () => {},
      }),
    );

    expect(html).toBe('');
  });

  it('renders PulseDashboard with customized layout and blocks', () => {
    const html = renderToStaticMarkup(
      React.createElement(PulseDashboard, {
        forecast: mockForecast,
        fxRates: [],
        points: [],
        groupMode: 'owner',
        setGroupMode: () => {},
        config: mockConfig,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    expect(html).toContain('class="pulse-dashboard"');
    expect(html).toContain('pulse-block--metrics');
    expect(html).toContain('pulse-block--forecast');
    expect(html).toContain('pulse-block--upcoming');
    expect(html).toContain('pulse-block--accounts');
    expect(html).toContain('Настроить дашборд');
    expect(html).toContain('Страна/регион');
    expect(html).toContain('Счёт');
    expect(html).not.toContain('Пользователь');
    expect(html).toContain('Группировка рядов прогноза');
  });

  it('shows forecast user grouping only when two household owners exist', () => {
    const html = renderToStaticMarkup(
      React.createElement(PulseDashboard, {
        forecast: {
          ...mockForecast,
          owners: ['Alex', 'Sam'],
          accounts: [
            { id: 1, name: 'Main', currency: 'EUR', balance_minor: 100000, owner: 'Alex', country: 'FR' },
            { id: 2, name: 'Card', currency: 'EUR', balance_minor: -5000, owner: 'Sam', country: 'DE' },
          ],
          series: [{
            date: '2026-09-21',
            overall_minor: 95000,
            by_country: { FR: 100000, DE: -5000 },
            by_account: { 1: 100000, 2: -5000 },
            by_owner: { Alex: 100000, Sam: -5000 },
          }],
        },
        fxRates: [],
        points: [],
        config: mockConfig,
        filters: { ...DEFAULT_PULSE_FILTERS, forecastGroupMode: 'user' },
      }),
    );

    expect(html).toContain('Пользователь');
    expect(html).toContain('Сбросить группировку прогноза');
  });

  it('renders friendly empty state when all blocks are hidden', () => {
    const emptyConfig = mockConfig.map((b) => ({ ...b, visible: false }));
    const html = renderToStaticMarkup(
      React.createElement(PulseDashboard, {
        forecast: mockForecast,
        fxRates: [],
        points: [],
        groupMode: 'owner',
        setGroupMode: () => {},
        config: emptyConfig,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    expect(html).toContain('class="pulse-empty-dashboard"');
    expect(html).toContain('Все блоки дашборда скрыты в настройках');
    expect(html).toContain('Сбросить');
    expect(html).toContain('Настроить дашборд');
  });

  it('renders "Авто" column placement chip in DashboardSettingsModal', () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardSettingsModal, {
        open: true,
        onClose: () => {},
        config: mockConfig,
        onChange: () => {},
        onReset: () => {},
      }),
    );

    expect(html).toContain('Авто');
    expect(html).toContain('Слева');
    expect(html).toContain('Справа');
    expect(html).toContain('На всю ширину');
  });

  it('renders "Поток" in 2 lines with inline period badge and filter reset button when non-default filter is set', () => {
    const customFilters = {
      forecastPeriod: 'quarter',
      spentPeriod: 'yesterday',
      warningsFilter: 'currency',
      upcomingRange: 'week',
      upcomingFilter: 'expense',
      accountsGroupMode: 'country',
    };

    const html = renderToStaticMarkup(
      React.createElement(PulseDashboard, {
        forecast: mockForecast,
        fxRates: [],
        points: [],
        groupMode: 'country',
        setGroupMode: () => {},
        config: mockConfig,
        filters: customFilters,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    // 2-line metric: label has inline sub, and metric-sub class is not present in Flow
    expect(html).toContain('Поток');
    expect(html).toContain('metric-sub-inline');
    // Filter reset buttons present for non-default values
    expect(html).toContain('filter-reset-icon-btn');
    expect(html).toContain('Сбросить период прогноза');
    expect(html).toContain('Сбросить группировку счетов');
  });

  it('renders collapsed state for Upcoming and Accounts sections when specified in filters', () => {
    const collapsedFilters = {
      ...DEFAULT_PULSE_FILTERS,
      upcomingOpen: false,
      accountsOpen: false,
    };

    const html = renderToStaticMarkup(
      React.createElement(PulseDashboard, {
        forecast: mockForecast,
        fxRates: [],
        points: [],
        config: mockConfig,
        filters: collapsedFilters,
      }),
    );

    // Both sections have aria-expanded="false"
    expect(html).toContain('aria-expanded="false"');
    // Bodies are not rendered when collapsed
    expect(html).not.toContain('upcoming-list');
    expect(html).not.toContain('accounts-groups');
  });
});
