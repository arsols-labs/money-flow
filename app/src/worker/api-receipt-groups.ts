// Manual receipt-group HTTP API. Session and CSRF come from the parent /api/v2 app.
import { Hono } from 'hono';
import type { Env } from './types';
import { ValidationError, failCaught } from './api-error';
import {
  createReceiptGroup,
  deleteReceiptGroup,
  getReceiptGroup,
  listReceiptGroups,
  parseCreateReceiptGroup,
  parseIdempotencyKey,
  parseRenameReceiptGroup,
  renameReceiptGroup,
  unlinkReceiptGroupMember,
} from './receipt-groups';

const receiptGroupsApi = new Hono<{ Bindings: Env }>();

function isInternalMcp(c: { executionCtx?: unknown }): boolean {
  try {
    return (c.executionCtx as { isInternalMcp?: boolean } | undefined)?.isInternalMcp === true;
  } catch {
    return false;
  }
}

function idParam(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'id' });
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'id' });
  return id;
}

function optionalLimit(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'limit' });
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'limit' });
  }
  return limit;
}

function optionalCursor(value: string | undefined, limit: number | null): number | null {
  if (value === undefined || value === '') return null;
  if (limit === null) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'cursor' });
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'cursor' });
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'cursor' });
  return cursor;
}

function idempotencyFrom(c: { req: { query: (name: string) => string | undefined } }): string {
  return parseIdempotencyKey(c.req.query('idempotency_key'));
}

receiptGroupsApi.get('/', async (c) => {
  try {
    const limit = optionalLimit(c.req.query('limit'));
    const cursor = optionalCursor(c.req.query('cursor'), limit);
    const page = await listReceiptGroups(c.env.DB, {
      q: c.req.query('q') ?? '',
      limit,
      cursor,
    });
    return c.json(page);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

receiptGroupsApi.get('/:id', async (c) => {
  try {
    const group = await getReceiptGroup(c.env.DB, idParam(c.req.param('id')));
    return c.json({ group });
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

receiptGroupsApi.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const input = parseCreateReceiptGroup(body);
    const via = isInternalMcp(c) ? 'mcp' : 'api';
    const result = await createReceiptGroup(c.env.DB, input, via);
    return c.json(result.body, result.status);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

receiptGroupsApi.delete('/:id/receipts/*', async (c) => {
  try {
    const id = idParam(c.req.param('id'));
    const marker = `/receipt-groups/${id}/receipts/`;
    const path = c.req.path;
    const at = path.indexOf(marker);
    if (at < 0) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'receipt_key' });
    const receiptKey = decodeURIComponent(path.slice(at + marker.length));
    if (!receiptKey) throw new ValidationError('RECEIPT_GROUP_FIELD_INVALID', { field: 'receipt_key' });
    const result = await unlinkReceiptGroupMember(c.env.DB, id, receiptKey, idempotencyFrom(c));
    return c.json(result.body, result.status);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

receiptGroupsApi.patch('/:id', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const input = parseRenameReceiptGroup(idParam(c.req.param('id')), body);
    const result = await renameReceiptGroup(c.env.DB, input);
    return c.json(result.body, result.status);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

receiptGroupsApi.delete('/:id', async (c) => {
  try {
    const result = await deleteReceiptGroup(c.env.DB, idParam(c.req.param('id')), idempotencyFrom(c));
    return c.json(result.body, result.status);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

export default receiptGroupsApi;
