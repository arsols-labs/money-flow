// Deterministic FX math v2 (issue #198): no floats —
// integer (BigInt) arithmetic and banker's rounding ROUND_HALF_EVEN.
//
// A rate is stored as a positive integer mantissa + scale (base_per_unit = m / 10^s),
// amounts are in minor units of a currency with exponent 0–8. Conversion:
//   N = A * mS * 10^(eT + sT)
//   D = mT * 10^(eS + sS)
//   target_minor = divide_round_half_even(N, D)
// A tie is strictly 2*remainder == denominator; the quotient rounds to even.

export interface FxRate {
  /** base_per_unit_mantissa > 0 */
  mantissa: bigint;
  /** base_per_unit_scale >= 0 — number of decimal digits in the mantissa */
  scale: number;
}

export interface CurrencyInfo {
  /** ISO-4217 exponent 0–8: minor units in one unit of the currency */
  exponent: number;
}

/** Rate of the base currency against itself — an identity conversion. */
export const IDENTITY_RATE: FxRate = { mantissa: 1n, scale: 0 };

/**
 * Rate from `fx_rates.rate_e9` (migrations/0001_initial_schema.sql:
 * `base_per_unit = rate_e9 / 1e9`) — the only source of rates in schema v2.
 */
export function rateFromE9(rateE9: number | bigint): FxRate {
  return { mantissa: BigInt(rateE9), scale: 9 };
}

const TEN = 10n;

function pow10(exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0) {
    throw new RangeError(`pow10: неотрицательная целая степень ожидалась, получено ${exp}`);
  }
  return TEN ** BigInt(exp);
}

/**
 * Signed integer division with half-to-even (banker's) rounding.
 * The denominator must be > 0 (rates are always positive).
 */
export function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError('divideRoundHalfEven: знаменатель должен быть > 0');
  }
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let quotient = n / denominator;
  const remainder = n % denominator;
  const twice = remainder * 2n;
  if (twice > denominator) {
    quotient += 1n;
  } else if (twice === denominator && quotient % 2n === 1n) {
    // Exactly half — round to even.
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

/**
 * Converts minor units of the source currency into minor units of the target
 * currency through a pair of rates against the base currency. Both amounts
 * and the result are BigInt: products easily exceed Number.MAX_SAFE_INTEGER.
 */
export function convertMinor(
  amountMinor: bigint,
  source: { rate: FxRate; currency: CurrencyInfo },
  target: { rate: FxRate; currency: CurrencyInfo },
): bigint {
  assertRate(source.rate, 'source');
  assertRate(target.rate, 'target');
  assertExponent(source.currency.exponent, 'source');
  assertExponent(target.currency.exponent, 'target');
  const n =
    amountMinor * source.rate.mantissa * pow10(target.currency.exponent + target.rate.scale);
  const d = target.rate.mantissa * pow10(source.currency.exponent + source.rate.scale);
  return divideRoundHalfEven(n, d);
}

function assertRate(rate: FxRate, label: string): void {
  if (rate.mantissa <= 0n) {
    throw new RangeError(`FX ${label}: mantissa должна быть > 0`);
  }
  // Upper bound of 12: the only producer of rates in v2 is rateFromE9
  // (scale is always 9), and the bound protects pow10() from unchecked input —
  // without it a jump in scale goes straight into 10n ** BigInt(scale).
  if (!Number.isInteger(rate.scale) || rate.scale < 0 || rate.scale > 12) {
    throw new RangeError(`FX ${label}: scale должен быть целым в диапазоне 0–12`);
  }
}

function assertExponent(exponent: number, label: string): void {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 8) {
    throw new RangeError(`FX ${label}: exponent валюты должен быть в диапазоне 0–8`);
  }
}
