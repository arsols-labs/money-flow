import { expenseLooksLikeDuplicate, type ExpenseDuplicateCandidate } from '../shared/booking-guards';
import { addDays } from './forecast/dates';
import { loadBookingGuardRules } from './rules-store';

export const DUPLICATE_EXPENSE_LOOKBACK_DAYS = 14;

export async function findDuplicateExpenseId(
  db: D1Database,
  candidate: ExpenseDuplicateCandidate,
  country?: string | null,
): Promise<number | null> {
  const from = addDays(candidate.date, -DUPLICATE_EXPENSE_LOOKBACK_DAYS);
  const to = addDays(candidate.date, 1);
  const [{ results }, rules] = await Promise.all([
    db.prepare(
      `SELECT id, date, account_id, store, item, comment, fiscal_receipt_id, receipt_url, amount_minor
       FROM operations
       WHERE kind = 'expense' AND account_id = ? AND date >= ? AND date <= ?`,
    ).bind(candidate.account_id, from, to).all<ExpenseDuplicateCandidate & { id: number }>(),
    loadBookingGuardRules(db, { country: country ?? null }),
  ]);
  for (const row of results) {
    if (expenseLooksLikeDuplicate(candidate, row, rules)) return row.id;
  }
  return null;
}
