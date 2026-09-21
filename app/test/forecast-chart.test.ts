import { describe, expect, it } from 'vitest';
import {
  accountKey,
  accountsWithForecastSeries,
  chartData,
  countryKey,
  forecastHasMultiUserSeries,
  forecastSeriesItems,
  forecastYDomain,
  resolveForecastGroupMode,
  userKey,
} from '../src/ui/forecast.js';

const series = [
  {
    date: '2026-09-21',
    overall_minor: 100_00,
    by_country: { USA: 80_00, DE: 20_00 },
    by_account: { 1: 80_00, 2: -15_00 },
    by_owner: { Alex: 80_00, Sam: 20_00 },
  },
];

describe('forecast chart grouping (issue #594)', () => {
  it('chartData keeps country keys and adds account/user series', () => {
    const [point] = chartData(series, 'USD');
    expect(point.overall).toBe(100);
    expect(point[countryKey('USA')]).toBe(80);
    expect(point[countryKey('DE')]).toBe(20);
    expect(point[accountKey(1)]).toBe(80);
    expect(point[accountKey(2)]).toBe(-15);
    expect(point[userKey('Alex')]).toBe(80);
    expect(point[userKey('Sam')]).toBe(20);
  });

  it('chartData stays country-only when newer maps are missing', () => {
    const [point] = chartData([{ date: '2026-09-21', overall_minor: 50_00, by_country: { SRB: 50_00 } }], 'USD');
    expect(point[countryKey('SRB')]).toBe(50);
    expect(Object.keys(point).some((key) => key.startsWith('a:') || key.startsWith('u:'))).toBe(false);
  });

  it('hides user grouping until two household owners exist', () => {
    expect(forecastHasMultiUserSeries(['Alex'])).toBe(false);
    expect(forecastHasMultiUserSeries(['Alex', 'Sam'])).toBe(true);
    expect(resolveForecastGroupMode('user', { owners: ['Alex'] })).toBe('country');
    expect(resolveForecastGroupMode('user', { owners: ['Alex', 'Sam'] })).toBe('user');
    expect(resolveForecastGroupMode('account', { accounts: [{ id: 1 }] })).toBe('account');
    expect(resolveForecastGroupMode('account', { accounts: [] })).toBe('country');
  });

  it('filters accounts to those present on the forecast series', () => {
    const accounts = [
      { id: 1, name: 'Cash' },
      { id: 2, name: 'Card' },
      { id: 3, name: 'No FX' },
    ];
    expect(accountsWithForecastSeries(accounts, series).map((account) => account.id)).toEqual([1, 2]);
  });

  it('builds country series as the default (Total is drawn separately)', () => {
    const items = forecastSeriesItems('country', {
      countries: ['USA', 'DE'],
      accounts: [{ id: 1, name: 'Cash' }],
      owners: ['Alex', 'Sam'],
    });
    expect(items.map((item) => item.key)).toEqual([countryKey('USA'), countryKey('DE')]);
    expect(items.map((item) => item.label)).toEqual(['USA', 'DE']);
  });

  it('builds one series per account, including a negative card', () => {
    const items = forecastSeriesItems('account', {
      countries: ['USA'],
      accounts: [{ id: 2, name: 'Everyday Card' }, { id: 1, name: 'Cash' }],
      owners: ['Alex'],
    });
    expect(items.map((item) => item.key)).toEqual([accountKey(2), accountKey(1)]);
    expect(items[0].label).toBe('Everyday Card');
  });

  it('opens the Y-axis below zero when a series is negative', () => {
    const points = chartData(series, 'USD');
    const domain = forecastYDomain(points, [accountKey(1), accountKey(2)]);
    expect(Array.isArray(domain)).toBe(true);
    expect(domain[0]).toBeLessThan(-15);
    expect(domain[1]).toBeGreaterThanOrEqual(0);
  });

  it('keeps auto Y-scale when every plotted value is non-negative', () => {
    const points = chartData([{
      date: '2026-09-21',
      overall_minor: 100_00,
      by_country: { USA: 100_00 },
    }], 'USD');
    expect(forecastYDomain(points, [countryKey('USA')])).toEqual(['auto', 'auto']);
  });
});
