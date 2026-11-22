import { Hono } from 'hono';
import { RULE_DOMAINS, type RuleDomain } from '../shared/rules';
import { ValidationError, failCaught } from './api-error';
import { BodyTooLargeError, readLimitedJson } from './limited-body';
import {
  activateRuleSet,
  buildRuntimeConfig,
  cloneRuleSetAsDraft,
  createRecurringPolicy,
  createRuleSet,
  deleteDraftRuleSet,
  deleteRuleEntry,
  exportRulesBundle,
  getRuleSetWithEntries,
  importRulesBundle,
  listRecurringPolicies,
  listRuleSets,
  previewRuleMatch,
  retireRuleSet,
  updateRecurringPolicyState,
  updateRuleSetMetadata,
  upsertRuleEntry,
  type RuleActor,
} from './rules-store';
import type { Env } from './types';

const rulesApi = new Hono<{ Bindings: Env }>();

const MAX_RULES_BODY_BYTES = 512 * 1024;

function actorFromContext(c: { req: { header: (name: string) => string | undefined }; executionCtx?: unknown }): RuleActor {
  let isMcp = false;
  try {
    isMcp = (c.executionCtx as { isInternalMcp?: boolean } | undefined)?.isInternalMcp === true;
  } catch {
    isMcp = false;
  }
  const uiHeader = c.req.header('X-Money-Flow-Source');
  const source = isMcp ? 'mcp' : (uiHeader === 'ui' ? 'ui' : 'api');
  return { source, actor: null };
}

async function readRulesJson(request: Request): Promise<unknown> {
  try {
    return await readLimitedJson(request, MAX_RULES_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new ValidationError('RULE_VALIDATION_FAILED', { detail: 'request body exceeds limit' });
    }
    if (error instanceof SyntaxError) {
      throw new ValidationError('INVALID_JSON');
    }
    throw error;
  }
}

function parsePositiveId(raw: string, code: 'RULE_SET_NOT_FOUND' | 'RULE_ENTRY_NOT_FOUND' | 'NOT_FOUND' = 'RULE_SET_NOT_FOUND'): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(code, undefined, 404);
  }
  return n;
}

function optionalRevision(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('RULE_VALIDATION_FAILED', { detail: 'revision must be a positive integer' });
  }
  return n;
}

