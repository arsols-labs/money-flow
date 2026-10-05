// Pure client helpers for the "Pulse" screen — kept apart from the components
// so the formulas (especially the warning color and the port from v1) are visible and
// checkable by eye without layout around them.
import { fractionDigits } from './money';

/**
 * Minor units into a number for recharts. Division is acceptable here for the same
 * reason as in money.js:formatMinor — this is ONLY display
 * (the chart, the labels), not storage or recalculation: balances are orders of magnitude below
 * MAX_SAFE_INTEGER, so precision is not lost.
 */
export function toMajor(minor, currency) {
  return minor / 10 ** fractionDigits(currency);
}

/**
 * "YYYY-MM-DD" (the /forecast contract — a calendar date, not an instant) →
 * a Date of the local calendar date, WITHOUT running it through UTC. `new Date("2026-
 * 08-13")` treats the string as UTC midnight; a time zone west of UTC, when
 * converted to local time, shifts the calendar day back by one —
 * "tomorrow" in the payments list becomes "today" (checked with a live
 * run on the stand; tz UTC+2 showed no shift, and the bug is caught only west of
 * UTC — which is why it was invisible on this machine). Parsing by components does not
 * make that shift.
 */
export function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// The "green" threshold — a port of the formula from app/src/ui/Pulse.jsx:21-30, but the threshold
// arrives as a parameter (low_balance_threshold_minor from /forecast), not
// hardcoded as LOWEST_BALANCE_SAFE_USD: a configurable threshold is the
// substance of the 2026-08-04 decision (issue #198).
export function lowestBalanceColor(amountMinor, thresholdMinor) {
  // A zero threshold is a degenerate case of the formula (amount/threshold divides by
  // zero): the warning was zeroed out, and the only signal left is
  // the sign of the amount.
  if (thresholdMinor === 0) return amountMinor >= 0 ? 'var(--safe)' : 'var(--danger)';
  const ratio = Math.max(0, Math.min(1, amountMinor / thresholdMinor));
  if (ratio >= 1) return 'var(--safe)';
  if (ratio >= 0.5) {
    const p = ((ratio - 0.5) / 0.5) * 100;
    return `color-mix(in srgb, var(--safe) ${p}%, var(--warning))`;
  }
  const p = (ratio / 0.5) * 100;
  return `color-mix(in srgb, var(--warning) ${p}%, var(--danger))`;
}

/**
 * Country key on a chart point. The prefix is required: `country` is free text
 * from the account card, and a country named `overall`, `ts`, or `date` would silently
 * overwrite a service field of the point — the overall total on the chart would become a country
 * series, and there would be nothing to notice it by. The `c:` prefix cannot end up in country names
 * because it is added here, not taken from the data.
 */
const COUNTRY_KEY_PREFIX = 'c:';
const ACCOUNT_KEY_PREFIX = 'a:';
const USER_KEY_PREFIX = 'u:';

export const FORECAST_GROUP_MODES = /** @type {const} */ (['country', 'account', 'user']);
export const DEFAULT_FORECAST_GROUP_MODE = 'country';

export function countryKey(country) {
  return COUNTRY_KEY_PREFIX + country;
}

export function accountKey(id) {
  return ACCOUNT_KEY_PREFIX + String(id);
}

export function userKey(owner) {
  return USER_KEY_PREFIX + owner;
}

/**
 * Back from a point key to a country name — for tooltip labels. A separate
 * function, not an in-place `slice(2)`: the prefix length must not live as a magic
 * number in another file. A mistake there would not throw; it would quietly label a money
 * row with the wrong name.
 */
export function countryFromKey(key) {
  return key.startsWith(COUNTRY_KEY_PREFIX) ? key.slice(COUNTRY_KEY_PREFIX.length) : key;
}

export function accountFromKey(key) {
  return key.startsWith(ACCOUNT_KEY_PREFIX) ? key.slice(ACCOUNT_KEY_PREFIX.length) : key;
}

export function userFromKey(key) {
  return key.startsWith(USER_KEY_PREFIX) ? key.slice(USER_KEY_PREFIX.length) : key;
}

/**
 * series (the /api/v2/forecast contract) → recharts points:
 * `{ts, date, overall, ['c:'+country]: value, ['a:'+id]: value, ['u:'+owner]: value}`.
 * Amounts are already in base_currency (the server converted them) — here only minor→major.
 * by_account / by_owner may be missing on an old response — then there are no keys.
 */
export function chartData(series, baseCurrency) {
  return series.map((d) => {
    const point = {
      ts: parseDateOnly(d.date).getTime(),
      date: d.date,
      overall: toMajor(d.overall_minor, baseCurrency),
    };
    for (const [country, minor] of Object.entries(d.by_country || {})) {
      point[countryKey(country)] = toMajor(minor, baseCurrency);
    }
    for (const [id, minor] of Object.entries(d.by_account || {})) {
      point[accountKey(id)] = toMajor(minor, baseCurrency);
    }
    for (const [owner, minor] of Object.entries(d.by_owner || {})) {
      point[userKey(owner)] = toMajor(minor, baseCurrency);
    }
    return point;
  });
}

/**
 * Household members exist for the chart when the API emitted at least two owner series.
 * @param {unknown} owners
 */
export function forecastHasMultiUserSeries(owners) {
  return Array.isArray(owners) && new Set(owners.filter((owner) => typeof owner === 'string' && owner.length > 0)).size >= 2;
}

