import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { statementImportLedgerGuard } from '../src/worker/statement-import';
import { IMPORT_UNDO_PHRASE, STATEMENT_IMPORT_MAX_FILE_BYTES, STATEMENT_IMPORT_MAX_ROWS } from '../src/shared/statement-import/types';
import { rowsFromPreview } from '../src/ui/statementImportState';
import { bpsLine, syntheticBpsWorkbook } from './statement-parsers.test';

let cookie: string;

beforeAll(async () => {
  const setCookie = await createSessionCookie(env as unknown as Env, false);
  cookie = setCookie.split(';')[0]!;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM category_rules'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM import_batches'),
    env.DB.prepare('DELETE FROM account_aliases'),
    env.DB.prepare('DELETE FROM pending_account_strings'),
    env.DB.prepare('DELETE FROM accounts'),
  ]);
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

async function createAccount(overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/v2/accounts', {
    name: 'Checking',
    currency: 'USD',
    owner: 'Tester',
    country: 'USA',
    balance_minor: 0,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json() as { account: { id: number; balance_minor: number; currency: string } }).account;
}

const BOFA = [
  'Date,Description,Amount,Running Bal.',
  '03/04/2026,"ACME COFFEE","-12.45","100.00"',
].join('\n');

describe('statement import API', () => {
  it('requires a session', async () => {
    const res = await api('POST', '/api/v2/statement-imports/preview', { category_mode: 'manual', files: [] }, false);
    expect(res.status).toBe(401);
  });

  it('lists presets', async () => {
    const res = await api('GET', '/api/v2/statement-imports/presets');
    expect(res.status).toBe(200);
    const body = await res.json() as { presets: Array<{ id: string }> };
    expect(body.presets.map((preset) => preset.id)).toEqual(['us-bofa', 'us-bofa-pdf', 'rs-bps', 'rs-bps-pdf']);
  });

  it('matches an alias, flags a currency mismatch, and applies both category modes', async () => {
    const usd = await createAccount({ name: 'US checking', currency: 'USD' });
    const eur = await createAccount({ name: 'Euro', currency: 'EUR', country: 'DEU' });
    await api('POST', `/api/v2/accounts/${usd.id}/aliases`, { alias_text: 'SYNTH-ACCT' });
    await api('POST', '/api/v2/category-rules', {
      pattern: 'acme coffee',
      match_field: 'description',
      category: 'Coffee',
      subcategory: 'Cafe',
      priority: 10,
    });

    const manual = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'bofa.csv', preset_id: 'us-bofa', content: BOFA, account_hint: 'synth-acct' }],
    });
    expect(manual.status).toBe(200);
    const manualBody = await manual.json() as {
      files: Array<{ statements: Array<{ match: string; account_id: number; rows: Array<Record<string, unknown>> }> }>;
    };
    const manualRow = manualBody.files[0]!.statements[0]!;
    expect(manualRow.match).toBe('alias');
    expect(manualRow.account_id).toBe(usd.id);
    expect(manualRow.rows[0]!.proposed_category).toBeNull();
    expect(manualRow.rows[0]!.currency_mismatch).toBe(false);

    const rules = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'rules',
      files: [{ filename: 'bofa.csv', preset_id: 'us-bofa', content: BOFA, account_id: usd.id }],
    });
    const rulesRow = ((await rules.json()) as {
      files: Array<{ statements: Array<{ rows: Array<Record<string, unknown>> }> }>;
    }).files[0]!.statements[0]!.rows[0]!;
    expect(rulesRow.proposed_category).toBe('Coffee');
    expect(rulesRow.proposed_subcategory).toBe('Cafe');

    const mismatch = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{
        filename: 'eur.csv',
        format: 'csv',
        content: 'Date,Description,Amount,Currency\n2026-03-04,TEST SHOP,-3.50,EUR\n',
        mapping: { date: 'Date', description: 'Description', amount: 'Amount', currency: 'Currency' },
        options: { delimiter: ',', decimal_separator: '.', date_format: 'YYYY-MM-DD', encoding: 'utf-8' },
        account_id: usd.id,
      }],
    });
    const mismatchRow = ((await mismatch.json()) as {
      files: Array<{ statements: Array<{ rows: Array<Record<string, unknown>> }> }>;
    }).files[0]!.statements[0]!.rows[0]!;
    expect(mismatchRow.currency_mismatch).toBe(true);

    const iban = `<?xml version="1.0"?>
<Document><BkToCstmrStmt><Stmt>
  <Acct><Id><IBAN>DE89 3704 0044 0532 0130 00</IBAN></Id><Ccy>EUR</Ccy></Acct>
  <Ntry>
    <Amt Ccy="EUR">3.50</Amt><CdtDbtInd>DBIT</CdtDbtInd>
    <BookgDt><Dt>2026-03-09</Dt></BookgDt>
    <AcctSvcrRef>SYNTH-CAMT-1</AcctSvcrRef>
    <NtryDtls><TxDtls><RmtInf><Ustrd>TEST FEE</Ustrd></RmtInf></TxDtls></NtryDtls>
  </Ntry>
</Stmt></BkToCstmrStmt></Document>`;
    await env.DB.prepare('UPDATE accounts SET account_number = ? WHERE id = ?')
      .bind('DE89370400440532013000', eur.id).run();
    const matched = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'camt.xml', format: 'camt053', content: iban }],
    });
    const camtStatement = ((await matched.json()) as {
      files: Array<{ statements: Array<Record<string, unknown>> }>;
    }).files[0]!.statements[0]!;
    expect(camtStatement.match).toBe('iban');
    expect(camtStatement.account_id).toBe(eur.id);
    expect((camtStatement.rows as Array<Record<string, unknown>>)[0]!.currency_mismatch).toBe(false);
  });

  it('flags bank-id duplicates and expense duplicates, including inside the batch', async () => {
    const account = await createAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, amount_minor, source, bank_transaction_id)
       VALUES ('2026-03-04', ?, 'expense', 'ACME', 'Existing card', -1245, 'manual', 'FIT-1')`,
    ).bind(account.id).run();
    const ofx = `<OFX><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>X
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260304<TRNAMT>-12.45<FITID>FIT-1<NAME>ACME<MEMO>different text</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260305<TRNAMT>-4.00<FITID>FIT-9<NAME>ACME<MEMO>one</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260305<TRNAMT>-4.00<FITID>FIT-9<NAME>ACME<MEMO>two</STMTTRN>
</STMTRS></OFX>`;
    const res = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'stmt.ofx', format: 'ofx', content: ofx, account_id: account.id }],
    });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as {
      files: Array<{ statements: Array<{ rows: Array<Record<string, unknown>> }> }>;
    }).files[0]!.statements[0]!.rows;
    expect(rows[0]!.duplicate).toBe(true);
    expect(rows[0]!.duplicate_reason).toBe('bank_transaction_id');
    expect(rows[1]!.duplicate).toBe(false);
    expect(rows[2]!.duplicate_in_batch).toBe(true);
    expect(rows[2]!.duplicate_reason).toBe('bank_transaction_id');

    const expense = await api('POST', '/api/v2/operations', {
      date: '2026-03-20',
      account_id: account.id,
      kind: 'expense',
      item: 'Manual coffee',
      store: 'ACME COFFEE',
      amount_minor: -1245,
    });
    expect(expense.status).toBe(201);
    const csv = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{
        filename: 'dup.csv',
        format: 'csv',
        content: 'Date,Merchant,Amount\n03/20/2026,ACME COFFEE,-12.45\n',
        mapping: { date: 'Date', merchant: 'Merchant', amount: 'Amount' },
        options: {
          delimiter: ',',
          decimal_separator: '.',
          date_format: 'MM/DD/YYYY',
          default_currency: 'USD',
        },
        account_id: account.id,
      }],
    });
    const dupRow = ((await csv.json()) as {
      files: Array<{ statements: Array<{ rows: Array<Record<string, unknown>> }> }>;
    }).files[0]!.statements[0]!.rows[0]!;
    expect(dupRow.duplicate_reason).toBe('expense_duplicate');
    expect(dupRow.duplicate_of_operation_id).toEqual(expect.any(Number));
  });

  it('commits atomically, replays the idempotency key, and skips a second import', async () => {
    const account = await createAccount({ balance_minor: 10_000 });
    const preview = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'bofa.csv', preset_id: 'us-bofa', content: BOFA, account_id: account.id }],
    });
    const row = ((await preview.json()) as {
      files: Array<{ statements: Array<{ rows: Array<Record<string, unknown>> }> }>;
    }).files[0]!.statements[0]!.rows[0]!;
    const payload = {
      idempotency_key: 'synthetic-import-1',
      category_mode: 'manual',
      file_count: 1,
      rows: [{
        include: true,
        account_id: account.id,
        date: row.date,
        amount_minor: row.amount_minor,
        currency: row.currency,
        kind: row.kind,
        item: row.description,
        statement_description: row.description,
        fingerprint: row.fingerprint,
        bank_transaction_id: row.bank_transaction_id,
      }],
    };
    const first = await api('POST', '/api/v2/statement-imports', payload);
    expect(first.status).toBe(201);
    const created = await first.json() as { written: boolean; batch: { id: number }; inserted: unknown[] };
    expect(created.written).toBe(true);
    expect(created.inserted).toHaveLength(1);
    const balance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
      .bind(account.id).first<{ balance_minor: number }>();
    expect(balance?.balance_minor).toBe(10_000 - 1245);
    const stored = await env.DB.prepare(
      'SELECT import_batch_id, source FROM operations WHERE import_fingerprint = ?',
    ).bind(row.fingerprint).first<{ import_batch_id: number; source: string }>();
    expect(stored).toEqual({ import_batch_id: created.batch.id, source: 'manual' });

    const replay = await api('POST', '/api/v2/statement-imports', payload);
    expect(replay.status).toBe(200);
    const replayed = await replay.json() as { idempotent_replay: boolean; written: boolean };
    expect(replayed.idempotent_replay).toBe(true);
    expect(replayed.written).toBe(false);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(count?.n).toBe(1);

    const again = await api('POST', '/api/v2/statement-imports', {
      ...payload,
      idempotency_key: 'synthetic-import-2',
    });
    expect(again.status).toBe(200);
    const skipped = await again.json() as { written: boolean; skipped: unknown[]; batch: null };
    expect(skipped.written).toBe(false);
    expect(skipped.batch).toBeNull();
    expect(skipped.skipped).toHaveLength(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>())?.n).toBe(1);

    const bad = await api('POST', '/api/v2/statement-imports', {
      idempotency_key: 'synthetic-import-bad',
      category_mode: 'manual',
      rows: [
        payload.rows[0],
        { ...payload.rows[0], account_id: 999999, fingerprint: null, statement_description: 'Other line' },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM import_batches').first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(8755);
  });

  it('rejects an over-size file and too many rows', async () => {
    const huge = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'big.csv', content: 'x'.repeat(STATEMENT_IMPORT_MAX_FILE_BYTES + 1) }],
    });
    expect(huge.status).toBe(400);
    expect((await huge.json() as { error: { code: string; params: { scope: string } } }).error.params.scope).toBe('file');

    const lines = ['Date,Description,Amount,Running Bal.'];
    for (let i = 0; i < STATEMENT_IMPORT_MAX_ROWS + 1; i += 1) {
      lines.push(`03/01/2026,ROW ${i},-1.00,`);
    }
    const many = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{
        filename: 'many.csv',
        preset_id: 'us-bofa',
        content: lines.join('\n'),
      }],
    });
    expect(many.status).toBe(400);
    expect((await many.json() as { error: { code: string; params: { scope: string } } }).error.params.scope).toBe('rows');
  });

  it('requires undo confirmation and restores balances', async () => {
    const account = await createAccount({ balance_minor: 5_000 });
    const preview = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'rules',
      files: [{ filename: 'bofa.csv', preset_id: 'us-bofa', content: BOFA, account_id: account.id }],
    });
    const row = ((await preview.json()) as {
      files: Array<{ statements: Array<{ rows: Array<Record<string, unknown>> }> }>;
    }).files[0]!.statements[0]!.rows[0]!;
    const committed = await api('POST', '/api/v2/statement-imports', {
      idempotency_key: 'undo-me',
      category_mode: 'manual',
      rows: [{
        account_id: account.id,
        date: row.date,
        amount_minor: row.amount_minor,
        currency: 'USD',
        kind: 'expense',
        item: 'ACME COFFEE',
        statement_description: row.description,
        fingerprint: row.fingerprint,
      }],
    });
    const batchId = ((await committed.json()) as { batch: { id: number } }).batch.id;
    expect((await api('POST', `/api/v2/statement-imports/${batchId}/undo`, {})).status).toBe(400);
    expect((await api('POST', `/api/v2/statement-imports/${batchId}/undo`, { confirm: true, phrase: 'RESET' })).status).toBe(400);
    const undone = await api('POST', `/api/v2/statement-imports/${batchId}/undo`, {
      confirm: true,
      phrase: IMPORT_UNDO_PHRASE,
    });
    expect(undone.status).toBe(200);
    expect((await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(account.id).first<{ balance_minor: number }>())?.balance_minor).toBe(5_000);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>())?.n).toBe(0);
    const again = await api('POST', `/api/v2/statement-imports/${batchId}/undo`, {
      confirm: true,
      phrase: IMPORT_UNDO_PHRASE,
    });
    expect(again.status).toBe(409);
  });

  it('rolls back a batch when the ledger guard fails', async () => {
    const account = await createAccount({ balance_minor: 100 });
    await expect(env.DB.batch([
      env.DB.prepare(
        `INSERT INTO import_batches (idempotency_key, category_mode, status, file_count, row_count, created_at)
         VALUES ('guard-test', 'manual', 'committed', 1, 1, '2026-03-04T00:00:00Z')`,
      ),
      env.DB.prepare('UPDATE accounts SET balance_minor = balance_minor + 1 WHERE id = ?')
        .bind(-1),
      statementImportLedgerGuard(env.DB, 1),
    ])).rejects.toThrow();
    const batches = await env.DB.prepare('SELECT COUNT(*) AS n FROM import_batches').first<{ n: number }>();
    const balance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
      .bind(account.id).first<{ balance_minor: number }>();
    expect(batches?.n).toBe(0);
    expect(balance?.balance_minor).toBe(100);
  });

  it('commits more than five BoA rows and keeps the exact balance', async () => {
    const account = await createAccount({ balance_minor: 5_000_000 });
    const lines = ['Date,Description,Amount,Running Bal.'];
    let expected = 5_000_000;
    for (let i = 0; i < 120; i += 1) {
      const minor = -((i % 7) + 1) * 100;
      expected += minor;
      const major = (minor / 100).toFixed(2);
      const day = String((i % 27) + 1).padStart(2, '0');
      lines.push(`03/${day}/2026,"ROW ${i}","${major}",`);
    }
    const preview = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [{ filename: 'many.csv', preset_id: 'us-bofa', content: lines.join('\n'), account_id: account.id }],
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const rows = previewRows(await preview.json() as PreviewBody);
    expect(rows).toHaveLength(120);
    const committed = await api('POST', '/api/v2/statement-imports', {
      idempotency_key: 'many-rows',
      category_mode: 'manual',
      file_count: 1,
      rows: rows.map((row) => ({
        include: true,
        account_id: account.id,
        date: row.date,
        amount_minor: row.amount_minor,
        currency: row.currency,
        kind: row.kind,
        item: row.description,
        statement_description: row.description,
        fingerprint: row.fingerprint,
      })),
    });
    expect(committed.status, await committed.clone().text()).toBe(201);
    const balance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?')
      .bind(account.id).first<{ balance_minor: number }>();
    expect(balance?.balance_minor).toBe(expected);
  });
});

type PreviewBody = {
  files: Array<{
    filename?: string;
    preset_id?: string | null;
    statements: Array<{ rows: Array<Record<string, unknown>> }>;
  }>;
};

function previewRows(body: PreviewBody) {
  return body.files.flatMap((file) => file.statements.flatMap((statement) => statement.rows));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function commitFromPreview(accountId: number, rows: Array<Record<string, unknown>>, key: string, filename: string, presetId: string) {
  return {
    idempotency_key: key,
    category_mode: 'manual',
    file_count: 1,
    files: [{ filename, preset_id: presetId }],
    rows: rows.map((row) => ({
      include: true,
      account_id: accountId,
      date: row.date,
      amount_minor: row.amount_minor,
      currency: row.currency,
      kind: row.kind,
      item: row.description,
      statement_description: row.description,
      bank_transaction_id: row.bank_transaction_id,
    })),
  };
}

describe('statement import duplicate re-preview', () => {
  const twoRows = [
    'Date,Description,Amount,Running Bal.',
    '03/04/2026,"ACME COFFEE","-12.45","87.55"',
    '03/05/2026,"DEMO SHOP","-3.00","84.55"',
  ].join('\n');

  async function importThenPreviewAgain(file: Record<string, unknown>, accountId: number, key: string, filename: string, presetId: string) {
    const first = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [file],
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json() as PreviewBody;
    const rows = previewRows(firstBody);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.duplicate === false)).toBe(true);
    const committed = await api('POST', '/api/v2/statement-imports', commitFromPreview(accountId, rows, key, filename, presetId));
    expect(committed.status, await committed.clone().text()).toBe(201);
    const created = await committed.json() as { batch: { id: number; files: Array<{ filename: string; preset_id: string }> }; inserted: unknown[] };
    expect(created.inserted).toHaveLength(rows.length);
    expect(created.batch.files).toEqual([{ filename, preset_id: presetId }]);

    const again = await api('POST', '/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [file],
    });
    expect(again.status).toBe(200);
    const againBody = await again.json() as PreviewBody;
    const againRows = previewRows(againBody);
    expect(againRows).toHaveLength(rows.length);
    expect(againRows.every((row) => row.duplicate === true)).toBe(true);
    expect(againRows.every((row) => row.duplicate_reason === 'fingerprint' || row.duplicate_reason === 'bank_transaction_id')).toBe(true);
    const uiRows = rowsFromPreview(againBody);
    expect(uiRows.every((row) => row.include === false)).toBe(true);

    const detail = await api('GET', `/api/v2/statement-imports/${created.batch.id}`);
    expect(detail.status).toBe(200);
    const loaded = await detail.json() as {
      batch: { status: string; files: Array<{ filename: string }> };
      operations: Array<{ date: string; description: string; amount_minor: number; currency: string; category: string | null }>;
    };
    expect(loaded.batch.status).toBe('committed');
    expect(loaded.operations).toHaveLength(rows.length);
    expect(loaded.operations.every((operation) => operation.date && operation.description && operation.currency)).toBe(true);
    expect(loaded.batch.files[0]?.filename).toBe(filename);
  }

  it('marks every BoA CSV row as a duplicate on a second preview without an account id', async () => {
    const account = await createAccount({ balance_minor: 50_000 });
    await importThenPreviewAgain(
      { filename: 'bofa.csv', preset_id: 'us-bofa', content: twoRows },
      account.id,
      'reimport-bofa',
      'bofa.csv',
      'us-bofa',
    );
  });

  it('marks every BPS xls row as a duplicate on a second preview without an account id', async () => {
    const account = await createAccount({ currency: 'RSD', country: 'SRB', balance_minor: 1_000_000 });
    const bytes = await syntheticBpsWorkbook([
      bpsLine('14/03/2026', '13/03/2026', 'RSD', '', '2,345.60', '123 - TEST MARKET 45>BEOGRAD            RS'),
      bpsLine('08/03/2026', '08/03/2026', 'RSD', '100.00', '', 'Pošiljalac: TEST ŠALTER'),
    ]);
    await importThenPreviewAgain(
      { filename: 'bps.xls', preset_id: 'rs-bps', format: 'xls', content_base64: bytesToBase64(bytes) },
      account.id,
      'reimport-bps',
      'bps.xls',
      'rs-bps',
    );
  });
});

describe('statement import on the demo ledger', () => {
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

  async function demoFetch(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    return app.request(`${ORIGIN}${path}`, { ...init, headers }, bindings());
  }

  it('imports a file into the session ledger and flags the same file on the next preview', async () => {
    const real = env as unknown as Env;
    const before = await real.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    const created = await demoFetch('/api/v2/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Import Checking',
        currency: 'USD',
        owner: 'Household',
        country: 'USA',
        balance_minor: 20_000,
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const cookie = created.headers.getSetCookie().find((item) => item.startsWith('mf_demo_sid='))!.split(';')[0]!;
    const accountId = ((await created.json()) as { account: { id: number } }).account.id;
    const file = {
      filename: 'bofa.csv',
      preset_id: 'us-bofa',
      content: 'Date,Description,Amount,Running Bal.\n03/04/2026,"ACME COFFEE","-12.45","100.00"\n',
    };
    const preview = await demoFetch('/api/v2/statement-imports/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_mode: 'manual', files: [file] }),
    }, cookie);
    expect(preview.status, await preview.clone().text()).toBe(200);
    const rows = previewRows(await preview.json() as PreviewBody);
    expect(rows.every((row) => row.duplicate === false)).toBe(true);
    const committed = await demoFetch('/api/v2/statement-imports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitFromPreview(accountId, rows, 'demo-reimport', 'bofa.csv', 'us-bofa')),
    }, cookie);
    expect(committed.status, await committed.clone().text()).toBe(201);
    const batchId = ((await committed.json()) as { batch: { id: number } }).batch.id;
    const detail = await demoFetch(`/api/v2/statement-imports/${batchId}`, {}, cookie);
    const loaded = await detail.json() as { operations: unknown[] };
    expect(loaded.operations.length).toBe(rows.length);

    const again = await demoFetch('/api/v2/statement-imports/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_mode: 'manual', files: [file] }),
    }, cookie);
    const againRows = previewRows(await again.json() as PreviewBody);
    expect(againRows.every((row) => row.duplicate === true)).toBe(true);
    expect(againRows.every((row) => row.duplicate_batch_id === batchId)).toBe(true);
    expect(rowsFromPreview({ files: [{ statements: [{ rows: againRows }] }] }).every((row) => row.include === false)).toBe(true);

    const after = await real.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('commits 120 rows on the demo ledger and keeps the exact balance', async () => {
    const real = env as unknown as Env;
    const before = await real.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    const created = await demoFetch('/api/v2/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Many Rows',
        currency: 'USD',
        owner: 'Household',
        country: 'USA',
        balance_minor: 5_000_000,
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const cookie = created.headers.getSetCookie().find((item) => item.startsWith('mf_demo_sid='))!.split(';')[0]!;
    const accountId = ((await created.json()) as { account: { id: number } }).account.id;
    const lines = ['Date,Description,Amount,Running Bal.'];
    let expected = 5_000_000;
    for (let i = 0; i < 120; i += 1) {
      const minor = -((i % 7) + 1) * 100;
      expected += minor;
      const day = String((i % 27) + 1).padStart(2, '0');
      lines.push(`03/${day}/2026,"ROW ${i}","${(minor / 100).toFixed(2)}",`);
    }
    const preview = await demoFetch('/api/v2/statement-imports/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_mode: 'manual',
        files: [{ filename: 'many.csv', preset_id: 'us-bofa', content: lines.join('\n') }],
      }),
    }, cookie);
    expect(preview.status, await preview.clone().text()).toBe(200);
    const rows = previewRows(await preview.json() as PreviewBody);
    expect(rows).toHaveLength(120);
    const committed = await demoFetch('/api/v2/statement-imports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitFromPreview(accountId, rows, 'demo-many', 'many.csv', 'us-bofa')),
    }, cookie);
    expect(committed.status, await committed.clone().text()).toBe(201);
    const accounts = await demoFetch('/api/v2/accounts', {}, cookie);
    const listed = await accounts.json() as { accounts: Array<{ id: number; balance_minor: number }> };
    expect(listed.accounts.find((account) => account.id === accountId)?.balance_minor).toBe(expected);
    const after = await real.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
