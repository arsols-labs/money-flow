/** Serbian TaxCore / PURS PFR numbers and similar fiscal document ids. */
export const FISCAL_RECEIPT_ID_MAX_LENGTH = 128;

export type FiscalReceiptGrouping = 'fiscal_id' | 'single_op';

export interface FiscalReceiptLine {
  id: number;
  item: string;
  category: string | null;
  subcategory: string | null;
  amount_minor: number;
  kind: string;
  comment: string | null;
  receipt_url: string | null;
}

export interface FiscalReceiptGroup {
  id: string;
  grouping: FiscalReceiptGrouping;
  fiscal_receipt_id: string | null;
  date: string;
  store: string | null;
  account_id: number;
  account_name: string;
  account_currency: string;
  receipt_url: string | null;
  total_minor: number;
  positions_count: number;
  lines: FiscalReceiptLine[];
}

export interface FiscalReceiptOperation {
  id: number;
  date: string;
  account_id: number;
  kind: string;
  store: string | null;
  item: string;
  category: string | null;
  subcategory: string | null;
  amount_minor: number;
  comment: string | null;
  receipt_url: string | null;
  fiscal_receipt_id: string | null;
  account_name?: string | null;
  currency?: string | null;
}

/**
 * Trimmed fiscal id or null. Empty after trim is null.
 * Does not invent a PFR and does not validate a country-specific format.
 */
export function trimFiscalReceiptId(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isTransferKind(kind: string): boolean {
  return kind === 'transfer_out' || kind === 'transfer_in';
}

function lineFromOp(op: FiscalReceiptOperation): FiscalReceiptLine {
  return {
    id: op.id,
    item: op.item,
    category: op.category,
    subcategory: op.subcategory,
    amount_minor: op.amount_minor,
    kind: op.kind,
    comment: op.comment,
    receipt_url: op.receipt_url,
  };
}

function accountNameOf(op: FiscalReceiptOperation): string {
  return (op.account_name ?? '').trim();
}

function currencyOf(op: FiscalReceiptOperation): string {
  return (op.currency ?? '').trim();
}

function firstReceiptUrl(lines: FiscalReceiptLine[]): string | null {
  for (const line of lines) {
    if (line.receipt_url) return line.receipt_url;
  }
  return null;
}

function compareGroups(a: FiscalReceiptGroup, b: FiscalReceiptGroup): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.grouping !== b.grouping) return a.grouping === 'fiscal_id' ? -1 : 1;
  const aKey = a.fiscal_receipt_id ?? a.id;
  const bKey = b.fiscal_receipt_id ?? b.id;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function buildGroup(params: {
  id: string;
  grouping: FiscalReceiptGrouping;
  fiscal_receipt_id: string | null;
  ops: FiscalReceiptOperation[];
}): FiscalReceiptGroup {
  const sorted = [...params.ops].sort((a, b) => a.id - b.id);
  const first = sorted[0]!;
  const lines = sorted.map(lineFromOp);
  return {
    id: params.id,
    grouping: params.grouping,
    fiscal_receipt_id: params.fiscal_receipt_id,
    date: first.date,
    store: first.store,
    account_id: first.account_id,
    account_name: accountNameOf(first),
    account_currency: currencyOf(first),
    receipt_url: firstReceiptUrl(lines),
    total_minor: sorted.reduce((sum, op) => sum + op.amount_minor, 0),
    positions_count: sorted.length,
    lines,
  };
}

/**
 * Group operations into fiscal-document cards for Data → Чеки.
 *
 * Primary key is a stored `fiscal_receipt_id` (PFR). Fallback without PFR is
 * one card per operation, and only when `receipt_url` is present — a weaker
 * "document without PFR" bucket. Operations with neither stay out. Transfers
 * stay out. No fake PFR is invented. Store+date+account rollup is Analytics
 * visit grouping and is intentionally not used here.
 */
export function groupFiscalReceipts(operations: FiscalReceiptOperation[]): FiscalReceiptGroup[] {
  const byFiscal = new Map<string, FiscalReceiptOperation[]>();
  const fallbacks: FiscalReceiptOperation[] = [];

  for (const op of operations) {
    if (isTransferKind(op.kind)) continue;
    const fiscalId = trimFiscalReceiptId(op.fiscal_receipt_id);
    if (fiscalId) {
      const bucket = byFiscal.get(fiscalId);
      if (bucket) bucket.push(op);
      else byFiscal.set(fiscalId, [op]);
      continue;
    }
    if (typeof op.receipt_url === 'string' && op.receipt_url.trim().length > 0) {
      fallbacks.push(op);
    }
  }

  const groups: FiscalReceiptGroup[] = [];
  for (const [fiscalId, ops] of byFiscal) {
    groups.push(buildGroup({
      id: `pfr:${fiscalId}`,
      grouping: 'fiscal_id',
      fiscal_receipt_id: fiscalId,
      ops,
    }));
  }
  for (const op of fallbacks) {
    groups.push(buildGroup({
      id: `op:${op.id}`,
      grouping: 'single_op',
      fiscal_receipt_id: null,
      ops: [op],
    }));
  }

  groups.sort(compareGroups);
  return groups;
}

export function fiscalReceiptMatchesQuery(
  group: FiscalReceiptGroup,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    group.fiscal_receipt_id,
    group.store,
    group.account_name,
    group.receipt_url,
    ...group.lines.map((line) => [line.item, line.category, line.subcategory, line.comment].filter(Boolean).join(' ')),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}
