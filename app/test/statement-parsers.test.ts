import { describe, expect, it } from 'vitest';
import { rowKeyFromStoredFingerprint, statementFingerprint, statementRowKey } from '../src/shared/statement-import/amounts';
import { parseStatementFile } from '../src/shared/statement-import/parse';
import { presetById, STATEMENT_PRESETS } from '../src/shared/statement-import/presets';

const BOFA_CSV = [
  'Description,,Summary Amt.',
  'Beginning balance as of 03/01/2026,,"1,250.00"',
  'Total credits,,"500.00"',
  'Total debits,,"-87.45"',
  'Ending balance as of 03/31/2026,,"1,662.55"',
  '',
  'Date,Description,Amount,Running Bal.',
  '03/01/2026,Beginning balance as of 03/01/2026,,"1,250.00"',
  '03/04/2026,"ACME COFFEE 03/03 PURCHASE SPRINGFIELD IL","-12.45","1,237.55"',
  '03/10/2026,"DEMO PAYROLL DES:DIRECT DEP","500.00","1,737.55"',
  '03/15/2026,"EXAMPLE CLOUD*SUB 03/14 PURCHASE EXAMPLE.COM CA","-75.00","1,662.55"',
].join('\r\n');

function blank(width = 20): string[] {
  return Array.from({ length: width }, () => '');
}

