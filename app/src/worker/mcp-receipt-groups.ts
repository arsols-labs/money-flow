// MCP receipt-group tools. They call the receipt-group API.
// Unlink, delete, and rename never accept auto_confirm.

export const RECEIPT_GROUP_READ_TOOLS = ['receipt_groups_list', 'receipt_group_get'] as const;

export const RECEIPT_GROUP_WRITE_TOOLS = [
  'receipt_group_create',
  'receipt_group_receipt_unlink',
  'receipt_group_delete',
  'receipt_group_rename',
] as const;

export const RECEIPT_GROUP_NO_AUTO_CONFIRM = [
  'receipt_group_receipt_unlink',
  'receipt_group_delete',
  'receipt_group_rename',
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
};

const WRITE_UI = {
  resourceUri: 'ui://write-confirm',
  visibility: ['model', 'app'],
  csp: { resourceDomains: [] as string[] },
};

export interface ReceiptGroupToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  _meta?: { ui: typeof WRITE_UI };
}

export function receiptGroupToolDefinitions(notes: { mrtr: string; noAutoConfirm: string }): ReceiptGroupToolDefinition[] {
  const requestState = { type: 'string', description: 'Token from the input_required response. Without it the tool writes nothing.' };
  const idempotency = {
    type: 'string',
    description: 'Client-generated idempotency key, 8 to 200 characters. Reuse it with the same payload to read the saved result. A different payload returns IDEMPOTENCY_CONFLICT. Keys are kept until reset or backup replace.',
  };
  return [
    {
      name: 'receipt_groups_list',
      description: 'List manual receipt groups with their place of purchase, shared date (or latest member date for older multi-date groups), and one total. Search matches the group place/name, date, number, and the receipts inside it. Pagination happens after that match, so a matching receipt is not hidden by cutting the group list first. Omit limit to return every match.' + GROUPING,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string' },
          limit: { type: 'number', description: 'Page size from 1 to 100. Omit to return every match.' },
          cursor: { type: 'number', description: 'Exclusive id of the last group on the previous page. Requires limit.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          groups: { type: 'array' },
          next_cursor: { type: ['number', 'null'] },
          limit: { type: ['number', 'null'] },
          error: { type: 'string' },
        },
      },
    },
    {
      name: 'receipt_group_get',
      description: 'Read one manual receipt group, including the place where the goods were bought, the shared date (or latest member date for older multi-date groups), each receipt key, whether it still resolves, its original and base-currency amounts, the group total (in that currency for one currency, or converted to the base currency for mixed currencies), and any missing exchange rates.' + GROUPING,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: { type: 'number' },
        },
        required: ['group_id'],
      },
      outputSchema: {
        type: 'object',
        properties: { group: { type: 'object' }, error: { type: 'string' } },
      },
    },
    {
      name: 'receipt_group_create',
      description: 'Create one manual receipt group from at least two distinct receipt keys from the same calendar date (time of day may differ). One atomic write. Different calendar dates are rejected with RECEIPT_GROUP_DATE_MISMATCH. If name is omitted, the place where the goods were bought is resolved from the receipts (ignoring delivery intermediaries like Wolt when paired with the merchant); if the place cannot be determined, the request is rejected with RECEIPT_GROUP_PLACE_REQUIRED. A receipt already in any group rejects the whole request. Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          receipt_keys: { type: 'array', items: { type: 'string' }, description: 'Stable keys, pfr:<canonical> or op:<token>. At least two from the same calendar date, no duplicates.' },
          name: { type: ['string', 'null'], description: 'Place or group name. Optional when the place of purchase can be determined from the receipts; required when it cannot.' },
          idempotency_key: idempotency,
          auto_confirm: { type: 'boolean' },
          requestState,
        },
        required: ['receipt_keys', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { group: { type: 'object' }, ...WRITE_OUTPUT } },
    },
    {
      name: 'receipt_group_receipt_unlink',
      description: 'Remove one receipt from a manual group. The receipt and its operations stay. The group is deleted only when it becomes empty. ' + notes.noAutoConfirm + 'Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: { type: 'number' },
          receipt_key: { type: 'string' },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['group_id', 'receipt_key', 'idempotency_key'],
      },
      outputSchema: {
        type: 'object',
        properties: { group: { type: ['object', 'null'] }, unlinked: { type: 'boolean' }, ...WRITE_OUTPUT },
      },
    },
    {
      name: 'receipt_group_delete',
      description: 'Delete a manual receipt group and its links. Receipts and operations stay. ' + notes.noAutoConfirm + 'Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: { type: 'number' },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['group_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { deleted: { type: 'boolean' }, ...WRITE_OUTPUT } },
    },
    {
      name: 'receipt_group_rename',
      description: 'Rename a manual receipt group. A typed name is stored as the title. An empty name falls back to the place resolved from the member receipts; if that place cannot be resolved, the request is refused with RECEIPT_GROUP_PLACE_REQUIRED and nothing is saved. Membership, date, amounts, balances, and analytics totals stay unchanged. ' + notes.noAutoConfirm + 'Requires scope "write" and confirmation (MRTR).' + GROUPING + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: { type: 'number' },
          name: { type: ['string', 'null'], description: 'New title. Null or blank falls back to the resolved place of purchase, or is refused when that place cannot be determined.' },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['group_id', 'name', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { group: { type: 'object' }, ...WRITE_OUTPUT } },
    },
  ].map((tool) => (
    tool.name === 'receipt_groups_list' || tool.name === 'receipt_group_get'
      ? tool
      : { ...tool, _meta: { ui: WRITE_UI } }
  )) as ReceiptGroupToolDefinition[];
}

