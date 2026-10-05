// Golden tests of the pure forecast core (issue #198, S1-4) — buildForecast
// does not touch D1 at all (see the docblock in src/worker/forecast/build.ts), so the
// whole file runs on hand-built ForecastAccount/ForecastFlow values, without a
// D1 test bench. In spirit this is a port of `forecast golden` from archive/v2-codex
// (app/test/readmodel.test.ts), adapted to our schema: signed amounts, its own
// currency on the flow, a configurable base currency, and a `currency` dimension
// alongside `country`/`overall` (ROADMAP, "Phase 3 — Forecast and dashboard").
import { describe, expect, it } from 'vitest';
import { addDays } from '../src/worker/forecast/dates';
import { buildForecast, type BuildForecastInput } from '../src/worker/forecast/build';
import { expandRecurring } from '../src/worker/forecast/recurrence';
import type { ForecastAccount, ForecastFlow } from '../src/worker/forecast/load';

function account(overrides: Partial<ForecastAccount> & Pick<ForecastAccount, 'id' | 'currency' | 'balance_minor'>): ForecastAccount {
  return {
    name: `Счёт ${overrides.id}`,
    owner: 'Алекс',
    country: 'USA',
    balance_updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function flow(overrides: Partial<ForecastFlow> & Pick<ForecastFlow, 'account_id' | 'date' | 'amount_minor' | 'currency'>): ForecastFlow {
  return {
    title: 'Операция',
    kind: 'planned',
    source_id: 1,
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildForecastInput> = {}): BuildForecastInput {
  return {
    accounts: [],
    flows: [],
    ratesE9: new Map(),
    baseCurrency: 'USD',
    asOfDate: '2026-01-01',
    horizonDays: 7,
    lowBalanceThresholdMinor: 0n,
    cashFlowDays: 30,
    ...overrides,
  };
}

describe('buildForecast — no flows, one currency equal to the base', () => {
  it('the series is flat, lowest is on the first day, and no conversion is needed at all', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 100000 });
    const result = buildForecast(
      baseInput({ accounts: [acc], asOfDate: '2026-07-23', horizonDays: 5, cashFlowDays: 3 }),
    );

    expect(result.series).toHaveLength(5);
    for (const day of result.series) {
      expect(day.overallMinor).toBe(100000n);
      expect(day.byCountry.get('USA')).toBe(100000n);
    }
    expect(result.netWorthMinor).toBe(100000n);
    expect(result.cashFlowMinor).toBe(0n); // day 3 is the same as the start
    expect(result.lowest).toEqual({ date: '2026-07-24', amountMinor: 100000n });
    expect(result.warnings).toEqual([]);
    expect(result.missingRates).toEqual([]); // the USD→USD rate was never requested
    expect(result.accounts).toEqual([{ account: acc, balanceBaseMinor: 100000n }]);
    expect(result.countries).toEqual(['USA']);
    expect(result.owners).toEqual(['Алекс']);
    expect(result.series[0]!.byAccount.get(1)).toBe(100000n);
    expect(result.series[0]!.byOwner.get('Алекс')).toBe(100000n);
  });

  it('splits account and owner series so a negative card can sit below zero', () => {
    const cash = account({ id: 1, name: 'Cash', owner: 'Alex', country: 'USA', currency: 'USD', balance_minor: 20000 });
    const card = account({ id: 2, name: 'Everyday Card', owner: 'Sam', country: 'USA', currency: 'USD', balance_minor: -4000 });
    const result = buildForecast(baseInput({ accounts: [cash, card], horizonDays: 2 }));

    expect(result.owners).toEqual(['Alex', 'Sam']);
    expect(result.series[0]!.byAccount.get(1)).toBe(20000n);
    expect(result.series[0]!.byAccount.get(2)).toBe(-4000n);
    expect(result.series[0]!.byOwner.get('Alex')).toBe(20000n);
    expect(result.series[0]!.byOwner.get('Sam')).toBe(-4000n);
    expect(result.series[0]!.overallMinor).toBe(16000n);
    expect(result.warnings.map((w) => String(w.dimension))).not.toContain('owner');
  });
});

