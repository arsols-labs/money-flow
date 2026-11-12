// Manual receipt groups. Read-only projection: no ledger writes.
// A group is a purchase order with kind "manual". Membership is metadata.

import { normalizeIso4217CurrencyCode } from './currency';
import { canonicalizePfr, groupFiscalReceipts, fiscalReceiptMatchesQuery, type FiscalReceiptGroup, type FiscalReceiptOperation } from './fiscal-receipts';
import { minorBigIntToNumber } from './money';
import { makeConverter } from '../worker/forecast/convert';

export const RECEIPT_GROUP_KIND = 'manual' as const;
export const RECEIPT_KEY_MAX = 100;

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OP_KEY_RE = /^op:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CALENDAR_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/;
const DELIVERY_SERVICE_RE = /^(?:wolt(?!\s+market\b)|glovo|mister\s*d|donesi|uber\s*eats|bolt\s*food|deliveroo|doordash|grubhub|instacart|yandex\s*(?:eats|delivery)|яндекс[\s.]*(?:еда|доставка)|delivery\s*club|деливери(?:\s*клаб)?|delivery|доставка|dostava|courier|курьер|kurir)(?:\b|[\s.,\-()/]|$)/iu;
const VENUE_STATION_SUFFIX_RE = /(?:[\s,./:–—\-]+|\s*\()(?:kitchen|bar|kuhinja|šank|sank|kuhinja\s*i\s*bar|кухня|бар|зал|food|drinks|храна|пиће|hrana|piće|pice)\)?$/iu;

export type ReceiptResolution = 'resolved' | 'epoch_changed' | 'missing' | 'ambiguous';

export interface ReceiptIdentityOperation extends FiscalReceiptOperation {
  receipt_identity_token?: string | null;
}

export interface ReceiptGroupMemberView {
  receipt_key: string;
  resolution: ReceiptResolution;
  operation_ids: number[];
  fiscal_receipt_id: string | null;
  date?: string | null;
  store?: string | null;
  currency: string | null;
  posted_minor: number | null;
  base_minor: number | null;
}

export interface ReceiptGroupSubtotal {
  currency: string | null;
  posted_minor: number;
  document_minor: null;
  document_known: false;
}

export interface ReceiptGroup {
  id: number;
  kind: 'manual';
  name: string | null;
  place: string | null;
  date: string | null;
  number: number;
  receipts: ReceiptGroupMemberView[];
  subtotals: ReceiptGroupSubtotal[];
  base_currency: string;
  total_minor: number | null;
  total_currency: string | null;
  missing_rates: string[];
  incomplete: boolean;
  multi_currency: boolean;
}

export interface ReceiptGroupFx {
  ratesE9?: ReadonlyMap<string, number>;
  baseCurrency?: string;
}

export interface ManualGroupRow {
  id: number;
  display_name: string | null;
  order_date?: string | null;
  created_at?: string | null;
}

export interface MembershipClaim {
  order_id: number;
  receipt_key: string;
  ledger_epoch: string;
}

/** Extracts a valid YYYY-MM-DD calendar date from a date or timestamp string. */
export function receiptCalendarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = CALENDAR_DATE_PREFIX_RE.exec(value.trim());
  if (!match) return null;
  const iso = match[1]!;
  const [year, month, day] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    dt.getUTCFullYear() !== year
    || dt.getUTCMonth() !== month! - 1
    || dt.getUTCDate() !== day
    || year! < 1
  ) {
    return null;
  }
  return iso;
}

function normalizeStoreText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** True when a store label names a delivery intermediary rather than the merchant where goods were bought. */
export function isDeliveryServiceStore(value: unknown): boolean {
  const normalized = normalizeStoreText(value);
  if (!normalized) return false;
  return DELIVERY_SERVICE_RE.test(normalized);
}

function stripVenueStationSuffix(store: string): string {
  const stripped = store.replace(VENUE_STATION_SUFFIX_RE, '').trim();
  return stripped.length >= 2 ? stripped : store;
}

