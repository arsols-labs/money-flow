import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRIVATE_FORBIDDEN_CONTENT_PATTERNS,
  RESERVED_PRODUCTION_HOST_MARKERS,
  RESERVED_PRODUCTION_RATE_LIMIT_IDS,
  RESERVED_PRODUCTION_RESOURCE_IDS,
  RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT,
} from './constants.mjs';
import { parseLocalWranglerConfig } from './config.mjs';
import { runSetup } from './run.mjs';

function isLocalWranglerPath(filePath) {
  return (
    filePath.endsWith('/node_modules/wrangler/package.json') ||
    filePath.endsWith('/node_modules/.bin/wrangler')
  );
}

function memoryFs(initial = {}, { localWrangler = true } = {}) {
  const files = { ...initial };
  return {
    files,
    async readFile(filePath) {
      if (!(filePath in files)) throw new Error(`ENOENT: ${filePath}`);
      return files[filePath];
    },
    async writeFile(filePath, contents) {
      files[filePath] = contents;
    },
    async mkdir() {},
    async fileExists(filePath) {
      if (filePath in files) return true;
      return localWrangler && isLocalWranglerPath(filePath);
    },
  };
}

function recorder() {
  const calls = [];
  return {
    calls,
    async run(spec) {
      calls.push(spec.command.join(' '));
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

describe('runSetup dry-run', () => {
  it('plans D1 + KV + migrate + build + deploy without executing them', async () => {
    const logs = [];
    const { run, calls } = recorder();
    const fs = memoryFs();
    const result = await runSetup({
      argv: ['--yes', '--dry-run', '--name', 'cash-desk'],
      cwd: '/tmp/app-v2-dry-run',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs,
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'a'.repeat(64),
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.answers.name, 'cash-desk');
    assert.equal(result.answers.hostnameMode, 'workers-dev');
    assert.equal(result.seedDemo, false);
    assert.equal(result.d1.name, 'cash-desk-db');
    assert.equal(result.d1.id, '00000000-0000-4000-8000-000000000001');
    assert.equal(result.kv.id, '00000000000000000000000000000001');
    assert.match(result.appOrigin, /cash-desk/);
    assert.match(result.mcpOrigin, /\/mcp$/);
    assert.equal(result.config.d1_databases[0].database_id, result.d1.id);
    for (const id of RESERVED_PRODUCTION_RESOURCE_IDS) {
      assert.equal(JSON.stringify(result.config).includes(id), false);
    }
    assert.equal(Object.keys(fs.files).length, 0);
    assert.equal(calls.some((line) => line.includes('npm run build')), false);
    const joined = logs.join('');
    assert.match(joined, /Dry-run complete/);
    assert.match(joined, /Dry-run skips MCP health check/);
    assert.match(joined, /\/mcp/);
    assert.match(joined, /Passkey/);
    assert.doesNotMatch(joined, /coming soon/i);
    for (const pattern of PRIVATE_FORBIDDEN_CONTENT_PATTERNS) {
      assert.doesNotMatch(joined, pattern);
    }
    assert.doesNotMatch(joined, /\$ npx wrangler/);
    const planned = result.planned.map((row) => row.command.join(' '));
    assert.equal(planned.some((line) => line.includes('d1 execute')), false);
    const deployAt = planned.findIndex((line) => line.includes('wrangler deploy'));
    const secretAt = planned.findIndex((line) => line.includes('secret put'));
    assert.ok(deployAt >= 0 && secretAt >= 0 && deployAt < secretAt);
    assert.match(joined, /Leaving the instance empty/);
    for (const id of RESERVED_PRODUCTION_RATE_LIMIT_IDS) {
      assert.equal(JSON.stringify(result.config).includes(id), false);
    }
  });

  it('plans a demo seed after migrate when --seed-demo is set', async () => {
    const logs = [];
    const result = await runSetup({
      argv: ['--yes', '--dry-run', '--name', 'cash-desk', '--seed-demo'],
      cwd: '/tmp/app-v2-dry-run-seed',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
    });
    assert.equal(result.seedDemo, true);
    const planned = result.planned.map((row) => row.command.join(' '));
    const migrateAt = planned.findIndex((line) => line.includes('migrations apply'));
    const seedAt = planned.findIndex((line) => line.includes('d1 execute') && line.includes('seed-demo.sql'));
    assert.ok(migrateAt >= 0 && seedAt >= 0 && migrateAt < seedAt);
    assert.match(logs.join(''), /would seed stranger-safe demo data/);
    assert.match(logs.join(''), /Data → Reset \(in a follow-up release\)/);
    assert.doesNotMatch(logs.join(''), /Leaving the instance empty/);
  });

  it('honors SETUP_SEED_DEMO=yes without --seed-demo', async () => {
    const result = await runSetup({
      argv: ['--yes', '--dry-run', '--name', 'cash-desk'],
      cwd: '/tmp/app-v2-dry-run-seed-env',
      isTTY: false,
      env: { ...process.env, SETUP_SEED_DEMO: 'yes' },
      stdout: { write() {} },
      stderr: { write() {} },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
    });
    assert.equal(result.seedDemo, true);
    const planned = result.planned.map((row) => row.command.join(' '));
    assert.ok(planned.some((line) => line.includes('seed-demo.sql')));
  });

  it('lets --no-seed-demo override SETUP_SEED_DEMO', async () => {
    const result = await runSetup({
      argv: ['--yes', '--dry-run', '--name', 'cash-desk', '--no-seed-demo'],
      cwd: '/tmp/app-v2-dry-run-no-seed',
      isTTY: false,
      env: { ...process.env, SETUP_SEED_DEMO: 'yes' },
      stdout: { write() {} },
      stderr: { write() {} },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
    });
    assert.equal(result.seedDemo, false);
    const planned = result.planned.map((row) => row.command.join(' '));
    assert.equal(planned.some((line) => line.includes('d1 execute')), false);
  });

  it('requires hostname flags in custom non-interactive mode', async () => {
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--dry-run', '--hostname-mode', 'custom'],
          cwd: '/tmp/app-v2-dry-run',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs(),
        }),
      /Custom hostname is required/,
    );
  });

  it('refuses to target wrangler.jsonc', async () => {
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--dry-run', '--config', 'wrangler.jsonc'],
          cwd: '/tmp/app-v2-dry-run',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs(),
        }),
      /Refusing to overwrite wrangler\.jsonc/,
    );
  });

  it('reuses existing local binding ids on a second dry-run', async () => {
    const existing = `{
      "name": "money-flow",
      "vars": { "APP_DOMAIN": "money-flow.myacct.workers.dev" },
      "kv_namespaces": [{ "binding": "KV", "id": "cccccccccccccccccccccccccccccccc" }],
      "d1_databases": [{ "binding": "DB", "database_name": "money-flow-db", "database_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]
    }`;
    const fs = memoryFs({
      '/tmp/app-v2-dry-run/wrangler.local.jsonc': existing,
    });
    const logs = [];
    const result = await runSetup({
      argv: ['--yes', '--dry-run'],
      cwd: '/tmp/app-v2-dry-run',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fs,
    });
    assert.equal(result.d1.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.equal(result.kv.id, 'cccccccccccccccccccccccccccccccc');
    assert.equal(result.answers.reusedExisting, true);
    const joined = logs.join('');
    assert.match(joined, /Local config is in use:/);
    assert.match(joined, /wrangler\.local\.jsonc/);
    assert.match(joined, /same D1 \/ KV \/ Worker/);
    assert.match(joined, /To start from scratch: delete /);
    assert.match(joined, /Worker:\s+money-flow/);
    assert.match(joined, /money-flow\.myacct\.workers\.dev/);
    assert.match(joined, /Reusing this Worker and hostname \(--yes\)/);
    assert.doesNotMatch(joined, /reserved production preview/i);
    assert.doesNotMatch(joined, /Data → Reset/);
  });

  it('tells a seed-demo re-run that Data → Reset ships later', async () => {
    const existing = `{
      "name": "money-flow",
      "vars": { "APP_DOMAIN": "money-flow.myacct.workers.dev" },
      "kv_namespaces": [{ "binding": "KV", "id": "cccccccccccccccccccccccccccccccc" }],
      "d1_databases": [{ "binding": "DB", "database_name": "money-flow-db", "database_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]
    }`;
    const logs = [];
    await runSetup({
      argv: ['--yes', '--dry-run', '--seed-demo'],
      cwd: '/tmp/app-v2-dry-run-seed-reuse',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fs: memoryFs({
        '/tmp/app-v2-dry-run-seed-reuse/wrangler.local.jsonc': existing,
      }),
    });
    const joined = logs.join('');
    assert.match(joined, /Local config is in use:/);
    assert.match(joined, /same D1 \/ KV \/ Worker/);
    assert.match(joined, /To start from scratch:/);
    assert.match(joined, /Data → Reset \(in a follow-up release\)/);
  });

  it('stops when an existing local config contains a reserved production id', {
    skip: RESERVED_PRODUCTION_RESOURCE_IDS.length < 2,
  }, async () => {
    const existing = `{
      "name": "money-flow",
      "kv_namespaces": [{ "binding": "KV", "id": "${RESERVED_PRODUCTION_RESOURCE_IDS[1]}" }],
      "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]
    }`;
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--dry-run'],
          cwd: '/tmp/app-v2-dry-run',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs({ '/tmp/app-v2-dry-run/wrangler.local.jsonc': existing }),
        }),
      /reserved production KV/,
    );
  });

  it('fails closed without a TTY when --yes is omitted', async () => {
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--dry-run'],
          cwd: '/tmp/app-v2-dry-run',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs(),
        }),
      /No TTY/,
    );
  });
});

