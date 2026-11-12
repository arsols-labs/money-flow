import {
  canonicalFiscalIdentity,
  fiscalDocumentsAreDistinct,
  normalizeFiscalReceiptId,
  normalizedVerificationUrlsMatch,
} from './fiscal-identity';

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
  /** Present when the caller loaded it. Missing and blank both mean "no URL". */
  receipt_url?: string | null;
}

function normalizeDuplicateText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function sameFiscalReceiptId(
  candidate: ExpenseDuplicateCandidate,
  existing: ExpenseDuplicateCandidate,
): boolean {
  const left = normalizeFiscalReceiptId(candidate.fiscal_receipt_id);
  const right = normalizeFiscalReceiptId(existing.fiscal_receipt_id);
  return Boolean(left && right && left === right);
}

/**
 * Shared Wolt/order token. Ignored when both rows have a canonical fiscal
 * identity and those identities differ. Same-PFR lines use line identity only.
 * A differing receipt URL string is not by itself a different document.
 */
function orderTokenDuplicate(
  candidate: ExpenseDuplicateCandidate,
  existing: ExpenseDuplicateCandidate,
): boolean {
  if (existing.account_id !== candidate.account_id) return false;
  if (sameFiscalReceiptId(candidate, existing)) return false;
  if (fiscalDocumentsAreDistinct(candidate, existing)) return false;
  const candidateTokens = extractExpenseOrderTokens([candidate.item, candidate.comment]);
  const existingTokens = extractExpenseOrderTokens([existing.item, existing.comment]);
  return candidateTokens.some((token) => existingTokens.includes(token));
}

/**
 * Line-level expense identity. A shared `fiscal_receipt_id` (or receipt URL)
 * is not a duplicate by itself — multi-line fiscal receipts reuse the same PFR.
 * A shared order id is not a duplicate only when both fiscal ids differ.
 * Equal normalized verification URLs are one document. A different URL is not.
 */
export function expenseLooksLikeDuplicate(
  candidate: ExpenseDuplicateCandidate,
  existing: ExpenseDuplicateCandidate & { id: number },
): boolean {
  if (existing.account_id !== candidate.account_id) return false;

  if (sameFiscalReceiptId(candidate, existing)) {
    return (
      candidate.date === existing.date
      && candidate.amount_minor === existing.amount_minor
      && normalizeDuplicateText(candidate.item) === normalizeDuplicateText(existing.item)
      && normalizeDuplicateText(candidate.store) === normalizeDuplicateText(existing.store)
    );
  }

  if (orderTokenDuplicate(candidate, existing)) return true;
  if (normalizedVerificationUrlsMatch(candidate, existing)) return true;
  return Boolean(
    candidate.store
    && existing.store
    && candidate.date === existing.date
    && candidate.amount_minor === existing.amount_minor
    && candidate.store.toLowerCase() === existing.store.toLowerCase(),
  );
}

type IndexedExpense = ExpenseDuplicateCandidate & { id: number };

function fiscalKey(row: ExpenseDuplicateCandidate): string | null {
  const fiscalReceiptId = normalizeFiscalReceiptId(row.fiscal_receipt_id);
  if (!fiscalReceiptId) return null;
  return [
    row.account_id,
    fiscalReceiptId,
    row.date,
    row.amount_minor,
    normalizeDuplicateText(row.item),
    normalizeDuplicateText(row.store),
  ].join('\u0001');
}

function identityKey(row: ExpenseDuplicateCandidate): string | null {
  if (!row.store) return null;
  return [row.account_id, row.date, row.amount_minor, row.store.toLowerCase()].join('\u0001');
}

type TokenEntry = { index: number; row: IndexedExpense };

/** Lookup with the same duplicate decision as scanning `expenseLooksLikeDuplicate`. */
export function createExpenseDuplicateIndex(rows: IndexedExpense[] = []): {
  find(candidate: ExpenseDuplicateCandidate): IndexedExpense | undefined;
  add(row: IndexedExpense): void;
} {
  const fiscal = new Map<string, IndexedExpense>();
  const tokens = new Map<string, TokenEntry[]>();
  const verificationUrls = new Map<string, IndexedExpense>();
  const identity = new Map<string, IndexedExpense>();
  let nextIndex = 0;
  const add = (row: IndexedExpense) => {
    const index = nextIndex;
    nextIndex += 1;
    const fiscalId = fiscalKey(row);
    if (fiscalId && !fiscal.has(fiscalId)) fiscal.set(fiscalId, row);
    for (const token of extractExpenseOrderTokens([row.item, row.comment])) {
      const key = `${row.account_id}\u0001${token}`;
      const list = tokens.get(key);
      if (list) list.push({ index, row });
      else tokens.set(key, [{ index, row }]);
    }
    const identityId = identityKey(row);
    if (identityId && !identity.has(identityId)) identity.set(identityId, row);
    const verificationUrl = canonicalFiscalIdentity(row);
    if (verificationUrl?.kind === 'url' && !verificationUrls.has(`${row.account_id}\u0001${verificationUrl.value}`)) {
      verificationUrls.set(`${row.account_id}\u0001${verificationUrl.value}`, row);
    }
  };
  const find = (candidate: ExpenseDuplicateCandidate): IndexedExpense | undefined => {
    const fiscalId = fiscalKey(candidate);
    if (fiscalId) {
      const hit = fiscal.get(fiscalId);
      if (hit) return hit;
    }
    let earliest: TokenEntry | undefined;
    for (const token of extractExpenseOrderTokens([candidate.item, candidate.comment])) {
      const list = tokens.get(`${candidate.account_id}\u0001${token}`);
      if (!list) continue;
      for (const entry of list) {
        if (earliest && entry.index >= earliest.index) break;
        if (orderTokenDuplicate(candidate, entry.row)) {
          earliest = entry;
          break;
        }
      }
    }
    if (earliest) return earliest.row;
    const verificationUrl = canonicalFiscalIdentity(candidate);
    if (verificationUrl?.kind === 'url') {
      const hit = verificationUrls.get(`${candidate.account_id}\u0001${verificationUrl.value}`);
      if (hit) return hit;
    }
    const identityId = identityKey(candidate);
    return identityId ? identity.get(identityId) : undefined;
  };
  for (const row of rows) add(row);
  return { find, add };
}
