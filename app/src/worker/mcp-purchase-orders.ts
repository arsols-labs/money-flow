// MCP purchase-order tools. Grouping only. Writes confirm by default.
// Unlink and delete never accept auto_confirm.

import { OPERATION_LINK_UNSUPPORTED_MESSAGE } from '../shared/purchase-orders';

export const PURCHASE_READ_TOOLS = ['purchase_orders_list', 'purchase_order_get'] as const;

export const PURCHASE_WRITE_TOOLS = [
  'purchase_order_upsert',
  'purchase_order_update',
  'purchase_order_component_link',
  'purchase_order_component_update',
  'purchase_order_component_reconfirm',
  'purchase_order_component_unlink',
  'purchase_order_delete',
] as const;

export const PURCHASE_NO_AUTO_CONFIRM = [
  'purchase_order_component_unlink',
  'purchase_order_delete',
] as const;

const GROUPING = ' Grouping only; does not change operations, balances, analytics, or duplicate checks.';

const WRITE_OUTPUT = {
  resultType: { type: 'string' },
  requestState: { type: 'string' },
  description: { type: 'string' },
  written: { type: 'boolean' },
  tool: { type: 'string' },
  idempotency_key: { type: 'string' },
  arguments: { type: 'object' },
  error: { type: 'string' },
  operation_count_unchanged: { type: 'boolean' },
  balance_unchanged: { type: 'boolean' },
};

const WRITE_UI = {
  resourceUri: 'ui://write-confirm',
  visibility: ['model', 'app'],
  csp: { resourceDomains: [] as string[] },
};

export interface PurchaseOrderToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  _meta?: { ui: typeof WRITE_UI };
}

