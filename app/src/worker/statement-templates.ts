import { ValidationError } from './api-error';
import {
  formatTemplateErrors,
  validateStatementTemplate,
  type StatementTemplate,
} from '../shared/statement-import/template-schema';
import type { RuleEntryRecord, RuleSetRecord } from '../shared/rules';
import {
  bumpRulesEpoch,
  deleteRuleEntry,
  ensureActiveSharedRuleSet,
  loadRulesSnapshot,
  upsertRuleEntry,
  type RuleActor,
} from './rules-store';

export const STATEMENT_TEMPLATE_MAX_BYTES = 32_768;

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_STATEMENT_TEMPLATES_SET_KEY = 'user-statement-templates';

export interface TemplateProvenance {
  createdVia: 'api' | 'mcp' | 'backup';
  createdByClientId: string | null;
}

export interface StoredStatementTemplate {
  templateId: string;
  label: string;
  format: StatementTemplate['format'];
  document: StatementTemplate;
  createdAt: string;
  updatedAt: string;
  createdVia: string | null;
  createdByClientId: string | null;
  usedBatchId: number | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStatementTemplate(input: unknown): StatementTemplate {
  const normalized = isPlainObject(input) ? { ...input } : input;
  if (isPlainObject(normalized)) {
    if (typeof normalized.id === 'string') normalized.id = normalized.id.trim();
    if (typeof normalized.label === 'string') normalized.label = normalized.label.trim();
  }
  const result = validateStatementTemplate(normalized);
  if (!result.ok) {
    throw new ValidationError('TEMPLATE_INVALID', { detail: formatTemplateErrors(result.errors) });
  }
  const encoded = JSON.stringify(result.value);
  if (encoded.length > STATEMENT_TEMPLATE_MAX_BYTES) {
    throw new ValidationError('TEMPLATE_INVALID', { detail: '/ document is too large' });
  }
  return result.value;
}

function parseMeta(metaJson: string | null): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function entryToStored(entry: RuleEntryRecord): StoredStatementTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.payload_json);
  } catch {
    throw new ValidationError('TEMPLATE_INVALID', { detail: '/document must be JSON' });
  }
  const document = parseStatementTemplate(parsed);
  const meta = parseMeta(entry.meta_json);
  return {
    templateId: document.id,
    label: document.label,
    format: document.format,
    document,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    createdVia: typeof meta.created_via === 'string' ? meta.created_via : null,
    createdByClientId: typeof meta.created_by_client_id === 'string' ? meta.created_by_client_id : null,
    usedBatchId: typeof meta.used_batch_id === 'number' && Number.isInteger(meta.used_batch_id) ? meta.used_batch_id : null,
  };
}

export function templateJson(template: StatementTemplate, source: 'd1' | 'user' = 'user', stamps?: {
  createdAt: string;
  updatedAt: string;
  createdVia?: string | null;
  usedBatchId?: number | null;
}) {
  return {
    source,
    readonly: false,
    document: template,
    created_at: stamps?.createdAt ?? null,
    updated_at: stamps?.updatedAt ?? null,
    created_via: stamps?.createdVia ?? null,
    used: stamps?.usedBatchId != null,
  };
}

function activeTemplateEntries(snapshot: Awaited<ReturnType<typeof loadRulesSnapshot>>): Array<{
  set: RuleSetRecord;
  entry: RuleEntryRecord;
}> {
  const activeSets = snapshot.sets
    .filter((set) => set.domain === 'statement_templates' && set.state === 'active')
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  const out: Array<{ set: RuleSetRecord; entry: RuleEntryRecord }> = [];
  for (const set of activeSets) {
    const entries = snapshot.entriesBySetId.get(set.id) ?? [];
    for (const entry of entries) {
      if (entry.enabled === 1) out.push({ set, entry });
    }
  }
  out.sort((a, b) => b.entry.updated_at.localeCompare(a.entry.updated_at) || b.entry.id - a.entry.id);
  return out;
}

export async function listStatementTemplates(db: D1Database): Promise<StoredStatementTemplate[]> {
  const snapshot = await loadRulesSnapshot(db);
  return activeTemplateEntries(snapshot).map(({ entry }) => entryToStored(entry));
}

