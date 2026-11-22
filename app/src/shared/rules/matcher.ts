import type { MatchType } from './types';

export const MAX_PATTERN_LENGTH = 512;
export const MAX_SAFE_REGEX_LENGTH = 300;
export const MAX_MATCH_INPUT_CHARS = 4096;

export interface PatternSafetyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Detect nested quantifiers, backreferences, lookbehinds with quantifiers,
 * and excessive alternation nesting so D1-stored regex_safe patterns cannot
 * trigger catastrophic backtracking (ReDoS).
 */
export function validateSafeRegexPattern(pattern: string): PatternSafetyResult {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, reason: 'pattern must be non-empty' };
  }
  if (pattern.length > MAX_SAFE_REGEX_LENGTH) {
    return { ok: false, reason: `regex_safe pattern exceeds ${MAX_SAFE_REGEX_LENGTH} chars` };
  }

  let escaped = false;
  let inCharClass = false;
  const groupHasQuantifierStack: boolean[] = [];

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (escaped) {
      // Reject backreferences \1..\9 (non-regular, potential exponential blowup).
      if (!inCharClass && ch >= '1' && ch <= '9') {
        return { ok: false, reason: 'backreferences are not allowed in regex_safe patterns' };
      }
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      continue;
    }
    if (inCharClass) continue;

    if (ch === '(') {
      if (pattern.startsWith('(?<', i) && !pattern.startsWith('(?<=', i) && !pattern.startsWith('(?<!', i)) {
        // Named group is fine.
      } else if (pattern.startsWith('(?<=', i) || pattern.startsWith('(?<!', i)) {
        return { ok: false, reason: 'lookbehinds are not allowed in regex_safe patterns' };
      }
      groupHasQuantifierStack.push(false);
      continue;
    }

    if (ch === ')') {
      const innerHadQuantifier = groupHasQuantifierStack.pop() ?? false;
      // Check if an outer quantifier immediately follows ')'.
      const next = pattern[i + 1];
      const hasOuterQuantifier = next === '*' || next === '+' || next === '{';
      if (innerHadQuantifier && hasOuterQuantifier) {
        return { ok: false, reason: 'nested quantifiers are not allowed in regex_safe patterns' };
      }
      if (hasOuterQuantifier && groupHasQuantifierStack.length > 0) {
        groupHasQuantifierStack[groupHasQuantifierStack.length - 1] = true;
      } else if (innerHadQuantifier && groupHasQuantifierStack.length > 0) {
        groupHasQuantifierStack[groupHasQuantifierStack.length - 1] = true;
      }
      continue;
    }

    if (ch === '*' || ch === '+' || ch === '{') {
      // Detect adjacent double quantifiers like a++ or a*+ (ignoring lazy `?`).
      if (groupHasQuantifierStack.length > 0) {
        groupHasQuantifierStack[groupHasQuantifierStack.length - 1] = true;
      }
    }
  }

  try {
    // Compile with Unicode flag to validate syntax in V8/workerd.
    new RegExp(pattern, 'iu');
  } catch (err) {
    return {
      ok: false,
      reason: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true };
}

export function validatePatternSafety(matchType: MatchType | null, pattern: string | null): PatternSafetyResult {
  if (pattern === null) return { ok: true };
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `pattern must be 1..${MAX_PATTERN_LENGTH} chars` };
  }
  if (matchType === 'regex_safe') {
    return validateSafeRegexPattern(pattern);
  }
  return { ok: true };
}

const REGEX_CACHE = new Map<string, RegExp>();

export function compileBoundedRegex(pattern: string, flags = 'iu'): RegExp | null {
  const safety = validateSafeRegexPattern(pattern);
  if (!safety.ok) return null;
  const cacheKey = `${flags}::${pattern}`;
  let compiled = REGEX_CACHE.get(cacheKey);
  if (!compiled) {
    compiled = new RegExp(pattern, flags);
    if (REGEX_CACHE.size > 512) REGEX_CACHE.clear();
    REGEX_CACHE.set(cacheKey, compiled);
  }
  return new RegExp(compiled.source, compiled.flags);
}

