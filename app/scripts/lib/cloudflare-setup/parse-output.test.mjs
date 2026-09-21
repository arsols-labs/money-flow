import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT,
  RESERVED_PRODUCTION_WORKERS_DEV_LABELS,
} from './constants.mjs';

import {
  isAuthError,
  isZoneError,
  parseD1CreateOutput,
  parseD1List,
  parseDeployUrls,
  parseKvCreateOutput,
  parseKvList,
  parseSecretList,
  parseWhoami,
  parseWorkerList,
} from './parse-output.mjs';

describe('parseWhoami', () => {
  it('reads JSON email and account', () => {
    const parsed = parseWhoami(
      JSON.stringify({ email: 'owner@example.com', accounts: [{ id: 'acct1', name: 'Personal' }] }),
    );
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, 'owner@example.com');
    assert.equal(parsed.accountId, 'acct1');
  });

  it('falls back to a banner email', () => {
    const parsed = parseWhoami("You are logged in with an OAuth Token, associated with the email 'dev@example.com'.");
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, 'dev@example.com');
  });

  it('treats User API Token whoami without email as logged in', () => {
    const parsed = parseWhoami(`
Getting User settings...
👋 You are logged in with an User API Token.
┌─────────────────┬──────────────────────────────────┐
│ Account Name    │ Account ID                       │
├─────────────────┼──────────────────────────────────┤
│ Example Account │ 0123456789abcdef0123456789abcdef │
└─────────────────┴──────────────────────────────────┘
`);
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, null);
    assert.equal(parsed.accountName, 'Example Account');
    assert.equal(parsed.accountId, '0123456789abcdef0123456789abcdef');
  });

  it('treats an account-table whoami without an email as logged in', () => {
    const parsed = parseWhoami(`
┌───────────────┬──────────────────────────────────┐
│ Account Name  │ Account ID                       │
├───────────────┼──────────────────────────────────┤
│ Demo Desk     │ abcdef0123456789abcdef0123456789 │
└───────────────┴──────────────────────────────────┘
`);
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, null);
    assert.equal(parsed.accountName, 'Demo Desk');
    assert.equal(parsed.accountId, 'abcdef0123456789abcdef0123456789');
  });

  it('does not treat a logged-out whoami as logged in', () => {
    const parsed = parseWhoami('You are not logged in.\nRun wrangler login to authenticate.');
    assert.equal(parsed.loggedIn, false);
    assert.equal(parsed.email, null);
  });
});

