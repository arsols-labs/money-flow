// Pure forecast core (issue #198, S1-4) — not a single call to D1. All I/O
// lives in load.ts; buildForecast takes already loaded data and returns daily
// series and warnings. The split is deliberate: the core is tested without a
// database (test/forecast-build.test.ts), and the API (api.ts) only glues
// load.ts → buildForecast → JSON.
import { addDays } from './dates';
import { makeConverter } from './convert';
import type { ForecastAccount, ForecastFlow } from './load';

export interface BuildForecastInput {
  accounts: ForecastAccount[];
  flows: ForecastFlow[];
  ratesE9: Map<string, number>;
  baseCurrency: string;
  asOfDate: string;
  horizonDays: number; // 1..366
  lowBalanceThresholdMinor: bigint;
  cashFlowDays: number; // Cash Flow metric window
}

export interface ForecastWarning {
  dimension: 'account' | 'country' | 'currency' | 'overall';
  dimensionKey: string; // account id as a string / country code / currency code / 'overall'
  currencyCode: string; // currency the series is computed in
  thresholdMinor: string;
  earliestBelowThresholdDate: string | null;
  earliestNonPositiveDate: string | null;
  minimumProjectedMinor: string;
  minimumProjectedDate: string;
  /**
   * Value of the dimension on asOfDate — what the series is built from.
   *
   * What belongs here is the amount, not a state label ("already below" /
   * "approaching"), and that is not a detail: one label glued together two
   * DIFFERENT states — "already below the threshold" and "already negative" —
   * and the screen could not tell them apart and said "already negative" about
   * an account with a positive balance that was simply not large. From the pair
   * (startMinor, thresholdMinor) both states are derived exactly, and ROADMAP
   * "Phase 3" requires distinguishing them.
   */
  startMinor: string;
}

export interface BuildForecastResult {
  asOfDate: string;
  horizonDays: number;
  baseCurrency: string;
  netWorthMinor: bigint; // sum of balances today, in the base currency
  cashFlowMinor: bigint; // overall[cashFlowDays-1] - netWorth
  cashFlowDays: number;
  countries: string[]; // sorted
  owners: string[]; // sorted; empty if no owner group could be converted
  series: Array<{
    date: string;
    overallMinor: bigint;
    byCountry: Map<string, bigint>;
    byAccount: Map<number, bigint>;
    byOwner: Map<string, bigint>;
  }>;
  lowest: { date: string; amountMinor: bigint } | null; // overall minimum over the horizon
  accounts: Array<{ account: ForecastAccount; balanceBaseMinor: bigint | null }>;
  warnings: ForecastWarning[];
  missingRates: string[]; // currencies in use without a rate, sorted
}

