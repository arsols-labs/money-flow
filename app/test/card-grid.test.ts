// Card layout and crash-free screen render — UI standard v2, 2026-08-21.
//
// CardGrid solves what pure CSS cannot: "a lonely card in
// the last row stretches to the full width". The rule `:last-child:
// nth-child(odd)` counts every child in a row and breaks on a wide card
// (`big`), which takes a whole row and shifts the parity. Since the layout
// is computed in JS, it has to be tested, or the next rearrangement of cards
// will silently put a hole back in the grid.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { CardGrid, MetricCard } from '../src/ui/components.jsx';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import Pulse, { PulseSegmentedControl } from '../src/ui/Pulse.jsx';
import Analytics from '../src/ui/Analytics.jsx';

/** Cell widths in order: `true` — the card takes the whole row on desktop. */
function cellWidths(children: React.ReactNode[]): boolean[] {
  const html = renderToStaticMarkup(
    React.createElement(CardGrid, null, ...children),
  );
  return [...html.matchAll(/class="([^"]*card-cell[^"]*)"/g)]
    .map((m) => m[1].split(' ').includes('card-cell--wide'));
}

/** Mobile width: `true` — the card has the class card-cell--mobile-wide. */
function cellMobileWidths(children: React.ReactNode[]): boolean[] {
  const html = renderToStaticMarkup(
    React.createElement(CardGrid, null, ...children),
  );
  return [...html.matchAll(/class="([^"]*card-cell[^"]*)"/g)]
    .map((m) => m[1].split(' ').includes('card-cell--mobile-wide'));
}

function card(label: string, big = false, mobileWide = false) {
  // MetricCard is written in JSX without types: tsc infers the props as required,
  // so the call goes through any — there is no need to type someone else's JS for a test.
  return React.createElement(MetricCard as never, {
    key: label, label, value: '0', big, mobileWide,
  } as never);
}

describe('CardGrid', () => {
  it('an even number of ordinary cards — all in two columns', () => {
    expect(cellWidths([card('a'), card('b')])).toEqual([false, false]);
    expect(cellWidths([card('a'), card('b'), card('c'), card('d')]))
      .toEqual([false, false, false, false]);
  });

  it('an odd number — the last one stretches instead of leaving a hole', () => {
    expect(cellWidths([card('a'), card('b'), card('c')]))
      .toEqual([false, false, true]);
  });

  it('a single card takes the full width', () => {
    expect(cellWidths([card('a')])).toEqual([true]);
  });

  // This is exactly the case CSS cannot handle: `big` is wide on its own,
  // and after it the column count starts over.
  it('a wide card does not throw off the column count of the others', () => {
    // big, a, b — big takes the row, a and b sit as a pair.
    expect(cellWidths([card('big', true), card('a'), card('b')]))
      .toEqual([true, false, false]);
    // big, a — one remains after the wide card: it stretches.
    expect(cellWidths([card('big', true), card('a')]))
      .toEqual([true, true]);
    // a, big, b — "a" would have been left alone in its row (big moves down), so
    // it stretches, and so does "b" at the end.
    expect(cellWidths([card('a'), card('big', true), card('b')]))
      .toEqual([true, true, true]);
    // a, b, big, c — the pair "a, b" is full, only "c" stretches.
    expect(cellWidths([card('a'), card('b'), card('big', true), card('c')]))
      .toEqual([false, false, true, true]);
    // Pulse layout on desktop: Capital and Flow in the first row,
    // Spent and Minimum ahead in the second row (all in 2 columns).
    expect(cellWidths([card('Капитал'), card('Поток'), card('Потрачено', false, true), card('Минимум', false, true)]))
      .toEqual([false, false, false, false]);
    // On mobile: Spent and Minimum get the class card-cell--mobile-wide.
    expect(cellMobileWidths([card('Капитал'), card('Поток'), card('Потрачено', false, true), card('Минимум', false, true)]))
      .toEqual([false, false, true, true]);
    // Without the minimum: Capital and Flow as a pair, Spent automatically takes the full desktop width.
    expect(cellWidths([card('Капитал'), card('Поток'), card('Потрачено', false, true)]))
      .toEqual([false, false, true]);
  });

  it('empty children do not create cells', () => {
    expect(cellWidths([card('a'), null as unknown as React.ReactElement, card('b')]))
      .toEqual([false, false]);
  });
});

describe('Pulse button choice', () => {
  it('shows every option, the active state, and the counters without a select', () => {
    const html = renderToStaticMarkup(
      React.createElement(PulseSegmentedControl as never, {
        options: [
          { key: 'all', label: 'Все', count: 7 },
          { key: 'country', label: 'Страны', count: 2 },
        ],
        value: 'country',
        onChange: () => {},
        ariaLabel: 'Категория предупреждений',
      } as never),
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Категория предупреждений"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('>Страны</span><span class="pulse-segmented-count">2</span>');
    expect(html).not.toContain('<select');
  });
});

// The same approach as in test/data-render.test.ts: a server render executes the body
// of the component before effects and throws on any typo in imports or JSX.
describe('screens render without exceptions', () => {
  it('"Pulse"', () => {
    expect(() => renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Pulse)),
    )).not.toThrow();
  });

  it('"Analytics"', () => {
    expect(() => renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Analytics)),
    )).not.toThrow();
  });
});
