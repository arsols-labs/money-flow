// Pure helpers for the "Spending trend" chart (issue #582): expense and refund
// on one scale, but as different series. The server sends minor units; here only
// minor→major for recharts and a fallback parse of the old `total_minor` without a split.

export const TREND_EXPENSE_COLOR = 'var(--danger)';
export const TREND_REFUND_COLOR = 'var(--safe)';

/**
 * API point → chart fields.
 * `expense_minor` / `refund_minor` are absolute amounts (not net).
 * If there is no split (an old response), a positive net is read as an expense
 * and a negative net as a refund: otherwise a green minus mixes back in with spending.
 */
export function splitTrendPoint(point, digits) {
  const scale = 10 ** digits;
  const totalMinor = Number(point.total_minor ?? 0);
  const hasSplit = point.expense_minor != null || point.refund_minor != null;
  const expenseMinor = hasSplit
    ? Number(point.expense_minor ?? 0)
    : Math.max(totalMinor, 0);
  const refundMinor = hasSplit
    ? Number(point.refund_minor ?? 0)
    : Math.max(-totalMinor, 0);
  return {
    expenseMinor,
    refundMinor,
    totalMinor,
    expenseMajor: expenseMinor / scale,
    refundMajor: refundMinor / scale,
    totalMajor: totalMinor / scale,
  };
}

export function trendHasRefunds(points) {
  return points.some((p) => p.refundMajor > 0);
}
