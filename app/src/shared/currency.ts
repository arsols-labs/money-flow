import type { CurrencyStandardPayload, ResolvedRuleEntry } from './rules/types';

export interface CurrencyCatalog {
  entries: ReadonlyMap<string, CurrencyStandardPayload>;
  fxAnchorCode: string | null;
}

export const EMPTY_CURRENCY_CATALOG: CurrencyCatalog = {
  entries: new Map(),
  fxAnchorCode: null,
};

export class MissingCurrencyConfigError extends Error {
  readonly code = 'MISSING_CONFIGURATION';
  readonly domain = 'currency_standards';
  readonly currencyCode: string | null;

  constructor(currencyCode: string | null, message?: string) {
    super(
      message
        ?? (currencyCode
          ? `Currency standard for "${currencyCode}" is not configured in D1 rules.`
          : 'Currency standards are not configured in D1 rules.'),
    );
    this.name = 'MissingCurrencyConfigError';
    this.currencyCode = currencyCode;
  }
}

let activeRuntimeCatalog: CurrencyCatalog = EMPTY_CURRENCY_CATALOG;

/**
 * Registers the runtime-resolved currency catalog loaded from D1 (used by browser UI formatting helpers).
 * Passing EMPTY_CURRENCY_CATALOG resets the runtime catalog (tests / empty install).
 */
export function setRuntimeCurrencyCatalog(catalog: CurrencyCatalog): void {
  activeRuntimeCatalog = catalog;
}

export function getRuntimeCurrencyCatalog(): CurrencyCatalog {
  return activeRuntimeCatalog;
}

const THREE_LETTER_CODE_RE = /^[A-Z]{3}$/;

/**
 * Pure syntactic normalization: trims and uppercases a 3-letter ASCII code.
 * Does NOT verify whether the currency exists or what minor units it uses.
 */
export function normalizeCurrencyCodeSyntax(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return THREE_LETTER_CODE_RE.test(code) ? code : null;
}

export function buildCurrencyCatalog(
  entries: ReadonlyArray<CurrencyStandardPayload | ResolvedRuleEntry<CurrencyStandardPayload>>,
): CurrencyCatalog {
  const map = new Map<string, CurrencyStandardPayload>();
  let fxAnchorCode: string | null = null;

  for (const item of entries) {
    const payload = 'payload' in item ? item.payload : item;
    const code = normalizeCurrencyCodeSyntax(payload.code);
    if (!code) continue;
    if (!map.has(code)) {
      map.set(code, {
        code,
        minor_digits: payload.minor_digits,
        symbol: payload.symbol ?? null,
        is_fx_anchor: payload.is_fx_anchor,
      });
    }
    if (payload.is_fx_anchor && fxAnchorCode === null) {
      fxAnchorCode = code;
    }
  }

  return {
    entries: map,
    fxAnchorCode,
  };
}

/**
 * Normalizes a currency code and requires it to be configured in `catalog`.
 */
export function normalizeConfiguredCurrencyCode(
  raw: unknown,
  catalog: CurrencyCatalog = activeRuntimeCatalog,
): string | null {
  const code = normalizeCurrencyCodeSyntax(raw);
  if (!code) return null;
  return catalog.entries.has(code) ? code : null;
}

export function resolveFxAnchor(catalog: CurrencyCatalog = activeRuntimeCatalog): string | null {
  return catalog.fxAnchorCode;
}

export function listConfiguredCurrencies(
  catalog: CurrencyCatalog = activeRuntimeCatalog,
): CurrencyStandardPayload[] {
  return Array.from(catalog.entries.values());
}

/**
 * Returns configured minor digits for `currency`, or `null` when not configured.
 */
export function tryFractionDigits(
  currency: unknown,
  catalog: CurrencyCatalog = activeRuntimeCatalog,
): number | null {
  const code = normalizeCurrencyCodeSyntax(currency);
  if (!code) return null;
  const entry = catalog.entries.get(code);
  return entry ? entry.minor_digits : null;
}

/**
 * Strict minor-digit lookup backed by the active D1 `currency_standards` catalog.
 * Throws MissingCurrencyConfigError when `currency` is absent from `catalog` instead of guessing 2 digits.
 */
export function fractionDigits(
  currency: unknown,
  catalog: CurrencyCatalog = activeRuntimeCatalog,
): number {
  const code = normalizeCurrencyCodeSyntax(currency);
  if (!code) {
    throw new MissingCurrencyConfigError(null, 'Currency code is missing or syntactically invalid.');
  }
  const entry = catalog.entries.get(code);
  if (!entry) {
    throw new MissingCurrencyConfigError(code);
  }
  return entry.minor_digits;
}
