import { moneyScaleColor } from './palette';
import { addDays, diffDays } from '../worker/forecast/dates';
import i18n from './i18n';
import { intlLocale } from './language';

/** ISO calendar dates are compared without local timezone or DST conversion. */
export function selectPayments(items, asOf, range, type) {
  const limit = addDays(asOf, range === 'week' ? 6 : 29);
  return items.filter((item) => item.date <= limit
    && (type !== 'income' || item.amount_minor >= 0)
    && (type !== 'expense' || item.amount_minor < 0));
}

export function paymentDateLabel(item, asOf) {
  const date = new Date(`${item.date}T00:00:00Z`);
  const options = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (item.date.slice(0, 4) !== asOf.slice(0, 4)) options.year = 'numeric';
  const label = date.toLocaleDateString(intlLocale(i18n.resolvedLanguage || i18n.language), options);
  if (item.date < asOf) return item.occurrence_count > 1 ? i18n.t('date.since', { date: label }) : label;
  if (item.date === asOf) return i18n.t('date.today');
  if (item.date === addDays(asOf, 1)) return i18n.t('date.tomorrow');
  return label;
}

/** Retry stale days at most once a minute, including small device clock skew. */
export function paymentRefreshDue(asOf, lastRequestedAt, now = Date.now()) {
  return asOf !== new Date(now).toISOString().slice(0, 10)
    && (lastRequestedAt === null || now - lastRequestedAt >= 60_000);
}

export const PAYMENT_FUTURE_HORIZON_DAYS = 30;
export const PAYMENT_OVERDUE_HORIZON_DAYS = 14;

/** Normalize once over the full schedule; missing FX stays in its own currency. */
export function paymentColors(items) {
  const basis = (item) => Number.isFinite(item.amount_base_minor)
    ? { group: 'base', amount: item.amount_base_minor }
    : { group: `native:${item.currency}`, amount: item.amount_minor };
  const maxima = new Map();
  for (const item of items) {
    const { group, amount } = basis(item);
    maxima.set(group, Math.max(maxima.get(group) || 0, Math.abs(amount)));
  }
  return new Map(items.map((item) => {
    const { group, amount } = basis(item);
    const maximum = maxima.get(group);
    const share = maximum ? Math.min(1, Math.max(0, Math.abs(amount) / maximum)) : 0;
    // Income spans [0.60, 1.00] (safe green); expense spans [0.40, 0.00] (danger red).
    // Native nonzero amounts preserve direction even if FX equivalent rounds to zero.
    let ratio = 0.5;
    if (item.amount_minor > 0) {
      ratio = 0.60 + 0.40 * Math.sqrt(share);
    } else if (item.amount_minor < 0) {
      ratio = 0.40 - 0.40 * Math.sqrt(share);
    }
    return [item, moneyScaleColor(ratio)];
  }));
}

/** Continuous timeline scale: today is warning (0.5), future transitions to safe (1.0), overdue to danger (0.0). */
export function paymentDateColor(date, asOf) {
  const days = diffDays(asOf, date);
  if (days === 0) return moneyScaleColor(0.5);
  if (days > 0) {
    const share = Math.min(1, Math.max(0, days / PAYMENT_FUTURE_HORIZON_DAYS));
    return moneyScaleColor(0.5 + 0.5 * Math.sqrt(share));
  }
  const overdueShare = Math.min(1, Math.max(0, Math.abs(days) / PAYMENT_OVERDUE_HORIZON_DAYS));
  return moneyScaleColor(0.5 - 0.5 * Math.sqrt(overdueShare));
}