/**
 * Persisted grouping may be `user` after owners collapse to one person —
 * fall back to country rather than drawing a one-line "household" view.
 * @param {unknown} mode
 * @param {{ owners?: string[], accounts?: Array<{ id: number, name?: string }> }} [meta]
 * @returns {'country' | 'account' | 'user'}
 */
export function resolveForecastGroupMode(mode, { owners = [], accounts = [] } = {}) {
  if (mode === 'account' && Array.isArray(accounts) && accounts.length > 0) return 'account';
  if (mode === 'user' && forecastHasMultiUserSeries(owners)) return 'user';
  return DEFAULT_FORECAST_GROUP_MODE;
}

/**
 * @param {Array<{ id: number, name?: string }>} accounts
 * @param {Array<{ by_account?: Record<string, number> }> | undefined} series
 */
export function accountsWithForecastSeries(accounts, series) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const first = series?.[0]?.by_account;
  if (!first || typeof first !== 'object') return accounts;
  const ids = new Set(Object.keys(first));
  return accounts.filter((account) => ids.has(String(account.id)));
}

/**
 * Visible extra series (Total is always drawn separately).
 * @param {unknown} mode
 * @param {{ countries?: string[], accounts?: Array<{ id: number, name?: string }>, owners?: string[] }} [meta]
 * @returns {Array<{ key: string, label: string, color: string }>}
 */
export function forecastSeriesItems(mode, { countries = [], accounts = [], owners = [] } = {}) {
  const resolved = resolveForecastGroupMode(mode, { owners, accounts });
  if (resolved === 'account') {
    const labels = accounts.map((account) => account.name || String(account.id));
    const colors = countryColors(labels);
    return accounts.map((account, index) => ({
      key: accountKey(account.id),
      label: account.name || String(account.id),
      color: colors[labels[index]],
    }));
  }
  if (resolved === 'user') {
    const colors = countryColors(owners);
    return owners.map((owner) => ({
      key: userKey(owner),
      label: owner,
      color: colors[owner],
    }));
  }
  const colors = countryColors(countries);
  return countries.map((country) => ({
    key: countryKey(country),
    label: country,
    color: colors[country],
  }));
}

/**
 * Y-axis domain. Country mode keeps Recharts auto-scale (current look).
 * When any plotted value is negative, the axis includes that floor and 0
 * so Everyday Card (and similar) can render below $0.
 */
export function forecastYDomain(points, extraKeys = []) {
  if (!Array.isArray(points) || points.length === 0) return ['auto', 'auto'];
  const keys = extraKeys.includes('overall') ? extraKeys : ['overall', ...extraKeys];
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    for (const key of keys) {
      const value = point[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ['auto', 'auto'];
  if (min >= 0) return ['auto', 'auto'];
  const top = Math.max(max, 0);
  const pad = (top - min) * 0.08 || 1;
  return [min - pad, top + pad];
}

// Line palette by country. v1 kept RUS/USA/SRB hardcoded in CSS variables
// (--rus/--usa/--srb) — in v2 country is an arbitrary string (issue #198 removed
// the tie to three countries), so a color is assigned by index from the shared
// palette, while familiar codes keep their usual color so the chart does not
// "move" for anyone already used to the v1 shades.
// `token` goes into SVG (so the shade follows the theme, as in v1); `hex` is the same
// value as a literal, and it is needed not for drawing but so the palette below can
// AVOID these colors: its first three shades are exactly these three, so
// an unfamiliar country at index 0 got exactly the USA color — two lines on
// the chart became indistinguishable. `var(--usa)` cannot be compared with a literal,
// hence the second column. It can drift only together with an edit of the token
// in styles.css, and the worst result then is that an unfamiliar country takes
// a shade that has become free again.
const KNOWN_COUNTRY_COLORS = {
  Global: { token: 'var(--overall)', hex: '#9AA3B5' },
  RUS: { token: 'var(--rus)', hex: '#D98757' },
  USA: { token: 'var(--usa)', hex: '#5B8FC7' },
  SRB: { token: 'var(--srb)', hex: '#6FBF8B' },
};

// A palette readable in both themes (the same principles as --safe/--warning/
// --danger in styles.css: medium saturation, not pure primary colors).
const COUNTRY_PALETTE = [
  '#5B8FC7', // blue
  '#D98757', // orange
  '#6FBF8B', // green
  '#B07FD9', // purple
  '#D9C15B', // yellow
  '#5BC7B4', // teal
  '#D95B8F', // pink
];

/**
 * Line colors for the WHOLE country list at once, not one by one.
 *
 * One by one was impossible: an unfamiliar country's color depends on which colors
 * familiar neighbors have already taken, and a call with one argument does not know that.
 * Returns an object `{ [country]: color }`; the order of the input list sets
 * the order in which colors are handed out, so the color is stable while the set of countries is unchanged.
 */
export function countryColors(countries) {
  const taken = new Set(countries.map((c) => KNOWN_COUNTRY_COLORS[c]?.hex).filter(Boolean));
  const free = COUNTRY_PALETTE.filter((color) => !taken.has(color));
  // All seven shades are taken by familiar countries — theoretically impossible
  // (there are only three familiar ones), but an empty color list would leave a country with no line,
  // while repeating a shade at least shows it.
  const pool = free.length > 0 ? free : COUNTRY_PALETTE;

  const colors = {};
  let next = 0;
  for (const c of countries) {
    colors[c] = KNOWN_COUNTRY_COLORS[c]?.token ?? pool[next++ % pool.length];
  }
  return colors;
}
