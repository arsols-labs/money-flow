/** Production analytical daily rules that must never post or link a ledger fact. */
export const ANALYTICAL_SKIP_ONLY_RECURRING_IDS = [16, 17] as const;

export function isAnalyticalSkipOnlyRecurringId(id: number): boolean {
  return id === 16 || id === 17;
}

const ORDER_HINT =
  /(?:wolt|order|заказ|ord)[-_#:\s]*([a-z0-9][a-z0-9-]{5,})/gi;

export function extractExpenseOrderTokens(
  parts: Array<string | null | undefined>,
): string[] {
  const tokens = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const text = part.trim();
    if (!text) continue;
    for (const match of text.matchAll(ORDER_HINT)) {
      tokens.add(match[1]!.toLowerCase());
    }
  }
  return [...tokens];
}

export interface ExpenseDuplicateCandidate {
  date: string;
  account_id: number;
  store: string | null;
  amount_minor: number;
  item: string;
  comment: string | null;
  fiscal_receipt_id: string | null;
}

function normalizeDuplicateText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Line-level expense identity. A shared `fiscal_receipt_id` (or receipt URL)
 * is not a duplicate by itself — multi-line fiscal receipts reuse the same PFR.
 */
export function expenseLooksLikeDuplicate(
  candidate: ExpenseDuplicateCandidate,
  existing: ExpenseDuplicateCandidate & { id: number },
): boolean {
  if (existing.account_id !== candidate.account_id) return false;

  const sameFiscalReceipt = Boolean(
    candidate.fiscal_receipt_id
    && existing.fiscal_receipt_id
    && candidate.fiscal_receipt_id === existing.fiscal_receipt_id,
  );
  if (sameFiscalReceipt) {
    return (
      candidate.date === existing.date
      && candidate.amount_minor === existing.amount_minor
      && normalizeDuplicateText(candidate.item) === normalizeDuplicateText(existing.item)
      && normalizeDuplicateText(candidate.store) === normalizeDuplicateText(existing.store)
    );
  }

  const candidateTokens = extractExpenseOrderTokens([
    candidate.item,
    candidate.comment,
  ]);
  const existingTokens = extractExpenseOrderTokens([
    existing.item,
    existing.comment,
  ]);
  if (candidateTokens.some((token) => existingTokens.includes(token))) return true;
  return Boolean(
    candidate.store
    && existing.store
    && candidate.date === existing.date
    && candidate.amount_minor === existing.amount_minor
    && candidate.store.toLowerCase() === existing.store.toLowerCase(),
  );
}
