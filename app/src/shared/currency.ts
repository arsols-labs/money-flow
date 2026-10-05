// ISO 4217 minor-unit scale — the shared source for the UI and the worker
// (issue #198). It used to live only in src/ui/money.js; the forecast engine
// needs it to convert flows between currencies (see src/worker/forecast/build.ts),
// so it is extracted here as one module (Law 3 — one source, not a second copy).

// Minor-unit scale per ISO 4217. A table, not
// `Intl.…resolvedOptions().maximumFractionDigits`, and that is deliberate:
// Intl answers from CLDR data, and in places that diverges from ISO — for RSD
// CLDR gives 0 digits (verified in workerd), so a Serbian account's balance
// would land in the database a hundred times too small. Worse, the answer
// depends on the ICU version in a particular browser: splitting an amount into
// minor units is how money sits in D1 forever, and it cannot change along with
// the environment. Only the exceptions are listed; everything else is two digits.
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
// Four-decimal ISO accounting units. They do not occur in everyday use, but
// since the table is called an ISO 4217 table, it must not have holes.
const FOUR_DECIMAL = new Set(['CLF', 'UYW']);

// Active alphabetic codes from ISO 4217 List One published 2026-01-01 and
// maintained by SIX Group. Refresh this snapshot from the source when SIX
// publishes a new List One revision.
// Keep this explicit rather than delegating validation to the runtime's CLDR:
// accepted persisted values must not change with a workerd/ICU upgrade.
// Source: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
export const ISO_4217_CURRENCY_CODES =
  'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAD XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG'.split(' ');
const ISO_4217_CODES = new Set(ISO_4217_CURRENCY_CODES);

export function fractionDigits(currency: unknown): number {
  const code = String(currency ?? '').trim().toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  if (FOUR_DECIMAL.has(code)) return 4;
  return 2;
}

/** Three-letter currency-shaped value in canonical form; does not prove ISO membership. */
export function normalizeCurrencyCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** Canonical ISO 4217 List One code, or `null` for unknown three-letter values. */
export function normalizeIso4217CurrencyCode(raw: unknown): string | null {
  const code = normalizeCurrencyCode(raw);
  return code !== null && ISO_4217_CODES.has(code) ? code : null;
}
