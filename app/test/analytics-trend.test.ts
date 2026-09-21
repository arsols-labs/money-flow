// Разделение расхода и возврата на графике динамики (issue #582).
import { describe, expect, it } from 'vitest';
import { splitTrendPoint, trendHasRefunds } from '../src/ui/analyticsTrend.js';

describe('splitTrendPoint', () => {
  it('uses explicit expense/refund minors and keeps net total', () => {
    const point = splitTrendPoint(
      { total_minor: 13100, expense_minor: 14000, refund_minor: 900 },
      2,
    );
    expect(point.expenseMajor).toBe(140);
    expect(point.refundMajor).toBe(9);
    expect(point.totalMajor).toBe(131);
  });

  it('does not treat a refund-only net as a negative expense bar', () => {
    const point = splitTrendPoint(
      { total_minor: -4000, expense_minor: 0, refund_minor: 4000 },
      2,
    );
    expect(point.expenseMajor).toBe(0);
    expect(point.refundMajor).toBe(40);
    expect(point.totalMajor).toBe(-40);
  });

  it('falls back to signed net when the split is absent', () => {
    expect(splitTrendPoint({ total_minor: 2500 }, 2)).toMatchObject({
      expenseMajor: 25,
      refundMajor: 0,
    });
    expect(splitTrendPoint({ total_minor: -2500 }, 2)).toMatchObject({
      expenseMajor: 0,
      refundMajor: 25,
    });
  });
});

describe('trendHasRefunds', () => {
  it('is true only when a refund bar would actually render', () => {
    expect(trendHasRefunds([
      { refundMajor: 0, expenseMajor: 10 },
      { refundMajor: 4, expenseMajor: 0 },
    ])).toBe(true);
    expect(trendHasRefunds([{ refundMajor: 0, expenseMajor: 12 }])).toBe(false);
  });
});