/**
 * Resolves the place where the goods were bought for a manual receipt group.
 * - An explicit user-typed name always wins.
 * - Otherwise, every receipt must have a store; delivery-service stores (e.g. Wolt) are ignored
 *   when paired with the merchant where the goods were bought (e.g. a pharmacy), and a venue's
 *   kitchen and bar receipts resolve to the shared restaurant name.
 * - Returns null when the place cannot be determined without guessing.
 */
export function resolveReceiptGroupPlace(
  cards: ReadonlyArray<{ store?: string | null }>,
  explicitName?: string | null,
): string | null {
  const typed = normalizeStoreText(explicitName);
  if (typed.length > 0) return typed;
  if (cards.length === 0) return null;
  const stores = cards.map((card) => normalizeStoreText(card.store));
  if (stores.some((store) => store.length === 0)) return null;
  const merchantStores = stores.filter((store) => !isDeliveryServiceStore(store));
  if (merchantStores.length === 0) return null;
  const firstExact = merchantStores[0]!;
  if (merchantStores.every((store) => store.toLowerCase() === firstExact.toLowerCase())) {
    return firstExact;
  }
  const baseStores = merchantStores.map(stripVenueStationSuffix);
  const firstBase = baseStores[0]!;
  if (
    firstBase.length > 0
    && baseStores.every((store) => store.toLowerCase() === firstBase.toLowerCase())
  ) {
    return firstBase;
  }
  return null;
}

/**
 * Title saved by a rename.
 * A typed name is stored as given. An empty name stores nothing and the
 * caller shows the place resolved from the receipts. Null means that place
 * cannot be resolved, so the empty name must be refused and nothing saved.
 */
export function receiptGroupRenameTarget(
  cards: ReadonlyArray<{ store?: string | null }>,
  explicitName: string | null,
): { displayName: string | null; place: string } | null {
  const place = resolveReceiptGroupPlace(cards, explicitName);
  if (!place) return null;
  const typed = typeof explicitName === 'string' && explicitName.trim().length > 0;
  return { displayName: typed ? place : null, place };
}

/**
 * Resolves the display and sort calendar date for a manual group.
 * Uses the latest member calendar date (preserving older groups whose members span dates),
 * falling back to the stored order_date/created_at when no member cards resolve.
 */
export function resolveReceiptGroupDate(
  cards: ReadonlyArray<{ date?: string | null }>,
  fallbackDate?: string | null,
): string | null {
  const dates: string[] = [];
  for (const card of cards) {
    const cal = receiptCalendarDate(card.date);
    if (cal) dates.push(cal);
  }
  if (dates.length > 0) {
    dates.sort();
    return dates[dates.length - 1]!;
  }
  return receiptCalendarDate(fallbackDate);
}

/** Checks whether all candidate receipts for a new group share the same calendar date. */
export function areReceiptsSameCalendarDate(
  cards: ReadonlyArray<{ date?: string | null; lines?: ReadonlyArray<{ date?: string | null }> }>,
): { ok: boolean; date: string | null } {
  if (cards.length === 0) return { ok: false, date: null };
  const dates = new Set<string>();
  for (const card of cards) {
    const cal = receiptCalendarDate(card.date);
    if (!cal) return { ok: false, date: null };
    dates.add(cal);
    for (const line of card.lines ?? []) {
      if (line.date !== undefined && line.date !== null) {
        const lineCal = receiptCalendarDate(line.date);
        if (!lineCal) return { ok: false, date: null };
        dates.add(lineCal);
      }
    }
  }
  if (dates.size !== 1) return { ok: false, date: null };
  return { ok: true, date: [...dates][0]! };
}

export type DatedReceiptFeedEntry<TGroup, TReceipt> =
  | { kind: 'group'; date: string; id: string; value: TGroup }
  | { kind: 'receipt'; date: string; id: string; value: TReceipt };

