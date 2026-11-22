// Amount conversion between currencies through rates against the configured FX anchor.
//
// A separate module, not a private function of build.ts, because two callers
// convert and they do it differently: the forecast core (build.ts) converts
// aggregates by account groups, and the `/forecast` route (api.ts) converts
// amounts of individual upcoming operations for the `upcoming` section. Here
// there is one path (Law 3).
import { IDENTITY_RATE, convertMinor, rateFromE9, type FxRate } from './fx';
import {
  EMPTY_CURRENCY_CATALOG,
  tryFractionDigits,
  type CurrencyCatalog,
} from '../../shared/currency';

export interface Converter {
  /** `null` means "no rate or missing currency standard for at least one side", not "zero". */
  (amountMinor: bigint, from: string, to: string): bigint | null;
}

export interface ConverterOptions {
  fxAnchorCurrency?: string | null;
  currencyCatalog?: CurrencyCatalog;
  onMissingCurrencyStandard?: (code: string) => void;
}

/**
 * Converter over the rate table `code -> rate_e9`.
 *
 * `onMissingRate` is called when an FX rate is needed and missing (or FX anchor is unconfigured).
 * Currency minor-unit exponents come strictly from `currencyCatalog`; missing currency standards
 * fail closed (return `null`) instead of assuming 2 decimals.
 */
export function makeConverter(
  ratesE9: Map<string, number>,
  _baseCurrency: string | null,
  onMissingRate?: (code: string) => void,
  options: ConverterOptions = {},
): Converter {
  const catalog = options.currencyCatalog ?? EMPTY_CURRENCY_CATALOG;
  const fxAnchor = options.fxAnchorCurrency ?? catalog.fxAnchorCode ?? null;

  function rateOf(code: string): FxRate | null {
    if (fxAnchor && code === fxAnchor) return IDENTITY_RATE;
    const e9 = ratesE9.get(code);
    if (e9 === undefined) {
      onMissingRate?.(code);
      return null;
    }
    return rateFromE9(e9);
  }

  return (amountMinor, from, to) => {
    if (from === to) return amountMinor;
    const fromDigits = tryFractionDigits(from, catalog);
    const toDigits = tryFractionDigits(to, catalog);
    if (fromDigits === null) {
      options.onMissingCurrencyStandard?.(from);
      onMissingRate?.(from);
    }
    if (toDigits === null) {
      options.onMissingCurrencyStandard?.(to);
      onMissingRate?.(to);
    }
    const sourceRate = rateOf(from);
    const targetRate = rateOf(to);
    if (fromDigits === null || toDigits === null || sourceRate === null || targetRate === null) {
      return null;
    }
    return convertMinor(
      amountMinor,
      { rate: sourceRate, currency: { exponent: fromDigits } },
      { rate: targetRate, currency: { exponent: toDigits } },
    );
  };
}
