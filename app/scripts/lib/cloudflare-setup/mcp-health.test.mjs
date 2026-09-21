import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { probeMcpHealth, waitForMcpHealth } from './mcp-health.mjs';

describe('probeMcpHealth', () => {
  it('passes when /mcp and OAuth discovery return JSON', async () => {
    const result = await probeMcpHealth('https://app.example.com', {
      fetchImpl: async (url) => {
        if (String(url).endsWith('/mcp')) {
          return { status: 200, json: async () => ({ status: 'ok' }) };
        }
        return {
          status: 200,
          json: async () => ({ issuer: 'https://app.example.com' }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mcp.ok, true);
    assert.equal(result.oauth.ok, true);
  });

  it('fails closed on HTTP errors without throwing', async () => {
    const result = await probeMcpHealth('https://app.example.com', {
      fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.mcp.ok, false);
    assert.equal(result.oauth.ok, false);
  });

  it('soft-fails when fetch never resolves instead of hanging', async () => {
    const result = await probeMcpHealth('https://app.example.com', {
      timeoutMs: 40,
      fetchImpl: () => new Promise(() => {}),
    });
    assert.equal(result.ok, false);
    assert.match(result.mcp.error, /timed out after 40ms/);
    assert.match(result.oauth.error, /timed out after 40ms/);
  });

  it('soft-fails when fetch throws', async () => {
    const result = await probeMcpHealth('https://app.example.com', {
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.mcp.error, /boom/);
    assert.match(result.oauth.error, /boom/);
  });

  it('treats unauthenticated 401 on /mcp as ready when OAuth discovery is up', async () => {
    const result = await probeMcpHealth('https://app.example.com', {
      fetchImpl: async (url) => {
        if (String(url).endsWith('/mcp')) {
          return { status: 401, json: async () => ({ error: 'unauthorized' }) };
        }
        return {
          status: 200,
          json: async () => ({ issuer: 'https://app.example.com' }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mcp.ok, true);
    assert.equal(result.mcpExpectedUnauth, true);
    assert.equal(result.oauth.ok, true);
  });

  it('waits and retries until OAuth discovery is ready', async () => {
    let attempts = 0;
    let waited = 0;
    const result = await waitForMcpHealth('https://app.example.com', {
      waitTimeoutMs: 1000,
      intervalMs: 1,
      sleep: async () => {},
      onWait: () => {
        waited += 1;
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/mcp')) {
          return { status: 401, json: async () => ({}) };
        }
        attempts += 1;
        if (attempts < 2) {
          return { status: 503, json: async () => ({}) };
        }
        return {
          status: 200,
          json: async () => ({ issuer: 'https://app.example.com' }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.waited, true);
    assert.equal(waited, 1);
  });
});
