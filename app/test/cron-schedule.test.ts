import { env } from 'cloudflare:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleScheduled } from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import { createSessionCookie } from '../src/worker/auth';
import { BACKUP_FORMAT, BACKUP_VERSION, exportUserState, parseBackupDocument } from '../src/worker/backup';
import {
  claimDailyCronJob,
  dispatchScheduledJobs,
} from '../src/worker/cron-schedule';
import {
  CRON_JOB_FX_REFRESH,
  CRON_LAST_RUN_FX_KEY,
  CRON_LAST_RUN_RECURRING_KEY,
  CRON_TIMEZONE_SETTING_KEY,
  FX_AUTO_UPDATE_HOUR_SETTING_KEY,
  RECURRING_AUTO_SKIP_HOUR_SETTING_KEY,
  formatUtcEquivalentForHour,
  normalizeCronHour,
  normalizeCronTimezone,
  resolveLocalDateAndHour,
} from '../src/shared/cron-schedule';
import { FX_AUTO_UPDATE_SETTING_KEY } from '../src/worker/fx-auto-update';
import type { Env } from '../src/worker/types';
import CronScheduleSection from '../src/ui/CronScheduleSection';
import { DataDashboard } from '../src/ui/Data';
import { DEFAULT_DATA_FILTERS } from '../src/ui/dataLayout';
import { RefreshProvider } from '../src/ui/RefreshContext';
import { RecurringItemForm } from '../src/ui/RecurringSection';
import i18n from '../src/ui/i18n';
import { seedAllTestRules } from './seed-test-rules';

