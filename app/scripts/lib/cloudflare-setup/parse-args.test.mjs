import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatHelp, parseArgs } from './parse-args.mjs';

describe('parseArgs', () => {
  it('parses a complete non-interactive flag set', () => {
    const args = parseArgs([
      '--yes',
      '--dry-run',
      '--name',
      'cash-desk',
      '--hostname-mode',
      'custom',
      '--hostname',
      'app.example.com',
      '--d1-name',
      'cash-desk-db',
      '--kv-name',
      'cash-desk-kv',
      '--config',
      'wrangler.local.jsonc',
      '--skip-deploy',
      '--skip-migrate',
      '--skip-secrets',
      '--skip-build',
      '--account-subdomain',
      'myacct',
    ]);
    assert.equal(args.nonInteractive, true);
    assert.equal(args.dryRun, true);
    assert.equal(args.name, 'cash-desk');
    assert.equal(args.hostnameMode, 'custom');
    assert.equal(args.hostname, 'app.example.com');
    assert.equal(args.d1Name, 'cash-desk-db');
    assert.equal(args.kvName, 'cash-desk-kv');
    assert.equal(args.skipDeploy, true);
    assert.equal(args.skipMigrate, true);
    assert.equal(args.skipSecrets, true);
    assert.equal(args.skipBuild, true);
    assert.equal(args.seedDemo, null);
    assert.equal(args.rotateSecrets, false);
    assert.equal(args.delete, false);
    assert.equal(args.accountSubdomain, 'myacct');
    assert.deepEqual(args.unknown, []);
  });

  it('parses --delete with an optional Worker name', () => {
    assert.equal(parseArgs(['--delete']).delete, true);
    assert.equal(parseArgs(['--delete']).name, null);
    assert.equal(parseArgs(['--delete', 'cash-desk']).delete, true);
    assert.equal(parseArgs(['--delete', 'cash-desk']).name, 'cash-desk');
    assert.equal(parseArgs(['--delete', '--yes']).delete, true);
    assert.equal(parseArgs(['--delete', '--yes']).nonInteractive, true);
    assert.equal(parseArgs(['--delete', '--name', 'cash-desk']).name, 'cash-desk');
  });

  it('rejects conflicting Worker names on --delete and --name', () => {
    assert.throws(() => parseArgs(['--delete', 'cash-desk', '--name', 'other']), /only one Worker name/);
    assert.throws(() => parseArgs(['--name', 'cash-desk', '--delete', 'other']), /only one Worker name/);
  });

  it('parses --seed-demo and --no-seed-demo', () => {
    assert.equal(parseArgs(['--seed-demo']).seedDemo, true);
    assert.equal(parseArgs(['--no-seed-demo']).seedDemo, false);
    assert.equal(parseArgs([]).seedDemo, null);
  });

  it('parses --rotate-secrets and the --rotate-setup-token alias', () => {
    assert.equal(parseArgs(['--rotate-secrets']).rotateSecrets, true);
    assert.equal(parseArgs(['--rotate-setup-token']).rotateSecrets, true);
    assert.equal(parseArgs([]).rotateSecrets, false);
  });

  it('rejects combining --seed-demo with --no-seed-demo', () => {
    assert.throws(() => parseArgs(['--seed-demo', '--no-seed-demo']), /only one of --seed-demo/);
    assert.throws(() => parseArgs(['--no-seed-demo', '--seed-demo']), /only one of --seed-demo/);
  });

  it('accepts -y and --non-interactive aliases', () => {
    assert.equal(parseArgs(['-y']).nonInteractive, true);
    assert.equal(parseArgs(['--non-interactive']).nonInteractive, true);
  });

  it('records unknown tokens', () => {
    const args = parseArgs(['--wat', 'positional']);
    assert.deepEqual(args.unknown, ['--wat', 'positional']);
  });

  it('throws when a flag is missing its value', () => {
    assert.throws(() => parseArgs(['--name']), /Missing value for --name/);
    assert.throws(() => parseArgs(['--name', '--yes']), /Missing value for --name/);
  });

  it('prints help text that names npm run setup and does not say coming soon', () => {
    const help = formatHelp();
    assert.match(help, /npm run setup/);
    assert.match(help, /--seed-demo/);
    assert.match(help, /--no-seed-demo/);
    assert.match(help, /--rotate-secrets/);
    assert.match(help, /--rotate-setup-token/);
    assert.match(help, /SESSION_SECRET/);
    assert.match(help, /npx wrangler login/);
    assert.match(help, /npm install/);
    assert.match(help, /Install dependencies now/);
    assert.match(help, /nodejs\.org/);
    assert.match(help, /SETUP_SEED_DEMO/);
    assert.match(help, /MCP HTTP endpoint and OAuth discovery/);
    assert.match(help, /setup still exits 0/);
    assert.match(help, /Reuse this Worker and hostname|reuse or change/);
    assert.match(help, /from scratch/);
    assert.match(help, /HTTP 401/);
    assert.match(help, /--delete/);
    assert.match(help, /type the Worker name to confirm/i);
    assert.match(help, /exits 0 without confirm/i);
    assert.match(help, /waits for a number/);
    assert.match(help, /read-only/);
    assert.match(help, /wrangler\.local\.jsonc is missing/);
    assert.match(help, /reserved production names/i);
    assert.match(help, /wrangler\.local\.jsonc/);
    assert.doesNotMatch(help, /coming soon/i);
  });
});
