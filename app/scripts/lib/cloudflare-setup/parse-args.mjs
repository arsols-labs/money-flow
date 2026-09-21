import { DEFAULT_WORKER_NAME, LOCAL_CONFIG_NAME } from './constants.mjs';

const HELP_TEXT = `Money Flow v2 — Cloudflare setup

Create D1 + KV on YOUR Cloudflare account, write wrangler.local.jsonc,
apply migrations, and deploy the Worker + assets.

Usage:
  npm run setup -- [options]
  ./scripts/setup.sh [options]
  node scripts/setup.mjs [options]

Options:
  --name <worker>              Worker/service name (default: ${DEFAULT_WORKER_NAME})
  --hostname-mode <mode>       workers-dev | custom
  --hostname <host>            Custom hostname (required when mode=custom)
  --d1-name <name>             D1 database name (default: <worker>-db)
  --kv-name <name>             KV namespace title (default: <worker>-kv)
  --config <path>              Local wrangler config to write (default: ${LOCAL_CONFIG_NAME})
  --account-subdomain <sub>    workers.dev account subdomain (optional)
  --delete [worker]            Delete that Worker + related setup resources
  --yes, --non-interactive, -y Do not prompt; use flags and defaults
  --dry-run                    Plan only: no Cloudflare writes, no deploy, no confirm.
                               Still runs read-only account lists (whoami / workers / D1 / KV)
  --skip-deploy                Create resources + config; do not deploy or upload secrets
  --skip-migrate               Skip remote D1 migrations
  --skip-secrets               Do not generate or upload Worker secrets
  --skip-build                 Skip npm run build before deploy
  --seed-demo                  After migrate, seed a stranger-safe English product showcase
  --no-seed-demo               Leave the instance empty after migrate (default)
  --rotate-secrets             Replace SESSION_SECRET and SETUP_TOKEN and print the new values once
  --rotate-setup-token         Alias for --rotate-secrets
  -h, --help                   Show this help

Interactive prompts run only on a TTY. For CI, pass --yes plus the flags you need.
Goal path on a TTY: confirm npm install (if needed) → Cloudflare login → setup.
Missing node_modules / local Wrangler: TTY asks "Install dependencies now? [Y/n]",
then runs npm install here and continues with npx wrangler (no global Wrangler).
--yes fails closed if dependencies are missing (prints: npm install)
or if Wrangler is not logged in (prints: npx wrangler login).
On a TTY without --yes, setup can run npx wrangler login for you.
Node.js 20+ is required (https://nodejs.org/).
SETUP_SEED_DEMO=yes|no also skips the prompt when the flags are omitted.
On a TTY, an existing wrangler.local.jsonc shows that local config is
in use, that re-runs reuse the same D1 / KV / Worker, and how to start
from scratch (delete that file, then re-run). It also shows the Worker
name, hostname mode, and domain and asks to reuse or change them.
After deploy, setup prints SESSION_SECRET and SETUP_TOKEN once, then
waits for the MCP HTTP endpoint and OAuth discovery (no chatbot).
HTTP 401 on /mcp without a token is expected. A failed check after the
wait is a warning; setup still exits 0 after a successful deploy.
If those Worker secrets already exist, a TTY asks to rotate them; --yes
prints --rotate-secrets instead of the values.

Delete (teardown a setup install):
  npm run setup -- --delete
  npm run setup -- --delete cash-desk
  npm run setup -- --delete cash-desk --dry-run
  npm run setup -- --delete cash-desk --yes
  npm run setup -- --delete cash-desk --yes --dry-run

--delete without a name lists Workers (account + relevant local install),
numbered. Type a digit to pick one. Reserved production names are listed
as protected and cannot be chosen.
A live TTY delete must type the Worker name to confirm. --yes skips
confirms and requires an explicit Worker name. --delete --dry-run
without a name still lists Workers and waits for a number, then prints
the plan and exits 0 without confirm (no typed-name prompt). --delete NAME --dry-run
prints the plan and exits 0 with no readline. Dry-run still lists
Workers, D1, and KV from the live Cloudflare account (read-only) so the
plan matches a real delete even when wrangler.local.jsonc is missing. It
never runs delete / create / deploy / secret put.

Delete removes the Worker (including its secrets/bindings), then the D1
and KV owned by that install (from wrangler.local.jsonc / .setup-state.json
or the <worker>-db / <worker>-kv naming convention). It never targets resources from the committed production wrangler.jsonc. Matching gitignored local files are removed after
a successful remote delete.
`

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {import('./types.js').SetupArgs}
 */
export function parseArgs(argv) {
  const args = {
    help: false,
    dryRun: false,
    nonInteractive: false,
    skipDeploy: false,
    skipMigrate: false,
    skipSecrets: false,
    skipBuild: false,
    seedDemo: null,
    rotateSecrets: false,
    delete: false,
    name: null,
    hostnameMode: null,
    hostname: null,
    d1Name: null,
    kvName: null,
    configPath: LOCAL_CONFIG_NAME,
    accountSubdomain: null,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return value;
    };

    switch (token) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--yes':
      case '--non-interactive':
      case '-y':
        args.nonInteractive = true;
        break;
      case '--skip-deploy':
        args.skipDeploy = true;
        break;
      case '--skip-migrate':
        args.skipMigrate = true;
        break;
      case '--skip-secrets':
        args.skipSecrets = true;
        break;
      case '--skip-build':
        args.skipBuild = true;
        break;
      case '--seed-demo':
        if (args.seedDemo === false) {
          throw new Error('Use only one of --seed-demo or --no-seed-demo.');
        }
        args.seedDemo = true;
        break;
      case '--no-seed-demo':
        if (args.seedDemo === true) {
          throw new Error('Use only one of --seed-demo or --no-seed-demo.');
        }
        args.seedDemo = false;
        break;
      case '--rotate-secrets':
      case '--rotate-setup-token':
        args.rotateSecrets = true;
        break;
      case '--delete': {
        args.delete = true;
        const peek = argv[i + 1];
        if (peek !== undefined && !peek.startsWith('-')) {
          const value = next();
          if (args.name && args.name !== value) {
            throw new Error('Use only one Worker name (--delete <name> or --name <name>).');
          }
          args.name = value;
        }
        break;
      }
      case '--name': {
        const value = next();
        if (args.name && args.name !== value) {
          throw new Error('Use only one Worker name (--delete <name> or --name <name>).');
        }
        args.name = value;
        break;
      }
      case '--hostname-mode':
        args.hostnameMode = next();
        break;
      case '--hostname':
        args.hostname = next();
        break;
      case '--d1-name':
        args.d1Name = next();
        break;
      case '--kv-name':
        args.kvName = next();
        break;
      case '--config':
        args.configPath = next();
        break;
      case '--account-subdomain':
        args.accountSubdomain = next();
        break;
      default:
        if (token.startsWith('-')) {
          args.unknown.push(token);
        } else {
          args.unknown.push(token);
        }
        break;
    }
  }

  return args;
}

export function formatHelp() {
  return HELP_TEXT;
}
