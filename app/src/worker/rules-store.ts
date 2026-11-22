import {
  buildCurrencyCatalog,
  normalizeConfiguredCurrencyCode,
  type CurrencyCatalog,
} from '../shared/currency';
import type { BookingGuardRules } from '../shared/booking-guards';
import type { ReceiptGroupRules } from '../shared/receipt-groups';
import {
  RULE_DOMAINS,
  SHARED_COUNTRY,
  detectActivationConflicts,
  matchPattern,
  normalizeCountryScope,
  normalizeLocaleScope,
  resolveRecurringPolicyIds,
  resolveRuleEntries,
  stripPatternSuffix,
  extractTokensWithPattern,
  validateRecurringPolicyInput,
  validateRuleEntryInput,
  validateRuleSetInput,
  validateRulesBundleInput,
  type CategoryRulePayload,
  type CurrencyStandardPayload,
  type DeliveryServicePayload,
  type DomainReadiness,
  type FiscalFormatPayload,
  type MerchantAliasPayload,
  type OrderHintPayload,
  type PdfLayoutPayload,
  type ProvenanceSource,
  type RecurringPolicyBindingRecord,
  type ResolvedRuleEntry,
  type RuleDomain,
  type RuleEntryRecord,
  type RuleSetRecord,
  type VenueSuffixPayload,
} from '../shared/rules';
import { canonicalFiscalIdentity } from '../shared/fiscal-identity';
import type { CategoryRule } from '../shared/statement-import/categories';
import { presetsFromTemplates, templateAsPreset, type StatementPreset } from '../shared/statement-import/templates';
import { validateStatementTemplate, type StatementTemplate } from '../shared/statement-import/template-schema';
import { ValidationError } from './api-error';

export interface RulesSnapshot {
  rulesEpoch: string;
  sets: RuleSetRecord[];
  entriesBySetId: Map<number, RuleEntryRecord[]>;
  recurringPolicies: RecurringPolicyBindingRecord[];
}

export interface RuleActor {
  source: ProvenanceSource;
  actor?: string | null;
}

export interface RuntimeConfigPayload {
  rules_epoch: string;
  base_currency: string | null;
  fx_anchor_currency: string | null;
  currencies: CurrencyStandardPayload[];
  fiscal_formats: Array<Pick<FiscalFormatPayload, 'id' | 'label' | 'canonical_scheme' | 'canonical_host' | 'default_currency'>>;
  statement_templates: Array<{ id: string; label: string; format: StatementTemplate['format']; scopes: string[] }>;
  pdf_layouts: Array<{ id: string; label: string; template_id: string | null; currency_code: string | null }>;
  readiness: DomainReadiness[];
  configured: {
    currencies: boolean;
    fx_anchor: boolean;
    base_currency: boolean;
    fiscal_formats: boolean;
    statement_templates: boolean;
    pdf_layouts: boolean;
  };
}

const snapshotCache = new WeakMap<D1Database, { epoch: string; snapshot: RulesSnapshot }>();

export function invalidateRulesCache(db: D1Database): void {
  snapshotCache.delete(db);
}

export function nowUtcIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function asIsoDate(value?: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date().toISOString().slice(0, 10);
}