const typedEnv = env as unknown as Env;
const clientId = 'client-cron-schedule-test';
let cookie: string;
let rpcId = 1;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return worker.request(
    path,
    {
      method,
      headers: {
        Cookie: cookie,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    typedEnv,
  );
}

async function callMcp(name: string, args: Record<string, unknown>, scopes: string[] = ['read', 'write']) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApp.fetch(req, typedEnv, { props: { scopes, clientId } } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function seedAccount(): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
     VALUES ('Schedule Main', 'USD', 10000, 1, 0, 'Alex', 'US', '2026-11-01T00:00:00Z')
     RETURNING id`,
  ).first<{ id: number }>();
  return row!.id;
}

beforeAll(async () => {
  const setCookie = await createSessionCookie(typedEnv, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
  await Promise.all([
    typedEnv.KV.delete('fx_refresh:meta'),
    typedEnv.KV.delete('fx_refresh:cooldown'),
  ]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare('DELETE FROM rule_entries'),
    env.DB.prepare('DELETE FROM rule_sets'),
    env.DB.prepare(`DELETE FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)`).bind(
      FX_AUTO_UPDATE_SETTING_KEY,
      CRON_TIMEZONE_SETTING_KEY,
      FX_AUTO_UPDATE_HOUR_SETTING_KEY,
      RECURRING_AUTO_SKIP_HOUR_SETTING_KEY,
      CRON_LAST_RUN_FX_KEY,
      CRON_LAST_RUN_RECURRING_KEY,
    ),
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES
         ('base_currency', 'USD'),
         ('low_balance_threshold_minor', '100000')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ]);
  await seedAllTestRules(env.DB);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Cron Schedule Test Client', datetime('now'))`)
    .bind(clientId)
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cron timezone and hour normalization', () => {
  it('canonicalizes valid IANA timezones and rejects abbreviations, numeric offsets, and invalid inputs', () => {
    expect(normalizeCronTimezone('UTC')).toBe('UTC');
    expect(normalizeCronTimezone(' utc ')).toBe('UTC');
    expect(normalizeCronTimezone('Etc/UTC')).toBe('UTC');
    expect(normalizeCronTimezone('europe/belgrade')).toBe('Europe/Belgrade');
    expect(normalizeCronTimezone('america/new_york')).toBe('America/New_York');
    expect(['Asia/Calcutta', 'Asia/Kolkata']).toContain(normalizeCronTimezone('Asia/Kolkata'));
    expect(['Europe/Kiev', 'Europe/Kyiv']).toContain(normalizeCronTimezone('Europe/Kyiv'));
    expect(normalizeCronTimezone('US/Eastern')).toBe('America/New_York');

    for (const bad of [
      '',
      '   ',
      'CET',
      'EST',
      'PST',
      'GMT',
      '+02:00',
      '-05:00',
      'Etc/GMT+2',
      'etc/gmt-3',
      'Mars/Olympus',
      'Europe/Belgrade extra',
      'A'.repeat(65),
      123,
      null,
      undefined,
    ]) {
      expect(normalizeCronTimezone(bad), String(bad)).toBeNull();
    }
  });

  it('validates integer hours 0..23 and rejects out-of-range or malformed values', () => {
    expect(normalizeCronHour(0)).toBe(0);
    expect(normalizeCronHour(2)).toBe(2);
    expect(normalizeCronHour(23)).toBe(23);
    expect(normalizeCronHour('0')).toBe(0);
    expect(normalizeCronHour('02')).toBe(2);
    expect(normalizeCronHour(' 23 ')).toBe(23);

    for (const bad of [-1, 24, 2.5, '24', '-1', '02:30', '', 'abc', null, true, undefined]) {
      expect(normalizeCronHour(bad), String(bad)).toBeNull();
    }
  });

  it('resolves local calendar dates and hours across midnight, half-hour offsets, and DST transitions', () => {
    // Negative offset crossing UTC midnight (2026-11-22 03:30Z -> 2026-11-21 22:30 EST)
    expect(resolveLocalDateAndHour(new Date('2026-11-22T03:30:00Z'), 'America/New_York')).toEqual({
      localDate: '2026-11-21',
      localHour: 22,
    });

    // Positive offset crossing UTC midnight (2026-11-22 22:30Z -> 2026-11-23 07:30 JST)
    expect(resolveLocalDateAndHour(new Date('2026-11-22T22:30:00Z'), 'Asia/Tokyo')).toEqual({
      localDate: '2026-11-23',
      localHour: 7,
    });

    // Half-hour offset at midnight (2026-11-22 18:30Z -> 2026-11-23 00:00 IST)
    expect(resolveLocalDateAndHour(new Date('2026-11-22T18:30:00Z'), 'Asia/Kolkata')).toEqual({
      localDate: '2026-11-23',
      localHour: 0,
    });

    // DST spring forward in Europe/Belgrade (2026-03-29: 01:59 CET -> 03:00 CEST, hour 2 skipped)
    expect(resolveLocalDateAndHour(new Date('2026-03-29T00:30:00Z'), 'Europe/Belgrade')).toEqual({
      localDate: '2026-03-29',
      localHour: 1,
    });
    expect(resolveLocalDateAndHour(new Date('2026-03-29T01:30:00Z'), 'Europe/Belgrade')).toEqual({
      localDate: '2026-03-29',
      localHour: 3,
    });

    // DST fall back in Europe/Belgrade (2026-10-25: 00:30Z = 02:30 CEST, 01:30Z = 02:30 CET)
    expect(resolveLocalDateAndHour(new Date('2026-10-25T00:30:00Z'), 'Europe/Belgrade')).toEqual({
      localDate: '2026-10-25',
      localHour: 2,
    });
    expect(resolveLocalDateAndHour(new Date('2026-10-25T01:30:00Z'), 'Europe/Belgrade')).toEqual({
      localDate: '2026-10-25',
      localHour: 2,
    });

    expect(formatUtcEquivalentForHour('UTC', 2, new Date('2026-11-22T00:00:00Z'))).toBe('02:00');
    expect(formatUtcEquivalentForHour('Europe/Belgrade', 8, new Date('2026-11-22T00:00:00Z'))).toBe('07:00');
    expect(formatUtcEquivalentForHour('Europe/Belgrade', 8, new Date('2026-07-15T00:00:00Z'))).toBe('06:00');
    expect(formatUtcEquivalentForHour('Asia/Kolkata', 8, new Date('2026-11-22T00:00:00Z'))).toBe('02:30');
  });
});

