import './use-ru-i18n';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { selectPayments, paymentDateLabel, paymentRefreshDue, paymentColors, paymentDateColor } from '../src/ui/payments';
import { UpcomingSection, UpcomingList } from '../src/ui/Pulse.jsx';

// Open the real accordion for server-rendered payment assertions.
vi.mock('../src/ui/components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/components')>();
  return { ...actual, CollapsibleSection: (props: React.ComponentProps<typeof actual.CollapsibleSection>) =>
    React.createElement(actual.CollapsibleSection, { ...props, defaultOpen: true }) };
});

const asOf = '2026-09-05';
const item = (date: string, amount_minor = -100, occurrence_count = 1) => ({
  date, amount_minor, occurrence_count, currency: 'USD', amount_base_minor: amount_minor,
  title: 'Test payment', account_name: 'Test account', kind: 'recurring', source_id: 1,
});

describe('Pulse payment dates and ranges', () => {
  it('keeps overdue and uses exactly seven/thirty calendar days', () => {
    const items = ['2026-09-01', '2026-09-05', '2026-09-11', '2026-09-12', '2026-10-04', '2026-10-05'].map(d => item(d));
    expect(selectPayments(items, asOf, 'week', 'all').map((x: { date: string }) => x.date)).toEqual(['2026-09-01', '2026-09-05', '2026-09-11']);
    expect(selectPayments(items, asOf, 'month', 'all')).toHaveLength(5);
    expect(selectPayments([...items, item(asOf, 200)], asOf, 'month', 'income')).toEqual([item(asOf, 200)]);
    expect(selectPayments([...items, item(asOf, 200)], asOf, 'month', 'expense')).toHaveLength(5);
  });

  it('labels by server as_of even when device date differs, including year rollover', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-06T01:30:00+02:00'));
      expect(paymentDateLabel(item(asOf), asOf)).toBe('сегодня');
      expect(paymentDateLabel(item('2026-09-06'), asOf)).toBe('завтра');
      expect(paymentDateLabel(item('2026-09-01', -200, 2), asOf)).toMatch(/^с 1/);
      expect(paymentDateLabel(item('2025-12-31'), asOf)).toContain('2025');
      expect(paymentDateLabel(item('2027-01-01'), '2026-12-31')).toBe('завтра');
    } finally { vi.useRealTimers(); }
  });

  it('catches late responses and retries clock skew or failure after a bounded cooldown', () => {
    const arrival = Date.parse('2026-09-06T00:00:00.100Z');
    expect(paymentRefreshDue('2026-09-05', null, arrival)).toBe(true);
    expect(paymentRefreshDue('2026-09-05', arrival, arrival + 30_000)).toBe(false);
    expect(paymentRefreshDue('2026-09-05', arrival, arrival + 60_000)).toBe(true);
    expect(paymentRefreshDue('2026-09-06', arrival, arrival + 60_000)).toBe(false);
    expect(paymentRefreshDue('2026-09-06', arrival, Date.parse('2026-09-07T00:00:00Z'))).toBe(true);
  });

  it('uses calendar boundaries across DST and month/year transitions', () => {
    expect(selectPayments([item('2026-03-31'), item('2026-04-01')], '2026-03-25', 'week', 'all')).toEqual([item('2026-03-31')]);
    expect(selectPayments([item('2027-01-28'), item('2027-01-29')], '2026-12-30', 'month', 'all')).toEqual([item('2027-01-28')]);
  });

  it('renders a past aggregate and today as separate rows with a filtered count', () => {
    const items = [item('2026-07-05', -200, 2), item(asOf), item('2026-10-05')];
    const heading = renderToStaticMarkup(React.createElement(UpcomingSection, {
      items, baseCurrency: 'USD', asOf,
    }));
    const html = renderToStaticMarkup(React.createElement(UpcomingList, {
      items: selectPayments(items, asOf, 'month', 'all'), baseCurrency: 'USD', asOf,
    }));
    expect(html).toContain('Просрочено');
    expect(html).toContain('2 платежа');
    expect(html).toContain('сегодня');
    expect(html.match(/class="upcoming-row[^"]*"/g)).toHaveLength(2);
    expect(heading).toContain('section-subtitle">2</');
  });
});

