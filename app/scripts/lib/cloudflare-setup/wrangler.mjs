import {
  isAuthError,
  parseD1CreateOutput,
  parseD1List,
  parseDeployUrls,
  parseKvCreateOutput,
  parseKvList,
  parseSecretList,
  parseWhoami,
  parseWorkerList,
} from './parse-output.mjs';
import { isReservedProductionResourceId } from './validate.mjs';

/**
 * @typedef {{
 *   command: string[],
 *   cwd?: string,
 *   input?: string,
 * }} RunSpec
 *
 * @typedef {{
 *   code: number,
 *   stdout: string,
 *   stderr: string,
 * }} RunResult
 */

export class SetupError extends Error {
  /**
   * @param {string} message
   * @param {{ hint?: string, code?: string }} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SetupError';
    this.hint = extra.hint;
    this.code = extra.code;
  }
}

function quoted(args) {
  return args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ');
}

/**
 * Dry-run must never issue Cloudflare writes. Account inventory reads stay live
 * so `--delete --dry-run` can resolve Worker / D1 / KV by name without
 * `wrangler.local.jsonc`.
 *
 * @param {string[]} args wrangler argv after `npx wrangler`
 */
export function isReadOnlyWranglerCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const [head, second, third] = args;
  if (head === '--version' || head === 'whoami') return true;
  if (head === 'workers' && second === 'list') return true;
  if (head === 'd1' && second === 'list') return true;
  if (head === 'kv' && second === 'namespace' && third === 'list') return true;
  if (head === 'secret' && second === 'list') return true;
  return false;
}

/**
 * @param {{
 *   run: (spec: RunSpec) => Promise<RunResult>,
 *   dryRun?: boolean,
 *   cwd: string,
 *   log?: (line: string) => void,
 * }} options
 */
