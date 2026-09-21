import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RESERVED_PRODUCTION_D1_NAMES,
  RESERVED_PRODUCTION_RESOURCE_IDS,
  RESERVED_PRODUCTION_WORKERS_DEV_LABELS,
} from './constants.mjs';
import {
  assertDeletableName,
  confirmDelete,
  formatDeletePlan,
  formatWorkerPicker,
  pickWorkerByDigit,
  planDeleteResources,
  relevantWorkerNames,
  resolveDeleteTarget,
  runDelete,
} from './delete.mjs';
import { runSetup } from './run.mjs';
import { createWranglerClient, isReadOnlyWranglerCommand } from './wrangler.mjs';

describe('delete deny lists', () => {
  it('refuses reserved production Worker and D1 names', {
    skip: RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length < 2 || RESERVED_PRODUCTION_D1_NAMES.length === 0,
  }, () => {
    assert.throws(
      () => assertDeletableName(RESERVED_PRODUCTION_WORKERS_DEV_LABELS[0]),
      /reserved production names list/,
    );
    assert.throws(
      () => assertDeletableName(`staging-${RESERVED_PRODUCTION_WORKERS_DEV_LABELS[1]}`),
      /reserved production names list/,
    );
    assert.throws(
      () => assertDeletableName(RESERVED_PRODUCTION_D1_NAMES[0]),
      /reserved production names list/,
    );
    assert.equal(assertDeletableName('cash-desk'), 'cash-desk');
    assert.equal(assertDeletableName('money-flow'), 'money-flow');
  });
});

