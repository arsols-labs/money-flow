import path from 'node:path';

import { LOCAL_CONFIG_NAME, STATE_FILE_NAME } from './constants.mjs';
import { parseLocalWranglerConfig } from './config.mjs';
import { SetupError } from './wrangler.mjs';
import {
  isReservedProductionHostname,
  isReservedProductionName,
  isReservedProductionResourceId,
  reservedProductionNameError,
  validateWorkerName,
} from './validate.mjs';

export function formatDeleteHelpHint() {
  return 'See npm run setup -- --help for --delete flags and reserved production names.';
}

export function assertDeletableName(name, label = 'Worker name') {
  const check = validateWorkerName(name);
  if (!check.ok) throw new SetupError(check.error);
  if (isReservedProductionName(check.value)) {
    throw new SetupError(reservedProductionNameError(check.value, label));
  }
  return check.value;
}

export function relevantWorkerNames({ accountWorkers = [], existing, state, d1List = [] }) {
  const names = new Set();
  for (const row of accountWorkers) {
    if (row?.name) names.add(row.name);
  }
  if (existing?.name) names.add(existing.name);
  if (state?.workerName) names.add(state.workerName);
  for (const row of d1List) {
    const d1Name = row?.name;
    if (typeof d1Name === 'string' && d1Name.endsWith('-db') && d1Name.length > 3) {
      names.add(d1Name.slice(0, -3));
    }
  }
  return [...names].sort();
}

export function formatWorkerPicker(names) {
  const lines = ['Workers on this account / relevant to this install:', ''];
  names.forEach((name, index) => {
    const mark = isReservedProductionName(name) ? '  [protected — production]' : '';
    lines.push(`  ${index + 1}. ${name}${mark}`);
  });
  lines.push('', 'Enter a number to delete that Worker and its setup resources.');
  return lines.join('\n');
}

export function pickWorkerByDigit(input, names) {
  const raw = String(input ?? '').trim();
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 1 || index > names.length) {
    throw new SetupError(`Choose a number between 1 and ${names.length}.`);
  }
  return names[index - 1];
}

function ownedD1Name({ workerName, flags, existing, state }) {
  if (flags.d1Name) return flags.d1Name;
  if (existing?.name === workerName && existing.d1?.name) return existing.d1.name;
  if (state?.workerName === workerName && state.d1?.name) return state.d1.name;
  return `${workerName}-db`;
}

function ownedKvName({ workerName, flags, existing, state }) {
  if (flags.kvName) return flags.kvName;
  if (existing?.name === workerName && existing.kv?.name) return existing.kv.name;
  if (state?.workerName === workerName && state.kv?.name) return state.kv.name;
  return `${workerName}-kv`;
}

export function planDeleteResources({
  workerName,
  flags = {},
  existing = null,
  state = null,
  d1List = [],
  kvList = [],
  configPath = LOCAL_CONFIG_NAME,
  statePath = STATE_FILE_NAME,
}) {
  const name = assertDeletableName(workerName);

  if (existing?.appDomain && isReservedProductionHostname(existing.appDomain) && existing.name === name) {
    throw new SetupError('Local config APP_DOMAIN is a reserved production host. Refusing to delete from that install record.');
  }

  const d1Name = ownedD1Name({ workerName: name, flags, existing, state });
  const kvName = ownedKvName({ workerName: name, flags, existing, state });

  if (isReservedProductionName(d1Name)) {
    throw new SetupError(reservedProductionNameError(d1Name, 'D1 name'));
  }
  if (isReservedProductionName(kvName)) {
    throw new SetupError(reservedProductionNameError(kvName, 'KV name'));
  }

  const listedD1 = d1List.find((row) => row.name === d1Name) ?? null;
  const listedKv = kvList.find((row) => row.title === kvName) ?? null;
  const d1Id =
    (existing?.name === name && existing.d1?.id) ||
    (state?.workerName === name && state.d1?.id) ||
    listedD1?.id ||
    null;
  const kvId =
    (existing?.name === name && existing.kv?.id) ||
    (state?.workerName === name && state.kv?.id) ||
    listedKv?.id ||
    null;

  if (d1Id && isReservedProductionResourceId(d1Id)) {
    throw new SetupError('Refusing to delete a reserved production D1 binding id.');
  }
  if (kvId && isReservedProductionResourceId(kvId)) {
    throw new SetupError('Refusing to delete a reserved production KV binding id.');
  }

  const localFiles = [];
  if (existing?.name === name) localFiles.push(configPath);
  if (state?.workerName === name) localFiles.push(statePath);

  return {
    workerName: name,
    d1: d1Id || listedD1 ? { name: d1Name, id: d1Id } : null,
    kv: kvId || listedKv ? { name: kvName, id: kvId } : null,
    localFiles,
    skipped: {
      d1Missing: !d1Id && !listedD1,
      kvMissing: !kvId && !listedKv,
    },
  };
}

export function formatDeletePlan(plan, { dryRun = false } = {}) {
  const lines = [
    dryRun ? 'Dry-run delete plan (no Cloudflare writes):' : 'This will permanently delete:',
    '',
    `  Worker:  ${plan.workerName}  (secrets and bindings go with the Worker)`,
  ];
  if (plan.d1) {
    lines.push(`  D1:      ${plan.d1.name}${plan.d1.id ? ` (${plan.d1.id})` : ''}`);
  } else {
    lines.push('  D1:      (none found for this install — skipped)');
  }
  if (plan.kv) {
    lines.push(`  KV:      ${plan.kv.name}${plan.kv.id ? ` (${plan.kv.id})` : ''}`);
  } else {
    lines.push('  KV:      (none found for this install — skipped)');
  }
  if (plan.localFiles.length > 0) {
    lines.push(`  Local:   ${plan.localFiles.join(', ')}`);
  } else {
    lines.push('  Local:   (no matching wrangler.local.jsonc / .setup-state.json)');
  }
  lines.push(
    '',
    'Not deleted: resources referenced by the committed production wrangler.jsonc,',
    'reserved production names or ids, unrelated account resources, 1Password.',
  );
  return lines.join('\n');
}

