import { describe, expect, it } from 'vitest';
import { presetById, STATEMENT_PRESETS } from '../src/shared/statement-import/presets';
import {
  STATEMENT_TEMPLATE_SCHEMA,
  validateStatementTemplate,
} from '../src/shared/statement-import/template-schema';
import {
  BUILTIN_TEMPLATES,
  builtinAccountAliases,
  builtinXlsHeaderAliases,
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

describe('statement template schema', () => {
  it('is versioned and closed to unknown properties', () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.format.enum).toEqual(['csv', 'xls', 'ofx', 'pdf']);
  });

  it('accepts the built-in files and rejects invalid documents with a path', () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(validateStatementTemplate(template).ok, template.id).toBe(true);
    }
    const boa = JSON.parse(JSON.stringify(BUILTIN_TEMPLATES[0])) as Record<string, unknown>;
    const extra = validateStatementTemplate({ ...boa, note: 'nope' });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.errors.some((error) => error.path === '/note' && error.message === 'is not allowed')).toBe(true);

    const badId = validateStatementTemplate({ ...boa, id: 'Bad_Bank' });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.errors.some((error) => error.path === '/id')).toBe(true);

    expect(validateStatementTemplate({ ...boa, schemaVersion: 2 }).ok).toBe(false);
    const mixed = validateStatementTemplate({
      ...boa,
      xls: { amountMode: 'credit-debit', currencyMode: 'per-row' },
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.errors.some((error) => error.path === '/xls')).toBe(true);

    expect(validateStatementTemplate({ ...boa, csv: undefined, format: 'csv' }).ok).toBe(false);
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

describe('built-in template parity', () => {
  it('keeps the Bank of America preset', () => {
    expect(STATEMENT_PRESETS.map((preset) => preset.id)).toEqual(['us-bofa', 'us-bofa-pdf', 'rs-bps', 'rs-bps-pdf']);
    expect(presetById('us-bofa')).toEqual({
      id: 'us-bofa',
      label: 'Bank of America',
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
  });

  it('keeps BPS credit/debit columns, per-row currency, and both header languages', () => {
    const preset = presetById('rs-bps');
    expect(preset?.format).toBe('xls');
    if (preset?.format !== 'xls') return;
    expect(preset.layout.columns).toEqual({
      valueDate: { index: 1, header: 'Value date' },
      transactionDate: { index: 2, header: 'Transaction date' },
      currency: { index: 6, header: 'Currency code' },
      credit: { index: 8, header: 'Credit' },
      debit: { index: 10, header: 'Debit' },
      description: { index: 12, header: 'Description' },
    });
    expect(preset.layout.sheetName).toBe('Sheet1');
    expect(preset.layout.dateFormat).toBe('DD/MM/YYYY');
    expect(preset.layout.decimalSeparator).toBe('.');
    expect(preset.layout.accountLabel).toBe('Account');
    expect(preset.layout.descriptionFlags).toEqual([
      { id: 'possible_own_account_transfer', pattern: 'otkup strane valute' },
    ]);
    expect(builtinXlsHeaderAliases()).toEqual({
      valueDate: ['value date', 'datum valute'],
      transactionDate: ['transaction date', 'datum transakcije', 'datum knjizenja', 'datum prometa'],
      currency: ['currency code', 'oznaka valute', 'sifra valute', 'currency', 'valuta'],
      credit: ['credit', 'potrazuje', 'potrazivanje', 'odobrenje', 'uplata'],
      debit: ['debit', 'duguje', 'dugovanje', 'zaduzenje', 'isplata'],
      description: ['description', 'opis transakcije', 'opis'],
    });
    expect([...builtinAccountAliases()]).toEqual(['account', 'account number', 'racun', 'broj racuna']);
    const bps = BUILTIN_TEMPLATES.find((template) => template.id === 'rs-bps');
    expect(bps?.xls?.headerVariants?.map((variant) => variant.id)).toEqual(['en', 'sr']);
    expect(bps?.xls?.headerVariants?.find((variant) => variant.id === 'sr')?.columns.credit.header).toBe('Potražuje');
    expect(bps?.xls?.amountMode).toBe('credit-debit');
    expect(bps?.xls?.currencyMode).toBe('per-row');
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