describe('buildForecast — monthly clamp 31→30→31 over a 100-day horizon', () => {
  it('day_of_month=31 clamps in short months and comes back in long ones', () => {
    const acc = account({ id: 1, currency: 'RUB', country: 'RUS', balance_minor: 470000 });
    const asOfDate = '2026-07-23';
    const horizonDays = 100; // covers through 2026-10-31 inclusive
    const limitDate = addDays(asOfDate, horizonDays);

    // Dates come from expandRecurring, which is already tested on its own — here
    // we check the aggregation in build.ts, not the rule expansion itself.
    const dates = expandRecurring(
      { id: 2, frequency: 'monthly', interval_count: 1, day_of_month: 31, month_of_year: null, next_due_date: '2026-07-31', end_date: null },
      asOfDate,
      limitDate,
    );
    const flows: ForecastFlow[] = dates.map((date, i) => flow({
      account_id: 1, date, amount_minor: -12000, currency: 'RUB', title: 'Groceries', kind: 'recurring', source_id: 2 + i,
    }));

    const result = buildForecast(baseInput({ accounts: [acc], flows, baseCurrency: 'RUB', asOfDate, horizonDays }));

    const on = (date: string) => result.series.find((s) => s.date === date)?.overallMinor;
    expect(on('2026-07-31')).toBe(458000n); // 470000 - 12000
    expect(on('2026-08-31')).toBe(446000n);
    expect(on('2026-09-30')).toBe(434000n); // clamp 31→30 in September — the third debit
    expect(on('2026-10-31')).toBe(422000n); // returned to the 31st — the fourth debit
    expect(result.warnings).toEqual([]); // the balance stays positive for the whole horizon
  });
});

describe('buildForecast — multi-currency: a flow in a currency other than the account currency', () => {
  it('an EUR flow is converted into RSD (the account currency), then the group into base USD', () => {
    const acc = account({ id: 1, currency: 'RSD', country: 'SRB', balance_minor: 200000 }); // 2000.00 RSD
    const ratesE9 = new Map([
      ['RSD', 9_700_000], // 0.0097 USD/RSD
      ['EUR', 1_140_000_000], // 1.14 USD/EUR
    ]);
    const f = flow({ account_id: 1, date: '2026-01-06', amount_minor: -1000, currency: 'EUR', title: 'Страховка' }); // -10.00 EUR, a foreign currency

    const result = buildForecast(
      baseInput({ accounts: [acc], flows: [f], ratesE9, asOfDate: '2026-01-01', horizonDays: 10 }),
    );

    // -10.00 EUR at rates 1.14/0.0097 yields -1175.26 RSD (ROUND_HALF_EVEN) —
    // computed independently when the test was written; see the implementer report.
    // 2000.00 - 1175.26 = 824.74 RSD → into USD at 0.0097: 19.40 before the flow,
    // 8.00 after (824.74 * 0.0097 = 7.99998 → round half to even, 8.00).
    const day = (date: string) => result.series.find((s) => s.date === date)!;
    expect(day('2026-01-05').overallMinor).toBe(1940n); // still before the flow (it is dated 01-06)
    expect(day('2026-01-06').overallMinor).toBe(800n); // the flow has been applied
    expect(result.series.at(-1)!.overallMinor).toBe(800n); // and it stays through the end of the horizon

    // accounts[].balanceBaseMinor is TODAY's balance; flows do not affect it.
    expect(result.accounts).toEqual([{ account: acc, balanceBaseMinor: 1940n }]);
    expect(result.missingRates).toEqual([]); // both RSD and EUR have a rate
  });
});

