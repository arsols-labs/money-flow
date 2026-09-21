// Тесты адаптивной навигации и раскладок по классам размеров окна (Compact, Medium, Expanded) — Issue #479.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import i18n from '../src/ui/i18n.js';
import Shell, { ALL_TABS } from '../src/ui/Shell.jsx';
import Pulse, { PulseDashboard } from '../src/ui/Pulse.jsx';
import OperationsSection from '../src/ui/OperationsSection.jsx';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';

describe('Адаптивная навигация Shell', () => {
  it('содержит 4 основных раздела в ALL_TABS', () => {
    const keys = ALL_TABS.map((t) => t.key);
    expect(keys).toEqual(['pulse', 'analytics', 'data', 'access']);
  });

  it('рендерит навигационную рельсу (.nav-rail) и нижнюю панель (.bottom-nav) с доступностью', () => {
    const html = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Shell, { theme: 'dark', setTheme: () => {} })),
    );

    // Навигационная рельса (Medium & Expanded)
    expect(html).toContain('class="nav-rail"');
    expect(html).toContain(`aria-label="${i18n.t('shell.nav.main')}"`);
    expect(html).toContain('class="nav-rail-brand"');
    expect(html).toContain('class="nav-rail-logo-img"');
    expect(html).toContain('/icons/icon-dark-32.png');
    expect(html).not.toContain('nav-rail-logo-glyph');
    expect(html).toContain('class="nav-rail-item nav-rail-item--active"');

    // Нижняя панель (Compact)
    expect(html).toContain('class="bottom-nav"');
    expect(html).toContain(`aria-label="${i18n.t('shell.nav.mobile')}"`);
    expect(html).toContain('class="bottom-nav-item bottom-nav-item--active"');

    // Наличие всех 4 направлений в обоих компонентах
    for (const tab of ALL_TABS) {
      expect(html).toContain(i18n.t(tab.titleKey));
    }
  });

  it('подставляет бренд-иконку nav-rail по разрешённой теме, не глиф валюты', () => {
    const light = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(Shell, { theme: 'light', resolvedTheme: 'light', setTheme: () => {} }),
      ),
    );
    expect(light).toContain('/icons/icon-light-32.png');
    expect(light).not.toContain('/icons/icon-dark-32.png');
    expect(light).not.toContain('nav-rail-logo-glyph');

    const dark = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(Shell, { theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
      ),
    );
    expect(dark).toContain('/icons/icon-dark-32.png');
    expect(dark).not.toContain('/icons/icon-light-32.png');
  });
});

describe('Адаптивный дашборд Pulse', () => {
  it('рендерит контейнер pulse-dashboard в состоянии загрузки', () => {
    const html = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Pulse)),
    );

    expect(html).toContain('class="pulse-dashboard"');
    expect(html).toContain('class="pulse-main-col"');
  });

  it('рендерит полную модульную структуру pulse-dashboard с тремя колонками', () => {
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

    const html = renderToStaticMarkup(
      React.createElement(PulseDashboard, {
        forecast: mockForecast,
        fxRates: [],
        points: [],
        groupMode: 'type',
        setGroupMode: () => {},
      }),
    );

    expect(html).toContain('class="pulse-dashboard"');
    expect(html).toContain('class="pulse-main-col"');
    expect(html).toContain('class="pulse-side-col"');
    expect(html).toContain('class="pulse-footer-col"');
  });
});

describe('Адаптивный List-Detail OperationsSection', () => {
  it('рендерит контейнер адаптивной раскладки операций', () => {
    const html = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(OperationsSection as never, {
        accounts: [{ id: 1, name: 'Main', currency: 'EUR' }],
        refreshAccounts: () => {},
        expanded: true,
        onToggle: () => {},
        filter: { operations: true },
      } as never)),
    );

    expect(html).toContain('class="ops-adaptive-container"');
  });
});

describe('CSS-основы брейкпоинтов и контейнерных запросов', () => {
  it('styles.css определяет канонические классы размеров окна и Container Queries', () => {
    const css = env.PALETTE_CSS;

    // Compact брейкпоинт (< 600px)
    expect(css).toContain('@media (max-width: 599.98px)');

    // Expanded брейкпоинт (>= 840px)
    expect(css).toContain('@media (min-width: 840px)');

    // Container queries
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('@container (min-width: 800px)');

    // Навигационные элементы
    expect(css).toContain('.nav-rail');
    expect(css).toContain('.nav-rail-logo');
    expect(css).toContain('.nav-rail-logo-img');
    expect(css).not.toContain('.nav-rail-logo-glyph');
    expect(css).toContain('.bottom-nav');
    expect(css).toContain('.pulse-dashboard');
    expect(css).toContain('.ops-adaptive-layout');
  });
});