function liveRunner({
  workerName = 'cash-desk',
  subdomain = 'myacct',
  d1Id = '11111111-1111-4111-8111-111111111111',
  kvId = 'abcdef0123456789abcdef0123456789',
  secrets = [],
  kvListStdout,
  deployStdout,
} = {}) {
  const calls = [];
  const secretPuts = [];
  const secretStore = [...secrets];
  const kvTable =
    kvListStdout ??
    JSON.stringify([]);
  const defaultDeploy = [
    `Uploaded ${workerName}`,
    `  https://deadbeef-${workerName}.${subdomain}.workers.dev`,
    `  https://${workerName}.${subdomain}.workers.dev`,
    'Current Version ID: deadbeef',
  ].join('\n');

  return {
    calls,
    secretPuts,
    secretStore,
    async run(spec) {
      const line = spec.command.join(' ');
      calls.push(line);
      if (line.includes('wrangler --version')) {
        return { code: 0, stdout: '4.20.0', stderr: '' };
      }
      if (line.includes('wrangler whoami')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            email: 'owner@example.com',
            accounts: [{ id: 'acct1', name: 'Personal' }],
          }),
          stderr: '',
        };
      }
      if (line.includes('d1 list')) {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      if (line.includes('d1 create')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            d1_databases: [{ database_name: `${workerName}-db`, database_id: d1Id }],
          }),
          stderr: '',
        };
      }
      if (line.includes('kv namespace list')) {
        return { code: 0, stdout: kvTable, stderr: '' };
      }
      if (line.includes('kv namespace create')) {
        return { code: 0, stdout: `{ binding = "KV", id = "${kvId}" }`, stderr: '' };
      }
      if (line.includes('d1 migrations apply')) {
        return { code: 0, stdout: 'Migrations applied', stderr: '' };
      }
      if (line.includes('d1 execute')) {
        return { code: 0, stdout: 'Executed 4 queries', stderr: '' };
      }
      if (line.includes('npm run build')) {
        return { code: 0, stdout: 'built', stderr: '' };
      }
      if (line.includes('wrangler deploy')) {
        return { code: 0, stdout: deployStdout ?? defaultDeploy, stderr: '' };
      }
      if (line.includes('secret list')) {
        return { code: 0, stdout: JSON.stringify(secretStore.map((name) => ({ name }))), stderr: '' };
      }
      if (line.includes('secret put')) {
        const name = spec.command[4];
        secretPuts.push(name);
        if (!secretStore.includes(name)) secretStore.push(name);
        return { code: 0, stdout: `Uploaded secret ${name}`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
    },
  };
}