describe('buildForecast — missing rate', () => {
  it('the account and its currency drop out of the group dimensions, and the currency lands in missing_rates', () => {
    const unconvertible = account({ id: 1, currency: 'XYZ', country: 'ZZZ', balance_minor: 500 });
    const result = buildForecast(baseInput({ accounts: [unconvertible], horizonDays: 3 }));

    expect(result.accounts).toEqual([{ account: unconvertible, balanceBaseMinor: null }]);
    expect(result.missingRates).toEqual(['XYZ']);
    // Group series exclude the account entirely — the currency/country/overall sum
    // stays 0, rather than a distorted number pretending to be real.
    expect(result.netWorthMinor).toBe(0n);
    // Country ZZZ is absent from the chart entirely: every one of its accounts is in a
    // currency with no rate, and its total is unknown, not zero. A line at zero would say
    // "there is no money in this country", even though the account holds 500 XYZ.
    expect(result.countries).toEqual([]);
    for (const day of result.series) {
      expect(day.overallMinor).toBe(0n);
      expect(day.byCountry.size).toBe(0);
    }
    // dimension=account is computed in the NATIVE currency and does not depend on the rate:
    // 500 XYZ is positive, so there is no warning on this dimension.
    expect(result.warnings.find((w) => w.dimension === 'account')).toBeUndefined();
    // There are no group warnings either, and that is the point of this case. The series
    // of an incomplete group is the sum of a subset of accounts; here the subset is empty,
    // so 0 means "unknown", not "there is no money". Claiming from such a
    // series that it is "already below the threshold" is a direct false alarm, so incomplete
    // groups are excluded from warnings entirely.
    expect(result.warnings.filter((w) => w.dimension !== 'account')).toHaveLength(0);
    // For the same reason, "lowest balance ahead" is not shown either.
    expect(result.lowest).toBeNull();
  });

  it('an incomplete group does not warn even when its truncated series falls below the threshold', () => {
    // The threshold is 100,000. The account with a rate contributes 500 base minor units —
    // too little, and on a complete series the warning would be honest. But both accounts
    // sit in ONE country, and the second currency cannot be converted: the country total
    // is understated by an unknown amount, and the real money may still be above
    // the threshold. So we stay silent for country=USA and for overall.
    const withRate = account({ id: 1, currency: 'USD', country: 'USA', balance_minor: 500 });
    const noRate = account({ id: 2, currency: 'XYZ', country: 'USA', balance_minor: 900_000 });
    const result = buildForecast(
      baseInput({ accounts: [withRate, noRate], horizonDays: 3, lowBalanceThresholdMinor: 100_000n }),
    );

    expect(result.missingRates).toEqual(['XYZ']);
    expect(result.netWorthMinor).toBe(500n); // the truncated total is visible
    expect(result.warnings.find((w) => w.dimension === 'country')).toBeUndefined();
    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeUndefined();
    expect(result.lowest).toBeNull();
    // Completeness is a property of the GROUP, not of the base: measure currency=USD consists
    // only of USD, so it is complete and it warns.
    expect(result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'USD')).toBeDefined();
    // And currency=XYZ is empty after the drop — we stay silent about it too.
    expect(result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'XYZ')).toBeUndefined();
  });

  it('a group that is fully covered by rates warns as usual, even when a currency without a rate is nearby', () => {
    // Control case for the previous two: the currency=USD dimension is complete
    // (it contains only USD), so a warning is emitted for it, even though the
    // base also has a currency without a rate. Completeness is computed per group, not per base.
    const poor = account({ id: 1, currency: 'USD', country: 'USA', balance_minor: 500 });
    const noRate = account({ id: 2, currency: 'XYZ', country: 'SRB', balance_minor: 900_000 });
    const result = buildForecast(
      baseInput({ accounts: [poor, noRate], horizonDays: 3, lowBalanceThresholdMinor: 100_000n }),
    );

    const usd = result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.startMinor).toBe('500'); // already below the 100,000 threshold on day 0
    // and overall is incomplete — we stay silent about it
    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeUndefined();
  });

  it('a second, convertible account in the same dimension is not affected by a neighbor without a rate', () => {
    const bad = account({ id: 1, currency: 'XYZ', country: 'SRB', balance_minor: 500 });
    const good = account({ id: 2, currency: 'USD', country: 'SRB', balance_minor: 100000 });
    const result = buildForecast(baseInput({ accounts: [bad, good], horizonDays: 2 }));

    expect(result.missingRates).toEqual(['XYZ']);
    // country='SRB' groups both accounts — but XYZ dropped out, so the sum equals
    // ONLY the convertible account, rather than being silently understated to a strange number.
    expect(result.series[0]!.byCountry.get('SRB')).toBe(100000n);
    expect(result.series[0]!.byAccount.has(1)).toBe(false);
    expect(result.series[0]!.byAccount.get(2)).toBe(100000n);
    expect(result.owners).toEqual(['Алекс']);
  });
});

