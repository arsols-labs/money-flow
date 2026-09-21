import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESERVED_PRODUCTION_HOST_MARKERS,
  RESERVED_PRODUCTION_RATE_LIMIT_IDS,
  RESERVED_PRODUCTION_RESOURCE_IDS,
  RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT,
} from './constants.mjs';
import {
  buildLocalWranglerConfig,
  parseLocalWranglerConfig,
  rateLimitNamespaceIds,
  serializeWranglerJsonc,
  workersDevOrigin,
} from './config.mjs';

const ownD1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownKv = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('buildLocalWranglerConfig', () => {
  it('emits workers.dev config without reserved production ids or hosts', () => {
    const config = buildLocalWranglerConfig({
      name: 'money-flow',
      hostnameMode: 'workers-dev',
      hostname: null,
      appDomain: 'money-flow.myacct.workers.dev',
      d1: { name: 'money-flow-db', id: ownD1 },
      kv: { id: ownKv },
    });
    assert.equal(config.name, 'money-flow');
    assert.equal(config.workers_dev, true);
    assert.equal(config.d1_databases[0].database_id, ownD1);
    assert.equal(config.kv_namespaces[0].id, ownKv);
    assert.equal(config.kv_namespaces[1].binding, 'OAUTH_KV');
    assert.equal(config.routes, undefined);
    const serialized = serializeWranglerJsonc(config);
    assert.match(serialized, /Do not commit/);
    for (const id of RESERVED_PRODUCTION_RESOURCE_IDS) {
      assert.equal(serialized.includes(id), false);
    }
    for (const id of RESERVED_PRODUCTION_RATE_LIMIT_IDS) {
      assert.equal(serialized.includes(id), false);
    }
    for (const marker of RESERVED_PRODUCTION_HOST_MARKERS) {
      assert.equal(serialized.includes(marker), false);
    }
    if (RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT) {
      assert.equal(serialized.includes(RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT), false);
    }
  });

  it('refuses reserved production APP_DOMAIN hosts', {
    skip: RESERVED_PRODUCTION_HOST_MARKERS.length === 0,
  }, () => {
    assert.throws(
      () =>
        buildLocalWranglerConfig({
          name: 'money-flow',
          hostnameMode: 'workers-dev',
          appDomain: `app.${RESERVED_PRODUCTION_HOST_MARKERS[0]}`,
          d1: { name: 'db', id: ownD1 },
          kv: { id: ownKv },
        }),
      /reserved production/i,
    );
  });

  it('adds a custom-domain route', () => {
    const config = buildLocalWranglerConfig({
      name: 'money-flow',
      hostnameMode: 'custom',
      hostname: 'app.example.com',
      appDomain: 'app.example.com',
      d1: { name: 'money-flow-db', id: ownD1 },
      kv: { id: ownKv },
    });
    assert.deepEqual(config.routes, [{ pattern: 'app.example.com', custom_domain: true }]);
  });

  it('refuses reserved production binding ids', {
    skip: RESERVED_PRODUCTION_RESOURCE_IDS.length === 0,
  }, () => {
    assert.throws(
      () =>
        buildLocalWranglerConfig({
          name: 'money-flow',
          hostnameMode: 'workers-dev',
          appDomain: 'x.workers.dev',
          d1: { name: 'db', id: RESERVED_PRODUCTION_RESOURCE_IDS[0] },
          kv: { id: ownKv },
        }),
      /reserved production/i,
    );
  });

  it('round-trips JSONC comments', () => {
    const config = buildLocalWranglerConfig({
      name: 'money-flow',
      hostnameMode: 'workers-dev',
      appDomain: 'money-flow.workers.dev',
      d1: { name: 'money-flow-db', id: ownD1 },
      kv: { id: ownKv },
    });
    const parsed = parseLocalWranglerConfig(serializeWranglerJsonc(config));
    assert.equal(parsed.d1.id, ownD1);
    assert.equal(parsed.kv.id, ownKv);
    assert.equal(parsed.hostnameMode, 'workers-dev');
  });
});

describe('rateLimitNamespaceIds', () => {
  it('is stable for the same worker name and unique per binding', () => {
    const a = rateLimitNamespaceIds('money-flow');
    const b = rateLimitNamespaceIds('money-flow');
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, 4);
    assert.notDeepEqual(a, rateLimitNamespaceIds('other-app'));
    for (const id of [...a, ...rateLimitNamespaceIds('other-app')]) {
      assert.equal(RESERVED_PRODUCTION_RATE_LIMIT_IDS.includes(id), false);
    }
  });

  it('never emits reserved production rate-limit ids across many worker names', () => {
    for (let i = 0; i < 200; i += 1) {
      for (const id of rateLimitNamespaceIds(`worker-${i}`)) {
        assert.equal(RESERVED_PRODUCTION_RATE_LIMIT_IDS.includes(id), false);
      }
    }
  });
});

describe('workersDevOrigin', () => {
  it('uses a placeholder when the account subdomain is unknown', () => {
    assert.equal(workersDevOrigin('money-flow', null), 'https://money-flow.<your-subdomain>.workers.dev');
    assert.equal(workersDevOrigin('money-flow', 'acct'), 'https://money-flow.acct.workers.dev');
  });
});