describe('parse D1 / KV output', () => {
  it('parses d1 list JSON', () => {
    const rows = parseD1List(
      JSON.stringify([{ name: 'money-flow-db', uuid: '11111111-1111-4111-8111-111111111111' }]),
    );
    assert.equal(rows[0].name, 'money-flow-db');
    assert.equal(rows[0].id, '11111111-1111-4111-8111-111111111111');
  });

  it('parses d1 create JSONC-ish stdout', () => {
    const created = parseD1CreateOutput(`
✅ Created
{ "d1_databases": [{ "database_name": "cash-db", "database_id": "22222222-2222-4222-8222-222222222222" }] }
`);
    assert.equal(created.name, 'cash-db');
    assert.equal(created.id, '22222222-2222-4222-8222-222222222222');
  });

  it('parses kv create text with a 32-char id', () => {
    const created = parseKvCreateOutput(`
✨ Success!
Add the following to your configuration file:
{ binding = "KV", id = "abcdef0123456789abcdef0123456789" }
`);
    assert.equal(created.id, 'abcdef0123456789abcdef0123456789');
  });

  it('parses kv list JSON', () => {
    const rows = parseKvList(JSON.stringify([{ title: 'money-flow-kv', id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]));
    assert.equal(rows[0].title, 'money-flow-kv');
  });

  it('parses kv list table/banner text when JSON is absent', () => {
    const rows = parseKvList(`
🌀 wrangler 4.20.0
┌──────────────────────────────────┬──────────────┐
│ id                               │ title        │
├──────────────────────────────────┼──────────────┤
│ abcdef0123456789abcdef0123456789 │ cash-desk-kv │
└──────────────────────────────────┴──────────────┘
`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'cash-desk-kv');
    assert.equal(rows[0].id, 'abcdef0123456789abcdef0123456789');
  });
});

describe('parseWorkerList', () => {
  it('parses a JSON array of Worker names', () => {
    const rows = parseWorkerList(JSON.stringify([{ name: 'cash-desk' }, { id: 'other-app' }]));
    assert.deepEqual(rows.map((row) => row.name), ['cash-desk', 'other-app']);
  });

  it('parses Cloudflare API result envelopes', () => {
    const rows = parseWorkerList(JSON.stringify({ result: [{ id: 'cash-desk' }] }));
    assert.equal(rows[0].name, 'cash-desk');
  });

  it('parses a banner table when JSON is absent', () => {
    const rows = parseWorkerList(`
🌀 wrangler 4.20.0
name
cash-desk
money-flow
`);
    assert.deepEqual(rows.map((row) => row.name), ['cash-desk', 'money-flow']);
  });
});

describe('parse deploy and secrets', () => {
  it('extracts workers.dev URL', () => {
    const parsed = parseDeployUrls(
      'Published money-flow\n  https://money-flow.myacct.workers.dev\nCurrent Version ID: abc',
      { workerName: 'money-flow' },
    );
    assert.equal(parsed.workersDev, 'https://money-flow.myacct.workers.dev');
  });

  it('prefers the stable workers.dev host over a versioned deploy URL', () => {
    const parsed = parseDeployUrls(
      [
        'Uploaded money-flow',
        '  https://deadbeef-money-flow.myacct.workers.dev',
        '  https://money-flow.myacct.workers.dev',
        'Current Version ID: deadbeef',
      ].join('\n'),
      { workerName: 'money-flow' },
    );
    assert.equal(parsed.workersDev, 'https://money-flow.myacct.workers.dev');
  });

  it('rejects reserved production preview hosts as the workers.dev URL', {
    skip: !RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT || RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length < 2,
  }, () => {
    const reservedPreviewHost = `staging-${RESERVED_PRODUCTION_WORKERS_DEV_LABELS[1]}.${RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT}`;
    const parsed = parseDeployUrls(
      `https://${reservedPreviewHost}`,
      { workerName: 'money-flow' },
    );
    assert.equal(parsed.workersDev, null);
  });

  it('accepts a resolving account-subdomain workers.dev URL', () => {
    const workerName = 'money-flow-setup-script-test';
    const workerHost = `${workerName}.myacct.workers.dev`;
    const parsed = parseDeployUrls(
      [
        `Uploaded ${workerName}`,
        `  https://${workerHost}`,
      ].join('\n'),
      { workerName },
    );
    assert.equal(parsed.workersDev, `https://${workerHost}`);
  });

  it('rejects the unresolved bare workers.dev host', () => {
    const parsed = parseDeployUrls('https://cash-desk.workers.dev', { workerName: 'cash-desk' });
    assert.equal(parsed.workersDev, null);
  });

  it('reads secret names from JSON', () => {
    assert.deepEqual(parseSecretList(JSON.stringify([{ name: 'SESSION_SECRET' }, { name: 'SETUP_TOKEN' }])), [
      'SESSION_SECRET',
      'SETUP_TOKEN',
    ]);
  });
});

describe('error heuristics', () => {
  it('detects auth and zone failures', () => {
    assert.equal(isAuthError('Not logged in'), true);
    assert.equal(isZoneError('', 'Could not find a zone for that custom domain'), true);
    assert.equal(isAuthError('ok'), false);
    assert.equal(isAuthError('You are logged in with an OAuth Token, associated with the email x@y.com.'), false);
    assert.equal(isAuthError('You are logged in with an User API Token.'), false);
  });
});