export function compareReceiptFeedItems(
  a: { kind: 'group' | 'receipt'; date: string; id: string },
  b: { kind: 'group' | 'receipt'; date: string; id: string },
): number {
  const aCal = receiptCalendarDate(a.date) ?? a.date;
  const bCal = receiptCalendarDate(b.date) ?? b.date;
  if (aCal !== bCal) return aCal < bCal ? 1 : -1;
  if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildDatedReceiptFeed<
  TGroup extends { group: { id: number; date?: string | null; order_date?: string | null }; nested: ReadonlyArray<{ date?: string | null }> },
  TReceipt extends { id: string; date: string },
>(
  manualGroups: ReadonlyArray<TGroup>,
  ungroupedReceipts: ReadonlyArray<TReceipt>,
): Array<DatedReceiptFeedEntry<TGroup, TReceipt>> {
  const items: Array<DatedReceiptFeedEntry<TGroup, TReceipt>> = [
    ...manualGroups.map((item) => ({
      kind: 'group' as const,
      date: item.group.date || resolveReceiptGroupDate(item.nested, item.group.order_date ?? null) || '',
      id: `manual-${item.group.id}`,
      value: item,
    })),
    ...ungroupedReceipts.map((receipt) => ({
      kind: 'receipt' as const,
      date: receiptCalendarDate(receipt.date) ?? receipt.date ?? '',
      id: receipt.id,
      value: receipt,
    })),
  ];
  items.sort(compareReceiptFeedItems);
  return items;
}

export interface DatedReceiptLine {
  id: number;
  amount_minor: number;
  converted_minor: number | null;
}

/** A receipt card that can be nested under a manual group. Extra fields are kept. */
export interface DatedReceiptCard {
  id: string;
  date: string;
  lines: readonly DatedReceiptLine[];
  receipt_total_minor: number;
  receipt_total_base_minor: number;
  positions_count: number;
}

export interface NestedManualGroup<TReceipt> {
  group: ReceiptGroup;
  nested: TReceipt[];
}

function withReceiptLines<T extends DatedReceiptCard>(
  receipt: T,
  lines: readonly DatedReceiptLine[],
  id: string,
): T {
  let minor = 0;
  let base = 0;
  for (const line of lines) {
    minor += Math.abs(line.amount_minor);
    if (typeof line.converted_minor === 'number') base += line.converted_minor;
  }
  return {
    ...receipt,
    id,
    lines,
    receipt_total_minor: minor,
    receipt_total_base_minor: base,
    positions_count: lines.length,
  };
}

/**
 * Places manual groups into a date-sorted receipt list.
 * A line that belongs to a group is shown only inside that group.
 * Receipts with no grouped lines stay loose. Sort matches Data.
 * This does not recompute analytics totals.
 */
export function nestManualGroupsInReceiptList<T extends DatedReceiptCard>(
  receipts: readonly T[],
  groups: readonly ReceiptGroup[],
): Array<DatedReceiptFeedEntry<NestedManualGroup<T>, T>> {
  const owner = new Map<number, number>();
  for (const group of [...groups].sort((a, b) => a.id - b.id)) {
    for (const member of group.receipts) {
      if (member.resolution !== 'resolved') continue;
      for (const opId of member.operation_ids) {
        if (!owner.has(opId)) owner.set(opId, group.id);
      }
    }
  }
  const nestedByGroup = new Map<number, T[]>();
  const loose: T[] = [];
  for (const receipt of receipts) {
    if (receipt.lines.length === 0) {
      loose.push(receipt);
      continue;
    }
    const buckets = new Map<number, DatedReceiptLine[]>();
    const free: DatedReceiptLine[] = [];
    for (const line of receipt.lines) {
      const groupId = owner.get(line.id);
      if (groupId === undefined) free.push(line);
      else {
        const list = buckets.get(groupId) ?? [];
        list.push(line);
        buckets.set(groupId, list);
      }
    }
    const pieces = buckets.size + (free.length > 0 ? 1 : 0);
    if (free.length > 0) {
      loose.push(pieces > 1 ? withReceiptLines(receipt, free, `${receipt.id}::loose`) : receipt);
    }
    for (const [groupId, lines] of buckets) {
      const whole = pieces === 1 && lines.length === receipt.lines.length;
      const piece = whole ? receipt : withReceiptLines(receipt, lines, `${receipt.id}::group-${groupId}`);
      const list = nestedByGroup.get(groupId) ?? [];
      list.push(piece);
      nestedByGroup.set(groupId, list);
    }
  }
  const manual = groups
    .filter((group) => (nestedByGroup.get(group.id)?.length ?? 0) > 0)
    .map((group) => ({ group, nested: nestedByGroup.get(group.id) ?? [] }));
  return buildDatedReceiptFeed(manual, loose);
}

export function isReceiptIdentityToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

export function pfrMembershipKey(canonical: string): string {
  return `pfr:${canonical}`;
}

export function operationMembershipKey(token: string): string {
  return `op:${token}`;
}

/** Stable server key for one receipt card. Null when a non-PFR card has no token yet. */
export function receiptCardKey(
  card: FiscalReceiptGroup,
  tokenByOperationId: ReadonlyMap<number, string | null | undefined>,
): string | null {
  if (card.grouping === 'fiscal_id') {
    const parsed = canonicalizePfr(card.fiscal_receipt_id);
    if (!parsed.ok || !parsed.value) return null;
    return pfrMembershipKey(parsed.value);
  }
  const opId = card.lines[0]?.id;
  if (opId === undefined) return null;
  const token = tokenByOperationId.get(opId);
  if (!isReceiptIdentityToken(token)) return null;
  return operationMembershipKey(token);
}

export function canonicalFromPfrKey(receiptKey: string): string | null {
  if (!receiptKey.startsWith('pfr:')) return null;
  const parsed = canonicalizePfr(receiptKey.slice(4));
  if (!parsed.ok || !parsed.value) return null;
  if (pfrMembershipKey(parsed.value) !== `pfr:${parsed.value}`) return null;
  return parsed.value;
}

export function tokenFromOperationKey(receiptKey: string): string | null {
  if (!OP_KEY_RE.test(receiptKey)) return null;
  return receiptKey.slice(3);
}

interface IndexedCards {
  byPfr: Map<string, FiscalReceiptGroup[]>;
  byToken: Map<string, FiscalReceiptGroup>;
}

function indexCards(operations: ReceiptIdentityOperation[]): IndexedCards {
  const cards = groupFiscalReceipts(operations);
  const byPfr = new Map<string, FiscalReceiptGroup[]>();
  const byToken = new Map<string, FiscalReceiptGroup>();
  const tokenById = new Map<number, string | null>();
  for (const op of operations) {
    tokenById.set(op.id, op.receipt_identity_token ?? null);
  }
  for (const card of cards) {
    if (card.grouping === 'fiscal_id') {
      const parsed = canonicalizePfr(card.fiscal_receipt_id);
      if (!parsed.ok || !parsed.value) continue;
      const list = byPfr.get(parsed.value) ?? [];
      list.push(card);
      byPfr.set(parsed.value, list);
      continue;
    }
    const key = receiptCardKey(card, tokenById);
    const token = key?.startsWith('op:') ? key.slice(3) : null;
    if (token) byToken.set(token, card);
  }
  return { byPfr, byToken };
}

function addMinor(left: number, right: number): number {
  return minorBigIntToNumber(BigInt(left) + BigInt(right), 'posted_minor');
}

function cardPostedMinor(card: FiscalReceiptGroup): number {
  const seen = new Set<number>();
  let total = 0;
  for (const line of card.lines) {
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    total = addMinor(total, line.amount_minor);
  }
  return total;
}

function subtotalsFor(cards: FiscalReceiptGroup[]): { subtotals: ReceiptGroupSubtotal[]; multiCurrency: boolean; currencyMissing: boolean } {
  const seen = new Set<number>();
  const buckets = new Map<string, number>();
  let currencyMissing = false;
  for (const card of cards) {
    for (const line of card.lines) {
      if (seen.has(line.id)) continue;
      seen.add(line.id);
      const currency = normalizeIso4217CurrencyCode(card.account_currency);
      if (!currency) {
        currencyMissing = true;
        const next = addMinor(buckets.get('') ?? 0, line.amount_minor);
        buckets.set('', next);
        continue;
      }
      buckets.set(currency, addMinor(buckets.get(currency) ?? 0, line.amount_minor));
    }
  }
  const subtotals: ReceiptGroupSubtotal[] = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, posted_minor]) => ({
      currency: currency.length > 0 ? currency : null,
      posted_minor,
      document_minor: null,
      document_known: false as const,
    }));
  const named = subtotals.filter((row) => row.currency !== null);
  return { subtotals, multiCurrency: named.length > 1, currencyMissing };
}

