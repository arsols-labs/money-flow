import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { BACKUP_VERSION } from '../src/worker/backup';
import { BUILTIN_TEMPLATES } from '../src/shared/statement-import/templates';
import { templateFromMapping } from '../src/ui/statementImportState.js';

let cookie: string;

beforeAll(async () => {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM statement_templates').run();
});

async function api(method: string, path: string, body?: unknown, withCookie = true): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(withCookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env as unknown as Env);
}

function userTemplate(id = 'my-bank', label = 'My bank') {
  return templateFromMapping({
    id,
    label,
    mapping: { date: 'Date', amount: 'Amount', description: 'Description' },
    options: {
      delimiter: ',',
      decimalSeparator: '.',
      dateFormat: 'MM/DD/YYYY',
      encoding: 'utf-8',
      hasHeader: true,
      defaultCurrency: 'USD',
    },
  });
}

describe('statement template API', () => {
  it('requires a session', async () => {
    const res = await api('GET', '/api/v2/statement-templates', undefined, false);
    expect(res.status).toBe(401);
  });

  it('lists built-ins as read-only and stores a user template', async () => {
    const listed = await api('GET', '/api/v2/statement-templates');
    expect(listed.status).toBe(200);
    const body = await listed.json() as { templates: Array<{ source: string; readonly: boolean; document: { id: string } }> };
    expect(body.templates.filter((row) => row.source === 'builtin').map((row) => row.document.id)).toEqual(['us-bofa', 'us-bofa-pdf', 'rs-bps', 'rs-bps-pdf']);
    expect(body.templates.filter((row) => row.source === 'builtin').every((row) => row.readonly)).toBe(true);

    const created = await api('POST', '/api/v2/statement-templates', userTemplate());
    expect(created.status).toBe(201);
    const again = await api('POST', '/api/v2/statement-templates', userTemplate());
    expect(again.status).toBe(409);
    const reserved = await api('POST', '/api/v2/statement-templates', userTemplate('us-bofa', 'Copy'));
    expect(reserved.status).toBe(409);
    const invalid = await api('POST', '/api/v2/statement-templates', { schemaVersion: 1, id: 'bad', label: 'Bad', format: 'csv', extra: true });
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json() as { error: { code: string; params: { detail: string } } };
    expect(invalidBody.error.code).toBe('TEMPLATE_INVALID');
    expect(invalidBody.error.params.detail).toMatch(/\/extra/);

    const renamed = await api('PATCH', '/api/v2/statement-templates/my-bank', { label: 'Renamed bank' });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json() as { document: { label: string; id: string } };
    expect(renamedBody.document).toMatchObject({ id: 'my-bank', label: 'Renamed bank' });

    const builtinPatch = await api('PATCH', '/api/v2/statement-templates/us-bofa', { label: 'Nope' });
    expect(builtinPatch.status).toBe(403);
    const builtinDelete = await api('DELETE', '/api/v2/statement-templates/rs-bps');
    expect(builtinDelete.status).toBe(403);

    const presets = await api('GET', '/api/v2/statement-imports/presets');
    const presetBody = await presets.json() as { presets: Array<{ id: string; source: string }> };
    expect(presetBody.presets.map((preset) => preset.id)).toEqual(['us-bofa', 'us-bofa-pdf', 'rs-bps', 'rs-bps-pdf', 'my-bank']);
    expect(presetBody.presets.find((preset) => preset.id === 'my-bank')?.source).toBe('user');

    const removed = await api('DELETE', '/api/v2/statement-templates/my-bank');
    expect(removed.status).toBe(200);
    expect((await api('GET', '/api/v2/statement-templates/my-bank')).status).toBe(404);
    expect((await api('GET', '/api/v2/statement-templates/us-bofa')).status).toBe(200);
  });

  it('reuses a saved column mapping as the preset for a later preview', async () => {
    const document = userTemplate('saved-map', 'Saved map');
    expect((await api('POST', '/api/v2/statement-templates', document)).status).toBe(201);
    const preview = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{
        filename: 'saved.csv',
        preset_id: 'saved-map',
        content: 'Date,Description,Amount\n03/04/2026,ACME COFFEE,-12.45\n',
      }],
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const body = await preview.json() as {
      files: Array<{ statements: Array<{ rows: Array<{ date: string; amount_minor: number; currency: string }> }> }>;
    };
    expect(body.files[0]?.statements[0]?.rows[0]).toMatchObject({
      date: '2026-03-04',
      amount_minor: -1245,
      currency: 'USD',
    });
  });

  it('previews a preamble with a user template and with generic mapping, and reports a mapping that reads nothing', async () => {
    const preamble = [
      'Bank of America',
      'Synthetic statement',
      'Account number,0000',
      'From,03/01/2026',
      'Through,03/31/2026',
      'Note,preamble',
      'Date,Description,Amount,Running Bal.',
      '03/04/2026,"ACME COFFEE","-12.45","100.00"',
      '03/10/2026,"DEMO PAYROLL","500.00","600.00"',
    ].join('\n');
    const document = userTemplate('preamble-boa', 'Preamble BoA');
    document.csv!.options.dateFormat = 'MM/DD/YYYY';
    expect((await api('POST', '/api/v2/statement-templates', document)).status).toBe(201);
    const preview = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'preamble.csv', preset_id: 'preamble-boa', content: preamble }],
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const rows = ((await preview.json()) as {
      files: Array<{ statements: Array<{ rows: Array<{ date: string; amount_minor: number; currency: string; kind: string; description: string }> }> }>;
    }).files[0]!.statements[0]!.rows;
    expect(rows.map((row) => [row.date, row.amount_minor, row.currency])).toEqual([
      ['2026-03-04', -1245, 'USD'],
      ['2026-03-10', 50000, 'USD'],
    ]);

    const generic = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{
        filename: 'generic.csv',
        format: 'csv',
        content: preamble,
        mapping: { date: 'Date', amount: 'Amount', description: 'Description' },
        options: {
          delimiter: ',',
          decimal_separator: '.',
          date_format: 'MM/DD/YYYY',
          encoding: 'utf-8',
          has_header: true,
          default_currency: 'USD',
          header_search: true,
        },
      }],
    });
    expect(generic.status, await generic.clone().text()).toBe(200);
    const genericRows = ((await generic.json()) as {
      files: Array<{ statements: Array<{ rows: unknown[] }> }>;
    }).files[0]!.statements[0]!.rows;
    expect(genericRows).toHaveLength(2);

    const bare = userTemplate('no-currency', 'No currency');
    bare.csv.options = {
      delimiter: ',',
      decimalSeparator: '.',
      dateFormat: 'MM/DD/YYYY',
      encoding: 'utf-8',
      hasHeader: true,
    };
    expect((await api('POST', '/api/v2/statement-templates', bare)).status).toBe(201);
    const failed = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'noccy.csv', preset_id: 'no-currency', content: preamble }],
    });
    expect(failed.status).toBe(400);
    const error = await failed.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe('IMPORT_CURRENCY_REQUIRED');
    expect(error.error.message).toMatch(/choose a target account in the preview/i);
    expect(error.error.message).toMatch(/set the currency in the template/i);

    const account = await api('POST', '/api/v2/accounts', {
      name: 'Preamble checking',
      currency: 'USD',
      owner: 'Tester',
      country: 'USA',
      balance_minor: 0,
    });
    expect(account.status).toBe(201);
    const accountId = ((await account.json()) as { account: { id: number } }).account.id;
    const committed = await api('POST', '/api/v2/statement-imports', {
      idempotency_key: 'preamble-boa-commit',
      category_mode: 'manual',
      file_count: 1,
      files: [{ filename: 'preamble.csv', preset_id: 'preamble-boa' }],
      rows: rows.map((row) => ({
        include: true,
        account_id: accountId,
        date: row.date,
        amount_minor: row.amount_minor,
        currency: row.currency,
        kind: row.kind,
        item: row.description,
        statement_description: row.description,
      })),
    });
    expect(committed.status, await committed.clone().text()).toBe(201);
    const committedBody = await committed.json() as { written: boolean; batch: { row_count: number } };
    expect(committedBody.written).toBe(true);
    expect(committedBody.batch.row_count).toBe(2);

    const fromAccount = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{
        filename: 'noccy.csv',
        preset_id: 'no-currency',
        content: preamble,
        account_id: accountId,
      }],
    });
    expect(fromAccount.status, await fromAccount.clone().text()).toBe(200);
    const accountRows = ((await fromAccount.json()) as {
      files: Array<{ statements: Array<{ rows: Array<{ currency: string; currency_from_account: boolean; amount_minor: number }> }> }>;
    }).files[0]!.statements[0]!.rows;
    expect(accountRows.map((row) => [row.amount_minor, row.currency, row.currency_from_account])).toEqual([
      [-1245, 'USD', true],
      [50000, 'USD', true],
    ]);
    const omittedCurrency = await api('POST', '/api/v2/statement-imports', {
      idempotency_key: 'noccy-from-account',
      category_mode: 'manual',
      file_count: 1,
      files: [{ filename: 'noccy.csv', preset_id: 'no-currency' }],
      rows: accountRows.map((row) => ({
        include: true,
        account_id: accountId,
        date: '2026-03-04',
        amount_minor: row.amount_minor,
        kind: row.amount_minor < 0 ? 'expense' : 'income',
        item: 'From account',
        statement_description: 'From account',
      })),
    });
    expect(omittedCurrency.status, await omittedCurrency.clone().text()).toBe(201);
  });

  it('keeps skipRows and headerSearch false through save, export, and import', async () => {
    const document = templateFromMapping({
      id: 'skip-search',
      label: 'Skip search',
      mapping: { date: 'Date', amount: 'Amount', description: 'Description' },
      options: {
        delimiter: ',',
        decimalSeparator: '.',
        dateFormat: 'MM/DD/YYYY',
        encoding: 'utf-8',
        hasHeader: true,
        defaultCurrency: 'USD',
        headerSearch: false,
        skipRows: 4,
      },
    });
    const savedOptions = document.csv?.options as { skipRows?: number; headerSearch?: boolean };
    expect(savedOptions.skipRows).toBe(4);
    expect(savedOptions.headerSearch).toBe(false);
    expect((await api('POST', '/api/v2/statement-templates', document)).status).toBe(201);
    const exported = await api('GET', '/api/v2/statement-templates/skip-search');
    expect(exported.status).toBe(200);
    const stored = ((await exported.json()) as {
      document: { csv?: { options?: { skipRows?: number; headerSearch?: boolean } } };
    }).document;
    expect(stored.csv?.options?.skipRows).toBe(4);
    expect(stored.csv?.options?.headerSearch).toBe(false);
    expect((await api('DELETE', '/api/v2/statement-templates/skip-search')).status).toBe(200);
    expect((await api('POST', '/api/v2/statement-templates', stored)).status).toBe(201);
    const imported = await api('GET', '/api/v2/statement-templates/skip-search');
    const again = ((await imported.json()) as {
      document: { csv?: { options?: { skipRows?: number; headerSearch?: boolean } } };
    }).document;
    expect(again.csv?.options).toMatchObject({ skipRows: 4, headerSearch: false });
  });

  it('round-trips templates in a version 2 backup and still imports a version 1 backup', async () => {
    expect((await api('POST', '/api/v2/statement-templates', userTemplate())).status).toBe(201);
    const exported = await api('GET', '/api/v2/backup/export');
    expect(exported.status).toBe(200);
    const dump = await exported.json() as {
      version: number;
      tables: { statement_templates: Array<{ template_id: string; document: string }> };
    };
    expect(dump.version).toBe(BACKUP_VERSION);
    expect(dump.tables.statement_templates.map((row) => row.template_id)).toEqual(['my-bank']);
    expect(JSON.parse(dump.tables.statement_templates[0]!.document).label).toBe('My bank');

    await api('DELETE', '/api/v2/statement-templates/my-bank');
    const legacy = structuredClone(dump) as {
      version: number;
      tables: Record<string, unknown>;
    };
    legacy.version = 1;
    delete legacy.tables.statement_templates;
    const legacyImport = await api('POST', '/api/v2/backup/import', { ...legacy, confirm: true });
    expect(legacyImport.status, await legacyImport.clone().text()).toBe(200);
    const afterLegacy = await env.DB.prepare('SELECT COUNT(*) AS n FROM statement_templates').first<{ n: number }>();
    expect(afterLegacy?.n).toBe(0);

    const restored = await api('POST', '/api/v2/backup/import', { ...dump, confirm: true });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const got = await api('GET', '/api/v2/statement-templates/my-bank');
    expect(got.status).toBe(200);
    const gotBody = await got.json() as { source: string; document: { label: string } };
    expect(gotBody.source).toBe('user');
    expect(gotBody.document.label).toBe('My bank');
  });
});

