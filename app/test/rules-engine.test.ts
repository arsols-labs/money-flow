import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import { createSessionCookie } from '../src/worker/auth';
import { normMerchant } from '../src/worker/analytics';
import { invalidateRulesCache } from '../src/worker/rules-store';
import {
  canonicalFiscalIdentity,
  MissingFiscalFormatConfigError,
  requireFiscalUrlIdentity,
} from '../src/shared/fiscal-identity';
import type { Env } from '../src/worker/types';
import { expectErrorCode } from './api-error-helpers';
import { seedTestCurrencyRules } from './seed-test-rules';

const typedEnv = env as unknown as Env;
const clientId = 'client-rules-engine';
let cookie = '';
let rpcId = 1;

beforeAll(async () => {
  cookie = (await createSessionCookie(typedEnv, false)).split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM rule_entries'),
    env.DB.prepare('DELETE FROM rule_sets'),
    env.DB.prepare('DELETE FROM recurring_policy_bindings'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare(`DELETE FROM settings WHERE key IN ('base_currency', 'rules_epoch')`),
  ]);
  invalidateRulesCache(env.DB);
  await env.DB.prepare(
    `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Rules Engine Test', datetime('now'))`,
  ).bind(clientId).run();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      Cookie: cookie,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, typedEnv);
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApp.fetch(req, typedEnv, {
    props: { scopes: ['read', 'write'], clientId },
  } as any);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ result: { isError?: boolean; structuredContent: Record<string, any> } }>;
}

async function mcpConfirm(name: string, args: Record<string, unknown>) {
  const pending = await mcpCall(name, args);
  expect(pending.result.isError, JSON.stringify(pending.result)).toBeFalsy();
  expect(pending.result.structuredContent.resultType).toBe('input_required');
  expect(pending.result.structuredContent.written).toBe(false);
  const done = await mcpCall(name, { ...args, requestState: pending.result.structuredContent.requestState });
  expect(done.result.isError, JSON.stringify(done.result)).toBeFalsy();
  return done;
}

