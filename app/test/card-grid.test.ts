// Раскладка карточек и рендер экранов без падений — UI-стандарт v2, 2026-08-21.
//
// CardGrid решает то, что чистым CSS не решается: «одинокая карточка в
// последней строке растягивается на всю ширину». Правило `:last-child:
// nth-child(odd)` считает всех детей подряд и ломается на широкой карточке
// (`big`), которая занимает строку целиком и сдвигает чётность. Раз раскладка
// считается в JS — её надо проверять, иначе следующая перестановка карточек
// молча вернёт дырку в сетке.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { CardGrid, MetricCard } from '../src/ui/components.jsx';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import Pulse, { PulseSegmentedControl } from '../src/ui/Pulse.jsx';
import Analytics from '../src/ui/Analytics.jsx';

/** Ширины ячеек по порядку: `true` — карточка занимает всю строку на десктопе. */
function cellWidths(children: React.ReactNode[]): boolean[] {
  const html = renderToStaticMarkup(
    React.createElement(CardGrid, null, ...children),
  );
  return [...html.matchAll(/class="([^"]*card-cell[^"]*)"/g)]
    .map((m) => m[1].split(' ').includes('card-cell--wide'));
}

/** Мобильная ширина: `true` — карточка имеет класс card-cell--mobile-wide. */
function cellMobileWidths(children: React.ReactNode[]): boolean[] {
  const html = renderToStaticMarkup(
    React.createElement(CardGrid, null, ...children),
  );
  return [...html.matchAll(/class="([^"]*card-cell[^"]*)"/g)]
    .map((m) => m[1].split(' ').includes('card-cell--mobile-wide'));
}

function card(label: string, big = false, mobileWide = false) {
  // MetricCard написан на JSX без типов: tsc выводит пропсы как обязательные,
  // поэтому вызов идёт через any — типизировать чужой JS ради теста не нужно.
  return React.createElement(MetricCard as never, {
    key: label, label, value: '0', big, mobileWide,
  } as never);
}

describe('CardGrid', () => {
  it('чётное число обычных карточек — все в две колонки', () => {
    expect(cellWidths([card('a'), card('b')])).toEqual([false, false]);
    expect(cellWidths([card('a'), card('b'), card('c'), card('d')]))
      .toEqual([false, false, false, false]);
  });

  it('нечётное число — последняя растягивается вместо дырки', () => {
    expect(cellWidths([card('a'), card('b'), card('c')]))
      .toEqual([false, false, true]);
  });

  it('одна карточка занимает всю ширину', () => {
    expect(cellWidths([card('a')])).toEqual([true]);
  });

  // Именно этот случай и не берётся на CSS: `big` сама по себе широкая,
  // после неё счёт колонок начинается заново.
  it('широкая карточка не сбивает счёт колонок у остальных', () => {
    // big, a, b — big занимает строку, a и b встают парой.
    expect(cellWidths([card('big', true), card('a'), card('b')]))
      .toEqual([true, false, false]);
    // big, a — после широкой остаётся одна: растягивается.
    expect(cellWidths([card('big', true), card('a')]))
      .toEqual([true, true]);
    // a, big, b — «a» осталась бы одна в строке (big уедет ниже), значит
    // растягивается и она, и «b» в конце.
    expect(cellWidths([card('a'), card('big', true), card('b')]))
      .toEqual([true, true, true]);
    // a, b, big, c — пара «a, b» полная, растягивается только «c».
    expect(cellWidths([card('a'), card('b'), card('big', true), card('c')]))
      .toEqual([false, false, true, true]);
    // Раскладка «Пульса» на десктопе: Капитал и Поток в первой строке,
    // Потрачено и Минимум впереди во второй строке (все по 2 колонки).
    expect(cellWidths([card('Капитал'), card('Поток'), card('Потрачено', false, true), card('Минимум', false, true)]))
      .toEqual([false, false, false, false]);
    // На мобильном: Потрачено и Минимум получают класс card-cell--mobile-wide.
    expect(cellMobileWidths([card('Капитал'), card('Поток'), card('Потрачено', false, true), card('Минимум', false, true)]))
      .toEqual([false, false, true, true]);
    // Без минимума: Капитал и Поток парой, Потрачено автоматически занимает всю ширину десктопа.
    expect(cellWidths([card('Капитал'), card('Поток'), card('Потрачено', false, true)]))
      .toEqual([false, false, true]);
  });

  it('пустые дети не создают ячеек', () => {
    expect(cellWidths([card('a'), null as unknown as React.ReactElement, card('b')]))
      .toEqual([false, false]);
  });
});

describe('кнопочный выбор Пульса', () => {
  it('показывает все варианты, активное состояние и счётчики без select', () => {
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

// Тот же приём, что в test/data-render.test.ts: серверный рендер исполняет тело
// компонента до эффектов и падает на любой опечатке в импортах или JSX.
describe('экраны рендерятся без исключений', () => {
  it('«Пульс»', () => {
    expect(() => renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Pulse)),
    )).not.toThrow();
  });

  it('«Аналитика»', () => {
    expect(() => renderToStaticMarkup(
      React.createElement(RefreshProvider, null, React.createElement(Analytics)),
    )).not.toThrow();
  });
});
