import path from 'node:path';

import { MIN_NODE_MAJOR } from './constants.mjs';

export const NODE_INSTALL_URL = 'https://nodejs.org/';
export const NPM_INSTALL_COMMAND = 'npm install';

export function nodeModulesPath(cwd) {
  return path.join(cwd, 'node_modules');
}

export function localWranglerPackagePath(cwd) {
  return path.join(cwd, 'node_modules', 'wrangler', 'package.json');
}

export function localWranglerBinPath(cwd) {
  return path.join(cwd, 'node_modules', '.bin', 'wrangler');
}

/**
 * Local Wrangler usable via `npx wrangler` after `npm install` in app/.
 * A global `wrangler` binary is not enough and is not required.
 * @param {(filePath: string) => Promise<boolean>} fileExists
 * @param {string} cwd
 */
export async function inspectLocalSetupDeps(fileExists, cwd) {
  const nodeModules = await fileExists(nodeModulesPath(cwd));
  const wranglerPkg = await fileExists(localWranglerPackagePath(cwd));
  const wranglerBin = await fileExists(localWranglerBinPath(cwd));
  const wrangler = wranglerPkg || wranglerBin;
  return {
    nodeModules,
    wrangler,
    ready: wrangler,
  };
}

export function formatNodeRequirementError(foundVersion, minMajor = MIN_NODE_MAJOR) {
  const found = foundVersion && String(foundVersion).trim() ? String(foundVersion).trim() : 'none';
  return [
    `Node.js ${minMajor}+ is required (found ${found}).`,
    'Setup cannot continue on this Node version.',
    '',
    `Install or upgrade Node.js LTS (${minMajor}+) from:`,
    `  ${NODE_INSTALL_URL}`,
    '',
    'Then open a new terminal, confirm `node -v`, and re-run from app/:',
    '  npm run setup',
    '',
  ].join('\n');
}

export function formatDepsInstallHint() {
  return [
    'Local Wrangler is not available yet (missing app/node_modules or the local wrangler package).',
    'Do not hunt for a global `wrangler` CLI. From app/ run this exact command, then re-run setup:',
    '',
    `  ${NPM_INSTALL_COMMAND}`,
    '',
    'After that, setup uses `npx wrangler` from this directory.',
    '',
  ].join('\n');
}

export function formatDepsMissingPromptIntro() {
  return [
    'Local Wrangler is missing (no app/node_modules wrangler).',
    'Setup will run `npm install` here, then use `npx wrangler` from this directory.',
    'A global Wrangler install is not required.',
  ].join('\n');
}