function foldCase(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize('NFC');
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchPattern(
  matchType: MatchType | null,
  pattern: string | null,
  candidate: string | null | undefined,
  options?: { caseSensitive?: boolean },
): boolean {
  if (!pattern || typeof candidate !== 'string') return false;
  const bounded = candidate.slice(0, MAX_MATCH_INPUT_CHARS);
  const caseSensitive = Boolean(options?.caseSensitive);
  const hay = foldCase(bounded, caseSensitive);
  const needle = foldCase(pattern, caseSensitive);

  switch (matchType ?? 'contains') {
    case 'exact':
      return hay === needle || hay.trim() === needle.trim();
    case 'prefix':
      return hay.trimStart().startsWith(needle.trim());
    case 'suffix':
      return hay.trimEnd().endsWith(needle.trim());
    case 'contains':
      return hay.includes(needle);
    case 'tokens': {
      const tokens = needle.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return false;
      const body = tokens.map(escapeRegExp).join('[\\s.,:/\\-]+');
      const tokenRe = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');
      return tokenRe.test(bounded);
    }
    case 'regex_safe': {
      const re = compileBoundedRegex(pattern, caseSensitive ? 'u' : 'iu');
      return re ? re.test(bounded) : false;
    }
    default:
      return hay.includes(needle);
  }
}

export function stripPatternSuffix(
  matchType: MatchType | null,
  pattern: string | null,
  text: string,
  options?: { caseSensitive?: boolean; trimResult?: boolean },
): { matched: boolean; value: string } {
  if (!pattern) return { matched: false, value: text };
  const bounded = text.slice(0, MAX_MATCH_INPUT_CHARS);
  const caseSensitive = Boolean(options?.caseSensitive);
  const effectiveType = matchType ?? 'suffix';

  if (effectiveType === 'regex_safe') {
    const re = compileBoundedRegex(pattern, caseSensitive ? 'u' : 'iu');
    if (!re) return { matched: false, value: text };
    const next = bounded.replace(re, '');
    if (next === bounded) return { matched: false, value: text };
    return {
      matched: true,
      value: options?.trimResult === false ? next : next.trim(),
    };
  }

  const hay = foldCase(bounded, caseSensitive);
  const needle = foldCase(pattern, caseSensitive);
  if (effectiveType === 'suffix' || effectiveType === 'exact') {
    const trimmedHay = hay.trimEnd();
    const trimmedNeedle = needle.trim();
    if (trimmedHay.endsWith(trimmedNeedle)) {
      const cutAt = trimmedHay.length - trimmedNeedle.length;
      const rawCut = bounded.slice(0, cutAt).replace(/[\s,./:–—\-()]+$/u, '');
      return {
        matched: true,
        value: options?.trimResult === false ? rawCut : rawCut.trim(),
      };
    }
  }
  return { matched: false, value: text };
}

export function extractTokensWithPattern(
  matchType: MatchType | null,
  pattern: string | null,
  text: string,
  options?: { tokenGroup?: number; uppercase?: boolean; caseSensitive?: boolean },
): string[] {
  if (!pattern || !text) return [];
  const bounded = text.slice(0, MAX_MATCH_INPUT_CHARS);
  const effectiveType = matchType ?? 'regex_safe';
  if (effectiveType === 'regex_safe') {
    const flags = options?.caseSensitive ? 'gu' : 'giu';
    const re = compileBoundedRegex(pattern, flags);
    if (!re) return [];
    const groupIdx = options?.tokenGroup ?? 1;
    const out: string[] = [];
    for (const match of bounded.matchAll(re)) {
      const raw = match[groupIdx] ?? match[0] ?? '';
      const cleaned = raw.trim();
      if (!cleaned) continue;
      out.push(options?.uppercase === false ? cleaned : cleaned.toUpperCase());
    }
    return out;
  }
  if (matchPattern(effectiveType, pattern, bounded, { caseSensitive: options?.caseSensitive })) {
    const normalized = pattern.trim();
    return normalized ? [options?.uppercase === false ? normalized : normalized.toUpperCase()] : [];
  }
  return [];
}