function commandIndex(calls, fragment) {
  return calls.findIndex((line) => line.includes(fragment));
}

describe('runSetup mocked live path', () => {
  it('deploys code before uploading secrets and selects the stable workers.dev host', async () => {
    const logs = [];
    const { run, calls, secretPuts } = liveRunner();
    const fs = memoryFs();
    const cwd = '/tmp/app-v2-live';
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk'],
      cwd,
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs,
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.appOrigin, 'https://cash-desk.myacct.workers.dev');
    assert.equal(result.config.vars.APP_DOMAIN, 'cash-desk.myacct.workers.dev');
    assert.deepEqual(secretPuts, ['SESSION_SECRET', 'SETUP_TOKEN']);

    const migrateAt = commandIndex(calls, 'migrations apply');
    const seedAt = commandIndex(calls, 'd1 execute');
    const buildAt = commandIndex(calls, 'npm run build');
    const firstDeployAt = commandIndex(calls, 'wrangler deploy');
    assert.equal(seedAt, -1);
    const secretListAt = commandIndex(calls, 'secret list');
    const firstSecretAt = commandIndex(calls, 'secret put');
    assert.ok(migrateAt >= 0 && buildAt >= 0 && firstDeployAt >= 0 && firstSecretAt >= 0);
    assert.ok(migrateAt < buildAt);
    assert.ok(buildAt < firstDeployAt);
    assert.ok(firstDeployAt < firstSecretAt);
    assert.ok(secretListAt > firstDeployAt && secretListAt < firstSecretAt);
    const deployIndexes = calls
      .map((line, index) => (line.includes('wrangler deploy') ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(deployIndexes.length, 2);
    assert.ok(deployIndexes.every((index) => index < firstSecretAt));

    const written = fs.files[`${cwd}/wrangler.local.jsonc`];
    assert.ok(written);
    const parsed = parseLocalWranglerConfig(written);
    assert.equal(parsed.appDomain, 'cash-desk.myacct.workers.dev');
    for (const id of RESERVED_PRODUCTION_RESOURCE_IDS) {
      assert.equal(written.includes(id), false);
    }
    for (const id of RESERVED_PRODUCTION_RATE_LIMIT_IDS) {
      assert.equal(written.includes(id), false);
    }
    for (const marker of RESERVED_PRODUCTION_HOST_MARKERS) {
      assert.equal(written.includes(marker), false);
    }
    if (RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT) {
      assert.equal(written.includes(RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT), false);
    }
    assert.equal(written.includes('deadbeef-cash-desk'), false);
    for (const pattern of PRIVATE_FORBIDDEN_CONTENT_PATTERNS) {
      assert.doesNotMatch(logs.join(''), pattern);
    }
    assert.doesNotMatch(logs.join(''), /replace-me/);
  });

  it('executes the demo seed after migrate when --seed-demo is set', async () => {
    const logs = [];
    const { run, calls } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct', '--seed-demo'],
      cwd: '/tmp/app-v2-live-seed',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
    });
    assert.equal(result.seedDemo, true);
    const migrateAt = commandIndex(calls, 'migrations apply');
    const seedAt = commandIndex(calls, 'd1 execute');
    const buildAt = commandIndex(calls, 'npm run build');
    assert.ok(migrateAt >= 0 && seedAt >= 0 && buildAt >= 0);
    assert.ok(migrateAt < seedAt);
    assert.ok(seedAt < buildAt);
    assert.ok(calls[seedAt].includes('seed-demo.sql'));
    assert.ok(calls[seedAt].includes('--yes'));
    assert.match(logs.join(''), /Seeding stranger-safe demo data/);
  });

  it('does not redeploy when APP_DOMAIN is already the stable host', async () => {
    const { run, calls } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-stable',
      isTTY: false,
      stdout: { write() {} },
      stderr: { write() {} },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'c'.repeat(64),
    });
    assert.equal(result.config.vars.APP_DOMAIN, 'cash-desk.myacct.workers.dev');
    assert.equal(calls.filter((line) => line.includes('wrangler deploy')).length, 1);
    const deployAt = commandIndex(calls, 'wrangler deploy');
    const secretAt = commandIndex(calls, 'secret put');
    assert.ok(deployAt < secretAt);
  });

  it('reuses a KV namespace from table/banner list output', async () => {
    const kvId = 'abcdef0123456789abcdef0123456789';
    const { run, calls } = liveRunner({
      kvId,
      kvListStdout: `
🌀 wrangler 4.20.0
┌──────────────────────────────────┬──────────────┐
│ id                               │ title        │
├──────────────────────────────────┼──────────────┤
│ ${kvId} │ cash-desk-kv │
└──────────────────────────────────┴──────────────┘
`,
    });
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-kv-table',
      isTTY: false,
      stdout: { write() {} },
      stderr: { write() {} },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'd'.repeat(64),
    });
    assert.equal(result.kv.id, kvId);
    assert.equal(calls.some((line) => line.includes('kv namespace create')), false);
  });

  it('leaves existing secrets unchanged on a second run', async () => {
    const { run, secretPuts } = liveRunner({
      secrets: ['SESSION_SECRET', 'SETUP_TOKEN'],
    });
    await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-rerun',
      isTTY: false,
      stdout: { write() {} },
      stderr: { write() {} },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => {
        throw new Error('must not generate secrets when both already exist');
      },
    });
    assert.deepEqual(secretPuts, []);
  });

  it('does not write replace-me when only one secret is missing', async () => {
    const { run } = liveRunner({ secrets: ['SESSION_SECRET'] });
    const cwd = '/tmp/app-v2-live-one-secret';
    const fs = memoryFs();
    await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd,
      isTTY: false,
      stdout: { write() {} },
      stderr: { write() {} },
      run,
      fs,
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'e'.repeat(64),
    });
    const devVars = fs.files[`${cwd}/.dev.vars`];
    assert.ok(devVars);
    assert.match(devVars, /SETUP_TOKEN=e{64}/);
    assert.doesNotMatch(devVars, /SESSION_SECRET=/);
    assert.doesNotMatch(devVars, /replace-me/);
  });

  it('skips secret upload when deploy is skipped', async () => {
    const { run, calls } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--skip-deploy'],
      cwd: '/tmp/app-v2-live-skip-deploy',
      isTTY: false,
      stdout: { write() {} },
      stderr: { write() {} },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'f'.repeat(64),
    });
    assert.equal(calls.some((line) => line.includes('secret put')), false);
    assert.equal(calls.some((line) => line.includes('wrangler deploy')), false);
    assert.equal(result.mcpHealth, null);
  });

  it('refuses an existing local config whose APP_DOMAIN is a reserved production host', {
    skip: RESERVED_PRODUCTION_HOST_MARKERS.length === 0,
  }, async () => {
    const reservedHost = `app.${RESERVED_PRODUCTION_HOST_MARKERS[0]}`;
    const existing = `{
      "name": "money-flow",
      "vars": { "APP_DOMAIN": "${reservedHost}" },
      "kv_namespaces": [{ "binding": "KV", "id": "cccccccccccccccccccccccccccccccc" }],
      "d1_databases": [{ "binding": "DB", "database_name": "money-flow-db", "database_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]
    }`;
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--name', 'money-flow'],
          cwd: '/tmp/app-v2-live-reserved-domain',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: liveRunner().run,
          fs: memoryFs({
            '/tmp/app-v2-live-reserved-domain/wrangler.local.jsonc': existing,
          }),
        }),
      /reserved production APP_DOMAIN/,
    );
  });

  it('prints the resolving account-subdomain workers.dev URL', async () => {
    const logs = [];
    const workerName = 'money-flow-setup-script-test';
    const accountSubdomain = 'myacct';
    const { run } = liveRunner({ workerName, subdomain: accountSubdomain });
    const result = await runSetup({
      argv: ['--yes', '--name', workerName],
      cwd: '/tmp/app-v2-live-workers-dev-url',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
    });
    const expectedHost = `${workerName}.${accountSubdomain}.workers.dev`;
    assert.equal(result.appOrigin, `https://${expectedHost}`);
    assert.equal(result.config.vars.APP_DOMAIN, expectedHost);
    const joined = logs.join('');
    assert.match(joined, new RegExp(expectedHost.replaceAll('.', '\\.')));
    assert.doesNotMatch(joined, /App origin:\s+https:\/\/money-flow-setup-script-test\.workers\.dev\s/);
  });

  it('prints SESSION_SECRET and SETUP_TOKEN once with password-manager copy', async () => {
    const logs = [];
    const secrets = [];
    const { run } = liveRunner();
    await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-setup-token',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => {
        const value = `${secrets.length === 0 ? 's' : 't'}`.repeat(64);
        secrets.push(value);
        return value;
      },
    });
    const joined = logs.join('');
    assert.equal(secrets.length, 2);
    assert.match(joined, /Secrets \(shown once — save them in a password manager now\)/);
    assert.match(joined, /SETUP_TOKEN\s+t{64}/);
    assert.match(joined, /SESSION_SECRET\s+s{64}/);
    assert.match(joined, /First Passkey enroll \/ recovery at \/setup\/passkey/);
    assert.match(joined, /Session signing key\. Do not share it/);
    assert.match(joined, /password field/);
    assert.match(joined, /These Worker secrets are not shown again after this run/);
  });

  it('paints the secrets-not-shown-again line bright red', async () => {
    const logs = [];
    const { run } = liveRunner();
    await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-secret-color',
      isTTY: false,
      env: { FORCE_COLOR: '1' },
      stdout: { isTTY: true, write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'c'.repeat(64),
    });
    assert.match(
      logs.join(''),
      /\u001b\[1m\u001b\[31mThese Worker secrets are not shown again after this run/,
    );
  });

  it('explains how to recover lost secrets on --yes re-run', async () => {
    const logs = [];
    const { run, secretPuts } = liveRunner({
      secrets: ['SESSION_SECRET', 'SETUP_TOKEN'],
    });
    await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-token-recovery',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => {
        throw new Error('must not generate secrets when both already exist');
      },
    });
    assert.deepEqual(secretPuts, []);
    const joined = logs.join('');
    assert.match(joined, /already set on the Worker/);
    assert.match(joined, /--rotate-secrets/);
    assert.doesNotMatch(joined, /Secrets \(shown once/);
  });

  it('rotates both secrets and prints the new values', async () => {
    const logs = [];
    const issued = [];
    const { run, secretPuts } = liveRunner({
      secrets: ['SESSION_SECRET', 'SETUP_TOKEN'],
    });
    await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct', '--rotate-secrets'],
      cwd: '/tmp/app-v2-live-rotate-token',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => {
        const value = `${issued.length === 0 ? 'S' : 'T'}`.repeat(64);
        issued.push(value);
        return value;
      },
    });
    assert.deepEqual(secretPuts, ['SESSION_SECRET', 'SETUP_TOKEN']);
    const joined = logs.join('');
    assert.match(joined, /Rotating SESSION_SECRET/);
    assert.match(joined, /Rotating SETUP_TOKEN/);
    assert.match(joined, /Secrets \(shown once/);
    assert.match(joined, /SESSION_SECRET\s+S{64}/);
    assert.match(joined, /SETUP_TOKEN\s+T{64}/);
  });

  it('offers TTY rotate of existing secrets and prints the new values', async () => {
    const logs = [];
    const { run, secretPuts } = liveRunner({
      secrets: ['SESSION_SECRET', 'SETUP_TOKEN'],
    });
    const token = 'y'.repeat(64);
    await runSetup({
      argv: ['--name', 'cash-desk', '--hostname-mode', 'workers-dev', '--no-seed-demo', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-rotate-tty',
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async (question) => {
        if (/Rotate existing secrets/i.test(question)) return 'y';
        throw new Error(`unexpected prompt: ${question}`);
      },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => token,
    });
    assert.deepEqual(secretPuts, ['SESSION_SECRET', 'SETUP_TOKEN']);
    const joined = logs.join('');
    assert.match(joined, /Rotate them to print new values/);
    assert.match(joined, /Secrets \(shown once/);
    assert.match(joined, new RegExp(token));
  });

  it('leaves existing secrets unchanged when the TTY user declines rotate', async () => {
    const logs = [];
    const { run, secretPuts } = liveRunner({
      secrets: ['SESSION_SECRET', 'SETUP_TOKEN'],
    });
    await runSetup({
      argv: ['--name', 'cash-desk', '--hostname-mode', 'workers-dev', '--no-seed-demo', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-live-rotate-decline',
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async (question) => {
        if (/Rotate existing secrets/i.test(question)) return 'n';
        throw new Error(`unexpected prompt: ${question}`);
      },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => {
        throw new Error('must not generate secrets when rotate is declined');
      },
    });
    assert.deepEqual(secretPuts, []);
    assert.match(logs.join(''), /--rotate-secrets/);
    assert.doesNotMatch(logs.join(''), /Secrets \(shown once/);
  });
});

describe('runSetup auth UX', () => {
  it('fails closed on --yes when wrangler is not logged in', async () => {
    const logs = [];
    let loginCalls = 0;
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--name', 'cash-desk'],
          cwd: '/tmp/app-v2-auth-yes',
          isTTY: true,
          stdout: { write: (text) => logs.push(text) },
          stderr: { write: (text) => logs.push(text) },
          run: async (spec) => {
            const line = spec.command.join(' ');
            if (line.includes('wrangler --version')) return { code: 0, stdout: '4.20.0', stderr: '' };
            if (line.includes('wrangler whoami')) {
              return { code: 0, stdout: 'You are not logged in.', stderr: '' };
            }
            if (line.includes('wrangler login')) {
              loginCalls += 1;
              return { code: 0, stdout: '', stderr: '' };
            }
            return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
          },
          fs: memoryFs(),
        }),
      /authentication required/,
    );
    assert.equal(loginCalls, 0);
    const joined = logs.join('');
    assert.match(joined, /npx wrangler login/);
    assert.match(joined, /--yes cannot open a browser/);
  });

  it('runs wrangler login on a TTY then continues', async () => {
    const logs = [];
    let whoamiCount = 0;
    const fallback = liveRunner();
    const result = await runSetup({
      argv: ['--name', 'cash-desk', '--hostname-mode', 'workers-dev', '--no-seed-demo', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-auth-tty',
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async (question) => {
        if (/Log in to Cloudflare/i.test(question)) return 'y';
        throw new Error(`unexpected prompt: ${question}`);
      },
      run: async (spec) => {
        const line = spec.command.join(' ');
        if (line.includes('wrangler whoami')) {
          whoamiCount += 1;
          if (whoamiCount === 1) {
            return { code: 0, stdout: 'You are not logged in.', stderr: '' };
          }
          return {
            code: 0,
            stdout: JSON.stringify({
              email: 'owner@example.com',
              accounts: [{ id: 'acct1', name: 'Personal' }],
            }),
            stderr: '',
          };
        }
        if (line.includes('wrangler login')) {
          return { code: 0, stdout: 'Opening browser', stderr: '' };
        }
        return fallback.run(spec);
      },
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
    });
    assert.equal(result.ok, true);
    assert.equal(whoamiCount, 2);
    assert.equal(result.appOrigin, 'https://cash-desk.myacct.workers.dev');
    assert.match(logs.join(''), /Starting npx wrangler login/);
  });
});

