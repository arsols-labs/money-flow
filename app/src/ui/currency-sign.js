// Currency sign and flag for buttons and lists.
//
// The base-currency button in the header is the tightest UI element: there is room
// for exactly one glyph. So it shows the currency sign ($ € ₽ ₾ ฿), and the three-letter
// code appears in the open list, where the country flag fits beside it.
//
// There is no sign table in the repository on purpose: it would have to be maintained by hand and would
// drift from reality at the first new currency. The sign comes from ICU
// (`Intl.NumberFormat` + `currencyDisplay: 'narrowSymbol'`) — the same library
// that already formats amounts in money.js.

/** ISO 4217 placeholder sign — "currency in general", when the code has no sign of its own. */
export const GENERIC_CURRENCY_SIGN = '¤';

/** Placeholder flag for supranational and non-cash codes (XAU, XDR). */
export const GENERIC_CURRENCY_FLAG = '🌐';

function normalize(code) {
  return String(code ?? '').trim().toUpperCase();
}

/**
 * A currency sign in one or two glyphs: `USD → $`, `RUB → ₽`, `PLN → zł`.
 *
 * ICU returns the code itself (`RSD → "RSD"`) when the currency has no sign
 * of its own — that is the sign that "no sign exists", not a short label:
 * a three-letter code will not fit on a one-glyph-wide button and will merge with
 * the neighboring button. In that case `¤` is returned, and which currency
 * is selected is visible in the open list and in the button's screen-reader label.
 *
 * Two glyphs (`zł`, `kr`) are allowed: they are real currency signs, just
 * compound ones, and dropping them for the sake of exactly one character would show `¤` where
 * a sign exists.
 */
export function currencySymbol(code) {
  const c = normalize(code);
  if (!/^[A-Z]{3}$/.test(c)) return GENERIC_CURRENCY_SIGN;
  let symbol = '';
  try {
    const parts = new Intl.NumberFormat('en', {
      style: 'currency', currency: c, currencyDisplay: 'narrowSymbol',
    }).formatToParts(0);
    symbol = parts.find((p) => p.type === 'currency')?.value ?? '';
  } catch {
    return GENERIC_CURRENCY_SIGN;
  }
  if (!symbol || symbol === c) return GENERIC_CURRENCY_SIGN;
  return [...symbol].length <= 2 ? symbol : GENERIC_CURRENCY_SIGN;
}

/**
 * Flag of the currency's country: `USD → 🇺🇸`, `RSD → 🇷🇸`, `EUR → 🇪🇺`.
 *
 * The first two letters of an ISO 4217 code are the ISO 3166-1 alpha-2 country code; the
 * currency numbering itself is built on that same convention. There are exactly two exceptions:
 * the euro (`EU` is not a country, but it has a flag) and codes starting with `X`, which have no country
 * by definition (`XAU` is gold, `XDR` is the IMF unit of account).
 *
 * The flag is built from regional indicators, not taken from a table: there are
 * two hundred-plus "code → emoji" pairs, and any copy of them in the repository would go stale.
 */
export function currencyFlag(code) {
  const c = normalize(code);
  if (!/^[A-Z]{3}$/.test(c) || c.startsWith('X')) return GENERIC_CURRENCY_FLAG;
  const region = c === 'EUR' ? 'EU' : c.slice(0, 2);
  return [...region]
    .map((ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65))
    .join('');
}