describe('delete planning', () => {
  it('uses naming convention when local config is absent', () => {
    const plan = planDeleteResources({
      workerName: 'cash-desk',
      d1List: [{ name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' }],
      kvList: [{ title: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' }],
    });
    assert.equal(plan.workerName, 'cash-desk');
    assert.equal(plan.d1.name, 'cash-desk-db');
    assert.equal(plan.kv.name, 'cash-desk-kv');
    assert.deepEqual(plan.localFiles, []);
  });

  it('prefers matching wrangler.local.jsonc / state ownership', () => {
    const plan = planDeleteResources({
      workerName: 'cash-desk',
      existing: {
        name: 'cash-desk',
        d1: { name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' },
        kv: { name: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' },
      },
      state: { workerName: 'cash-desk' },
      configPath: 'wrangler.local.jsonc',
      statePath: '.setup-state.json',
    });
    assert.deepEqual(plan.localFiles, ['wrangler.local.jsonc', '.setup-state.json']);
  });

  it('does not take D1/KV from a local config for a different Worker', () => {
    const plan = planDeleteResources({
      workerName: 'other-app',
      existing: {
        name: 'cash-desk',
        d1: { name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' },
        kv: { id: 'abcdef0123456789abcdef0123456789' },
      },
      d1List: [],
      kvList: [],
    });
    assert.equal(plan.d1, null);
    assert.equal(plan.kv, null);
    assert.deepEqual(plan.localFiles, []);
  });

  it('refuses reserved production resource ids even when names look local', {
    skip: RESERVED_PRODUCTION_RESOURCE_IDS.length === 0,
  }, () => {
    assert.throws(
      () =>
        planDeleteResources({
          workerName: 'cash-desk',
          existing: {
            name: 'cash-desk',
            d1: { name: 'cash-desk-db', id: RESERVED_PRODUCTION_RESOURCE_IDS[0] },
            kv: { id: 'abcdef0123456789abcdef0123456789' },
          },
        }),
      /reserved production D1/,
    );
  });

  it('lists relevant Workers and marks reserved production names protected', {
    skip: RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length === 0,
  }, () => {
    const reservedWorker = RESERVED_PRODUCTION_WORKERS_DEV_LABELS[0];
    const names = relevantWorkerNames({
      accountWorkers: [{ name: 'cash-desk' }, { name: reservedWorker }],
      existing: { name: 'already-local' },
      d1List: [{ name: 'side-project-db' }],
    });
    assert.deepEqual(names, ['already-local', 'cash-desk', reservedWorker, 'side-project']);
    const picker = formatWorkerPicker(['cash-desk', reservedWorker]);
    assert.match(picker, /1\. cash-desk/);
    assert.match(picker, new RegExp(`2\\. ${reservedWorker} {2}\\[protected — production\\]`));
    assert.equal(pickWorkerByDigit('1', ['cash-desk', reservedWorker]), 'cash-desk');
    assert.throws(() => pickWorkerByDigit('9', ['cash-desk']), /between 1 and 1/);
  });

  it('prints a plan that names Worker, D1, KV, and reserved production exclusions', () => {
    const text = formatDeletePlan({
      workerName: 'cash-desk',
      d1: { name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' },
      kv: { name: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' },
      localFiles: ['wrangler.local.jsonc'],
    });
    assert.match(text, /Worker: {2}cash-desk/);
    assert.match(text, /cash-desk-db/);
    assert.match(text, /wrangler\.local\.jsonc/);
    assert.match(text, /reserved production names or ids/);
    assert.match(text, /1Password/);
  });
});

describe('delete confirms and targeting', () => {
  it('requires --yes plus a name when there is no TTY', async () => {
    await assert.rejects(
      () =>
        resolveDeleteTarget({
          flags: { delete: true, nonInteractive: true, name: null },
          existing: null,
          state: null,
          accountWorkers: [{ name: 'cash-desk' }],
          d1List: [],
          ask: async () => '1',
          isTTY: false,
        }),
      /Pass --delete <workerName> with --yes/,
    );
  });

  it('picks a numbered Worker on a TTY', async () => {
    const name = await resolveDeleteTarget({
      flags: { delete: true, name: null },
      existing: null,
      state: null,
      accountWorkers: [{ name: 'cash-desk' }, { name: 'other-app' }],
      d1List: [],
      ask: async () => '2',
      isTTY: true,
    });
    assert.equal(name, 'other-app');
  });

  it('still waits for a number on --delete --dry-run without a name', async () => {
    const logs = [];
    const questions = [];
    const name = await resolveDeleteTarget({
      flags: { delete: true, name: null, dryRun: true, nonInteractive: false },
      existing: null,
      state: null,
      accountWorkers: [{ name: 'cash-desk' }, { name: 'other-app' }],
      d1List: [],
      ask: async (question) => {
        questions.push(question);
        return '2';
      },
      isTTY: true,
      write: (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`),
      stdout: { write: (text) => logs.push(text) },
    });
    assert.equal(name, 'other-app');
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Number:/);
    assert.match(logs.join(''), /1\. cash-desk/);
    assert.doesNotMatch(questions.join(''), /Type the Worker name/);
  });

  it('refuses a protected name selected from the list', {
    skip: RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length === 0,
  }, async () => {
    await assert.rejects(
      () =>
        resolveDeleteTarget({
          flags: { delete: true, name: null },
          existing: null,
          state: null,
          accountWorkers: [{ name: RESERVED_PRODUCTION_WORKERS_DEV_LABELS[0] }],
          d1List: [],
          ask: async () => '1',
          isTTY: true,
        }),
      /reserved production names list/,
    );
  });

  it('requires typing the Worker name on a TTY', async () => {
    await confirmDelete({
      plan: { workerName: 'cash-desk' },
      ask: async () => 'cash-desk',
      nonInteractive: false,
      isTTY: true,
    });
    await assert.rejects(
      () =>
        confirmDelete({
          plan: { workerName: 'cash-desk' },
          ask: async () => 'yes',
          nonInteractive: false,
          isTTY: true,
        }),
      /did not match/,
    );
    await confirmDelete({
      plan: { workerName: 'cash-desk' },
      ask: async () => {
        throw new Error('should not prompt');
      },
      nonInteractive: true,
      isTTY: false,
    });
    await confirmDelete({
      plan: { workerName: 'cash-desk' },
      ask: async () => {
        throw new Error('dry-run should not open readline');
      },
      nonInteractive: false,
      isTTY: true,
      dryRun: true,
    });
  });
});

describe('setup.mjs entry', () => {
  it('uses async main instead of a top-level await', () => {
    const source = readFileSync(fileURLToPath(new URL('../../setup.mjs', import.meta.url)), 'utf8');
    assert.match(source, /async function main/);
    assert.match(source, /void main\(\)/);
    assert.doesNotMatch(source, /^const \w+ = await /m);
    assert.doesNotMatch(source, /^await /m);
  });
});

function memoryFs(initial = {}) {
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
    async unlink(filePath) {
      delete files[filePath];
    },
    async mkdir() {},
    async fileExists(filePath) {
      return filePath in files;
    },
  };
}

describe('wrangler delete commands', () => {
  it('plans wrangler delete argv for Worker, D1, and KV', async () => {
    const planned = [];
    const client = createWranglerClient({
      dryRun: true,
      cwd: '/tmp/app-v2-delete-wrangler',
      run: async (spec) => {
        planned.push(spec.command);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await client.deleteWorker('cash-desk');
    await client.deleteD1('cash-desk-db');
    await client.deleteKv('abcdef0123456789abcdef0123456789');
    const commands = client.planned.map((row) => row.command.join(' '));
    assert.equal(planned.length, 0);
    assert.match(commands.join('\n'), /wrangler delete --name cash-desk --force/);
    assert.match(commands.join('\n'), /wrangler d1 delete cash-desk-db --skip-confirmation/);
    assert.match(
      commands.join('\n'),
      /wrangler kv namespace delete --namespace-id abcdef0123456789abcdef0123456789 --skip-confirmation/,
    );
  });
});

describe('wrangler dry-run listing', () => {
  it('classifies inventory commands as read-only and deletes as writes', () => {
    assert.equal(isReadOnlyWranglerCommand(['whoami']), true);
    assert.equal(isReadOnlyWranglerCommand(['--version']), true);
    assert.equal(isReadOnlyWranglerCommand(['workers', 'list', '--json']), true);
    assert.equal(isReadOnlyWranglerCommand(['d1', 'list', '--json']), true);
    assert.equal(isReadOnlyWranglerCommand(['kv', 'namespace', 'list']), true);
    assert.equal(isReadOnlyWranglerCommand(['secret', 'list', '--json']), true);
    assert.equal(isReadOnlyWranglerCommand(['delete', '--name', 'cash-desk', '--force']), false);
    assert.equal(isReadOnlyWranglerCommand(['d1', 'delete', 'cash-desk-db', '--skip-confirmation']), false);
    assert.equal(isReadOnlyWranglerCommand(['d1', 'create', 'cash-desk-db']), false);
    assert.equal(
      isReadOnlyWranglerCommand(['kv', 'namespace', 'delete', '--namespace-id', 'abc', '--skip-confirmation']),
      false,
    );
    assert.equal(isReadOnlyWranglerCommand(['kv', 'namespace', 'create', 'cash-desk-kv']), false);
    assert.equal(isReadOnlyWranglerCommand(['secret', 'put', 'SETUP_TOKEN']), false);
    assert.equal(isReadOnlyWranglerCommand(['deploy', '--config', 'wrangler.local.jsonc']), false);
  });

  it('executes whoami / listWorkers / listD1 / listKv on dry-run and never runs deletes', async () => {
    const runCalls = [];
    const client = createWranglerClient({
      dryRun: true,
      cwd: '/tmp/app-v2-delete-dry-list',
      run: async (spec) => {
        const line = spec.command.join(' ');
        runCalls.push(line);
        if (line.includes('whoami')) {
          return { code: 0, stdout: 'You are logged in\nemail: tester@example.com\n', stderr: '' };
        }
        if (line.includes('workers list')) {
          return { code: 0, stdout: '[{"name":"cash-desk"}]', stderr: '' };
        }
        if (line.includes('d1 list')) {
          return {
            code: 0,
            stdout: '[{"name":"cash-desk-db","uuid":"11111111-1111-4111-8111-111111111111"}]',
            stderr: '',
          };
        }
        if (line.includes('kv namespace list')) {
          return {
            code: 0,
            stdout: '[{"title":"cash-desk-kv","id":"abcdef0123456789abcdef0123456789"}]',
            stderr: '',
          };
        }
        throw new Error(`dry-run must not execute write: ${line}`);
      },
    });

    const identity = await client.whoami();
    const workers = await client.listWorkers();
    const d1 = await client.listD1();
    const kv = await client.listKv();
    await client.deleteWorker('cash-desk');
    await client.deleteD1('cash-desk-db');
    await client.deleteKv('abcdef0123456789abcdef0123456789');

    assert.equal(identity.loggedIn, true);
    assert.equal(identity.email, 'tester@example.com');
    assert.deepEqual(workers, [{ name: 'cash-desk' }]);
    assert.deepEqual(d1, [{ name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' }]);
    assert.deepEqual(kv, [{ title: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' }]);
    assert.equal(runCalls.some((line) => line.includes('wrangler whoami')), true);
    assert.equal(runCalls.some((line) => line.includes('workers list')), true);
    assert.equal(runCalls.some((line) => line.includes('d1 list')), true);
    assert.equal(runCalls.some((line) => line.includes('kv namespace list')), true);
    assert.equal(runCalls.some((line) => /wrangler delete |d1 delete|kv namespace delete/.test(line)), false);
  });
});

describe('runDelete dry-run', () => {
  it('plans Worker + D1 + KV deletes without executing them', async () => {
    const logs = [];
    const calls = [];
    const result = await runDelete({
      args: {
        delete: true,
        name: 'cash-desk',
        nonInteractive: true,
        dryRun: true,
        configPath: 'wrangler.local.jsonc',
      },
      cwd: '/tmp/app-v2-delete-dry',
      stdout: { write: (text) => logs.push(text) },
      write: (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`),
      isTTY: false,
      ask: async () => {
        throw new Error('should not prompt');
      },
      fsApi: memoryFs(),
      wrangler: {
        planned: [],
        async listWorkers() {
          return [{ name: 'cash-desk' }];
        },
        async listD1() {
          return [{ name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' }];
        },
        async listKv() {
          return [{ title: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' }];
        },
        async deleteWorker(name) {
          calls.push(`deleteWorker ${name}`);
        },
        async deleteD1(name) {
          calls.push(`deleteD1 ${name}`);
        },
        async deleteKv(id) {
          calls.push(`deleteKv ${id}`);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.workerName, 'cash-desk');
    assert.deepEqual(calls, []);
    assert.match(logs.join(''), /Dry-run delete plan/);
    assert.match(logs.join(''), /would delete/);
  });

  it('prints the dry-run plan without readline when --yes is omitted', async () => {
    const logs = [];
    let asked = 0;
    const result = await runDelete({
      args: {
        delete: true,
        name: 'cash-desk',
        nonInteractive: false,
        dryRun: true,
        configPath: 'wrangler.local.jsonc',
      },
      cwd: '/tmp/app-v2-delete-dry-tty',
      stdout: { write: (text) => logs.push(text) },
      write: (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`),
      isTTY: true,
      ask: async () => {
        asked += 1;
        throw new Error('dry-run should not open readline');
      },
      fsApi: memoryFs(),
      wrangler: {
        planned: [],
        async listWorkers() {
          return [{ name: 'cash-desk' }];
        },
        async listD1() {
          return [{ name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' }];
        },
        async listKv() {
          return [{ title: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' }];
        },
        async deleteWorker() {
          throw new Error('dry-run must not delete a Worker');
        },
        async deleteD1() {
          throw new Error('dry-run must not delete D1');
        },
        async deleteKv() {
          throw new Error('dry-run must not delete KV');
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(asked, 0);
    assert.match(logs.join(''), /Dry-run delete plan/);
    assert.match(logs.join(''), /would delete/);
    assert.doesNotMatch(logs.join(''), /Type the Worker name/);
  });

  it('deletes Worker, then owned D1 / KV, then matching local files', async () => {
    const logs = [];
    const calls = [];
    const cwd = '/tmp/app-v2-delete-live';
    const fsApi = memoryFs({
      [`${cwd}/wrangler.local.jsonc`]: JSON.stringify({
        name: 'cash-desk',
        vars: { APP_DOMAIN: 'cash-desk.example.workers.dev' },
        d1_databases: [
          {
            database_name: 'cash-desk-db',
            database_id: '11111111-1111-4111-8111-111111111111',
          },
        ],
        kv_namespaces: [{ binding: 'KV', id: 'abcdef0123456789abcdef0123456789' }],
      }),
      [`${cwd}/.setup-state.json`]: JSON.stringify({
        workerName: 'cash-desk',
        d1: { name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' },
        kv: { name: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' },
      }),
    });
    const result = await runDelete({
      args: {
        delete: true,
        name: 'cash-desk',
        nonInteractive: true,
        dryRun: false,
        configPath: 'wrangler.local.jsonc',
      },
      cwd,
      stdout: { write: (text) => logs.push(text) },
      write: (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`),
      isTTY: false,
      ask: async () => {
        throw new Error('should not prompt');
      },
      fsApi,
      wrangler: {
        planned: [],
        async listWorkers() {
          return [{ name: 'cash-desk' }];
        },
        async listD1() {
          return [{ name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' }];
        },
        async listKv() {
          return [{ title: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' }];
        },
        async deleteWorker(name) {
          calls.push(`deleteWorker ${name}`);
        },
        async deleteD1(name) {
          calls.push(`deleteD1 ${name}`);
        },
        async deleteKv(id) {
          calls.push(`deleteKv ${id}`);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.deepEqual(calls, [
      'deleteWorker cash-desk',
      'deleteD1 cash-desk-db',
      'deleteKv abcdef0123456789abcdef0123456789',
    ]);
    assert.equal(`${cwd}/wrangler.local.jsonc` in fsApi.files, false);
    assert.equal(`${cwd}/.setup-state.json` in fsApi.files, false);
    assert.match(logs.join(''), /Delete complete/);
  });

  it('skips the typed-name confirm on --yes even when stdin is a TTY', async () => {
    const logs = [];
    let asked = 0;
    const calls = [];
    const result = await runDelete({
      args: {
        delete: true,
        name: 'cash-desk',
        nonInteractive: true,
        dryRun: false,
        configPath: 'wrangler.local.jsonc',
      },
      cwd: '/tmp/app-v2-delete-yes-tty',
      stdout: { write: (text) => logs.push(text) },
      write: (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`),
      isTTY: true,
      ask: async () => {
        asked += 1;
        throw new Error('--yes should not open readline');
      },
      fsApi: memoryFs(),
      wrangler: {
        planned: [],
        async listWorkers() {
          return [{ name: 'cash-desk' }];
        },
        async listD1() {
          return [{ name: 'cash-desk-db', id: '11111111-1111-4111-8111-111111111111' }];
        },
        async listKv() {
          return [{ title: 'cash-desk-kv', id: 'abcdef0123456789abcdef0123456789' }];
        },
        async deleteWorker(name) {
          calls.push(`deleteWorker ${name}`);
        },
        async deleteD1(name) {
          calls.push(`deleteD1 ${name}`);
        },
        async deleteKv(id) {
          calls.push(`deleteKv ${id}`);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(asked, 0);
    assert.deepEqual(calls, [
      'deleteWorker cash-desk',
      'deleteD1 cash-desk-db',
      'deleteKv abcdef0123456789abcdef0123456789',
    ]);
  });
});

describe('runSetup --delete', () => {
  it('refuses reserved production names before any delete command', {
    skip: RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length === 0,
  }, async () => {
    const reservedWorker = RESERVED_PRODUCTION_WORKERS_DEV_LABELS[0];
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--dry-run', '--delete', reservedWorker],
          cwd: '/tmp/app-v2-delete-reserved',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs(),
        }),
      /reserved production names list/,
    );
  });

  it('refuses wrangler.jsonc as the delete config', async () => {
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--dry-run', '--delete', 'cash-desk', '--config', 'wrangler.jsonc'],
          cwd: '/tmp/app-v2-delete-jsonc',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs(),
        }),
      /Refusing to use wrangler\.jsonc/,
    );
  });

  it('prints the delete plan and skips confirm on --dry-run without --yes', async () => {
    const logs = [];
    let asked = 0;
    const result = await runSetup({
      argv: ['--delete', 'cash-desk', '--dry-run'],
      cwd: '/tmp/app-v2-delete-dry-no-yes',
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async () => {
        asked += 1;
        throw new Error('dry-run should not open readline');
      },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fs: memoryFs(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.delete, true);
    assert.equal(asked, 0);
    assert.match(logs.join(''), /Dry-run delete plan/);
    assert.doesNotMatch(logs.join(''), /Type the Worker name/);
  });

  it('picks a numbered Worker on --delete --dry-run without a name, then skips confirm', async () => {
    const logs = [];
    const questions = [];
    const result = await runSetup({
      argv: ['--delete', '--dry-run'],
      cwd: '/tmp/app-v2-delete-dry-pick',
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async (question) => {
        questions.push(question);
        return '1';
      },
      run: async (spec) => {
        const line = spec.command.join(' ');
        if (line.includes('whoami')) {
          return { code: 0, stdout: 'authenticated\nemail: tester@example.com\n', stderr: '' };
        }
        if (line.includes('workers list')) {
          return { code: 0, stdout: '[{"name":"cash-desk"}]', stderr: '' };
        }
        if (line.includes('d1 list')) {
          return {
            code: 0,
            stdout: '[{"name":"cash-desk-db","uuid":"11111111-1111-4111-8111-111111111111"}]',
            stderr: '',
          };
        }
        if (line.includes('kv namespace list')) {
          return {
            code: 0,
            stdout: '[{"title":"cash-desk-kv","id":"abcdef0123456789abcdef0123456789"}]',
            stderr: '',
          };
        }
        if (line.includes('wrangler delete') || line.includes('d1 delete') || line.includes('kv namespace delete')) {
          throw new Error(`dry-run must not write: ${line}`);
        }
        return { code: 0, stdout: '4.0.0', stderr: '' };
      },
      fs: memoryFs(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.workerName, 'cash-desk');
    assert.equal(result.plan.d1.name, 'cash-desk-db');
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Number:/);
    assert.match(logs.join(''), /1\. cash-desk/);
    assert.match(logs.join(''), /Dry-run delete plan/);
    assert.doesNotMatch(logs.join(''), /Type the Worker name/);
  });

  it('skips confirm on --yes for a live delete path (mocked, no Cloudflare write)', async () => {
    const logs = [];
    let asked = 0;
    const calls = [];
    const result = await runSetup({
      argv: ['--yes', '--delete', 'cash-desk'],
      cwd: '/tmp/app-v2-delete-yes-tty',
      isTTY: true,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async () => {
        asked += 1;
        throw new Error('--yes should not open readline');
      },
      run: async (spec) => {
        const line = spec.command.join(' ');
        calls.push(line);
        if (line.includes('whoami')) {
          return { code: 0, stdout: 'authenticated\nemail: tester@example.com\n', stderr: '' };
        }
        if (line.includes('workers list')) {
          return { code: 0, stdout: '[{"name":"cash-desk"}]', stderr: '' };
        }
        if (line.includes('d1 list')) {
          return {
            code: 0,
            stdout: '[{"name":"cash-desk-db","uuid":"11111111-1111-4111-8111-111111111111"}]',
            stderr: '',
          };
        }
        if (line.includes('kv namespace list')) {
          return {
            code: 0,
            stdout: '[{"title":"cash-desk-kv","id":"abcdef0123456789abcdef0123456789"}]',
            stderr: '',
          };
        }
        if (line.includes('wrangler delete') || line.includes('d1 delete') || line.includes('kv namespace delete')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '4.0.0', stderr: '' };
      },
      fs: memoryFs({
        '/tmp/app-v2-delete-yes-tty/node_modules/wrangler/package.json': '{}',
        '/tmp/app-v2-delete-yes-tty/node_modules/.bin/wrangler': '',
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(asked, 0);
    assert.equal(
      calls.some((line) => line.includes('wrangler delete --name cash-desk')),
      true,
    );
    assert.match(logs.join(''), /Delete complete/);
  });

  it('lists live D1/KV on --delete --dry-run when wrangler.local.jsonc is missing', async () => {
    const logs = [];
    const calls = [];
    const result = await runSetup({
      argv: ['--delete', 'cash-desk', '--dry-run'],
      cwd: '/tmp/app-v2-delete-dry-live-list',
      isTTY: false,
      stdout: { write: (text) => logs.push(text) },
      stderr: { write: (text) => logs.push(text) },
      ask: async () => {
        throw new Error('dry-run should not open readline');
      },
      run: async (spec) => {
        const line = spec.command.join(' ');
        calls.push(line);
        if (line.includes('whoami')) {
          return { code: 0, stdout: 'authenticated\nemail: tester@example.com\n', stderr: '' };
        }
        if (line.includes('workers list')) {
          return { code: 0, stdout: '[{"name":"cash-desk"}]', stderr: '' };
        }
        if (line.includes('d1 list')) {
          return {
            code: 0,
            stdout: '[{"name":"cash-desk-db","uuid":"11111111-1111-4111-8111-111111111111"}]',
            stderr: '',
          };
        }
        if (line.includes('kv namespace list')) {
          return {
            code: 0,
            stdout: '[{"title":"cash-desk-kv","id":"abcdef0123456789abcdef0123456789"}]',
            stderr: '',
          };
        }
        if (line.includes('wrangler delete') || line.includes('d1 delete') || line.includes('kv namespace delete')) {
          throw new Error(`dry-run must not write: ${line}`);
        }
        return { code: 0, stdout: '4.0.0', stderr: '' };
      },
      fs: memoryFs(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.d1.name, 'cash-desk-db');
    assert.equal(result.plan.d1.id, '11111111-1111-4111-8111-111111111111');
    assert.equal(result.plan.kv.name, 'cash-desk-kv');
    assert.equal(result.plan.kv.id, 'abcdef0123456789abcdef0123456789');
    assert.deepEqual(result.plan.localFiles, []);
    assert.match(logs.join(''), /cash-desk-db/);
    assert.match(logs.join(''), /cash-desk-kv/);
    assert.doesNotMatch(logs.join(''), /none found for this install/);
    assert.equal(calls.some((line) => line.includes('d1 list')), true);
    assert.equal(calls.some((line) => line.includes('kv namespace list')), true);
    assert.equal(
      calls.some((line) => line.includes('wrangler delete') || line.includes('d1 delete') || line.includes('kv namespace delete')),
      false,
    );
  });

  it('requires a Worker name with --yes when --delete has no operand', async () => {
    await assert.rejects(
      () =>
        runSetup({
          argv: ['--yes', '--dry-run', '--delete'],
          cwd: '/tmp/app-v2-delete-yes-noname',
          isTTY: false,
          stdout: { write() {} },
          stderr: { write() {} },
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
          fs: memoryFs(),
        }),
      /Pass --delete <workerName> with --yes/,
    );
  });
});
