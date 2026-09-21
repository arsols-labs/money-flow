import '../src/ui/i18n.js';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardSettingsModal, { applyBlockColumnChange } from '../src/ui/DashboardSettingsModal';
import { AnalyticsDashboard } from '../src/ui/Analytics';
import {
  DEFAULT_ANALYTICS_CONFIG,
  ANALYTICS_BLOCK_DEFS,
} from '../src/ui/analyticsLayout';

describe('Analytics customization UI & AnalyticsDashboard', () => {
  const mockConfig = [
    { id: 'metrics', visible: true, column: 'full' },
    { id: 'trend', visible: true, column: 'full' },
    { id: 'top_items', visible: true, column: 'left' },
    { id: 'categories', visible: true, column: 'left' },
    { id: 'subcategories', visible: true, column: 'right' },
    { id: 'merchants', visible: true, column: 'right' },
    { id: 'recurring', visible: false, column: 'left' },
    { id: 'receipts', visible: true, column: 'right' },
    { id: 'fx_rates', visible: true, column: 'full' },
  ];

  const mockData = {
    base_currency: 'EUR',
    stats: {
      total_spent_minor: -125000,
      total_income_minor: 250000,
      avg_receipt_minor: -3500,
      per_day_minor: -4000,
      receipts_count: 25,
      positions_count: 42,
    },
    series: {
      day: [
        { ts: '2026-09-01T00:00:00Z', total_minor: -1500 },
        { ts: '2026-09-02T00:00:00Z', total_minor: -3200 },
      ],
      week: [],
      month: [],
    },
    top_items: {
      expense: [{ label: 'Supermarket', total_minor: -12000, count: 3 }],
      income: [{ label: 'Salary', total_minor: 200000, count: 1 }],
      refund: [],
    },
    categories: [{ label: 'Продукты', total_minor: -15000, receipts_count: 5 }],
    subcategories: [{ label: 'Кофе', total_minor: -2500, count: 4 }],
    merchants: [{ label: 'Mercadona', total_minor: -12000, receipts_count: 3 }],
    plans: { items: [], categories: [] },
    recurring_details: [],
    recurring_operations: [],
    receipts: [
      {
        id: 1,
        date: '2026-09-01',
        merchant: 'Mercadona',
        receipt_total_minor: -5000,
        receipt_total_base_minor: -5000,
        positions_count: 2,
        lines: [],
      },
    ],
    options: {
      categories: [{ label: 'Продукты', count: 5 }],
      merchants: [{ label: 'Mercadona', count: 3 }],
      accounts: ['Main'],
      currencies: ['EUR'],
    },
  };

  it('renders DashboardSettingsModal configured for Analytics', () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardSettingsModal, {
        open: true,
        onClose: () => {},
        config: mockConfig,
        onChange: () => {},
        onReset: () => {},
        title: 'Настройка аналитики',
        description: 'Настройте порядок, видимость и расположение блоков экрана аналитики.',
        blockDefs: ANALYTICS_BLOCK_DEFS,
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Настройка аналитики');
    expect(html).toContain('Key metrics');
    expect(html).toContain('Spending trend');
    expect(html).toContain('Top items');
    expect(html).toContain('Categories');
    expect(html).toContain('Subcategories');
    expect(html).toContain('Merchants');
    expect(html).toContain('Recurring');
    expect(html).toContain('Receipts');
    expect(html).toContain('Exchange rates');
    expect(html).toContain('Hidden'); // recurring is hidden in mockConfig
    expect(html).toContain('Reset');
    expect(html).toContain('Auto');
    expect(html).toContain('Left');
    expect(html).toContain('Right');
    expect(html).toContain('Full width');
  });

  it('updates column configuration when column chip is clicked via applyBlockColumnChange', () => {
    const initialConfig = [
      { id: 'categories', visible: true, column: 'auto' },
      { id: 'top_items', visible: true, column: 'left' },
      { id: 'merchants', visible: true, column: 'right' },
    ];

    // Change categories to 'right'
    const updatedRight = applyBlockColumnChange(initialConfig, 'categories', 'right', ANALYTICS_BLOCK_DEFS);
    expect(updatedRight.find((b: any) => b.id === 'categories')?.column).toBe('right');

    // Change top_items to 'full'
    const updatedFull = applyBlockColumnChange(initialConfig, 'top_items', 'full', ANALYTICS_BLOCK_DEFS);
    expect(updatedFull.find((b: any) => b.id === 'top_items')?.column).toBe('full');

    // Change merchants to 'left'
    const updatedLeft = applyBlockColumnChange(initialConfig, 'merchants', 'left', ANALYTICS_BLOCK_DEFS);
    expect(updatedLeft.find((b: any) => b.id === 'merchants')?.column).toBe('left');

    // Disallowed column rejected gracefully
    const invalid = applyBlockColumnChange(initialConfig, 'categories', 'nonexistent_col', ANALYTICS_BLOCK_DEFS);
    expect(invalid).toEqual(initialConfig);
  });

  it('renders active column chips in DashboardSettingsModal for custom column placements', () => {
    const customConfig = [
      { id: 'categories', visible: true, column: 'right' },
      { id: 'top_items', visible: true, column: 'full' },
      { id: 'merchants', visible: true, column: 'left' },
    ];

    const html = renderToStaticMarkup(
      React.createElement(DashboardSettingsModal, {
        open: true,
        onClose: () => {},
        config: customConfig,
        onChange: () => {},
        onReset: () => {},
        title: 'Настройка аналитики',
        blockDefs: ANALYTICS_BLOCK_DEFS,
      }),
    );

    expect(html).toContain('dashboard-col-chip--active');
  });

  it('renders AnalyticsDashboard with customized blocks and layout', () => {
    const html = renderToStaticMarkup(
      React.createElement(AnalyticsDashboard, {
        data: mockData,
        fxRates: [],
        baseCurrency: 'EUR',
        stats: mockData.stats,
        categories: mockData.categories,
        subcategories: mockData.subcategories,
        merchants: mockData.merchants,
        recurringOps: [],
        recurringDetails: [],
        receipts: mockData.receipts,
        config: mockConfig,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    expect(html).toContain('class="analytics-dashboard"');
    expect(html).toContain('analytics-block--metrics');
    expect(html).toContain('analytics-block--trend');
    expect(html).toContain('analytics-block--top-items');
    expect(html).toContain('analytics-block--categories');
    expect(html).toContain('analytics-block--subcategories');
    expect(html).toContain('analytics-block--merchants');
    expect(html).toContain('analytics-block--receipts');
    expect(html).toContain('analytics-block--fx');
    // recurring is hidden
    expect(html).not.toContain('analytics-block--recurring');
    expect(html).toContain('Customize analytics');

    // Verify sequential rendering order matches mockConfig: metrics -> trend -> top_items -> categories -> subcategories -> merchants -> receipts -> fx
    const metricsPos = html.indexOf('analytics-block--metrics');
    const trendPos = html.indexOf('analytics-block--trend');
    const topItemsPos = html.indexOf('analytics-block--top-items');
    const categoriesPos = html.indexOf('analytics-block--categories');
    const receiptsPos = html.indexOf('analytics-block--receipts');
    const fxPos = html.indexOf('analytics-block--fx');

    expect(metricsPos).toBeLessThan(trendPos);
    expect(trendPos).toBeLessThan(topItemsPos);
    expect(topItemsPos).toBeLessThan(categoriesPos);
    expect(receiptsPos).toBeLessThan(fxPos);
  });

  it('strictly respects custom block order (e.g. moving receipts to first position)', () => {
    // Put receipts first, then metrics
    const reorderedConfig = [
      { id: 'receipts', visible: true, column: 'full' },
      { id: 'metrics', visible: true, column: 'full' },
    ];

    const html = renderToStaticMarkup(
      React.createElement(AnalyticsDashboard, {
        data: mockData,
        fxRates: [],
        baseCurrency: 'EUR',
        stats: mockData.stats,
        categories: mockData.categories,
        subcategories: mockData.subcategories,
        merchants: mockData.merchants,
        recurringOps: [],
        recurringDetails: [],
        receipts: mockData.receipts,
        config: reorderedConfig,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    const receiptsPos = html.indexOf('analytics-block--receipts');
    const metricsPos = html.indexOf('analytics-block--metrics');
    expect(receiptsPos).toBeGreaterThan(-1);
    expect(metricsPos).toBeGreaterThan(-1);
    expect(receiptsPos).toBeLessThan(metricsPos);
  });

  it('renders graceful empty state when all blocks are hidden', () => {
    const emptyConfig = mockConfig.map((b) => ({ ...b, visible: false }));
    const html = renderToStaticMarkup(
      React.createElement(AnalyticsDashboard, {
        data: mockData,
        fxRates: [],
        baseCurrency: 'EUR',
        stats: mockData.stats,
        categories: mockData.categories,
        subcategories: mockData.subcategories,
        merchants: mockData.merchants,
        recurringOps: [],
        recurringDetails: [],
        receipts: mockData.receipts,
        config: emptyConfig,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    expect(html).toContain('class="analytics-empty-dashboard"');
    expect(html).toContain('All analytics blocks are hidden in settings.');
    expect(html).toContain('Reset');
    expect(html).toContain('Customize analytics');
  });

  it('renders inline RotateCcw reset buttons when non-default section filters are active', () => {
    const customFilters = {
      period: 'm1',
      q: '',
      cats: [],
      merchants: [],
      accounts: [],
      currencies: [],
      trendGranularity: 'month',
      topItemsKind: 'income',
      topItemsLimit: 20,
      recurringView: 'daily',
      recurringCat: '',
      recurringSubcat: '',
    };

    const html = renderToStaticMarkup(
      React.createElement(AnalyticsDashboard, {
        data: mockData,
        fxRates: [],
        baseCurrency: 'EUR',
        stats: mockData.stats,
        categories: mockData.categories,
        subcategories: mockData.subcategories,
        merchants: mockData.merchants,
        recurringOps: [],
        recurringDetails: [],
        receipts: mockData.receipts,
        config: DEFAULT_ANALYTICS_CONFIG,
        blockFilters: customFilters,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    expect(html).toContain('filter-reset-icon-btn');
    expect(html).toContain('Reset chart scale');
    expect(html).toContain('Reset top items filters');
  });

  it('respects collapsible section open states from blockFilters', () => {
    const filtersWithCollapsed = {
      period: 'd30',
      q: '',
      cats: [],
      merchants: [],
      accounts: [],
      currencies: [],
      trendGranularity: 'day',
      topItemsKind: 'expense',
      topItemsLimit: 10,
      recurringView: 'categories',
      recurringCat: '',
      recurringSubcat: '',
      topItemsOpen: false,
      categoriesOpen: false,
      subcategoriesOpen: true,
      merchantsOpen: true,
      recurringOpen: true,
      receiptsOpen: false,
    };

    const html = renderToStaticMarkup(
      React.createElement(AnalyticsDashboard, {
        data: mockData,
        fxRates: [],
        baseCurrency: 'EUR',
        stats: mockData.stats,
        categories: mockData.categories,
        subcategories: mockData.subcategories,
        merchants: mockData.merchants,
        recurringOps: [],
        recurringDetails: [],
        receipts: mockData.receipts,
        config: DEFAULT_ANALYTICS_CONFIG,
        blockFilters: filtersWithCollapsed,
        onOpenSettings: () => {},
        onResetConfig: () => {},
      }),
    );

    // Collapsed sections should render aria-expanded="false"
    // Top items is collapsed
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?<span[^>]*class="card-title"[^>]*>Top items<\/span>/);
    // Categories is collapsed
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?<span[^>]*class="card-title"[^>]*>Categories<\/span>/);
    // Receipts is collapsed
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?<span[^>]*class="card-title"[^>]*>Receipts<\/span>/);

    // Open sections should render aria-expanded="true"
    // Subcategories is open
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*>[\s\S]*?<span[^>]*class="card-title"[^>]*>Subcategories<\/span>/);
    // Merchants is open
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*>[\s\S]*?<span[^>]*class="card-title"[^>]*>Merchants<\/span>/);
  });
});