export function bpsLine(
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

export async function syntheticBpsWorkbook(dataRows: string[][]): Promise<Uint8Array> {
  const xlsx = await import('xlsx');
  const book = xlsx.default ?? xlsx;
  const rows: string[][] = [];
  for (let i = 0; i < 21; i += 1) rows.push(blank());
  rows[0]![0] = 'Page 1 of 1';
  rows[1]![0] = 'Transactions History';
  rows[2]![0] = 'Owner';
  rows[2]![1] = 'TEST OWNER';
  rows[5]![0] = 'From';
  rows[5]![1] = '01/03/2026';
  rows[6]![0] = 'To';
  rows[6]![1] = '31/03/2026';
  rows[8]![0] = 'Account';
  rows[8]![3] = '265-0000000000001-23';
  rows[10]![0] = 'Statuses All';
  rows[11]![0] = 'Direction All';
  const header = blank();
  header[0] = 'Value date';
  header[1] = 'Transaction date';
  header[5] = 'Currency code';
  header[7] = 'Credit';
  header[9] = 'Debit';
  header[11] = 'Description';
  rows.push(header, ...dataRows);
  const sheet = book.utils.aoa_to_sheet(rows);
  const ref = book.utils.decode_range(sheet['!ref'] as string);
  for (let r = ref.s.r; r <= ref.e.r; r += 1) {
    for (let c = ref.s.c; c <= ref.e.c; c += 1) {
      const addr = book.utils.encode_cell({ r, c });
      const cell = sheet[addr] as { v?: unknown; t?: string } | undefined;
      if (!cell || cell.v === undefined || cell.v === '') continue;
      cell.t = 's';
      cell.v = String(cell.v);
    }
  }
  sheet['!merges'] = [
    { s: { r: 21, c: 11 }, e: { r: 21, c: 18 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
  ];
  const workbook = book.utils.book_new();
  book.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const bytes = book.write(workbook, { bookType: 'xls', type: 'array' }) as ArrayBuffer;
  return new Uint8Array(bytes);
}

describe('statement presets', () => {
  it('ships us-bofa and rs-bps as data, with no parser branch on the bank id', () => {
    expect(STATEMENT_PRESETS.map((preset) => preset.id)).toEqual(['us-bofa', 'us-bofa-pdf', 'rs-bps', 'rs-bps-pdf']);
    expect(presetById('us-bofa')?.format).toBe('csv');
    expect(presetById('rs-bps')?.format).toBe('xls');
    expect(presetById('missing')).toBeNull();
  });
});

describe('us-bofa CSV preset', () => {
  it('detects the header by content, skips the empty-amount pseudo-row, and checks the running balance', async () => {
    const parsed = await parseStatementFile({
      format: 'auto',
      text: BOFA_CSV,
      presetId: 'us-bofa',
    });
    expect(parsed.format).toBe('csv');
    const rows = parsed.statements[0]!.rows;
    expect(rows.map((row) => row.date)).toEqual(['2026-03-04', '2026-03-10', '2026-03-15']);
    expect(rows.map((row) => row.amountMinor)).toEqual([-1245, 50000, -7500]);
    expect(rows.every((row) => row.currency === 'USD')).toBe(true);
    expect(rows.map((row) => row.kind)).toEqual(['expense', 'income', 'expense']);
    expect(rows.every((row) => row.warnings.length === 0)).toBe(true);
    expect(rows.every((row) => row.bankTransactionId === null)).toBe(true);
    expect(rows[0]!.description).toContain('ACME COFFEE');
    const broken = BOFA_CSV.replace('1,237.55', '1,000.00');
    const warned = await parseStatementFile({ format: 'csv', text: broken, presetId: 'us-bofa' });
    expect(warned.statements[0]!.rows[0]!.warnings.join(' ')).toMatch(/running balance/i);
  });

  it('reads a user mapping after a preamble and refuses a mapping that yields no rows', async () => {
    const text = [
      'Bank of America',
      'Synthetic statement',
      'Account number,0000',
      'From,03/01/2026',
      'Through,03/31/2026',
      'Note,preamble',
      'Date,Description,Amount,Running Bal.',
      '03/04/2026,"ACME COFFEE","-12.45","100.00"',
    ].join('\n');
    const mapping = { date: 'Date', amount: 'Amount', description: 'Description' };
    const options = {
      delimiter: ',' as const,
      decimalSeparator: '.' as const,
      dateFormat: 'MM/DD/YYYY' as const,
      encoding: 'utf-8' as const,
      hasHeader: true,
      headerSearch: true,
      skipRows: 0,
    };
    const parsed = await parseStatementFile({
      format: 'csv',
      text,
      mapping,
      options: { ...options, defaultCurrency: 'USD' },
    });
    expect(parsed.statements[0]!.rows).toEqual([
      expect.objectContaining({ date: '2026-03-04', amountMinor: -1245, currency: 'USD', kind: 'expense' }),
    ]);
    const deferred = await parseStatementFile({
      format: 'csv',
      text,
      mapping,
      options,
    });
    expect(deferred.statements[0]!.rows[0]).toMatchObject({
      date: '2026-03-04',
      currency: '',
      amountMinor: 0,
    });
    expect(deferred.statements[0]!.rows[0]!.pendingAmount?.text).toBe('-12.45');
    await expect(parseStatementFile({
      format: 'csv',
      text: 'Date,Description,Amount\nnot-a-date,COFFEE,-1.00\n',
      mapping,
      options,
    })).rejects.toThrow(/invalid date "not-a-date"/i);
  });

  it('reads MM/DD/YYYY when the preferred format is YYYY-MM-DD', async () => {
    const text = 'Date,Description,Amount\n04/23/2026,ACME COFFEE,-12.45\n';
    const parsed = await parseStatementFile({
      format: 'csv',
      text,
      mapping: { date: 'Date', amount: 'Amount', description: 'Description' },
      options: {
        delimiter: ',',
        decimalSeparator: '.',
        dateFormat: 'YYYY-MM-DD',
        encoding: 'utf-8',
        hasHeader: true,
        defaultCurrency: 'USD',
      },
    });
    expect(parsed.statements[0]!.dateFormat).toBe('MM/DD/YYYY');
    expect(parsed.statements[0]!.rows[0]).toMatchObject({ date: '2026-04-23', amountMinor: -1245, currency: 'USD' });
    expect(parsed.statements[0]!.warnings.join(' ')).toMatch(/MM\/DD\/YYYY/);
  });
});

describe('rs-bps Excel preset', () => {
  it('reads a synthetic BIFF8 workbook: header, signs, currencies, transfer flag, and dedup key', async () => {
    const bytes = await syntheticBpsWorkbook([
      bpsLine('14/03/2026', '13/03/2026', 'RSD', '', '2,345.60', '123 - TEST MARKET 45>BEOGRAD            RS'),
      bpsLine('12/03/2026', '12/03/2026', 'RSD', '5,800.00', '', 'EB 00000000001 - otkup strane valute preko m-banki'),
      bpsLine('10/03/2026', '09/03/2026', 'EUR', '', '3.50', 'Naplata provizije za vodjenje racuna za period 02.'),
      bpsLine('08/03/2026', '08/03/2026', 'RSD', '100.00', '', 'Pošiljalac: TEST ŠALTER'),
    ]);
    const parsed = await parseStatementFile({ format: 'xls', bytes, presetId: 'rs-bps' });
    const statement = parsed.statements[0]!;
    expect(statement.accountRef).toBe('265-0000000000001-23');
    expect(statement.rows.map((row) => [row.date, row.valueDate, row.currency, row.amountMinor, row.kind])).toEqual([
      ['2026-03-13', '2026-03-14', 'RSD', -234560, 'expense'],
      ['2026-03-12', '2026-03-12', 'RSD', 580000, 'income'],
      ['2026-03-09', '2026-03-10', 'EUR', -350, 'expense'],
      ['2026-03-08', '2026-03-08', 'RSD', 10000, 'income'],
    ]);
    expect(statement.rows.map((row) => row.possibleOwnAccountTransfer)).toEqual([false, true, false, false]);
    expect(statement.rows[3]!.description).toContain('ŠALTER');
    expect(statement.rows.every((row) => row.bankTransactionId === null)).toBe(true);
    const market = statement.rows[0]!;
    expect(statementFingerprint({
      accountId: 7,
      date: market.date,
      amountMinor: market.amountMinor,
      currency: market.currency,
      description: market.description,
      bankTransactionId: null,
    })).toBe('row:7:2026-03-13:-234560:RSD:123 - test market 45>beograd rs');
    expect(statementRowKey({
      date: market.date,
      amountMinor: market.amountMinor,
      currency: market.currency,
      description: market.description,
      bankTransactionId: null,
    })).toBe('row:2026-03-13:-234560:RSD:123 - test market 45>beograd rs');
    expect(rowKeyFromStoredFingerprint('row:7:2026-03-13:-234560:RSD:123 - test market 45>beograd rs'))
      .toBe('row:2026-03-13:-234560:RSD:123 - test market 45>beograd rs');
    expect(rowKeyFromStoredFingerprint('bank:7:FIT-1')).toBe('bank:FIT-1');
  });

  async function compactWorkbook(headers: string[], data: string[][]): Promise<Uint8Array> {
    const xlsx = await import('xlsx');
    const book = xlsx.default ?? xlsx;
    const rows = [
      ['Transactions History'],
      ['From', '01/03/2026'],
      ['Account', '265-0000000000001-23'],
      [],
      headers,
      ...data,
    ];
    const sheet = book.utils.aoa_to_sheet(rows);
    const workbook = book.utils.book_new();
    book.utils.book_append_sheet(workbook, sheet, 'Export');
    return new Uint8Array(book.write(workbook, { bookType: 'xls', type: 'array' }) as ArrayBuffer);
  }

  it('reads an English header row that is not on the preset column indexes', async () => {
    const bytes = await compactWorkbook(
      ['Value date', 'Transaction date', 'Currency code', 'Credit', 'Debit', 'Description'],
      [
        ['14/03/2026', '13/03/2026', 'RSD', '', '1.234,56', 'TEST MARKET'],
        ['08/03/2026', '08/03/2026', 'RSD', '100,00', '', 'TEST SALARY'],
      ],
    );
    const parsed = await parseStatementFile({ format: 'xls', bytes, presetId: 'rs-bps' });
    const statement = parsed.statements[0]!;
    expect(statement.accountRef).toBe('265-0000000000001-23');
    expect(statement.rows.map((row) => [row.date, row.currency, row.amountMinor, row.kind])).toEqual([
      ['2026-03-13', 'RSD', -123456, 'expense'],
      ['2026-03-08', 'RSD', 10000, 'income'],
    ]);
    const auto = await parseStatementFile({ format: 'auto', bytes });
    expect(auto.format).toBe('xls');
    expect(auto.statements[0]!.rows).toHaveLength(2);
  });

  it('reads Serbian headers and a multi-currency English USD/EUR sheet', async () => {
    const serbian = await compactWorkbook(
      ['Datum valute', 'Datum transakcije', 'Šifra valute', 'Potražuje', 'Duguje', 'Opis'],
      [['14/03/2026', '13/03/2026', 'RSD', '', '10,00', 'PRODAVNICA']],
    );
    const parsed = await parseStatementFile({ format: 'auto', bytes: serbian });
    expect(parsed.statements[0]!.rows[0]).toMatchObject({
      date: '2026-03-13',
      currency: 'RSD',
      amountMinor: -1000,
      kind: 'expense',
    });

    const mixed = await compactWorkbook(
      ['Value date', 'Transaction date', 'Currency code', 'Credit', 'Debit', 'Description'],
      [
        ['02/03/2026', '02/03/2026', 'USD', '', '10.00', 'TEST SHOP'],
        ['01/03/2026', '01/03/2026', 'EUR', '4.00', '', 'TEST REFUND'],
      ],
    );
    const foreign = await parseStatementFile({ format: 'auto', bytes: mixed, presetId: 'rs-bps' });
    expect(foreign.statements[0]!.currency).toBeNull();
    expect(foreign.statements[0]!.rows.map((row) => [row.currency, row.amountMinor, row.kind])).toEqual([
      ['USD', -1000, 'expense'],
      ['EUR', 400, 'income'],
    ]);
  });

  it('keeps USD and EUR rows from one foreign-currency workbook', async () => {
    const bytes = await syntheticBpsWorkbook([
      bpsLine('02/03/2026', '02/03/2026', 'USD', '', '10.00', 'TEST SHOP, CITY'),
      bpsLine('01/03/2026', '01/03/2026', 'EUR', '4.00', '', 'TEST REFUND'),
    ]);
    const parsed = await parseStatementFile({ format: 'auto', bytes, presetId: 'rs-bps' });
    expect(parsed.statements[0]!.currency).toBeNull();
    expect(parsed.statements[0]!.rows.map((row) => [row.currency, row.amountMinor])).toEqual([
      ['USD', -1000],
      ['EUR', 400],
    ]);
  });
});

describe('OFX and CAMT parsers', () => {
  it('reads SGML OFX, XML OFX, and CAMT.053 bank ids', async () => {
    const sgml = `
OFXHEADER:100
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>000000000<ACCTID>SYNTH-ACCT<ACCTTYPE>CHECKING
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260304
<TRNAMT>-12.45
<FITID>FIT-1
<NAME>ACME COFFEE
<MEMO>card
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260310
<TRNAMT>500.00
<FITID>FIT-2
<NAME>DEMO PAYROLL
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
    const ofx = await parseStatementFile({ format: 'ofx', text: sgml });
    expect(ofx.statements[0]!.accountRef).toBe('SYNTH-ACCT');
    expect(ofx.statements[0]!.rows.map((row) => [row.bankTransactionId, row.amountMinor, row.kind])).toEqual([
      ['FIT-1', -1245, 'expense'],
      ['FIT-2', 50000, 'income'],
    ]);

    const xml = sgml
      .replace('<TRNAMT>-12.45', '<TRNAMT>-12.45</TRNAMT>')
      .replace('<FITID>FIT-1', '<FITID>FIT-1</FITID>');
    const xmlParsed = await parseStatementFile({ format: 'qfx', text: xml });
    expect(xmlParsed.format).toBe('qfx');
    expect(xmlParsed.statements[0]!.rows[0]!.bankTransactionId).toBe('FIT-1');

    const camt = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt><Stmt>
    <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
    <Ntry>
      <Amt Ccy="EUR">3.50</Amt>
      <CdtDbtInd>DBIT</CdtDbtInd>
      <BookgDt><Dt>2026-03-09</Dt></BookgDt>
      <AcctSvcrRef>SYNTH-CAMT-1</AcctSvcrRef>
      <NtryDtls><TxDtls>
        <Refs><EndToEndId>E2E-SYNTH</EndToEndId></Refs>
        <RltdPties><Cdtr><Nm>TEST FEE</Nm></Cdtr></RltdPties>
        <RmtInf><Ustrd>Naplata provizije</Ustrd></RmtInf>
      </TxDtls></NtryDtls>
    </Ntry>
  </Stmt></BkToCstmrStmt>
</Document>`;
    const camtParsed = await parseStatementFile({ format: 'camt053', text: camt });
    const row = camtParsed.statements[0]!.rows[0]!;
    expect(camtParsed.statements[0]!.accountRef).toBe('DE89370400440532013000');
    expect(row.amountMinor).toBe(-350);
    expect(row.bankTransactionId).toBe('SYNTH-CAMT-1');
    expect(row.reference).toBe('E2E-SYNTH');
    expect(statementFingerprint({
      accountId: 3,
      date: row.date,
      amountMinor: row.amountMinor,
      currency: row.currency,
      description: 'ignored when the bank id is present',
      bankTransactionId: row.bankTransactionId,
    })).toBe('bank:3:SYNTH-CAMT-1');
  });
});
