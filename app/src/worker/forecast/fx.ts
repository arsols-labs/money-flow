// Детерминированная FX-математика v2 (issue #198): никаких float —
// целочисленная (BigInt) арифметика и банковское округление ROUND_HALF_EVEN.
//
// Курс хранится как positive integer mantissa + scale (base_per_unit = m / 10^s),
// суммы — в minor units валюты с exponent 0–8. Конверсия:
//   N = A * mS * 10^(eT + sT)
//   D = mT * 10^(eS + sS)
//   target_minor = divide_round_half_even(N, D)
// Tie — строго 2*remainder == denominator; частное округляется к чётному.

export interface FxRate {
  /** base_per_unit_mantissa > 0 */
  mantissa: bigint;
  /** base_per_unit_scale >= 0 — число десятичных знаков мантиссы */
  scale: number;
}

export interface CurrencyInfo {
  /** ISO-4217 exponent 0–8: minor units в одной единице валюты */
  exponent: number;
}

/** Курс базовой валюты к самой себе — тождественная конверсия. */
export const IDENTITY_RATE: FxRate = { mantissa: 1n, scale: 0 };

/**
 * Курс из `fx_rates.rate_e9` (migrations/0001_initial_schema.sql:
 * `base_per_unit = rate_e9 / 1e9`) — единственный источник курсов в схеме v2.
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
 * Целочисленное деление со знаком и округлением half-to-even (банковским).
 * Знаменатель должен быть > 0 (курсы всегда положительны).
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
    // Ровно половина — округляем к чётному.
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

/**
 * Конверсия minor units source-валюты в minor units target-валюты через пару
 * курсов к базовой валюте. Обе величины и результат — BigInt: произведения
 * легко выходят за Number.MAX_SAFE_INTEGER.
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
  // Верхняя граница 12: единственный производитель курсов в v2 — rateFromE9
  // (scale всегда 9), а граница защищает pow10() от непроверенного входа —
  // без неё скачок scale уходит прямиком в 10n ** BigInt(scale).
  if (!Number.isInteger(rate.scale) || rate.scale < 0 || rate.scale > 12) {
    throw new RangeError(`FX ${label}: scale должен быть целым в диапазоне 0–12`);
  }
}

function assertExponent(exponent: number, label: string): void {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 8) {
    throw new RangeError(`FX ${label}: exponent валюты должен быть в диапазоне 0–8`);
  }
}
