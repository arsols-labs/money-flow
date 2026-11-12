import { normalizeStatementText } from './amounts';
import type { CategoryMatchField, StatementRow } from './types';

export interface CategoryRule {
  id: number;
  pattern: string;
  match_field: CategoryMatchField;
  category: string;
  subcategory: string | null;
  priority: number;
}

function haystack(row: Pick<StatementRow, 'description' | 'merchant' | 'counterparty'>, field: CategoryMatchField): string {
  if (field === 'description') return row.description;
  if (field === 'merchant') return row.merchant || row.description;
  return [row.description, row.merchant, row.counterparty].filter(Boolean).join(' ');
}

/** First matching rule wins. Lower priority, then lower id. Patterns are literal substrings. */
export function matchCategoryRule(
  row: Pick<StatementRow, 'description' | 'merchant' | 'counterparty'>,
  rules: CategoryRule[],
): CategoryRule | null {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const rule of ordered) {
    const needle = normalizeStatementText(rule.pattern);
    if (!needle) continue;
    if (normalizeStatementText(haystack(row, rule.match_field)).includes(needle)) return rule;
  }
  return null;
}
