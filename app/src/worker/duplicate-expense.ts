import { expenseLooksLikeDuplicate, type ExpenseDuplicateCandidate } from '../shared/booking-guards';
import { addDays } from './forecast/dates';

export const DUPLICATE_EXPENSE_LOOKBACK_DAYS = 14;

export async function findDuplicateExpenseId(
  db: D1Database,
  candidate: ExpenseDuplicateCandidate,
): Promise<number | null> {
  const from = addDays(candidate.date, -DUPLICATE_EXPENSE_LOOKBACK_DAYS);
  const to = addDays(candidate.date, 1);
  const { results } = await db.prepare(
    `SELECT id, date, account_id, store, item, comment, fiscal_receipt_id, receipt_url, amount_minor
     FROM operations
     WHERE kind = 'expense' AND account_id = ? AND date >= ? AND date <= ?`,
  ).bind(candidate.account_id, from, to).all<ExpenseDuplicateCandidate & { id: number }>();
  for (const row of results) {
    if (expenseLooksLikeDuplicate(candidate, row)) return row.id;
  }
  return null;
}
