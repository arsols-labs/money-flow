import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_WORKER_NAME,
  LOCAL_CONFIG_NAME,
  MIN_NODE_MAJOR,
  STATE_FILE_NAME,
} from './constants.mjs';
import {
  buildLocalWranglerConfig,
  originFromHostname,
  parseLocalWranglerConfig,
  serializeWranglerJsonc,
  workersDevOrigin,
} from './config.mjs';
import { formatHelp, parseArgs } from './parse-args.mjs';
import { waitForMcpHealth } from './mcp-health.mjs';
import {
  closePrompter,
  collectAnswers,
  createLinePrompter,
  formatLocalConfigInUseCopy,
  releaseStdin,
  SEED_RESET_HINT,
} from './prompts.mjs';
import { createStyle, styleEnabled } from './style.mjs';
import {
  formatDepsInstallHint,
  formatDepsMissingPromptIntro,
  formatNodeRequirementError,
  inspectLocalSetupDeps,
} from './deps.mjs';
import { DEMO_SEED_RELATIVE_PATH, parseYesNo, resolveSeedDemoChoice } from './seed-demo.mjs';
import {
  isReservedProductionHostname,
  isReservedProductionResourceId,
  isStableWorkersDevHost,
  parseNodeMajor,
  validateAppDomain,
  validateResourceId,
} from './validate.mjs';
import { runDelete } from './delete.mjs';
import { SetupError, createWranglerClient, loginHint } from './wrangler.mjs';

export { parseArgs, formatHelp, SetupError };

function defaultRun({ command, cwd, input, inheritStdio = false }) {
  return new Promise((resolve) => {
    if (inheritStdio) {
      const child = spawn(command[0], command.slice(1), {
        cwd,
        env: process.env,
        stdio: 'inherit',
      });
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout: '', stderr: '' });
      });
      return;
    }
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: process.env,
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function generateSecret() {
  return randomBytes(32).toString('hex');
}

function writeDevVarsContents({ appDomain, sessionSecret, setupToken }) {
  const lines = [
    '# Written by npm run setup for local `wrangler dev`. Gitignored. Do not commit.',
    `APP_DOMAIN=${appDomain}`,
  ];
  if (sessionSecret) lines.push(`SESSION_SECRET=${sessionSecret}`);
  if (setupToken) lines.push(`SETUP_TOKEN=${setupToken}`);
  lines.push('');
  return lines.join('\n');
}

function customDomainNextSteps(hostname) {
  return [
    `Custom domain "${hostname}" must be an active zone (or a hostname in a zone) on the same Cloudflare account.`,
    'If deploy reports a zone / custom-domain error:',
    '  1. Add the domain to Cloudflare and wait until the zone is Active.',
    '  2. In the dashboard: Workers & Pages → your Worker → Settings → Domains & Routes → Add → Custom Domain.',
    '  3. Re-run: npm run setup -- --yes --hostname-mode custom --hostname ' + hostname,
    'You cannot attach a custom domain on a zone you do not own, or on a hostname that already has a conflicting CNAME.',
  ];
}

function formatPrintedSecrets({ sessionSecret, setupToken, style }) {
  if (!sessionSecret && !setupToken) return [];
  const paint = style ?? createStyle({ enabled: false });
  const lines = [
    '',
    paint.heading('Secrets (shown once — save them in a password manager now):'),
    '',
  ];
  if (setupToken) {
    lines.push(
      `  SETUP_TOKEN     ${paint.secret(setupToken)}`,
      '    First Passkey enroll / recovery at /setup/passkey.',
      '    Paste this into the password field. Do not put it in a query string.',
      '',
    );
  }
  if (sessionSecret) {
    lines.push(
      `  SESSION_SECRET  ${paint.secret(sessionSecret)}`,
      '    Session signing key. Do not share it.',
      '',
    );
  }
  lines.push(paint.danger('These Worker secrets are not shown again after this run.'));
  return lines;
}