describe('country-scoped D1 rules engine & empty-install fail-closed guards', () => {
  it('blocks unsafe actions with 422 MISSING_CONFIGURATION when required business rules are empty', async () => {
    const runtimeEmpty = await api('GET', '/api/v2/config/runtime');
    expect(runtimeEmpty.status).toBe(200);
    const runtimeBody = await runtimeEmpty.json() as {
      configured: Record<string, boolean>;
      readiness: Array<{ domain: string; configured: boolean; active_sets: number; active_entries: number }>;
    };
    expect(runtimeBody.configured).toMatchObject({
      currencies: false,
      fx_anchor: false,
      base_currency: false,
      fiscal_formats: false,
      pdf_layouts: false,
      statement_templates: false,
    });
    expect(runtimeBody.readiness.every((d) => d.configured === false)).toBe(true);

    const accRes = await api('POST', '/api/v2/accounts', {
      name: 'Empty Checking',
      currency: 'USD',
      owner: 'Tester',
      country: 'USA',
      balance_minor: 0,
    });
    expect(accRes.status).toBe(422);
    await expectErrorCode(accRes, 'MISSING_CONFIGURATION');

    const baseRes = await api('PUT', '/api/v2/settings/base_currency', { value: 'USD' });
    expect(baseRes.status).toBe(422);
    await expectErrorCode(baseRes, 'MISSING_CONFIGURATION');

    const fxRes = await api('PUT', '/api/v2/fx-rates/EUR', { rate: '1.1' });
    expect(fxRes.status).toBe(422);
    await expectErrorCode(fxRes, 'MISSING_CONFIGURATION');

    const forecastRes = await api('GET', '/api/v2/forecast');
    expect(forecastRes.status).toBe(422);
    await expectErrorCode(forecastRes, 'MISSING_CONFIGURATION');

    expect(canonicalFiscalIdentity({ receipt_url: 'https://suf.purs.gov.rs/v/?vl=abc' }, [])).toBeNull();
    expect(() => requireFiscalUrlIdentity('https://suf.purs.gov.rs/v/?vl=abc', []))
      .toThrow(MissingFiscalFormatConfigError);

    // Configuring currency standards unblocks currencies, while PDF layouts remain empty -> 422 on PDF parse.
    await seedTestCurrencyRules(env.DB);
    const baseOk = await api('PUT', '/api/v2/settings/base_currency', { value: 'USD' });
    expect(baseOk.status).toBe(200);

    const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
    let binary = '';
    for (const byte of pdfBytes) binary += String.fromCharCode(byte);
    const pdfRes = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{
        filename: 'test.pdf',
        format: 'pdf',
        content_base64: btoa(binary),
      }],
    });
    expect(pdfRes.status).toBe(422);
    await expectErrorCode(pdfRes, 'MISSING_CONFIGURATION');
  });

  it('enforces country-scoped precedence over SHARED, effective date windows, overlap conflicts, and lifecycle transitions', async () => {
    const sharedRes = await api('POST', '/api/v2/rules/sets', {
      domain: 'merchant_aliases',
      scope_country: 'SHARED',
      set_key: 'merchants',
      state: 'active',
      label: 'Shared Merchants',
      entries: [
        {
          entry_key: 'coffee-shared',
          match_type: 'contains',
          match_field: 'store',
          pattern: 'coffee shop',
          priority: 100,
          payload: { target_merchant: 'Shared Coffee' },
        },
      ],
    });
    expect(sharedRes.status, await sharedRes.clone().text()).toBe(201);
    const sharedSet = ((await sharedRes.json()) as { rule_set: { id: number; revision: number } }).rule_set;

    const srbRes = await api('POST', '/api/v2/rules/sets', {
      domain: 'merchant_aliases',
      scope_country: 'RS',
      set_key: 'merchants',
      state: 'active',
      effective_from: '2026-01-01',
      effective_to: '2026-12-31',
      label: 'Serbia Merchants 2026',
      entries: [
        {
          entry_key: 'coffee-srb',
          match_type: 'contains',
          match_field: 'store',
          pattern: 'coffee shop',
          priority: 100,
          payload: { target_merchant: 'Belgrade Coffee' },
        },
      ],
    });
    expect(srbRes.status, await srbRes.clone().text()).toBe(201);
    const srbSet = ((await srbRes.json()) as { rule_set: { id: number; revision: number; version: number } }).rule_set;

    // RS during 2026 hits Serbia rule; after 2026 falls back to SHARED; US falls back to SHARED.
    const inSrb = await (await api('POST', '/api/v2/rules/preview', {
      domain: 'merchant_aliases',
      scope_country: 'RS',
      as_of_date: '2026-06-15',
      sample: 'Downtown COFFEE SHOP #1',
    })).json() as { matched: boolean; output: { normalized_merchant: string }; matched_entry: { scope_country: string } };
    expect(inSrb.matched).toBe(true);
    expect(inSrb.output.normalized_merchant).toBe('Belgrade Coffee');
    expect(inSrb.matched_entry.scope_country).toBe('RS');

    const afterWindow = await (await api('POST', '/api/v2/rules/preview', {
      domain: 'merchant_aliases',
      scope_country: 'RS',
      as_of_date: '2027-01-15',
      sample: 'Downtown COFFEE SHOP #1',
    })).json() as { matched: boolean; output: { normalized_merchant: string }; matched_entry: { scope_country: string } };
    expect(afterWindow.matched).toBe(true);
    expect(afterWindow.output.normalized_merchant).toBe('Shared Coffee');
    expect(afterWindow.matched_entry.scope_country).toBe('SHARED');

    // Unmatched stored values pass through intact, preserving whitespace & casing.
    const rawUnmatched = '  Corner Bakery d.o.o.  ';
    const unmatched = await (await api('POST', '/api/v2/rules/preview', {
      domain: 'merchant_aliases',
      scope_country: 'RS',
      as_of_date: '2026-06-15',
      sample: rawUnmatched,
    })).json() as { matched: boolean; output: { normalized_merchant: string }; matched_entry: unknown };
    expect(unmatched.matched).toBe(false);
    expect(unmatched.output.normalized_merchant).toBe(rawUnmatched);
    expect(unmatched.matched_entry).toBeNull();
    expect(normMerchant(rawUnmatched, [])).toBe(rawUnmatched);

    // Deleting an active set is rejected (409); duplicate version conflicts (409); clone & activate retires prior version.
    const delActive = await api('DELETE', `/api/v2/rules/sets/${srbSet.id}`);
    expect(delActive.status).toBe(409);

    const conflictDup = await api('POST', '/api/v2/rules/sets', {
      domain: 'merchant_aliases',
      scope_country: 'RS',
      set_key: 'merchants',
      version: 1,
      state: 'active',
      effective_from: '2026-06-01',
      effective_to: '2026-12-31',
      label: 'Conflict candidate',
      entries: [],
    });
    expect(conflictDup.status).toBe(409);

    const draftV2 = await api('POST', '/api/v2/rules/sets', {
      domain: 'merchant_aliases',
      scope_country: 'RS',
      set_key: 'merchants',
      version: 2,
      state: 'draft',
      effective_from: '2026-06-01',
      label: 'Draft v2',
      entries: [],
    });
    expect(draftV2.status).toBe(201);
    const draftId = ((await draftV2.json()) as { rule_set: { id: number } }).rule_set.id;

    // Retire draft? Delete draft succeeds cleanly; clone & retire active succeeds cleanly.
    const delDraft = await api('DELETE', `/api/v2/rules/sets/${draftId}`);
    expect(delDraft.status).toBe(200);

    const cloned = await api('POST', `/api/v2/rules/sets/${srbSet.id}/clone`, {
      label: 'Serbia Merchants v2',
    });
    expect(cloned.status).toBe(201);
    const clonedSet = ((await cloned.json()) as { rule_set: { id: number; version: number; state: string } }).rule_set;
    expect(clonedSet.version).toBe(srbSet.version + 1);
    expect(clonedSet.state).toBe('draft');

    const activated = await api('POST', `/api/v2/rules/sets/${clonedSet.id}/activate`, {});
    expect(activated.status, await activated.clone().text()).toBe(200);

    const oldAfterActivate = await (await api('GET', `/api/v2/rules/sets/${srbSet.id}`)).json() as {
      rule_set: { state: string };
    };
    expect(oldAfterActivate.rule_set.state).toBe('retired');

    const retired = await api('POST', `/api/v2/rules/sets/${sharedSet.id}/retire`, {
      revision: sharedSet.revision,
    });
    expect(retired.status).toBe(200);
  });

  it('previews venue suffixes, round-trips rule bundles (merge/replace), and executes MCP rules tools with MRTR', async () => {
    const venueCreate = await mcpCall('rule_set_create', {
      domain: 'venue_suffixes',
      scope_country: 'SHARED',
      set_key: 'venues',
      state: 'active',
      label: 'Venue suffixes',
      entries: [
        {
          entry_key: 'strip-belgrade',
          match_type: 'regex_safe',
          match_field: 'store',
          pattern: '\\s*-\\s*Belgrade\\s*$',
          priority: 100,
          payload: { label: 'Belgrade suffix', trim_result: true },
        },
      ],
      auto_confirm: true,
      idempotency_key: 'mcp-create-venues',
    });
    expect(venueCreate.result.isError, JSON.stringify(venueCreate.result)).toBeFalsy();
    expect(venueCreate.result.structuredContent.written).toBe(true);
    const createdSetId = venueCreate.result.structuredContent.rule_set.id as number;

    const listed = await mcpCall('rule_sets_list', { domain: 'venue_suffixes' });
    expect(listed.result.isError).toBeFalsy();
    expect(listed.result.structuredContent.rule_sets.map((s: { id: number }) => s.id)).toContain(createdSetId);

    const preview = await (await api('POST', '/api/v2/rules/preview', {
      domain: 'venue_suffixes',
      sample: 'Supermarket - Belgrade',
    })).json() as { matched: boolean; output: { stripped_store: string } };
    expect(preview.matched).toBe(true);
    expect(preview.output.stripped_store).toBe('Supermarket');

    const bundleRes = await api('GET', '/api/v2/rules/export');
    expect(bundleRes.status).toBe(200);
    const bundle = await bundleRes.json() as { format: string; rule_sets: unknown[] };
    expect(bundle.rule_sets.length).toBeGreaterThanOrEqual(1);

    // MCP destructive/bundle writes refuse auto_confirm and succeed after requestState confirmation.
    const draftCreate = await mcpCall('rule_set_create', {
      domain: 'merchant_aliases',
      scope_country: 'SHARED',
      set_key: 'draft-del',
      state: 'draft',
      label: 'To delete',
      entries: [],
      auto_confirm: true,
      idempotency_key: 'mcp-create-draft',
    });
    const draftId = draftCreate.result.structuredContent.rule_set.id as number;

    const refusedDelete = await mcpCall('rule_set_delete', {
      rule_set_id: draftId,
      auto_confirm: true,
      idempotency_key: 'mcp-delete-refused',
    });
    expect(refusedDelete.result.isError).toBe(true);

    const deleted = await mcpConfirm('rule_set_delete', {
      rule_set_id: draftId,
      idempotency_key: 'mcp-delete-confirmed',
    });
    expect(deleted.result.structuredContent.written).toBe(true);

    const refusedImport = await mcpCall('rules_bundle_import', {
      bundle,
      mode: 'replace',
      auto_confirm: true,
      idempotency_key: 'mcp-import-refused',
    });
    expect(refusedImport.result.isError).toBe(true);

    const imported = await mcpConfirm('rules_bundle_import', {
      bundle,
      mode: 'replace',
      idempotency_key: 'mcp-import-confirmed',
    });
    expect(imported.result.structuredContent.written).toBe(true);
  });
});
