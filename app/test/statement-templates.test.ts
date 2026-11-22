import { describe, expect, it } from 'vitest';
import {
  STATEMENT_TEMPLATE_SCHEMA,
  validateStatementTemplate,
} from '../src/shared/statement-import/template-schema';
import {
  BUILTIN_TEMPLATES,
  mergeAccountAliases,
  mergeXlsHeaderAliases,
  templateAsPreset,
} from '../src/shared/statement-import/templates';
import {
  inspectTemplateDocument,
  templateFileName,
  templateFromMapping,
} from '../src/ui/statementImportState.js';

const schema = STATEMENT_TEMPLATE_SCHEMA as {
  additionalProperties: boolean;
  properties: { schemaVersion: { const: number }; format: { enum: string[] } };
};

const SAMPLE_CSV_TEMPLATE = {
  schemaVersion: 1,
  id: 'sample-csv',
  label: 'Sample CSV',
  format: 'csv',
  csv: {
    mapping: { date: 'Date', description: 'Description', amount: 'Amount', balance: 'Running Bal.' },
    options: {
      delimiter: ',',
      decimalSeparator: '.',
      dateFormat: 'MM/DD/YYYY',
      encoding: 'utf-8',
      hasHeader: true,
      defaultCurrency: 'USD',
      skipEmptyAmount: true,
      checkRunningBalance: true,
    },
  },
} as const;

const SAMPLE_XLS_TEMPLATE = {
  schemaVersion: 1,
  id: 'sample-xls',
  label: 'Sample XLS',
  format: 'xls',
  xls: {
    sheetName: 'Sheet1',
    accountLabel: 'Account',
    accountAliases: ['account', 'account number', 'racun', 'broj racuna'],
    dateFormat: 'DD/MM/YYYY',
    decimalSeparator: '.',
    amountMode: 'credit-debit',
    currencyMode: 'per-row',
    columns: {
      valueDate: { index: 1, header: 'Value date' },
      transactionDate: { index: 2, header: 'Transaction date' },
      currency: { index: 6, header: 'Currency code' },
      credit: { index: 8, header: 'Credit' },
      debit: { index: 10, header: 'Debit' },
      description: { index: 12, header: 'Description' },
    },
    headerAliases: {
      valueDate: ['value date', 'datum valute'],
      transactionDate: ['transaction date', 'datum transakcije'],
      currency: ['currency code', 'sifra valute'],
      credit: ['credit', 'potrazuje'],
      debit: ['debit', 'duguje'],
      description: ['description', 'opis'],
    },
    headerVariants: [
      {
        id: 'en',
        columns: {
          valueDate: { index: 1, header: 'Value date' },
          transactionDate: { index: 2, header: 'Transaction date' },
          currency: { index: 6, header: 'Currency code' },
          credit: { index: 8, header: 'Credit' },
          debit: { index: 10, header: 'Debit' },
          description: { index: 12, header: 'Description' },
        },
      },
      {
        id: 'sr',
        columns: {
          valueDate: { index: 1, header: 'Datum valute' },
          transactionDate: { index: 2, header: 'Datum transakcije' },
          currency: { index: 6, header: 'Šifra valute' },
          credit: { index: 8, header: 'Potražuje' },
          debit: { index: 10, header: 'Duguje' },
          description: { index: 12, header: 'Opis' },
        },
      },
    ],
    descriptionFlags: [
      { id: 'possible_own_account_transfer', pattern: 'otkup strane valute' },
    ],
  },
} as const;