export function createWranglerClient(options) {
  const { run, dryRun = false, cwd, log = () => {} } = options;
  const planned = [];

  async function wrangler(args, { input, allowFail = false, inheritStdio = false } = {}) {
    const command = ['npx', 'wrangler', ...args];
    planned.push({ command, input: input ? '[redacted]' : undefined });
    if (dryRun && !isReadOnlyWranglerCommand(args)) {
      return { code: 0, stdout: '', stderr: '', dryRun: true };
    }
    const result = await run({ command, cwd, input, inheritStdio });
    if (result.code !== 0 && !allowFail) {
      if (isAuthError(result.stderr, result.stdout)) {
        throw new SetupError('Wrangler is not authenticated with Cloudflare.', {
          code: 'auth',
          hint: 'Run: npx wrangler login',
        });
      }
      throw new SetupError(
        `Command failed (${result.code}): ${quoted(command)}\n${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  return {
    planned,
    async version() {
      const result = await wrangler(['--version'], { allowFail: true });
      return (result.stdout || result.stderr).trim();
    },
    async whoami() {
      const result = await wrangler(['whoami'], { allowFail: true });
      if (result.code !== 0 || isAuthError(result.stderr, result.stdout)) {
        if (dryRun) {
          return { loggedIn: true, email: 'dry-run@example.com', accountId: 'dry-run', accountName: 'dry-run' };
        }
        return { loggedIn: false, email: null, accountId: null, accountName: null };
      }
      const parsed = parseWhoami(`${result.stdout}\n${result.stderr}`);
      if (dryRun && !parsed.loggedIn) {
        return { loggedIn: true, email: 'dry-run@example.com', accountId: 'dry-run', accountName: 'dry-run' };
      }
      return parsed;
    },
    async login() {
      return wrangler(['login'], { allowFail: true, inheritStdio: true });
    },
    async listD1() {
      const result = await wrangler(['d1', 'list', '--json'], { allowFail: true });
      return parseD1List(result.stdout || result.stderr);
    },
    async createD1(name) {
      const existing = (await this.listD1()).find((row) => row.name === name);
      if (existing) {
        if (isReservedProductionResourceId(existing.id)) {
          throw new SetupError('Existing D1 id matches a reserved production binding. Choose another database name.');
        }
        log(`Reusing existing D1 database "${name}" (${existing.id}).`);
        return existing;
      }
      const result = await wrangler(['d1', 'create', name]);
      if (dryRun) {
        return { name, id: '00000000-0000-4000-8000-000000000001' };
      }
      const created = parseD1CreateOutput(result.stdout || result.stderr);
      if (!created.id) {
        throw new SetupError(`Could not parse D1 id from wrangler d1 create ${name}.`);
      }
      if (isReservedProductionResourceId(created.id)) {
        throw new SetupError('Refusing to use a reserved production D1 id.');
      }
      return { name, id: created.id };
    },
    async listKv() {
      const result = await wrangler(['kv', 'namespace', 'list'], { allowFail: true });
      return parseKvList(result.stdout || result.stderr);
    },
    async createKv(title) {
      const existing = (await this.listKv()).find((row) => row.title === title);
      if (existing) {
        if (isReservedProductionResourceId(existing.id)) {
          throw new SetupError('Existing KV id matches a reserved production binding. Choose another namespace title.');
        }
        log(`Reusing existing KV namespace "${title}" (${existing.id}).`);
        return existing;
      }
      const result = await wrangler(['kv', 'namespace', 'create', title]);
      if (dryRun) {
        return { title, id: '00000000000000000000000000000001' };
      }
      const created = parseKvCreateOutput(result.stdout || result.stderr);
      if (!created.id) {
        throw new SetupError(`Could not parse KV id from wrangler kv namespace create ${title}.`);
      }
      if (isReservedProductionResourceId(created.id)) {
        throw new SetupError('Refusing to use a reserved production KV id.');
      }
      return { title, id: created.id };
    },
    async applyMigrations(databaseName, configPath) {
      return wrangler([
        'd1',
        'migrations',
        'apply',
        databaseName,
        '--remote',
        '--config',
        configPath,
      ]);
    },
    async executeSqlFile(databaseName, filePath, configPath) {
      return wrangler([
        'd1',
        'execute',
        databaseName,
        '--remote',
        '--yes',
        '--file',
        filePath,
        '--config',
        configPath,
      ]);
    },
    async listSecrets(configPath) {
      const result = await wrangler(['secret', 'list', '--config', configPath, '--json'], {
        allowFail: true,
      });
      return parseSecretList(result.stdout || result.stderr);
    },
    async putSecret(name, value, configPath) {
      return wrangler(['secret', 'put', name, '--config', configPath], { input: `${value}\n` });
    },
    async listWorkers() {
      const jsonResult = await wrangler(['workers', 'list', '--json'], { allowFail: true });
      const fromJson = parseWorkerList(jsonResult.stdout || jsonResult.stderr);
      if (fromJson.length > 0 || jsonResult.code === 0) return fromJson;
      const tableResult = await wrangler(['workers', 'list'], { allowFail: true });
      return parseWorkerList(tableResult.stdout || tableResult.stderr);
    },
    async deleteWorker(name) {
      return wrangler(['delete', '--name', name, '--force']);
    },
    async deleteD1(name) {
      return wrangler(['d1', 'delete', name, '--skip-confirmation']);
    },
    async deleteKv(namespaceId) {
      return wrangler(['kv', 'namespace', 'delete', '--namespace-id', namespaceId, '--skip-confirmation']);
    },
    async deploy(configPath, { workerName } = {}) {
      const result = await wrangler(['deploy', '--config', configPath]);
      if (dryRun) {
        return {
          urls: [],
          workersDev: null,
          stdout: '',
        };
      }
      return {
        ...parseDeployUrls(`${result.stdout}\n${result.stderr}`, { workerName }),
        stdout: result.stdout,
      };
    },
  };
}

export function loginHint({ nonInteractive = false } = {}) {
  return [
    'Cloudflare authentication is required.',
    nonInteractive
      ? 'Non-interactive / --yes cannot open a browser.'
      : 'This machine is not logged in to Cloudflare.',
    'Run this exact command, complete the browser login, then re-run setup:',
    '',
    '  npx wrangler login',
    '',
    'A User API Token in CLOUDFLARE_API_TOKEN also works (User Details Read is optional).',
    '',
  ].join('\n');
}
