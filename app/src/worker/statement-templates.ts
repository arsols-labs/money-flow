import { ValidationError } from './api-error';
import {
  formatTemplateErrors,
  validateStatementTemplate,
  type StatementTemplate,
} from '../shared/statement-import/template-schema';
import { isBuiltinTemplateId } from '../shared/statement-import/templates';

export const STATEMENT_TEMPLATE_MAX_BYTES = 32_768;

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

interface TemplateRow {
  template_id: string;
  label: string;
  format: string;
  document: string;
  created_at: string;
  updated_at: string;
  created_via: string | null;
  created_by_client_id: string | null;
  used_batch_id: number | null;
}

const TEMPLATE_COLUMNS = `template_id, label, format, document, created_at, updated_at,
  created_via, created_by_client_id, used_batch_id`;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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

function rowToStored(row: TemplateRow): StoredStatementTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document);
  } catch {
    throw new ValidationError('TEMPLATE_INVALID', { detail: '/document must be JSON' });
  }
  const document = parseStatementTemplate(parsed);
  return {
    templateId: row.template_id,
    label: row.label,
    format: document.format,
    document,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdVia: row.created_via,
    createdByClientId: row.created_by_client_id,
    usedBatchId: row.used_batch_id,
  };
}

export function templateJson(template: StatementTemplate, source: 'builtin' | 'user', stamps?: {
  createdAt: string;
  updatedAt: string;
  createdVia?: string | null;
  usedBatchId?: number | null;
}) {
  return {
    source,
    readonly: source === 'builtin',
    document: template,
    created_at: stamps?.createdAt ?? null,
    updated_at: stamps?.updatedAt ?? null,
    created_via: stamps?.createdVia ?? null,
    used: stamps?.usedBatchId != null,
  };
}

export async function listStatementTemplates(db: D1Database): Promise<StoredStatementTemplate[]> {
  const { results } = await db.prepare(
    `SELECT ${TEMPLATE_COLUMNS}
     FROM statement_templates
     ORDER BY updated_at DESC, id DESC`,
  ).all<TemplateRow>();
  return results.map(rowToStored);
}

export async function getStatementTemplate(db: D1Database, templateId: string): Promise<StoredStatementTemplate | null> {
  if (!TEMPLATE_ID.test(templateId)) return null;
  const row = await db.prepare(
    `SELECT ${TEMPLATE_COLUMNS}
     FROM statement_templates WHERE template_id = ?`,
  ).bind(templateId).first<TemplateRow>();
  return row ? rowToStored(row) : null;
}

export async function insertStatementTemplate(
  db: D1Database,
  document: StatementTemplate,
  provenance: TemplateProvenance = { createdVia: 'api', createdByClientId: null },
): Promise<StoredStatementTemplate> {
  if (isBuiltinTemplateId(document.id)) {
    throw new ValidationError('TEMPLATE_ID_RESERVED', undefined, 409);
  }
  const existing = await getStatementTemplate(db, document.id);
  if (existing) throw new ValidationError('TEMPLATE_ID_TAKEN', undefined, 409);
  const stamp = nowIso();
  const encoded = JSON.stringify(document);
  try {
    const row = await db.prepare(
      `INSERT INTO statement_templates (
         template_id, label, format, document, created_at, updated_at, created_via, created_by_client_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${TEMPLATE_COLUMNS}`,
    ).bind(
      document.id,
      document.label,
      document.format,
      encoded,
      stamp,
      stamp,
      provenance.createdVia,
      provenance.createdByClientId,
    ).first<TemplateRow>();
    if (!row) throw new ValidationError('TEMPLATE_INVALID', { detail: '/ could not be saved' });
    return rowToStored(row);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if (/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) {
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
  if (isBuiltinTemplateId(templateId)) {
    throw new ValidationError('TEMPLATE_READONLY', undefined, 403);
  }
  const current = await getStatementTemplate(db, templateId);
  if (!current) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  let next = input.document ?? current.document;
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
  const stamp = nowIso();
  const row = await db.prepare(
    `UPDATE statement_templates
     SET label = ?, format = ?, document = ?, updated_at = ?
     WHERE template_id = ?
     RETURNING ${TEMPLATE_COLUMNS}`,
  ).bind(next.label, next.format, JSON.stringify(next), stamp, templateId).first<TemplateRow>();
  if (!row) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  return rowToStored(row);
}

export async function deleteStatementTemplate(db: D1Database, templateId: string): Promise<void> {
  if (isBuiltinTemplateId(templateId)) {
    throw new ValidationError('TEMPLATE_READONLY', undefined, 403);
  }
  if (!TEMPLATE_ID.test(templateId)) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
  const result = await db.prepare('DELETE FROM statement_templates WHERE template_id = ?').bind(templateId).run();
  if ((result.meta.changes ?? 0) < 1) throw new ValidationError('TEMPLATE_NOT_FOUND', undefined, 404);
}
