import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESERVED_PRODUCTION_WORKERS_DEV_LABELS } from './constants.mjs';

import {
  closePrompter,
  collectAnswers,
  createLinePrompter,
  formatLocalConfigInUseCopy,
  formatReuseSummary,
  releaseStdin,
  SEED_RESET_HINT,
} from './prompts.mjs';

describe('collectAnswers', () => {
  it('uses defaults in non-interactive mode', async () => {
    const answers = await collectAnswers({
      flags: { nonInteractive: true },
      existing: null,
      ask: async () => {
        throw new Error('should not prompt');
      },
      isTTY: false,
    });
    assert.equal(answers.name, 'money-flow');
    assert.equal(answers.hostnameMode, 'workers-dev');
    assert.equal(answers.hostname, null);
    assert.equal(answers.seedDemo, false);
  });

  it('refuses a reserved production Worker name on create', {
    skip: RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length === 0,
  }, async () => {
    await assert.rejects(
      () => collectAnswers({
        flags: { nonInteractive: true, name: RESERVED_PRODUCTION_WORKERS_DEV_LABELS[0] },
        existing: null,
        ask: async () => { throw new Error('should not prompt'); },
        isTTY: false,
      }),
      /reserved production names list/,
    );
  });

  it('honors an explicit seed-demo flag without prompting', async () => {
    const answers = await collectAnswers({
      flags: { nonInteractive: true, seedDemo: true },
      existing: null,
      ask: async () => {
        throw new Error('should not prompt');
      },
      isTTY: false,
    });
    assert.equal(answers.seedDemo, true);
  });

  it('walks interactive prompts', async () => {
    const questions = [];
    const replies = ['cash-desk', '2', 'app.example.com', ''];
    const answers = await collectAnswers({
      flags: {},
      existing: null,
      ask: async (question) => {
        questions.push(question);
        return replies.shift();
      },
      isTTY: true,
    });
    assert.equal(answers.name, 'cash-desk');
    assert.equal(answers.hostnameMode, 'custom');
    assert.equal(answers.hostname, 'app.example.com');
    assert.equal(answers.seedDemo, false);
    assert.match(questions[1], /workers\.dev/);
    assert.match(questions[1], /Custom domain/);
    assert.match(questions[3], /Seed demo data/);
  });

  it('treats an empty seed-demo answer as no', async () => {
    const answers = await collectAnswers({
      flags: { name: 'cash-desk', hostnameMode: 'workers-dev' },
      existing: null,
      ask: async () => '',
      isTTY: true,
    });
    assert.equal(answers.seedDemo, false);
  });

  it('accepts yes for the seed-demo prompt', async () => {
    const questions = [];
    const answers = await collectAnswers({
      flags: { name: 'cash-desk', hostnameMode: 'workers-dev' },
      existing: null,
      ask: async (question) => {
        questions.push(question);
        return 'yes';
      },
      isTTY: true,
    });
    assert.equal(answers.seedDemo, true);
    assert.match(questions[0], /Seed demo data/);
  });

  it('reuses an existing local name when flags are empty', async () => {
    const answers = await collectAnswers({
      flags: { nonInteractive: true },
      existing: { name: 'already-there', hostnameMode: 'workers-dev', hostname: null },
      ask: async () => {
        throw new Error('should not prompt');
      },
      isTTY: false,
    });
    assert.equal(answers.name, 'already-there');
    assert.equal(answers.reusedExisting, true);
    assert.match(answers.reuseNotice, /already-there/);
    assert.match(answers.reuseNotice, /workers\.dev/);
  });

  it('asks a TTY to confirm the reused Worker and hostname', async () => {
    const questions = [];
    const answers = await collectAnswers({
      flags: {},
      existing: {
        name: 'already-there',
        hostnameMode: 'workers-dev',
        hostname: null,
        appDomain: 'already-there.myacct.workers.dev',
      },
      ask: async (question) => {
        questions.push(question);
        if (/Reuse this Worker and hostname/.test(question)) return 'y';
        if (/Seed demo data/.test(question)) return '';
        throw new Error(`unexpected prompt: ${question}`);
      },
      isTTY: true,
    });
    assert.equal(answers.name, 'already-there');
    assert.equal(answers.hostnameMode, 'workers-dev');
    assert.equal(answers.reusedExisting, true);
    assert.match(questions[0], /Local config is in use/);
    assert.match(questions[0], /same D1 \/ KV \/ Worker/);
    assert.match(questions[0], /To start from scratch:/);
    assert.match(questions[0], /already-there/);
    assert.match(questions[0], /already-there\.myacct\.workers\.dev/);
    assert.match(questions[0], /Reuse this Worker and hostname/);
    assert.match(questions[1], /Seed demo data/);
    assert.equal(questions.some((q) => /Worker \/ service name/.test(q)), false);
  });

  it('re-prompts Worker and hostname when the TTY declines reuse', async () => {
    const questions = [];
    const replies = ['n', 'cash-desk', '2', 'app.example.com', ''];
    const answers = await collectAnswers({
      flags: {},
      existing: {
        name: 'already-there',
        hostnameMode: 'workers-dev',
        hostname: null,
        appDomain: 'already-there.myacct.workers.dev',
      },
      ask: async (question) => {
        questions.push(question);
        return replies.shift();
      },
      isTTY: true,
    });
    assert.equal(answers.name, 'cash-desk');
    assert.equal(answers.hostnameMode, 'custom');
    assert.equal(answers.hostname, 'app.example.com');
    assert.equal(answers.reusedExisting, false);
    assert.match(questions[0], /Reuse this Worker and hostname/);
    assert.match(questions[1], /Worker \/ service name/);
  });

  it('summarizes reused worker, mode, and domain', () => {
    const text = formatReuseSummary(
      {
        name: 'cash-desk',
        hostnameMode: 'custom',
        hostname: 'app.example.com',
      },
      { configPath: '/tmp/app-v2/wrangler.local.jsonc' },
    );
    assert.match(text, /Local config is in use: \/tmp\/app-v2\/wrangler\.local\.jsonc/);
    assert.match(text, /same D1 \/ KV \/ Worker/);
    assert.match(text, /delete \/tmp\/app-v2\/wrangler\.local\.jsonc, then re-run setup/);
    assert.match(text, /Worker:\s+cash-desk/);
    assert.match(text, /Custom domain/);
    assert.match(text, /app\.example\.com/);
    assert.doesNotMatch(text, /Data → Reset/);
  });

  it('mentions Data → Reset only when seed demo is on', () => {
    const text = formatLocalConfigInUseCopy({
      configPath: 'wrangler.local.jsonc',
      seedDemo: true,
    });
    assert.match(text, /Local config is in use: wrangler\.local\.jsonc/);
    assert.equal(text.includes(SEED_RESET_HINT), true);
    assert.match(text, /follow-up release/);
  });
});

describe('prompter cleanup', () => {
  it('pauses and unrefs stdin on close', () => {
    let paused = 0;
    let unrefed = 0;
    const stdin = {
      isTTY: false,
      pause() {
        paused += 1;
      },
      unref() {
        unrefed += 1;
      },
    };
    const ask = createLinePrompter(stdin, { write() {} });
    closePrompter(ask);
    releaseStdin(stdin);
    assert.ok(paused >= 1);
    assert.ok(unrefed >= 1);
  });
});
