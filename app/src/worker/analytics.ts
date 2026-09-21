// Агрегация и расчёт данных для экрана «Аналитика» (S1-5b, issue #250, S1-5c, issue #251).
//
// Выполняется на сервере, чтобы не передавать все строки операций на клиент.
// Суммы в разных валютах пересчитываются в базовую с использованием
// целочисленной арифметики курсов (makeConverter / rate_e9), без float.
// Валюта без курса не ломает расчёт: операция пропускается, а код валюты
// возвращается в missing_rates (поведение согласовано с S1-4, issue #198).
import type { Converter } from './forecast/convert';
import { minorBigIntToNumber } from '../shared/money';
import { ValidationError } from './api-error';

export const ANALYTICS_MAX_Q_LEN = 200;
export const ANALYTICS_MAX_Q_TOKENS = 8;
export const ANALYTICS_MAX_FILTER_ITEMS = 32;
export const ANALYTICS_MAX_FILTER_ITEM_LEN = 128;

function asSafeMinor(value: bigint, field = 'amount_minor'): number {
  try {
    return minorBigIntToNumber(value, field);
  } catch {
    throw new ValidationError('AMOUNT_OUT_OF_SAFE_RANGE', { field });
  }
}

function normalizeFilterList(input: unknown, field: string): string[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > ANALYTICS_MAX_FILTER_ITEMS) {
    throw new ValidationError('FILTER_TOO_LARGE', { field });
  }
  const values: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    if (item.length > ANALYTICS_MAX_FILTER_ITEM_LEN) {
      throw new ValidationError('FILTER_ITEM_TOO_LONG', { field });
    }
    values.push(item);
  }
  return values;
}

export function normalizeAnalyticsFilters(body: Record<string, unknown>): {
  q: string | null;
  cats: string[] | null;
  merchants: string[] | null;
  accounts: string[] | null;
  currencies: string[] | null;
} {
  let q: string | null = null;
  if (typeof body.q === 'string') {
    if (body.q.length > ANALYTICS_MAX_Q_LEN) {
      throw new ValidationError('FILTER_TOO_LARGE', { field: 'q' });
    }
    const tokens = body.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > ANALYTICS_MAX_Q_TOKENS) {
      throw new ValidationError('FILTER_TOO_LARGE', { field: 'q' });
    }
    q = body.q;
  }
  return {
    q,
    cats: normalizeFilterList(body.cats, 'cats'),
    merchants: normalizeFilterList(body.merchants, 'merchants'),
    accounts: normalizeFilterList(body.accounts, 'accounts'),
    currencies: normalizeFilterList(body.currencies, 'currencies'),
  };
}

const MERCHANT_RULES: [string, string][] = [
  ['AMAZON', 'Amazon'],
  ['APPLE', 'Apple'],
  ['GOOGLE', 'Google'],
  ['UBER', 'Uber'],
  ['NETFLIX', 'Netflix'],
  ['SPOTIFY', 'Spotify'],
  ['STARBUCKS', 'Starbucks'],
  ['MAXI', 'Maxi'],
  ['DELHAIZE', 'Maxi'],
  ['AROMA', 'Aroma 57'],
  ['DR.MAX', 'Dr. Max'],
  ['DR. MAX', 'Dr. Max'],
  ['ALBA GRAECA', 'Apoteka Alba Graeca'],
  ['LILLY', 'Lilly'],
  ['IDEA', 'Idea'],
  ['POŠTA', 'Pošta Srbije'],
  ['POSTA SRBIJE', 'Pošta Srbije'],
  ['ПОШТА', 'Pošta Srbije'],
  ['VIZIM', 'Дом здравља Vizim'],
  ['ЧАРОБЊАК', 'Чаробњак'],
  ['GIROSLAV', 'Giroslav'],
  ['AKVAFOR', 'Akvafor'],
  ['BOJEL', 'Bojel Trade'],
];

export function normMerchant(raw: string | null | undefined): string {
  if (!raw) return '—';
  const upper = String(raw).toUpperCase();
  for (const [needle, canon] of MERCHANT_RULES) {
    if (upper.includes(needle)) return canon;
  }
  const cleaned = String(raw).split(',')[0].replace(/\s+/g, ' ').trim();
  return cleaned.length > 28 ? cleaned.slice(0, 27) + '…' : cleaned || '—';
}