describe('hourly cron dispatcher, atomic claims, and timezone calendar alignment', () => {
  it('preserves default 02:00 UTC schedule and runs at most once per day', async () => {
    const accountId = await seedAccount();
    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1100000000, '2026-10-01T00:00:00Z')`,
    ).run();
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, '1')`).bind(FX_AUTO_UPDATE_SETTING_KEY).run();
    await api('POST', '/api/v2/recurring-items', {
      title: 'Daily Coffee',
      amount_minor: -300,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-21',
      auto_skip_overdue: true,
      auto_skip_after_days: 1,
    });

    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ result: 'success', base_code: 'USD', rates: { EUR: 0.8 } }), { status: 200 }),
    );

    // 01:00 UTC -> before default 02:00 UTC
    const early = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-22T01:00:00Z'),
      fetcher,
    });
    expect(early.fx_refresh).toEqual({ ran: false, reason: 'before_scheduled_hour' });
    expect(early.recurring_auto_skip.status).toBe('skipped_schedule');
    expect(fetcher).not.toHaveBeenCalled();

    // 02:00 UTC -> both jobs execute once
    const atHour = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-22T02:00:00Z'),
      fetcher,
    });
    expect(atHour.fx_refresh).toMatchObject({ ran: true, ok: true, updated: 1 });
    expect(atHour.recurring_auto_skip).toMatchObject({ status: 'ok', today: '2026-11-22', periodsSkipped: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 03:00 UTC same day -> idempotent skip
    const laterSameDay = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-22T03:00:00Z'),
      fetcher,
    });
    expect(laterSameDay.fx_refresh).toEqual({ ran: false, reason: 'already_ran_today' });
    expect(laterSameDay.recurring_auto_skip.status).toBe('already_ran_today');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Next UTC day 02:00 UTC -> runs again cleanly
    const nextDay = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-23T02:00:00Z'),
      fetcher,
    });
    expect(nextDay.fx_refresh).toMatchObject({ ran: true, ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dispatches per-job local hours independently and evaluates recurring overdue dates in configured timezone', async () => {
    const accountId = await seedAccount();
    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1100000000, '2026-10-01T00:00:00Z')`,
    ).run();
    await api('PUT', `/api/v2/settings/${FX_AUTO_UPDATE_SETTING_KEY}`, { value: '1' });
    await api('PUT', '/api/v2/cron-schedule', {
      timezone: 'Asia/Tokyo', // UTC+9
      fx_auto_update_hour: 9,
      recurring_auto_skip_hour: 7,
    });

    // Due 2026-11-22, auto_skip_after_days=1 -> eligible when localDate >= 2026-11-23
    const createRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Tokyo Lunch',
      amount_minor: -900,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-22',
      auto_skip_overdue: true,
      auto_skip_after_days: 1,
    });
    const ruleId = ((await createRes.json()) as any).recurring_item.id;

    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ result: 'success', base_code: 'USD', rates: { EUR: 0.85 } }), { status: 200 }),
    );

    // 2026-11-22T22:00:00Z = 2026-11-23 07:00 Asia/Tokyo (UTC date is still 2026-11-22!)
    // Recurring hour=7 runs with today=2026-11-23 and skips 2026-11-22 -> 2026-11-23; FX hour=9 waits.
    const tick1 = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-22T22:00:00Z'),
      fetcher,
    });
    expect(tick1.local_date).toBe('2026-11-23');
    expect(tick1.local_hour).toBe(7);
    expect(tick1.recurring_auto_skip).toMatchObject({ status: 'ok', today: '2026-11-23', periodsSkipped: 1 });
    expect(tick1.fx_refresh).toEqual({ ran: false, reason: 'before_scheduled_hour' });
    expect(fetcher).not.toHaveBeenCalled();

    const updatedRule = await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?')
      .bind(ruleId)
      .first<{ next_due_date: string }>();
    expect(updatedRule?.next_due_date).toBe('2026-11-23');

    // 2026-11-23T00:00:00Z = 2026-11-23 09:00 Asia/Tokyo -> FX runs now, recurring already ran for 2026-11-23
    const tick2 = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-23T00:00:00Z'),
      fetcher,
    });
    expect(tick2.local_date).toBe('2026-11-23');
    expect(tick2.local_hour).toBe(9);
    expect(tick2.fx_refresh).toMatchObject({ ran: true, ok: true, updated: 1 });
    expect(tick2.recurring_auto_skip.status).toBe('already_ran_today');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('handles DST spring-forward and fall-back without missing or duplicating daily runs', async () => {
    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1100000000, '2026-10-01T00:00:00Z')`,
    ).run();
    await api('PUT', `/api/v2/settings/${FX_AUTO_UPDATE_SETTING_KEY}`, { value: '1' });
    await api('PUT', '/api/v2/cron-schedule', {
      timezone: 'Europe/Belgrade',
      fx_auto_update_hour: 2,
      recurring_auto_skip_hour: 2,
    });

    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ result: 'success', base_code: 'USD', rates: { EUR: 0.9 } }), { status: 200 }),
    );

    // Spring forward 2026-03-29: 01:00 UTC jumps from 01:59 CET to 03:00 CEST (hour 2 skipped)
    const spring = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-03-29T01:00:00Z'),
      fetcher,
    });
    expect(spring.local_date).toBe('2026-03-29');
    expect(spring.local_hour).toBe(3);
    expect(spring.fx_refresh).toMatchObject({ ran: true, ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Fall back 2026-10-25: 00:00 UTC is 02:00 CEST, 01:00 UTC is 02:00 CET (hour 2 repeats)
    const fallFirst = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-10-25T00:00:00Z'),
      fetcher,
    });
    expect(fallFirst.local_date).toBe('2026-10-25');
    expect(fallFirst.local_hour).toBe(2);
    expect(fallFirst.fx_refresh).toMatchObject({ ran: true, ok: true });

    const fallSecond = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-10-25T01:00:00Z'),
      fetcher,
    });
    expect(fallSecond.local_date).toBe('2026-10-25');
    expect(fallSecond.local_hour).toBe(2);
    expect(fallSecond.fx_refresh).toEqual({ ran: false, reason: 'already_ran_today' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('releases claim on failure for retry, skips claim when FX disabled, and is a no-op in DEMO_MODE', async () => {
    await env.DB.prepare(
      `INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES ('EUR', 1100000000, '2026-10-01T00:00:00Z')`,
    ).run();

    // 1. Atomic concurrent claim allows strictly one winner
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimDailyCronJob(env.DB, CRON_JOB_FX_REFRESH, '2026-11-22')),
    );
    expect(claims.filter((c) => c.acquired)).toHaveLength(1);
    expect(claims.filter((c) => !c.acquired)).toHaveLength(4);
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(CRON_LAST_RUN_FX_KEY).run();

    // 2. When fx_auto_update is disabled at 02:00, claim is NOT recorded; enabling later at 03:00 still runs
    const disabledTick = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-22T02:00:00Z'),
    });
    expect(disabledTick.fx_refresh).toEqual({ ran: false, reason: 'disabled' });
    const markerWhileDisabled = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind(CRON_LAST_RUN_FX_KEY)
      .first();
    expect(markerWhileDisabled).toBeNull();

    // 3. Failure at 02:00 releases claim so retry at 03:00 succeeds
    await api('PUT', `/api/v2/settings/${FX_AUTO_UPDATE_SETTING_KEY}`, { value: '1' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failFetcher = vi.fn(async () => new Response('upstream error', { status: 503 }));
    const failedTick = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-22T02:00:00Z'),
      fetcher: failFetcher,
    });
    expect(failedTick.fx_refresh).toMatchObject({ ran: true, ok: false });

    const okFetcher = vi.fn(async () =>
      new Response(JSON.stringify({ result: 'success', base_code: 'USD', rates: { EUR: 0.88 } }), { status: 200 }),
    );
    const retryTick = await dispatchScheduledJobs(typedEnv, {
      now: new Date('2026-11-22T03:00:00Z'),
      fetcher: okFetcher,
    });
    expect(retryTick.fx_refresh).toMatchObject({ ran: true, ok: true, updated: 1 });
    expect(okFetcher).toHaveBeenCalledTimes(1);

    // 4. DEMO_MODE=1 is a strict no-op via handleScheduled
    const pending: Promise<unknown>[] = [];
    const mockCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const demoSpy = vi.fn();
    vi.stubGlobal('fetch', demoSpy);
    await handleScheduled(
      { scheduledTime: Date.UTC(2026, 10, 23, 2, 0, 0), cron: '0 * * * *' } as ScheduledController,
      { ...typedEnv, DEMO_MODE: '1' },
      mockCtx,
    );
    await Promise.all(pending);
    expect(demoSpy).not.toHaveBeenCalled();
  });
});