export async function confirmDelete({ plan, ask, nonInteractive, isTTY, dryRun = false }) {
  if (dryRun || nonInteractive) return true;
  if (!isTTY) {
    throw new SetupError(
      `No TTY. Re-run with --yes and --delete ${plan.workerName}. ${formatDeleteHelpHint()}`,
    );
  }
  const typed = await ask(`Type the Worker name to confirm deletion [${plan.workerName}]: `);
  if (String(typed).trim() !== plan.workerName) {
    throw new SetupError('Confirmation did not match the Worker name. Delete cancelled.');
  }
  return true;
}

export async function resolveDeleteTarget({
  flags,
  existing,
  state,
  accountWorkers,
  d1List,
  ask,
  isTTY,
  write,
  stdout,
}) {
  let name = flags.name ?? null;
  if (!name) {
    if (flags.nonInteractive || !isTTY) {
      throw new SetupError(
        `No Worker name. Pass --delete <workerName> with --yes. ${formatDeleteHelpHint()}`,
      );
    }
    const names = relevantWorkerNames({ accountWorkers, existing, state, d1List });
    if (names.length === 0) {
      throw new SetupError('No Workers found on this account or in the local setup record.');
    }
    const picker = formatWorkerPicker(names);
    if (typeof write === 'function' && stdout) {
      write(stdout, picker);
    }
    // Dry-run still waits for this digit. Only the typed-name confirm is skipped.
    const listed = await ask(typeof write === 'function' ? 'Number: ' : `${picker}\nNumber: `);
    name = pickWorkerByDigit(listed, names);
  }
  return assertDeletableName(name);
}

function parseStateFile(text) {
  try {
    const parsed = JSON.parse(String(text));
    return {
      workerName: parsed.workerName ?? parsed.name ?? null,
      d1: { name: parsed.d1?.name ?? null, id: parsed.d1?.id ?? null },
      kv: { name: parsed.kv?.name ?? null, id: parsed.kv?.id ?? null },
    };
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   args: object,
 *   cwd: string,
 *   stdout: { write: (s: string) => void },
 *   write: (stream: { write: (s: string) => void }, text: string) => void,
 *   isTTY: boolean,
 *   ask: (q: string, options?: object) => Promise<string>,
 *   fsApi: { readFile: Function, fileExists: Function, unlink?: Function },
 *   wrangler: object,
 * }} ctx
 */
export async function runDelete(ctx) {
  const { args, cwd, stdout, write, isTTY, ask, fsApi, wrangler } = ctx;
  const configPath = path.resolve(cwd, args.configPath);
  const statePath = path.join(cwd, STATE_FILE_NAME);

  let existing = null;
  if (await fsApi.fileExists(configPath)) {
    existing = parseLocalWranglerConfig(await fsApi.readFile(configPath, 'utf8'));
    write(stdout, `Found existing ${path.basename(configPath)}; delete will use it only if the Worker name matches.`);
  }

  let state = null;
  if (await fsApi.fileExists(statePath)) {
    state = parseStateFile(await fsApi.readFile(statePath, 'utf8'));
  }

  const accountWorkers = await wrangler.listWorkers();
  const d1List = await wrangler.listD1();
  const kvList = await wrangler.listKv();

  const workerName = await resolveDeleteTarget({
    flags: args,
    existing,
    state,
    accountWorkers,
    d1List,
    ask,
    isTTY,
    write,
    stdout,
  });

  const plan = planDeleteResources({
    workerName,
    flags: args,
    existing,
    state,
    d1List,
    kvList,
    configPath: path.basename(configPath) === path.basename(args.configPath) ? args.configPath : configPath,
    statePath: STATE_FILE_NAME,
  });

  write(stdout, formatDeletePlan(plan, { dryRun: args.dryRun }));
  if (args.dryRun) {
    write(stdout, 'Dry-run: would delete the Worker, then owned D1 / KV, then matching local files.');
    return { ok: true, delete: true, dryRun: true, plan, planned: wrangler.planned };
  }

  await confirmDelete({
    plan,
    ask,
    nonInteractive: args.nonInteractive,
    isTTY,
    dryRun: false,
  });

  write(stdout, `Deleting Worker ${plan.workerName}…`);
  await wrangler.deleteWorker(plan.workerName);
  if (plan.d1) {
    write(stdout, `Deleting D1 ${plan.d1.name}…`);
    await wrangler.deleteD1(plan.d1.name);
  }
  if (plan.kv?.id) {
    write(stdout, `Deleting KV ${plan.kv.name}…`);
    await wrangler.deleteKv(plan.kv.id);
  }

  if (typeof fsApi.unlink === 'function') {
    for (const relative of plan.localFiles) {
      const filePath = path.isAbsolute(relative) ? relative : path.resolve(cwd, relative);
      if (await fsApi.fileExists(filePath)) {
        await fsApi.unlink(filePath);
        write(stdout, `Removed ${relative}`);
      }
    }
  }

  write(stdout, 'Delete complete.');
  return { ok: true, delete: true, dryRun: false, plan, planned: wrangler.planned };
}
