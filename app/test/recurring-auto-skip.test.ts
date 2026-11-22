import { env } from 'cloudflare:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleScheduled } from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import { createSessionCookie } from '../src/worker/auth';
import { BACKUP_FORMAT, BACKUP_VERSION, exportUserState, parseBackupDocument, USER_TABLES } from '../src/worker/backup';
import {
  handleScheduledRecurringAutoSkip,
  isOccurrenceEligibleForAutoSkip,
  runRecurringAutoSkip,
} from '../src/worker/recurring-auto-skip';
import type { Env } from '../src/worker/types';
import { RecurringItemForm } from '../src/ui/RecurringSection';
import i18n from '../src/ui/i18n';
import { seedAllTestRules } from './seed-test-rules';

const typedEnv = env as unknown as Env;
const clientId = 'client-recurring-auto-skip-test';
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
     VALUES ('Main USD', 'USD', 50000, 1, 0, 'Alex', 'US', '2026-11-01T00:00:00Z')
     RETURNING id`,
  ).first<{ id: number }>();
  return row!.id;
}

beforeAll(async () => {
  const setCookie = await createSessionCookie(typedEnv, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
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
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES
         ('base_currency', 'USD'),
         ('low_balance_threshold_minor', '100000')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ]);
  await seedAllTestRules(env.DB);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Recurring Skip Test Client', datetime('now'))`)
    .bind(clientId)
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isOccurrenceEligibleForAutoSkip', () => {
  it('checks exact integer-day boundaries and invalid delays', () => {
    expect(isOccurrenceEligibleForAutoSkip('2026-11-21', 1, '2026-11-21')).toBe(false);
    expect(isOccurrenceEligibleForAutoSkip('2026-11-20', 1, '2026-11-21')).toBe(true);
    expect(isOccurrenceEligibleForAutoSkip('2026-11-19', 3, '2026-11-21')).toBe(false);
    expect(isOccurrenceEligibleForAutoSkip('2026-11-18', 3, '2026-11-21')).toBe(true);
    expect(isOccurrenceEligibleForAutoSkip('2026-11-01', 0, '2026-11-21')).toBe(false);
    expect(isOccurrenceEligibleForAutoSkip('2026-11-01', 366, '2026-11-21')).toBe(false);
  });
});

describe('REST API parity for auto_skip_overdue and auto_skip_after_days', () => {
  it('defaults to OFF with 1-day delay, accepts explicit values, and validates ranges', async () => {
    const accountId = await seedAccount();

    const defaultRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Streaming Subscription',
      amount_minor: -1299,
      account_id: accountId,
      frequency: 'monthly',
      next_due_date: '2026-11-25',
    });
    expect(defaultRes.status).toBe(201);
    const defaultItem = ((await defaultRes.json()) as any).recurring_item;
    expect(defaultItem.auto_skip_overdue).toBe(false);
    expect(defaultItem.auto_skip_after_days).toBe(1);

    const optInRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Daily Coffee',
      amount_minor: -450,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-20',
      auto_skip_overdue: true,
      auto_skip_after_days: 3,
    });
    expect(optInRes.status).toBe(201);
    const optInItem = ((await optInRes.json()) as any).recurring_item;
    expect(optInItem.auto_skip_overdue).toBe(true);
    expect(optInItem.auto_skip_after_days).toBe(3);

    const patchRes = await api('PATCH', `/api/v2/recurring-items/${optInItem.id}`, {
      auto_skip_overdue: false,
      auto_skip_after_days: 7,
    });
    expect(patchRes.status).toBe(200);
    const patched = ((await patchRes.json()) as any).recurring_item;
    expect(patched.auto_skip_overdue).toBe(false);
    expect(patched.auto_skip_after_days).toBe(7);

    for (const badDays of [0, -1, 366, 1.5, '2']) {
      const badRes = await api('PATCH', `/api/v2/recurring-items/${optInItem.id}`, {
        auto_skip_after_days: badDays,
      });
      expect(badRes.status).toBe(400);
      expect(((await badRes.json()) as any).error.code).toBe('INVALID_AUTO_SKIP_AFTER_DAYS');
    }

    const badBoolRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Bad Bool',
      amount_minor: -100,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-20',
      auto_skip_overdue: 'yes',
    });
    expect(badBoolRes.status).toBe(400);
  });
});