function rejected(args: Record<string, unknown>, allowed: string[], tool: string): string | null {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return null;
  return `Fields not allowed for ${tool}: ${extra.join(', ')}. Allowed fields: ${allowed.join(', ')}`;
}

function positiveId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

export function validateReceiptGroupWrite(
  name: string,
  args: Record<string, unknown>,
  idempotencyKey: string,
): { error?: string; description?: string; confirmedArgs?: Record<string, unknown> } {
  if (name === 'receipt_group_create') {
    const extra = rejected(args, ['receipt_keys', 'name', 'idempotency_key', 'requestState'], name);
    if (extra) return { error: extra };
    if (!Array.isArray(args.receipt_keys) || args.receipt_keys.length < 2) {
      return { error: 'receipt_keys must list at least two receipts' };
    }
    if (args.receipt_keys.some((key) => typeof key !== 'string')) return { error: 'receipt_keys must be strings' };
    const confirmed: Record<string, unknown> = {
      receipt_keys: args.receipt_keys,
      idempotency_key: idempotencyKey,
    };
    if ('name' in args) confirmed.name = args.name;
    return {
      description: `Confirm grouping ${args.receipt_keys.length} receipts. Operations, balances, analytics, and duplicate checks stay unchanged.`,
      confirmedArgs: confirmed,
    };
  }
  if (name === 'receipt_group_receipt_unlink') {
    const extra = rejected(args, ['group_id', 'receipt_key', 'idempotency_key', 'requestState'], name);
    if (extra) return { error: extra };
    const groupId = positiveId(args.group_id);
    if (groupId === null || typeof args.receipt_key !== 'string' || args.receipt_key.length === 0) {
      return { error: 'group_id and receipt_key are required' };
    }
    return {
      description: `Confirm removing one receipt from group ${groupId}. The receipt and its operations stay.`,
      confirmedArgs: { group_id: groupId, receipt_key: args.receipt_key, idempotency_key: idempotencyKey },
    };
  }
  if (name === 'receipt_group_delete') {
    const extra = rejected(args, ['group_id', 'idempotency_key', 'requestState'], name);
    if (extra) return { error: extra };
    const groupId = positiveId(args.group_id);
    if (groupId === null) return { error: 'Invalid group_id' };
    return {
      description: `Confirm deleting receipt group ${groupId}. Receipts and operations stay.`,
      confirmedArgs: { group_id: groupId, idempotency_key: idempotencyKey },
    };
  }
  if (name === 'receipt_group_rename') {
    const extra = rejected(args, ['group_id', 'name', 'idempotency_key', 'requestState'], name);
    if (extra) return { error: extra };
    const groupId = positiveId(args.group_id);
    if (groupId === null || !('name' in args)) return { error: 'group_id and name are required' };
    let renameName: string | null;
    if (args.name === null) renameName = null;
    else if (typeof args.name === 'string') {
      const trimmed = args.name.trim();
      if (trimmed.length > 120) return { error: 'name is too long' };
      renameName = trimmed.length > 0 ? trimmed : null;
    } else {
      return { error: 'name must be a string or null' };
    }
    const shown = renameName ?? 'the place resolved from its receipts';
    return {
      description: `Confirm renaming receipt group ${groupId} to ${shown}. Membership, date, amounts, balances, and analytics stay unchanged.`,
      confirmedArgs: { group_id: groupId, name: renameName, idempotency_key: idempotencyKey },
    };
  }
  return { error: `Unknown tool: ${name}` };
}

export function receiptGroupWriteRequest(
  name: string,
  args: Record<string, unknown>,
  origin: string,
  headers: Headers,
): Request | null {
  if (name === 'receipt_group_create') {
    return new Request(new URL('/receipt-groups', origin).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
  }
  if (name === 'receipt_group_receipt_unlink') {
    const url = new URL(
      `/receipt-groups/${args.group_id}/receipts/${encodeURIComponent(String(args.receipt_key))}`,
      origin,
    );
    url.searchParams.set('idempotency_key', String(args.idempotency_key));
    return new Request(url.toString(), { method: 'DELETE', headers });
  }
  if (name === 'receipt_group_delete') {
    const url = new URL(`/receipt-groups/${args.group_id}`, origin);
    url.searchParams.set('idempotency_key', String(args.idempotency_key));
    return new Request(url.toString(), { method: 'DELETE', headers });
  }
  if (name === 'receipt_group_rename') {
    return new Request(new URL(`/receipt-groups/${args.group_id}`, origin).toString(), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        name: args.name,
        idempotency_key: args.idempotency_key,
      }),
    });
  }
  return null;
}