describe('runSetup Node and deps shepherding', () => {
  it('explains how to install or upgrade Node instead of failing silently', async () => {
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--name', 'cash-desk'],
          cwd: '/tmp/app-v2-old-node',
          isTTY: false,
          env: { ...process.env, NODE_VERSION: '18.20.0' },
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs(),
        }),
      /https:\/\/nodejs\.org\//,
    );
  });

  it('fails closed on --yes when local Wrangler / node_modules is missing', async () => {
    const logs = [];
    let npmInstallCalls = 0;
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--name', 'cash-desk'],
          cwd: '/tmp/app-v2-deps-yes',
          isTTY: true,
          stdout: { write: (text) => logs.push(text) },
          stderr: { write: (text) => logs.push(text) },
          run: async (spec) => {
            if (spec.command.join(' ') === 'npm install') {
              npmInstallCalls += 1;
              return { code: 0, stdout: '', stderr: '' };
            }
            return { code: 1, stdout: '', stderr: `unexpected command: ${spec.command.join(' ')}` };
          },
          fs: memoryFs({}, { localWrangler: false }),
        }),
      /Local Wrangler is required/,
    );
    assert.equal(npmInstallCalls, 0);
    const joined = logs.join('');
    assert.match(joined, /npm install/);
    assert.match(joined, /npx wrangler/);
    assert.doesNotMatch(joined, /npm i -g wrangler/);
  });

  it('offers npm install on a TTY then continues to login and setup', async () => {
    const logs = [];
    const cwd = '/tmp/app-v2-deps-tty';
    const fs = memoryFs({}, { localWrangler: false });
    const fallback = liveRunner();
    let npmInstallCalls = 0;
    const result = await runSetup({
      argv: ['--name', 'cash-desk', '--hostname-mode', 'workers-dev', '--no-seed-demo', '--account-subdomain', 'myacct'],
      cwd,
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async (question) => {
        if (/Install dependencies now/i.test(question)) return 'y';
        throw new Error(`unexpected prompt: ${question}`);
      },
      run: async (spec) => {
        if (spec.command.join(' ') === 'npm install') {
          npmInstallCalls += 1;
          fs.files[`${cwd}/node_modules/wrangler/package.json`] = '{"name":"wrangler","version":"4.20.0"}';
          return { code: 0, stdout: 'added 1 package', stderr: '' };
        }
        return fallback.run(spec);
      },
      fs,
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
    });
    assert.equal(result.ok, true);
    assert.equal(npmInstallCalls, 1);
    assert.equal(result.appOrigin, 'https://cash-desk.myacct.workers.dev');
    const joined = logs.join('');
    assert.match(joined, /Install dependencies now|Running npm install/);
    assert.match(joined, /npx wrangler/);
    assert.match(joined, /Dependencies installed/);
  });

  it('fails closed when the TTY user declines npm install', async () => {
    const logs = [];
    let npmInstallCalls = 0;
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--name', 'cash-desk'],
          cwd: '/tmp/app-v2-deps-decline',
          isTTY: true,
          stdout: { write: (text) => logs.push(text) },
          stderr: { write: (text) => logs.push(text) },
          ask: async (question) => {
            if (/Install dependencies now/i.test(question)) return 'n';
            throw new Error(`unexpected prompt: ${question}`);
          },
          run: async (spec) => {
            if (spec.command.join(' ') === 'npm install') {
              npmInstallCalls += 1;
              return { code: 0, stdout: '', stderr: '' };
            }
            return { code: 1, stdout: '', stderr: `unexpected command: ${spec.command.join(' ')}` };
          },
          fs: memoryFs({}, { localWrangler: false }),
        }),
      /Local Wrangler is required/,
    );
    assert.equal(npmInstallCalls, 0);
    assert.match(logs.join(''), /npm install/);
  });

  it('skips live npm install on dry-run when deps are missing', async () => {
    const logs = [];
    let npmInstallCalls = 0;
    const result = await runSetup({
      argv: ['--yes', '--dry-run', '--name', 'cash-desk'],
      cwd: '/tmp/app-v2-deps-dry-run',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run: async (spec) => {
        if (spec.command.join(' ') === 'npm install') {
          npmInstallCalls += 1;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      fs: memoryFs({}, { localWrangler: false }),
      now: () => '2026-09-20T00:00:00.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(npmInstallCalls, 0);
    assert.match(logs.join(''), /Dry-run skips npm install/);
  });
});

describe('runSetup finish and MCP health', () => {
  it('pauses stdin so the process can exit after setup complete', async () => {
    let paused = false;
    let unrefed = false;
    const stdin = {
      isTTY: false,
      pause() {
        paused = true;
      },
      unref() {
        unrefed = true;
      },
    };
    await runSetup({
      argv: ['--yes', '--dry-run', '--name', 'cash-desk'],
      cwd: '/tmp/app-v2-stdin-release',
      stdin,
      isTTY: false,
      stdout: { write() {} },
      stderr: { write() {} },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
    });
    assert.equal(paused, true);
    assert.equal(unrefed, true);
  });

  it('probes MCP HTTP and OAuth discovery after a live deploy', async () => {
    const logs = [];
    const urls = [];
    const { run } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-mcp-health',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
      fetch: async (url) => {
        urls.push(String(url));
        if (String(url).endsWith('/mcp')) {
          return { status: 200, json: async () => ({ status: 'ok' }) };
        }
        return {
          status: 200,
          json: async () => ({
            issuer: 'https://cash-desk.myacct.workers.dev',
            authorization_endpoint: 'https://cash-desk.myacct.workers.dev/api/auth/oauth/authorize',
          }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mcpHealth.ok, true);
    assert.ok(urls.some((url) => url.endsWith('/mcp')));
    assert.ok(urls.some((url) => url.includes('oauth-authorization-server')));
    const joined = logs.join('');
    assert.match(joined, /MCP endpoint and OAuth discovery — ok/);
    assert.match(joined, /MCP health:\s+ok/);
    assert.doesNotMatch(joined, /reserved production preview/i);
  });

  it('warns when MCP health fails and still returns ok after deploy', async () => {
    const logs = [];
    const { run } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-mcp-health-fail',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
      fetch: async () => ({ status: 503, json: async () => ({}) }),
      mcpWaitTimeoutMs: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mcpHealth.ok, false);
    const joined = logs.join('');
    assert.match(joined, /MCP health check did not pass \(setup still finished\)/);
    assert.match(joined, /HTTP 503/);
    assert.match(joined, /MCP health:\s+warning — check did not pass; setup still finished/);
    assert.match(joined, /Setup complete/);
    assert.doesNotMatch(joined, /Waiting for deployment/);
  });

  it('warns when MCP health throws and still returns ok after deploy', async () => {
    const logs = [];
    const { run } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-mcp-health-throw',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
      fetch: async () => {
        throw new Error('dns exploded');
      },
      mcpWaitTimeoutMs: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mcpHealth.ok, false);
    const joined = logs.join('');
    assert.match(joined, /MCP health check did not pass \(setup still finished\)/);
    assert.match(joined, /dns exploded/);
  });

  it('treats unauthenticated 401 on /mcp as ready after deploy', async () => {
    const logs = [];
    const { run } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-mcp-health-401',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
      fetch: async (url) => {
        if (String(url).endsWith('/mcp')) {
          return { status: 401, json: async () => ({ error: 'unauthorized' }) };
        }
        return {
          status: 200,
          json: async () => ({ issuer: 'https://cash-desk.myacct.workers.dev' }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mcpHealth.ok, true);
    assert.equal(result.mcpHealth.mcpExpectedUnauth, true);
    const joined = logs.join('');
    assert.match(joined, /MCP endpoint and OAuth discovery — ok/);
    assert.doesNotMatch(joined, /did not pass/);
    assert.doesNotMatch(joined, /HTTP 401/);
    assert.doesNotMatch(joined, /Waiting for deployment/);
  });

  it('prints Waiting for deployment while MCP/OAuth become ready', async () => {
    const logs = [];
    let oauthAttempts = 0;
    const { run } = liveRunner();
    const result = await runSetup({
      argv: ['--yes', '--name', 'cash-desk', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-mcp-health-wait',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      run,
      fs: memoryFs(),
      now: () => '2026-09-20T00:00:00.000Z',
      randomSecret: () => 'b'.repeat(64),
      mcpWaitTimeoutMs: 1000,
      mcpWaitIntervalMs: 1,
      sleep: async () => {},
      fetch: async (url) => {
        if (String(url).endsWith('/mcp')) {
          return { status: 401, json: async () => ({}) };
        }
        oauthAttempts += 1;
        if (oauthAttempts < 2) {
          return { status: 503, json: async () => ({}) };
        }
        return {
          status: 200,
          json: async () => ({ issuer: 'https://cash-desk.myacct.workers.dev' }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mcpHealth.ok, true);
    assert.equal(result.mcpHealth.waited, true);
    assert.match(logs.join(''), /Waiting for deployment…/);
  });
});

describe('runSetup reuse confirm', () => {
  it('asks a TTY to confirm an existing Worker and hostname before seed', async () => {
    const logs = [];
    const questions = [];
    const existing = `{
      "name": "already-there",
      "vars": { "APP_DOMAIN": "already-there.myacct.workers.dev" },
      "kv_namespaces": [{ "binding": "KV", "id": "cccccccccccccccccccccccccccccccc" }],
      "d1_databases": [{ "binding": "DB", "database_name": "already-there-db", "database_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]
    }`;
    const { run } = liveRunner({ workerName: 'already-there' });
    const result = await runSetup({
      argv: ['--no-seed-demo', '--account-subdomain', 'myacct'],
      cwd: '/tmp/app-v2-reuse-tty',
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async (question) => {
        questions.push(question);
        if (/Reuse this Worker and hostname/.test(question)) return 'y';
        if (/Rotate existing secrets/.test(question)) return 'n';
        throw new Error(`unexpected prompt: ${question}`);
      },
      run,
      fs: memoryFs({
        '/tmp/app-v2-reuse-tty/wrangler.local.jsonc': existing,
      }),
      now: () => '2026-09-20T00:00:00.000Z',
      fetch: async (url) => {
        if (String(url).endsWith('/mcp')) {
          return { status: 401, json: async () => ({}) };
        }
        return {
          status: 200,
          json: async () => ({ issuer: 'https://already-there.myacct.workers.dev' }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.answers.name, 'already-there');
    assert.equal(result.answers.reusedExisting, true);
    assert.match(questions[0], /Local config is in use/);
    assert.match(questions[0], /already-there/);
    assert.match(questions[0], /already-there\.myacct\.workers\.dev/);
    assert.equal(questions.some((q) => /Worker \/ service name/.test(q)), false);
    assert.doesNotMatch(logs.join(''), /reserved production preview/i);
  });
});