export function purchaseOrderToolDefinitions(notes: { mrtr: string; noAutoConfirm: string }): PurchaseOrderToolDefinition[] {
  const requestState = { type: 'string', description: 'Token from the input_required response. Without it the tool writes nothing.' };
  return [
    {
      name: 'purchase_orders_list',
      description: 'List and search purchase orders. A shared date does not create a group and does not put receipts into one. Filter text matches provider, provider order id, note, date text, canonical PFR, and component label. Use limit and cursor to page. Omit limit to return every match.' + GROUPING,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', description: 'Optional search text. Matching a date only filters; it does not group receipts.' },
          limit: { type: 'number', description: 'Page size from 1 to 100. Omit to return every match.' },
          cursor: { type: 'number', description: 'Exclusive id of the last order on the previous page. Requires limit.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          orders: { type: 'array' },
          next_cursor: { type: ['number', 'null'] },
          limit: { type: ['number', 'null'] },
          error: { type: 'string' },
        },
      },
    },
    {
      name: 'purchase_order_get',
      description: 'Read one purchase order with its components, linked fiscal receipts, posted spend net of refunds, expected amounts, status, conflict flag, and difference. Grouping only. Does not change operations, balances, or analytics.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'number', description: 'Purchase order id from purchase_orders_list or purchase_order_upsert.' },
        },
        required: ['order_id'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          order: { type: 'object' },
          error: { type: 'string' },
        },
      },
    },
    {
      name: 'purchase_order_upsert',
      description: 'Create a purchase order or return the existing one for the same provider and provider_order_id. The first writer wins; a repeat does not overwrite. Change fields with the app, not by repeating this call. Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: 'Slug such as wolt, glovo, or other' },
          provider_order_id: { type: 'string' },
          order_date: { type: ['string', 'null'] },
          order_total_minor: { type: ['number', 'null'], description: 'Optional declared spend in minor units, >= 0' },
          order_total_currency: { type: ['string', 'null'] },
          order_total_source: { type: 'string', enum: ['provider_document', 'fiscal_document'] },
          order_total_reference: { type: ['string', 'null'], description: 'Free text, not a URL' },
          note: { type: ['string', 'null'] },
          idempotency_key: { type: 'string' },
          auto_confirm: { type: 'boolean' },
          requestState,
        },
        required: ['provider', 'provider_order_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { created: { type: 'boolean' }, order: { type: 'object' }, ...WRITE_OUTPUT } },
    },
    {
      name: 'purchase_order_update',
      description: 'Edit purchase-order metadata: date, declared total, source, reference, and note. Provider and provider_order_id stay as first written. Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'number' },
          order_date: { type: ['string', 'null'] },
          order_total_minor: { type: ['number', 'null'], description: 'Declared spend in minor units, >= 0, or null to clear' },
          order_total_currency: { type: ['string', 'null'] },
          order_total_source: { type: ['string', 'null'], description: 'provider_document or fiscal_document, or null to clear' },
          order_total_reference: { type: ['string', 'null'] },
          note: { type: ['string', 'null'] },
          idempotency_key: { type: 'string' },
          auto_confirm: { type: 'boolean' },
          requestState,
        },
        required: ['order_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { order: { type: 'object' }, ...WRITE_OUTPUT } },
    },
    {
      name: 'purchase_order_component_link',
      description: 'Link a fiscal receipt id (PFR) or an expected, not-posted component to an order. Operation-id links are unsupported and return OPERATION_LINK_UNSUPPORTED. Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'number' },
          component_type: { type: 'string', enum: ['goods', 'service_fee', 'delivery_fee', 'tip', 'discount', 'refund', 'other'] },
          target_kind: { type: 'string', enum: ['pfr', 'expected', 'operation'] },
          fiscal_receipt_id: { type: ['string', 'null'] },
          operation_id: { type: ['number', 'null'], description: 'Unsupported. A value here returns OPERATION_LINK_UNSUPPORTED.' },
          expected_amount_minor: { type: ['number', 'null'], description: 'Signed spend contribution. Positive charge, negative discount or refund. Never posted.' },
          expected_currency: { type: ['string', 'null'] },
          label: { type: ['string', 'null'] },
          idempotency_key: { type: 'string' },
          auto_confirm: { type: 'boolean' },
          requestState,
        },
        required: ['order_id', 'component_type', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { created: { type: 'boolean' }, component_id: { type: 'number' }, order: { type: 'object' }, ...WRITE_OUTPUT } },
    },
    {
      name: 'purchase_order_component_update',
      description: 'Edit one component. component_type is the role (goods, delivery fee, and the other roles). For a PFR component, fiscal_receipt_id relinks that same component to another existing receipt and does not move or delete the operation. For an expected component, edit the expected amount, currency, and label. Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'number' },
          component_id: { type: 'number' },
          component_type: { type: 'string', enum: ['goods', 'service_fee', 'delivery_fee', 'tip', 'discount', 'refund', 'other'] },
          fiscal_receipt_id: { type: 'string', description: 'New PFR for a PFR component. Canonicalized before the unique check.' },
          expected_amount_minor: { type: 'number', description: 'Signed expected spend. Expected components only.' },
          expected_currency: { type: 'string' },
          label: { type: ['string', 'null'] },
          idempotency_key: { type: 'string' },
          auto_confirm: { type: 'boolean' },
          requestState,
        },
        required: ['order_id', 'component_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { component_id: { type: 'number' }, order: { type: 'object' }, ...WRITE_OUTPUT } },
    },
    {
      name: 'purchase_order_component_reconfirm',
      description: 'Unsupported. There is no operation fingerprint to reconfirm. ' + OPERATION_LINK_UNSUPPORTED_MESSAGE + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'number' },
          component_id: { type: 'number' },
          idempotency_key: { type: 'string' },
          requestState,
        },
        required: ['order_id', 'component_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT } },
    },
    {
      name: 'purchase_order_component_unlink',
      description: 'Unlink one order component. Operations are not deleted. ' + notes.noAutoConfirm + 'Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'number' },
          component_id: { type: 'number' },
          idempotency_key: { type: 'string' },
          requestState,
        },
        required: ['order_id', 'component_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, order: { type: 'object' }, ...WRITE_OUTPUT } },
    },
    {
      name: 'purchase_order_delete',
      description: 'Delete an order and its links. Operations and balances stay. ' + notes.noAutoConfirm + 'Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'number' },
          idempotency_key: { type: 'string' },
          requestState,
        },
        required: ['order_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, ...WRITE_OUTPUT } },
    },
  ].map((tool) => (
    tool.name === 'purchase_orders_list' || tool.name === 'purchase_order_get'
      ? tool
      : { ...tool, _meta: { ui: WRITE_UI } }
  )) as PurchaseOrderToolDefinition[];
}