describe('buildForecast — threshold: already below vs will cross later', () => {
  it('the balance is already below the threshold on day 0 — this shows up in startMinor', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 50000 }); // $500
    const result = buildForecast(
      baseInput({ accounts: [acc], lowBalanceThresholdMinor: 100000n, horizonDays: 3 }), // threshold $1000
    );
    const overall = result.warnings.find((w) => w.dimension === 'overall')!;
    // startMinor together with thresholdMinor is what yields the "already below the threshold" state:
    // 50,000 <= 100,000, yet still > 0 — so it is NOT "already negative". The
    // state label used to glue those two cases together, and the screen then talked about a
    // negative balance on an account that still had a positive balance.
    expect(overall.startMinor).toBe('50000');
    expect(overall.thresholdMinor).toBe('100000');
    expect(overall.earliestBelowThresholdDate).toBe('2026-01-02');
    expect(overall.earliestNonPositiveDate).toBeNull(); // 500 > 0, it does not reach zero
    // the account dimension does not see the threshold — only zero, and here the balance is positive.
    expect(result.warnings.find((w) => w.dimension === 'account')).toBeUndefined();
  });

  it('the threshold and zero are crossed on DIFFERENT days — both dates are in one warning', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 150000 }); // $1500, above the threshold
    const flows: ForecastFlow[] = [
      flow({ account_id: 1, date: '2026-01-06', amount_minor: -70000, currency: 'USD', source_id: 1 }), // → $800, below the threshold, still > 0
      flow({ account_id: 1, date: '2026-01-11', amount_minor: -100000, currency: 'USD', source_id: 2 }), // → -$200, into the negative
    ];
    const result = buildForecast(
      baseInput({ accounts: [acc], flows, lowBalanceThresholdMinor: 100000n, horizonDays: 15 }),
    );
    const overall = result.warnings.find((w) => w.dimension === 'overall')!;
    expect(overall.startMinor).toBe('150000'); // on day 0 the threshold is not yet breached
    expect(overall.earliestBelowThresholdDate).toBe('2026-01-06');
    expect(overall.earliestNonPositiveDate).toBe('2026-01-11');
    expect(overall.minimumProjectedMinor).toBe('-20000');
    expect(overall.minimumProjectedDate).toBe('2026-01-11');
  });
});

describe('buildForecast — an empty dimension stays silent (issue #256)', () => {
  it('an account with a zero balance and no operations produces no warnings at all', () => {
    // Found by the owner in production: an empty EUR account always warned, simply
    // because 0 is below the $1000 threshold. There is nothing to warn about — there is no money
    // and no movement.
    const empty = account({ id: 1, currency: 'USD', country: 'SRB', balance_minor: 0 });
    const result = buildForecast(
      baseInput({ accounts: [empty], horizonDays: 5, lowBalanceThresholdMinor: 100_000n }),
    );

    expect(result.warnings).toEqual([]);
    // The account has not disappeared: it is still in the list and in the series; there is just
    // nothing to say about it.
    expect(result.accounts).toHaveLength(1);
    expect(result.netWorthMinor).toBe(0n);
  });

  it('a zero balance, but an operation on the horizon — the warning comes back', () => {
    const acc = account({ id: 1, currency: 'USD', country: 'SRB', balance_minor: 0 });
    const flows = [flow({ account_id: 1, date: '2026-01-04', amount_minor: -5000, currency: 'USD' })];
    const result = buildForecast(
      baseInput({ accounts: [acc], flows, horizonDays: 5, lowBalanceThresholdMinor: 100_000n }),
    );

    // The series is no longer all zeros — the rule works as usual, both for the account and
    // for the groups.
    expect(result.warnings.find((w) => w.dimension === 'account')).toBeDefined();
    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeDefined();
  });

  it('a non-zero balance with a flat series does not stay silent — the threshold has nothing to do with it', () => {
    // Control for the first case: silence comes specifically from "zero AND no
    // movement", not from "the series is flat".
    const acc = account({ id: 1, currency: 'USD', country: 'SRB', balance_minor: 500 });
    const result = buildForecast(
      baseInput({ accounts: [acc], horizonDays: 5, lowBalanceThresholdMinor: 100_000n }),
    );

    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeDefined();
  });
});

describe('buildForecast — when the minima are equal, lowest takes the earliest date', () => {
  it('two equal minima on the horizon — the earliest one is chosen', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 1000 });
    const flows: ForecastFlow[] = [
      flow({ account_id: 1, date: '2026-01-02', amount_minor: -500, currency: 'USD', source_id: 1 }), // day 1: 500
      flow({ account_id: 1, date: '2026-01-03', amount_minor: 500, currency: 'USD', source_id: 2 }), // day 2: 1000
      flow({ account_id: 1, date: '2026-01-04', amount_minor: -500, currency: 'USD', source_id: 3 }), // day 3: 500 — the same minimum
    ];
    const result = buildForecast(baseInput({ accounts: [acc], flows, horizonDays: 3 }));

    expect(result.series.map((s) => s.overallMinor)).toEqual([500n, 1000n, 500n]);
    expect(result.lowest).toEqual({ date: '2026-01-02', amountMinor: 500n }); // not 2026-01-04
  });

  it('lowest is null only when there are no accounts at all', () => {
    const result = buildForecast(baseInput({ accounts: [], horizonDays: 3 }));
    expect(result.lowest).toBeNull();
    expect(result.series).toHaveLength(3);
    expect(result.series[0]!.overallMinor).toBe(0n);
    expect(result.warnings).toEqual([]);
    expect(result.countries).toEqual([]);
  });
});