export interface OperationWithAccount {
  id: number;
  date: string;
  account_id: number;
  kind: 'expense' | 'income' | 'refund' | 'transfer_out' | 'transfer_in';
  store: string | null;
  item: string;
  category: string | null;
  subcategory: string | null;
  amount_minor: number;
  receipt_id: number | null;
  source: 'manual' | 'receipt' | 'recurring' | 'planned';
  comment: string | null;
  receipt_url: string | null;
  account_name: string;
  account_currency: string;
}

export interface RecurringRuleRow {
  id: number;
  title: string;
  amount_minor: number;
  currency: string;
  account_id: number;
  category: string | null;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval_count: number;
  active: number;
}

export interface AnalyticsFilterInput {
  start_date?: string | null;
  end_date?: string | null;
  q?: string | null;
  cats?: string[] | null;
  merchants?: string[] | null;
  accounts?: string[] | null;
  currencies?: string[] | null;
}

export interface AnalyticsFilterOption {
  label: string;
  count: number;
}

export interface AnalyticsSeriesPoint {
  ts: number;
  /** Нетто: расход минус возврат (обратная совместимость). */
  total_minor: number;
  /** Абсолютный расход за точку (не нетто). */
  expense_minor: number;
  /** Абсолютный возврат за точку (не нетто, не минус). */
  refund_minor: number;
}

export interface AnalyticsBreakdownItem {
  label: string;
  value_minor: number;
  count: number;
  receipts_count?: number;
}

export interface AnalyticsReceiptLine {
  id: number;
  item: string;
  category: string | null;
  subcategory: string | null;
  amount_minor: number;
  kind: 'expense' | 'income' | 'refund' | 'transfer_out' | 'transfer_in';
  converted_minor: number | null;
  comment: string | null;
  receipt_url: string | null;
}

export interface AnalyticsReceipt {
  id: string;
  date: string;
  store: string | null;
  merchant: string;
  account_name: string;
  account_currency: string;
  receipt_total_minor: number;
  receipt_total_base_minor: number;
  positions_count: number;
  lines: AnalyticsReceiptLine[];
}

export interface AnalyticsPlanItem {
  id: number;
  title: string;
  category: string | null;
  amount_minor: number;
  currency: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval_count: number;
  monthly_eq_minor: number;
  converted_amount_minor: number;
  active: number;
}

export interface AnalyticsPlansSummary {
  categories: Array<{ label: string; value_minor: number }>;
  items: AnalyticsPlanItem[];
  monthly_subscriptions_minor: number;
  yearly_subscriptions_minor: number;
  daily_transactions_minor: number;
  daily_expenses_per_month_minor: number;
  total_income_minor: number;
  total_expenses_minor: number;
}

export interface AnalyticsRecurringDetail {
  id: number;
  date: string;
  item: string;
  store: string | null;
  category: string | null;
  subcategory: string | null;
  amount_minor: number;
  account_currency: string;
  account_name: string;
  converted_minor: number;
}

export interface AnalyticsResult {
  stats: {
    total_spent_minor: number;
    total_income_minor: number;
    avg_receipt_minor: number;
    per_day_minor: number;
    receipts_count: number;
    positions_count: number;
  };
  series: {
    day: AnalyticsSeriesPoint[];
    week: AnalyticsSeriesPoint[];
    month: AnalyticsSeriesPoint[];
  };
  options: {
    categories: AnalyticsFilterOption[];
    merchants: AnalyticsFilterOption[];
    accounts: string[];
    currencies: string[];
  };
  missing_rates: string[];
  top_items: {
    expense: AnalyticsBreakdownItem[];
    income: AnalyticsBreakdownItem[];
    refund: AnalyticsBreakdownItem[];
  };
  categories: AnalyticsBreakdownItem[];
  subcategories: AnalyticsBreakdownItem[];
  merchants: AnalyticsBreakdownItem[];
  recurring_operations: AnalyticsBreakdownItem[];
  recurring_details: AnalyticsRecurringDetail[];
  receipts: AnalyticsReceipt[];
  plans?: AnalyticsPlansSummary;
}

