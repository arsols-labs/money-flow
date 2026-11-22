import { RULE_DOMAINS } from '../shared/rules';

export const RULES_READ_TOOLS = [
  'config_runtime_get',
  'rule_sets_list',
  'rule_set_get',
  'rule_preview_match',
  'rules_bundle_export',
  'recurring_policies_list',
] as const;

export const RULES_WRITE_TOOLS = [
  'rule_set_create',
  'rule_set_update',
  'rule_set_activate',
  'rule_set_retire',
  'rule_set_clone',
  'rule_set_delete',
  'rule_entry_upsert',
  'rule_entry_delete',
  'rules_bundle_import',
  'recurring_policy_create',
  'recurring_policy_state_update',
] as const;

export const RULES_NO_AUTO_CONFIRM = [
  'rule_set_delete',
  'rule_entry_delete',
  'rules_bundle_import',
] as const;

const WRITE_UI = {
  resourceUri: 'ui://write-confirm',
  visibility: ['model', 'app'],
  csp: { resourceDomains: [] as string[] },
};

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

export interface RulesToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: { ui: typeof WRITE_UI };
}

export function rulesToolDefinitions(notes: { mrtr: string; noAutoConfirm: string }): RulesToolDefinition[] {
  const idempotency = {
    type: 'string',
    description: 'Client-generated idempotency key, 8 to 200 characters.',
  };
  const requestState = {
    type: 'string',
    description: 'Token from the input_required response. Without it the tool writes nothing.',
  };

  return [
    {
      name: 'config_runtime_get',
      description: 'Read resolved runtime business configuration from D1 (currencies, FX anchor, base currency, fiscal formats, statement templates, PDF layouts, and per-domain readiness).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          country: { type: 'string' },
          as_of_date: { type: 'string' },
        },
      },
    },
    {
      name: 'rule_sets_list',
      description: 'List versioned rule sets in D1, optionally filtered by domain, state (draft/active/retired), scope_country, scope_locale, or set_key.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', enum: [...RULE_DOMAINS] },
          state: { type: 'string', enum: ['draft', 'active', 'retired'] },
          scope_country: { type: 'string' },
          scope_locale: { type: 'string' },
          set_key: { type: 'string' },
        },
      },
    },
    {
      name: 'rule_set_get',
      description: 'Read one rule set and all its rule entries from D1 by rule_set_id.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
        },
        required: ['rule_set_id'],
      },
    },
    {
      name: 'rule_preview_match',
      description: 'Dry-run evaluate active D1 rules against a sample string for a domain (fiscal_formats, merchant_aliases, delivery_services, venue_suffixes, order_hints, category_rules, pdf_layouts). Read-only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', enum: [...RULE_DOMAINS] },
          scope_country: { type: 'string' },
          scope_locale: { type: 'string' },
          as_of_date: { type: 'string' },
          sample: { type: 'string' },
          sample_secondary: { type: 'string' },
        },
        required: ['domain', 'sample'],
      },
    },
    {
      name: 'rules_bundle_export',
      description: 'Export versioned D1 rule sets and recurring policy bindings as a portable JSON bundle.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'recurring_policies_list',
      description: 'List country-scoped versioned recurring policy bindings from D1.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'rule_set_create',
      description: 'Create a country/locale-scoped versioned rule set (draft or active) with entries in D1. Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', enum: [...RULE_DOMAINS] },
          scope_country: { type: 'string' },
          scope_locale: { type: 'string' },
          set_key: { type: 'string' },
          state: { type: 'string', enum: ['draft', 'active'] },
          effective_from: { type: ['string', 'null'] },
          effective_to: { type: ['string', 'null'] },
          priority: { type: 'integer' },
          allow_shared_fallback: { type: 'boolean' },
          label: { type: 'string' },
          description: { type: ['string', 'null'] },
          entries: { type: 'array', items: { type: 'object' } },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['domain', 'scope_country', 'set_key', 'label', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, rule_set: { type: 'object' }, entries: { type: 'array', items: { type: 'object' } } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rule_set_update',
      description: 'Update metadata on a draft or active rule set using optimistic concurrency (expected_revision). Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
          expected_revision: { type: 'integer', minimum: 1 },
          scope_country: { type: 'string' },
          scope_locale: { type: 'string' },
          set_key: { type: 'string' },
          effective_from: { type: ['string', 'null'] },
          effective_to: { type: ['string', 'null'] },
          priority: { type: 'integer' },
          allow_shared_fallback: { type: 'boolean' },
          label: { type: 'string' },
          description: { type: ['string', 'null'] },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['rule_set_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, rule_set: { type: 'object' }, entries: { type: 'array', items: { type: 'object' } } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rule_set_activate',
      description: 'Activate a draft rule set in D1 after conflict checking, automatically retiring any prior active version of the same (domain, country, locale, set_key). Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
          expected_revision: { type: 'integer', minimum: 1 },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['rule_set_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, rule_set: { type: 'object' } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rule_set_retire',
      description: 'Retire an active or draft rule set in D1 (making it historical/immutable). Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
          expected_revision: { type: 'integer', minimum: 1 },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['rule_set_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, rule_set: { type: 'object' } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rule_set_clone',
      description: 'Clone an existing or retired rule set into a new version (draft or active). Useful for editing active/retired versions or rolling back. Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
          activate: { type: 'boolean' },
          label: { type: 'string' },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['rule_set_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, rule_set: { type: 'object' } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rule_set_delete',
      description: 'Delete a draft rule set. Active/retired sets must be retired, not deleted. ' + notes.noAutoConfirm + 'Requires scope "write" and human confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
          expected_revision: { type: 'integer', minimum: 1 },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['rule_set_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, ok: { type: 'boolean' } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rule_entry_upsert',
      description: 'Create or update a rule entry inside a draft or active rule set. Pass entry_id to update an existing entry, omit to create one. Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
          entry_id: { type: 'integer', minimum: 1 },
          expected_set_revision: { type: 'integer', minimum: 1 },
          entry_key: { type: 'string' },
          match_type: { type: ['string', 'null'] },
          match_field: { type: ['string', 'null'] },
          pattern: { type: ['string', 'null'] },
          priority: { type: 'integer' },
          enabled: { type: 'boolean' },
          payload: { type: 'object' },
          meta: { type: ['object', 'null'] },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['rule_set_id', 'entry_key', 'payload', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, rule_set: { type: 'object' }, entry: { type: 'object' } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rule_entry_delete',
      description: 'Delete a single entry from a draft or active rule set. ' + notes.noAutoConfirm + 'Requires scope "write" and human confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_set_id: { type: 'integer', minimum: 1 },
          entry_id: { type: 'integer', minimum: 1 },
          expected_set_revision: { type: 'integer', minimum: 1 },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['rule_set_id', 'entry_id', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, rule_set: { type: 'object' } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'rules_bundle_import',
      description: 'Import a rules JSON bundle into D1 (optionally replacing existing sets). ' + notes.noAutoConfirm + 'Requires scope "write" and human confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bundle: { type: 'object' },
          mode: { type: 'string', enum: ['merge', 'replace'] },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['bundle', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'recurring_policy_create',
      description: 'Create a country-scoped versioned recurring policy binding (for example analytical_skip_only) in D1. Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recurring_item_id: { type: 'integer', minimum: 1 },
          policy_type: { type: 'string' },
          scope_country: { type: 'string' },
          state: { type: 'string', enum: ['draft', 'active'] },
          effective_from: { type: ['string', 'null'] },
          effective_to: { type: ['string', 'null'] },
          priority: { type: 'integer' },
          notes: { type: ['string', 'null'] },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['recurring_item_id', 'policy_type', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, policy: { type: 'object' } } },
      _meta: { ui: WRITE_UI },
    },
    {
      name: 'recurring_policy_state_update',
      description: 'Transition a recurring policy binding state to active or retired in D1. Requires scope "write" and confirmation (MRTR).' + notes.mrtr,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          policy_id: { type: 'integer', minimum: 1 },
          state: { type: 'string', enum: ['active', 'retired'] },
          expected_revision: { type: 'integer', minimum: 1 },
          idempotency_key: idempotency,
          requestState,
        },
        required: ['policy_id', 'state', 'idempotency_key'],
      },
      outputSchema: { type: 'object', properties: { ...WRITE_OUTPUT, policy: { type: 'object' } } },
      _meta: { ui: WRITE_UI },
    },
  ];
}

export function rulesReadSpec(
  name: string,
  args: Record<string, unknown>,
): { error?: string; path?: string; method?: 'GET' | 'POST'; body?: string } {
  switch (name) {
    case 'config_runtime_get': {
      const sp = new URLSearchParams();
      if (typeof args.locale === 'string' && args.locale) sp.set('locale', args.locale);
      if (typeof args.country === 'string' && args.country) sp.set('country', args.country);
      if (typeof args.as_of_date === 'string' && args.as_of_date) sp.set('as_of_date', args.as_of_date);
      const q = sp.toString();
      return { method: 'GET', path: q ? `/config/runtime?${q}` : '/config/runtime' };
    }
    case 'rule_sets_list': {
      const sp = new URLSearchParams();
      for (const k of ['domain', 'state', 'scope_country', 'scope_locale', 'set_key'] as const) {
        if (typeof args[k] === 'string' && args[k]) sp.set(k, String(args[k]));
      }
      const q = sp.toString();
      return { method: 'GET', path: q ? `/rules/sets?${q}` : '/rules/sets' };
    }
    case 'rule_set_get': {
      if (typeof args.rule_set_id !== 'number' || !Number.isInteger(args.rule_set_id) || args.rule_set_id < 1) {
        return { error: 'Invalid rule_set_id' };
      }
      return { method: 'GET', path: `/rules/sets/${args.rule_set_id}` };
    }
    case 'rule_preview_match': {
      if (typeof args.domain !== 'string' || typeof args.sample !== 'string') {
        return { error: 'domain and sample are required' };
      }
      return {
        method: 'POST',
        path: '/rules/preview',
        body: JSON.stringify(args),
      };
    }
    case 'rules_bundle_export':
      return { method: 'GET', path: '/rules/export' };
    case 'recurring_policies_list':
      return { method: 'GET', path: '/rules/recurring-policies' };
    default:
      return { error: `Unknown rules read tool: ${name}` };
  }
}

export function validateRulesWrite(
  name: string,
  args: Record<string, unknown>,
  idempotencyKey: string,
): { error?: string; description?: string; confirmedArgs?: Record<string, unknown> } {
  const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1;
  switch (name) {
    case 'rule_set_create': {
      if (typeof args.domain !== 'string' || typeof args.set_key !== 'string' || typeof args.label !== 'string') {
        return { error: 'domain, set_key, and label are required' };
      }
      const { requestState: _rs, ...rest } = args;
      return {
        description: `Confirm creating ${args.state === 'active' ? 'active' : 'draft'} rule set "${args.set_key}" in domain ${args.domain} (${String(args.scope_country ?? 'SHARED')}).`,
        confirmedArgs: { ...rest, idempotency_key: idempotencyKey },
      };
    }
    case 'rule_set_update': {
      if (!posInt(args.rule_set_id)) return { error: 'Invalid rule_set_id' };
      const { requestState: _rs, ...rest } = args;
      return {
        description: `Confirm updating metadata of rule set #${args.rule_set_id}.`,
        confirmedArgs: { ...rest, idempotency_key: idempotencyKey },
      };
    }
    case 'rule_set_activate': {
      if (!posInt(args.rule_set_id)) return { error: 'Invalid rule_set_id' };
      return {
        description: `Confirm activating rule set #${args.rule_set_id} (prior active versions of the same key/scope will be retired).`,
        confirmedArgs: {
          rule_set_id: args.rule_set_id,
          ...(args.expected_revision !== undefined ? { expected_revision: args.expected_revision } : {}),
          idempotency_key: idempotencyKey,
        },
      };
    }
    case 'rule_set_retire': {
      if (!posInt(args.rule_set_id)) return { error: 'Invalid rule_set_id' };
      return {
        description: `Confirm retiring rule set #${args.rule_set_id}.`,
        confirmedArgs: {
          rule_set_id: args.rule_set_id,
          ...(args.expected_revision !== undefined ? { expected_revision: args.expected_revision } : {}),
          idempotency_key: idempotencyKey,
        },
      };
    }
    case 'rule_set_clone': {
      if (!posInt(args.rule_set_id)) return { error: 'Invalid rule_set_id' };
      return {
        description: `Confirm cloning rule set #${args.rule_set_id} into a new ${args.activate ? 'active' : 'draft'} version.`,
        confirmedArgs: {
          rule_set_id: args.rule_set_id,
          ...(args.activate !== undefined ? { activate: Boolean(args.activate) } : {}),
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
          idempotency_key: idempotencyKey,
        },
      };
    }
    case 'rule_set_delete': {
      if (!posInt(args.rule_set_id)) return { error: 'Invalid rule_set_id' };
      return {
        description: `Confirm permanently deleting draft rule set #${args.rule_set_id}.`,
        confirmedArgs: {
          rule_set_id: args.rule_set_id,
          ...(args.expected_revision !== undefined ? { expected_revision: args.expected_revision } : {}),
          idempotency_key: idempotencyKey,
        },
      };
    }
    case 'rule_entry_upsert': {
      if (!posInt(args.rule_set_id)) return { error: 'Invalid rule_set_id' };
      if (typeof args.entry_key !== 'string' || !args.payload || typeof args.payload !== 'object') {
        return { error: 'entry_key and payload object are required' };
      }
      const { requestState: _rs, ...rest } = args;
      const verb = posInt(args.entry_id) ? `updating entry #${args.entry_id}` : `adding entry "${args.entry_key}"`;
      return {
        description: `Confirm ${verb} in rule set #${args.rule_set_id}.`,
        confirmedArgs: { ...rest, idempotency_key: idempotencyKey },
      };
    }
    case 'rule_entry_delete': {
      if (!posInt(args.rule_set_id) || !posInt(args.entry_id)) return { error: 'Invalid rule_set_id or entry_id' };
      return {
        description: `Confirm deleting rule entry #${args.entry_id} from rule set #${args.rule_set_id}.`,
        confirmedArgs: {
          rule_set_id: args.rule_set_id,
          entry_id: args.entry_id,
          ...(args.expected_set_revision !== undefined ? { expected_set_revision: args.expected_set_revision } : {}),
          idempotency_key: idempotencyKey,
        },
      };
    }
    case 'rules_bundle_import': {
      if (!args.bundle || typeof args.bundle !== 'object') {
        return { error: 'bundle object is required' };
      }
      return {
        description: `Confirm importing rules bundle (mode: ${args.mode === 'replace' ? 'replace' : 'merge'}).`,
        confirmedArgs: {
          bundle: args.bundle,
          mode: args.mode === 'replace' ? 'replace' : 'merge',
          idempotency_key: idempotencyKey,
        },
      };
    }
    case 'recurring_policy_create': {
      if (!posInt(args.recurring_item_id) || typeof args.policy_type !== 'string') {
        return { error: 'recurring_item_id and policy_type are required' };
      }
      const { requestState: _rs, ...rest } = args;
      return {
        description: `Confirm creating recurring policy ${args.policy_type} for recurring item #${args.recurring_item_id}.`,
        confirmedArgs: { ...rest, idempotency_key: idempotencyKey },
      };
    }
    case 'recurring_policy_state_update': {
      if (!posInt(args.policy_id) || (args.state !== 'active' && args.state !== 'retired')) {
        return { error: 'policy_id and state (active|retired) are required' };
      }
      return {
        description: `Confirm changing recurring policy #${args.policy_id} to ${args.state}.`,
        confirmedArgs: {
          policy_id: args.policy_id,
          state: args.state,
          ...(args.expected_revision !== undefined ? { expected_revision: args.expected_revision } : {}),
          idempotency_key: idempotencyKey,
        },
      };
    }
    default:
      return { error: `Unknown rules write tool: ${name}` };
  }
}

export function rulesWriteRequest(
  name: string,
  args: Record<string, unknown>,
  origin: string,
  headers: Headers,
): Request | null {
  switch (name) {
    case 'rule_set_create':
      return new Request(new URL('/rules/sets', origin).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
    case 'rule_set_update': {
      const { rule_set_id, ...rest } = args;
      return new Request(new URL(`/rules/sets/${rule_set_id}`, origin).toString(), {
        method: 'PATCH',
        headers,
        body: JSON.stringify(rest),
      });
    }
    case 'rule_set_activate':
      return new Request(new URL(`/rules/sets/${args.rule_set_id}/activate`, origin).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ expected_revision: args.expected_revision }),
      });
    case 'rule_set_retire':
      return new Request(new URL(`/rules/sets/${args.rule_set_id}/retire`, origin).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ expected_revision: args.expected_revision }),
      });
    case 'rule_set_clone':
      return new Request(new URL(`/rules/sets/${args.rule_set_id}/clone`, origin).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ activate: args.activate, label: args.label }),
      });
    case 'rule_set_delete':
      return new Request(new URL(`/rules/sets/${args.rule_set_id}`, origin).toString(), {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ expected_revision: args.expected_revision }),
      });
    case 'rule_entry_upsert': {
      const { rule_set_id, entry_id, ...rest } = args;
      if (typeof entry_id === 'number' && Number.isInteger(entry_id) && entry_id > 0) {
        return new Request(new URL(`/rules/sets/${rule_set_id}/entries/${entry_id}`, origin).toString(), {
          method: 'PATCH',
          headers,
          body: JSON.stringify(rest),
        });
      }
      return new Request(new URL(`/rules/sets/${rule_set_id}/entries`, origin).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(rest),
      });
    }
    case 'rule_entry_delete':
      return new Request(new URL(`/rules/sets/${args.rule_set_id}/entries/${args.entry_id}`, origin).toString(), {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ expected_set_revision: args.expected_set_revision }),
      });
    case 'rules_bundle_import':
      return new Request(new URL('/rules/import', origin).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
    case 'recurring_policy_create':
      return new Request(new URL('/rules/recurring-policies', origin).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
    case 'recurring_policy_state_update':
      return new Request(new URL(`/rules/recurring-policies/${args.policy_id}`, origin).toString(), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ state: args.state, expected_revision: args.expected_revision }),
      });
    default:
      return null;
  }
}