describe('buildForecast — cash_flow when cashFlowDays > horizonDays', () => {
  it('the metric index is clamped to the last day of the horizon', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 100000 });
    const flows: ForecastFlow[] = [
      flow({ account_id: 1, date: '2026-01-05', amount_minor: -30000, currency: 'USD', source_id: 1 }),
    ];
    const result = buildForecast(baseInput({ accounts: [acc], flows, horizonDays: 5, cashFlowDays: 30 }));

    expect(result.cashFlowDays).toBe(30); // the field reflects the REQUESTED window, not the clamped one
    expect(result.series).toHaveLength(5);
    expect(result.series[4]!.overallMinor).toBe(70000n); // 100000 - 30000, the last day
    expect(result.cashFlowMinor).toBe(-30000n); // 70000 - 100000, not an out-of-bounds array access
  });

  it('a horizon outside 1..366, or cashFlowDays < 1, raises RangeError', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 0 });
    expect(() => buildForecast(baseInput({ accounts: [acc], horizonDays: 0 }))).toThrow(RangeError);
    expect(() => buildForecast(baseInput({ accounts: [acc], horizonDays: 367 }))).toThrow(RangeError);
    expect(() => buildForecast(baseInput({ accounts: [acc], cashFlowDays: 0 }))).toThrow(RangeError);
  });
});

// Contract clarification (ROADMAP "Phase 3 — Forecast and dashboard on our own data"):
// "for each account, country, AND CURRENCY — the first date of crossing zero and
// the minimum balance". The currency dimension is the same grouping as country and
// overall, but by the account currency code, not by country.
describe('buildForecast — the currency dimension', () => {
  it('two accounts in one currency: a warning on the SUM, not on each account separately', () => {
    const acc1 = account({ id: 1, currency: 'USD', country: 'USA', balance_minor: 70000 }); // $700
    const acc2 = account({ id: 2, currency: 'USD', country: 'CAN', balance_minor: 20000 }); // $200
    // The sum is $900 — below the $1000 threshold, even though neither account is at zero on its own.
    const result = buildForecast(
      baseInput({ accounts: [acc1, acc2], lowBalanceThresholdMinor: 100000n, horizonDays: 3 }),
    );

    const currencyWarnings = result.warnings.filter((w) => w.dimension === 'currency');
    expect(currencyWarnings).toHaveLength(1);
    expect(currencyWarnings[0]).toMatchObject({
      dimension: 'currency',
      dimensionKey: 'USD',
      currencyCode: 'USD',
      thresholdMinor: '100000',
      earliestBelowThresholdDate: '2026-01-02',
      earliestNonPositiveDate: null,
      minimumProjectedMinor: '90000',
      startMinor: '90000',
    });

    // dimension=account does not breach the threshold for either account on its own —
    // neither of them goes to zero.
    expect(result.warnings.filter((w) => w.dimension === 'account')).toEqual([]);
  });

  it('different currencies are different groups; a warning only for the one that dropped', () => {
    const usd = account({ id: 1, currency: 'USD', balance_minor: 50000 }); // $500, below the threshold
    const eur = account({ id: 2, currency: 'EUR', balance_minor: 500000 }); // 5000.00 EUR, above
    const ratesE9 = new Map([['EUR', 1_140_000_000]]);
    const result = buildForecast(
      baseInput({ accounts: [usd, eur], ratesE9, lowBalanceThresholdMinor: 100000n, horizonDays: 2 }),
    );

    const byKey = new Map(result.warnings.filter((w) => w.dimension === 'currency').map((w) => [w.dimensionKey, w]));
    expect(byKey.has('USD')).toBe(true);
    expect(byKey.has('EUR')).toBe(false);
  });

  it('a currency group reports its minimum and its threshold in its own native currency', () => {
    const eur = account({ id: 1, currency: 'EUR', balance_minor: 80_000 }); // €800
    const ratesE9 = new Map([['EUR', 1_140_000_000]]); // €1 = $1.14
    const result = buildForecast(
      baseInput({ accounts: [eur], ratesE9, lowBalanceThresholdMinor: 100_000n, horizonDays: 2 }),
    );

    const currency = result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'EUR');
    expect(currency).toMatchObject({
      currencyCode: 'EUR',
      startMinor: '80000',
      minimumProjectedMinor: '80000',
      thresholdMinor: '87719',
    });
  });

  it('does not emit a false currency warning at the banker-rounding boundary', () => {
    const ratesE9 = new Map([['EUR', 1_077_000_000]]); // 92851 EUR minor -> 100001 USD minor
    const above = account({ id: 1, currency: 'EUR', balance_minor: 92_851 });
    const resultAbove = buildForecast(
      baseInput({ accounts: [above], ratesE9, lowBalanceThresholdMinor: 100_000n, horizonDays: 2 }),
    );
    expect(resultAbove.warnings.some((w) => w.dimension === 'currency' && w.dimensionKey === 'EUR')).toBe(false);

    const atBoundary = account({ id: 1, currency: 'EUR', balance_minor: 92_850 });
    const resultAtBoundary = buildForecast(
      baseInput({ accounts: [atBoundary], ratesE9, lowBalanceThresholdMinor: 100_000n, horizonDays: 2 }),
    );
    expect(resultAtBoundary.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'EUR')).toMatchObject({
      currencyCode: 'EUR',
      thresholdMinor: '92850',
      startMinor: '92850',
    });
  });

  it('keeps a literal zero threshold for a cheap currency', () => {
    const rsd = account({ id: 1, currency: 'RSD', balance_minor: 54 }); // 0.54 RSD rounds to 0 USD minor
    const result = buildForecast(
      baseInput({
        accounts: [rsd],
        ratesE9: new Map([['RSD', 9_200_000]]),
        lowBalanceThresholdMinor: 0n,
        horizonDays: 2,
      }),
    );

    expect(result.warnings.some((w) => w.dimension === 'currency' && w.dimensionKey === 'RSD')).toBe(false);
  });
});