rulesApi.get('/config/runtime', async (c) => {
  try {
    const country = c.req.query('country') || null;
    const asOfDate = c.req.query('as_of_date') || null;
    const runtime = await buildRuntimeConfig(c.env.DB, { country, asOfDate });
    return c.json(runtime);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.get('/rules/sets', async (c) => {
  try {
    const sets = await listRuleSets(c.env.DB, {
      domain: c.req.query('domain') || null,
      state: c.req.query('state') || null,
      scope_country: c.req.query('scope_country') || null,
      scope_locale: c.req.query('scope_locale') ?? undefined,
      set_key: c.req.query('set_key') || null,
    });
    return c.json({ rule_sets: sets });
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/sets', async (c) => {
  try {
    const body = await readRulesJson(c.req.raw);
    const idemp = c.req.header('Idempotency-Key') || (typeof (body as { idempotency_key?: unknown })?.idempotency_key === 'string'
      ? (body as { idempotency_key: string }).idempotency_key
      : null);
    const created = await createRuleSet(c.env.DB, body, actorFromContext(c), { idempotencyKey: idemp });
    return c.json(created, created.replayed ? 200 : 201);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.get('/rules/sets/:id', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const detail = await getRuleSetWithEntries(c.env.DB, setId);
    return c.json(detail);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.patch('/rules/sets/:id', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const body = (await readRulesJson(c.req.raw)) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('INVALID_JSON');
    }
    const updated = await updateRuleSetMetadata(
      c.env.DB,
      setId,
      body,
      optionalRevision(body.revision ?? body.expected_revision),
      actorFromContext(c),
    );
    return c.json(updated);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/sets/:id/activate', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const activated = await activateRuleSet(
      c.env.DB,
      setId,
      optionalRevision(raw?.revision ?? raw?.expected_revision),
      actorFromContext(c),
    );
    return c.json(activated);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/sets/:id/retire', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const retired = await retireRuleSet(
      c.env.DB,
      setId,
      optionalRevision(raw?.revision ?? raw?.expected_revision),
      actorFromContext(c),
    );
    return c.json(retired);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/sets/:id/clone', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const cloned = await cloneRuleSetAsDraft(c.env.DB, setId, actorFromContext(c), {
      activate: raw?.activate === true,
      label: typeof raw?.label === 'string' ? raw.label : undefined,
    });
    return c.json(cloned, 201);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.delete('/rules/sets/:id', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const rev = optionalRevision(c.req.query('revision') ?? c.req.query('expected_revision') ?? raw?.revision ?? raw?.expected_revision);
    await deleteDraftRuleSet(c.env.DB, setId, rev);
    return c.json({ ok: true });
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/sets/:id/entries', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const body = (await readRulesJson(c.req.raw)) as Record<string, unknown>;
    const saved = await upsertRuleEntry(
      c.env.DB,
      setId,
      null,
      body,
      optionalRevision(body?.set_revision ?? body?.expected_set_revision ?? body?.expected_revision ?? body?.revision),
      actorFromContext(c),
    );
    return c.json(saved, 201);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.patch('/rules/sets/:id/entries/:entryId', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const entryId = parsePositiveId(c.req.param('entryId'), 'RULE_ENTRY_NOT_FOUND');
    const body = (await readRulesJson(c.req.raw)) as Record<string, unknown>;
    const saved = await upsertRuleEntry(
      c.env.DB,
      setId,
      entryId,
      body,
      optionalRevision(body?.set_revision ?? body?.expected_set_revision ?? body?.expected_revision ?? body?.revision),
      actorFromContext(c),
    );
    return c.json(saved);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.delete('/rules/sets/:id/entries/:entryId', async (c) => {
  try {
    const setId = parsePositiveId(c.req.param('id'), 'RULE_SET_NOT_FOUND');
    const entryId = parsePositiveId(c.req.param('entryId'), 'RULE_ENTRY_NOT_FOUND');
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const rev = optionalRevision(
      c.req.query('set_revision')
      ?? c.req.query('expected_set_revision')
      ?? c.req.query('revision')
      ?? raw?.set_revision
      ?? raw?.expected_set_revision
      ?? raw?.revision,
    );
    const updated = await deleteRuleEntry(
      c.env.DB,
      setId,
      entryId,
      rev,
      actorFromContext(c),
    );
    return c.json(updated);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/preview', async (c) => {
  try {
    const body = (await readRulesJson(c.req.raw)) as Record<string, unknown>;
    const domain = typeof body?.domain === 'string' && (RULE_DOMAINS as readonly string[]).includes(body.domain)
      ? (body.domain as RuleDomain)
      : null;
    if (!domain) {
      throw new ValidationError('RULE_VALIDATION_FAILED', { detail: 'valid domain is required' });
    }
    if (typeof body?.sample !== 'string') {
      throw new ValidationError('RULE_VALIDATION_FAILED', { detail: 'sample string is required' });
    }
    const result = await previewRuleMatch(c.env.DB, {
      domain,
      scope_country: typeof body.scope_country === 'string' ? body.scope_country : null,
      scope_locale: typeof body.scope_locale === 'string' ? body.scope_locale : null,
      as_of_date: typeof body.as_of_date === 'string' ? body.as_of_date : null,
      sample: body.sample,
      sample_secondary: typeof body.sample_secondary === 'string' ? body.sample_secondary : null,
    });
    return c.json(result);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.get('/rules/export', async (c) => {
  try {
    const bundle = await exportRulesBundle(c.env.DB, {
      domain: c.req.query('domain') || null,
      scope_country: c.req.query('scope_country') || null,
      state: c.req.query('state') || null,
    });
    return c.json(bundle);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/import', async (c) => {
  try {
    const body = (await readRulesJson(c.req.raw)) as Record<string, unknown> | null;
    const idemp = c.req.header('Idempotency-Key') || (typeof body?.idempotency_key === 'string'
      ? body.idempotency_key
      : null);
    const hasEnvelope = body && typeof body === 'object' && !Array.isArray(body) && body.bundle && typeof body.bundle === 'object';
    const rawBundle = hasEnvelope ? body.bundle : body;
    const replaceExisting = body?.mode === 'replace' || body?.replace_existing === true;
    const result = await importRulesBundle(c.env.DB, rawBundle, actorFromContext(c), {
      idempotencyKey: idemp,
      replaceExisting,
    });
    return c.json(result, result.replayed ? 200 : 201);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.get('/rules/recurring-policies', async (c) => {
  try {
    const policies = await listRecurringPolicies(c.env.DB);
    return c.json({ recurring_policies: policies });
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.post('/rules/recurring-policies', async (c) => {
  try {
    const body = await readRulesJson(c.req.raw);
    const created = await createRecurringPolicy(c.env.DB, body, actorFromContext(c));
    return c.json({ recurring_policy: created }, 201);
  } catch (err) {
    return failCaught(c, err);
  }
});

rulesApi.patch('/rules/recurring-policies/:id', async (c) => {
  try {
    const id = parsePositiveId(c.req.param('id'), 'NOT_FOUND');
    const body = (await readRulesJson(c.req.raw)) as Record<string, unknown>;
    const state = body?.state === 'active' || body?.state === 'retired' ? body.state : null;
    if (!state) {
      throw new ValidationError('RULE_VALIDATION_FAILED', { detail: 'state must be "active" or "retired"' });
    }
    const updated = await updateRecurringPolicyState(
      c.env.DB,
      id,
      state,
      optionalRevision(body?.revision ?? body?.expected_revision),
    );
    return c.json({ recurring_policy: updated });
  } catch (err) {
    return failCaught(c, err);
  }
});

export default rulesApi;
