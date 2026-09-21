// Чистые помощники графика «Динамика трат» (issue #582): расход и возврат
// на одной шкале, но разными рядами. Сервер отдаёт минорные; здесь только
// minor→major для recharts и запасной разбор старого `total_minor` без сплита.

export const TREND_EXPENSE_COLOR = 'var(--danger)';
export const TREND_REFUND_COLOR = 'var(--safe)';

/**
 * Точка API → поля графика.
 * `expense_minor` / `refund_minor` — абсолютные суммы (не нетто).
 * Если сплита нет (старый ответ), положительный нетто читаем как расход,
 * отрицательный — как возврат: иначе зелёный минус снова смешается с тратой.
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