describe('REST API, settings, and backup parity for cron schedule', () => {
  it('reads defaults and validates updates via GET/PUT /cron-schedule and /settings/:key', async () => {
    const initial = await (await api('GET', '/api/v2/cron-schedule')).json() as any;
    expect(initial).toEqual({
      timezone: 'UTC',
      fx_auto_update_hour: 2,
      recurring_auto_skip_hour: 2,
      fx_auto_update_enabled: false,
      demo_mode: false,
      jobs: {
        fx_refresh: { hour: 2, time: '02:00', last_run_local_date: null },
        recurring_auto_skip: { hour: 2, time: '02:00', last_run_local_date: null },
      },
    });

    // Reject bad timezone, bad hour, empty/unknown patch fields
    const badTz = await api('PUT', '/api/v2/cron-schedule', { timezone: 'CET' });
    expect(badTz.status).toBe(400);
    expect(((await badTz.json()) as any).error.code).toBe('SETTING_TIMEZONE_INVALID');

    const badHour = await api('PUT', '/api/v2/cron-schedule', { fx_auto_update_hour: 24 });
    expect(badHour.status).toBe(400);
    expect(((await badHour.json()) as any).error.code).toBe('SETTING_HOUR_INVALID');

    const emptyPatch = await api('PUT', '/api/v2/cron-schedule', {});
    expect(emptyPatch.status).toBe(400);
    expect(((await emptyPatch.json()) as any).error.code).toBe('NO_PATCH_FIELDS');

    const unknownField = await api('PUT', '/api/v2/cron-schedule', { timezone: 'UTC', extra: 1 });
    expect(unknownField.status).toBe(400);
    expect(((await unknownField.json()) as any).error.code).toBe('REQUEST_BODY_INVALID');

    // Valid update via /cron-schedule reflects in /fx-rates and /settings
    const updatedRes = await api('PUT', '/api/v2/cron-schedule', {
      timezone: 'europe/belgrade',
      fx_auto_update_hour: 8,
      recurring_auto_skip_hour: 1,
    });
    expect(updatedRes.status).toBe(200);
    const updated = await updatedRes.json() as any;
    expect(updated.timezone).toBe('Europe/Belgrade');
    expect(updated.fx_auto_update_hour).toBe(8);
    expect(updated.recurring_auto_skip_hour).toBe(1);
    expect(updated.jobs.fx_refresh.time).toBe('08:00');
    expect(updated.jobs.recurring_auto_skip.time).toBe('01:00');

    const fxList = await (await api('GET', '/api/v2/fx-rates')).json() as any;
    expect(fxList.auto_update).toMatchObject({
      schedule_timezone: 'Europe/Belgrade',
      schedule_hour: 8,
      schedule_time: '08:00',
    });

    // Individual setting endpoints + reserved last-run keys
    const tzPut = await api('PUT', `/api/v2/settings/${CRON_TIMEZONE_SETTING_KEY}`, { value: 'america/new_york' });
    expect(tzPut.status).toBe(200);
    expect(((await tzPut.json()) as any).settings[CRON_TIMEZONE_SETTING_KEY]).toBe('America/New_York');

    const hourPut = await api('PUT', `/api/v2/settings/${FX_AUTO_UPDATE_HOUR_SETTING_KEY}`, { value: '15' });
    expect(hourPut.status).toBe(200);
    expect(((await hourPut.json()) as any).settings[FX_AUTO_UPDATE_HOUR_SETTING_KEY]).toBe('15');

    // Reserved last_run markers cannot be written via /settings/:key and are hidden from GET /settings
    await claimDailyCronJob(env.DB, CRON_JOB_FX_REFRESH, '2026-11-22');
    const reservedPut = await api('PUT', `/api/v2/settings/${CRON_LAST_RUN_FX_KEY}`, { value: '2026-11-20' });
    expect(reservedPut.status).toBe(403);
    expect(((await reservedPut.json()) as any).error.code).toBe('SETTING_KEY_RESERVED');

    const settingsGet = await (await api('GET', '/api/v2/settings')).json() as any;
    expect(settingsGet.settings[CRON_LAST_RUN_FX_KEY]).toBeUndefined();
    expect(settingsGet.settings[CRON_TIMEZONE_SETTING_KEY]).toBe('America/New_York');
  });

  it('validates cron schedule keys on backup export and import', async () => {
    await api('PUT', '/api/v2/cron-schedule', {
      timezone: 'europe/belgrade',
      fx_auto_update_hour: 6,
      recurring_auto_skip_hour: 4,
    });
    const doc = await exportUserState(env.DB);
    const parsed = parseBackupDocument({ confirm: true, ...doc });
    expect(parsed.tables.settings).toEqual(
      expect.arrayContaining([
        { key: CRON_TIMEZONE_SETTING_KEY, value: 'Europe/Belgrade' },
        { key: FX_AUTO_UPDATE_HOUR_SETTING_KEY, value: '6' },
        { key: RECURRING_AUTO_SKIP_HOUR_SETTING_KEY, value: '4' },
      ]),
    );

    expect(() =>
      parseBackupDocument({
        confirm: true,
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: '2026-11-22T00:00:00Z',
        tables: {
          ...doc.tables,
          settings: [{ key: CRON_TIMEZONE_SETTING_KEY, value: 'CET' }],
        },
      }),
    ).toThrow();

    expect(() =>
      parseBackupDocument({
        confirm: true,
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: '2026-11-22T00:00:00Z',
        tables: {
          ...doc.tables,
          settings: [{ key: FX_AUTO_UPDATE_HOUR_SETTING_KEY, value: '25' }],
        },
      }),
    ).toThrow();

    expect(() =>
      parseBackupDocument({
        confirm: true,
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: '2026-11-22T00:00:00Z',
        tables: {
          ...doc.tables,
          settings: [{ key: CRON_LAST_RUN_FX_KEY, value: 'not-a-date' }],
        },
      }),
    ).toThrow();
  });
});