export function projectManualGroup(
  order: ManualGroupRow,
  members: MembershipClaim[],
  operations: ReceiptIdentityOperation[],
  currentEpoch: string | null,
  fx?: ReceiptGroupFx,
): ReceiptGroup {
  const baseCurrency = normalizeIso4217CurrencyCode(fx?.baseCurrency) ?? 'USD';
  const ratesMap = new Map<string, number>();
  for (const [code, rate] of fx?.ratesE9 ?? []) {
    const normalized = normalizeIso4217CurrencyCode(code);
    if (normalized) ratesMap.set(normalized, rate);
  }
  const indexed = indexCards(operations);
  const mine = members
    .filter((member) => member.order_id === order.id)
    .slice()
    .sort((a, b) => a.receipt_key.localeCompare(b.receipt_key));
  const resolvedCards: FiscalReceiptGroup[] = [];
  const receipts: ReceiptGroupMemberView[] = mine.map((member) => {
    if (currentEpoch === null || member.ledger_epoch !== currentEpoch) {
      return {
        receipt_key: member.receipt_key,
        resolution: 'epoch_changed',
        operation_ids: [],
        fiscal_receipt_id: null,
        date: null,
        store: null,
        currency: null,
        posted_minor: null,
        base_minor: null,
      };
    }
    const canonical = canonicalFromPfrKey(member.receipt_key);
    if (canonical) {
      const matches = indexed.byPfr.get(canonical) ?? [];
      if (matches.length === 0) {
        return {
          receipt_key: member.receipt_key,
          resolution: 'missing',
          operation_ids: [],
          fiscal_receipt_id: canonical,
          date: null,
          store: null,
          currency: null,
          posted_minor: null,
          base_minor: null,
        };
      }
      if (matches.length > 1) {
        return {
          receipt_key: member.receipt_key,
          resolution: 'ambiguous',
          operation_ids: [],
          fiscal_receipt_id: canonical,
          date: null,
          store: null,
          currency: null,
          posted_minor: null,
          base_minor: null,
        };
      }
      const card = matches[0]!;
      resolvedCards.push(card);
      return {
        receipt_key: member.receipt_key,
        resolution: 'resolved',
        operation_ids: card.lines.map((line) => line.id).sort((a, b) => a - b),
        fiscal_receipt_id: canonical,
        date: receiptCalendarDate(card.date),
        store: card.store ?? null,
        currency: normalizeIso4217CurrencyCode(card.account_currency),
        posted_minor: cardPostedMinor(card),
        base_minor: null,
      };
    }
    const token = tokenFromOperationKey(member.receipt_key);
    if (!token) {
      return {
        receipt_key: member.receipt_key,
        resolution: 'missing',
        operation_ids: [],
        fiscal_receipt_id: null,
        date: null,
        store: null,
        currency: null,
        posted_minor: null,
        base_minor: null,
      };
    }
    const card = indexed.byToken.get(token);
    if (!card) {
      return {
        receipt_key: member.receipt_key,
        resolution: 'missing',
        operation_ids: [],
        fiscal_receipt_id: null,
        date: null,
        store: null,
        currency: null,
        posted_minor: null,
        base_minor: null,
      };
    }
    resolvedCards.push(card);
    return {
      receipt_key: member.receipt_key,
      resolution: 'resolved',
      operation_ids: card.lines.map((line) => line.id).sort((a, b) => a - b),
      fiscal_receipt_id: null,
      date: receiptCalendarDate(card.date),
      store: card.store ?? null,
      currency: normalizeIso4217CurrencyCode(card.account_currency),
      posted_minor: cardPostedMinor(card),
      base_minor: null,
    };
  });
  const totals = subtotalsFor(resolvedCards);
  const missingRates = new Set<string>();
  const convertTracked = makeConverter(ratesMap, baseCurrency, (code) => missingRates.add(code));
  const convertQuiet = makeConverter(ratesMap, baseCurrency);
  for (const receipt of receipts) {
    if (receipt.resolution !== 'resolved' || receipt.currency === null || receipt.posted_minor === null) {
      continue;
    }
    const converted = totals.multiCurrency
      ? convertTracked(BigInt(receipt.posted_minor), receipt.currency, baseCurrency)
      : convertQuiet(BigInt(receipt.posted_minor), receipt.currency, baseCurrency);
    receipt.base_minor = converted === null ? null : minorBigIntToNumber(converted, 'base_minor');
  }
  const missing_rates = [...missingRates].sort();
  const unresolved = receipts.some((receipt) => receipt.resolution !== 'resolved');
  const incomplete = unresolved || totals.currencyMissing || missing_rates.length > 0;
  const namedCurrencies = totals.subtotals
    .map((row) => row.currency)
    .filter((code): code is string => code !== null);
  const singleCurrency = namedCurrencies.length === 1 ? namedCurrencies[0]! : null;
  const total_currency = totals.multiCurrency ? baseCurrency : singleCurrency;
  let total_minor: number | null = null;
  if (!incomplete && resolvedCards.length > 0) {
    if (totals.multiCurrency) {
      total_minor = receipts.reduce((sum, receipt) => addMinor(sum, receipt.base_minor ?? 0), 0);
    } else if (singleCurrency !== null) {
      total_minor = totals.subtotals.find((row) => row.currency === singleCurrency)?.posted_minor ?? null;
    }
  }
  const place = resolveReceiptGroupPlace(resolvedCards, order.display_name);
  const date = resolveReceiptGroupDate(resolvedCards, order.order_date ?? order.created_at ?? null);
  return {
    id: order.id,
    kind: 'manual',
    name: place,
    place,
    date,
    number: order.id,
    receipts,
    subtotals: totals.subtotals,
    base_currency: baseCurrency,
    total_minor,
    total_currency,
    missing_rates,
    incomplete,
    multi_currency: totals.multiCurrency,
  };
}

