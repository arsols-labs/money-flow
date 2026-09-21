import { describe, expect, it } from 'vitest';
import { buildCurrencyOptions } from '../src/ui/components';

describe('buildCurrencyOptions (issue #403)', () => {
  it('собирает уникальные валюты счетов и сортирует их', () => {
    const accounts = [
      { currency: 'USD' },
      { currency: 'eur' }, // регистр не нормализуется здесь — просто дедуп по строке
      { currency: 'RSD' },
      { currency: 'USD' }, // дубль
      { currency: 'eur' },
    ];
    expect(buildCurrencyOptions(accounts, null)).toEqual(['RSD', 'USD', 'eur']);
  });

  it('отбрасывает пустые/отсутствующие валюты счетов', () => {
    const accounts = [
      { currency: 'USD' },
      { currency: '' },
      { currency: null },
      {},
    ];
    expect(buildCurrencyOptions(accounts, null)).toEqual(['USD']);
  });

  it('добавляет текущую базовую валюту, даже если её нет среди счетов', () => {
    const accounts = [{ currency: 'RSD' }, { currency: 'EUR' }];
    // Текущая база пришла из settings, но не фигурирует на счетах (например,
    // валюта была сменена, а счета ещё в старой). Она должна остаться в списке.
    expect(buildCurrencyOptions(accounts, 'USD')).toEqual(['EUR', 'RSD', 'USD']);
  });

  it('не дублирует текущую базу, если она уже есть среди счетов', () => {
    const accounts = [{ currency: 'USD' }, { currency: 'EUR' }];
    expect(buildCurrencyOptions(accounts, 'USD')).toEqual(['EUR', 'USD']);
  });

  it('без текущей базы и со счетами без валют возвращает пустой список', () => {
    expect(buildCurrencyOptions([{}, { currency: '' }], null)).toEqual([]);
  });

  it('обрабатывает null/undefined вместо списка счетов', () => {
    expect(buildCurrencyOptions(null, 'USD')).toEqual(['USD']);
    expect(buildCurrencyOptions(undefined, null)).toEqual([]);
  });
});
