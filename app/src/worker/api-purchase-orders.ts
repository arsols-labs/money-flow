// Purchase-order HTTP API. Session and CSRF come from the parent /api/v2 app.
import { Hono } from 'hono';
import type { Env } from './types';
import { ValidationError, fail, failCaught } from './api-error';
import {
  deleteOrder,
  getProjectedOrder,
  linkComponent,
  listProjectedOrdersPage,
  parseComponentPatch,
  parseComponentWrite,
  parseOrderPatch,
  parseOrderWrite,
  patchOrder,
  unlinkComponent,
  updateComponent,
  upsertOrder,
} from './purchase-orders';

const purchaseOrdersApi = new Hono<{ Bindings: Env }>();

function isInternalMcp(c: { executionCtx?: unknown }): boolean {
  try {
    return (c.executionCtx as { isInternalMcp?: boolean } | undefined)?.isInternalMcp === true;
  } catch {
    return false;
  }
}

function idParam(value: string, field: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError('ORDER_FIELD_INVALID', { field });
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new ValidationError('ORDER_FIELD_INVALID', { field });
  return id;
}

function optionalLimit(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'limit' });
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new ValidationError('ORDER_FIELD_INVALID', { field: 'limit' });
  }
  return limit;
}

function optionalCursor(value: string | undefined, limit: number | null): number | null {
  if (value === undefined || value === '') return null;
  if (limit === null) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'cursor' });
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'cursor' });
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new ValidationError('ORDER_FIELD_INVALID', { field: 'cursor' });
  return cursor;
}

purchaseOrdersApi.get('/', async (c) => {
  try {
    const limit = optionalLimit(c.req.query('limit'));
    const cursor = optionalCursor(c.req.query('cursor'), limit);
    const page = await listProjectedOrdersPage(c.env.DB, {
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

purchaseOrdersApi.get('/:id', async (c) => {
  try {
    const id = idParam(c.req.param('id'), 'id');
    const order = await getProjectedOrder(c.env.DB, id);
    return c.json({ order });
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

purchaseOrdersApi.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const input = parseOrderWrite(body, false);
    const via = isInternalMcp(c) ? 'mcp' : 'api';
    const result = await upsertOrder(c.env.DB, input, via);
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

purchaseOrdersApi.patch('/:id', async (c) => {
  try {
    const id = idParam(c.req.param('id'), 'id');
    const current = await getProjectedOrder(c.env.DB, id);
    const body = await c.req.json().catch(() => null);
    const input = parseOrderPatch(body, current);
    const result = await patchOrder(c.env.DB, id, input);
    return c.json(result);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

purchaseOrdersApi.delete('/:id', async (c) => {
  try {
    const id = idParam(c.req.param('id'), 'id');
    const result = await deleteOrder(c.env.DB, id);
    return c.json(result);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

purchaseOrdersApi.post('/:id/components', async (c) => {
  try {
    const id = idParam(c.req.param('id'), 'id');
    const body = await c.req.json().catch(() => null);
    const input = parseComponentWrite(body);
    const result = await linkComponent(c.env.DB, id, input);
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

purchaseOrdersApi.post('/:id/components/:cid/reconfirm', (c) => (
  fail(c, 'OPERATION_LINK_UNSUPPORTED', 422)
));

purchaseOrdersApi.patch('/:id/components/:cid', async (c) => {
  try {
    const id = idParam(c.req.param('id'), 'id');
    const componentId = idParam(c.req.param('cid'), 'component_id');
    const current = await getProjectedOrder(c.env.DB, id);
    const component = current.components.find((item) => item.id === componentId);
    if (!component) return fail(c, 'COMPONENT_NOT_FOUND', 404);
    const body = await c.req.json().catch(() => null);
    const patch = parseComponentPatch(body, {
      id: component.id,
      component_type: component.component_type,
      target_kind: component.target_kind,
      pfr_canonical: component.pfr_canonical,
      expected_amount_minor: component.expected_amount_minor,
      expected_currency: component.expected_currency,
      label: component.label,
    });
    const result = await updateComponent(c.env.DB, id, componentId, patch);
    return c.json(result);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

purchaseOrdersApi.delete('/:id/components/:cid', async (c) => {
  try {
    const id = idParam(c.req.param('id'), 'id');
    const componentId = idParam(c.req.param('cid'), 'component_id');
    const result = await unlinkComponent(c.env.DB, id, componentId);
    return c.json(result);
  } catch (error) {
    if (error instanceof ValidationError) return failCaught(c, error);
    throw error;
  }
});

export default purchaseOrdersApi;
