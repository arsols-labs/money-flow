// Merchant labels in Analytics. Synthetic store strings and D1 rule fixtures only.
import { describe, expect, it } from 'vitest';
import type { MerchantAliasPayload, ResolvedRuleEntry } from '../src/shared/rules/types';
import { normMerchant } from '../src/worker/analytics';

function aliasRule(
  id: number,
  pattern: string,
  target_merchant: string,
  match_type: 'tokens' | 'exact' | 'prefix' | 'contains' = 'tokens',
): ResolvedRuleEntry<MerchantAliasPayload> {
  return {
    set: {
      id: 1,
      domain: 'merchant_aliases',
      scope_country: 'SHARED',
      scope_locale: '',
      set_key: 'test-merchants',
      version: 1,
      state: 'active',
      effective_from: null,
      effective_to: null,
      priority: 100,
      allow_shared_fallback: 1,
      label: 'Test Merchants',
      description: null,
      provenance_source: 'api',
      provenance_actor: null,
      revision: 1,
      activated_at: '2026-01-01T00:00:00Z',
      retired_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    entry: {
      id,
      rule_set_id: 1,
      entry_key: `rule_${id}`,
      match_type,
      match_field: 'merchant',
      pattern,
      priority: id * 10,
      enabled: 1,
      payload_json: JSON.stringify({ target_merchant }),
      meta_json: null,
      revision: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    specificity: 1,
    payload: { target_merchant },
  };
}

const SAMPLE_RULES: ReadonlyArray<readonly [string, string]> = [
  ['UBER', 'Uber'],
  ['DR.MAX', 'Dr. Max'],
  ['DR. MAX', 'Dr. Max'],
  ['DR.MAXI', 'Maxi'],
  ['DR. MAXI', 'Maxi'],
  ['POSTA SRBIJE', 'Pošta Srbije'],
  ['ПОШТА СРБИЈЕ', 'Pošta Srbije'],
  ['ПОШТА', 'Pošta Srbije'],
  ['MAXI', 'Maxi'],
];

const RESOLVED_SAMPLE_RULES = SAMPLE_RULES.map(([pattern, target], idx) => aliasRule(idx + 1, pattern, target));

const CASES: readonly [string, string][] = [
  ['GUBERNIJA', 'GUBERNIJA'],
  ['Gubernija d.o.o.', 'Gubernija d.o.o.'],
  ['Uber', 'Uber'],
  ['UBER EATS', 'Uber'],
  ['Uber Eats', 'Uber'],
  ['UBER *TRIP', 'Uber'],
  ['UBER* TRIP HELP.UBER.COM', 'Uber'],
  ['UPPER*TRIP', 'UPPER*TRIP'],
  ['Pošta Srbije', 'Pošta Srbije'],
  ['POSTA SRBIJE', 'Pošta Srbije'],
  ['ПОШТА', 'Pošta Srbije'],
  ['ПОШТА СРБИЈЕ', 'Pošta Srbije'],
  ['Sample Toy Shop', 'Sample Toy Shop'],
  ['Губернија', 'Губернија'],
  ['Макси', 'Макси'],
  ['DR.MAX', 'Dr. Max'],
  ['Dr.Max', 'Dr. Max'],
  ['DR. MAX', 'Dr. Max'],
  ['dr. max pharmacy', 'Dr. Max'],
  ['DR.MAX PHARMACY', 'Dr. Max'],
  ['A.B. DR.MAX', 'Dr. Max'],
  ['DRXMAX', 'DRXMAX'],
  ['DR.MAXI', 'Maxi'],
  ['DR. MAXI', 'Maxi'],
  ['PINEAPPLE', 'PINEAPPLE'],
  ['ХПОШТА', 'ХПОШТА'],
  ['UBER_TRIP', 'Uber'],
  ['UBER-TRIP', 'Uber'],
  ['UBER1', 'UBER1'],
  ['1UBER', '1UBER'],
];

const STORE_SHAPES: readonly [string, string, string][] = SAMPLE_RULES.flatMap(
  ([needle, canon]) => [
    ['alone', needle, canon],
    ['lower case', needle.toLowerCase(), canon],
    ['word before', `PAY ${needle}`, canon],
    ['word after', `${needle} DOO`, canon],
    ['punctuation before', `SQ*${needle}`, canon],
    ['dot after', `${needle}.RS`, canon],
  ],
);

describe('normMerchant', () => {
  it.each(CASES)('maps %j to %j when rules are configured', (raw, expected) => {
    expect(normMerchant(raw, RESOLVED_SAMPLE_RULES)).toBe(expected);
  });

  it.each(STORE_SHAPES)('%s %j maps to %j', (_shape, raw, canon) => {
    expect(normMerchant(raw, RESOLVED_SAMPLE_RULES)).toBe(canon);
  });

  it.each(SAMPLE_RULES)('does not match %j glued inside letters', (needle, canon) => {
    expect(normMerchant(`Q${needle}Z`, RESOLVED_SAMPLE_RULES)).not.toBe(canon);
  });

  it('returns the exact stored value untouched on no-match or empty D1 rules', () => {
    expect(normMerchant('LOCAL KIOSK, BRANCH 2', RESOLVED_SAMPLE_RULES)).toBe('LOCAL KIOSK, BRANCH 2');
    expect(normMerchant('  LOCAL KIOSK  ', RESOLVED_SAMPLE_RULES)).toBe('  LOCAL KIOSK  ');
    expect(normMerchant('Z'.repeat(40), RESOLVED_SAMPLE_RULES)).toBe('Z'.repeat(40));
    expect(normMerchant('UBER EATS', [])).toBe('UBER EATS');
    expect(normMerchant('', RESOLVED_SAMPLE_RULES)).toBe('');
    expect(normMerchant('   ', RESOLVED_SAMPLE_RULES)).toBe('   ');
    expect(normMerchant(null, RESOLVED_SAMPLE_RULES)).toBeNull();
    expect(normMerchant(undefined, RESOLVED_SAMPLE_RULES)).toBeNull();
  });
});
