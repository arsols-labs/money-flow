import readline from 'node:readline';

import { DEFAULT_WORKER_NAME } from './constants.mjs';
import { parseYesNo } from './seed-demo.mjs';
import {
  isReservedProductionName,
  normalizeHostnameMode,
  reservedProductionNameError,
  validateHostname,
  validateHostnameMode,
  validateWorkerName,
} from './validate.mjs';

export const SEED_RESET_HINT =
  'You can wipe demo data later from Data → Reset (in a follow-up release).';

/**
 * @param {{
 *   configPath?: string | null,
 *   seedDemo?: boolean,
 * }} [options]
 */
export function formatLocalConfigInUseCopy(options = {}) {
  const pathLabel = options.configPath || 'wrangler.local.jsonc';
  const lines = [
    `Local config is in use: ${pathLabel}`,
    'Re-running setup reuses the same D1 / KV / Worker.',
    `To start from scratch: delete ${pathLabel}, then re-run setup.`,
  ];
  if (options.seedDemo) {
    lines.push(SEED_RESET_HINT);
  }
  return lines.join('\n');
}

/**
 * @param {{
 *   name?: string | null,
 *   hostnameMode?: string | null,
 *   hostname?: string | null,
 *   appDomain?: string | null,
 * }} existing
 * @param {{
 *   configPath?: string | null,
 *   seedDemo?: boolean,
 * }} [options]
 */
export function formatReuseSummary(existing, options = {}) {
  const name = existing?.name || '(unknown)';
  const hostnameMode = existing?.hostnameMode === 'custom' ? 'custom' : 'workers-dev';
  const modeLabel = hostnameMode === 'custom' ? 'Custom domain' : 'Free *.workers.dev';
  const domain =
    hostnameMode === 'custom'
      ? existing?.hostname || existing?.appDomain || '(none)'
      : existing?.appDomain || existing?.hostname || `${name}.<account>.workers.dev`;
  return [
    formatLocalConfigInUseCopy({
      configPath: options.configPath,
      seedDemo: options.seedDemo,
    }),
    '',
    `  Worker:         ${name}`,
    `  Hostname mode:  ${modeLabel}`,
    `  Domain:         ${domain}`,
  ].join('\n');
}

/**
 * @param {{
 *   flags: { name?: string | null, hostnameMode?: string | null, hostname?: string | null, nonInteractive?: boolean, seedDemo?: boolean | null },
 *   existing?: { name?: string | null, hostnameMode?: string | null, hostname?: string | null, appDomain?: string | null } | null,
 *   configPath?: string | null,
 *   ask: (question: string, options?: { defaultValue?: string }) => Promise<string>,
 *   isTTY: boolean,
 * }} input
 */
