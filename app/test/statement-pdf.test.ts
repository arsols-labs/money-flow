import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLOSING_BALANCE_MISMATCH_WARNING } from '../src/shared/statement-import/types';
import { parseStatementFile } from '../src/shared/statement-import/parse';
import expectedPsb from './fixtures/pdf/psb-rsd-synth.expected.json';
import { PSB_RSD_SYNTH_PDF_BASE64 } from './fixtures/pdf/psb-rsd-synth.bytes';
import app from '../src/worker/index';
import mcpApp from '../src/worker/mcp-server';
import { createSessionCookie } from '../src/worker/auth';
import type { Env } from '../src/worker/types';
import { bytesToBase64 } from '../src/worker/statement-uploads';
import {
  emptyTextPdf,
  encryptedPdf,
  syntheticBofaPdf,
  syntheticBpsFxPdf,
  syntheticBpsRsdPdf,
  unknownLayoutPdf,
} from './pdf-fixtures';

const typedEnv = env as unknown as Env;
const clientId = 'client-pdf-statement';
let rpcId = 1;
let cookie = '';

function toolText(result: { result?: { content?: Array<{ text?: string }>; structuredContent?: { error?: string } } }): string {
  return `${result.result?.content?.[0]?.text ?? ''} ${result.result?.structuredContent?.error ?? ''}`;
}

async function call(name: string, args: Record<string, unknown>) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const res = await mcpApp.fetch(req, typedEnv, {
    props: { scopes: ['read', 'write'], clientId },
  } as any);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ result: { isError?: boolean; structuredContent: Record<string, any>; content?: Array<{ text?: string }> } }>;
}

async function api(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, typedEnv);
}

beforeAll(async () => {
  cookie = (await createSessionCookie(typedEnv, false)).split(';')[0]!;
});

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
  await env.DB.prepare(
    `INSERT INTO oauth_clients (id, name, created_at) VALUES (?, 'PDF', datetime('now'))`,
  ).bind(clientId).run();
});

