// Money and date handling for the "Data" UI.
// Parsing user input is done with string operations, without multiplying by
// 100: `19.99 * 100 === 1998.9999999999998` — the classic float bug, which is
// why this is written this way.

// The ISO 4217 minor-unit scale is also needed by the worker (the forecast engine,
// issue #198) — the single source is src/shared/currency.ts, and this file only
// re-exports it: other UI modules and test/money.test.ts use the public fractionDigits
// export from this module, so it must not be broken. The comment with
// the rationale for the table (rather than Intl) lives there; we do not keep a second copy.
import { fractionDigits } from '../shared/currency';
import i18n from './i18n';
import { intlLocale } from './language';
export { fractionDigits };

function currentIntlLocale() {
  return intlLocale(i18n.resolvedLanguage || i18n.language);
}

// Genitive case — the form for "10 August". Exported because
// recurrence.js uses the same list: a second copy of the month names in the same
// catalog would drift from this one on the first edit.
export const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Thousands-separator spaces a user may paste in.
const SPACE_CHARS = /[\s  ]/g;

/**
 * A user string ("19,99", " 1 200.5 ") into integer minor units.
 * No `parseFloat(...) * 100`: the digits are collected as a string and parsed
 * whole, so binary-arithmetic error is avoided.
 */
export function parseAmountToMinor(input, currency) {
  const digits = fractionDigits(currency);
  let s = String(input ?? '').trim().replace(SPACE_CHARS, '').replace(',', '.');

  if (s === '') throw new Error(i18n.t('validation.enterAmount'));
  if (!/^-?\d*(\.\d*)?$/.test(s)) throw new Error(i18n.t('validation.invalidAmount'));

  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  if (s === '' || s === '.') throw new Error(i18n.t('validation.invalidAmount'));

  const [rawInt, rawFrac = ''] = s.split('.');
  if (rawFrac.length > digits) {
    throw new Error(i18n.t('validation.maxDecimalPlaces', { digits }));
  }

  const intPart = rawInt === '' ? '0' : rawInt;
  const fracPart = rawFrac.padEnd(digits, '0');
  const digitsOnly = (intPart + fracPart).replace(/^0+(?=\d)/, '');
  const minor = parseInt(digitsOnly || '0', 10);

  // Specifically isSafeInteger, not isFinite: parseInt on a twenty-digit string
  // returns a finite but already imprecise number — the amount would silently drift even before
  // it was sent to the server. A clear rejection here is better than a 400 with a technical
  // message from there.
  if (!Number.isSafeInteger(minor)) throw new Error(i18n.t('validation.amountTooLarge'));
  return negative && minor !== 0 ? -minor : minor;
}

/** The reverse conversion for an input field — also done with string operations. */
export function minorToInputString(minor, currency) {
  const digits = fractionDigits(currency);
  const negative = minor < 0;
  const absStr = String(Math.abs(minor)).padStart(digits + 1, '0');
  if (digits === 0) return (negative ? '-' : '') + absStr;
  const cut = absStr.length - digits;
  const intPart = absStr.slice(0, cut) || '0';
  const fracPart = absStr.slice(cut);
  return (negative ? '-' : '') + intPart + '.' + fracPart;
}

/**
 * Division is acceptable for display (see the spec) — balances are orders of magnitude below
 * MAX_SAFE_INTEGER, so precision is not lost here.
 */
export function formatMinor(minor, currency) {
  return formatMajor(minor / 10 ** fractionDigits(currency), currency);
}

/**
 * Major units (already after minor→major) into a grouped currency string.
 * Separate from formatMinor: charts hand recharts major numbers already, and
 * dividing by 10**digits again would shift the axis into thousandths.
 *
 * `compact: true` — no fractional part (axis ticks, a short min marker).
 * Thousands grouping must not be stripped here with a `[.,]\d+` regex: in en-US
 * `$17,521.60`.replace(/[.,]\d+/, '') yields `$17.60` (issue #582).
 */
export function formatMajor(value, currency, locale = currentIntlLocale(), options = {}) {
  const currencyDigits = fractionDigits(currency);
  const digits = options.compact ? 0 : currencyDigits;
  const numeric = Number(value);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: true,
    }).format(numeric);
  } catch {
    return `${numeric.toFixed(digits)} ${currency}`;
  }
}

/** Compact axis / min-marker label: grouping is kept, cents are not. */
export function formatMajorCompact(value, currency, locale = currentIntlLocale()) {
  return formatMajor(value, currency, locale, { compact: true });
}

/**
 * A currency rate is a track separate from account amounts: up to 9 digits after the point,
 * with no zero and no minus. It must not be run through parseAmountToMinor — there the fraction
 * is padded with zeros to the currency's digits (usually 2), which does not fit a rate.
 */
export function normalizeRateInput(input) {
  const s = String(input ?? '').trim().replace(SPACE_CHARS, '').replace(',', '.');
  if (s === '') throw new Error(i18n.t('validation.enterRate'));
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(i18n.t('validation.invalidRate'));
  }
  const [, frac = ''] = s.split('.');
  if (frac.length > 9) throw new Error(i18n.t('validation.rateMaxDecimals'));
  // The zero check is a string check, not Number(): in a module whose whole point
  // is to refuse floats, there is no reason to turn a rate into a double even for a comparison.
  if (/^0+(\.0+)?$/.test(s)) throw new Error(i18n.t('validation.rateZero'));
  return s;
}

/**
 * Russian numeral declension: `plural(1, one, few, many)`.
 * Generalized from the private pluralDays when Pulse needed a second form
 * ("1 operation" / "2 operations" / "8 operations"): the rule itself is one per language, and
 * there should not be a second copy of it nearby.
 */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function pluralDays(n) {
  return i18n.t('plural.day', { count: n });
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Age of a rate after which it counts as stale.
 *
 * Lives here, not in the screens: the rates footer and the "Data" screen show one and
 * the same mark, and different thresholds in them would mean the same rate is
 * fresh and stale at once.
 */
export const STALE_RATE_DAYS = 30;

/** How many days have passed since `iso` — used for the "rate is stale" mark. */
export function daysSince(iso) {
  if (!iso) return Infinity;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Infinity;
  return Math.floor((Date.now() - startOfDay(date).getTime()) / 86400000);
}

/** "today" / "yesterday" / "3 days ago" / "10 August" / "10 August 2024". */
export function formatRelativeDate(iso) {
  if (!iso) return i18n.t('date.noData');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return i18n.t('date.noData');

  const now = new Date();
  const diffDays = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000);

  if (diffDays === 0) return i18n.t('date.today');
  if (diffDays === 1) return i18n.t('date.yesterday');
  if (diffDays > 1 && diffDays < 30) {
    return i18n.t('date.daysAgo', { count: diffDays, unit: pluralDays(diffDays) });
  }

  const locale = currentIntlLocale();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    ...(includeYear ? { year: 'numeric' } : {}),
  });
}