async function findStatementTemplateRecord(
  db: D1Database,
  templateId: string,
): Promise<{ set: RuleSetRecord; entry: RuleEntryRecord; stored: StoredStatementTemplate } | null> {
  if (!TEMPLATE_ID.test(templateId)) return null;
  const snapshot = await loadRulesSnapshot(db);
  for (const { set, entry } of activeTemplateEntries(snapshot)) {
    const stored = entryToStored(entry);
    if (stored.templateId === templateId || entry.entry_key === templateId) {
      return { set, entry, stored };
    }
  }
  return null;
}

export async function getStatementTemplate(db: D1Database, templateId: string): Promise<StoredStatementTemplate | null> {
  const found = await findStatementTemplateRecord(db, templateId);
  return found ? found.stored : null;
}

function actorFromProvenance(provenance: TemplateProvenance): RuleActor {
  return {
    source: provenance.createdVia === 'mcp' ? 'mcp' : provenance.createdVia === 'backup' ? 'import' : 'api',
    actor: provenance.createdByClientId,
  };
}

export async function insertStatementTemplate(
  db: D1Database,
  document: StatementTemplate,
  provenance: TemplateProvenance = { createdVia: 'api', createdByClientId: null },
): Promise<StoredStatementTemplate> {
  const existing = await findStatementTemplateRecord(db, document.id);
  if (existing) throw new ValidationError('TEMPLATE_ID_TAKEN', undefined, 409);

  const actor = actorFromProvenance(provenance);
  const set = await ensureActiveSharedRuleSet(
    db,
    'statement_templates',
    DEFAULT_STATEMENT_TEMPLATES_SET_KEY,
    'User Statement Templates',
    actor,
  );
  const meta: Record<string, unknown> = {
    created_via: provenance.createdVia,
    created_by_client_id: provenance.createdByClientId,
    used_batch_id: null,
  };
  try {
    const res = await upsertRuleEntry(
      db,
      set.id,
      null,
      {
        entry_key: document.id,
        priority: 100,
        enabled: true,
        payload: document,
        meta,
      },
      set.revision,
      actor,
    );
    return entryToStored(res.entry);
  } catch (error) {
    if (error instanceof ValidationError && error.code === 'RULE_CONFLICT') {
      throw new ValidationError('TEMPLATE_ID_TAKEN', undefined, 409);
    }
    throw error;
  }
}

export async function updateStatementTemplate(
  db: D1Database,
  templateId: string,
  input: { label?: string; document?: StatementTemplate },
): Promise<StoredStatementTemplate> {
  const found = await findStatementTemplateRecord(db, templateId);
  if (!found) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  let next = input.document ?? found.stored.document;
  if (next.id !== templateId) {
    throw new ValidationError('TEMPLATE_INVALID', { detail: '/id must match the template being updated' });
  }
  if (input.label !== undefined) {
    const label = input.label.trim();
    next = parseStatementTemplate({ ...next, label });
    if (next.id !== templateId) {
      throw new ValidationError('TEMPLATE_INVALID', { detail: '/id must match the template being updated' });
    }
  }
  const meta = parseMeta(found.entry.meta_json);
  const res = await upsertRuleEntry(
    db,
    found.set.id,
    found.entry.id,
    {
      entry_key: next.id,
      priority: found.entry.priority,
      enabled: found.entry.enabled === 1,
      payload: next,
      meta,
    },
    found.set.revision,
    { source: 'api' },
  );
  return entryToStored(res.entry);
}

export async function deleteStatementTemplate(db: D1Database, templateId: string): Promise<void> {
  if (!TEMPLATE_ID.test(templateId)) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  const found = await findStatementTemplateRecord(db, templateId);
  if (!found) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  await deleteRuleEntry(db, found.set.id, found.entry.id, found.set.revision, { source: 'api' });
}

export function statementTemplateUsedStatement(
  db: D1Database,
  idempotencyKey: string,
  templateId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE rule_entries
     SET meta_json = json_set(
       COALESCE(meta_json, '{}'),
       '$.used_batch_id',
       (SELECT id FROM import_batches WHERE idempotency_key = ?)
     )
     WHERE rule_set_id IN (
       SELECT id FROM rule_sets WHERE domain = 'statement_templates' AND state = 'active'
     )
       AND entry_key = ?
       AND json_extract(COALESCE(meta_json, '{}'), '$.used_batch_id') IS NULL`,
  ).bind(idempotencyKey, templateId);
}

export async function refreshStatementTemplateEpoch(db: D1Database): Promise<void> {
  await bumpRulesEpoch(db);
}
