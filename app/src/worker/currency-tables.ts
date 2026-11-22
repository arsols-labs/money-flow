// Schema tables with a `currency` column — single source of truth shared between
// `api.ts` (re-exported for schema reconciliation tests) and `fx-auto-update.ts`.
export const CURRENCY_TABLES = [
  'accounts',
  'planned_items',
  'recurring_items',
  'imported_receipt_items',
] as const;
