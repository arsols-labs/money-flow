import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import type { Env } from '../src/worker/types';
import {
  STATEMENT_IMPORT_INLINE_MAX_BYTES,
  STATEMENT_IMPORT_MAX_FILE_BYTES,
  STATEMENT_IMPORT_MAX_ROWS,
  STATEMENT_IMPORT_MCP_JSON_MAX_BYTES,
  base64LengthForBytes,
} from '../src/shared/statement-import/types';
import {
  statementImportCommitStatementCount,
  statementImportInsertChunkRows,
} from '../src/worker/statement-import';
import { bytesToBase64, signStatementUploadToken } from '../src/worker/statement-uploads';

function blank(width = 20): string[] {
  return Array.from({ length: width }, () => '');
}

function bpsLine(
  valueDate: string,
  transactionDate: string,
  currency: string,
  credit: string,
  debit: string,
  description: string,
): string[] {
  const row = blank();
  row[0] = valueDate;
  row[1] = transactionDate;
  row[5] = currency;
  row[7] = credit;
  row[9] = debit;
  row[11] = description;
  return row;
}

async function syntheticBpsWorkbook(dataRows: string[][]): Promise<Uint8Array> {
  const xlsx = await import('xlsx');
  const book = xlsx.default ?? xlsx;
  const rows: string[][] = [];
  for (let i = 0; i < 21; i += 1) rows.push(blank());
  rows[0]![0] = 'Page 1 of 1';
  rows[1]![0] = 'Transactions History';
  rows[8]![0] = 'Account';
  rows[8]![3] = '265-0000000000001-23';
  const header = blank();
  header[0] = 'Value date';
  header[1] = 'Transaction date';
  header[5] = 'Currency code';
  header[7] = 'Credit';
  header[9] = 'Debit';
  header[11] = 'Description';
  rows.push(header, ...dataRows);
  const sheet = book.utils.aoa_to_sheet(rows);
  const workbook = book.utils.book_new();
  book.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return new Uint8Array(book.write(workbook, { bookType: 'xls', type: 'array' }) as ArrayBuffer);
}

const typedEnv = env as unknown as Env;
const clientId = 'client-mcp-statement';
const otherClientId = 'client-mcp-statement-other';
let rpcId = 1;

const BOFA = [
  'Date,Description,Amount,Running Bal.',
  '03/04/2026,"ACME COFFEE","-12.45","100.00"',
].join('\n');

const OFX = `OFXHEADER:100
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260304
<TRNAMT>-12.45
<FITID>FIT-SYNTH-1
<NAME>ACME COFFEE
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

async function call(
  name: string,
  args: Record<string, unknown>,
  options: { scopes?: string[]; client?: string } = {},
) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApp.fetch(req, typedEnv, {
    props: { scopes: options.scopes ?? ['read', 'write'], clientId: options.client ?? clientId },
  } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function confirm(name: string, args: Record<string, unknown>, client = clientId) {
  const first = await call(name, args, { client });
  expect(first.result.isError, JSON.stringify(first.result)).toBeFalsy();
  expect(first.result.structuredContent.resultType).toBe('input_required');
  expect(first.result.structuredContent.written).toBe(false);
  const second = await call(name, { ...args, requestState: first.result.structuredContent.requestState }, { client });
  expect(second.result.isError, JSON.stringify(second.result)).toBeFalsy();
  return second;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM import_batches'),
    env.DB.prepare('DELETE FROM statement_import_uploads'),
    env.DB.prepare('DELETE FROM statement_templates'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM oauth_clients'),
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Statement', datetime('now'))`).bind(clientId),
    env.DB.prepare(`INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'Other', datetime('now'))`).bind(otherClientId),
  ]);
});