async function readRulesEpoch(db: D1Database): Promise<string> {
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'rules_epoch'`)
      .first<{ value: string }>();
    return row?.value ?? '0';
  } catch {
    return '0';
  }
}

export async function bumpRulesEpoch(db: D1Database): Promise<string> {
  const current = await readRulesEpoch(db);
  const nextNum = /^\d+$/.test(current) ? Number(current) + 1 : 1;
  const next = String(nextNum);
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('rules_epoch', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(next)
    .run();
  invalidateRulesCache(db);
  return next;
}

export async function loadRulesSnapshot(db: D1Database): Promise<RulesSnapshot> {
  const epoch = await readRulesEpoch(db);
  const cached = snapshotCache.get(db);
  if (cached && cached.epoch === epoch) {
    return cached.snapshot;
  }

  let sets: RuleSetRecord[] = [];
  let entries: RuleEntryRecord[] = [];
  let policies: RecurringPolicyBindingRecord[] = [];

  try {
    const [setsRes, entriesRes, policiesRes] = await db.batch([
      db.prepare(
        `SELECT id, domain, scope_country, scope_locale, set_key, version, state,
                effective_from, effective_to, priority, allow_shared_fallback,
                label, description, provenance_source, provenance_actor,
                revision, activated_at, retired_at, created_at, updated_at
         FROM rule_sets
         ORDER BY domain ASC, scope_country ASC, scope_locale ASC, set_key ASC, version DESC, id ASC`,
      ),
      db.prepare(
        `SELECT id, rule_set_id, entry_key, match_type, match_field, pattern,
                priority, enabled, payload_json, meta_json, revision, created_at, updated_at
         FROM rule_entries
         ORDER BY priority DESC, id ASC`,
      ),
      db.prepare(
        `SELECT id, recurring_item_id, policy_type, scope_country, version, state,
                effective_from, effective_to, priority, provenance_source, provenance_actor,
                revision, notes, created_at, updated_at
         FROM recurring_policy_bindings
         ORDER BY policy_type ASC, scope_country ASC, recurring_item_id ASC, version DESC, id ASC`,
      ),
    ]);

    sets = (setsRes?.results ?? []) as RuleSetRecord[];
    entries = (entriesRes?.results ?? []) as RuleEntryRecord[];
    policies = (policiesRes?.results ?? []) as RecurringPolicyBindingRecord[];
  } catch {
    // Allow isolated test fixtures without 0028 tables to fail closed with empty snapshot.
    sets = [];
    entries = [];
    policies = [];
  }

  const entriesBySetId = new Map<number, RuleEntryRecord[]>();
  for (const entry of entries) {
    const bucket = entriesBySetId.get(entry.rule_set_id);
    if (bucket) bucket.push(entry);
    else entriesBySetId.set(entry.rule_set_id, [entry]);
  }

  const snapshot: RulesSnapshot = {
    rulesEpoch: epoch,
    sets,
    entriesBySetId,
    recurringPolicies: policies,
  };
  snapshotCache.set(db, { epoch, snapshot });
  return snapshot;
}

export async function loadCurrencyCatalog(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<CurrencyCatalog> {
  const snapshot = await loadRulesSnapshot(db);
  const resolved = resolveRuleEntries<CurrencyStandardPayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'currency_standards',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
  return buildCurrencyCatalog(resolved);
}

export async function loadFiscalFormats(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<FiscalFormatPayload[]> {
  const snapshot = await loadRulesSnapshot(db);
  const resolved = resolveRuleEntries<FiscalFormatPayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'fiscal_formats',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
  const byId = new Map<string, FiscalFormatPayload>();
  for (const item of resolved) {
    if (!byId.has(item.payload.id)) byId.set(item.payload.id, item.payload);
  }
  return Array.from(byId.values());
}

export async function loadMerchantAliases(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<ResolvedRuleEntry<MerchantAliasPayload>[]> {
  const snapshot = await loadRulesSnapshot(db);
  return resolveRuleEntries<MerchantAliasPayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'merchant_aliases',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
}

export async function loadReceiptGroupRules(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<ReceiptGroupRules> {
  const snapshot = await loadRulesSnapshot(db);
  const deliveryServices = resolveRuleEntries<DeliveryServicePayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'delivery_services',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
  const venueSuffixes = resolveRuleEntries<VenueSuffixPayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'venue_suffixes',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
  return { deliveryServices, venueSuffixes };
}

export async function loadBookingGuardRules(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<BookingGuardRules> {
  const snapshot = await loadRulesSnapshot(db);
  const orderHints = resolveRuleEntries<OrderHintPayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'order_hints',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
  const fiscalFormats = await loadFiscalFormats(db, options);
  const analyticalSkipOnlyRecurringIds = resolveRecurringPolicyIds(
    snapshot.recurringPolicies,
    'analytical_skip_only',
    { country: options.country ?? null, asOfDate: options.asOfDate ?? null },
  );
  return { orderHints, fiscalFormats, analyticalSkipOnlyRecurringIds };
}

export async function loadAnalyticalSkipOnlyRecurringIds(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<Set<number>> {
  const snapshot = await loadRulesSnapshot(db);
  return resolveRecurringPolicyIds(snapshot.recurringPolicies, 'analytical_skip_only', {
    country: options.country ?? null,
    asOfDate: options.asOfDate ?? null,
  });
}

export async function loadCategoryRulesFromD1(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<CategoryRule[]> {
  const snapshot = await loadRulesSnapshot(db);
  const resolved = resolveRuleEntries<CategoryRulePayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'category_rules',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
  return resolved
    .filter((item) => Boolean(item.entry.pattern))
    .map((item) => ({
      id: item.entry.id,
      pattern: item.entry.pattern!,
      match_field: (item.entry.match_field === 'description' || item.entry.match_field === 'merchant'
        ? item.entry.match_field
        : 'any'),
      match_type: item.entry.match_type ?? 'contains',
      category: item.payload.category,
      subcategory: item.payload.subcategory,
      priority: item.entry.priority,
    }));
}

export async function loadStatementRuleConfig(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<{
  templates: StatementTemplate[];
  presets: StatementPreset[];
  pdfLayouts: PdfLayoutPayload[];
  resolvedTemplates: ResolvedRuleEntry<StatementTemplate>[];
}> {
  const snapshot = await loadRulesSnapshot(db);
  const resolvedTemplates = resolveRuleEntries<StatementTemplate>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'statement_templates',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );
  const resolvedLayouts = resolveRuleEntries<PdfLayoutPayload>(
    snapshot.sets,
    snapshot.entriesBySetId,
    'pdf_layouts',
    {
      country: options.country ?? null,
      asOfDate: options.asOfDate ?? null,
      includeAllCountriesWhenUnscoped: true,
    },
  );

  const uniqueTemplates = new Map<string, StatementTemplate>();
  for (const item of resolvedTemplates) {
    const check = validateStatementTemplate(item.payload);
    if (!check.ok) continue;
    if (!uniqueTemplates.has(check.value.id)) {
      uniqueTemplates.set(check.value.id, check.value);
    }
  }
  const uniqueLayouts = new Map<string, PdfLayoutPayload>();
  const layoutsByTemplate = new Map<string, string[]>();
  for (const item of resolvedLayouts) {
    if (!uniqueLayouts.has(item.payload.id)) {
      uniqueLayouts.set(item.payload.id, item.payload);
      if (item.payload.template_id) {
        const list = layoutsByTemplate.get(item.payload.template_id) ?? [];
        list.push(item.payload.id);
        layoutsByTemplate.set(item.payload.template_id, list);
      }
    }
  }

  const templates = Array.from(uniqueTemplates.values());
  const pdfLayouts = Array.from(uniqueLayouts.values());
  const presets = presetsFromTemplates(templates, layoutsByTemplate);
  return { templates, presets, pdfLayouts, resolvedTemplates };
}

export function computeReadiness(snapshot: RulesSnapshot): DomainReadiness[] {
  const result: DomainReadiness[] = RULE_DOMAINS.map((domain) => {
    const activeSets = snapshot.sets.filter((s) => s.domain === domain && s.state === 'active');
    const activeEntries = activeSets.reduce((sum, s) => {
      const entries = snapshot.entriesBySetId.get(s.id) ?? [];
      return sum + entries.filter((e) => e.enabled === 1).length;
    }, 0);
    return {
      domain,
      active_sets: activeSets.length,
      active_entries: activeEntries,
      configured: activeEntries > 0,
    };
  });
  const activePolicies = snapshot.recurringPolicies.filter((p) => p.state === 'active').length;
  result.push({
    domain: 'recurring_policies',
    active_sets: activePolicies,
    active_entries: activePolicies,
    configured: activePolicies > 0,
  });
  return result;
}

export async function buildRuntimeConfig(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<RuntimeConfigPayload> {
  const snapshot = await loadRulesSnapshot(db);
  const currencyCatalog = await loadCurrencyCatalog(db, options);
  const fiscalFormats = await loadFiscalFormats(db, options);
  const stmt = await loadStatementRuleConfig(db, options);

  const baseSetting = await db
    .prepare(`SELECT value FROM settings WHERE key = 'base_currency'`)
    .first<{ value: string }>();
  const baseCurrency = normalizeConfiguredCurrencyCode(baseSetting?.value, currencyCatalog);

  const scopesByTemplate = new Map<string, Set<string>>();
  for (const item of stmt.resolvedTemplates) {
    const set = scopesByTemplate.get(item.payload.id) ?? new Set<string>();
    set.add(item.set.scope_country);
    scopesByTemplate.set(item.payload.id, set);
  }

  const currencies = Array.from(currencyCatalog.entries.values());
  const readiness = computeReadiness(snapshot);

  return {
    rules_epoch: snapshot.rulesEpoch,
    base_currency: baseCurrency,
    fx_anchor_currency: currencyCatalog.fxAnchorCode,
    currencies,
    fiscal_formats: fiscalFormats.map((f) => ({
      id: f.id,
      label: f.label,
      canonical_scheme: f.canonical_scheme,
      canonical_host: f.canonical_host,
      default_currency: f.default_currency ?? null,
    })),
    statement_templates: stmt.templates.map((t) => ({
      id: t.id,
      label: t.label,
      format: t.format,
      scopes: Array.from(scopesByTemplate.get(t.id) ?? []),
    })),
    pdf_layouts: stmt.pdfLayouts.map((l) => ({
      id: l.id,
      label: l.label,
      template_id: l.template_id ?? null,
      currency_code: l.currency_code ?? null,
    })),
    readiness,
    configured: {
      currencies: currencies.length > 0,
      fx_anchor: currencyCatalog.fxAnchorCode !== null,
      base_currency: baseCurrency !== null,
      fiscal_formats: fiscalFormats.length > 0,
      statement_templates: stmt.templates.length > 0,
      pdf_layouts: stmt.pdfLayouts.length > 0,
    },
  };
}

export async function listRuleSets(
  db: D1Database,
  filters: {
    domain?: string | null;
    state?: string | null;
    scope_country?: string | null;
    scope_locale?: string | null;
    set_key?: string | null;
  } = {},
): Promise<Array<RuleSetRecord & { entries_count: number }>> {
  const snapshot = await loadRulesSnapshot(db);
  return snapshot.sets
    .filter((set) => {
      if (filters.domain && set.domain !== filters.domain) return false;
      if (filters.state && set.state !== filters.state) return false;
      if (filters.scope_country && set.scope_country !== filters.scope_country.toUpperCase()) return false;
      if (filters.scope_locale !== undefined && filters.scope_locale !== null) {
        const norm = normalizeLocaleScope(filters.scope_locale);
        if (norm !== null && set.scope_locale !== norm) return false;
      }
      if (filters.set_key && set.set_key !== filters.set_key.toLowerCase()) return false;
      return true;
    })
    .map((set) => ({
      ...set,
      entries_count: (snapshot.entriesBySetId.get(set.id) ?? []).length,
    }));
}

export async function getRuleSetWithEntries(
  db: D1Database,
  setId: number,
): Promise<{ rule_set: RuleSetRecord; entries: RuleEntryRecord[] }> {
  const snapshot = await loadRulesSnapshot(db);
  const set = snapshot.sets.find((s) => s.id === setId);
  if (!set) throw new ValidationError('RULE_SET_NOT_FOUND', undefined, 404);
  return {
    rule_set: set,
    entries: snapshot.entriesBySetId.get(set.id) ?? [],
  };
}

async function computeSha256Hex(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function withRuleMutationIdempotency<T>(
  db: D1Database,
  idempotencyKey: string | null | undefined,
  operation: string,
  payloadForHash: unknown,
  executor: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const key = idempotencyKey?.trim();
  if (!key) {
    const out = await executor();
    return { ...out, replayed: false };
  }
  if (key.length < 8 || key.length > 200) {
    throw new ValidationError('RULE_VALIDATION_FAILED', {
      detail: 'idempotency_key must be between 8 and 200 characters',
    });
  }
  const requestHash = await computeSha256Hex(JSON.stringify({ operation, payloadForHash }));
  const existing = await db
    .prepare(
      `SELECT operation, request_hash, status_code, response_json
       FROM rule_config_mutations WHERE idempotency_key = ?`,
    )
    .bind(key)
    .first<{ operation: string; request_hash: string; status_code: number; response_json: string }>();

  if (existing) {
    if (existing.operation !== operation || existing.request_hash !== requestHash) {
      throw new ValidationError('IDEMPOTENCY_CONFLICT', undefined, 409);
    }
    return {
      status: existing.status_code,
      body: JSON.parse(existing.response_json) as T,
      replayed: true,
    };
  }

  const out = await executor();
  const serialized = JSON.stringify(out.body);
  if (serialized.length <= 200_000) {
    await db
      .prepare(
        `INSERT INTO rule_config_mutations (idempotency_key, operation, request_hash, status_code, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(key, operation, requestHash, out.status, serialized, nowUtcIsoSeconds())
      .run();
  }
  return { ...out, replayed: false };
}

