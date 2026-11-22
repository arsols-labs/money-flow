import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardSettingsModal, { applyBlockColumnChange } from '../src/ui/DashboardSettingsModal';
import { DataDashboard } from '../src/ui/Data';
import RulesSettingsSection from '../src/ui/RulesSettingsSection';
import Shell from '../src/ui/Shell';
import { applyRuntimeConfigPayload, hasRequiredCurrencyConfig } from '../src/ui/runtimeConfig';
import { RefreshProvider } from '../src/ui/RefreshContext';
import {
  DEFAULT_DATA_CONFIG,
  DATA_BLOCK_DEFS,
  DEFAULT_DATA_FILTERS,
} from '../src/ui/dataLayout';
import i18n from '../src/ui/i18n';

describe('Data customization UI & DataDashboard', () => {
  const mockConfig = [
    { id: 'operations', visible: true, column: 'full' },
    { id: 'receipts', visible: true, column: 'full' },
    { id: 'accounts', visible: true, column: 'full' },
    { id: 'planned', visible: true, column: 'full' },
    { id: 'recurring', visible: true, column: 'full' },
    { id: 'rates', visible: false, column: 'full' },
    { id: 'forecast', visible: true, column: 'full' },
    { id: 'rules', visible: true, column: 'full' },
  ];

  const mockAccounts = [
    {
      id: 1,
      name: 'Основной счёт',
      currency: 'USD',
      balance_minor: 150000,
      bank: 'Bank of America',
      archived: 0,
    },
  ];

  it('renders DashboardSettingsModal configured for Data screen without column pickers', () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardSettingsModal, {
        open: true,
        onClose: () => {},
        config: mockConfig,
        onChange: () => {},
        onReset: () => {},
        title: 'Настройка разделов данных',
        description: 'Настройте порядок, видимость и расположение секций экрана «Данные».',
        blockDefs: DATA_BLOCK_DEFS,
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Настройка разделов данных');
    expect(html).toContain(i18n.t('data.blocks.operations.title'));
    expect(html).toContain(i18n.t('data.blocks.receipts.title'));
    expect(html).toContain(i18n.t('data.blocks.accounts.title'));
    expect(html).toContain(i18n.t('data.blocks.planned.title'));
    expect(html).toContain(i18n.t('data.blocks.recurring.title'));
    expect(html).toContain(i18n.t('data.blocks.rates.title'));
    expect(html).toContain(i18n.t('data.blocks.forecast.title'));
    expect(html).toContain(i18n.t('data.blocks.rules.title').replace(/&/g, '&amp;'));
    expect(html).not.toContain('Журнал аудита');
    expect(html).toContain(i18n.t('dashboard.settings.hiddenBadge')); // rates is hidden in mockConfig
    expect(html).toContain(i18n.t('common.reset'));
    // Data blocks are all single-column ('full'), so column switchers must not be rendered
    expect(html).not.toContain('dashboard-settings-row__columns');
    expect(html).not.toContain('Авто');
  });

  it('correctly applies column changes via applyBlockColumnChange helper with multi-column defs', () => {
    const multiColDefs = {
      accounts: { title: 'Счета', allowedColumns: ['auto', 'left', 'right', 'full'], defaultColumn: 'auto' },
      forecast: { title: 'Прогноз', allowedColumns: ['auto', 'left', 'right', 'full'], defaultColumn: 'auto' },
    };
    const updated = applyBlockColumnChange(mockConfig, 'accounts', 'right', multiColDefs);
    const accountsBlock = updated.find((b) => b.id === 'accounts');
    expect(accountsBlock?.column).toBe('right');

    // Passing an invalid column name should leave column unchanged
    const unchanged = applyBlockColumnChange(mockConfig, 'forecast', 'invalid_column', multiColDefs);
    expect(unchanged.find((b) => b.id === 'forecast')?.column).toBe('full');
  });

  it('renders DataDashboard with visible blocks and omits hidden blocks', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(DataDashboard as any, {
          config: mockConfig,
          filters: DEFAULT_DATA_FILTERS,
          accounts: mockAccounts,
          rates: [{ code: 'EUR', rate: '0.92', updated_at: '2026-09-01T00:00:00Z' }],
          visibleRates: [],
          missingRates: [],
          baseCurrency: 'USD',
          thresholdMinor: 50000,
        }),
      ),
    );

    expect(html).toContain('data-dashboard');
    expect(html).toContain('data-block--operations');
    expect(html).toContain('data-block--receipts');
    expect(html).toContain('data-block--accounts');
    expect(html).toContain('data-block--planned');
    expect(html).toContain('data-block--recurring');
    expect(html).toContain('data-block--forecast');
    expect(html).toContain('data-block--rules');
    expect(html).toContain('id="data-section-rules" class="data-section-body" hidden=""');
    // Rates is hidden in mockConfig, so it should not be rendered
    expect(html).not.toContain('data-block--rates');
    // Audit is completely removed from Data
    expect(html).not.toContain('data-block--audit');
  });

  it('renders sections in exact customized vertical order', () => {
    // Custom reorder: recurring placed before planned and accounts
    const reorderedConfig = [
      { id: 'recurring', visible: true, column: 'full' },
      { id: 'planned', visible: true, column: 'full' },
      { id: 'accounts', visible: true, column: 'full' },
    ];
    const html = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(DataDashboard as any, {
          config: reorderedConfig,
          filters: DEFAULT_DATA_FILTERS,
          accounts: mockAccounts,
        }),
      ),
    );

    const recurringIdx = html.indexOf('data-block--recurring');
    const plannedIdx = html.indexOf('data-block--planned');
    const accountsIdx = html.indexOf('data-block--accounts');

    expect(recurringIdx).toBeGreaterThan(-1);
    expect(plannedIdx).toBeGreaterThan(-1);
    expect(accountsIdx).toBeGreaterThan(-1);

    expect(recurringIdx).toBeLessThan(plannedIdx);
    expect(plannedIdx).toBeLessThan(accountsIdx);
  });

  it('renders empty dashboard state when all sections are hidden', () => {
    const allHiddenConfig = mockConfig.map((b) => ({ ...b, visible: false }));
    const html = renderToStaticMarkup(
      React.createElement(DataDashboard as any, {
        config: allHiddenConfig,
        filters: DEFAULT_DATA_FILTERS,
        onResetConfig: () => {},
        onOpenSettings: () => {},
      }),
    );

    expect(html).toContain('data-empty-dashboard');
    expect(html).toContain(i18n.t('data.allSectionsHidden'));
    expect(html).toContain(i18n.t('common.reset'));
    expect(html).toContain(i18n.t('data.configureSections'));
  });

  it('hides home/Pulse warning banner when currency_standards is configured even if optional domains are empty', () => {
    const optionalMissingPayload = {
      rules_epoch: 1,
      base_currency: 'USD',
      fx_anchor_currency: 'USD',
      currencies: [{ code: 'USD', decimals: 2, is_fx_anchor: true }],
      fiscal_formats: [],
      statement_templates: [],
      pdf_layouts: [],
      readiness: [
        { domain: 'currency_standards', configured: true },
        { domain: 'fiscal_formats', configured: false },
        { domain: 'merchant_aliases', configured: false },
        { domain: 'delivery_services', configured: false },
        { domain: 'venue_suffixes', configured: false },
        { domain: 'order_hints', configured: false },
        { domain: 'category_rules', configured: false },
        { domain: 'statement_templates', configured: false },
        { domain: 'pdf_layouts', configured: false },
        { domain: 'recurring_policies', configured: false },
      ],
      configured: false,
    };
    const state = applyRuntimeConfigPayload(optionalMissingPayload);
    expect(hasRequiredCurrencyConfig(state)).toBe(true);

    const html = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(Shell, { theme: 'light', setTheme: () => {} }),
      ),
    );

    expect(html).not.toContain('banner--warning');
    expect(html).not.toContain('fiscal_formats');
    expect(html).not.toContain('merchant_aliases');
    expect(html).not.toContain('pdf_layouts');
  });

  it('shows currency starter notice banner without raw domain ids when currency_standards is missing', () => {
    const missingCurrencyPayload = {
      rules_epoch: 0,
      base_currency: null,
      fx_anchor_currency: null,
      currencies: [],
      fiscal_formats: [],
      statement_templates: [],
      pdf_layouts: [],
      readiness: [
        { domain: 'currency_standards', configured: false },
        { domain: 'fiscal_formats', configured: false },
      ],
      configured: false,
    };
    const state = applyRuntimeConfigPayload(missingCurrencyPayload);
    expect(hasRequiredCurrencyConfig(state)).toBe(false);

    const html = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(Shell, { theme: 'light', setTheme: () => {} }),
      ),
    );

    expect(html).toContain('banner--warning');
    expect(html).toContain(i18n.t('onboarding.bannerTitle'));
    expect(html).not.toContain('currency_standards');
    expect(html).not.toContain('fiscal_formats');
  });

  it('renders RulesSettingsSection collapsed by default with neutral labels for optional domains', () => {
    applyRuntimeConfigPayload({
      rules_epoch: 2,
      base_currency: 'EUR',
      fx_anchor_currency: 'USD',
      currencies: [
        { code: 'USD', decimals: 2, is_fx_anchor: true },
        { code: 'EUR', decimals: 2, is_fx_anchor: false },
      ],
      readiness: [
        { domain: 'currency_standards', configured: true },
        { domain: 'fiscal_formats', configured: false },
        { domain: 'merchant_aliases', configured: false },
        { domain: 'pdf_layouts', configured: false },
      ],
    });

    const collapsedHtml = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(RulesSettingsSection),
      ),
    );
    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).toContain('id="data-section-rules" class="data-section-body" hidden=""');

    const expandedHtml = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(RulesSettingsSection, { expanded: true }),
      ),
    );
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain(`${i18n.t('rulesSettings.domains.currency_standards')}: ${i18n.t('rulesSettings.configured')}`);
    expect(expandedHtml).toContain(`${i18n.t('rulesSettings.domains.fiscal_formats')}: ${i18n.t('rulesSettings.notAddedYet')}`);
    expect(expandedHtml).toContain(`${i18n.t('rulesSettings.domains.pdf_layouts')}: ${i18n.t('rulesSettings.notAddedYet')}`);
    expect(expandedHtml).not.toContain('rules-chip--missing');
    expect(expandedHtml).not.toContain(`>${'fiscal_formats'}:`);
    expect(expandedHtml).not.toContain('replace_existing');
  });

  it('renders Exchange rates section with auto-update checkbox, Refresh now button, and ExchangeRate-API link', () => {
    const ratesConfig = [
      { id: 'rates', visible: true, column: 'full' },
    ];
    const rates = [{ code: 'EUR', rate: '0.92', updated_at: '2026-11-21T02:00:00Z' }];
    const html = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(DataDashboard as any, {
          config: ratesConfig,
          filters: { ...DEFAULT_DATA_FILTERS, ratesOpen: true },
          accounts: mockAccounts,
          rates,
          visibleRates: rates,
          missingRates: [],
          baseCurrency: 'USD',
          fxAnchorCode: 'USD',
          fxAutoUpdate: {
            enabled: false,
            provider: 'exchangerate-api',
            provider_name: 'ExchangeRate-API',
            provider_url: 'https://www.exchangerate-api.com',
            schedule_utc: '02:00',
            last_run_at: '2026-11-21T02:00:00Z',
            last_status: 'ok',
            last_error: null,
            last_trigger: 'cron',
          },
          fxRefreshNotice: 'Updated 1 exchange rate(s).',
        }),
      ),
    );

    expect(html).toContain('data-block--rates');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(i18n.t('data.rates.autoUpdateToggle', { time: '02:00', timezone: 'UTC' }));
    expect(html).toContain(i18n.t('data.rates.refreshNow'));
    expect(html).toContain('https://www.exchangerate-api.com');
    expect(html).toContain('ExchangeRate-API');
    expect(html).toContain('Updated 1 exchange rate(s).');
  });
});