async function insertAccount(currency = 'USD'): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, currency, balance_minor, sort, archived, owner, country, balance_updated_at)
     VALUES (?, ?, 0, 1, 0, 'Alex', 'RS', '2026-11-01T00:00:00Z') RETURNING id`,
  ).bind(`${currency} checking`, currency).first<{ id: number }>();
  return row!.id;
}

describe('statement template MCP tools', () => {
  it('lists built-ins as read-only and refuses to edit or delete them', async () => {
    const listed = await call('template_list', {});
    const ids = listed.result.structuredContent.templates.map((row: { id: string }) => row.id);
    expect(ids).toEqual(expect.arrayContaining(['us-bofa', 'us-bofa-pdf', 'rs-bps', 'rs-bps-pdf']));
    expect(listed.result.structuredContent.templates.find((row: { id: string }) => row.id === 'us-bofa').readonly).toBe(true);

    const got = await call('template_get', { template_id: 'rs-bps' });
    expect(got.result.structuredContent.readonly).toBe(true);
    expect(got.result.structuredContent.document.id).toBe('rs-bps');

    for (const name of ['template_update', 'template_delete'] as const) {
      const denied = await call(name, {
        template_id: 'us-bofa',
        label: 'Changed',
        auto_confirm: true,
        idempotency_key: `builtin-${name}`,
      });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.structuredContent.error).toMatch(/TEMPLATE_READONLY|auto_confirm is not accepted/);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM statement_templates').first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it('copies a built-in template, allows same-client auto_confirm until the template is used, and always confirms delete', async () => {
    const pending = await call('template_create', {
      copy_from: 'us-bofa',
      id: 'copy-bofa',
      idempotency_key: 'create-pending',
    });
    expect(pending.result.structuredContent.written).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM statement_templates').first<{ n: number }>()).toMatchObject({ n: 0 });

    const created = await call('template_create', {
      copy_from: 'us-bofa',
      id: 'copy-bofa',
      label: 'My BoA',
      auto_confirm: true,
      idempotency_key: 'create-now',
    });
    expect(created.result.structuredContent.written).toBe(true);
    expect(created.result.structuredContent.template.document.id).toBe('copy-bofa');
    expect(created.result.structuredContent.template.created_via).toBe('mcp');
    expect(created.result.structuredContent.template.used).toBe(false);

    const renamed = await call('template_update', {
      template_id: 'copy-bofa',
      label: 'My BoA renamed',
      auto_confirm: true,
      idempotency_key: 'rename-same',
    });
    expect(renamed.result.isError, JSON.stringify(renamed.result)).toBeFalsy();
    expect(renamed.result.structuredContent.template.document.label).toBe('My BoA renamed');

    const other = await call('template_update', {
      template_id: 'copy-bofa',
      label: 'Stolen',
      auto_confirm: true,
      idempotency_key: 'rename-other',
    }, { client: otherClientId });
    expect(other.result.structuredContent.error).toMatch(/auto_confirm is not accepted for template_update/);
    const label = await env.DB.prepare('SELECT label FROM statement_templates WHERE template_id = ?').bind('copy-bofa').first<{ label: string }>();
    expect(label?.label).toBe('My BoA renamed');

    const accountId = await insertAccount();
    const imported = await call('statement_import_commit', {
      content: BOFA,
      template_id: 'copy-bofa',
      account_id: accountId,
      auto_confirm: true,
      idempotency_key: 'import-uses-template',
    });
    expect(imported.result.structuredContent.added).toBe(1);
    const used = await env.DB.prepare('SELECT used_batch_id FROM statement_templates WHERE template_id = ?').bind('copy-bofa').first<{ used_batch_id: number }>();
    expect(used?.used_batch_id).toBe(imported.result.structuredContent.batch_id);

    const afterUse = await call('template_update', {
      template_id: 'copy-bofa',
      label: 'Too late',
      auto_confirm: true,
      idempotency_key: 'rename-used',
    });
    expect(afterUse.result.structuredContent.error).toMatch(/auto_confirm is not accepted for template_update/);

    const confirmed = await confirm('template_update', {
      template_id: 'copy-bofa',
      label: 'After use',
      idempotency_key: 'rename-confirmed',
    });
    expect(confirmed.result.structuredContent.template.document.label).toBe('After use');

    const refusedDelete = await call('template_delete', {
      template_id: 'copy-bofa',
      auto_confirm: true,
      idempotency_key: 'delete-auto',
    });
    expect(refusedDelete.result.structuredContent.error).toMatch(/auto_confirm is not accepted for template_delete/);
    const deleted = await confirm('template_delete', { template_id: 'copy-bofa', idempotency_key: 'delete-mrtr' });
    expect(deleted.result.structuredContent.deleted).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM statement_templates').first<{ n: number }>()).toMatchObject({ n: 0 });
  });
});

describe('statement import MCP tools', () => {
  it('previews through the shared parser, commits with auto_confirm, skips duplicates, and undoes only after confirmation', async () => {
    const accountId = await insertAccount();
    const preview = await call('statement_import_preview', {
      filename: 'synthetic.csv',
      content: BOFA,
      account_id: accountId,
      idempotency_key: 'preview-bofa',
    });
    expect(preview.result.isError, JSON.stringify(preview.result)).toBeFalsy();
    const body = preview.result.structuredContent;
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.detected_template.id).toBe('us-bofa');
    expect(body.account_mapping[0].account_id).toBe(accountId);
    expect(body.duplicates).toBe(0);
    expect(body.totals[0].currency).toBe('USD');
    expect(body.requestState).toEqual(expect.any(String));
    expect(body.written).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>()).toMatchObject({ n: 0 });

    const committed = await call('statement_import_commit', {
      idempotency_key: 'preview-bofa',
      requestState: body.requestState,
    });
    expect(committed.result.structuredContent.written).toBe(true);
    expect(committed.result.structuredContent.added).toBe(1);
    expect(committed.result.structuredContent.skipped_duplicates).toBe(0);
    expect(committed.result.structuredContent.batch_id).toEqual(expect.any(Number));
    expect(committed.result.structuredContent.view_path).toBe('#/data/import');
    expect(committed.result.structuredContent.undo_tool).toBe('statement_import_undo');

    const again = await call('statement_import_commit', {
      content: BOFA,
      account_id: accountId,
      auto_confirm: true,
      idempotency_key: 'import-again',
    });
    expect(again.result.structuredContent.written).toBe(false);
    expect(again.result.structuredContent.added).toBe(0);
    expect(again.result.structuredContent.skipped_duplicates).toBeGreaterThan(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>()).toMatchObject({ n: 1 });

    const batchId = committed.result.structuredContent.batch_id as number;
    const autoUndo = await call('statement_import_undo', {
      batch_id: batchId,
      phrase: 'UNDO IMPORT',
      auto_confirm: true,
      idempotency_key: 'undo-auto',
    });
    expect(autoUndo.result.structuredContent.error).toMatch(/auto_confirm is not accepted for statement_import_undo/);
    const undone = await confirm('statement_import_undo', {
      batch_id: batchId,
      phrase: 'UNDO IMPORT',
      idempotency_key: 'undo-mrtr',
    });
    expect(undone.result.structuredContent.undone).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>()).toMatchObject({ n: 0 });
    const balance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
    expect(balance?.balance_minor).toBe(0);
  });

  it('surfaces parser failures and empty files instead of an empty success', async () => {
    const garbage = await call('statement_import_preview', { content: 'hello', filename: 'notes.txt' });
    expect(garbage.result.isError).toBe(true);
    expect(garbage.result.structuredContent.error).toMatch(/IMPORT_FILE_INVALID|IMPORT_NO_ROWS/);
    expect(garbage.result.structuredContent.requestState).toBeUndefined();
    expect(garbage.result.structuredContent.written).not.toBe(true);

    const headerOnly = await call('statement_import_preview', {
      content: 'Date,Description,Amount,Running Bal.\n',
      template_id: 'us-bofa',
      filename: 'empty.csv',
    });
    expect(headerOnly.result.isError).toBe(true);
    expect(headerOnly.result.structuredContent.error).toMatch(/no transaction rows|IMPORT_NO_ROWS/);
    expect(headerOnly.result.structuredContent.requestState).toBeUndefined();
    expect(headerOnly.result.structuredContent.committable).not.toBe(true);
  });

  it('uses one raw-byte cap for inline and upload, and the shared row cap', async () => {
    expect(STATEMENT_IMPORT_INLINE_MAX_BYTES).toBe(STATEMENT_IMPORT_MAX_FILE_BYTES);
    expect(STATEMENT_IMPORT_MAX_FILE_BYTES).toBe(1_048_576);
    expect(STATEMENT_IMPORT_MAX_ROWS).toBe(2_000);
    expect(STATEMENT_IMPORT_MCP_JSON_MAX_BYTES).toBeGreaterThan(
      base64LengthForBytes(STATEMENT_IMPORT_MAX_FILE_BYTES),
    );

    const accountId = await insertAccount();
    const atCap = await call('statement_import_preview', {
      content: 'x'.repeat(STATEMENT_IMPORT_MAX_FILE_BYTES),
      filename: 'at-cap.txt',
    });
    expect(atCap.result.structuredContent.code).not.toBe('IMPORT_TOO_LARGE');
    expect(atCap.result.isError).toBe(true);

    const tooBig = 'x'.repeat(STATEMENT_IMPORT_MAX_FILE_BYTES + 1);
    const fileCap = await call('statement_import_preview', {
      content_base64: bytesToBase64(new TextEncoder().encode(tooBig)),
      account_id: accountId,
      filename: 'big.csv',
    });
    expect(fileCap.result.isError).toBe(true);
    expect(fileCap.result.structuredContent.error).toContain(String(STATEMENT_IMPORT_MAX_FILE_BYTES));
    expect(fileCap.result.structuredContent.code).toBe('IMPORT_TOO_LARGE');

    const lines = ['Date,Description,Amount,Running Bal.'];
    for (let i = 0; i < STATEMENT_IMPORT_MAX_ROWS + 1; i += 1) {
      lines.push(`03/04/2026,ROW ${i},-1.00,100.00`);
    }
    const rows = await call('statement_import_preview', {
      content: lines.join('\n'),
      template_id: 'us-bofa',
      account_id: accountId,
    });
    expect(rows.result.structuredContent.code).toBe('IMPORT_TOO_LARGE');
    expect(rows.result.structuredContent.error).toContain(String(STATEMENT_IMPORT_MAX_ROWS));

    const slot = await call('statement_import_upload_create', { filename: 'over.csv' });
    const uploadUrl = new URL(slot.result.structuredContent.upload_url as string);
    const put = await app.request(uploadUrl.pathname, {
      method: 'PUT',
      body: new Uint8Array(STATEMENT_IMPORT_MAX_FILE_BYTES + 1),
    }, typedEnv);
    expect(put.status).toBe(400);
    const body = await put.json() as { error: { code: string; params?: { limit?: number } } };
    expect(body.error.code).toBe('IMPORT_TOO_LARGE');
    expect(body.error.params?.limit).toBe(STATEMENT_IMPORT_MAX_FILE_BYTES);
  });

  it('keeps a 2000-row commit inside one D1 batch and can undo it', async () => {
    expect(statementImportInsertChunkRows()).toBe(5);
    expect(5 * 11 + 1).toBeLessThanOrEqual(100);
    const statements = statementImportCommitStatementCount(STATEMENT_IMPORT_MAX_ROWS, 1);
    expect(statements).toBe(1 + 2 + STATEMENT_IMPORT_MAX_ROWS / 5);
    expect(statements).toBeLessThanOrEqual(2_000);
    expect(base64LengthForBytes(STATEMENT_IMPORT_MAX_FILE_BYTES)).toBeLessThan(2_000_000);

    const accountId = await insertAccount();
    const lines = ['Date,Description,Amount,Running Bal.'];
    for (let i = 0; i < STATEMENT_IMPORT_MAX_ROWS; i += 1) {
      lines.push(`03/04/2026,SYNTH ${i},-1.00,`);
    }
    const csv = lines.join('\n');
    const preview = await call('statement_import_preview', {
      filename: 'month.csv',
      content: csv,
      template_id: 'us-bofa',
      account_id: accountId,
      idempotency_key: 'rows-2000-preview',
    });
    expect(preview.result.isError, JSON.stringify(preview.result?.structuredContent?.error ?? preview.result)).toBeFalsy();
    expect(preview.result.structuredContent.rows).toHaveLength(STATEMENT_IMPORT_MAX_ROWS);

    const committed = await call('statement_import_commit', {
      idempotency_key: 'rows-2000-preview',
      requestState: preview.result.structuredContent.requestState,
    });
    expect(committed.result.isError, JSON.stringify(committed.result)).toBeFalsy();
    expect(committed.result.structuredContent.written).toBe(true);
    expect(committed.result.structuredContent.added).toBe(STATEMENT_IMPORT_MAX_ROWS);
    expect(committed.result.structuredContent.skipped_duplicates).toBe(0);
    const balance = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
    expect(balance?.balance_minor).toBe(STATEMENT_IMPORT_MAX_ROWS * -100);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM operations WHERE import_batch_id = ?')
      .bind(committed.result.structuredContent.batch_id).first<{ n: number }>()).toMatchObject({ n: STATEMENT_IMPORT_MAX_ROWS });

    const undone = await confirm('statement_import_undo', {
      batch_id: committed.result.structuredContent.batch_id,
      phrase: 'UNDO IMPORT',
      idempotency_key: 'rows-2000-undo',
    });
    expect(undone.result.structuredContent.undone).toBe(true);
    expect(undone.result.structuredContent.removed).toBe(STATEMENT_IMPORT_MAX_ROWS);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM operations').first<{ n: number }>()).toMatchObject({ n: 0 });
    const restored = await env.DB.prepare('SELECT balance_minor FROM accounts WHERE id = ?').bind(accountId).first<{ balance_minor: number }>();
    expect(restored?.balance_minor).toBe(0);
  }, 30_000);

  it('accepts one raw upload, then refuses a second PUT and an expired token', async () => {
    const created = await call('statement_import_upload_create', { filename: 'synthetic.csv' });
    expect(created.result.structuredContent.written).toBe(false);
    expect(created.result.structuredContent.max_file_bytes).toBe(STATEMENT_IMPORT_MAX_FILE_BYTES);
    const uploadUrl = new URL(created.result.structuredContent.upload_url as string);
    const put = await app.request(uploadUrl.pathname, {
      method: 'PUT',
      body: new TextEncoder().encode(BOFA),
    }, typedEnv);
    expect(put.status, await put.clone().text()).toBe(201);
    const stored = await put.json() as { upload_id: string; byte_length: number };
    expect(stored.upload_id).toBe(created.result.structuredContent.upload_id);
    expect(stored.byte_length).toBe(new TextEncoder().encode(BOFA).byteLength);

    const second = await app.request(uploadUrl.pathname, {
      method: 'PUT',
      body: new TextEncoder().encode(BOFA),
    }, typedEnv);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: { code: 'STATEMENT_UPLOAD_INVALID', params: { detail: 'already used' } } });

    const accountId = await insertAccount();
    const preview = await call('statement_import_preview', {
      upload_id: stored.upload_id,
      account_id: accountId,
    });
    expect(preview.result.isError, JSON.stringify(preview.result)).toBeFalsy();
    expect(preview.result.structuredContent.rows).toHaveLength(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM statement_import_uploads').first<{ n: number }>()).toMatchObject({ n: 0 });

    const again = await call('statement_import_upload_create', { filename: 'later.csv' });
    const laterUrl = new URL(again.result.structuredContent.upload_url as string);
    const expiredToken = await signStatementUploadToken(typedEnv.SESSION_SECRET, {
      id: again.result.structuredContent.upload_id,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const expiredPath = `/api/v2/statement-imports/uploads/${expiredToken}`;
    const expired = await app.request(expiredPath, {
      method: 'PUT',
      body: new TextEncoder().encode(BOFA),
    }, typedEnv);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: { code: 'STATEMENT_UPLOAD_INVALID', params: { detail: 'expired' } } });

    await env.DB.prepare(`UPDATE statement_import_uploads SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`)
      .bind(again.result.structuredContent.upload_id).run();
    const stale = await app.request(laterUrl.pathname, {
      method: 'PUT',
      body: new TextEncoder().encode('Date,Description,Amount\n'),
    }, typedEnv);
    expect(stale.status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM statement_import_uploads').first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it('keeps preamble rows when a user template is applied by the shared parser', async () => {
    const accountId = await insertAccount();
    const created = await call('template_create', {
      copy_from: 'us-bofa',
      id: 'preamble-boa',
      auto_confirm: true,
      idempotency_key: 'preamble-template',
    });
    expect(created.result.structuredContent.written).toBe(true);
    const preamble = [
      'Bank of America',
      'Synthetic statement',
      'Account number,0000',
      'Date,Description,Amount,Running Bal.',
      '03/04/2026,"ACME COFFEE","-12.45","100.00"',
    ].join('\n');
    const preview = await call('statement_import_preview', {
      filename: 'preamble.csv',
      content: preamble,
      template_id: 'preamble-boa',
      account_id: accountId,
    });
    expect(preview.result.isError, JSON.stringify(preview.result)).toBeFalsy();
    expect(preview.result.structuredContent.rows).toHaveLength(1);
    expect(preview.result.structuredContent.rows[0].amount_minor).toBe(-1245);
    expect(preview.result.structuredContent.requestState).toEqual(expect.any(String));
  });

  it('parses OFX text and an Excel workbook with the same preview service', async () => {
    const accountId = await insertAccount();
    const ofx = await call('statement_import_preview', {
      filename: 'synthetic.ofx',
      content: OFX,
      account_id: accountId,
    });
    expect(ofx.result.isError, JSON.stringify(ofx.result)).toBeFalsy();
    expect(ofx.result.structuredContent.detected_format).toBe('ofx');
    expect(ofx.result.structuredContent.rows).toHaveLength(1);
    expect(ofx.result.structuredContent.rows[0].amount_minor).toBe(-1245);

    const bytes = await syntheticBpsWorkbook([
      bpsLine('02/03/2026', '02/03/2026', 'USD', '', '10.00', 'TEST SHOP'),
    ]);
    const xls = await call('statement_import_preview', {
      filename: 'synthetic.xls',
      content_base64: bytesToBase64(bytes),
      template_id: 'rs-bps',
      account_id: accountId,
    });
    expect(xls.result.isError, JSON.stringify(xls.result)).toBeFalsy();
    expect(xls.result.structuredContent.detected_template.id).toBe('rs-bps');
    expect(xls.result.structuredContent.rows).toHaveLength(1);
    expect(xls.result.structuredContent.rows[0].amount_minor).toBe(-1000);
  });
});