describe('statement templates on the demo ledger', () => {
  const ORIGIN = 'https://demo.example';

  function bindings(): Env {
    const real = env as unknown as Env;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'DEMO_MODE') return '1';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Env;
  }

  async function demoFetch(path: string, init: RequestInit = {}, session?: string): Promise<Response> {
    const headers = new Headers(init.headers);
    if (session) headers.set('Cookie', session);
    return app.request(`${ORIGIN}${path}`, { ...init, headers }, bindings());
  }

  it('creates, renames, and deletes a template without writing shared D1', async () => {
    const real = env as unknown as Env;
    const before = await real.DB.prepare('SELECT COUNT(*) AS n FROM statement_templates').first<{ n: number }>();
    const createdAccount = await demoFetch('/api/v2/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Template Checking',
        currency: 'USD',
        owner: 'Household',
        country: 'USA',
        balance_minor: 0,
      }),
    });
    expect(createdAccount.status, await createdAccount.clone().text()).toBe(201);
    const session = createdAccount.headers.getSetCookie().find((item) => item.startsWith('mf_demo_sid='))!.split(';')[0]!;
    const document = userTemplate('demo-bank', 'Demo bank');
    const created = await demoFetch('/api/v2/statement-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(document),
    }, session);
    expect(created.status, await created.clone().text()).toBe(201);
    const renamed = await demoFetch('/api/v2/statement-templates/demo-bank', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Demo renamed' }),
    }, session);
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const listed = await demoFetch('/api/v2/statement-templates', {}, session);
    const listBody = await listed.json() as { templates: Array<{ source: string; document: { id: string; label: string } }> };
    expect(listBody.templates.filter((row) => row.source === 'user').map((row) => row.document.label)).toEqual(['Demo renamed']);
    expect(listBody.templates.filter((row) => row.source === 'builtin')).toHaveLength(BUILTIN_TEMPLATES.length);
    const removed = await demoFetch('/api/v2/statement-templates/demo-bank', { method: 'DELETE' }, session);
    expect(removed.status).toBe(200);
    const after = await real.DB.prepare('SELECT COUNT(*) AS n FROM statement_templates').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

