import {
  SHARED_COUNTRY,
  type RecurringPolicyBindingRecord,
  type RecurringPolicyType,
  type ResolvedRuleEntry,
  type RuleDomain,
  type RuleEntryRecord,
  type RuleSetRecord,
} from './types';

export interface ResolveRuleOptions {
  country?: string | null;
  locale?: string | null;
  asOfDate?: string | null;
  /** If true and country is null/empty, include active sets across any country (useful for global catalogs like currency_standards/fiscal_formats/templates). */
  includeAllCountriesWhenUnscoped?: boolean;
}

export interface ActivationConflict {
  conflicting_set_id: number;
  conflicting_set_key: string;
  conflicting_version: number;
  reason: string;
}

export function isEffectiveAtDate(
  effectiveFrom: string | null,
  effectiveTo: string | null,
  asOfDate: string,
): boolean {
  if (effectiveFrom && asOfDate < effectiveFrom) return false;
  if (effectiveTo && asOfDate > effectiveTo) return false;
  return true;
}

export function dateRangesOverlap(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null,
): boolean {
  if (aFrom && bTo && aFrom > bTo) return false;
  if (bFrom && aTo && bFrom > aTo) return false;
  return true;
}

function normalizeCountryFilter(country: string | null | undefined): string | null {
  if (!country) return null;
  const trimmed = country.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLocaleFilter(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const trimmed = locale.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function localeScore(setLocale: string, targetLocale: string | null): number {
  const normalizedSet = setLocale.trim().toLowerCase();
  if (!targetLocale) {
    return normalizedSet === '' || normalizedSet === 'all' ? 1 : 0;
  }
  const normalizedTarget = targetLocale.trim().toLowerCase();
  if (normalizedSet === normalizedTarget) return 3;
  const baseTarget = normalizedTarget.split('-')[0];
  const baseSet = normalizedSet.split('-')[0];
  if (baseTarget && baseSet === baseTarget && normalizedSet === baseTarget) return 2;
  if (normalizedSet === '' || normalizedSet === 'all') return 1;
  return -1;
}

function countryScore(
  setCountry: string,
  targetCountry: string | null,
  includeAllWhenUnscoped: boolean,
): number {
  if (!targetCountry) {
    if (setCountry === SHARED_COUNTRY) return 2;
    return includeAllWhenUnscoped ? 1 : -1;
  }
  if (setCountry === targetCountry) return 3;
  if (setCountry === SHARED_COUNTRY) return 1;
  return -1;
}

/**
 * Filter and rank active rule sets for `(domain, options)`.
 * Enforces `allow_shared_fallback = 0` when at least one exact-country effective active set disables fallback.
 */
export function selectEffectiveRuleSets(
  sets: readonly RuleSetRecord[],
  domain: RuleDomain,
  options: ResolveRuleOptions = {},
): Array<{ set: RuleSetRecord; specificity: number }> {
  const targetCountry = normalizeCountryFilter(options.country);
  const targetLocale = normalizeLocaleFilter(options.locale);
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const includeAll = options.includeAllCountriesWhenUnscoped ?? true;

  const eligible: Array<{ set: RuleSetRecord; cScore: number; lScore: number }> = [];
  let hasExactCountryDisablingShared = false;

  for (const set of sets) {
    if (set.domain !== domain || set.state !== 'active') continue;
    if (!isEffectiveAtDate(set.effective_from, set.effective_to, asOfDate)) continue;
    const cScore = countryScore(set.scope_country, targetCountry, includeAll);
    if (cScore < 0) continue;
    const lScore = localeScore(set.scope_locale, targetLocale);
    if (lScore < 0) continue;

    if (targetCountry && set.scope_country === targetCountry && set.allow_shared_fallback === 0) {
      hasExactCountryDisablingShared = true;
    }
    eligible.push({ set, cScore, lScore });
  }

  const filtered = hasExactCountryDisablingShared
    ? eligible.filter((item) => item.set.scope_country !== SHARED_COUNTRY)
    : eligible;

  filtered.sort((a, b) => {
    if (a.cScore !== b.cScore) return b.cScore - a.cScore;
    if (a.lScore !== b.lScore) return b.lScore - a.lScore;
    if (a.set.priority !== b.set.priority) return b.set.priority - a.set.priority;
    const aFrom = a.set.effective_from ?? '';
    const bFrom = b.set.effective_from ?? '';
    if (aFrom !== bFrom) return bFrom.localeCompare(aFrom);
    if (a.set.version !== b.set.version) return b.set.version - a.set.version;
    return a.set.id - b.set.id;
  });

  return filtered.map((item) => ({
    set: item.set,
    specificity: item.cScore * 10 + item.lScore,
  }));
}

export function resolveRuleEntries<T = Record<string, unknown>>(
  sets: readonly RuleSetRecord[],
  entriesBySetId: ReadonlyMap<number, readonly RuleEntryRecord[]>,
  domain: RuleDomain,
  options: ResolveRuleOptions = {},
): ResolvedRuleEntry<T>[] {
  const orderedSets = selectEffectiveRuleSets(sets, domain, options);
  const result: ResolvedRuleEntry<T>[] = [];

  for (const { set, specificity } of orderedSets) {
    const entries = entriesBySetId.get(set.id) ?? [];
    const activeEntries = entries
      .filter((entry) => entry.enabled === 1)
      .slice()
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.id - b.id;
      });

    for (const entry of activeEntries) {
      let payload: T;
      try {
        payload = JSON.parse(entry.payload_json) as T;
      } catch {
        continue;
      }
      result.push({ entry, set, specificity, payload });
    }
  }

  // Deterministic global precedence across candidate sets and entries.
  result.sort((a, b) => {
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    if (a.set.priority !== b.set.priority) return b.set.priority - a.set.priority;
    if (a.entry.priority !== b.entry.priority) return b.entry.priority - a.entry.priority;
    if (a.set.version !== b.set.version) return b.set.version - a.set.version;
    return a.entry.id - b.entry.id;
  });

  return result;
}

