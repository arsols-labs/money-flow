import { matchPattern } from '../rules/matcher';
import type { MatchType } from '../rules/types';
import { normalizeStatementText } from './amounts';
import type { CategoryMatchField, StatementRow } from './types';

export interface CategoryRule {
  id: number;
  pattern: string;
  match_field: CategoryMatchField;
  match_type?: MatchType | null;
  category: string;
  subcategory: string | null;
  priority: number;
}

function haystack(row: Pick<StatementRow, 'description' | 'merchant' | 'counterparty'>, field: CategoryMatchField): string {
  if (field === 'description') return row.description;
  if (field === 'merchant') return row.merchant || row.description;
  return [row.description, row.merchant, row.counterparty].filter(Boolean).join(' ');
}

/** First matching rule wins. Evaluates rules using configured `match_type` (defaults to literal substring `contains`). */
export function matchCategoryRule(
  row: Pick<StatementRow, 'description' | 'merchant' | 'counterparty'>,
  rules: readonly CategoryRule[],
  options: { preserveOrder?: boolean } = {},
): CategoryRule | null {
  const ordered = options.preserveOrder
    ? rules
    : [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const rule of ordered) {
    const matchType = rule.match_type ?? 'contains';
    if (matchType === 'contains') {
      const needle = normalizeStatementText(rule.pattern);
      if (!needle) continue;
      if (normalizeStatementText(haystack(row, rule.match_field)).includes(needle)) return rule;
    } else if (matchPattern(matchType, rule.pattern, haystack(row, rule.match_field))) {
      return rule;
    }
  }
  return null;
}