function formatExistingSecretsHint({ hasSession, hasSetup }) {
  const names = [
    hasSetup ? 'SETUP_TOKEN' : null,
    hasSession ? 'SESSION_SECRET' : null,
  ].filter(Boolean);
  const label = names.join(' and ');
  return [
    '',
    `${label} ${names.length === 1 ? 'is' : 'are'} already set on the Worker and cannot be shown again.`,
    'Save them in a password manager:',
    '  SETUP_TOKEN — first Passkey enroll / recovery at /setup/passkey',
    '  SESSION_SECRET — session signing; do not share',
    '',
    'To regenerate both and print the new values:',
    '',
    '  npm run setup -- --yes --rotate-secrets',
    '',
    '--rotate-setup-token is an alias. Rotating SESSION_SECRET signs out every session.',
    'Or delete a secret and re-run setup:',
    '  npx wrangler secret delete SETUP_TOKEN --config wrangler.local.jsonc',
    '  npx wrangler secret delete SESSION_SECRET --config wrangler.local.jsonc',
  ];
}

function formatMcpHealthWarning(mcpHealth) {
  const mcpStatus = mcpHealth?.mcp?.status;
  const mcpExpectedUnauth = mcpHealth?.mcpExpectedUnauth || mcpStatus === 401;
  const mcpLine =
    mcpHealth?.mcp?.ok || mcpExpectedUnauth
      ? null
      : `  ${mcpHealth?.mcp?.url || '/mcp'} — ${mcpHealth?.mcp?.error || `HTTP ${mcpStatus ?? 0}`}`;
  return [
    'MCP health check did not pass (setup still finished).',
    mcpLine,
    mcpHealth?.oauth?.ok
      ? null
      : `  ${mcpHealth?.oauth?.url || '/.well-known/oauth-authorization-server'} — ${mcpHealth?.oauth?.error || `HTTP ${mcpHealth?.oauth?.status ?? 0}`}`,
    '  Open the app origin in a browser; the Worker may still be propagating.',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSummary({
  appOrigin,
  mcpOrigin,
  setupUrl,
  sessionSecret,
  setupToken,
  secretsAlreadySet,
  dryRun,
  hostnameMode,
  hostname,
  style,
  mcpHealth,
  configPath,
  seedDemo,
  localConfigInUse,
}) {
  const paint = style ?? createStyle({ enabled: false });
  const lines = [
    '',
    paint.ok(dryRun ? 'Dry-run complete (no Cloudflare writes).' : 'Setup complete.'),
    '',
    `App origin:     ${paint.info(appOrigin)}`,
    `MCP endpoint:   ${paint.info(`${mcpOrigin}/mcp`)}`,
  ];
  if (mcpHealth) {
    lines.push(
      mcpHealth.ok
        ? `MCP health:     ${paint.ok('ok')}`
        : `MCP health:     ${paint.warn('warning — check did not pass; setup still finished')}`,
    );
  }
  lines.push(
    `Passkey setup:  ${paint.info(setupUrl)}`,
    '',
    'Next steps:',
    '  1. Open the app origin in a browser.',
    '  2. Enroll a Passkey at the Passkey setup URL (or the login screen).',
    '  3. Paste SETUP_TOKEN into the password field. Do not put it in a query string.',
    '  4. Save SESSION_SECRET and SETUP_TOKEN in a password manager.',
    '  5. Point an MCP client at the MCP endpoint after you have signed in and created an OAuth client.',
  );
  if (hostnameMode === 'custom') {
    lines.push('', ...customDomainNextSteps(hostname));
  }
  if (sessionSecret || setupToken) {
    lines.push(...formatPrintedSecrets({ sessionSecret, setupToken, style: paint }));
  } else if (secretsAlreadySet) {
    lines.push(
      ...formatExistingSecretsHint({
        hasSession: secretsAlreadySet.session,
        hasSetup: secretsAlreadySet.setup,
      }),
    );
  }
  if (localConfigInUse) {
    lines.push(
      '',
      formatLocalConfigInUseCopy({
        configPath: configPath || LOCAL_CONFIG_NAME,
        seedDemo,
      }),
    );
  } else {
    lines.push(
      '',
      `Local config: ${configPath || LOCAL_CONFIG_NAME} (gitignored). Re-run npm run setup to reuse the same D1/KV/Worker.`,
    );
    if (seedDemo) {
      lines.push(SEED_RESET_HINT);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function initialWorkersDevAppDomain({ name, accountSubdomain, existingHost }) {
  if (accountSubdomain) return `${name}.${accountSubdomain}.workers.dev`;
  if (existingHost && isStableWorkersDevHost(existingHost, name) && !isReservedProductionHostname(existingHost)) {
    return existingHost;
  }
  return `${name}.<your-subdomain>.workers.dev`;
}

function hostFromWorkersDevUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function ensureLocalWrangler({
  args,
  cwd,
  fsApi,
  isTTY,
  ask,
  run,
  stdout,
  stderr,
  write,
}) {
  const deps = await inspectLocalSetupDeps(fsApi.fileExists, cwd);
  if (deps.ready) return { installed: false, skipped: false };

  if (args.dryRun) {
    write(
      stdout,
      'Local Wrangler / node_modules not found. Dry-run skips npm install (live setup would ask).',
    );
    return { installed: false, skipped: true };
  }

  const canOfferInstall = isTTY && !args.nonInteractive;
  if (canOfferInstall) {
    write(stdout, formatDepsMissingPromptIntro());
    const typed = await ask('Install dependencies now? [Y/n]: ', { defaultValue: 'y' });
    const doInstall = parseYesNo(typed, { emptyDefault: true }) ?? true;
    if (doInstall) {
      write(stdout, 'Running npm install in this directory…');
      write(stdout, 'Afterward setup uses `npx wrangler` from app/ (no global Wrangler needed).');
      const result = await run({ command: ['npm', 'install'], cwd, inheritStdio: true });
      if (result.code !== 0) {
        throw new SetupError('npm install failed.', {
          code: 'deps',
          hint: 'npm install',
        });
      }
      const after = await inspectLocalSetupDeps(fsApi.fileExists, cwd);
      if (!after.ready) {
        write(stderr, formatDepsInstallHint());
        throw new SetupError('npm install finished, but local Wrangler is still missing.', {
          code: 'deps',
          hint: 'npm install',
        });
      }
      write(stdout, 'Dependencies installed. Continuing with npx wrangler from app/.');
      return { installed: true, skipped: false };
    }
  }

  write(stderr, formatDepsInstallHint());
  throw new SetupError('Local Wrangler is required.', {
    code: 'deps',
    hint: 'npm install',
  });
}

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   isTTY?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   run?: typeof defaultRun,
 *   fs?: { readFile: typeof readFile, writeFile: typeof writeFile, mkdir: typeof mkdir, fileExists: typeof fileExists },
 *   now?: () => string,
 *   randomSecret?: () => string,
 *   fetch?: typeof fetch,
 * }} [options]
 */
export async function runSetup(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(stdin.isTTY);
  const run = options.run ?? defaultRun;
  const fsApi = options.fs ?? {
    readFile,
    writeFile,
    mkdir,
    fileExists,
    unlink,
  };
  const now = options.now ?? (() => new Date().toISOString());
  const randomSecret = options.randomSecret ?? generateSecret;
  const style = createStyle({ enabled: styleEnabled(env, stdout) });
  const write = (stream, text) => {
    stream.write(text.endsWith('\n') ? text : `${text}\n`);
  };
  const ownedPrompter = !options.ask;
  let ask = options.ask ?? null;

  const args = parseArgs(options.argv ?? process.argv.slice(2));
  if (args.unknown.length > 0) {
    throw new SetupError(`Unknown argument(s): ${args.unknown.join(', ')}. Use --help.`);
  }
  if (args.help) {
    write(stdout, formatHelp());
    releaseStdin(stdin);
    return { ok: true, help: true };
  }

  const nodeVersionLabel = env.NODE_VERSION?.replace(/^v/, '') ?? process.versions.node;
  const nodeMajor = parseNodeMajor(nodeVersionLabel);
  if (nodeMajor < MIN_NODE_MAJOR) {
    throw new SetupError(formatNodeRequirementError(nodeVersionLabel), {
      code: 'node',
      hint: 'https://nodejs.org/',
    });
  }
  write(stdout, style.ok(`Node.js ${process.versions.node} — ok.`));

  const wrangler = createWranglerClient({
    run,
    dryRun: args.dryRun,
    cwd,
    log: (line) => write(stdout, style.ok(line)),
  });
  ask = options.ask ?? createLinePrompter(stdin, stdout);

  try {
  await ensureLocalWrangler({
    args,
    cwd,
    fsApi,
    isTTY,
    ask,
    run,
    stdout,
    stderr,
    write,
  });

  const wranglerVersion = await wrangler.version();
  if (!args.dryRun && !wranglerVersion) {
    throw new SetupError(
      'Local Wrangler did not start (`npx wrangler --version`). From app/ run: npm install',
      { code: 'deps', hint: 'npm install' },
    );
  }
  write(
    stdout,
    wranglerVersion
      ? style.ok(`Wrangler ${wranglerVersion} — ok.`)
      : style.dim('Wrangler version check skipped (dry-run).'),
  );

  let identity = await wrangler.whoami();
  if (!identity.loggedIn) {
    const canOfferLogin = isTTY && !args.nonInteractive && !args.dryRun;
    if (canOfferLogin) {
      write(
        stdout,
        'Not logged in to Cloudflare. Setup can open a browser now (`npx wrangler login`).',
      );
      const typed = await ask('Log in to Cloudflare now? [Y/n]: ', { defaultValue: 'y' });
      const startLogin = parseYesNo(typed, { emptyDefault: true }) ?? true;
      if (startLogin) {
        write(stdout, 'Starting npx wrangler login…');
        await wrangler.login();
        identity = await wrangler.whoami();
      }
    }
    if (!identity.loggedIn) {
      write(stderr, loginHint({ nonInteractive: args.nonInteractive }));
      throw new SetupError('Cloudflare authentication required.', {
        code: 'auth',
        hint: 'npx wrangler login',
      });
    }
  }
  write(stdout, identity.email ? `Cloudflare account: ${identity.email}` : 'Cloudflare account: authenticated.');

  const configPath = path.resolve(cwd, args.configPath);
  if (path.basename(configPath) === 'wrangler.jsonc') {
    throw new SetupError(
      args.delete
        ? 'Refusing to use wrangler.jsonc. Delete reads wrangler.local.jsonc so committed production binding ids stay protected.'
        : 'Refusing to overwrite wrangler.jsonc. The setup path writes wrangler.local.jsonc so committed production binding ids stay protected.',
    );
  }

  if (args.delete) {
    return runDelete({
      args,
      cwd,
      stdout,
      write,
      isTTY,
      ask,
      fsApi,
      wrangler,
    });
  }

  let existing = null;
  if (await fsApi.fileExists(configPath)) {
    existing = parseLocalWranglerConfig(await fsApi.readFile(configPath, 'utf8'));
    if (existing.d1.id && isReservedProductionResourceId(existing.d1.id)) {
      throw new SetupError('Existing local config contains a reserved production D1 id. Delete it and re-run setup.');
    }
    if (existing.kv.id && isReservedProductionResourceId(existing.kv.id)) {
      throw new SetupError('Existing local config contains a reserved production KV id. Delete it and re-run setup.');
    }
    if (existing.appDomain && isReservedProductionHostname(existing.appDomain)) {
      throw new SetupError('Existing local config contains a reserved production APP_DOMAIN. Delete it and re-run setup.');
    }
  }

  let seedDemoFlag = args.seedDemo;
  try {
    seedDemoFlag = resolveSeedDemoChoice({
      flag: args.seedDemo,
      envValue: env.SETUP_SEED_DEMO,
    });
  } catch (error) {
    throw new SetupError(error instanceof Error ? error.message : String(error));
  }

  const answers = await collectAnswers({
    flags: { ...args, seedDemo: seedDemoFlag },
    existing,
    configPath,
    ask,
    isTTY,
  });
  if (args.nonInteractive && answers.reusedExisting && answers.reuseNotice) {
    write(
      stdout,
      `${answers.reuseNotice}\nReusing this Worker and hostname (--yes).`,
    );
  } else if (args.nonInteractive && existing) {
    write(
      stdout,
      formatLocalConfigInUseCopy({
        configPath,
        seedDemo: answers.seedDemo,
      }),
    );
  } else if (existing && answers.seedDemo && seedDemoFlag !== true) {
    write(stdout, SEED_RESET_HINT);
  }

  const d1Name = args.d1Name ?? existing?.d1.name ?? `${answers.name}-db`;
  const kvName = args.kvName ?? `${answers.name}-kv`;

  const d1 =
    existing?.d1.id && existing.d1.name === d1Name
      ? existing.d1
      : await wrangler.createD1(d1Name);
  const d1Check = validateResourceId(d1.id, 'D1 id');
  if (!d1Check.ok) throw new SetupError(d1Check.error);

  const kv =
    existing?.kv.id
      ? { title: kvName, id: existing.kv.id }
      : await wrangler.createKv(kvName);
  const kvCheck = validateResourceId(kv.id, 'KV id');
  if (!kvCheck.ok) throw new SetupError(kvCheck.error);

  const appDomain =
    answers.hostnameMode === 'custom'
      ? answers.hostname
      : initialWorkersDevAppDomain({
          name: answers.name,
          accountSubdomain: args.accountSubdomain,
          existingHost: existing?.appDomain,
        });

  const domainCheck = validateAppDomain(appDomain);
  if (!domainCheck.ok) throw new SetupError(domainCheck.error);

  const config = buildLocalWranglerConfig({
    name: answers.name,
    hostnameMode: answers.hostnameMode,
    hostname: answers.hostname,
    appDomain,
    d1: { name: d1Name, id: d1.id },
    kv: { id: kv.id, name: kvName },
  });

  if (!args.dryRun) {
    await fsApi.mkdir(path.dirname(configPath), { recursive: true });
    await fsApi.writeFile(configPath, serializeWranglerJsonc(config), 'utf8');
    write(stdout, `Wrote ${configPath}`);
  } else {
    write(stdout, `Dry-run: would write ${configPath}`);
    write(stdout, serializeWranglerJsonc(config));
  }

  const statePath = path.join(cwd, STATE_FILE_NAME);
  const state = {
    version: 1,
    workerName: answers.name,
    hostnameMode: answers.hostnameMode,
    hostname: answers.hostname,
    d1: { name: d1Name, id: d1.id },
    kv: { name: kvName, id: kv.id },
    updatedAt: now(),
  };
  if (!args.dryRun) {
    await fsApi.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  if (!args.skipMigrate) {
    write(stdout, args.dryRun ? 'Dry-run: would apply remote D1 migrations.' : 'Applying remote D1 migrations…');
    await wrangler.applyMigrations(d1Name, args.configPath);
  }

  if (answers.seedDemo) {
    write(
      stdout,
      args.dryRun
        ? 'Dry-run: would seed stranger-safe demo data.'
        : 'Seeding stranger-safe demo data…',
    );
    await wrangler.executeSqlFile(d1Name, DEMO_SEED_RELATIVE_PATH, args.configPath);
  } else {
    write(stdout, 'Leaving the instance empty (no demo seed).');
  }

  if (!args.skipBuild && !args.skipDeploy) {
    write(stdout, args.dryRun ? 'Dry-run: would run npm run build.' : 'Building Worker + assets…');
    if (!args.dryRun) {
      const build = await run({ command: ['npm', 'run', 'build'], cwd });
      if (build.code !== 0) {
        throw new SetupError(`npm run build failed.\n${build.stderr || build.stdout}`);
      }
    }
  }

  let deployUrls = { urls: [], workersDev: null };
  if (!args.skipDeploy) {
    write(
      stdout,
      args.dryRun
        ? 'Dry-run: would deploy the Worker (create or update).'
        : 'Deploying Worker + assets (creates or updates the Worker)…',
    );
    try {
      deployUrls = await wrangler.deploy(args.configPath, { workerName: answers.name });
    } catch (error) {
      if (answers.hostnameMode === 'custom') {
        write(stderr, customDomainNextSteps(answers.hostname).join('\n'));
      }
      throw error;
    }
  }

  let stableHost = hostFromWorkersDevUrl(deployUrls.workersDev);
  if (stableHost && (isReservedProductionHostname(stableHost) || !isStableWorkersDevHost(stableHost, answers.name))) {
    stableHost = null;
  }
  if (!stableHost && args.accountSubdomain) {
    const candidate = `${answers.name}.${args.accountSubdomain}.workers.dev`;
    if (isStableWorkersDevHost(candidate, answers.name) && !isReservedProductionHostname(candidate)) {
      stableHost = candidate;
    }
  }

  if (answers.hostnameMode === 'workers-dev' && !args.dryRun && !args.skipDeploy && !stableHost) {
    throw new SetupError(
      'Deploy finished but no resolving workers.dev URL was found in Wrangler output. Re-run with --account-subdomain <subdomain> (the label in <name>.<subdomain>.workers.dev).',
    );
  }

  if (
    !args.dryRun &&
    !args.skipDeploy &&
    answers.hostnameMode === 'workers-dev' &&
    stableHost &&
    config.vars.APP_DOMAIN !== stableHost
  ) {
    config.vars.APP_DOMAIN = stableHost;
    await fsApi.writeFile(configPath, serializeWranglerJsonc(config), 'utf8');
    write(stdout, `Updated APP_DOMAIN to ${stableHost} and redeploying once…`);
    await wrangler.deploy(args.configPath, { workerName: answers.name });
  }

  const workersOrigin = stableHost
    ? `https://${stableHost}`
    : workersDevOrigin(answers.name, args.accountSubdomain);
  const appOrigin =
    answers.hostnameMode === 'custom'
      ? originFromHostname(answers.hostname)
      : stableHost
        ? `https://${stableHost}`
        : originFromHostname(config.vars.APP_DOMAIN) ?? workersOrigin;

  let setupToken = null;
  let sessionSecret = null;
  let secretsAlreadySet = null;
  if (args.skipSecrets) {
    write(stdout, 'Skipping secret upload (--skip-secrets).');
    if (args.rotateSecrets) {
      write(stdout, 'Ignoring --rotate-secrets because --skip-secrets is set.');
    }
  } else if (args.skipDeploy) {
    write(
      stdout,
      'Skipping secret upload because no Worker code was deployed (wrangler secret put deploys immediately).',
    );
  } else {
    const existingSecrets = args.dryRun ? [] : await wrangler.listSecrets(args.configPath);
    const hasSession = existingSecrets.includes('SESSION_SECRET');
    const hasSetup = existingSecrets.includes('SETUP_TOKEN');
    let rotateSecrets = args.rotateSecrets === true;
    const anyExisting = hasSession || hasSetup;
    const canOfferRotate = isTTY && !args.nonInteractive && !args.dryRun;
    if (!rotateSecrets && anyExisting && canOfferRotate) {
      write(
        stdout,
        [
          'Worker secrets SESSION_SECRET and/or SETUP_TOKEN already exist and cannot be shown again.',
          'Rotate them to print new values. Rotating SESSION_SECRET signs out every session.',
        ].join('\n'),
      );
      const typed = await ask('Rotate existing secrets and print the new values? [y/N]: ', {
        defaultValue: '',
      });
      rotateSecrets = parseYesNo(typed, { emptyDefault: false }) ?? false;
    }

    const replaceSession = !hasSession || rotateSecrets;
    const replaceSetup = !hasSetup || rotateSecrets;
    sessionSecret = replaceSession ? randomSecret() : null;
    setupToken = replaceSetup ? randomSecret() : null;
    secretsAlreadySet =
      (hasSession && !replaceSession) || (hasSetup && !replaceSetup)
        ? { session: hasSession && !replaceSession, setup: hasSetup && !replaceSetup }
        : null;

    if (sessionSecret) {
      const rotating = hasSession && rotateSecrets;
      write(
        stdout,
        args.dryRun
          ? rotating
            ? 'Dry-run: would rotate SESSION_SECRET.'
            : 'Dry-run: would upload SESSION_SECRET.'
          : rotating
            ? 'Rotating SESSION_SECRET on the Worker…'
            : 'Uploading SESSION_SECRET…',
      );
      await wrangler.putSecret('SESSION_SECRET', sessionSecret, args.configPath);
    } else {
      write(stdout, 'SESSION_SECRET already set on the Worker; leaving it unchanged.');
    }
    if (setupToken) {
      const rotating = hasSetup && rotateSecrets;
      write(
        stdout,
        args.dryRun
          ? rotating
            ? 'Dry-run: would rotate SETUP_TOKEN.'
            : 'Dry-run: would upload SETUP_TOKEN.'
          : rotating
            ? 'Rotating SETUP_TOKEN on the Worker…'
            : 'Uploading SETUP_TOKEN…',
      );
      await wrangler.putSecret('SETUP_TOKEN', setupToken, args.configPath);
    } else {
      write(
        stdout,
        'SETUP_TOKEN already set on the Worker; leaving it unchanged (use --rotate-secrets to replace it).',
      );
    }

    const devVarsPath = path.join(cwd, '.dev.vars');
    if ((sessionSecret || setupToken) && !(await fsApi.fileExists(devVarsPath))) {
      const devVars = writeDevVarsContents({
        appDomain: config.vars.APP_DOMAIN,
        sessionSecret,
        setupToken,
      });
      if (!args.dryRun) {
        await fsApi.writeFile(devVarsPath, devVars, 'utf8');
        write(stdout, 'Wrote .dev.vars for local development (gitignored).');
      }
    }
  }

  let mcpHealth = null;
  const fetchImpl = options.fetch ?? (run === defaultRun ? globalThis.fetch : null);
  if (!args.dryRun && !args.skipDeploy && fetchImpl) {
    write(stdout, 'Checking MCP HTTP endpoint and OAuth discovery…');
    try {
      mcpHealth = await waitForMcpHealth(appOrigin, {
        fetchImpl,
        timeoutMs: options.mcpProbeTimeoutMs,
        waitTimeoutMs: options.mcpWaitTimeoutMs,
        intervalMs: options.mcpWaitIntervalMs,
        sleep: options.sleep,
        onWait: () => write(stdout, style.info('Waiting for deployment…')),
      });
    } catch (error) {
      const origin = String(appOrigin || '').replace(/\/$/, '');
      const message = String(error?.message || error);
      mcpHealth = {
        ok: false,
        mcpExpectedUnauth: false,
        mcp: { url: `${origin}/mcp`, ok: false, status: 0, error: message },
        oauth: {
          url: `${origin}/.well-known/oauth-authorization-server`,
          ok: false,
          status: 0,
          error: message,
        },
      };
    }
    if (mcpHealth.ok) {
      write(stdout, style.ok('MCP endpoint and OAuth discovery — ok.'));
    } else {
      write(stdout, style.warn(formatMcpHealthWarning(mcpHealth)));
    }
  } else if (args.dryRun && !args.skipDeploy) {
    write(stdout, style.dim('Dry-run skips MCP health check.'));
  }

  const summary = formatSummary({
    appOrigin,
    mcpOrigin: appOrigin,
    setupUrl: `${appOrigin}/setup/passkey`,
    sessionSecret: args.dryRun ? null : sessionSecret,
    setupToken: args.dryRun ? null : setupToken,
    secretsAlreadySet: args.dryRun ? null : secretsAlreadySet,
    dryRun: args.dryRun,
    hostnameMode: answers.hostnameMode,
    hostname: answers.hostname,
    style,
    mcpHealth,
    configPath,
    seedDemo: answers.seedDemo,
    localConfigInUse: Boolean(existing),
  });
  write(stdout, summary);

  return {
    ok: true,
    dryRun: args.dryRun,
    answers,
    seedDemo: answers.seedDemo,
    d1: { name: d1Name, id: d1.id },
    kv: { name: kvName, id: kv.id },
    appOrigin,
    mcpOrigin: `${appOrigin}/mcp`,
    mcpHealth,
    config,
    planned: wrangler.planned,
    defaultWorkerName: DEFAULT_WORKER_NAME,
  };
  } finally {
    if (ownedPrompter) closePrompter(ask);
    releaseStdin(stdin);
  }
}
