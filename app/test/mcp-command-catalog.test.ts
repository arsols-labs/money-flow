import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import mcpApp from '../src/worker/mcp-server';
import type { Env } from '../src/worker/types';
import {
  getMcpCommandCatalogEntry,
  MCP_COMMAND_CATALOG,
  MCP_COMMAND_CATALOG_BY_NAME,
} from '../src/worker/mcp-command-catalog';

interface ListedTool {
  name: string;
  description?: unknown;
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
}

async function listLiveTools(scopes: string[]): Promise<ListedTool[]> {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const res = await mcpApp.fetch(req, env as unknown as Env, {
    props: { scopes, clientId: 'catalog-completeness-test' },
  } as any);
  expect(res.status).toBe(200);
  const payload = (await res.json()) as {
    result?: { tools?: ListedTool[] };
    error?: unknown;
  };
  expect(payload.error).toBeUndefined();
  return payload.result?.tools ?? [];
}

describe('MCP command catalog', () => {
  it('describes every live tools/list tool once with no missing or extra entries', async () => {
    const liveTools = await listLiveTools(['read', 'write']);
    const liveNames = liveTools.map((tool) => tool.name);
    const liveNameSet = new Set(liveNames);

    const catalogNames = MCP_COMMAND_CATALOG.map((entry) => entry.name);
    const catalogNameSet = new Set(catalogNames);

    const duplicates = catalogNames.filter((name, index) => catalogNames.indexOf(name) !== index);
    expect(duplicates, `Duplicate catalog entries: ${duplicates.join(', ')}`).toEqual([]);

    const missingFromCatalog = liveNames.filter((name) => !catalogNameSet.has(name));
    expect(missingFromCatalog, `Live tools missing from catalog: ${missingFromCatalog.join(', ')}`).toEqual([]);

    const extraInCatalog = catalogNames.filter((name) => !liveNameSet.has(name));
    expect(extraInCatalog, `Catalog entries absent from tools/list: ${extraInCatalog.join(', ')}`).toEqual([]);

    expect(MCP_COMMAND_CATALOG).toHaveLength(liveTools.length);
    expect(MCP_COMMAND_CATALOG_BY_NAME.size).toBe(liveTools.length);

    for (const tool of liveTools) {
      expect(typeof tool.description, `${tool.name}: description must be a string`).toBe('string');
      expect((tool.description as string).trim().length, `${tool.name}: description must be non-empty`).toBeGreaterThan(0);
      expect(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name}: inputSchema must be an object`).toBe(true);
    }
  });

  it('requires every entry to provide required metadata and single-sentence purpose', () => {
    for (const entry of MCP_COMMAND_CATALOG) {
      expect(entry.name.trim().length, `Empty name`).toBeGreaterThan(0);
      expect(getMcpCommandCatalogEntry(entry.name)).toBe(entry);

      const purpose = entry.purpose.trim();
      expect(purpose.length, `${entry.name}: empty purpose`).toBeGreaterThan(0);
      expect(purpose.endsWith('.'), `${entry.name}: purpose must end with a period`).toBe(true);
      expect(
        /\.\s+\S/.test(purpose),
        `${entry.name}: purpose must be a single sentence, got "${purpose}"`
      ).toBe(false);

      expect(entry.whenToCall.trim().length, `${entry.name}: empty whenToCall`).toBeGreaterThan(0);
      expect(entry.whenNotToCall.trim().length, `${entry.name}: empty whenNotToCall`).toBeGreaterThan(0);
      expect(
        entry.confirmationPolicy.trim().length,
        `${entry.name}: empty confirmationPolicy`
      ).toBeGreaterThan(0);
    }

    expect(getMcpCommandCatalogEntry('nonexistent_tool_for_test')).toBeUndefined();
  });

  it('matches live read vs write scopes and auto_confirm schema exposure', async () => {
    const readTools = await listLiveTools(['read']);
    const writeTools = await listLiveTools(['write']);
    const allTools = await listLiveTools(['read', 'write']);

    const readNames = new Set(readTools.map((tool) => tool.name));
    const writeNames = new Set(writeTools.map((tool) => tool.name));
    const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));

    for (const entry of MCP_COMMAND_CATALOG) {
      if (entry.access === 'read') {
        expect(readNames.has(entry.name), `${entry.name} missing under read scope`).toBe(true);
        expect(writeNames.has(entry.name), `${entry.name} unexpectedly exposed under write-only scope`).toBe(false);
        expect(entry.writeConfirmation).toBe('not_applicable');
      } else {
        expect(writeNames.has(entry.name), `${entry.name} missing under write scope`).toBe(true);
        expect(readNames.has(entry.name), `${entry.name} unexpectedly exposed under read-only scope`).toBe(false);
        expect(entry.writeConfirmation).not.toBe('not_applicable');
      }

      const props = toolsByName.get(entry.name)?.inputSchema?.properties ?? {};
      const exposesAutoConfirm = Object.prototype.hasOwnProperty.call(props, 'auto_confirm');
      const shouldExposeAutoConfirm =
        entry.writeConfirmation === 'optional_auto_confirm' ||
        entry.writeConfirmation === 'default_auto_confirm' ||
        entry.writeConfirmation === 'conditional_auto_confirm' ||
        entry.writeConfirmation === 'unsupported';

      expect(
        exposesAutoConfirm,
        `${entry.name}: auto_confirm schema exposure (${exposesAutoConfirm}) mismatches writeConfirmation (${entry.writeConfirmation})`
      ).toBe(shouldExposeAutoConfirm);
    }
  });
});
