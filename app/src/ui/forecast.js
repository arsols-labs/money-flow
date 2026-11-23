// Pure client helpers for the "Pulse" screen — kept apart from the components
// so the formulas (especially the warning color and the port from v1) are visible and
// checkable by eye without layout around them.
import { tryFractionDigits } from './money';

/**
 * Minor units into a number for recharts.
 * Returns null when the currency's minor-unit scale is not yet configured.
 * @param {number} minor
 * @param {string} currency
 * @param {number | null} [digits]
 * @returns {number | null}
 */
export function toMajor(minor, currency, digits = tryFractionDigits(currency)) {
  if (digits === null) return null;
  return minor / 10 ** digits;
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
// substance of the 2026-08-04 decision.
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
 * @param {any[]} series
 * @param {string} baseCurrency
 * @returns {Array<Record<string, any>>}
 */
export function chartData(series, baseCurrency) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const digits = tryFractionDigits(baseCurrency);
  if (digits === null) return [];
  return series.map((d) => {
    /** @type {Record<string, any>} */
    const point = {
      ts: parseDateOnly(d.date).getTime(),
      date: d.date,
      overall: toMajor(d.overall_minor, baseCurrency, digits),
    };
    for (const [country, minor] of Object.entries(d.by_country || {})) {
      point[countryKey(country)] = toMajor(minor, baseCurrency, digits);
    }
    for (const [id, minor] of Object.entries(d.by_account || {})) {
      point[accountKey(id)] = toMajor(minor, baseCurrency, digits);
    }
    for (const [owner, minor] of Object.entries(d.by_owner || {})) {
      point[userKey(owner)] = toMajor(minor, baseCurrency, digits);
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

// Line palette assigned dynamically by country order (no hardcoded country names).
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
 */
export function countryColors(countries) {
  const colors = {};
  let next = 0;
  for (const c of countries) {
    colors[c] = COUNTRY_PALETTE[next++ % COUNTRY_PALETTE.length];
  }
  return colors;
}