describe('Pulse payment palette', () => {
  it('uses converted amounts across currencies and isolates missing-FX currencies', () => {
    const usd = item(asOf, -100);
    const rsd = { ...item(asOf, -10_000), currency: 'RSD', amount_base_minor: -100 };
    const big = item(asOf, 200);
    const missing = { ...item(asOf, -1_000_000), currency: 'JPY', amount_base_minor: null };
    const missingSmall = { ...missing, amount_minor: -500_000 };
    const missingOther = { ...missing, currency: 'GBP', amount_minor: -1 };
    const colors = paymentColors([usd, rsd, big, missing, missingSmall, missingOther]);
    expect(colors.get(usd)).toBe(colors.get(rsd));
    expect(colors.get(usd)).toContain('var(--danger)');
    expect(colors.get(usd)).not.toBe('var(--warning)');
    expect(colors.get(big)).toBe('var(--safe)');
    expect(colors.get(missing)).toBe('var(--danger)');
    expect(colors.get(missingSmall)).toBe(colors.get(usd));
    expect(colors.get(missingOther)).toBe('var(--danger)');
  });

  it('keeps income green regardless of date and uses native direction if FX rounds to zero', () => {
    const overdueIncome = item('2026-09-04', 100);
    const dueIncome = item(asOf, 100);
    const zero = item('2026-09-04', 0);
    const colors = paymentColors([overdueIncome, dueIncome, zero]);
    expect(colors.get(overdueIncome)).toBe('var(--safe)');
    expect(colors.get(dueIncome)).toBe('var(--safe)');
    expect(colors.get(zero)).toBe('var(--warning)');
    expect(paymentColors([]).size).toBe(0);
    const html = renderToStaticMarkup(React.createElement(UpcomingList, {
      items: [overdueIncome, dueIncome, zero, { ...item(asOf), currency: 'JPY', amount_base_minor: null }], baseCurrency: 'USD', asOf,
    }));
    expect(html.match(/upcoming-row--overdue/g)).toHaveLength(2);
    expect(html).toContain('Доход');
    expect(html).toContain('Нулевая сумма');
    expect(html).toContain('Нет курса JPY/USD');
    expect(html).not.toContain('is-income');
    const rounded = { ...item(asOf, -1), currency: 'RSD', amount_base_minor: 0 };
    const roundedHtml = renderToStaticMarkup(React.createElement(UpcomingList, { items: [rounded], baseCurrency: 'USD', asOf }));
    expect(roundedHtml).toContain('Расход');
    expect(roundedHtml).not.toContain('Нулевая сумма');
    expect(paymentColors([rounded]).get(rounded)).toContain('var(--danger)');
    expect(paymentColors([rounded]).get(rounded)).not.toBe('var(--warning)');
  });

  it('keeps comparison over the full schedule when filtering or paginating', () => {
    const small = item(asOf, -100);
    const big = item('2026-09-25', 1000);
    const items = [small, ...Array.from({ length: 5 }, () => item(asOf, -10)), big];
    const colors = paymentColors(items);
    const style = `--payment-color:${colors.get(small)}`;
    const initial = renderToStaticMarkup(React.createElement(UpcomingSection, { items, baseCurrency: 'USD', asOf }));
    expect(initial).toContain(style);
    for (const range of ['week', 'month']) {
      const html = renderToStaticMarkup(React.createElement(UpcomingList, {
        items: selectPayments(items, asOf, range, 'expense').slice(0, 1), colors, baseCurrency: 'USD', asOf,
      }));
      expect(html).toContain(style);
    }
  });
});