function rejected(args: Record<string, unknown>, allowed: string[], tool: string): string | null {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return null;
  return `Fields not allowed for ${tool}: ${extra.join(', ')}. Allowed fields: ${allowed.join(', ')}`;
}

function positiveId(value: unknown, field: string): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

export function validatePurchaseOrderWrite(
  name: string,
  args: Record<string, unknown>,
  idempotencyKey: string,
): { error?: string; description?: string; confirmedArgs?: Record<string, unknown> } {
  if (name === 'purchase_order_component_reconfirm') {
    return { error: OPERATION_LINK_UNSUPPORTED_MESSAGE };
  }
  if (name === 'purchase_order_upsert') {
    const allowed = [
      'provider', 'provider_order_id', 'order_date', 'order_total_minor', 'order_total_currency',
      'order_total_source', 'order_total_reference', 'note', 'idempotency_key', 'requestState',
    ];
    const extra = rejected(args, allowed, name);
    if (extra) return { error: extra };
    if (typeof args.provider !== 'string' || typeof args.provider_order_id !== 'string') {
      return { error: 'provider and provider_order_id are required' };
    }
    const confirmed: Record<string, unknown> = {
      provider: args.provider,
      provider_order_id: args.provider_order_id,
      idempotency_key: idempotencyKey,
    };
    for (const field of ['order_date', 'order_total_minor', 'order_total_currency', 'order_total_source', 'order_total_reference', 'note']) {
      if (field in args) confirmed[field] = args[field];
    }
    return {
      description: `Confirm saving purchase order ${args.provider} ${args.provider_order_id}. Grouping only: operations, balances, analytics, and duplicate checks stay unchanged.`,
      confirmedArgs: confirmed,
    };
  }
  if (name === 'purchase_order_update') {
    const allowed = [
      'order_id', 'order_date', 'order_total_minor', 'order_total_currency',
      'order_total_source', 'order_total_reference', 'note', 'idempotency_key', 'requestState',
    ];
    const extra = rejected(args, allowed, name);
    if (extra) return { error: extra };
    const orderId = positiveId(args.order_id, 'order_id');
    if (orderId === null) return { error: 'Invalid order_id' };
    const editable = ['order_date', 'order_total_minor', 'order_total_currency', 'order_total_source', 'order_total_reference', 'note'];
    if (!editable.some((field) => field in args)) return { error: 'At least one metadata field is required' };
    const confirmed: Record<string, unknown> = { order_id: orderId, idempotency_key: idempotencyKey };
    for (const field of editable) {
      if (field in args) confirmed[field] = args[field];
    }
    return {
      description: `Confirm editing purchase order ${orderId}. Provider and provider order id stay unchanged. Operations, balances, analytics, and duplicate checks stay unchanged.`,
      confirmedArgs: confirmed,
    };
  }
  if (name === 'purchase_order_component_link') {
    const allowed = [
      'order_id', 'component_type', 'target_kind', 'fiscal_receipt_id', 'operation_id',
      'expected_amount_minor', 'expected_currency', 'label', 'idempotency_key', 'requestState',
    ];
    const extra = rejected(args, allowed, name);
    if (extra) return { error: extra };
    if (args.target_kind === 'operation' || (args.operation_id !== undefined && args.operation_id !== null)) {
      return { error: OPERATION_LINK_UNSUPPORTED_MESSAGE };
    }
    const orderId = positiveId(args.order_id, 'order_id');
    if (orderId === null) return { error: 'Invalid order_id' };
    if (typeof args.component_type !== 'string') return { error: 'component_type is required' };
    const confirmed: Record<string, unknown> = {
      order_id: orderId,
      component_type: args.component_type,
      idempotency_key: idempotencyKey,
    };
    for (const field of ['target_kind', 'fiscal_receipt_id', 'expected_amount_minor', 'expected_currency', 'label']) {
      if (field in args) confirmed[field] = args[field];
    }
    const target = typeof args.fiscal_receipt_id === 'string' && args.fiscal_receipt_id.trim()
      ? `PFR ${args.fiscal_receipt_id.trim()}`
      : `expected ${String(args.expected_amount_minor)} ${String(args.expected_currency ?? '')}`;
    return {
      description: `Confirm linking ${target} to purchase order ${orderId} as ${args.component_type}. Grouping only: operations, balances, analytics, and duplicate checks stay unchanged.`,
      confirmedArgs: confirmed,
    };
  }
  if (name === 'purchase_order_component_update') {
    const allowed = [
      'order_id', 'component_id', 'component_type', 'fiscal_receipt_id',
      'expected_amount_minor', 'expected_currency', 'label', 'idempotency_key', 'requestState',
    ];
    const extra = rejected(args, allowed, name);
    if (extra) return { error: extra };
    const orderId = positiveId(args.order_id, 'order_id');
    const componentId = positiveId(args.component_id, 'component_id');
    if (orderId === null || componentId === null) return { error: 'Invalid order_id or component_id' };
    const editable = ['component_type', 'fiscal_receipt_id', 'expected_amount_minor', 'expected_currency', 'label'];
    if (!editable.some((field) => field in args)) return { error: 'At least one component field is required' };
    const confirmed: Record<string, unknown> = {
      order_id: orderId,
      component_id: componentId,
      idempotency_key: idempotencyKey,
    };
    for (const field of editable) {
      if (field in args) confirmed[field] = args[field];
    }
    return {
      description: `Confirm editing component ${componentId} on purchase order ${orderId}. The fiscal documents and operations stay in the ledger.`,
      confirmedArgs: confirmed,
    };
  }
  if (name === 'purchase_order_component_unlink') {
    const extra = rejected(args, ['order_id', 'component_id', 'idempotency_key', 'requestState'], name);
    if (extra) return { error: extra };
    const orderId = positiveId(args.order_id, 'order_id');
    const componentId = positiveId(args.component_id, 'component_id');
    if (orderId === null || componentId === null) return { error: 'Invalid order_id or component_id' };
    return {
      description: `Confirm unlinking component ${componentId} from purchase order ${orderId}. The operation rows stay.`,
      confirmedArgs: { order_id: orderId, component_id: componentId, idempotency_key: idempotencyKey },
    };
  }
  if (name === 'purchase_order_delete') {
    const extra = rejected(args, ['order_id', 'idempotency_key', 'requestState'], name);
    if (extra) return { error: extra };
    const orderId = positiveId(args.order_id, 'order_id');
    if (orderId === null) return { error: 'Invalid order_id' };
    return {
      description: `Confirm deleting purchase order ${orderId} and its links. Operations and balances stay.`,
      confirmedArgs: { order_id: orderId, idempotency_key: idempotencyKey },
    };
  }
  return { error: `Unknown tool: ${name}` };
}