describe('MCP parity for cron_schedule_get, cron_schedule_set, and setting_set', () => {
  it('enforces scopes, two-step MRTR, auto_confirm, write-only redaction, and validation', async () => {
    const readDenied = await callMcp('cron_schedule_get', {}, ['write']);
    expect(readDenied.error.code).toBe(-32001);

    const initial = await callMcp('cron_schedule_get', {}, ['read']);
    expect(initial.result.isError).not.toBe(true);
    expect(initial.result.structuredContent).toMatchObject({
      timezone: 'UTC',
      fx_auto_update_hour: 2,
      recurring_auto_skip_hour: 2,
    });

    const writeDenied = await callMcp('cron_schedule_set', {
      timezone: 'Europe/Belgrade',
      idempotency_key: 'mcp-cron-ro',
    }, ['read']);
    expect(writeDenied.error.code).toBe(-32001);

    // Invalid timezone rejected before MRTR
    const badTz = await callMcp('cron_schedule_set', {
      timezone: 'CET',
      idempotency_key: 'mcp-cron-bad-tz',
    });
    expect(badTz.result.isError).toBe(true);
    expect(badTz.result.structuredContent.error).toContain('IANA timezone');

    // Empty schedule rejected
    const emptyArgs = await callMcp('cron_schedule_set', {
      idempotency_key: 'mcp-cron-empty',
    });
    expect(emptyArgs.result.isError).toBe(true);

    // Two-step MRTR flow
    const preview = await callMcp('cron_schedule_set', {
      timezone: 'europe/belgrade',
      fx_auto_update_hour: 8,
      recurring_auto_skip_hour: 1,
      idempotency_key: 'mcp-cron-mrtr',
    });
    expect(preview.result.structuredContent.resultType).toBe('input_required');
    expect(preview.result.structuredContent.written).toBe(false);
    expect(preview.result.structuredContent.description).toContain('UTC -> Europe/Belgrade');
    expect(preview.result.structuredContent.description).toContain('02:00 -> 08:00');
    expect(preview.result.structuredContent.description).toContain('02:00 -> 01:00');

    const confirmed = await callMcp('cron_schedule_set', {
      timezone: 'europe/belgrade',
      fx_auto_update_hour: 8,
      recurring_auto_skip_hour: 1,
      idempotency_key: 'mcp-cron-mrtr',
      requestState: preview.result.structuredContent.requestState,
    });
    expect(confirmed.result.isError).not.toBe(true);
    expect(confirmed.result.structuredContent).toMatchObject({
      resultType: 'complete',
      written: true,
      timezone: 'Europe/Belgrade',
      fx_auto_update_hour: 8,
      recurring_auto_skip_hour: 1,
    });

    // Write-only auto_confirm redacts read fields while reporting applied schedule changes
    const writeOnly = await callMcp('cron_schedule_set', {
      timezone: 'UTC',
      auto_confirm: true,
      idempotency_key: 'mcp-cron-wo',
    }, ['write']);
    expect(writeOnly.result.structuredContent).toEqual({
      written: true,
      resultType: 'complete',
      success: true,
      timezone: 'UTC',
    });

    // setting_set accepts new keys and blocks reserved last_run keys
    const settingOk = await callMcp('setting_set', {
      key: RECURRING_AUTO_SKIP_HOUR_SETTING_KEY,
      value: 5,
      auto_confirm: true,
      idempotency_key: 'mcp-setting-hour',
    });
    expect(settingOk.result.isError).not.toBe(true);
    expect(settingOk.result.structuredContent.settings[RECURRING_AUTO_SKIP_HOUR_SETTING_KEY]).toBe('5');

    const settingReserved = await callMcp('setting_set', {
      key: CRON_LAST_RUN_FX_KEY,
      value: '2026-11-22',
      idempotency_key: 'mcp-setting-reserved',
    });
    expect(settingReserved.result.isError).toBe(true);
    expect(settingReserved.result.structuredContent.error).toContain('reserved');
  });
});