describe('Worker Cron runRecurringAutoSkip and handleScheduledRecurringAutoSkip', () => {
  it('skips eligible overdue periods only, catches up without creating operations or changing balances, and handles end_date & DEMO_MODE', async () => {
    const accountId = await seedAccount();

    // 1. Mandatory rule (opt-in OFF) - never auto-skipped even when overdue
    const fixedRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Rent',
      amount_minor: -100000,
      account_id: accountId,
      frequency: 'monthly',
      next_due_date: '2026-11-01',
      auto_skip_overdue: false,
      auto_skip_after_days: 1,
    });
    const fixedId = ((await fixedRes.json()) as any).recurring_item.id;

    // 2. Daily optional rule (delay 1 day), 3 overdue days (2026-11-18, 19, 20) vs today 2026-11-21 -> stops on 2026-11-21
    const dailyRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Groceries',
      amount_minor: -1500,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-18',
      auto_skip_overdue: true,
      auto_skip_after_days: 1,
    });
    const dailyId = ((await dailyRes.json()) as any).recurring_item.id;

    // 3. 3-day-delay rule overdue by only 2 days (2026-11-19 -> diff 2 < 3) -> NOT skipped yet
    const delayedRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Transport',
      amount_minor: -500,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-19',
      auto_skip_overdue: true,
      auto_skip_after_days: 3,
    });
    const delayedId = ((await delayedRes.json()) as any).recurring_item.id;

    // 4. Ending rule: next_due_date = 2026-11-19, end_date = 2026-11-20, daily, after_days = 1
    // On 2026-11-21: skips 2026-11-19 -> advances to 2026-11-20 -> skips 2026-11-20 -> next (21) > end_date -> active = 0
    const endingRes = await api('POST', '/api/v2/recurring-items', {
      title: 'Temp Pass',
      amount_minor: -300,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-19',
      end_date: '2026-11-20',
      auto_skip_overdue: true,
      auto_skip_after_days: 1,
    });
    const endingId = ((await endingRes.json()) as any).recurring_item.id;

    // DEMO_MODE=1 must be a strict no-op
    const demoOutcome = await handleScheduledRecurringAutoSkip(
      { ...typedEnv, DEMO_MODE: '1' },
      { todayIso: '2026-11-21' },
    );
    expect(demoOutcome).toEqual({
      status: 'skipped_demo',
      today: '2026-11-21',
      rulesChecked: 0,
      rulesAdvanced: 0,
      periodsSkipped: 0,
      rulesDeactivated: 0,
    });

    // Live run on 2026-11-21
    const result = await runRecurringAutoSkip(env.DB, { todayIso: '2026-11-21' });
    expect(result).toEqual({
      status: 'ok',
      today: '2026-11-21',
      rulesChecked: 3,
      rulesAdvanced: 2,
      periodsSkipped: 5, // 3 (Groceries: 18,19,20) + 2 (Temp Pass: 19,20)
      rulesDeactivated: 1,
    });

    const fixedRow = await env.DB.prepare('SELECT next_due_date, active FROM recurring_items WHERE id = ?').bind(fixedId).first<any>();
    expect(fixedRow).toEqual({ next_due_date: '2026-11-01', active: 1 });

    const dailyRow = await env.DB.prepare('SELECT next_due_date, active FROM recurring_items WHERE id = ?').bind(dailyId).first<any>();
    expect(dailyRow).toEqual({ next_due_date: '2026-11-21', active: 1 });

    const delayedRow = await env.DB.prepare('SELECT next_due_date, active FROM recurring_items WHERE id = ?').bind(delayedId).first<any>();
    expect(delayedRow).toEqual({ next_due_date: '2026-11-19', active: 1 });

    const endingRow = await env.DB.prepare('SELECT next_due_date, end_date, active FROM recurring_items WHERE id = ?').bind(endingId).first<any>();
    expect(endingRow).toEqual({ next_due_date: '2026-11-20', end_date: '2026-11-20', active: 0 });

    const fulfillments = await env.DB.prepare(
      'SELECT recurring_item_id, period_due_date, outcome FROM recurring_period_fulfillments ORDER BY recurring_item_id ASC, period_due_date ASC',
    ).all<any>();
    expect(fulfillments.results).toEqual([
      { recurring_item_id: dailyId, period_due_date: '2026-11-18', outcome: 'skipped' },
      { recurring_item_id: dailyId, period_due_date: '2026-11-19', outcome: 'skipped' },
      { recurring_item_id: dailyId, period_due_date: '2026-11-20', outcome: 'skipped' },
      { recurring_item_id: endingId, period_due_date: '2026-11-19', outcome: 'skipped' },
      { recurring_item_id: endingId, period_due_date: '2026-11-20', outcome: 'skipped' },
    ]);

    // Balances and operations must remain untouched
    const opCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(opCount?.n).toBe(0);
    const accRow = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
    expect(accRow?.balance_minor).toBe(50000);

    // Next day (2026-11-22): Transport reaches +3 days (2026-11-19 -> 2026-11-22) and Groceries skips 2026-11-21
    const dayTwo = await runRecurringAutoSkip(env.DB, { todayIso: '2026-11-22' });
    expect(dayTwo).toEqual({
      status: 'ok',
      today: '2026-11-22',
      rulesChecked: 2,
      rulesAdvanced: 2,
      periodsSkipped: 2,
      rulesDeactivated: 0,
    });
    const delayedDayTwo = await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(delayedId).first<{ next_due_date: string }>();
    expect(delayedDayTwo?.next_due_date).toBe('2026-11-20');
  });

  it('runs handleScheduledRecurringAutoSkip alongside FX refresh via handleScheduled without cross-job failure', async () => {
    const accountId = await seedAccount();
    const yesterday = '2026-11-21';
    const today = '2026-11-22';
    const res = await api('POST', '/api/v2/recurring-items', {
      title: 'Snacks',
      amount_minor: -200,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: yesterday,
      auto_skip_overdue: true,
      auto_skip_after_days: 1,
    });
    const itemId = ((await res.json()) as any).recurring_item.id;

    // Even if FX fetch fails, handleScheduled uses Promise.allSettled and recurring cron still advances
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const pending: Promise<unknown>[] = [];
    const mockCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    await handleScheduled({ scheduledTime: Date.UTC(2026, 10, 22, 2, 0, 0), cron: '0 * * * *' } as ScheduledController, typedEnv, mockCtx);
    await Promise.all(pending);

    const updated = await env.DB.prepare('SELECT next_due_date FROM recurring_items WHERE id = ?').bind(itemId).first<{ next_due_date: string }>();
    expect(updated?.next_due_date).toBe(today);
  });

  it('catches DB errors inside handleScheduledRecurringAutoSkip cleanly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenDb = {
      prepare: () => {
        throw new Error('d1 unavailable');
      },
    } as unknown as D1Database;
    const outcome = await handleScheduledRecurringAutoSkip({ DB: brokenDb, DEMO_MODE: '0' }, { todayIso: '2026-11-21' });
    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('d1 unavailable');
  });

  it('aborts CAS update if a concurrent PATCH edits schedule fields without changing revision', async () => {
    const accountId = await seedAccount();
    const res = await api('POST', '/api/v2/recurring-items', {
      title: 'Coffee',
      amount_minor: -400,
      account_id: accountId,
      frequency: 'daily',
      interval_count: 1,
      next_due_date: '2026-11-19',
      auto_skip_overdue: true,
      auto_skip_after_days: 1,
    });
    const itemId = ((await res.json()) as any).recurring_item.id;

    let mutated = false;
    const racingDb = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async <T = unknown>(stmts: D1PreparedStatement[]) => {
        if (!mutated) {
          mutated = true;
          // Concurrent PATCH changes schedule fields while leaving revision and next_due_date intact.
          const patchRes = await api('PATCH', `/api/v2/recurring-items/${itemId}`, {
            interval_count: 7,
          });
          expect(patchRes.status).toBe(200);
        }
        return env.DB.batch<T>(stmts);
      },
    } as unknown as D1Database;

    const result = await runRecurringAutoSkip(racingDb, { todayIso: '2026-11-21' });
    expect(result).toEqual({
      status: 'ok',
      today: '2026-11-21',
      rulesChecked: 1,
      rulesAdvanced: 0,
      periodsSkipped: 0,
      rulesDeactivated: 0,
    });

    const row = await env.DB.prepare(
      'SELECT next_due_date, interval_count FROM recurring_items WHERE id = ?',
    ).bind(itemId).first<{ next_due_date: string; interval_count: number }>();
    expect(row).toEqual({ next_due_date: '2026-11-19', interval_count: 7 });

    const fulfillments = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM recurring_period_fulfillments WHERE recurring_item_id = ?',
    ).bind(itemId).first<{ n: number }>();
    expect(fulfillments?.n).toBe(0);
  });
});

