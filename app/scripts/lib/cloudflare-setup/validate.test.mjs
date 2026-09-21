import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESERVED_PRODUCTION_D1_NAMES,
  RESERVED_PRODUCTION_HOST_MARKERS,
  RESERVED_PRODUCTION_RATE_LIMIT_IDS,
  RESERVED_PRODUCTION_RESOURCE_IDS,
  RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT,
  RESERVED_PRODUCTION_WORKERS_DEV_LABELS,
} from './constants.mjs';
import {
  isReservedProductionHostname,
  isReservedProductionName,
  isReservedProductionRateLimitId,
  isReservedProductionResourceId,
  isStableWorkersDevHost,
  normalizeHostnameMode,
  parseNodeMajor,
  validateAppDomain,
  validateHostname,
  validateHostnameMode,
  validateResourceId,
  validateWorkerName,
} from './validate.mjs';

describe('validateWorkerName', () => {
  it('accepts a sensible default', () => {
    assert.equal(validateWorkerName('money-flow').ok, true);
  });

  it('rejects empty, uppercase, and invalid punctuation', () => {
    assert.equal(validateWorkerName('').ok, false);
    assert.equal(validateWorkerName('MoneyFlow').ok, false);
    assert.equal(validateWorkerName('-leading').ok, false);
    assert.equal(validateWorkerName('trailing-').ok, false);
    assert.equal(validateWorkerName('has_underscore').ok, false);
  });
});

describe('hostname mode parsing', () => {
  it('maps interactive shortcuts', () => {
    assert.equal(normalizeHostnameMode('1'), 'workers-dev');
    assert.equal(normalizeHostnameMode('A'), 'workers-dev');
    assert.equal(normalizeHostnameMode('workers.dev'), 'workers-dev');
    assert.equal(normalizeHostnameMode('2'), 'custom');
    assert.equal(normalizeHostnameMode('custom-domain'), 'custom');
  });

  it('rejects unknown modes', () => {
    assert.equal(validateHostnameMode('prod').ok, false);
  });
});

describe('reserved production guards', () => {
  const reservedWorker = RESERVED_PRODUCTION_WORKERS_DEV_LABELS[0];
  const reservedPreviewWorker = RESERVED_PRODUCTION_WORKERS_DEV_LABELS[1];
  const reservedCustomHost = `app.${RESERVED_PRODUCTION_HOST_MARKERS[0]}`;
  const reservedWorkerHost = `${reservedWorker}.${RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT}`;
  const reservedPreviewHost = `staging-${reservedPreviewWorker}.${RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT}`;
  const unreservedWorker = 'money-flow-setup-script-test';
  const unreservedAccountHost = `${unreservedWorker}.${RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT}`;

  it('blocks reserved production hostnames', {
    skip: !RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT
      || RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length < 2
      || RESERVED_PRODUCTION_HOST_MARKERS.length === 0,
  }, () => {
    assert.equal(isReservedProductionHostname(reservedCustomHost), true);
    assert.equal(isReservedProductionHostname(reservedPreviewHost), true);
    assert.equal(isReservedProductionHostname(reservedWorkerHost), true);
    assert.equal(isReservedProductionHostname(unreservedAccountHost), false);
    assert.equal(isReservedProductionHostname('app.example.com'), false);
    assert.equal(validateHostname(reservedCustomHost, { mode: 'custom' }).ok, false);
  });

  it('blocks reserved production binding ids', () => {
    for (const id of RESERVED_PRODUCTION_RESOURCE_IDS) {
      assert.equal(isReservedProductionResourceId(id), true);
      assert.equal(validateResourceId(id).ok, false);
    }
    assert.equal(validateResourceId('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').ok, true);
  });

  it('blocks reserved production rate-limit namespace ids', () => {
    for (const id of RESERVED_PRODUCTION_RATE_LIMIT_IDS) {
      assert.equal(isReservedProductionRateLimitId(id), true);
    }
    assert.equal(isReservedProductionRateLimitId('100000'), false);
    assert.equal(isReservedProductionRateLimitId('535105'), false);
  });

  it('blocks reserved production Worker and D1 names from delete/setup targeting', {
    skip: RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length === 0
      && RESERVED_PRODUCTION_D1_NAMES.length === 0,
  }, () => {
    for (const name of RESERVED_PRODUCTION_WORKERS_DEV_LABELS) {
      assert.equal(isReservedProductionName(name), true);
      assert.equal(isReservedProductionName(`staging-${name}`), true);
      assert.equal(isReservedProductionName(`cursor-foo-${name}`), true);
    }
    for (const name of RESERVED_PRODUCTION_D1_NAMES) {
      assert.equal(isReservedProductionName(name), true);
    }
    assert.equal(isReservedProductionName('money-flow'), false);
    assert.equal(isReservedProductionName('cash-desk'), false);
  });

  it('blocks reserved production APP_DOMAIN hosts', {
    skip: !RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT
      || RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length < 2
      || RESERVED_PRODUCTION_HOST_MARKERS.length === 0,
  }, () => {
    assert.equal(validateAppDomain(reservedCustomHost).ok, false);
    assert.equal(validateAppDomain(reservedPreviewHost).ok, false);
    assert.equal(validateAppDomain('cash-desk.myacct.workers.dev').ok, true);
    assert.equal(validateAppDomain(unreservedAccountHost).ok, true);
  });

  it('accepts only the stable workers.dev host', {
    skip: !RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT || RESERVED_PRODUCTION_WORKERS_DEV_LABELS.length < 2,
  }, () => {
    assert.equal(isStableWorkersDevHost('cash-desk.myacct.workers.dev', 'cash-desk'), true);
    assert.equal(isStableWorkersDevHost('deadbeef-cash-desk.myacct.workers.dev', 'cash-desk'), false);
    assert.equal(isStableWorkersDevHost('deadbeef.cash-desk.myacct.workers.dev', 'cash-desk'), false);
    assert.equal(
      isStableWorkersDevHost(reservedPreviewHost, 'money-flow'),
      false,
    );
    assert.equal(
      isStableWorkersDevHost(
        unreservedAccountHost,
        unreservedWorker,
      ),
      true,
    );
    assert.equal(isStableWorkersDevHost('cash-desk.workers.dev', 'cash-desk'), false);
  });

  it('requires a hostname in custom mode', () => {
    assert.equal(validateHostname('', { mode: 'custom' }).ok, false);
    assert.equal(validateHostname('not a host', { mode: 'custom' }).ok, false);
    assert.equal(validateHostname('app.example.com', { mode: 'custom' }).value, 'app.example.com');
  });
});

describe('parseNodeMajor', () => {
  it('reads the major version', () => {
    assert.equal(parseNodeMajor('22.14.0'), 22);
    assert.equal(parseNodeMajor('20.0.0'), 20);
  });
});