describe('PDF text-layer layouts', () => {
  it('reads a multi-page BPS RSD IZVOD, including a page without the column header', async () => {
    const parsed = await parseStatementFile({
      format: 'auto',
      filename: 'izvod.pdf',
      bytes: await syntheticBpsRsdPdf(),
    });
    expect(parsed.format).toBe('pdf');
    expect(parsed.detectedPresetId).toBe('rs-bps-pdf');
    const statement = parsed.statements[0]!;
    expect(statement.currency).toBe('RSD');
    expect(statement.accountRef).toBe('265000000000000001');
    expect(statement.warnings).toEqual([]);
    expect(statement.rows.map((row) => ({
      date: row.date,
      amount: row.amountMinor,
      balance: row.balanceMinor,
      reference: row.reference,
      description: row.description,
    }))).toEqual([
      {
        date: '2026-06-01',
        amount: 123456,
        balance: 1000000,
        reference: 'REF-1001',
        description: 'PLACEHOLDER GROCER',
      },
      {
        date: '2026-06-02',
        amount: -5000,
        balance: 995000,
        reference: 'REF-1002',
        description: 'Kartica 400000******0000 PLACEHOLDER MERCHANT CITY BRANCH',
      },
      {
        date: '2026-06-03',
        amount: -1000,
        balance: 994000,
        reference: null,
        description: 'PLACEHOLDER FEE',
      },
      {
        date: '2026-06-04',
        amount: 2500,
        balance: 996500,
        reference: 'REF-1004',
        description: 'PLACEHOLDER PAGE TWO WRAPPED LINE',
      },
    ]);
  });

  it('warns when Novo stanje does not match opening plus the rows', async () => {
    const parsed = await parseStatementFile({
      format: 'pdf',
      filename: 'izvod.pdf',
      bytes: await syntheticBpsRsdPdf({ mismatch: true }),
      presetId: 'rs-bps-pdf',
    });
    expect(parsed.statements[0]?.warnings).toEqual([CLOSING_BALANCE_MISMATCH_WARNING]);
    expect(parsed.statements[0]?.rows).toHaveLength(4);
  });

  it('reads BPS USD and EUR PROMENE statements with year-less dates and a shifted second page', async () => {
    const usd = await parseStatementFile({
      format: 'auto',
      filename: 'promene.pdf',
      bytes: await syntheticBpsFxPdf(),
    });
    const statement = usd.statements[0]!;
    expect(statement.currency).toBe('USD');
    expect(statement.accountRef).toBe('265-0000000000001-23');
    expect(statement.warnings).toEqual([]);
    expect(statement.rows.map((row) => [row.date, row.amountMinor, row.description])).toEqual([
      ['2025-12-29', -10000, 'EB 00000000000 - otkup strane valute preko m'],
      ['2026-01-02', -50, '1234 VI/PLACEHOLDER MERCHANT, CITY'],
      ['2026-01-03', 2000, 'PLACEHOLDER FX PAGE TWO'],
    ]);

    const eur = await parseStatementFile({
      format: 'pdf',
      bytes: await syntheticBpsFxPdf({ currency: 'EUR' }),
      presetId: 'rs-bps',
    });
    expect(eur.statements[0]?.currency).toBe('EUR');
    expect(eur.statements[0]?.rows).toHaveLength(3);

    const mismatch = await parseStatementFile({
      format: 'auto',
      bytes: await syntheticBpsFxPdf({ mismatch: true }),
    });
    expect(mismatch.statements[0]?.warnings).toEqual([CLOSING_BALANCE_MISMATCH_WARNING]);
  });

  it('reads a Bank of America statement across a continued section and ignores the trailer', async () => {
    const parsed = await parseStatementFile({
      format: 'auto',
      filename: 'boa.pdf',
      bytes: await syntheticBofaPdf(),
    });
    expect(parsed.detectedPresetId).toBe('us-bofa-pdf');
    const statement = parsed.statements[0]!;
    expect(statement.accountRef).toBe('9999 9999 9999');
    expect(statement.warnings).toEqual([]);
    expect(statement.rows.map((row) => [row.date, row.amountMinor, row.kind, row.description])).toEqual([
      ['2026-05-01', 10000, 'income', 'PAYROLL PLACEHOLDER'],
      ['2026-05-02', -2000, 'expense', 'ATM WITHDRAWAL'],
      ['2026-05-03', -500, 'expense', 'PLACEHOLDER STORE SECOND LINE'],
      ['2026-05-04', -250, 'expense', 'MONTHLY FEE'],
    ]);
    const mismatch = await parseStatementFile({
      format: 'pdf',
      bytes: await syntheticBofaPdf({ mismatch: true }),
      presetId: 'us-bofa-pdf',
    });
    expect(mismatch.statements[0]?.warnings).toEqual([CLOSING_BALANCE_MISMATCH_WARNING]);
  });

  it('rejects a scan, an unknown layout, an encrypted file, and the wrong bank preset', async () => {
    await expect(parseStatementFile({ format: 'auto', filename: 'scan.pdf', bytes: await emptyTextPdf() }))
      .rejects.toMatchObject({ code: 'PDF_NO_TEXT_LAYER' });
    await expect(parseStatementFile({ format: 'auto', filename: 'other.pdf', bytes: await unknownLayoutPdf() }))
      .rejects.toMatchObject({ code: 'PDF_UNKNOWN_LAYOUT' });
    await expect(parseStatementFile({ format: 'auto', filename: 'locked.pdf', bytes: await encryptedPdf() }))
      .rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });
    await expect(parseStatementFile({
      format: 'auto',
      filename: 'boa.pdf',
      bytes: await syntheticBofaPdf(),
      presetId: 'rs-bps-pdf',
    })).rejects.toMatchObject({ code: 'PDF_UNKNOWN_LAYOUT' });
  });
});