function pacedCsv(count: number): string {
  const lines = ['Date,Description,Amount,Running Bal.'];
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 27) + 1).padStart(2, '0');
    const minor = -((index % 9) + 1);
    lines.push(`03/${day}/2026,"ROW ${index}","${minor}.00",`);
  }
  return lines.join('\n');
}

async function expectUserTemplateCommit(
  request: (path: string, body: unknown) => Promise<Response>,
  count: number,
  boundMs: number,
) {
  const account = await request('/api/v2/accounts', {
    name: `Pace ${count}`,
    currency: 'USD',
    owner: 'Household',
    country: 'USA',
    balance_minor: 50_000_000,
  });
  expect(account.status, await account.clone().text()).toBe(201);
  const accountId = ((await account.json()) as { account: { id: number } }).account.id;
  const document = userTemplate(`pace-${count}`, `Pace ${count}`);
  expect((await request('/api/v2/statement-templates', document)).status).toBe(201);
  const started = performance.now();
  const preview = await request('/api/v2/statement-imports/preview', {
    category_mode: 'manual',
    files: [{
      filename: 'pace.csv',
      preset_id: `pace-${count}`,
      content: pacedCsv(count),
      account_id: accountId,
    }],
  });
  expect(preview.status, await preview.clone().text()).toBe(200);
  const rows = ((await preview.json()) as {
    files: Array<{ statements: Array<{ rows: Array<Record<string, unknown>> }> }>;
  }).files[0]!.statements[0]!.rows;
  expect(rows).toHaveLength(count);
  const committed = await request('/api/v2/statement-imports', {
    idempotency_key: `pace-${count}`,
    category_mode: 'manual',
    file_count: 1,
    files: [{ filename: 'pace.csv', preset_id: `pace-${count}` }],
    rows: rows.map((row) => ({
      include: true,
      account_id: accountId,
      date: row.date,
      amount_minor: row.amount_minor,
      currency: row.currency,
      kind: row.kind,
      item: row.description,
      statement_description: row.description,
      fingerprint: row.fingerprint,
    })),
  });
  const elapsed = performance.now() - started;
  expect(committed.status, await committed.clone().text()).toBe(201);
  expect(elapsed, `user template commit of ${count} rows`).toBeLessThan(boundMs);
}

describe('user template commit pace', () => {
  it('commits 118 and 2000 rows through a user template on D1', async () => {
    const request = (path: string, body: unknown) => api('POST', path, body);
    await expectUserTemplateCommit(request, 118, 8_000);
    await expectUserTemplateCommit(request, 2000, 20_000);
  }, 60_000);

  it('commits 118 and 2000 rows through a user template on the demo ledger', async () => {
    const real = env as unknown as Env;
    const before = await real.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    const demo = new Proxy(real, {
      get(target, prop) {
        if (prop === 'DEMO_MODE') return '1';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Env;
    let session = '';
    const request = async (path: string, body: unknown) => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (session) headers.set('Cookie', session);
      const response = await app.request(`https://demo.example${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, demo);
      const cookie = response.headers.getSetCookie().find((item) => item.startsWith('mf_demo_sid='));
      if (cookie) session = cookie.split(';')[0]!;
      return response;
    };
    await expectUserTemplateCommit(request, 118, 8_000);
    await expectUserTemplateCommit(request, 2000, 20_000);
    const after = await real.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  }, 60_000);
});