export function buildAnalytics(params: {
  operations: OperationWithAccount[];
  converter: Converter;
  baseCurrency: string;
  missingRates: Set<string>;
  filters: AnalyticsFilterInput;
  recurringRules?: RecurringRuleRow[];
}): AnalyticsResult {
  const { operations, converter, baseCurrency, missingRates, filters, recurringRules } = params;

  // 1. Вычисляем доступные опции фильтров по ВСЕМ операциям периода (до фильтров cats/merchants/etc)
  const catCounts = new Map<string, number>();
  const merchantCounts = new Map<string, number>();
  const accountsSet = new Set<string>();
  const currenciesSet = new Set<string>();

  for (const op of operations) {
    if (op.category) {
      catCounts.set(op.category, (catCounts.get(op.category) ?? 0) + 1);
    }
    const m = normMerchant(op.store);
    if (m && m !== '—') {
      merchantCounts.set(m, (merchantCounts.get(m) ?? 0) + 1);
    }
    if (op.account_name) accountsSet.add(op.account_name);
    if (op.account_currency) currenciesSet.add(op.account_currency);
  }

  const categoriesOptions: AnalyticsFilterOption[] = Array.from(catCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'));

  const merchantsOptions: AnalyticsFilterOption[] = Array.from(merchantCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'));

  const accounts = Array.from(accountsSet).sort((a, b) => a.localeCompare(b, 'ru'));
  const currencies = Array.from(currenciesSet).sort();

  // 2. Применяем фильтры
  const selectedCats = filters.cats && filters.cats.length ? new Set(filters.cats) : null;
  const selectedMerchants = filters.merchants && filters.merchants.length ? new Set(filters.merchants) : null;
  const selectedAccounts = filters.accounts && filters.accounts.length ? new Set(filters.accounts) : null;
  const selectedCurrencies = filters.currencies && filters.currencies.length ? new Set(filters.currencies) : null;
  const tokens = (filters.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  const filteredOps = operations.filter((op) => {
    if (selectedCats && (!op.category || !selectedCats.has(op.category))) return false;
    if (selectedMerchants && !selectedMerchants.has(normMerchant(op.store))) return false;
    if (selectedAccounts && !selectedAccounts.has(op.account_name)) return false;
    if (selectedCurrencies && !selectedCurrencies.has(op.account_currency)) return false;
    if (tokens.length) {
      const hay = `${op.item} ${op.store ?? ''} ${normMerchant(op.store)} ${op.category ?? ''} ${op.subcategory ?? ''} ${op.id} ${op.account_name}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  // 3. Считаем итоги, динамику и агрегаты разрезов
  let totalSpentMinor = 0n;
  let totalIncomeMinor = 0n;
  const receiptKeys = new Set<string>();
  let positionsCount = 0;

  const dayBuckets = new Map<number, bigint>();
  const weekBuckets = new Map<number, bigint>();
  const monthBuckets = new Map<number, bigint>();
  const dayExpenseBuckets = new Map<number, bigint>();
  const weekExpenseBuckets = new Map<number, bigint>();
  const monthExpenseBuckets = new Map<number, bigint>();
  const dayRefundBuckets = new Map<number, bigint>();
  const weekRefundBuckets = new Map<number, bigint>();
  const monthRefundBuckets = new Map<number, bigint>();
  const addBucket = (map: Map<number, bigint>, ts: number, delta: bigint) => {
    map.set(ts, (map.get(ts) ?? 0n) + delta);
  };

  // Группы разрезов
  const topExpenseMap = new Map<string, { value: bigint; count: number }>();
  const topIncomeMap = new Map<string, { value: bigint; count: number }>();
  const topRefundMap = new Map<string, { value: bigint; count: number }>();

  const catBreakdown = new Map<string, { value: bigint; count: number; receipts: Set<string> }>();
  const subBreakdown = new Map<string, { value: bigint; count: number; receipts: Set<string> }>();
  const merchantBreakdown = new Map<string, { value: bigint; count: number; receipts: Set<string> }>();
  const recurringBreakdown = new Map<string, { value: bigint; count: number; receipts: Set<string> }>();
  const recurringDetails: AnalyticsRecurringDetail[] = [];

  // Чеки / группированные операции
  interface ReceiptGroupBuilder {
    id: string;
    date: string;
    store: string | null;
    merchant: string;
    account_name: string;
    account_currency: string;
    receipt_total_minor: bigint;
    receipt_total_base_minor: bigint;
    lines: AnalyticsReceiptLine[];
  }
  const receiptsMap = new Map<string, ReceiptGroupBuilder>();

  for (const op of filteredOps) {
    if (op.kind === 'transfer_out' || op.kind === 'transfer_in') continue;

    const absAmount = BigInt(Math.abs(op.amount_minor));
    const converted = converter(absAmount, op.account_currency, baseCurrency);
    if (converted === null) continue; // валюта без курса осела в missingRates

    const rKey = op.receipt_id ? `receipt_${op.receipt_id}` : `manual_${op.date}_${op.account_id}_${op.store || 'nostore'}`;
    const [y, m, d] = op.date.split('-').map(Number);
    const dayTs = Date.UTC(y, m - 1, d);
    const dateObj = new Date(dayTs);
    const dayOfWeek = (dateObj.getUTCDay() + 6) % 7; // Понедельник = 0
    const weekTs = Date.UTC(y, m - 1, d - dayOfWeek);
    const monthTs = Date.UTC(y, m - 1, 1);

    // Добавление в receipt group
    let rGroup = receiptsMap.get(rKey);
    if (!rGroup) {
      rGroup = {
        id: rKey,
        date: op.date,
        store: op.store,
        merchant: normMerchant(op.store),
        account_name: op.account_name,
        account_currency: op.account_currency,
        receipt_total_minor: 0n,
        receipt_total_base_minor: 0n,
        lines: [],
      };
      receiptsMap.set(rKey, rGroup);
    }
    rGroup.receipt_total_minor += absAmount;
    rGroup.receipt_total_base_minor += converted;
    rGroup.lines.push({
      id: op.id,
      item: op.item,
      category: op.category,
      subcategory: op.subcategory,
      amount_minor: op.amount_minor,
      kind: op.kind,
      converted_minor: asSafeMinor(converted, 'converted_minor'),
      comment: op.comment,
      receipt_url: op.receipt_url,
    });

    if (op.kind === 'income') {
      totalIncomeMinor += converted;
      const cur = topIncomeMap.get(op.item) ?? { value: 0n, count: 0 };
      topIncomeMap.set(op.item, { value: cur.value + converted, count: cur.count + 1 });
      continue;
    }

    if (op.kind === 'expense') {
      totalSpentMinor += converted;
      positionsCount += 1;
      receiptKeys.add(rKey);

      addBucket(dayBuckets, dayTs, converted);
      addBucket(weekBuckets, weekTs, converted);
      addBucket(monthBuckets, monthTs, converted);
      addBucket(dayExpenseBuckets, dayTs, converted);
      addBucket(weekExpenseBuckets, weekTs, converted);
      addBucket(monthExpenseBuckets, monthTs, converted);

      // Топ расходов
      const curExp = topExpenseMap.get(op.item) ?? { value: 0n, count: 0 };
      topExpenseMap.set(op.item, { value: curExp.value + converted, count: curExp.count + 1 });

      // Категории
      if (op.category) {
        const curCat = catBreakdown.get(op.category) ?? { value: 0n, count: 0, receipts: new Set() };
        curCat.value += converted;
        curCat.count += 1;
        curCat.receipts.add(rKey);
        catBreakdown.set(op.category, curCat);
      }

      // Подкатегории
      if (op.subcategory) {
        const subKey = op.subcategory;
        const curSub = subBreakdown.get(subKey) ?? { value: 0n, count: 0, receipts: new Set() };
        curSub.value += converted;
        curSub.count += 1;
        curSub.receipts.add(rKey);
        subBreakdown.set(subKey, curSub);
      }

      // Магазины
      const mName = normMerchant(op.store);
      if (mName && mName !== '—') {
        const curM = merchantBreakdown.get(mName) ?? { value: 0n, count: 0, receipts: new Set() };
        curM.value += converted;
        curM.count += 1;
        curM.receipts.add(rKey);
        merchantBreakdown.set(mName, curM);
      }

      // Регулярные
      if (op.source === 'recurring') {
        const curRec = recurringBreakdown.get(op.item) ?? { value: 0n, count: 0, receipts: new Set() };
        curRec.value += converted;
        curRec.count += 1;
        curRec.receipts.add(rKey);
        recurringBreakdown.set(op.item, curRec);

        recurringDetails.push({
          id: op.id,
          date: op.date,
          item: op.item,
          store: op.store,
          category: op.category,
          subcategory: op.subcategory,
          amount_minor: op.amount_minor,
          account_currency: op.account_currency,
          account_name: op.account_name,
          converted_minor: asSafeMinor(converted, 'converted_minor'),
        });
      }
    } else if (op.kind === 'refund') {
      // Возврат уменьшает потраченную сумму
      totalSpentMinor -= converted;
      addBucket(dayBuckets, dayTs, -converted);
      addBucket(weekBuckets, weekTs, -converted);
      addBucket(monthBuckets, monthTs, -converted);
      addBucket(dayRefundBuckets, dayTs, converted);
      addBucket(weekRefundBuckets, weekTs, converted);
      addBucket(monthRefundBuckets, monthTs, converted);

      // Топ возвратов
      const curRef = topRefundMap.get(op.item) ?? { value: 0n, count: 0 };
      topRefundMap.set(op.item, { value: curRef.value + converted, count: curRef.count + 1 });

      if (op.category) {
        const curCat = catBreakdown.get(op.category) ?? { value: 0n, count: 0, receipts: new Set() };
        curCat.value -= converted;
        curCat.receipts.add(rKey);
        catBreakdown.set(op.category, curCat);
      }

      if (op.subcategory) {
        const subKey = op.subcategory;
        const curSub = subBreakdown.get(subKey) ?? { value: 0n, count: 0, receipts: new Set() };
        curSub.value -= converted;
        curSub.receipts.add(rKey);
        subBreakdown.set(subKey, curSub);
      }

      const mName = normMerchant(op.store);
      if (mName && mName !== '—') {
        const curM = merchantBreakdown.get(mName) ?? { value: 0n, count: 0, receipts: new Set() };
        curM.value -= converted;
        curM.receipts.add(rKey);
        merchantBreakdown.set(mName, curM);
      }
    }
  }

  // Сортировка и маппинг списков
  const mapBreakdown = (
    map: Map<string, { value: bigint; count: number; receipts?: Set<string> }>,
  ): AnalyticsBreakdownItem[] =>
    Array.from(map.entries())
      .map(([label, data]) => ({
        label,
        value_minor: asSafeMinor(data.value, 'value_minor'),
        count: data.count,
        receipts_count: data.receipts ? data.receipts.size : undefined,
      }))
      .sort((a, b) => b.value_minor - a.value_minor);

  const topExpense = mapBreakdown(topExpenseMap);
  const topIncome = mapBreakdown(topIncomeMap);
  const topRefund = mapBreakdown(topRefundMap);

  const categories = mapBreakdown(catBreakdown);
  const subcategories = mapBreakdown(subBreakdown);
  const merchants = mapBreakdown(merchantBreakdown);
  const recurringOperations = mapBreakdown(recurringBreakdown);

  const receipts: AnalyticsReceipt[] = Array.from(receiptsMap.values())
    .map((r) => ({
      id: r.id,
      date: r.date,
      store: r.store,
      merchant: r.merchant,
      account_name: r.account_name,
      account_currency: r.account_currency,
      receipt_total_minor: asSafeMinor(r.receipt_total_minor, 'receipt_total_minor'),
      receipt_total_base_minor: asSafeMinor(r.receipt_total_base_minor, 'receipt_total_base_minor'),
      positions_count: r.lines.length,
      lines: r.lines,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

  // Число дней в периоде для расчёта «в день»
  let daysCount = 1;
  if (filters.start_date && filters.end_date) {
    const [y1, m1, d1] = filters.start_date.split('-').map(Number);
    const [y2, m2, d2] = filters.end_date.split('-').map(Number);
    const startMs = Date.UTC(y1, m1 - 1, d1);
    const endMs = Date.UTC(y2, m2 - 1, d2);
    daysCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  } else if (filteredOps.length) {
    const dates = filteredOps.map((op) => {
      const [y, m, d] = op.date.split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    });
    const minMs = Math.min(...dates);
    const maxMs = Math.max(...dates);
    daysCount = Math.max(1, Math.round((maxMs - minMs) / 86400000) + 1);
  }

  const receiptsCount = receiptKeys.size;
  const avgReceiptMinor = receiptsCount > 0 ? asSafeMinor(totalSpentMinor / BigInt(receiptsCount), 'avg_receipt_minor') : 0;
  const perDayMinor = daysCount > 0 ? asSafeMinor(totalSpentMinor / BigInt(daysCount), 'per_day_minor') : 0;

  const toSeries = (
    net: Map<number, bigint>,
    expenses: Map<number, bigint>,
    refunds: Map<number, bigint>,
  ): AnalyticsSeriesPoint[] =>
    Array.from(net.entries())
      .map(([ts, val]) => ({
        ts,
        total_minor: asSafeMinor(val, 'total_minor'),
        expense_minor: asSafeMinor(expenses.get(ts) ?? 0n, 'expense_minor'),
        refund_minor: asSafeMinor(refunds.get(ts) ?? 0n, 'refund_minor'),
      }))
      .sort((a, b) => a.ts - b.ts);

  // Расчёт планов и подписок
  let plans: AnalyticsPlansSummary | undefined;
  if (recurringRules && recurringRules.length > 0) {
    let monthlySubs = 0n;
    let yearlySubs = 0n;
    let weeklySubs = 0n;
    let dailyTrans = 0n;
    let totalPlanIncome = 0n;
    let totalPlanExpenses = 0n;
    const planCatMap = new Map<string, bigint>();
    const planItems: AnalyticsPlanItem[] = [];

    for (const r of recurringRules) {
      if (r.active !== 1) continue;
      const absVal = BigInt(Math.abs(r.amount_minor));
      const converted = converter(absVal, r.currency, baseCurrency);
      if (converted === null) continue;

      // Нормализация в месяц
      let monthlyEq = 0n;
      if (r.frequency === 'monthly') {
        monthlyEq = converted;
        if (r.amount_minor < 0) monthlySubs += converted;
      } else if (r.frequency === 'yearly') {
        monthlyEq = converted / 12n;
        if (r.amount_minor < 0) yearlySubs += converted;
      } else if (r.frequency === 'daily') {
        monthlyEq = converted * 30n;
        if (r.amount_minor < 0) dailyTrans += converted;
      } else if (r.frequency === 'weekly') {
        monthlyEq = (converted * 52n) / 12n;
        if (r.amount_minor < 0) weeklySubs += converted;
      }

      if (r.amount_minor > 0) {
        totalPlanIncome += monthlyEq;
      } else {
        totalPlanExpenses += monthlyEq;
        if (r.category) {
          planCatMap.set(r.category, (planCatMap.get(r.category) ?? 0n) + monthlyEq);
        }
      }

      planItems.push({
        id: r.id,
        title: r.title,
        category: r.category,
        amount_minor: r.amount_minor,
        currency: r.currency,
        frequency: r.frequency,
        interval_count: r.interval_count,
        monthly_eq_minor: asSafeMinor(r.amount_minor < 0 ? -monthlyEq : monthlyEq, 'monthly_eq_minor'),
        converted_amount_minor: asSafeMinor(r.amount_minor < 0 ? -converted : converted, 'converted_amount_minor'),
        active: r.active,
      });
    }

    const planCategories = Array.from(planCatMap.entries())
      .map(([label, val]) => ({ label, value_minor: asSafeMinor(val, 'value_minor') }))
      .sort((a, b) => b.value_minor - a.value_minor);

    const totalMonthlySubs = monthlySubs + yearlySubs / 12n + (weeklySubs * 52n) / 12n;
    const totalYearlySubs = monthlySubs * 12n + yearlySubs + weeklySubs * 52n;

    plans = {
      categories: planCategories,
      items: planItems,
      monthly_subscriptions_minor: asSafeMinor(totalMonthlySubs, 'monthly_subscriptions_minor'),
      yearly_subscriptions_minor: asSafeMinor(totalYearlySubs, 'yearly_subscriptions_minor'),
      daily_transactions_minor: asSafeMinor(dailyTrans, 'daily_transactions_minor'),
      daily_expenses_per_month_minor: asSafeMinor(dailyTrans * 30n, 'daily_expenses_per_month_minor'),
      total_income_minor: asSafeMinor(totalPlanIncome, 'total_income_minor'),
      total_expenses_minor: asSafeMinor(totalPlanExpenses, 'total_expenses_minor'),
    };
  }

  return {
    stats: {
      total_spent_minor: asSafeMinor(totalSpentMinor, 'total_spent_minor'),
      total_income_minor: asSafeMinor(totalIncomeMinor, 'total_income_minor'),
      avg_receipt_minor: avgReceiptMinor,
      per_day_minor: perDayMinor,
      receipts_count: receiptsCount,
      positions_count: positionsCount,
    },
    series: {
      day: toSeries(dayBuckets, dayExpenseBuckets, dayRefundBuckets),
      week: toSeries(weekBuckets, weekExpenseBuckets, weekRefundBuckets),
      month: toSeries(monthBuckets, monthExpenseBuckets, monthRefundBuckets),
    },
    options: {
      categories: categoriesOptions,
      merchants: merchantsOptions,
      accounts,
      currencies,
    },
    missing_rates: Array.from(missingRates).sort(),
    top_items: {
      expense: topExpense,
      income: topIncome,
      refund: topRefund,
    },
    categories,
    subcategories,
    merchants,
    recurring_operations: recurringOperations,
    recurring_details: recurringDetails,
    receipts,
    plans,
  };
}
