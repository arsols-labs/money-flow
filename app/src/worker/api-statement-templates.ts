import { Hono } from 'hono';
import { ValidationError, fail, failCaught } from './api-error';
import { BodyTooLargeError, readLimitedJson } from './limited-body';
import { BUILTIN_TEMPLATES } from '../shared/statement-import/templates';
import {
  STATEMENT_TEMPLATE_MAX_BYTES,
  deleteStatementTemplate,
  getStatementTemplate,
  insertStatementTemplate,
  listStatementTemplates,
  parseStatementTemplate,
  templateJson,
  updateStatementTemplate,
} from './statement-templates';
import type { Env } from './types';

const statementTemplatesApi = new Hono<{ Bindings: Env }>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readTemplateBody(request: Request): Promise<unknown> {
  try {
    return await readLimitedJson(request, STATEMENT_TEMPLATE_MAX_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new ValidationError('TEMPLATE_INVALID', { detail: '/ document is too large' });
    }
    if (error instanceof SyntaxError) {
      throw new ValidationError('TEMPLATE_INVALID', { detail: '/ must be JSON' });
    }
    throw error;
  }
}

statementTemplatesApi.get('/statement-templates', async (c) => {
  const stored = await listStatementTemplates(c.env.DB);
  return c.json({
    templates: [
      ...BUILTIN_TEMPLATES.map((template) => templateJson(template, 'builtin')),
      ...stored.map((row) => templateJson(row.document, 'user', row)),
    ],
  });
});

statementTemplatesApi.post('/statement-templates', async (c) => {
  try {
    const body = await readTemplateBody(c.req.raw);
    const document = parseStatementTemplate(body);
    const stored = await insertStatementTemplate(c.env.DB, document);
    return c.json(templateJson(stored.document, 'user', stored), 201);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementTemplatesApi.get('/statement-templates/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const builtin = BUILTIN_TEMPLATES.find((template) => template.id === id);
  if (builtin) return c.json(templateJson(builtin, 'builtin'));
  const stored = await getStatementTemplate(c.env.DB, id);
  if (!stored) return fail(c, 'TEMPLATE_NOT_FOUND', 404);
  return c.json(templateJson(stored.document, 'user', stored));
});

statementTemplatesApi.patch('/statement-templates/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readTemplateBody(c.req.raw);
    if (!isPlainObject(body)) throw new ValidationError('TEMPLATE_INVALID', { detail: '/ must be an object' });
    const patch: { label?: string; document?: ReturnType<typeof parseStatementTemplate> } = {};
    if (body.document !== undefined) patch.document = parseStatementTemplate(body.document);
    if (body.label !== undefined) {
      if (typeof body.label !== 'string') throw new ValidationError('TEMPLATE_INVALID', { detail: '/label must be a string' });
      patch.label = body.label;
    }
    if (patch.document === undefined && patch.label === undefined) {
      throw new ValidationError('TEMPLATE_INVALID', { detail: '/label or /document is required' });
    }
    const stored = await updateStatementTemplate(c.env.DB, id, patch);
    return c.json(templateJson(stored.document, 'user', stored));
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

statementTemplatesApi.delete('/statement-templates/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    await deleteStatementTemplate(c.env.DB, id);
    return c.json({ ok: true, id });
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

export default statementTemplatesApi;