/**
 * Detect conflicts before activating `candidate`.
 * Same `(domain, scope_country, scope_locale, set_key)` active versions are expected to be retired on activation
 * (not conflicts); overlapping different `set_key`s in the same scope with equal priority or duplicate entry keys
 * report explicit conflicts.
 */
export function detectActivationConflicts(
  candidate: RuleSetRecord,
  candidateEntries: readonly RuleEntryRecord[],
  existingActiveSets: readonly RuleSetRecord[],
  entriesBySetId: ReadonlyMap<number, readonly RuleEntryRecord[]>,
): ActivationConflict[] {
  const conflicts: ActivationConflict[] = [];
  const candidateKeys = new Set(
    candidateEntries.filter((e) => e.enabled === 1).map((e) => e.entry_key),
  );

  for (const other of existingActiveSets) {
    if (other.id === candidate.id || other.state !== 'active') continue;
    if (
      other.domain !== candidate.domain
      || other.scope_country !== candidate.scope_country
      || other.scope_locale !== candidate.scope_locale
    ) {
      continue;
    }
    if (other.set_key === candidate.set_key) continue;
    if (!dateRangesOverlap(candidate.effective_from, candidate.effective_to, other.effective_from, other.effective_to)) {
      continue;
    }

    const otherEntries = (entriesBySetId.get(other.id) ?? []).filter((e) => e.enabled === 1);
    const sharedEntryKeys = otherEntries.filter((e) => candidateKeys.has(e.entry_key)).map((e) => e.entry_key);
    if (sharedEntryKeys.length > 0) {
      conflicts.push({
        conflicting_set_id: other.id,
        conflicting_set_key: other.set_key,
        conflicting_version: other.version,
        reason: `overlapping active effective window shares entry_key(s): ${sharedEntryKeys.slice(0, 5).join(', ')}`,
      });
      continue;
    }

    if (other.priority === candidate.priority && candidate.domain === 'currency_standards') {
      conflicts.push({
        conflicting_set_id: other.id,
        conflicting_set_key: other.set_key,
        conflicting_version: other.version,
        reason: `ambiguous equal priority (${other.priority}) in overlapping ${candidate.domain} scope`,
      });
    }
  }

  return conflicts;
}

export function resolveRecurringPolicyIds(
  policies: readonly RecurringPolicyBindingRecord[],
  policyType: RecurringPolicyType,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Set<number> {
  const targetCountry = normalizeCountryFilter(options.country);
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const ids = new Set<number>();

  for (const row of policies) {
    if (row.policy_type !== policyType || row.state !== 'active') continue;
    if (!isEffectiveAtDate(row.effective_from, row.effective_to, asOfDate)) continue;
    if (targetCountry && row.scope_country !== targetCountry && row.scope_country !== SHARED_COUNTRY) {
      continue;
    }
    ids.add(row.recurring_item_id);
  }
  return ids;
}
