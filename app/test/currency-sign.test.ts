// Знак валюты в шапке и флаг+код в списке — UI-стандарт v2, 2026-08-21.
//
// Знак берётся у ICU, а не из своей таблицы: список валют владельца открыт
// (сегодня RSD, завтра любая другая), а поддерживать копию справочника —
// гарантированно отстать от него. Тест фиксирует не таблицу, а ПОВЕДЕНИЕ:
// что делает функция, когда знака нет, когда «знак» на деле длинный, и что
// возвращается вместо флага для наднациональных кодов.
import { describe, expect, it } from 'vitest';
import {
  currencySymbol, currencyFlag, GENERIC_CURRENCY_SIGN, GENERIC_CURRENCY_FLAG,
} from '../src/ui/currency-sign.js';

describe('currencySymbol', () => {
  it('отдаёт односимвольный знак для валют, у которых он есть', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('RUB')).toBe('₽');
    expect(currencySymbol('GBP')).toBe('£');
  });

  it('не зависит от регистра кода', () => {
    expect(currencySymbol('usd')).toBe('$');
    expect(currencySymbol('eur')).toBe('€');
  });

  // Требование владельца: «если символа нет, ставить какой-то уникальный
  // односимвольный знак». ¤ (U+00A4) — стандартный «валютный» плейсхолдер,
  // он не занят ни одной реальной валютой и потому ни с чем не спутается.
  it('подставляет ¤, когда знака нет или он длиннее двух глифов', () => {
    // У RSD в CLDR нет собственного знака — ICU возвращает сам код.
    expect(currencySymbol('RSD')).toBe(GENERIC_CURRENCY_SIGN);
    expect(currencySymbol('XAU')).toBe(GENERIC_CURRENCY_SIGN);
    expect(currencySymbol('')).toBe(GENERIC_CURRENCY_SIGN);
    expect(currencySymbol(null)).toBe(GENERIC_CURRENCY_SIGN);
    // Заведомо несуществующий код не должен ронять шапку исключением.
    expect(currencySymbol('ZZZ')).toBe(GENERIC_CURRENCY_SIGN);
  });

  it('никогда не отдаёт сам код валюты вместо знака', () => {
    for (const code of ['USD', 'EUR', 'RSD', 'XAU', 'KZT', 'AMD', 'ZZZ']) {
      expect(currencySymbol(code)).not.toBe(code);
    }
  });

  it('знак укладывается в один-два глифа — кнопка шапки не разъедется', () => {
    for (const code of ['USD', 'EUR', 'RUB', 'PLN', 'SEK', 'RSD', 'JPY']) {
      expect([...currencySymbol(code)].length).toBeLessThanOrEqual(2);
    }
  });
});

describe('currencyFlag', () => {
  it('строит флаг из первых двух букв кода', () => {
    expect(currencyFlag('USD')).toBe('🇺🇸');
    expect(currencyFlag('RUB')).toBe('🇷🇺');
    expect(currencyFlag('RSD')).toBe('🇷🇸');
    expect(currencyFlag('gbp')).toBe('🇬🇧');
  });

  // Евро — не страна: у ISO-кода EUR первые две буквы дают несуществующий
  // регион EU… , поэтому флаг задан явно.
  it('у евро — флаг ЕС', () => {
    expect(currencyFlag('EUR')).toBe('🇪🇺');
  });

  // Коды на X — наднациональные (металлы, SDR, тестовые). Региона у них нет,
  // и рисовать «флаг страны XA» значит выдумывать несуществующее.
  it('для наднациональных кодов — нейтральный значок', () => {
    expect(currencyFlag('XAU')).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag('XDR')).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag('')).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag(null)).toBe(GENERIC_CURRENCY_FLAG);
    expect(currencyFlag('E')).toBe(GENERIC_CURRENCY_FLAG);
  });
});