describe('statement template schema', () => {
  it('is versioned and closed to unknown properties', () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.format.enum).toEqual(['csv', 'xls', 'ofx', 'pdf']);
  });

  it('ships zero built-in templates and validates D1 documents cleanly', () => {
    expect(BUILTIN_TEMPLATES).toEqual([]);
    expect(validateStatementTemplate(SAMPLE_CSV_TEMPLATE).ok).toBe(true);
    expect(validateStatementTemplate(SAMPLE_XLS_TEMPLATE).ok).toBe(true);
    const sample = JSON.parse(JSON.stringify(SAMPLE_CSV_TEMPLATE)) as Record<string, unknown>;
    const extra = validateStatementTemplate({ ...sample, note: 'nope' });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.errors.some((error) => error.path === '/note' && error.message === 'is not allowed')).toBe(true);

    const badId = validateStatementTemplate({ ...sample, id: 'Bad_Bank' });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.errors.some((error) => error.path === '/id')).toBe(true);

    expect(validateStatementTemplate({ ...sample, schemaVersion: 2 }).ok).toBe(false);
    const mixed = validateStatementTemplate({
      ...sample,
      xls: { amountMode: 'credit-debit', currencyMode: 'per-row' },
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.errors.some((error) => error.path === '/xls')).toBe(true);

    expect(validateStatementTemplate({ ...sample, csv: undefined, format: 'csv' }).ok).toBe(false);
  });

  it('describes OFX and text-layer PDF templates', () => {
    const pdf = validateStatementTemplate({
      schemaVersion: 1,
      id: 'pdf-sample',
      label: 'PDF sample',
      format: 'pdf',
      pdf: { textLayer: true, pageSize: 'A4' },
    });
    expect(pdf.ok).toBe(true);
    if (pdf.ok) expect(templateAsPreset(pdf.value)?.format).toBe('pdf');

    const ofx = validateStatementTemplate({
      schemaVersion: 1,
      id: 'ofx-sample',
      label: 'OFX',
      format: 'ofx',
      ofx: {},
    });
    expect(ofx.ok).toBe(true);
    if (ofx.ok) expect(templateAsPreset(ofx.value)?.format).toBe('ofx');
  });
});

describe('D1 statement template conversion and header merging', () => {
  it('converts validated CSV and XLS templates to StatementPreset and merges aliases from D1 rules', () => {
    const csvCheck = validateStatementTemplate(SAMPLE_CSV_TEMPLATE);
    const xlsCheck = validateStatementTemplate(SAMPLE_XLS_TEMPLATE);
    expect(csvCheck.ok).toBe(true);
    expect(xlsCheck.ok).toBe(true);
    if (!csvCheck.ok || !xlsCheck.ok) return;

    expect(templateAsPreset(csvCheck.value)).toEqual({
      id: 'sample-csv',
      label: 'Sample CSV',
      format: 'csv',
      mapping: {
        date: 'Date',
        description: 'Description',
        amount: 'Amount',
        balance: 'Running Bal.',
      },
      options: {
        delimiter: ',',
        decimalSeparator: '.',
        dateFormat: 'MM/DD/YYYY',
        encoding: 'utf-8',
        hasHeader: true,
        defaultCurrency: 'USD',
        skipEmptyAmount: true,
        checkRunningBalance: true,
      },
    });

    const xlsPreset = templateAsPreset(xlsCheck.value);
    expect(xlsPreset?.format).toBe('xls');
    if (xlsPreset?.format !== 'xls') return;
    expect(xlsPreset.layout.columns.credit).toEqual({ index: 8, header: 'Credit' });
    expect(xlsPreset.layout.descriptionFlags).toEqual([
      { id: 'possible_own_account_transfer', pattern: 'otkup strane valute' },
    ]);
    expect(mergeXlsHeaderAliases([xlsCheck.value]).credit).toEqual(['credit', 'potrazuje']);
    expect(mergeAccountAliases([xlsCheck.value])).toEqual(['account', 'account number', 'racun', 'broj racuna']);
  });
});

describe('saved mapping documents', () => {
  it('turns a manual column mapping into a schema-valid template file', () => {
    const document = templateFromMapping({
      id: 'my-bank',
      label: 'My bank',
      mapping: { date: 'Posted', amount: 'Value', description: 'Memo', debit: '' },
      options: {
        delimiter: ';',
        decimalSeparator: ',',
        dateFormat: 'DD.MM.YYYY',
        encoding: 'utf-8',
        hasHeader: true,
        defaultCurrency: 'eur',
      },
    });
    const inspected = inspectTemplateDocument(document);
    expect(inspected.ok).toBe(true);
    expect(inspected.document?.csv?.options.defaultCurrency).toBe('EUR');
    expect(inspected.document?.csv?.options.delimiter).toBe(';');
    expect(templateFileName(inspected.document?.id)).toBe('my-bank.json');
    const roundTrip = inspectTemplateDocument(JSON.parse(JSON.stringify(inspected.document)));
    expect(roundTrip.ok).toBe(true);
  });

  it('reports schema errors for a template file', () => {
    const inspected = inspectTemplateDocument({ schemaVersion: 1, id: 'x', label: '', format: 'csv' });
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.detail).toMatch(/\/label/);
    expect(inspected.detail).toMatch(/\/csv/);
  });
});