export async function createRuleSet(
  db: D1Database,
  rawInput: unknown,
  actor: RuleActor,
  options: { idempotencyKey?: string | null } = {},
): Promise<{ rule_set: RuleSetRecord; entries: RuleEntryRecord[]; replayed?: boolean }> {
  const res = await withRuleMutationIdempotency(
    db,
    options.idempotencyKey,
    'create_rule_set',
    rawInput,
    async () => {
      const setVal = validateRuleSetInput(rawInput, actor.source);
      if (!setVal.ok) {
        throw new ValidationError('RULE_VALIDATION_FAILED', {
          detail: setVal.errors.map((e) => `${e.path} ${e.message}`).join('; '),
        });
      }
      const data = setVal.value;
      const entriesRaw = typeof rawInput === 'object' && rawInput !== null && Array.isArray((rawInput as { entries?: unknown }).entries)
        ? (rawInput as { entries: unknown[] }).entries
        : [];
      const validatedEntries = entriesRaw.map((entryItem, idx) => {
        const v = validateRuleEntryInput(data.domain, entryItem);
        if (!v.ok) {
          throw new ValidationError('RULE_VALIDATION_FAILED', {
            detail: v.errors.map((e) => `/entries/${idx}${e.path} ${e.message}`).join('; '),
          });
        }
        return v.value;
      });

      const snapshot = await loadRulesSnapshot(db);
      const maxVerRow = await db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS max_ver
           FROM rule_sets WHERE domain = ? AND scope_country = ? AND scope_locale = ? AND set_key = ?`,
        )
        .bind(data.domain, data.scope_country, data.scope_locale, data.set_key)
        .first<{ max_ver: number }>();
      const requestedVersion = (rawInput as { version?: unknown }).version !== undefined
        ? data.version
        : (maxVerRow?.max_ver ?? 0) + 1;

      const now = nowUtcIsoSeconds();
      const activatedAt = data.state === 'active' ? now : null;
      const retiredAt = data.state === 'retired' ? now : null;

      if (data.state === 'active') {
        const candidateStub: RuleSetRecord = {
          id: -1,
          ...data,
          version: requestedVersion,
          revision: 1,
          activated_at: activatedAt,
          retired_at: null,
          created_at: now,
          updated_at: now,
        };
        const entryStubs: RuleEntryRecord[] = validatedEntries.map((e, idx) => ({
          id: -(idx + 1),
          rule_set_id: -1,
          ...e,
          revision: 1,
          created_at: now,
          updated_at: now,
        }));
        const conflicts = detectActivationConflicts(candidateStub, entryStubs, snapshot.sets, snapshot.entriesBySetId);
        if (conflicts.length > 0) {
          throw new ValidationError(
            'RULE_CONFLICT',
            { detail: conflicts.map((c) => `${c.conflicting_set_key} v${c.conflicting_version}: ${c.reason}`).join('; ') },
            409,
          );
        }
        await db
          .prepare(
            `UPDATE rule_sets
             SET state = 'retired', retired_at = ?, updated_at = ?, revision = revision + 1
             WHERE domain = ? AND scope_country = ? AND scope_locale = ? AND set_key = ? AND state = 'active'`,
          )
          .bind(now, now, data.domain, data.scope_country, data.scope_locale, data.set_key)
          .run();
      }

      let setId: number;
      try {
        const inserted = await db
          .prepare(
            `INSERT INTO rule_sets (
               domain, scope_country, scope_locale, set_key, version, state,
               effective_from, effective_to, priority, allow_shared_fallback,
               label, description, provenance_source, provenance_actor,
               revision, activated_at, retired_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .bind(
            data.domain,
            data.scope_country,
            data.scope_locale,
            data.set_key,
            requestedVersion,
            data.state,
            data.effective_from,
            data.effective_to,
            data.priority,
            data.allow_shared_fallback,
            data.label,
            data.description,
            actor.source,
            actor.actor ?? data.provenance_actor,
            activatedAt,
            retiredAt,
            now,
            now,
          )
          .run();
        setId = Number(inserted.meta.last_row_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE')) {
          throw new ValidationError(
            'RULE_CONFLICT',
            { detail: `Version ${requestedVersion} already exists for ${data.domain}/${data.scope_country}/${data.set_key}` },
            409,
          );
        }
        throw err;
      }

      if (validatedEntries.length > 0) {
        await db.batch(
          validatedEntries.map((entry) =>
            db
              .prepare(
                `INSERT INTO rule_entries (
                   rule_set_id, entry_key, match_type, match_field, pattern,
                   priority, enabled, payload_json, meta_json, revision, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
              )
              .bind(
                setId,
                entry.entry_key,
                entry.match_type,
                entry.match_field,
                entry.pattern,
                entry.priority,
                entry.enabled,
                entry.payload_json,
                entry.meta_json,
                now,
                now,
              ),
          ),
        );
      }

      await bumpRulesEpoch(db);
      const created = await getRuleSetWithEntries(db, setId);
      return { status: 201, body: created };
    },
  );
  return { ...res.body, replayed: res.replayed };
}

export async function updateRuleSetMetadata(
  db: D1Database,
  setId: number,
  patch: Record<string, unknown>,
  expectedRevision: number | undefined,
  actor: RuleActor,
): Promise<{ rule_set: RuleSetRecord; entries: RuleEntryRecord[] }> {
  const existing = await getRuleSetWithEntries(db, setId);
  const current = existing.rule_set;
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  if (current.state === 'retired') {
    throw new ValidationError('RULE_CONFLICT', { detail: 'Retired rule sets are immutable; clone to create a new draft version' }, 409);
  }

  const mergedInput = {
    domain: current.domain,
    scope_country: patch.scope_country !== undefined ? patch.scope_country : current.scope_country,
    scope_locale: patch.scope_locale !== undefined ? patch.scope_locale : current.scope_locale,
    set_key: patch.set_key !== undefined ? patch.set_key : current.set_key,
    version: current.version,
    state: current.state,
    effective_from: patch.effective_from !== undefined ? patch.effective_from : current.effective_from,
    effective_to: patch.effective_to !== undefined ? patch.effective_to : current.effective_to,
    priority: patch.priority !== undefined ? patch.priority : current.priority,
    allow_shared_fallback: patch.allow_shared_fallback !== undefined ? patch.allow_shared_fallback : current.allow_shared_fallback,
    label: patch.label !== undefined ? patch.label : current.label,
    description: patch.description !== undefined ? patch.description : current.description,
    provenance_source: actor.source,
    provenance_actor: actor.actor ?? current.provenance_actor,
  };
  const val = validateRuleSetInput(mergedInput, actor.source);
  if (!val.ok) {
    throw new ValidationError('RULE_VALIDATION_FAILED', {
      detail: val.errors.map((e) => `${e.path} ${e.message}`).join('; '),
    });
  }
  const next = val.value;
  const now = nowUtcIsoSeconds();
  const result = await db
    .prepare(
      `UPDATE rule_sets
       SET scope_country = ?, scope_locale = ?, set_key = ?, effective_from = ?, effective_to = ?,
           priority = ?, allow_shared_fallback = ?, label = ?, description = ?,
           provenance_source = ?, provenance_actor = ?,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .bind(
      next.scope_country,
      next.scope_locale,
      next.set_key,
      next.effective_from,
      next.effective_to,
      next.priority,
      next.allow_shared_fallback,
      next.label,
      next.description,
      actor.source,
      actor.actor ?? next.provenance_actor,
      now,
      setId,
      current.revision,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  await bumpRulesEpoch(db);
  return getRuleSetWithEntries(db, setId);
}

export async function activateRuleSet(
  db: D1Database,
  setId: number,
  expectedRevision: number | undefined,
  actor: RuleActor,
): Promise<{ rule_set: RuleSetRecord; entries: RuleEntryRecord[] }> {
  const snapshot = await loadRulesSnapshot(db);
  const { rule_set: current, entries } = await getRuleSetWithEntries(db, setId);
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  const conflicts = detectActivationConflicts(current, entries, snapshot.sets, snapshot.entriesBySetId);
  if (conflicts.length > 0) {
    throw new ValidationError(
      'RULE_CONFLICT',
      { detail: conflicts.map((c) => `${c.conflicting_set_key} v${c.conflicting_version}: ${c.reason}`).join('; ') },
      409,
    );
  }

  const now = nowUtcIsoSeconds();
  await db.batch([
    db
      .prepare(
        `UPDATE rule_sets
         SET state = 'retired', retired_at = ?, updated_at = ?, revision = revision + 1
         WHERE domain = ? AND scope_country = ? AND scope_locale = ? AND set_key = ? AND state = 'active' AND id != ?`,
      )
      .bind(now, now, current.domain, current.scope_country, current.scope_locale, current.set_key, setId),
    db
      .prepare(
        `UPDATE rule_sets
         SET state = 'active', activated_at = ?, retired_at = NULL,
             provenance_source = ?, provenance_actor = ?,
             updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ?`,
      )
      .bind(now, actor.source, actor.actor ?? current.provenance_actor, now, setId, current.revision),
  ]);
  await bumpRulesEpoch(db);
  return getRuleSetWithEntries(db, setId);
}

export async function retireRuleSet(
  db: D1Database,
  setId: number,
  expectedRevision: number | undefined,
  actor: RuleActor,
): Promise<{ rule_set: RuleSetRecord; entries: RuleEntryRecord[] }> {
  const { rule_set: current } = await getRuleSetWithEntries(db, setId);
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  const now = nowUtcIsoSeconds();
  const res = await db
    .prepare(
      `UPDATE rule_sets
       SET state = 'retired', retired_at = ?, provenance_source = ?, provenance_actor = ?,
           updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`,
    )
    .bind(now, actor.source, actor.actor ?? current.provenance_actor, now, setId, current.revision)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  await bumpRulesEpoch(db);
  return getRuleSetWithEntries(db, setId);
}

export async function cloneRuleSetAsDraft(
  db: D1Database,
  setId: number,
  actor: RuleActor,
  opts: { activate?: boolean; label?: string } = {},
): Promise<{ rule_set: RuleSetRecord; entries: RuleEntryRecord[] }> {
  const { rule_set: source, entries } = await getRuleSetWithEntries(db, setId);
  const rawClone = {
    domain: source.domain,
    scope_country: source.scope_country,
    scope_locale: source.scope_locale,
    set_key: source.set_key,
    state: opts.activate ? 'active' : 'draft',
    effective_from: source.effective_from,
    effective_to: source.effective_to,
    priority: source.priority,
    allow_shared_fallback: source.allow_shared_fallback === 1,
    label: opts.label ?? source.label,
    description: source.description,
    entries: entries.map((e) => ({
      entry_key: e.entry_key,
      match_type: e.match_type,
      match_field: e.match_field,
      pattern: e.pattern,
      priority: e.priority,
      enabled: e.enabled === 1,
      payload: JSON.parse(e.payload_json),
      meta: e.meta_json ? JSON.parse(e.meta_json) : null,
    })),
  };
  return createRuleSet(db, rawClone, actor);
}

export async function deleteDraftRuleSet(
  db: D1Database,
  setId: number,
  expectedRevision?: number,
): Promise<void> {
  const { rule_set: current } = await getRuleSetWithEntries(db, setId);
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  if (current.state !== 'draft') {
    throw new ValidationError('RULE_CONFLICT', { detail: 'Only draft rule sets can be deleted; retire active sets instead' }, 409);
  }
  await db.prepare(`DELETE FROM rule_sets WHERE id = ?`).bind(setId).run();
  await bumpRulesEpoch(db);
}

export async function upsertRuleEntry(
  db: D1Database,
  setId: number,
  entryId: number | null,
  rawEntry: unknown,
  expectedSetRevision: number | undefined,
  actor: RuleActor,
): Promise<{ rule_set: RuleSetRecord; entry: RuleEntryRecord }> {
  const { rule_set: set, entries } = await getRuleSetWithEntries(db, setId);
  if (expectedSetRevision !== undefined && set.revision !== expectedSetRevision) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  if (set.state === 'retired') {
    throw new ValidationError('RULE_CONFLICT', { detail: 'Retired rule sets cannot be modified' }, 409);
  }
  const val = validateRuleEntryInput(set.domain, rawEntry);
  if (!val.ok) {
    throw new ValidationError('RULE_VALIDATION_FAILED', {
      detail: val.errors.map((e) => `${e.path} ${e.message}`).join('; '),
    });
  }
  const data = val.value;
  const now = nowUtcIsoSeconds();

  let targetEntryId: number;
  if (entryId !== null) {
    const existing = entries.find((e) => e.id === entryId);
    if (!existing) throw new ValidationError('RULE_ENTRY_NOT_FOUND', undefined, 404);
    try {
      await db
        .prepare(
          `UPDATE rule_entries
           SET entry_key = ?, match_type = ?, match_field = ?, pattern = ?,
               priority = ?, enabled = ?, payload_json = ?, meta_json = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND rule_set_id = ?`,
        )
        .bind(
          data.entry_key,
          data.match_type,
          data.match_field,
          data.pattern,
          data.priority,
          data.enabled,
          data.payload_json,
          data.meta_json,
          now,
          entryId,
          setId,
        )
        .run();
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new ValidationError('RULE_CONFLICT', { detail: `entry_key "${data.entry_key}" already exists in this set` }, 409);
      }
      throw err;
    }
    targetEntryId = entryId;
  } else {
    try {
      const inserted = await db
        .prepare(
          `INSERT INTO rule_entries (
             rule_set_id, entry_key, match_type, match_field, pattern,
             priority, enabled, payload_json, meta_json, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          setId,
          data.entry_key,
          data.match_type,
          data.match_field,
          data.pattern,
          data.priority,
          data.enabled,
          data.payload_json,
          data.meta_json,
          now,
          now,
        )
        .run();
      targetEntryId = Number(inserted.meta.last_row_id);
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new ValidationError('RULE_CONFLICT', { detail: `entry_key "${data.entry_key}" already exists in this set` }, 409);
      }
      throw err;
    }
  }

  await db
    .prepare(
      `UPDATE rule_sets SET revision = revision + 1, provenance_source = ?, provenance_actor = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(actor.source, actor.actor ?? set.provenance_actor, now, setId)
    .run();
  await bumpRulesEpoch(db);

  const refreshed = await getRuleSetWithEntries(db, setId);
  const entry = refreshed.entries.find((e) => e.id === targetEntryId);
  if (!entry) throw new ValidationError('RULE_ENTRY_NOT_FOUND', undefined, 404);
  return { rule_set: refreshed.rule_set, entry };
}

export async function deleteRuleEntry(
  db: D1Database,
  setId: number,
  entryId: number,
  expectedSetRevision: number | undefined,
  actor: RuleActor,
): Promise<{ rule_set: RuleSetRecord }> {
  const { rule_set: set, entries } = await getRuleSetWithEntries(db, setId);
  if (expectedSetRevision !== undefined && set.revision !== expectedSetRevision) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  if (set.state === 'retired') {
    throw new ValidationError('RULE_CONFLICT', { detail: 'Retired rule sets cannot be modified' }, 409);
  }
  if (!entries.some((e) => e.id === entryId)) {
    throw new ValidationError('RULE_ENTRY_NOT_FOUND', undefined, 404);
  }
  const now = nowUtcIsoSeconds();
  await db.batch([
    db.prepare(`DELETE FROM rule_entries WHERE id = ? AND rule_set_id = ?`).bind(entryId, setId),
    db
      .prepare(
        `UPDATE rule_sets SET revision = revision + 1, provenance_source = ?, provenance_actor = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(actor.source, actor.actor ?? set.provenance_actor, now, setId),
  ]);
  await bumpRulesEpoch(db);
  const refreshed = await getRuleSetWithEntries(db, setId);
  return { rule_set: refreshed.rule_set };
}

export async function previewRuleMatch(
  db: D1Database,
  input: {
    domain: RuleDomain;
    scope_country?: string | null;
    scope_locale?: string | null;
    as_of_date?: string | null;
    sample: string;
    sample_secondary?: string | null;
  },
): Promise<{
  domain: RuleDomain;
  matched: boolean;
  output: unknown;
  matched_entry: { rule_set_id: number; set_key: string; version: number; entry_id: number; entry_key: string; scope_country: string } | null;
}> {
  const snapshot = await loadRulesSnapshot(db);
  const country = normalizeCountryScope(input.scope_country ?? '') ?? null;
  const locale = input.scope_locale ?? null;
  const asOfDate = asIsoDate(input.as_of_date);

  if (input.domain === 'fiscal_formats') {
    const resolved = resolveRuleEntries<FiscalFormatPayload>(snapshot.sets, snapshot.entriesBySetId, 'fiscal_formats', {
      country,
      asOfDate,
      includeAllCountriesWhenUnscoped: true,
    });
    const identity = canonicalFiscalIdentity(
      { receipt_url: input.sample, fiscal_receipt_id: input.sample_secondary ?? null },
      resolved.map((r) => r.payload),
    );
    const matchedItem = identity?.format_id
      ? resolved.find((r) => r.payload.id === identity.format_id) ?? null
      : null;
    return {
      domain: input.domain,
      matched: Boolean(identity),
      output: identity,
      matched_entry: matchedItem
        ? {
          rule_set_id: matchedItem.set.id,
          set_key: matchedItem.set.set_key,
          version: matchedItem.set.version,
          entry_id: matchedItem.entry.id,
          entry_key: matchedItem.entry.entry_key,
          scope_country: matchedItem.set.scope_country,
        }
        : null,
    };
  }

  if (input.domain === 'merchant_aliases') {
    const resolved = resolveRuleEntries<MerchantAliasPayload>(snapshot.sets, snapshot.entriesBySetId, 'merchant_aliases', {
      country,
      asOfDate,
      includeAllCountriesWhenUnscoped: true,
    });
    for (const rule of resolved) {
      if (!rule.entry.pattern || !rule.entry.match_type) continue;
      if (matchPattern(rule.entry.match_type, rule.entry.pattern, input.sample, { caseSensitive: rule.payload.case_sensitive })) {
        return {
          domain: input.domain,
          matched: true,
          output: { normalized_merchant: rule.payload.target_merchant },
          matched_entry: {
            rule_set_id: rule.set.id,
            set_key: rule.set.set_key,
            version: rule.set.version,
            entry_id: rule.entry.id,
            entry_key: rule.entry.entry_key,
            scope_country: rule.set.scope_country,
          },
        };
      }
    }
    return {
      domain: input.domain,
      matched: false,
      output: { normalized_merchant: input.sample },
      matched_entry: null,
    };
  }

  if (input.domain === 'delivery_services') {
    const resolved = resolveRuleEntries<DeliveryServicePayload>(snapshot.sets, snapshot.entriesBySetId, 'delivery_services', {
      country,
      asOfDate,
      includeAllCountriesWhenUnscoped: true,
    });
    for (const rule of resolved) {
      if (!rule.entry.pattern || !rule.entry.match_type) continue;
      if (matchPattern(rule.entry.match_type, rule.entry.pattern, input.sample, { caseSensitive: rule.payload.case_sensitive })) {
        return {
          domain: input.domain,
          matched: true,
          output: { is_delivery_service: true, label: rule.payload.label },
          matched_entry: {
            rule_set_id: rule.set.id,
            set_key: rule.set.set_key,
            version: rule.set.version,
            entry_id: rule.entry.id,
            entry_key: rule.entry.entry_key,
            scope_country: rule.set.scope_country,
          },
        };
      }
    }
    return {
      domain: input.domain,
      matched: false,
      output: { is_delivery_service: false },
      matched_entry: null,
    };
  }

  if (input.domain === 'venue_suffixes') {
    const resolved = resolveRuleEntries<VenueSuffixPayload>(snapshot.sets, snapshot.entriesBySetId, 'venue_suffixes', {
      country,
      asOfDate,
      includeAllCountriesWhenUnscoped: true,
    });
    for (const rule of resolved) {
      if (!rule.entry.pattern || !rule.entry.match_type) continue;
      const stripped = stripPatternSuffix(rule.entry.match_type, rule.entry.pattern, input.sample, {
        caseSensitive: rule.payload.case_sensitive,
        trimResult: rule.payload.trim_result ?? true,
      });
      if (stripped.matched) {
        return {
          domain: input.domain,
          matched: true,
          output: { stripped_store: stripped.value },
          matched_entry: {
            rule_set_id: rule.set.id,
            set_key: rule.set.set_key,
            version: rule.set.version,
            entry_id: rule.entry.id,
            entry_key: rule.entry.entry_key,
            scope_country: rule.set.scope_country,
          },
        };
      }
    }
    return {
      domain: input.domain,
      matched: false,
      output: { stripped_store: input.sample },
      matched_entry: null,
    };
  }

  if (input.domain === 'order_hints') {
    const resolved = resolveRuleEntries<OrderHintPayload>(snapshot.sets, snapshot.entriesBySetId, 'order_hints', {
      country,
      asOfDate,
      includeAllCountriesWhenUnscoped: true,
    });
    const tokens: string[] = [];
    let firstMatch: ResolvedRuleEntry<OrderHintPayload> | null = null;
    for (const rule of resolved) {
      if (!rule.entry.pattern || !rule.entry.match_type) continue;
      const found = extractTokensWithPattern(rule.entry.match_type, rule.entry.pattern, input.sample, {
        caseSensitive: rule.payload.case_sensitive,
        tokenGroup: rule.payload.token_group ?? 1,
        uppercase: rule.payload.uppercase ?? false,
      });
      if (found.length > 0) {
        if (!firstMatch) firstMatch = rule;
        tokens.push(...found);
      }
    }
    return {
      domain: input.domain,
      matched: tokens.length > 0,
      output: { tokens: Array.from(new Set(tokens)) },
      matched_entry: firstMatch
        ? {
          rule_set_id: firstMatch.set.id,
          set_key: firstMatch.set.set_key,
          version: firstMatch.set.version,
          entry_id: firstMatch.entry.id,
          entry_key: firstMatch.entry.entry_key,
          scope_country: firstMatch.set.scope_country,
        }
        : null,
    };
  }

  if (input.domain === 'category_rules') {
    const resolved = resolveRuleEntries<CategoryRulePayload>(snapshot.sets, snapshot.entriesBySetId, 'category_rules', {
      country,
      asOfDate,
      includeAllCountriesWhenUnscoped: true,
    });
    for (const rule of resolved) {
      if (!rule.entry.pattern || !rule.entry.match_type) continue;
      if (matchPattern(rule.entry.match_type, rule.entry.pattern, input.sample)) {
        return {
          domain: input.domain,
          matched: true,
          output: rule.payload,
          matched_entry: {
            rule_set_id: rule.set.id,
            set_key: rule.set.set_key,
            version: rule.set.version,
            entry_id: rule.entry.id,
            entry_key: rule.entry.entry_key,
            scope_country: rule.set.scope_country,
          },
        };
      }
    }
    return { domain: input.domain, matched: false, output: null, matched_entry: null };
  }

  const generic = resolveRuleEntries(snapshot.sets, snapshot.entriesBySetId, input.domain, {
    country,
    locale,
    asOfDate,
    includeAllCountriesWhenUnscoped: true,
  });
  const hit = generic.find((item) => item.entry.entry_key === input.sample) ?? null;
  return {
    domain: input.domain,
    matched: hit !== null,
    output: hit ? hit.payload : null,
    matched_entry: hit
      ? {
        rule_set_id: hit.set.id,
        set_key: hit.set.set_key,
        version: hit.set.version,
        entry_id: hit.entry.id,
        entry_key: hit.entry.entry_key,
        scope_country: hit.set.scope_country,
      }
      : null,
  };
}

export async function listRecurringPolicies(db: D1Database): Promise<RecurringPolicyBindingRecord[]> {
  const snapshot = await loadRulesSnapshot(db);
  return snapshot.recurringPolicies;
}

export async function createRecurringPolicy(
  db: D1Database,
  rawInput: unknown,
  actor: RuleActor,
): Promise<RecurringPolicyBindingRecord> {
  const val = validateRecurringPolicyInput(rawInput, actor.source);
  if (!val.ok) {
    throw new ValidationError('RULE_VALIDATION_FAILED', {
      detail: val.errors.map((e) => `${e.path} ${e.message}`).join('; '),
    });
  }
  const data = val.value;
  const exists = await db
    .prepare(`SELECT id FROM recurring_items WHERE id = ?`)
    .bind(data.recurring_item_id)
    .first<{ id: number }>();
  if (!exists) {
    throw new ValidationError('NOT_FOUND', undefined, 404);
  }
  const now = nowUtcIsoSeconds();
  if (data.state === 'active') {
    await db
      .prepare(
        `UPDATE recurring_policy_bindings
         SET state = 'retired', updated_at = ?, revision = revision + 1
         WHERE recurring_item_id = ? AND policy_type = ? AND scope_country = ? AND state = 'active'`,
      )
      .bind(now, data.recurring_item_id, data.policy_type, data.scope_country)
      .run();
  }
  const inserted = await db
    .prepare(
      `INSERT INTO recurring_policy_bindings (
         recurring_item_id, policy_type, scope_country, version, state,
         effective_from, effective_to, priority, provenance_source, provenance_actor,
         revision, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      data.recurring_item_id,
      data.policy_type,
      data.scope_country,
      data.version,
      data.state,
      data.effective_from,
      data.effective_to,
      data.priority,
      actor.source,
      actor.actor ?? data.provenance_actor,
      data.notes,
      now,
      now,
    )
    .run();
  await bumpRulesEpoch(db);
  const row = await db
    .prepare(`SELECT * FROM recurring_policy_bindings WHERE id = ?`)
    .bind(Number(inserted.meta.last_row_id))
    .first<RecurringPolicyBindingRecord>();
  return row!;
}

export async function updateRecurringPolicyState(
  db: D1Database,
  id: number,
  nextState: 'active' | 'retired',
  expectedRevision?: number,
): Promise<RecurringPolicyBindingRecord> {
  const existing = await db
    .prepare(`SELECT * FROM recurring_policy_bindings WHERE id = ?`)
    .bind(id)
    .first<RecurringPolicyBindingRecord>();
  if (!existing) throw new ValidationError('NOT_FOUND', undefined, 404);
  if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
    throw new ValidationError('REVISION_CONFLICT', undefined, 409);
  }
  const now = nowUtcIsoSeconds();
  if (nextState === 'active') {
    await db
      .prepare(
        `UPDATE recurring_policy_bindings
         SET state = 'retired', updated_at = ?, revision = revision + 1
         WHERE recurring_item_id = ? AND policy_type = ? AND scope_country = ? AND state = 'active' AND id != ?`,
      )
      .bind(now, existing.recurring_item_id, existing.policy_type, existing.scope_country, id)
      .run();
  }
  await db
    .prepare(
      `UPDATE recurring_policy_bindings
       SET state = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    )
    .bind(nextState, now, id)
    .run();
  await bumpRulesEpoch(db);
  const updated = await db
    .prepare(`SELECT * FROM recurring_policy_bindings WHERE id = ?`)
    .bind(id)
    .first<RecurringPolicyBindingRecord>();
  return updated!;
}

export async function exportRulesBundle(
  db: D1Database,
  filters: { domain?: string | null; scope_country?: string | null; state?: string | null } = {},
) {
  const snapshot = await loadRulesSnapshot(db);
  const sets = snapshot.sets.filter((set) => {
    if (filters.domain && set.domain !== filters.domain) return false;
    if (filters.scope_country && set.scope_country !== filters.scope_country.toUpperCase()) return false;
    if (filters.state && set.state !== filters.state) return false;
    return true;
  });

  return {
    schema_version: 1 as const,
    exported_at: nowUtcIsoSeconds(),
    rule_sets: sets.map((set) => ({
      domain: set.domain,
      scope_country: set.scope_country,
      scope_locale: set.scope_locale || 'all',
      set_key: set.set_key,
      version: set.version,
      state: set.state,
      effective_from: set.effective_from,
      effective_to: set.effective_to,
      priority: set.priority,
      allow_shared_fallback: set.allow_shared_fallback === 1,
      label: set.label,
      description: set.description,
      entries: (snapshot.entriesBySetId.get(set.id) ?? []).map((entry) => ({
        entry_key: entry.entry_key,
        match_type: entry.match_type,
        match_field: entry.match_field,
        pattern: entry.pattern,
        priority: entry.priority,
        enabled: entry.enabled === 1,
        payload: JSON.parse(entry.payload_json),
        ...(entry.meta_json ? { meta: JSON.parse(entry.meta_json) } : {}),
      })),
    })),
    recurring_policies: snapshot.recurringPolicies
      .filter((p) => !filters.scope_country || p.scope_country === filters.scope_country.toUpperCase())
      .map((p) => ({
        recurring_item_id: p.recurring_item_id,
        policy_type: p.policy_type,
        scope_country: p.scope_country,
        version: p.version,
        state: p.state,
        effective_from: p.effective_from,
        effective_to: p.effective_to,
        priority: p.priority,
        notes: p.notes,
      })),
  };
}

export async function importRulesBundle(
  db: D1Database,
  rawBundle: unknown,
  actor: RuleActor,
  options: { idempotencyKey?: string | null; replaceExisting?: boolean } = {},
): Promise<{ imported_sets: number; imported_entries: number; imported_policies: number; replayed?: boolean }> {
  const res = await withRuleMutationIdempotency(
    db,
    options.idempotencyKey,
    'import_rules_bundle',
    { rawBundle, replaceExisting: Boolean(options.replaceExisting) },
    async () => {
      const val = validateRulesBundleInput(rawBundle, actor.source);
      if (!val.ok) {
        throw new ValidationError('RULE_VALIDATION_FAILED', {
          detail: val.errors.map((e) => `${e.path} ${e.message}`).join('; '),
        });
      }
      let importedSets = 0;
      let importedEntries = 0;
      let importedPolicies = 0;
      const now = nowUtcIsoSeconds();

      if (options.replaceExisting) {
        await db
          .prepare(
            `UPDATE rule_sets
             SET state = 'retired', retired_at = COALESCE(retired_at, ?), revision = revision + 1, updated_at = ?
             WHERE state = 'active'`,
          )
          .bind(now, now)
          .run();
        await db
          .prepare(
            `UPDATE recurring_policy_bindings
             SET state = 'retired', revision = revision + 1, updated_at = ?
             WHERE state = 'active'`,
          )
          .bind(now)
          .run();
        await bumpRulesEpoch(db);
        invalidateRulesCache(db);
      }

      for (const setInput of val.value.rule_sets) {
        const snapshot = await loadRulesSnapshot(db);
        const existingVersion = snapshot.sets.find(
          (s) =>
            s.domain === setInput.domain
            && s.scope_country === setInput.scope_country
            && s.scope_locale === setInput.scope_locale
            && s.set_key === setInput.set_key
            && s.version === setInput.version,
        );
        const maxVer = snapshot.sets
          .filter(
            (s) =>
              s.domain === setInput.domain
              && s.scope_country === setInput.scope_country
              && s.scope_locale === setInput.scope_locale
              && s.set_key === setInput.set_key,
          )
          .reduce((m, s) => Math.max(m, s.version), 0);
        const version = existingVersion ? maxVer + 1 : setInput.version;

        const created = await createRuleSet(
          db,
          {
            ...setInput,
            version,
            allow_shared_fallback: setInput.allow_shared_fallback === 1,
            entries: setInput.entries.map((e) => ({
              ...e,
              enabled: e.enabled === 1,
              payload: JSON.parse(e.payload_json),
              ...(e.meta_json ? { meta: JSON.parse(e.meta_json) } : {}),
            })),
          },
          actor,
        );
        importedSets += 1;
        importedEntries += created.entries.length;
      }

      for (const pol of val.value.recurring_policies) {
        const item = await db
          .prepare(`SELECT id FROM recurring_items WHERE id = ?`)
          .bind(pol.recurring_item_id)
          .first<{ id: number }>();
        if (!item) continue;
        if (pol.state === 'active') {
          await db
            .prepare(
              `UPDATE recurring_policy_bindings
               SET state = 'retired', updated_at = ?, revision = revision + 1
               WHERE recurring_item_id = ? AND policy_type = ? AND scope_country = ? AND state = 'active'`,
            )
            .bind(now, pol.recurring_item_id, pol.policy_type, pol.scope_country)
            .run();
        }
        const existingVer = await db
          .prepare(
            `SELECT COALESCE(MAX(version), 0) AS max_ver FROM recurring_policy_bindings
             WHERE recurring_item_id = ? AND policy_type = ? AND scope_country = ?`,
          )
          .bind(pol.recurring_item_id, pol.policy_type, pol.scope_country)
          .first<{ max_ver: number }>();
        const nextVer = (existingVer?.max_ver ?? 0) + 1;
        await db
          .prepare(
            `INSERT INTO recurring_policy_bindings (
               recurring_item_id, policy_type, scope_country, version, state,
               effective_from, effective_to, priority, provenance_source, provenance_actor,
               revision, notes, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .bind(
            pol.recurring_item_id,
            pol.policy_type,
            pol.scope_country,
            Math.max(pol.version, nextVer),
            pol.state,
            pol.effective_from,
            pol.effective_to,
            pol.priority,
            actor.source,
            actor.actor ?? pol.provenance_actor,
            pol.notes,
            now,
            now,
          )
          .run();
        importedPolicies += 1;
      }

      await bumpRulesEpoch(db);
      return {
        status: 201,
        body: {
          imported_sets: importedSets,
          imported_entries: importedEntries,
          imported_policies: importedPolicies,
        },
      };
    },
  );
  return { ...res.body, replayed: res.replayed };
}

export function sharedCountryCode(): string {
  return SHARED_COUNTRY;
}

export async function loadWidgetLocaleBundle(
  db: D1Database,
  options: { country?: string | null; asOfDate?: string | null } = {},
): Promise<{
  currencyMeta: Record<string, { fraction_digits: number; symbol: string | null; is_fx_anchor: boolean }>;
}> {
  const currencyCatalog = await loadCurrencyCatalog(db, options);
  const currencyMeta: Record<string, { fraction_digits: number; symbol: string | null; is_fx_anchor: boolean }> = {};
  for (const [code, entry] of currencyCatalog.entries) {
    currencyMeta[code] = {
      fraction_digits: entry.minor_digits,
      symbol: entry.symbol ?? null,
      is_fx_anchor: Boolean(entry.is_fx_anchor),
    };
  }
  return { currencyMeta };
}

export async function ensureActiveSharedRuleSet(
  db: D1Database,
  domain: RuleDomain,
  preferredSetKey: string,
  label: string,
  actor: RuleActor,
): Promise<RuleSetRecord> {
  const snapshot = await loadRulesSnapshot(db);
  const preferred = snapshot.sets.find(
    (set) => set.domain === domain
      && set.state === 'active'
      && set.scope_country === SHARED_COUNTRY
      && set.scope_locale === ''
      && set.set_key === preferredSetKey,
  );
  if (preferred) return preferred;
  const anyShared = snapshot.sets.find(
    (set) => set.domain === domain
      && set.state === 'active'
      && set.scope_country === SHARED_COUNTRY
      && set.scope_locale === '',
  );
  if (anyShared) return anyShared;
  const created = await createRuleSet(db, {
    domain,
    scope_country: SHARED_COUNTRY,
    scope_locale: '',
    set_key: preferredSetKey,
    state: 'active',
    label,
    entries: [],
  }, actor);
  return created.rule_set;
}
