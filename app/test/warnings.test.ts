import './use-ru-i18n';
import { describe, expect, it } from 'vitest';
import {
  compareWarnings, WARNING_LIMIT, warningFilters, warningRatio, warningSelection, warningSeverity,
} from '../src/ui/warnings.js';

function warning(overrides: Record<string, unknown> = {}) {
  return {
    dimension: 'country',
    dimension_key: 'SRB',
    currency_code: 'USD',
    threshold_minor: 100_000,
    start_minor: 150_000,
    minimum_projected_minor: 90_000,
    minimum_projected_date: '2026-09-30',
    earliest_below_threshold_date: '2026-09-20',
    earliest_non_positive_date: null,
    ...overrides,
  };
}

describe('очередь предупреждений Пульса', () => {
  it('ставит наступившие критические состояния выше будущих и ограничивает список тремя', () => {
    const warnings = [
      warning({ dimension_key: 'below-later' }),
      warning({ dimension: 'account', dimension_key: '17', threshold_minor: 0, start_minor: -1, minimum_projected_minor: -500 }),
      warning({ dimension: 'currency', dimension_key: 'RSD', start_minor: 0, minimum_projected_minor: 0 }),
      warning({ dimension: 'overall', dimension_key: 'overall', earliest_non_positive_date: '2026-09-02', minimum_projected_minor: -5_000 }),
      warning({ dimension_key: 'below-sooner', earliest_below_threshold_date: '2026-09-10' }),
      warning({ dimension: 'country', dimension_key: 'USA', earliest_non_positive_date: '2026-09-01', minimum_projected_minor: -1 }),
      warning({ dimension: 'currency', dimension_key: 'USD', earliest_below_threshold_date: '2026-09-05' }),
    ];

    const result = warningSelection(warnings, 'all');

    expect(WARNING_LIMIT).toBe(3);
    expect(result.visible).toHaveLength(3);
    expect(result.hidden).toBe(4);
    expect(result.visible.map((item: any) => item.dimension_key)).toEqual([
      '17', 'RSD', 'USA',
    ]);
    expect(warningSeverity(result.visible[0]!).label).toBe('Критично');
    expect(warningSeverity(result.visible[2]!).label).toBe('Важно');
  });

  it('фильтрует по стране, счёту и валюте, сохраняя единый порядок', () => {
    const warnings = [
      warning({ dimension: 'country', dimension_key: 'USA', start_minor: -10 }),
      warning({ dimension: 'country', dimension_key: 'SRB' }),
      warning({ dimension: 'account', dimension_key: '3', threshold_minor: 0, start_minor: -1 }),
      warning({ dimension: 'currency', dimension_key: 'RSD', earliest_non_positive_date: '2026-09-25' }),
    ];

    expect(warningFilters(warnings)).toEqual([
      { key: 'critical', label: 'Критично', count: 2 },
      { key: 'important', label: 'Важно', count: 1 },
      { key: 'all', label: 'Все', count: 4 },
      { key: 'country', label: 'Страны', count: 2 },
      { key: 'account', label: 'Счета', count: 1 },
      { key: 'currency', label: 'Валюты', count: 1 },
    ]);
    expect(warningSelection(warnings, 'country').visible.map((item: any) => item.dimension_key)).toEqual(['USA', 'SRB']);
    expect(warningSelection(warnings, 'account').total).toBe(1);
    expect(warningSelection(warnings, 'currency').total).toBe(1);
  });

  it('сбрасывает исчезнувшую категорию на Все и держит tie-breaker детерминированным', () => {
    const warnings = [warning({ dimension_key: '2' }), warning({ dimension_key: '10' })];

    expect(warningSelection(warnings, 'account').activeFilter).toBe('all');
    expect([...warnings].sort(compareWarnings).map((item) => item.dimension_key)).toEqual(['2', '10']);
  });

  it('возвращает устойчивое пустое состояние с нулевым общим фильтром', () => {
    expect(warningSelection([], 'currency')).toEqual({
      activeFilter: 'all',
      availableFilters: [{ key: 'all', label: 'Все', count: 0 }],
      total: 0,
      visible: [],
      hidden: 0,
    });
  });

  it('не схлопывает глубокий минус цветовым clamp и поднимает его в очереди', () => {
    const warnings = [
      warning({ dimension_key: 'shallow', start_minor: -1, minimum_projected_minor: -1 }),
      warning({ dimension_key: 'deep', start_minor: -1, minimum_projected_minor: -300_000 }),
    ];

    expect([...warnings].sort(compareWarnings).map((item) => item.dimension_key)).toEqual(['deep', 'shallow']);
    expect(warningRatio(warnings[1]!)).toBeLessThan(warningRatio(warnings[0]!));
    expect(warningRatio(warning({ start_minor: 0, minimum_projected_minor: 0 }))).toBeCloseTo(0.35);
    expect(warningRatio(warnings[0]!)).toBeLessThan(0.5);
  });

  it('фильтрует срочность раньше прежних категорий и раскрывает заданный лимит', () => {
    const warnings = [
      warning({ dimension_key: 'critical', start_minor: -1 }),
      warning({ dimension_key: 'important', earliest_non_positive_date: '2026-09-01' }),
      warning({ dimension_key: 'attention' }),
      warning({ dimension: 'account', dimension_key: 'account', threshold_minor: 0, start_minor: -1 }),
    ];

    expect(warningFilters(warnings).map((item) => item.key)).toEqual([
      'critical', 'important', 'all', 'country', 'account',
    ]);
    expect(warningSelection(warnings, 'critical', 6).total).toBe(2);
    expect(warningSelection(warnings, 'important', 6).total).toBe(1);
    expect(warningSelection(warnings, 'all', 6).visible).toHaveLength(4);
  });

  it('не смешивает относительный порог группы с нативной суммой счёта', () => {
    const warnings = [
      warning({ dimension: 'account', dimension_key: 'account', threshold_minor: 0, start_minor: -1, minimum_projected_minor: -100 }),
      warning({ dimension: 'overall', dimension_key: 'overall', start_minor: -1_000, minimum_projected_minor: -1_000 }),
    ];

    expect([...warnings].sort(compareWarnings).map((item) => item.dimension_key)).toEqual(['overall', 'account']);
  });

  it('задаёт транзитивный порядок для смешанных денежных шкал', () => {
    const a = warning({ dimension: 'account', dimension_key: 'A', threshold_minor: 0, start_minor: 100, minimum_projected_minor: -1_000, earliest_non_positive_date: '2026-09-03' });
    const b = warning({ dimension: 'account', dimension_key: 'B', threshold_minor: 0, start_minor: 100, minimum_projected_minor: -10, earliest_non_positive_date: '2026-09-01' });
    const c = warning({ dimension: 'country', dimension_key: 'C', minimum_projected_minor: -50_000, earliest_non_positive_date: '2026-09-02' });
    const expected = ['B', 'C', 'A'];

    expect([a, b, c].sort(compareWarnings).map((item) => item.dimension_key)).toEqual(expected);
    expect([c, a, b].sort(compareWarnings).map((item) => item.dimension_key)).toEqual(expected);
    expect([b, c, a].sort(compareWarnings).map((item) => item.dimension_key)).toEqual(expected);
  });
});