export function purchaseOrderWriteRequest(
  name: string,
  args: Record<string, unknown>,
  origin: string,
  headers: Headers,
): Request | null {
  if (name === 'purchase_order_upsert') {
    const { idempotency_key: _ignored, ...body } = args;
    return new Request(new URL('/purchase-orders', origin).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }
  if (name === 'purchase_order_update') {
    const { order_id, idempotency_key: _ignored, ...body } = args;
    return new Request(new URL(`/purchase-orders/${order_id}`, origin).toString(), {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  }
  if (name === 'purchase_order_component_link') {
    const { order_id, idempotency_key: _ignored, ...body } = args;
    return new Request(new URL(`/purchase-orders/${order_id}/components`, origin).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }
  if (name === 'purchase_order_component_update') {
    const { order_id, component_id, idempotency_key: _ignored, ...body } = args;
    return new Request(new URL(`/purchase-orders/${order_id}/components/${component_id}`, origin).toString(), {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  }
  if (name === 'purchase_order_component_unlink') {
    return new Request(new URL(`/purchase-orders/${args.order_id}/components/${args.component_id}`, origin).toString(), {
      method: 'DELETE',
      headers,
    });
  }
  if (name === 'purchase_order_delete') {
    return new Request(new URL(`/purchase-orders/${args.order_id}`, origin).toString(), {
      method: 'DELETE',
      headers,
    });
  }
  if (name === 'purchase_order_component_reconfirm') {
    return new Request(new URL(`/purchase-orders/${args.order_id}/components/${args.component_id}/reconfirm`, origin).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
  }
  return null;
}
