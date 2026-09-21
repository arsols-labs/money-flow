// Разбор денежного ввода на клиенте (S1-2, issue #196).
//
// Почему это вообще тестируется, хотя «CRUD и UI — smoke» по ТЗ: сюда
// пользователь вводит суммы руками, и ошибка здесь молча искажает баланс, на
// котором держится весь прогноз. `19.99 * 100 === 1998.9999999999998` — ровно
// тот случай, который тесты обязаны зафиксировать навсегда.
//
// Гоняется в том же workerd-пуле, что и остальные тесты v2; DOM здесь не
// нужен — money.js работает со строками и Intl.
import './use-ru-i18n';
import { describe, expect, it } from 'vitest';
import {
  parseAmountToMinor,
  minorToInputString,
  normalizeRateInput,
  fractionDigits,
  formatMajor,
  formatMajorCompact,
} from '../src/ui/money.js';

describe('fractionDigits', () => {
  it('знает разрядность обычных валют', () => {
    expect(fractionDigits('USD')).toBe(2);
    expect(fractionDigits('EUR')).toBe(2);
    expect(fractionDigits('RUB')).toBe(2);
    expect(fractionDigits('JPY')).toBe(0);
    expect(fractionDigits('KWD')).toBe(3);
    expect(fractionDigits('CLF')).toBe(4);
  });

  // Отдельным тестом, потому что это не абстрактный край: у владельца есть
  // счета в динарах, а CLDR (то есть Intl) отдаёт для RSD 0 знаков вопреки
  // ISO 4217. Ответ должен приходить из нашей таблицы, а не из ICU браузера.
  it('для RSD даёт два знака — ISO 4217, а не CLDR', () => {
    expect(fractionDigits('RSD')).toBe(2);
  });

  it('на неизвестном коде не падает, а отдаёт два знака', () => {
    expect(fractionDigits('ZZZ')).toBe(2);
    expect(fractionDigits('')).toBe(2);
    expect(fractionDigits(undefined)).toBe(2);
  });
});

describe('parseAmountToMinor', () => {
  it.each([
    ['19.99', 'USD', 1999],
    // Запятая — как её набирают на русской раскладке.
    ['19,99', 'USD', 1999],
    ['0.05', 'USD', 5],
    ['.5', 'USD', 50],
    ['1 200.5', 'USD', 120050],
    ['  1200  ', 'USD', 120000],
    ['-5.5', 'USD', -550],
    ['0', 'USD', 0],
    ['-0.00', 'USD', 0],
    // Валюта без дробной части: минорная единица равна майорной.
    ['1200', 'JPY', 1200],
  ])('%s (%s) → %i', (input, currency, expected) => {
    expect(parseAmountToMinor(input, currency)).toBe(expected);
  });

  it('не теряет копейки на float-опасных значениях', () => {
    // У каждого из этих значений `Number(x) * 100` даёт хвост вида
    // 1998.9999999999998 или 823.9999999999999 — строковый разбор обязан
    // давать ровное целое.
    for (const [input, expected] of [
      ['19.99', 1999],
      ['0.07', 7],
      ['1.1', 110],
      ['8.24', 824],
      ['35.41', 3541],
    ] as const) {
      expect(parseAmountToMinor(input, 'USD')).toBe(expected);
    }
  });

  it.each([
    ['пустая строка', ''],
    ['только пробелы', '   '],
    ['буквы', 'abc'],
    ['две точки', '1.2.3'],
    ['один минус', '-'],
    ['одна точка', '.'],
    ['лишний знак для двухзначной валюты', '1.999'],
  ])('отклоняет: %s', (_label, input) => {
    expect(() => parseAmountToMinor(input, 'USD')).toThrow();
  });

  it('отклоняет сумму за пределами точного целого, а не округляет молча', () => {
    expect(() => parseAmountToMinor('999999999999999999', 'USD')).toThrow(/Слишком большая/);
  });

  it('для валюты без дробной части лишний знак — ошибка', () => {
    expect(() => parseAmountToMinor('1200.5', 'JPY')).toThrow();
  });
});

describe('minorToInputString', () => {
  it.each([
    [1999, 'USD', '19.99'],
    [5, 'USD', '0.05'],
    [0, 'USD', '0.00'],
    [-550, 'USD', '-5.50'],
    [1200, 'JPY', '1200'],
  ])('%i (%s) → %s', (minor, currency, expected) => {
    expect(minorToInputString(minor, currency)).toBe(expected);
  });

  it('round-trip: строка → минорные → строка не меняет значения', () => {
    for (const value of ['19.99', '0.05', '-5.50', '1200.00']) {
      const minor = parseAmountToMinor(value, 'USD');
      expect(parseAmountToMinor(minorToInputString(minor, 'USD'), 'USD')).toBe(minor);
    }
  });
});

describe('formatMajorCompact (issue #582)', () => {
  it('keeps thousands grouping instead of stripping the group as cents', () => {
    // Старый форматтер оси: formatMajor(v).replace(/[.,]\d+/, '') —
    // на en-US `$17,521.60` превращался в `$17.60`.
    const fullEn = formatMajor(17521.60, 'USD', 'en-US');
    expect(fullEn.replace(/[.,]\d+/, '')).toBe('$17.60');
    expect(formatMajorCompact(17521.60, 'USD', 'en-US')).toBe('$17,522');
    expect(formatMajorCompact(5000, 'USD', 'en-US')).toBe('$5,000');
    expect(formatMajorCompact(0, 'USD', 'en-US')).toBe('$0');
  });

  it('keeps grouping in ru-RU compact labels', () => {
    const compact = formatMajorCompact(17521.60, 'USD', 'ru-RU');
    expect(compact).toMatch(/17/);
    expect(compact).toMatch(/522/);
    expect(compact.replace(/\s/g, '')).not.toMatch(/^17[.,]60/);
  });
});

describe('normalizeRateInput', () => {
  it('пропускает курс с девятью знаками и нормализует запятую', () => {
    expect(normalizeRateInput('0.0092')).toBe('0.0092');
    expect(normalizeRateInput(' 0,0092 ')).toBe('0.0092');
    expect(normalizeRateInput('0.000000001')).toBe('0.000000001');
    expect(normalizeRateInput('1')).toBe('1');
  });

  it.each([
    ['ноль', '0'],
    ['ноль с нулевой дробью', '0.000'],
    ['отрицательный', '-1'],
    ['десять знаков после точки', '0.0000000001'],
    ['экспонента', '1e5'],
    ['буквы', 'abc'],
    ['пусто', ''],
  ])('отклоняет: %s', (_label, input) => {
    expect(() => normalizeRateInput(input)).toThrow();
  });
});
