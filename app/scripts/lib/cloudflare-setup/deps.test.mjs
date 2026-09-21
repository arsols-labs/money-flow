import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NODE_INSTALL_URL,
  NPM_INSTALL_COMMAND,
  formatDepsInstallHint,
  formatDepsMissingPromptIntro,
  formatNodeRequirementError,
  inspectLocalSetupDeps,
  localWranglerBinPath,
  localWranglerPackagePath,
  nodeModulesPath,
} from './deps.mjs';

describe('deps helpers', () => {
  it('formats a Node install/upgrade error with nodejs.org', () => {
    const text = formatNodeRequirementError('18.20.0');
    assert.match(text, /Node\.js 20\+ is required \(found 18\.20\.0\)/);
    assert.match(text, /Install or upgrade/);
    assert.match(text, new RegExp(NODE_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, /npm run setup/);
  });

  it('treats a blank Node version as none', () => {
    assert.match(formatNodeRequirementError(''), /found none/);
  });

  it('tells strangers to run npm install, not a global wrangler', () => {
    const hint = formatDepsInstallHint();
    assert.match(hint, new RegExp(`^\\s*${NPM_INSTALL_COMMAND}\\s*$`, 'm'));
    assert.match(hint, /npx wrangler/);
    assert.doesNotMatch(hint, /npm i -g wrangler|wrangler login/);
    assert.match(formatDepsMissingPromptIntro(), /npm install/);
    assert.match(formatDepsMissingPromptIntro(), /global Wrangler install is not required/);
  });

  it('detects local wrangler via package or bin, not node_modules alone', async () => {
    const cwd = '/tmp/app-v2-deps-inspect';
    const present = new Set([nodeModulesPath(cwd)]);
    const fileExists = async (filePath) => present.has(filePath);

    const emptyModules = await inspectLocalSetupDeps(fileExists, cwd);
    assert.equal(emptyModules.nodeModules, true);
    assert.equal(emptyModules.ready, false);

    present.add(localWranglerPackagePath(cwd));
    const withPkg = await inspectLocalSetupDeps(fileExists, cwd);
    assert.equal(withPkg.ready, true);

    present.delete(localWranglerPackagePath(cwd));
    present.add(localWranglerBinPath(cwd));
    const withBin = await inspectLocalSetupDeps(fileExists, cwd);
    assert.equal(withBin.ready, true);
  });
});
