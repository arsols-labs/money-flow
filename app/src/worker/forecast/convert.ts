// Amount conversion between currencies through rates against the base (issue #198, S1-4).
//
// A separate module, not a private function of build.ts, because two callers
// convert and they do it differently: the forecast core (build.ts) converts
// aggregates by account groups, and the `/forecast` route (api.ts) converts
// amounts of individual upcoming operations for the `upcoming` section. While
// those were two implementations, they could diverge in rounding and in the
// meaning of "no rate" — and they would diverge silently, because both emit
// a plausible number. Here there is one path (Law 3).
import { IDENTITY_RATE, convertMinor, rateFromE9, type FxRate } from './fx';
import { fractionDigits } from '../../shared/currency';

export interface Converter {
  /** `null` means "no rate for at least one side", not "zero". */
  (amountMinor: bigint, from: string, to: string): bigint | null;
}

/**
 * Converter over the rate table `code -> rate_e9`.
 *
 * `onMissingRate` is called exactly when a rate was actually needed and was
 * missing — that is, the "currencies without a rate" list is collected by
 * actual need, not by the mere presence of a currency in the data. The
 * difference shows up on an account in the base currency with an operation in
 * that same currency: no conversion is needed there at all, and there is
 * nothing to report about a missing rate.
 */
export function makeConverter(
  ratesE9: Map<string, number>,
  baseCurrency: string,
  onMissingRate?: (code: string) => void,
): Converter {
  function rateOf(code: string): FxRate | null {
    if (code === 'USD') return IDENTITY_RATE;
    const e9 = ratesE9.get(code);
    if (e9 === undefined) {
      onMissingRate?.(code);
      return null;
    }
    return rateFromE9(e9);
  }

  return (amountMinor, from, to) => {
    // Identical codes are returned as-is — without a pass through
    // BigInt math: there is no reason to pay ROUND_HALF_EVEN rounding for an
    // identity conversion, and a rate is not needed for it (see rateOf above).
    if (from === to) return amountMinor;
    const sourceRate = rateOf(from);
    const targetRate = rateOf(to);
    // Both rateOf calls happen BEFORE the check on purpose: when both sides
    // lack a rate, the owner must see both currencies in missing_rates, not
    // only the first.
    if (sourceRate === null || targetRate === null) return null;
    return convertMinor(
      amountMinor,
      { rate: sourceRate, currency: { exponent: fractionDigits(from) } },
      { rate: targetRate, currency: { exponent: fractionDigits(to) } },
    );
  };
}