describe('independent money and date signals', () => {
  it('uses continuous timeline scale for the stripe, including year and DST boundaries', () => {
    // Yesterday (-1 day): coral / orange-red
    const yesterday = paymentDateColor('2026-09-04', asOf);
    expect(yesterday).toContain('var(--danger)');
    expect(yesterday).toContain('var(--warning)');

    // 14+ days overdue: pure danger red
    expect(paymentDateColor('2026-08-20', asOf)).toBe('var(--danger)');
    expect(paymentDateColor('2026-12-31', '2027-01-15')).toBe('var(--danger)');

    // Today: warning orange
    expect(paymentDateColor(asOf, asOf)).toBe('var(--warning)');

    // Tomorrow (+1 day): warm lime / yellow-orange
    const tomorrow = paymentDateColor('2026-09-06', asOf);
    expect(tomorrow).toContain('var(--safe)');
    expect(tomorrow).toContain('var(--warning)');

    // 30+ days future: pure safe green
    expect(paymentDateColor('2026-10-05', asOf)).toBe('var(--safe)');
    expect(paymentDateColor('2026-03-29', '2026-02-20')).toBe('var(--safe)');
  });

  it('demonstrates smooth date stripe gradation for both overdue and future horizons', () => {
    const overdue14 = paymentDateColor('2026-08-22', asOf); // -14 days
    const overdue7 = paymentDateColor('2026-08-29', asOf); // -7 days
    const overdue1 = paymentDateColor('2026-09-04', asOf); // -1 day
    const today = paymentDateColor(asOf, asOf); // 0 days
    const future1 = paymentDateColor('2026-09-06', asOf); // +1 day
    const future7 = paymentDateColor('2026-09-12', asOf); // +7 days
    const future30 = paymentDateColor('2026-10-05', asOf); // +30 days

    expect(overdue14).toBe('var(--danger)');
    expect(today).toBe('var(--warning)');
    expect(future30).toBe('var(--safe)');

    // Every distinct day produces a distinct color token/mix
    const colors = new Set([overdue14, overdue7, overdue1, today, future1, future7, future30]);
    expect(colors.size).toBe(7);
  });

  it('preserves direction away from orange while providing wide continuous amount gradation', () => {
    const tinyPositive = { ...item(asOf, 1), amount_base_minor: 0 };
    const midPositive = { ...item(asOf, 250_000), amount_base_minor: 250_000 };
    const maxPositive = { ...item(asOf, 1_000_000), amount_base_minor: 1_000_000 };

    const tinyNegative = { ...item(asOf, -1), amount_base_minor: 0 };
    const midNegative = { ...item(asOf, -250_000), amount_base_minor: -250_000 };
    const maxNegative = { ...item(asOf, -1_000_000), amount_base_minor: -1_000_000 };

    const colors = paymentColors([
      tinyPositive, midPositive, maxPositive,
      tinyNegative, midNegative, maxNegative,
    ]);

    // Positive starts at 0.60 (safe 20%) and smoothly reaches 1.0 (pure safe)
    expect(colors.get(tinyPositive)).toBe('color-mix(in srgb, var(--safe) 20.0%, var(--warning))');
    expect(colors.get(maxPositive)).toBe('var(--safe)');
    expect(colors.get(midPositive)).not.toBe(colors.get(tinyPositive));
    expect(colors.get(midPositive)).not.toBe(colors.get(maxPositive));

    // Negative starts at 0.40 (danger 20%) and smoothly reaches 0.0 (pure danger)
    expect(colors.get(tinyNegative)).toBe('color-mix(in srgb, var(--warning) 80.0%, var(--danger))');
    expect(colors.get(maxNegative)).toBe('var(--danger)');
    expect(colors.get(midNegative)).not.toBe(colors.get(tinyNegative));
    expect(colors.get(midNegative)).not.toBe(colors.get(maxNegative));
  });

  it('renders green overdue income beside date stripe and red future expense beside date stripe', () => {
    const plus = item('2026-09-04', 100);
    const minus = item('2026-09-06', -100);
    const html = renderToStaticMarkup(React.createElement(UpcomingList, {
      items: [plus, minus], baseCurrency: 'USD', asOf,
    }));
    // Plus amount is safe (max in group); date is overdue (coral-red)
    expect(html).toContain('--payment-color:var(--safe)');
    expect(html).toContain('--payment-date-color:color-mix(in srgb, var(--warning) 73.3%, var(--danger))');
    // Minus amount is danger (max in group); date is tomorrow (yellow-orange)
    expect(html).toContain('--payment-color:var(--danger)');
    expect(html).toContain('--payment-date-color:color-mix(in srgb, var(--safe) 18.3%, var(--warning))');
    expect(html).toContain('+1,00');
    expect(html).toContain('-1,00');
    expect(html.match(/upcoming-row--overdue/g)).toHaveLength(1);
  });
});
