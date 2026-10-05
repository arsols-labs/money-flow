// Tests for adaptive navigation and layouts by window size class (Compact, Medium, Expanded) — Issue #479.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import i18n from '../src/ui/i18n.js';
import Shell, { ALL_TABS } from '../src/ui/Shell.jsx';
import Pulse, { PulseDashboard } from '../src/ui/Pulse.jsx';
import OperationsSection from '../src/ui/OperationsSection.jsx';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';

describe('Shell adaptive navigation', () => {
  it('contains 4 main sections in ALL_TABS', () => {
    const keys = ALL_TABS.map((t) => t.key);
    expect(keys).toEqual(['pulse', 'analytics', 'data', 'access']);
  });

  it('renders the navigation rail (.nav-rail) and the bottom bar (.bottom-nav) with accessibility', () => {
    const html = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Shell, { theme: 'dark', setTheme: () => {} })),
    );

    // Navigation rail (Medium & Expanded)
    expect(html).toContain('class="nav-rail"');
    expect(html).toContain(`aria-label="${i18n.t('shell.nav.main')}"`);
    expect(html).toContain('class="nav-rail-brand"');
    expect(html).toContain('class="nav-rail-logo-img"');
    expect(html).toContain('/icons/icon-dark-32.png');
    expect(html).not.toContain('nav-rail-logo-glyph');
    expect(html).toContain('class="nav-rail-item nav-rail-item--active"');

    // Bottom bar (Compact)
    expect(html).toContain('class="bottom-nav"');
    expect(html).toContain(`aria-label="${i18n.t('shell.nav.mobile')}"`);
    expect(html).toContain('class="bottom-nav-item bottom-nav-item--active"');

    // All 4 destinations present in both components
    for (const tab of ALL_TABS) {
      expect(html).toContain(i18n.t(tab.titleKey));
    }
  });

  it('puts the nav-rail brand icon for the resolved theme, not a currency glyph', () => {
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

describe('Pulse adaptive dashboard', () => {
  it('renders the pulse-dashboard container in the loading state', () => {
    const html = renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Pulse)),
    );

    expect(html).toContain('class="pulse-dashboard"');
    expect(html).toContain('class="pulse-main-col"');
  });

  it('renders the full modular pulse-dashboard structure with three columns', () => {
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

describe('Adaptive list-detail OperationsSection', () => {
  it('renders the adaptive operations layout container', () => {
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

describe('CSS foundations for breakpoints and container queries', () => {
  it('styles.css defines the canonical window size classes and container queries', () => {
    const css = env.PALETTE_CSS;

    // Compact breakpoint (< 600px)
    expect(css).toContain('@media (max-width: 599.98px)');

    // Expanded breakpoint (>= 840px)
    expect(css).toContain('@media (min-width: 840px)');

    // Container queries
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('@container (min-width: 800px)');

    // Navigation elements
    expect(css).toContain('.nav-rail');
    expect(css).toContain('.nav-rail-logo');
    expect(css).toContain('.nav-rail-logo-img');
    expect(css).not.toContain('.nav-rail-logo-glyph');
    expect(css).toContain('.bottom-nav');
    expect(css).toContain('.pulse-dashboard');
    expect(css).toContain('.ops-adaptive-layout');
  });
});