export function receiptGroupSearchText(
  group: ReceiptGroup,
  cards: FiscalReceiptGroup[],
): string {
  return [
    group.place ?? group.name ?? '',
    group.date ?? '',
    String(group.number),
    ...group.receipts.map((receipt) => receipt.receipt_key),
    ...cards.flatMap((card) => [
      card.fiscal_receipt_id ?? '',
      card.store ?? '',
      card.date ?? '',
      card.account_name,
      card.receipt_url ?? '',
      ...card.lines.map((line) => [line.item, line.category, line.subcategory, line.comment].filter(Boolean).join(' ')),
    ]),
  ].join('\n').toLowerCase();
}

export function receiptGroupSearchState(
  group: ReceiptGroup,
  cards: FiscalReceiptGroup[],
  query: string,
): { visible: boolean; expand: boolean } {
  const q = query.trim().toLowerCase();
  if (!q) return { visible: true, expand: false };
  const title = (group.place ?? group.name ?? '').toLowerCase();
  const date = (group.date ?? '').toLowerCase();
  const headerHit = title.includes(q)
    || date.includes(q)
    || String(group.number) === q;
  const innerHit = cards.some((card) => fiscalReceiptMatchesQuery(card, query))
    || group.receipts.some((receipt) => receipt.receipt_key.toLowerCase().includes(q));
  return { visible: headerHit || innerHit, expand: innerHit && !headerHit };
}

export function pageReceiptGroups<T extends { id: number }>(
  groups: T[],
  query: { limit: number | null; cursor: number | null },
): { groups: T[]; next_cursor: number | null; limit: number | null } {
  const sorted = [...groups].sort((a, b) => a.id - b.id);
  const after = query.cursor === null ? sorted : sorted.filter((group) => group.id > query.cursor!);
  if (query.limit === null) return { groups: after, next_cursor: null, limit: null };
  const page = after.slice(0, query.limit);
  const next = after.length > query.limit ? page[page.length - 1]?.id ?? null : null;
  return { groups: page, next_cursor: next, limit: query.limit };
}
