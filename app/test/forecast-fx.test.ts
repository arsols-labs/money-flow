// Unit-тесты FX decimal-математики (issue #198, «ROUND_HALF_EVEN»). Портировано
// из archive/v2-codex (app/test/fx.test.ts): изменена точка входа
// (src/worker/forecast/fx.ts), кейсы convertMinorToUsd выкинуты (в v2 базовая
// валюта настраиваемая, а не зашитый USD — см. IDENTITY_RATE/rateFromE9).
import { describe, expect, it } from 'vitest';
import { IDENTITY_RATE, convertMinor, divideRoundHalfEven, rateFromE9 } from '../src/worker/forecast/fx';

describe('divideRoundHalfEven', () => {
  it('округляет вниз при remainder < half', () => {
    expect(divideRoundHalfEven(7n, 3n)).toBe(2n); // 2.33…
  });

  it('округляет вверх при remainder > half', () => {
    expect(divideRoundHalfEven(8n, 3n)).toBe(3n); // 2.66…
  });

  it('tie → к чётному (2.5 → 2, 3.5 → 4)', () => {
    expect(divideRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divideRoundHalfEven(7n, 2n)).toBe(4n);
  });

  it('отрицательные суммы симметричны (-2.5 → -2, -3.5 → -4)', () => {
    expect(divideRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(divideRoundHalfEven(-7n, 2n)).toBe(-4n);
  });

  it('точное деление без округления', () => {
    expect(divideRoundHalfEven(9n, 3n)).toBe(3n);
    expect(divideRoundHalfEven(0n, 7n)).toBe(0n);
  });

  it('tie определяется строго как 2*remainder == denominator', () => {
    // 4.5 при чётном частном 4 остаётся 4
    expect(divideRoundHalfEven(9n, 2n)).toBe(4n);
  });

  it('отвергает неположительный знаменатель', () => {
    expect(() => divideRoundHalfEven(1n, 0n)).toThrow(RangeError);
    expect(() => divideRoundHalfEven(1n, -2n)).toThrow(RangeError);
  });
});

describe('convertMinor', () => {
  // Курсы в стиле фикстур: EUR 1.14 к базовой, RSD 0.0097 к базовой (mantissa
  // 114/scale 2 и 97/scale 4 — ровно форма rateFromE9, только с произвольным
  // scale, чтобы проверить общую формулу, а не только e9-частный случай);
  // оба exponent 2.
  const eur = { rate: { mantissa: 114n, scale: 2 }, currency: { exponent: 2 } };
  const rsd = { rate: { mantissa: 97n, scale: 4 }, currency: { exponent: 2 } };
  const base = { rate: IDENTITY_RATE, currency: { exponent: 2 } };
  const jpy = { rate: { mantissa: 67n, scale: 4 }, currency: { exponent: 0 } }; // 0.0067 базовой, без minor units

  it('EUR → базовая: 10.00 EUR = 11.40', () => {
    expect(convertMinor(1000n, eur, base)).toBe(1140n);
  });

  it('базовая → EUR обратим с банковским округлением', () => {
    // 11.40 / 1.14 = 10.00 EUR
    expect(convertMinor(1140n, base, eur)).toBe(1000n);
  });

  it('кросс-курс через базовую-pivot: 100.00 EUR → RSD', () => {
    // 100.00 EUR = 114 базовой; 114 / 0.0097 = 11752.577… RSD → 11752.58 (minor 1175258)
    expect(convertMinor(10000n, eur, rsd)).toBe(1175258n);
  });

  it('разные exponent: 1000 JPY → базовая (exponent 0 → 2)', () => {
    // 1000 JPY * 0.0067 = 6.70 базовой
    expect(convertMinor(1000n, jpy, base)).toBe(670n);
  });

  it('отрицательные суммы конвертируются симметрично', () => {
    expect(convertMinor(-10000n, eur, rsd)).toBe(-1175258n);
  });

  it('BigInt: суммы за пределами Number.MAX_SAFE_INTEGER не теряют точность', () => {
    const big = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    expect(convertMinor(big, base, base)).toBe(big);
  });

  it('rateFromE9 строит FxRate из fx_rates.rate_e9 (mantissa=rateE9, scale=9)', () => {
    // 0.0092 * 1e9 = 9_200_000 — ровно то, что хранит колонка rate_e9.
    const rsdFromE9 = { rate: rateFromE9(9_200_000), currency: { exponent: 2 } };
    expect(convertMinor(100000n, base, rsdFromE9)).toBe(10869565n); // 1000.00 / 0.0092 = 108695.65…
  });

  it('IDENTITY_RATE — тождественная конверсия базовой в саму себя', () => {
    expect(convertMinor(12345n, base, base)).toBe(12345n);
  });

  it('отвергает некорректный курс и exponent', () => {
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 0n, scale: 0 }, currency: { exponent: 2 } }, base),
    ).toThrow(RangeError);
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 0 }, currency: { exponent: 9 } }, base),
    ).toThrow(RangeError);
  });

  it('отвергает scale вне персистентного контракта 0..12 (не только < 0)', () => {
    // Без верхней границы огромный scale уходит в 10n ** BigInt(scale) —
    // непроверенный source конвертации мог бы исчерпать CPU/память.
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 13 }, currency: { exponent: 2 } }, base),
    ).toThrow(RangeError);
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 1000000 }, currency: { exponent: 2 } }, base),
    ).toThrow(RangeError);
    // 12 — валидная граница, должен пройти.
    expect(() =>
      convertMinor(1n, { rate: { mantissa: 1n, scale: 12 }, currency: { exponent: 2 } }, base),
    ).not.toThrow();
  });
});