describe('MCP parity and backup compatibility', () => {
  it('supports recurring_item_add, recurring_item_update, recurring_items_list, and snapshot conflict detection', async () => {
    const accountId = await seedAccount();

    const invalidAdd = await callMcp('recurring_item_add', {
      title: 'Bad Days',
      amount_minor: -100,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-20',
      auto_skip_after_days: 0,
      idempotency_key: 'mcp-rec-add-bad',
    });
    expect(invalidAdd.result.isError).toBe(true);
    expect(invalidAdd.result.structuredContent.error).toContain('auto_skip_after_days');

    const addDone = await callMcp('recurring_item_add', {
      title: 'Daily Cigarettes',
      amount_minor: -500,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-20',
      auto_skip_overdue: true,
      auto_skip_after_days: 2,
      auto_confirm: true,
      idempotency_key: 'mcp-rec-add-ok',
    });
    expect(addDone.result.isError).not.toBe(true);
    const created = addDone.result.structuredContent.recurring_item;
    expect(created.auto_skip_overdue).toBe(true);
    expect(created.auto_skip_after_days).toBe(2);

    // Prepare Step-1 preview for update, then mutate auto_skip_after_days via REST to verify snapshot catches it
    const updatePreview = await callMcp('recurring_item_update', {
      recurring_item_id: created.id,
      auto_skip_overdue: false,
      idempotency_key: 'mcp-rec-upd-stale',
    });
    expect(updatePreview.result.structuredContent.resultType).toBe('input_required');

    await api('PATCH', `/api/v2/recurring-items/${created.id}`, { auto_skip_after_days: 5 });

    const staleConfirm = await callMcp('recurring_item_update', {
      recurring_item_id: created.id,
      auto_skip_overdue: false,
      idempotency_key: 'mcp-rec-upd-stale',
      requestState: updatePreview.result.structuredContent.requestState,
    });
    expect(staleConfirm.result.isError).toBe(true);
    expect(String(staleConfirm.result.structuredContent.error)).toContain(
      'the object changed after confirmation',
    );

    const freshUpdate = await callMcp('recurring_item_update', {
      recurring_item_id: created.id,
      auto_skip_overdue: true,
      auto_skip_after_days: 4,
      auto_confirm: true,
      idempotency_key: 'mcp-rec-upd-ok',
    });
    expect(freshUpdate.result.structuredContent.recurring_item.auto_skip_after_days).toBe(4);

    const listed = await callMcp('recurring_items_list', {}, ['read']);
    expect(listed.result.structuredContent.recurring_items[0]).toMatchObject({
      id: created.id,
      auto_skip_overdue: true,
      auto_skip_after_days: 4,
    });
  });

  it('exports new columns and accepts pre-0029 backups without auto_skip columns', async () => {
    const accountId = await seedAccount();
    await api('POST', '/api/v2/recurring-items', {
      title: 'Groceries',
      amount_minor: -1500,
      account_id: accountId,
      frequency: 'daily',
      next_due_date: '2026-11-20',
      auto_skip_overdue: true,
      auto_skip_after_days: 3,
    });

    const exported = await exportUserState(env.DB);
    expect(exported.tables.recurring_items[0]).toMatchObject({
      auto_skip_overdue: 1,
      auto_skip_after_days: 3,
    });

    const legacyTables = Object.fromEntries(USER_TABLES.map((t) => [t, [] as Record<string, unknown>[]]));
    legacyTables.settings = [{ key: 'low_balance_threshold_minor', value: '0' }];
    legacyTables.accounts = [
      {
        id: 1,
        name: 'Main',
        bank: null,
        type: null,
        owner: 'Alex',
        country: 'US',
        currency: 'USD',
        balance_minor: 1000,
        balance_updated_at: '2026-11-01T00:00:00Z',
        sort: 1,
        archived: 0,
        account_number: null,
      },
    ];
    legacyTables.recurring_items = [
      {
        id: 10,
        title: 'Legacy Rule',
        amount_minor: -500,
        currency: 'USD',
        account_id: 1,
        category: null,
        frequency: 'daily',
        interval_count: 1,
        day_of_month: null,
        month_of_year: null,
        next_due_date: '2026-11-20',
        active: 1,
        end_date: null,
        revision: null,
      },
    ];

    const parsed = parseBackupDocument({
      confirm: true,
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exported_at: '2026-11-21T00:00:00Z',
      tables: legacyTables,
    });
    expect(parsed.tables.recurring_items[0]).toMatchObject({
      auto_skip_overdue: 0,
      auto_skip_after_days: 1,
    });

    expect(() =>
      parseBackupDocument({
        confirm: true,
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: '2026-11-21T00:00:00Z',
        tables: {
          ...legacyTables,
          recurring_items: [
            { ...legacyTables.recurring_items[0], auto_skip_after_days: 0 },
          ],
        },
      }),
    ).toThrow();
  });
});