export function buildForecast(input: BuildForecastInput): BuildForecastResult {
  const { accounts, flows, ratesE9, baseCurrency, asOfDate, horizonDays, lowBalanceThresholdMinor, cashFlowDays } =
    input;

  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) {
    throw new RangeError('buildForecast: horizonDays должен быть целым числом 1..366');
  }
  if (!Number.isInteger(cashFlowDays) || cashFlowDays < 1) {
    throw new RangeError('buildForecast: cashFlowDays должен быть целым числом >= 1');
  }
  const cashFlowIndex = Math.min(cashFlowDays, horizonDays) - 1;

  // ---------- rates and conversion ----------

  // The list of currencies without a rate is collected as a side effect of
  // conversion — that is, exactly when a rate was actually needed by someone,
  // not for every currency encountered in the data (see the makeConverter docblock).
  const missingRatesSet = new Set<string>();
  const convert = makeConverter(ratesE9, baseCurrency, (code) => missingRatesSet.add(code));

  // ---------- flows → account currency, daily series by account ----------

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  // Cumulative deltas by (account, date) — in the account's NATIVE currency. A
  // flow whose currency could not be converted into the account currency (no
  // rate for at least one side) is skipped: its currency already landed in
  // missingRatesSet via convert() above, and that is the only signal of the
  // skip — it does not stay silent at the response level (the UI shows
  // missing_rates as a warning).
  const deltasByAccountDate = new Map<number, Map<string, bigint>>();
  for (const f of flows) {
    const account = accountById.get(f.account_id);
    if (!account) continue; // load.ts already filters by eligibleAccountIds, but a guard is cheap
    const converted = convert(BigInt(f.amount_minor), f.currency, account.currency);
    if (converted === null) continue;
    let byDate = deltasByAccountDate.get(f.account_id);
    if (!byDate) deltasByAccountDate.set(f.account_id, (byDate = new Map()));
    byDate.set(f.date, (byDate.get(f.date) ?? 0n) + converted);
  }

  // Daily closing balances by account, days 1..horizonDays from asOfDate.
  // Day 0 (asOfDate itself) is not in the series — it is the starting balance.
  const perAccountDaily = new Map<number, bigint[]>();
  for (const a of accounts) {
    const deltas = deltasByAccountDate.get(a.id);
    const daily: bigint[] = [];
    let bal = BigInt(a.balance_minor);
    for (let i = 1; i <= horizonDays; i++) {
      const date = addDays(asOfDate, i);
      bal += deltas?.get(date) ?? 0n;
      daily.push(bal);
    }
    perAccountDaily.set(a.id, daily);
  }

  // ---------- account balances in the base currency (for the accounts section of the response) ----------

  const accountsOut = accounts.map((a) => ({
    account: a,
    balanceBaseMinor: convert(BigInt(a.balance_minor), a.currency, baseCurrency),
  }));

  // ---------- group dimensions: currency, country, overall ----------
  //
  // One shared pass for all three group dimensions (the archived `forecast.ts`
  // did exactly the same — a `groups` array with `keyOf`), not three copies of
  // one and the same loop.
  const groups: Array<{ dimension: 'currency' | 'country' | 'overall' | 'owner'; keyOf: (a: ForecastAccount) => string }> = [
    { dimension: 'currency', keyOf: (a) => a.currency },
    { dimension: 'country', keyOf: (a) => a.country },
    { dimension: 'owner', keyOf: (a) => a.owner },
    { dimension: 'overall', keyOf: () => 'overall' },
  ];

  interface GroupResult {
    dimension: 'currency' | 'country' | 'overall' | 'owner';
    key: string;
    startBalance: bigint;
    daily: bigint[];
    /**
     * Whether every account in the group could be converted into the base
     * currency. `false` means the series is the sum of a SUBSET of accounts,
     * that is, understated by an unknown amount. Such a series can still be
     * drawn (a chart with a warning about currencies without a rate is better
     * than an empty screen), but nothing may be ASSERTED from it — see the
     * warning filter below.
     */
    complete: boolean;
    /**
     * A currency group additionally stores its own native series. For
     * country/overall it is undefined: such a group contains several currencies
     * and the only honest unit left is baseCurrency.
     */
    nativeCurrency: string | null;
    nativeStartBalance: bigint | null;
    nativeDaily: bigint[] | null;
  }

  const groupResults: GroupResult[] = [];
  let overallStart = 0n;
  let overallDaily: bigint[] = new Array(horizonDays).fill(0n);
  // Initially false: the overall group may not appear at all (there are no
  // accounts, or none of their currencies can be converted), and then the zero
  // series above is a placeholder, not a result. Set to true only together
  // with a real complete group.
  let overallComplete = false;
  const countrySeries = new Map<string, bigint[]>();
  const ownerSeries = new Map<string, bigint[]>();
  const accountSeries = new Map<number, bigint[]>();
  for (const a of accounts) {
    // An account series on the chart is in the base currency. No rate — no line:
    // a zero series would claim there is nothing on the account, while the
    // amount is simply unknown.
    if (convert(0n, a.currency, baseCurrency) === null) continue;
    const nativeDaily = perAccountDaily.get(a.id)!;
    accountSeries.set(
      a.id,
      nativeDaily.map((native) => convert(native, a.currency, baseCurrency)!),
    );
  }

  for (const g of groups) {
    const byKey = new Map<string, ForecastAccount[]>();
    for (const a of accounts) {
      const key = g.keyOf(a);
      let members = byKey.get(key);
      if (!members) byKey.set(key, (members = []));
      members.push(a);
    }
    for (const key of [...byKey.keys()].sort()) {
      const members = byKey.get(key)!;
      // Currency → slot in the accumulator. The daily loop adds into a
      // fixed-length array instead of a new Map on each of the H days: the
      // order of summands is the order of first appearance of the currency in
      // members, so the conversion result is deterministic, and allocations
      // over the horizon are zero.
      const currencies: string[] = [];
      const currencyIndex = new Map<string, number>();
      const memberSlots: Array<{ daily: bigint[]; slot: number; balanceMinor: bigint }> = [];
      for (const a of members) {
        let slot = currencyIndex.get(a.currency);
        if (slot === undefined) {
          slot = currencies.length;
          currencies.push(a.currency);
          currencyIndex.set(a.currency, slot);
        }
        memberSlots.push({ daily: perAccountDaily.get(a.id)!, slot, balanceMinor: BigInt(a.balance_minor) });
      }
      // ROUND_HALF_EVEN is not distributive: aggregate native amounts by currency
      // and convert each currency group exactly once, not per account. A
      // currency that cannot be converted (convert returned null) is not added
      // to the sum at all — an account in that currency drops out of the group
      // series entirely, otherwise the total would be quietly understated under
      // the guise of a "normal" number.
      const convertGroupTotal = (nativeByCurrency: bigint[]): bigint => {
        let sum = 0n;
        for (let c = 0; c < currencies.length; c++) {
          const converted = convert(nativeByCurrency[c]!, currencies[c]!, baseCurrency);
          if (converted !== null) sum += converted;
        }
        return sum;
      };

      // Completeness of a group is a property of its currency set, not of a
      // particular day: a rate either exists or it does not, and it does not
      // depend on the amount. So it is computed once, before the daily loop.
      const convertible = currencies.filter((code) => convert(0n, code, baseCurrency) !== null);
      const complete = convertible.length === currencies.length;

      // A group where NOT A SINGLE currency can be converted is not emitted at
      // all. One rule for every group: show what is computable. A partially
      // converted group is computable — it is an understated but real sum
      // (nothing may be asserted from it; see the warning filter below). The
      // sum of a group where nothing can be converted is not "zero" but
      // unknown, and drawing it as zero would say "there is no money in this
      // country" when the money is there. Those accounts are visible in the
      // account list with a "no rate" mark, and the reason is in missingRates.
      if (convertible.length === 0) continue;

      const native = new Array<bigint>(currencies.length).fill(0n);
      for (const m of memberSlots) native[m.slot] += m.balanceMinor;
      const startBalance = convertGroupTotal(native);
      const nativeCurrency = g.dimension === 'currency' ? currencies[0]! : null;
      const nativeStartBalance = g.dimension === 'currency' ? native[0]! : null;

      const daily: bigint[] = [];
      const nativeDaily: bigint[] | null = g.dimension === 'currency' ? [] : null;
      for (let i = 0; i < horizonDays; i++) {
        native.fill(0n);
        for (const m of memberSlots) native[m.slot] += m.daily[i]!;
        nativeDaily?.push(native[0]!);
        daily.push(convertGroupTotal(native));
      }

      groupResults.push({
        dimension: g.dimension,
        key,
        startBalance,
        daily,
        complete,
        nativeCurrency,
        nativeStartBalance,
        nativeDaily,
      });
      if (g.dimension === 'overall') {
        overallStart = startBalance;
        overallDaily = daily;
        overallComplete = complete;
      }
      if (g.dimension === 'country') {
        countrySeries.set(key, daily);
      }
      if (g.dimension === 'owner') {
        ownerSeries.set(key, daily);
      }
    }
  }

  // ---------- final series and metrics ----------

  // Countries — only those whose series could be computed (see the group skip
  // above). A country where every account is in a currency without a rate does
  // not appear on the chart at all: a line at zero would claim there is no
  // money there.
  const countries = [...countrySeries.keys()].sort();
  const owners = [...ownerSeries.keys()].sort();
  const accountIds = [...accountSeries.keys()].sort((a, b) => a - b);
  const series = Array.from({ length: horizonDays }, (_, i) => ({
    date: addDays(asOfDate, i + 1),
    overallMinor: overallDaily[i]!,
    byCountry: new Map(countries.map((c) => [c, countrySeries.get(c)![i]!])),
    byAccount: new Map(accountIds.map((id) => [id, accountSeries.get(id)![i]!])),
    byOwner: new Map(owners.map((owner) => [owner, ownerSeries.get(owner)![i]!])),
  }));

  const netWorthMinor = overallStart;
  // cashFlowIndex is always inside [0, horizonDays-1] (Math.min(cashFlowDays,
  // horizonDays) - 1, and horizonDays >= 1), so the index is always defined.
  const cashFlowMinor = overallDaily[cashFlowIndex]! - netWorthMinor;

  // The minimum is sought only on a COMPLETE series. An incomplete one is
  // understated by an unknown amount, and a "minimum ahead" from it is not a
  // cautious estimate but a wrong number: the card on Pulse is simply not
  // shown, and the owner sees the warning about currencies without a rate and
  // enters the missing rate.
  let lowest: BuildForecastResult['lowest'] = null;
  if (accounts.length > 0 && overallComplete) {
    let minIdx = 0;
    let min = overallDaily[0]!;
    for (let i = 1; i < overallDaily.length; i++) {
      if (overallDaily[i]! < min) {
        min = overallDaily[i]!;
        minIdx = i;
      }
    }
    lowest = { date: addDays(asOfDate, minIdx + 1), amountMinor: min };
  }

  // ---------- warnings ----------

  function scanSeries(
    dimension: ForecastWarning['dimension'],
    dimensionKey: string,
    currencyCode: string,
    thresholdMinor: bigint,
    startBalance: bigint,
    daily: bigint[],
  ): ForecastWarning | null {
    // A dimension with neither money nor movement stays silent: a flat zero
    // across the whole horizon is "empty", not "low balance". Without this an
    // empty account would warn forever, simply because 0 is below the
    // threshold, and in production such rows made up a quarter of the list
    // (owner decision 2026-08-12, issue #256). As soon as a balance or even
    // one operation appears on the dimension, the series stops being zero and
    // the rule works as usual.
    if (startBalance === 0n && daily.every((v) => v === 0n)) return null;

    let earliestBelowThresholdIdx = -1;
    let earliestNonPositiveIdx = -1;
    let minIdx = 0;
    let min = daily[0]!;
    for (let i = 0; i < daily.length; i++) {
      if (daily[i]! < min) {
        min = daily[i]!;
        minIdx = i;
      }
      if (thresholdMinor > 0n && earliestBelowThresholdIdx === -1 && daily[i]! <= thresholdMinor) {
        earliestBelowThresholdIdx = i;
      }
      if (earliestNonPositiveIdx === -1 && daily[i]! <= 0n) {
        earliestNonPositiveIdx = i;
      }
    }
    if (earliestBelowThresholdIdx === -1 && earliestNonPositiveIdx === -1) return null;
    return {
      dimension,
      dimensionKey,
      currencyCode,
      // account is scanned only against zero; currency gets the same threshold,
      // converted in advance from the base currency into the group's native currency.
      thresholdMinor: thresholdMinor.toString(),
      earliestBelowThresholdDate: earliestBelowThresholdIdx === -1 ? null : addDays(asOfDate, earliestBelowThresholdIdx + 1),
      earliestNonPositiveDate: earliestNonPositiveIdx === -1 ? null : addDays(asOfDate, earliestNonPositiveIdx + 1),
      startMinor: startBalance.toString(),
      minimumProjectedMinor: min.toString(),
      minimumProjectedDate: addDays(asOfDate, minIdx + 1),
    };
  }

  const warnings: ForecastWarning[] = [];

  /**
   * The largest amount in `currency` that, after the usual ROUND_HALF_EVEN,
   * still does not exceed the base threshold. A plain inverse conversion of
   * the threshold can be off by one minor unit: for example, return 92851 EUR
   * when the reverse of that is already 100001 USD. A monotonic bound keeps
   * the original classification in baseCurrency and at the same time lets us
   * return an honest native threshold to the UI.
   */
  function thresholdCutoffInCurrency(currency: string): bigint | null {
    // A zero setting means exactly "only zero/negative". A positive native
    // amount does not become a threshold merely because it rounded to zero
    // when converted in a low-value currency.
    if (lowBalanceThresholdMinor === 0n) return 0n;

    const approximate = convert(lowBalanceThresholdMinor, baseCurrency, currency);
    if (approximate === null) return null;

    let low = approximate > 0n ? approximate : 0n;
    let high: bigint;
    const convertedLow = convert(low, currency, baseCurrency);
    if (convertedLow === null) return null;

    if (convertedLow > lowBalanceThresholdMinor) {
      high = low;
      low = 0n;
    } else {
      high = low + 1n;
      while (true) {
        const convertedHigh = convert(high, currency, baseCurrency);
        if (convertedHigh === null) return null;
        if (convertedHigh > lowBalanceThresholdMinor) break;
        low = high;
        high *= 2n;
      }
    }

    while (high - low > 1n) {
      const middle = (low + high) / 2n;
      const convertedMiddle = convert(middle, currency, baseCurrency);
      if (convertedMiddle === null) return null;
      if (convertedMiddle <= lowBalanceThresholdMinor) low = middle;
      else high = middle;
    }
    return low;
  }

  // dimension=account — native currency, against zero only.
  for (const a of accounts) {
    const w = scanSeries('account', String(a.id), a.currency, 0n, BigInt(a.balance_minor), perAccountDaily.get(a.id)!);
    if (w) warnings.push(w);
  }

  // Country and the overall total are in the base currency; a currency group
  // is in its own native currency. All three dimensions are checked against the
  // threshold AND against zero.
  //
  // An incomplete group produces no warnings at all. Reason: its series is the
  // sum of only those accounts whose currency could be converted, so it is
  // understated by construction. On such a series the threshold would fire
  // where the real money is enough, and the degenerate case (a single account
  // in a currency without a rate) would produce a series of zeros and an
  // "already below the threshold" warning about an amount that is actually
  // UNKNOWN, not equal to zero. A false alarm here costs more than a miss: the
  // real signal has not gone anywhere — a currency without a rate arrives in
  // `missingRates`, and that state is fixable with one rate. Warnings on the
  // accounts themselves (dimension=account) still always work: they are
  // computed in the native currency and need no conversion.
  for (const g of groupResults) {
    if (!g.complete) continue;
    // owner — a series for the "by user" chart, not a separate warning: the
    // low-balance signal for a person is already covered by account/country/overall.
    if (g.dimension === 'owner') continue;
    let w: ForecastWarning | null;
    if (g.dimension === 'currency') {
      // The label "Currency RSD" must be accompanied by a series in RSD, not by
      // an outwardly wrong symbol of the base currency. The threshold stays one
      // setting in baseCurrency and is translated by the same server FX path
      // before the comparison.
      const nativeThreshold = thresholdCutoffInCurrency(g.nativeCurrency!);
      if (nativeThreshold === null) continue; // complete guarantees reversibility; the guard stays fail-closed
      w = scanSeries(
        g.dimension,
        g.key,
        g.nativeCurrency!,
        nativeThreshold,
        g.nativeStartBalance!,
        g.nativeDaily!,
      );
    } else {
      w = scanSeries(g.dimension, g.key, baseCurrency, lowBalanceThresholdMinor, g.startBalance, g.daily);
    }
    if (w) warnings.push(w);
  }

  warnings.sort((x, y) => (x.dimension === y.dimension ? (x.dimensionKey < y.dimensionKey ? -1 : 1) : x.dimension < y.dimension ? -1 : 1));

  return {
    asOfDate,
    horizonDays,
    baseCurrency,
    netWorthMinor,
    cashFlowMinor,
    cashFlowDays,
    countries,
    owners,
    series,
    lowest,
    accounts: accountsOut,
    warnings,
    missingRates: [...missingRatesSet].sort(),
  };
}