export async function collectAnswers(input) {
  const { flags, existing, ask, isTTY, configPath } = input;
  const reuse = existing?.name
    ? {
        name: existing.name,
        hostnameMode: existing.hostnameMode ?? 'workers-dev',
        hostname: existing.hostname ?? null,
        appDomain: existing.appDomain ?? null,
      }
    : null;
  const reuseSummary = reuse
    ? formatReuseSummary(reuse, {
        configPath,
        seedDemo: flags.seedDemo === true,
      })
    : null;
  const identityFromFlags = Boolean(flags.name) && Boolean(flags.hostnameMode);

  let name = flags.name ?? reuse?.name ?? null;
  let hostnameMode = flags.hostnameMode ? normalizeHostnameMode(flags.hostnameMode) : reuse?.hostnameMode ?? null;
  let hostname = flags.hostname ?? reuse?.hostname ?? null;
  let seedDemo = flags.seedDemo === true || flags.seedDemo === false ? flags.seedDemo : null;
  let reusedExisting = Boolean(reuse && name === reuse.name && hostnameMode === reuse.hostnameMode);

  if (flags.nonInteractive) {
    name = name ?? DEFAULT_WORKER_NAME;
    hostnameMode = hostnameMode ?? 'workers-dev';
  } else if (!isTTY) {
    throw new Error(
      'No TTY. Re-run with --yes and explicit flags (see npm run setup -- --help).',
    );
  } else {
    if (reuse && !identityFromFlags) {
      const typed = await ask(`${reuseSummary}\nReuse this Worker and hostname? [Y/n]: `, {
        defaultValue: 'y',
      });
      const keep = parseYesNo(typed, { emptyDefault: true }) ?? true;
      if (keep) {
        name = reuse.name;
        hostnameMode = reuse.hostnameMode;
        hostname = reuse.hostname;
        reusedExisting = true;
      } else {
        name = flags.name ?? null;
        hostnameMode = flags.hostnameMode ? normalizeHostnameMode(flags.hostnameMode) : null;
        hostname = flags.hostname ?? null;
        reusedExisting = false;
      }
    }
    if (!name) {
      const fallback = reuse?.name ?? DEFAULT_WORKER_NAME;
      const typed = await ask(`Worker / service name [${fallback}]: `, {
        defaultValue: fallback,
      });
      name = typed.trim() || fallback;
    }
    if (!hostnameMode) {
      const typed = await ask(
        [
          'Hostname mode:',
          '  [1] Free *.workers.dev subdomain (default)',
          '  [2] Custom domain already in your Cloudflare zone',
          'Choose 1 or 2 [1]: ',
        ].join('\n'),
        { defaultValue: '1' },
      );
      hostnameMode = normalizeHostnameMode(typed) ?? 'workers-dev';
    }
    if (hostnameMode === 'custom' && !hostname) {
      hostname = (await ask('Custom hostname (e.g. money.example.com): ')).trim();
    }
    if (seedDemo == null) {
      const typed = await ask('Seed demo data? [y/N]: ', { defaultValue: '' });
      seedDemo = parseYesNo(typed, { emptyDefault: false }) ?? false;
    }
  }

  if (seedDemo == null) {
    seedDemo = false;
  }

  const nameCheck = validateWorkerName(name);
  if (!nameCheck.ok) throw new Error(nameCheck.error);
  if (isReservedProductionName(nameCheck.value)) {
    throw new Error(reservedProductionNameError(nameCheck.value, 'Worker name'));
  }
  const modeCheck = validateHostnameMode(hostnameMode);
  if (!modeCheck.ok) throw new Error(modeCheck.error);
  const hostCheck = validateHostname(hostname, { mode: modeCheck.value });
  if (!hostCheck.ok) throw new Error(hostCheck.error);

  return {
    name: nameCheck.value,
    hostnameMode: modeCheck.value,
    hostname: hostCheck.value,
    seedDemo,
    reusedExisting: reusedExisting && reuse?.name === nameCheck.value,
    reuseNotice: reuseSummary,
  };
}

export function createLinePrompter(stdin, stdout) {
  let rl = null;
  function ensure() {
    if (!rl) {
      rl = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: Boolean(stdin.isTTY),
      });
    }
    return rl;
  }
  function ask(question, { defaultValue } = {}) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof stdin.resume === 'function') stdin.resume();
        if (typeof stdin.ref === 'function') stdin.ref();
        ensure().question(question, (line) => {
          resolve(line === '' && defaultValue !== undefined ? defaultValue : line);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  ask.close = () => {
    if (rl) {
      rl.close();
      rl = null;
    }
    releaseStdin(stdin);
  };
  return ask;
}

export function closePrompter(ask) {
  if (ask && typeof ask.close === 'function') {
    try {
      ask.close();
    } catch {
      // ignore
    }
  }
}

export function releaseStdin(stdin) {
  if (!stdin) return;
  try {
    if (typeof stdin.pause === 'function') stdin.pause();
  } catch {
    // ignore
  }
  try {
    if (typeof stdin.unref === 'function') stdin.unref();
  } catch {
    // ignore
  }
}