describe('synthetic BPS RSD column-ordered statement', () => {
  it('reads every row, its sign and date, and the printed totals', async () => {
    const bytes = Uint8Array.from(atob(PSB_RSD_SYNTH_PDF_BASE64), (char) => char.charCodeAt(0));
    const parsed = await parseStatementFile({
      format: 'auto',
      filename: 'psb-rsd-synth.pdf',
      bytes,
    });
    const statement = parsed.statements[0]!;
    expect(statement.currency).toBe(expectedPsb.currency);
    expect(statement.accountRef).toBe(expectedPsb.accountRef);
    expect(statement.warnings).toEqual([]);
    expect(statement.rows).toHaveLength(expectedPsb.rows.length);
    expect(statement.rows.map((row) => ({
      date: row.date,
      amountMinor: row.amountMinor,
      balanceMinor: row.balanceMinor,
      reference: row.reference,
    }))).toEqual(expectedPsb.rows.map((row) => ({
      date: row.date,
      amountMinor: row.amountMinor,
      balanceMinor: row.balanceMinor,
      reference: row.reference,
    })));
    statement.rows.forEach((row, index) => {
      expect(row.description).toContain(expectedPsb.rows[index]!.description);
    });
    const credits = statement.rows.filter((row) => row.amountMinor > 0);
    const debits = statement.rows.filter((row) => row.amountMinor < 0);
    expect(credits).toHaveLength(expectedPsb.totals.creditsCount);
    expect(debits).toHaveLength(expectedPsb.totals.debitsCount);
    expect(credits.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(expectedPsb.totals.inMinor);
    expect(debits.reduce((sum, row) => sum + -row.amountMinor, 0)).toBe(expectedPsb.totals.outMinor);
    const net = statement.rows.reduce((sum, row) => sum + row.amountMinor, 0);
    expect(expectedPsb.totals.openingMinor + net).toBe(expectedPsb.totals.closingMinor);
    expect(statement.rows.at(-1)?.balanceMinor).toBe(expectedPsb.totals.closingMinor);
  });
});

describe('PDF is never parsed as CSV', () => {
  it('does not ask for a CSV column mapping when inline content starts with %PDF', async () => {
    const preview = await call('statement_import_preview', {
      filename: 'statement.pdf',
      content: '%PDF-1.4\n% synthetic placeholder, not a statement\n',
    });
    expect(preview.result.isError).toBe(true);
    expect(toolText(preview)).not.toContain('CSV column mapping');
    expect(preview.result.structuredContent.code).not.toBeUndefined();
    expect(preview.result.structuredContent.rows).toBeUndefined();
  });

  it('routes a .pdf name, base64, and an upload to the PDF errors', async () => {
    const named = await call('statement_import_preview', {
      filename: 'statement.pdf',
      content: 'Date,Description,Amount\n05/01/2026,PLACEHOLDER,-1.00',
    });
    expect(named.result.isError).toBe(true);
    expect(toolText(named)).not.toContain('CSV column mapping');

    const empty = await call('statement_import_preview', {
      filename: 'scan.pdf',
      content_base64: bytesToBase64(await emptyTextPdf()),
    });
    expect(empty.result.structuredContent.code).toBe('PDF_NO_TEXT_LAYER');
    expect(toolText(empty)).not.toContain('CSV column mapping');

    const unknown = await call('statement_import_preview', {
      filename: 'notes.pdf',
      content_base64: bytesToBase64(await unknownLayoutPdf()),
    });
    expect(unknown.result.structuredContent.code).toBe('PDF_UNKNOWN_LAYOUT');

    const slot = await call('statement_import_upload_create', { filename: 'scan.pdf' });
    const uploadUrl = new URL(slot.result.structuredContent.upload_url as string);
    const put = await app.request(uploadUrl.pathname, {
      method: 'PUT',
      body: await emptyTextPdf(),
    }, typedEnv);
    expect(put.status).toBe(201);
    const uploaded = await call('statement_import_preview', {
      upload_id: slot.result.structuredContent.upload_id,
      filename: 'scan.pdf',
    });
    expect(uploaded.result.structuredContent.code).toBe('PDF_NO_TEXT_LAYER');
    expect(toolText(uploaded)).not.toContain('CSV column mapping');
  });

  it('fails the whole UI preview when one file is a PDF with no text layer', async () => {
    const csv = 'Date,Description,Amount,Running Bal.\n05/01/2026,PLACEHOLDER,-1.00,10.00';
    const res = await api('/api/v2/statement-imports/preview', {
      category_mode: 'manual',
      files: [
        { filename: 'boa.csv', preset_id: 'us-bofa', content: csv },
        { filename: 'scan.pdf', format: 'auto', content_base64: bytesToBase64(await emptyTextPdf()) },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string }; files?: unknown };
    expect(body.error.code).toBe('PDF_NO_TEXT_LAYER');
    expect(body.files).toBeUndefined();
    const batches = await env.DB.prepare('SELECT COUNT(*) AS n FROM import_batches').first<{ n: number }>();
    expect(batches?.n).toBe(0);
  });
});
