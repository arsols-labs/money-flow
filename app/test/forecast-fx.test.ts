// Unit tests of FX decimal math (issue #198, "ROUND_HALF_EVEN"). Ported
// from archive/v2-codex (app/test/fx.test.ts): the entry point changed
// (src/worker/forecast/fx.ts), and the convertMinorToUsd cases were dropped (in v2 the base
// currency is configurable, not a hardcoded USD — see IDENTITY_RATE/rateFromE9).
import { describe, expect, it } from 'vitest';
import { IDENTITY_RATE, convertMinor, divideRoundHalfEven, rateFromE9 } from '../src/worker/forecast/fx';

describe('divideRoundHalfEven', () => {
  it('rounds down when remainder < half', () => {
    expect(divideRoundHalfEven(7n, 3n)).toBe(2n); // 2.33…
  });

  it('rounds up when remainder > half', () => {
    expect(divideRoundHalfEven(8n, 3n)).toBe(3n); // 2.66…
  });

  it('tie → to even (2.5 → 2, 3.5 → 4)', () => {
    expect(divideRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divideRoundHalfEven(7n, 2n)).toBe(4n);
  });

  it('negative amounts are symmetric (-2.5 → -2, -3.5 → -4)', () => {
    expect(divideRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(divideRoundHalfEven(-7n, 2n)).toBe(-4n);
  });

  it('exact division with no rounding', () => {
    expect(divideRoundHalfEven(9n, 3n)).toBe(3n);
    expect(divideRoundHalfEven(0n, 7n)).toBe(0n);
  });

  it('a tie is defined strictly as 2*remainder == denominator', () => {
    // 4.5 with an even quotient of 4 stays 4
    expect(divideRoundHalfEven(9n, 2n)).toBe(4n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => divideRoundHalfEven(1n, 0n)).toThrow(RangeError);
    expect(() => divideRoundHalfEven(1n, -2n)).toThrow(RangeError);
  });
});

describe('convertMinor', () => {
  // Rates in the style of the fixtures: EUR 1.14 to the base, RSD 0.0097 to the base (mantissa
  // 114/scale 2 and 97/scale 4 — exactly the rateFromE9 form, only with an arbitrary
  // scale, so the general formula is checked, not only the e9 special case);
  // both exponent 2.
  const eur = { rate: { mantissa: 114n, scale: 2 }, currency: { exponent: 2 } };
  const rsd = { rate: { mantissa: 97n, scale: 4 }, currency: { exponent: 2 } };
  const base = { rate: IDENTITY_RATE, currency: { exponent: 2 } };
  const jpy = { rate: { mantissa: 67n, scale: 4 }, currency: { exponent: 0 } }; // 0.0067 of the base, no minor units

  it('EUR → base: 10.00 EUR = 11.40', () => {
    expect(convertMinor(1000n, eur, base)).toBe(1140n);
  });

  it("base → EUR is reversible with banker's rounding", () => {
    // 11.40 / 1.14 = 10.00 EUR
    expect(convertMinor(1140n, base, eur)).toBe(1000n);
  });

  it('cross rate through the base pivot: 100.00 EUR → RSD', () => {
    // 100.00 EUR = 114 of the base; 114 / 0.0097 = 11752.577… RSD → 11752.58 (minor 1175258)
    expect(convertMinor(10000n, eur, rsd)).toBe(1175258n);
  });

  it('different exponents: 1000 JPY → base (exponent 0 → 2)', () => {
    // 1000 JPY * 0.0067 = 6.70 of the base
    expect(convertMinor(1000n, jpy, base)).toBe(670n);
  });

  it('negative amounts convert symmetrically', () => {
    expect(convertMinor(-10000n, eur, rsd)).toBe(-1175258n);
  });

  it('BigInt: amounts beyond Number.MAX_SAFE_INTEGER do not lose precision', () => {
    const big = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    expect(convertMinor(big, base, base)).toBe(big);
  });

  it('rateFromE9 builds an FxRate from fx_rates.rate_e9 (mantissa=rateE9, scale=9)', () => {
    // 0.0092 * 1e9 = 9_200_000 — exactly what the rate_e9 column stores.
    const rsdFromE9 = { rate: rateFromE9(9_200_000), currency: { exponent: 2 } };
    expect(convertMinor(100000n, base, rsdFromE9)).toBe(10869565n); // 1000.00 / 0.0092 = 108695.65…
  });

  it('IDENTITY_RATE — identity conversion of the base into itself', () => {
    expect(convertMinor(12345n, base, base)).toBe(12345n);
  });

  it('rejects an invalid rate and exponent', () => {
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 0n, scale: 0 }, currency: { exponent: 2 } }, base),
    ).toThrow(RangeError);
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 0 }, currency: { exponent: 9 } }, base),
    ).toThrow(RangeError);
  });

  it('rejects a scale outside the persistent contract 0..12 (not only < 0)', () => {
    // Without an upper bound a huge scale goes into 10n ** BigInt(scale) —
    // an unchecked conversion source could exhaust CPU/memory.
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 13 }, currency: { exponent: 2 } }, base),
    ).toThrow(RangeError);
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 1000000 }, currency: { exponent: 2 } }, base),
    ).toThrow(RangeError);
    // 12 is a valid boundary and must pass.
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 12 }, currency: { exponent: 2 } }, base),
    ).not.toThrow();
  });
});