describe('RecurringItemForm SSR rendering for auto-skip and InfoToggletip', () => {
  const accounts = [{ id: 1, name: 'Main USD', currency: 'USD', archived: 0 }];

  it('renders unchecked by default without numeric delay input, and shows InfoToggletip attributes', () => {
    const Form = RecurringItemForm as unknown as React.ComponentType<Record<string, unknown>>;
    const html = renderToStaticMarkup(
      React.createElement(Form, {
        accounts,
        submitLabel: 'Create',
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );

    expect(html).toContain('recurring-auto-skip-box');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain(i18n.t('data.recurring.fieldAutoSkipAfterDays'));
    expect(html).toMatch(/popovertarget=/i);
    expect(html).toMatch(/popovertargetaction="show"/i);
    expect(html).toContain('interestfor=');
    expect(html).toContain('popover="hint"');
    expect(html).toContain('role="tooltip"');
  });

  it('renders days input when auto_skip_overdue is enabled on an edited rule', () => {
    const Form = RecurringItemForm as unknown as React.ComponentType<Record<string, unknown>>;
    const html = renderToStaticMarkup(
      React.createElement(Form, {
        initial: {
          id: 5,
          title: 'Daily Food',
          amount_minor: -1000,
          currency: 'USD',
          account_id: 1,
          category: 'Food',
          frequency: 'daily',
          interval_count: 1,
          day_of_month: null,
          month_of_year: null,
          next_due_date: '2026-11-20',
          end_date: null,
          active: true,
          auto_skip_overdue: true,
          auto_skip_after_days: 3,
        },
        accounts,
        submitLabel: 'Save',
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );

    expect(html).toContain('checked=""');
    expect(html).toContain(i18n.t('data.recurring.fieldAutoSkipAfterDays'));
    expect(html).toContain('min="1" max="365" value="3"');
  });
});
