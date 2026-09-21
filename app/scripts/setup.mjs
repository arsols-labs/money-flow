#!/usr/bin/env node
import { runSetup, SetupError } from './lib/cloudflare-setup/run.mjs';
import { releaseStdin } from './lib/cloudflare-setup/prompts.mjs';

function finish(code) {
  releaseStdin(process.stdin);
  process.exit(code);
}

async function main() {
  try {
    const result = await runSetup();
    finish(result ? 0 : 1);
  } catch (error) {
    if (error instanceof SetupError) {
      process.stderr.write(`${error.message}\n`);
      if (error.hint) process.stderr.write(`${error.hint}\n`);
      finish(error.code === 'auth' ? 2 : 1);
    }
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    finish(1);
  }
}

void main();
