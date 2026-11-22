import { describe, expect, it } from 'vitest';
import mcpApp from '../src/worker/mcp-server';
import { MCP_COMMAND_CATALOG } from '../src/worker/mcp-command-catalog';
import {
  MCP_DOCS_GROUPS,
  MCP_DOCS_INDEX_URI,
  MCP_DOCUMENTATION_RESOURCES,
} from '../src/worker/mcp-documentation';
import type { Env } from '../src/worker/types';
import { MCP_RULE_ENTRY_EXAMPLES } from '../src/worker/mcp-rule-examples';
import { RULE_DOMAINS, validateRuleEntryInput } from '../src/shared/rules';
import { STATEMENT_TEMPLATE_SCHEMA } from '../src/shared/statement-import/template-schema';

// No database, GitHub client, initialized session, or repository files are
// available to this client. It discovers and reads the bundled application docs.
async function rpc(scopes: string[], method: string, params: Record<string, unknown> = {}) {
  const response = await mcpApp.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), {} as Env, { props: { scopes } } as any);
  expect(response.status).toBe(200);
  return await response.json() as any;
}

describe('MCP application documentation', () => {
  it('serves valid synthetic payloads for every rule domain and the runtime statement schema', async () => {
    expect(Object.keys(MCP_RULE_ENTRY_EXAMPLES).sort()).toEqual([...RULE_DOMAINS].sort());
    const rules = (await rpc(['read'], 'resources/read', { uri: `${MCP_DOCS_INDEX_URI}rules` })).result.contents[0].text;
    for (const domain of RULE_DOMAINS) {
      const entry = MCP_RULE_ENTRY_EXAMPLES[domain];
      const result = validateRuleEntryInput(domain, entry);
      expect(result.ok, `${domain}: ${JSON.stringify(result)}`).toBe(true);
      expect(rules).toContain(JSON.stringify(entry, null, 2));
    }
    const statements = (await rpc(['read'], 'resources/read', { uri: `${MCP_DOCS_INDEX_URI}statements` })).result.contents[0].text;
    expect(statements).toContain(JSON.stringify(STATEMENT_TEMPLATE_SCHEMA, null, 2));
  });
  it.each([['read'], ['write'], ['read', 'write']])(
    'discovers and reads the entire documentation tree with scopes %j without initialize',
    async (...scopes: string[]) => {
      const listing = await rpc(scopes, 'resources/list');
      expect(listing.error).toBeUndefined();
      const docs = listing.result.resources.filter((resource: any) => resource.uri.startsWith(MCP_DOCS_INDEX_URI));
      expect(docs).toEqual(MCP_DOCUMENTATION_RESOURCES);
      expect(new Set(docs.map((resource: any) => resource.uri)).size).toBe(docs.length);
      expect(docs).toHaveLength(MCP_DOCS_GROUPS.length + 1);

      for (const resource of docs) {
        const page = await rpc(scopes, 'resources/read', { uri: resource.uri });
        expect(page.error).toBeUndefined();
        expect(page.result.contents).toHaveLength(1);
        expect(page.result.contents[0]).toMatchObject({ uri: resource.uri, mimeType: 'text/markdown' });
        expect(page.result.contents[0].text.length).toBeGreaterThan(100);
      }
    },
  );

  it('indexes every page and publishes each live tool exactly once from the catalog', async () => {
    const scopes = ['read', 'write'];
    const listing = await rpc(scopes, 'resources/list');
    const index = (await rpc(scopes, 'resources/read', { uri: MCP_DOCS_INDEX_URI })).result.contents[0].text as string;
    const pageUris = listing.result.resources
      .map((resource: any) => resource.uri as string)
      .filter((uri: string) => uri.startsWith(MCP_DOCS_INDEX_URI) && uri !== MCP_DOCS_INDEX_URI);
    const links = [...index.matchAll(/\]\((money-flow:\/\/docs\/[^)]+)\)/g)].map((match) => match[1]);
    expect(links.sort()).toEqual([...pageUris].sort());

    const publishedNames: string[] = [];
    for (const uri of pageUris) {
      const text = (await rpc(scopes, 'resources/read', { uri })).result.contents[0].text as string;
      const names = [...text.matchAll(/^## (\w+)$/gm)].map((match) => match[1]!);
      expect(names.length).toBeGreaterThan(0);
      publishedNames.push(...names);
      for (const name of names) {
        const entry = MCP_COMMAND_CATALOG.find((candidate) => candidate.name === name)!;
        expect(entry, `${name} must come from catalog`).toBeDefined();
        expect(uri).toBe(`${MCP_DOCS_INDEX_URI}${entry.group}`);
        for (const field of [entry.purpose, entry.whenToCall, entry.whenNotToCall, entry.confirmationPolicy]) {
          expect(text).toContain(field);
        }
      }
    }
    const liveNames = (await rpc(scopes, 'tools/list')).result.tools.map((tool: any) => tool.name).sort();
    expect(publishedNames.sort()).toEqual(liveNames);
    expect(new Set(publishedNames).size).toBe(publishedNames.length);
    expect(publishedNames).toHaveLength(MCP_COMMAND_CATALOG.length);
  });

  it('denies listing and every documentation read without a supported scope', async () => {
    for (const scopes of [[], ['unrelated']]) {
      expect((await rpc(scopes, 'resources/list')).error.code).toBe(-32001);
      for (const resource of MCP_DOCUMENTATION_RESOURCES) {
        const result = await rpc(scopes, 'resources/read', { uri: resource.uri });
        expect(result.error.code).toBe(-32001);
        expect(result.result).toBeUndefined();
      }
    }
  });

  it('does not grant write-only clients access to read tools or dashboard resources', async () => {
    const tools = (await rpc(['write'], 'tools/list')).result.tools.map((tool: any) => tool.name);
    expect(tools).not.toContain('accounts_list');
    for (const uri of ['ui://pulse', 'ui://analytics']) {
      expect((await rpc(['write'], 'resources/read', { uri })).error.code).toBe(-32001);
    }
    expect((await rpc(['read'], 'resources/read', { uri: 'ui://write-confirm' })).error.code).toBe(-32001);
  });

  it('rejects unknown documentation URIs rather than returning an unrelated page', async () => {
    for (const uri of ['money-flow://docs/missing', 'money-flow://docs/rules/extra']) {
      expect((await rpc(['read', 'write'], 'resources/read', { uri })).error.code).toBe(-32602);
    }
  });

  it('explains confirmation exceptions and preserves accepted minimal configuration rules', async () => {
    const index = (await rpc(['read'], 'resources/read', { uri: MCP_DOCS_INDEX_URI })).result.contents[0].text;
    expect(index).toContain('No confirmation means no write.');
    expect(index).toContain('fx_rate_set, where auto_confirm=false is required');
    expect(index).toContain('get confirmation before calling statement_import_upload_create');
    expect(index).toContain('"not stated"');
    const rules = (await rpc(['read'], 'resources/read', { uri: `${MCP_DOCS_INDEX_URI}rules` })).result.contents[0].text;
    expect(rules).toContain('Empty optional lists are normal.');
    expect(rules).toContain('only USD with minor_digits=2 and is_fx_anchor=true');
    expect(rules).toContain('Policies must never post operations or move money.');
    expect(rules).toContain('rule_preview_match evaluates active rules only');
  });

  it('publishes initialize serverInfo metadata and instructions pointing to tools/list and money-flow://docs/', async () => {
    const init = await rpc([], 'initialize', { protocolVersion: '2026-07-28', capabilities: {} });
    expect(init.error).toBeUndefined();
    expect(init.result.serverInfo.title).toBe('Money Flow');
    expect(init.result.serverInfo.description).toContain(MCP_DOCS_INDEX_URI);
    expect(init.result.serverInfo.description).toContain('tools/list');
    expect(init.result.instructions).toContain(MCP_DOCS_INDEX_URI);
    expect(init.result.instructions).toContain('tools/list');

    const index = (await rpc(['read'], 'resources/read', { uri: MCP_DOCS_INDEX_URI })).result.contents[0].text;
    expect(index).toContain('per-command descriptions and argument schemas');
    expect(index).toContain('without a prior initialize handshake');
  });
});