describe('buildForecast — validation', () => {
  it('a fractional or non-integer horizonDays/cashFlowDays is rejected with the same RangeError', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 0 });
    expect(() => buildForecast(baseInput({ accounts: [acc], horizonDays: 1.5 }))).toThrow(RangeError);
    expect(() => buildForecast(baseInput({ accounts: [acc], cashFlowDays: 1.5 }))).toThrow(RangeError);
  });
});

describe('buildForecast — overdue recurring payment (issue #279)', () => {
  it('aggregated debt on the first day of the horizon shifts the whole daily series and cash_flow', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 100000 }); // $1000.00
    const asOfDate = '2026-08-15';
    // Debt for 2 missed periods (-$100 * 2 = -$200) on the first day (2026-08-16)
    // plus a future payment of -$100 on 2026-09-15
    const flows: ForecastFlow[] = [
      flow({
        account_id: 1,
        date: '2026-08-16',
        amount_minor: -20000,
        currency: 'USD',
        title: 'Аренда',
        kind: 'recurring',
        source_id: 10,
      }),
      flow({
        account_id: 1,
        date: '2026-09-15',
        amount_minor: -10000,
        currency: 'USD',
        title: 'Аренда',
        kind: 'recurring',
        source_id: 10,
      }),
    ];

    const result = buildForecast(
      baseInput({ accounts: [acc], flows, baseCurrency: 'USD', asOfDate, horizonDays: 60, cashFlowDays: 30 }),
    );

    // Day 0 (start / net worth) = $1000.00 (100000n)
    expect(result.netWorthMinor).toBe(100000n);
    // Day 1 (2026-08-16) closes including the -$200.00 debt = $800.00
    expect(result.series[0].date).toBe('2026-08-16');
    expect(result.series[0].overallMinor).toBe(80000n);
    // Day 30 (2026-09-14) the balance is still $800.00
    expect(result.series[29].date).toBe('2026-09-14');
    expect(result.series[29].overallMinor).toBe(80000n);
    // Day 31 (2026-09-15) the second debit of -$100.00 = $700.00
    expect(result.series[30].date).toBe('2026-09-15');
    expect(result.series[30].overallMinor).toBe(70000n);

    // cashFlowMinor over a 30-day window = 80000n - 100000n = -20000n
    expect(result.cashFlowMinor).toBe(-20000n);
  });
});