describe('UI SSR rendering for CronScheduleSection, FX rates, and Recurring schedule hints', () => {
  it('renders CronScheduleSection controls, datalist, last-run dates, and explicit DEMO_MODE notice', () => {
    const schedule = {
      timezone: 'Europe/Belgrade',
      fx_auto_update_hour: 8,
      recurring_auto_skip_hour: 1,
      fx_auto_update_enabled: true,
      demo_mode: true,
      jobs: {
        fx_refresh: { hour: 8, time: '08:00', last_run_local_date: '2026-11-22' },
        recurring_auto_skip: { hour: 1, time: '01:00', last_run_local_date: null },
      },
    };
    const demoHtml = renderToStaticMarkup(
      React.createElement(CronScheduleSection as any, {
        schedule,
        demoMode: true,
      }),
    );

    expect(demoHtml).toContain('id="schedule"');
    expect(demoHtml).toContain('<datalist');
    expect(demoHtml).toContain('value="Europe/Belgrade"');
    expect(demoHtml).toContain('08:00');
    expect(demoHtml).toContain('01:00');
    expect(demoHtml).toContain('2026-11-22');
    expect(demoHtml).toContain(i18n.t('data.schedule.demoNotice'));
    expect(demoHtml).toContain(i18n.t('data.schedule.save'));

    const prodHtml = renderToStaticMarkup(
      React.createElement(CronScheduleSection as any, {
        schedule: { ...schedule, demo_mode: false },
        demoMode: false,
      }),
    );
    expect(prodHtml).not.toContain(i18n.t('data.schedule.demoNotice'));
    expect(prodHtml).toContain('role="status"');
    expect(prodHtml).toContain('aria-live="polite"');

    const loadErrorHtml = renderToStaticMarkup(
      React.createElement(CronScheduleSection as any, {
        schedule: { ...schedule, demo_mode: false },
        loadError: 'Network failure',
        demoMode: false,
      }),
    );
    expect(loadErrorHtml).toContain('Network failure');
    expect(loadErrorHtml).toContain('role="alert"');
  });

  it('renders live configured schedule in DataDashboard FX section and RecurringItemForm', () => {
    const cronSchedule = {
      timezone: 'Europe/Belgrade',
      fx_auto_update_hour: 8,
      recurring_auto_skip_hour: 1,
    };
    const dashboardHtml = renderToStaticMarkup(
      React.createElement(
        RefreshProvider,
        null,
        React.createElement(DataDashboard as any, {
          config: [{ id: 'rates', visible: true, column: 'full' }],
          filters: { ...DEFAULT_DATA_FILTERS, ratesOpen: true },
          accounts: [],
          rates: [],
          visibleRates: [],
          missingRates: [],
          baseCurrency: 'USD',
          fxAnchorCode: 'USD',
          cronSchedule,
          fxAutoUpdate: {
            enabled: true,
            provider: 'exchangerate-api',
            provider_name: 'ExchangeRate-API',
            provider_url: 'https://www.exchangerate-api.com',
            schedule_utc: '07:00',
            schedule_hour: 8,
            schedule_timezone: 'Europe/Belgrade',
            schedule_time: '08:00',
            last_run_at: null,
            last_status: null,
            last_error: null,
            last_trigger: null,
          },
        }),
      ),
    );
    expect(dashboardHtml).toContain('08:00 Europe/Belgrade');
    expect(dashboardHtml).toContain('#/data/schedule');

    const formHtml = renderToStaticMarkup(
      React.createElement(RecurringItemForm as any, {
        accounts: [{ id: 1, name: 'Main', currency: 'USD', archived: 0 }],
        submitLabel: 'Save',
        onSubmit: () => {},
        onCancel: () => {},
        cronSchedule,
      }),
    );
    expect(formHtml).toContain('01:00 Europe/Belgrade');
    expect(formHtml).toContain('#/data/schedule');
  });
});
