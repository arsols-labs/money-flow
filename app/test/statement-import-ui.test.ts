import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { statementFingerprint } from '../src/shared/statement-import/amounts';
import { formatMinor } from '../src/ui/money.js';
import { RefreshProvider } from '../src/ui/RefreshContext.jsx';
import { CategoryRulesPanel } from '../src/ui/CategoryRulesEditor.jsx';
import { StatementImportView } from '../src/ui/StatementImportSection.jsx';
import { tabFromHash } from '../src/ui/Shell.jsx';
import i18n from '../src/ui/i18n.js';
import {
  IMPORT_UNDO_PHRASE,
  PRESET_AUTO,
  PRESET_GENERIC,
  buildCommitPayload,
  buildCommitRow,
  buildPreviewRequest,
  canCommit,
  categoryCatalog,
  commitBlockers,
  describeImportBatch,
  describeStatementRows,
  existingExpenseDuplicateRows,
  fileAdmissionError,
  inspectTemplateDocument,
  idempotencyForPayload,
  interpretCommit,
  preselectDateFormat,
  previewRequestProblems,
  priorityMove,
  rowsFromPreview,
  rulePayload,
  summarizeCommit,
  summarizeRemoval,
  templateFileName,
  templateFromMapping,
  undoPhraseMatches,
  validateRuleDraft,
  withInclude,
  withStatementAccount,
} from '../src/ui/statementImportState.js';

const LIMITS = {
  max_files: 8,
  max_file_bytes: 1_048_576,
  max_body_bytes: 11_250_368,
  max_rows: 2_000,
};

const ACCOUNTS = [
  { id: 1, name: 'Checking', currency: 'USD', account_number: 'US00TEST' },
  { id: 2, name: 'Dinars', currency: 'RSD' },
];

function previewFixture() {
  return {
    category_mode: 'rules',
    files: [{
      filename: 'sample.csv',
      format: 'csv',
      warnings: [],
      statements: [{
        account_ref: 'US00TEST',
        statement_currency: 'USD',
        account_id: 1,
        account_currency: 'USD',
        match: 'iban',
        warnings: [],
        rows: [
          {
            index: 0,
            date: '2026-01-02',
            amount_minor: -2500,
            currency: 'USD',
            description: 'COFFEE',
            merchant: 'Cafe',
            counterparty: null,
            bank_transaction_id: null,
            kind: 'expense',
            duplicate: false,
            duplicate_in_batch: false,
            duplicate_reason: null,
            possible_own_account_transfer: false,
            currency_mismatch: false,
            proposed_category: 'Food',
            proposed_subcategory: 'Cafe',
            category_rule_id: 4,
            warnings: [],
          },
          {
            index: 1,
            date: '2026-01-03',
            amount_minor: -2500,
            currency: 'USD',
            description: 'COFFEE',
            merchant: 'Cafe',
            counterparty: null,
            bank_transaction_id: 'DUP-1',
            kind: 'expense',
            duplicate: true,
            duplicate_in_batch: false,
            duplicate_reason: 'bank_transaction_id',
            possible_own_account_transfer: true,
            currency_mismatch: false,
            proposed_category: null,
            proposed_subcategory: null,
            category_rule_id: null,
            warnings: [],
          },
        ],
      }],
    }],
  };
}

describe('statement import flow state', () => {
  it('rejects unsupported names and files over the preset limit', () => {
    expect(fileAdmissionError(
      { name: 'notes.xlsx', size: 10 },
      { existingCount: 0, existingBodyBytes: 0, limits: LIMITS },
    )).toMatchObject({ code: 'unsupported', name: 'notes.xlsx' });
    expect(fileAdmissionError(
      { name: 'big.csv', size: LIMITS.max_file_bytes + 1 },
      { existingCount: 0, existingBodyBytes: 0, limits: LIMITS },
    )).toMatchObject({ code: 'IMPORT_TOO_LARGE', scope: 'file', limit: LIMITS.max_file_bytes });
    expect(fileAdmissionError(
      { name: 'ninth.csv', size: 10, base64: 'eA==' },
      { existingCount: 8, existingBodyBytes: 0, limits: LIMITS },
    )).toMatchObject({ code: 'IMPORT_TOO_LARGE', scope: 'files', limit: 8 });
  });

  it('excludes duplicates by default and keeps a rule category editable in state', () => {
    const rows = rowsFromPreview(previewFixture());
    expect(rows).toHaveLength(2);
    expect(rows[0].include).toBe(true);
    expect(rows[0].category).toBe('Food');
    expect(rows[0].subcategory).toBe('Cafe');
    expect(rows[0].ownTransfer).toBe(false);
    expect(rows[1].include).toBe(false);
    expect(rows[1].duplicateReason).toBe('bank_transaction_id');
    expect(rows[1].ownTransfer).toBe(true);
    const included = withInclude(rows, rows[1].key, true);
    expect(included[1].include).toBe(true);
  });

  it('blocks commit until every included row has a matching account', () => {
    const rows = rowsFromPreview(previewFixture());
    expect(canCommit(rows)).toBe(true);
    const unmatched = withStatementAccount(rows, '0:0', null, ACCOUNTS);
    expect(commitBlockers(unmatched).missingAccount).toBe(1);
    expect(canCommit(unmatched)).toBe(false);
    const wrongCurrency = withStatementAccount(rows, '0:0', 2, ACCOUNTS);
    expect(wrongCurrency[0].currencyMismatch).toBe(true);
    expect(wrongCurrency[0].accountCurrency).toBe('RSD');
    expect(canCommit(wrongCurrency)).toBe(false);
    const summary = summarizeCommit(rows, ACCOUNTS);
    expect(summary.count).toBe(1);
    expect(summary.groups[0]).toMatchObject({ accountName: 'Checking', currency: 'USD', amountMinor: -2500 });
  });

  it('builds a preview body for auto, a bank preset, and generic CSV mapping', () => {
    const file = { name: 'sample.csv', base64: 'QQ==', presetId: PRESET_AUTO };
    const auto = buildPreviewRequest({
      categoryMode: 'manual',
      files: [file],
      mapping: { date: '' },
      options: { delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', encoding: 'utf-8', hasHeader: true, defaultCurrency: '' },
      presets: [{ id: 'us-bofa', format: 'csv', label: 'Bank of America' }],
    });
    expect(auto.files[0]).toEqual({ filename: 'sample.csv', content_base64: 'QQ==', format: 'auto' });
    const preset = buildPreviewRequest({
      categoryMode: 'rules',
      files: [{ ...file, presetId: 'us-bofa' }],
      mapping: { date: 'Date' },
      options: auto && { delimiter: ',', decimalSeparator: '.', dateFormat: 'MM/DD/YYYY', encoding: 'utf-8', hasHeader: true, defaultCurrency: '' },
      presets: [{ id: 'us-bofa', format: 'csv', label: 'Bank of America' }],
    });
    expect(preset.files[0].preset_id).toBe('us-bofa');
    expect(preset.files[0].format).toBe('csv');
    expect(preset.files[0].mapping).toBeUndefined();
    expect(buildPreviewRequest({
      categoryMode: 'manual',
      files: [{ ...file, presetId: 'us-bofa', accountId: 7 }],
      mapping: { date: 'Date' },
      options: { delimiter: ',', decimalSeparator: '.', dateFormat: 'MM/DD/YYYY', encoding: 'utf-8', hasHeader: true, defaultCurrency: '' },
      presets: [{ id: 'us-bofa', format: 'csv', label: 'Bank of America' }],
    }).files[0].account_id).toBe(7);
    expect(previewRequestProblems({
      presetId: PRESET_GENERIC,
      files: [{ presetId: PRESET_GENERIC }],
      mapping: { date: ' ' },
      options: { defaultCurrency: '' },
    })).toContain('date');
    const generic = buildPreviewRequest({
      categoryMode: 'manual',
      files: [{ ...file, name: 'generic.csv', presetId: PRESET_GENERIC }],
      mapping: { date: 'Date', amount: 'Amount', description: 'Description', debit: '' },
      options: { delimiter: ';', decimalSeparator: ',', dateFormat: 'DD.MM.YYYY', encoding: 'utf-8', hasHeader: true, defaultCurrency: 'eur' },
      presets: [],
    });
    expect(generic.files[0].format).toBe('csv');
    expect(generic.files[0].preset_id).toBeUndefined();
    expect(generic.files[0].mapping).toEqual({ date: 'Date', amount: 'Amount', description: 'Description' });
    expect(generic.files[0].options.default_currency).toBe('EUR');
    expect(generic.files[0].options.delimiter).toBe(';');
  });

  it('recomputes the fingerprint for the chosen account and keeps one idempotency key', () => {
    const rows = rowsFromPreview(previewFixture());
    const payload = buildCommitPayload(rows, { categoryMode: 'rules', fileCount: 1, idempotencyKey: 'key-1' });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].fingerprint).toBe(statementFingerprint({
      accountId: 1,
      date: '2026-01-02',
      amountMinor: -2500,
      currency: 'USD',
      description: 'COFFEE',
      bankTransactionId: null,
    }));
    expect(payload.rows[0].category).toBe('Food');
    expect(payload.rows[0].subcategory).toBe('Cafe');
    const moved = withStatementAccount(rows, '0:0', 1, ACCOUNTS);
    const again = buildCommitPayload(moved, { categoryMode: 'manual', fileCount: 1, idempotencyKey: 'key-1' });
    expect(again.rows[0].account_id).toBe(1);
    const { idempotency_key: ignored, ...withoutKey } = payload;
    void ignored;
    const first = idempotencyForPayload(null, withoutKey);
    const second = idempotencyForPayload(first, withoutKey);
    expect(second.key).toBe(first.key);
    const changed = idempotencyForPayload(first, { ...withoutKey, file_count: 2 });
    expect(changed.key).not.toBe(first.key);
  });

  it('tells a replay apart from a fresh commit', () => {
    expect(interpretCommit({
      written: false,
      idempotent_replay: true,
      batch: { id: 9 },
      inserted: [],
      skipped: [],
    })).toEqual({ kind: 'replay', batchId: 9, skipped: 0, inserted: 0 });
    expect(interpretCommit({
      written: true,
      idempotent_replay: false,
      batch: { id: 4 },
      inserted: [{ id: 1 }, { id: 2 }],
      skipped: [{ fingerprint: 'x', reason: 'duplicate' }],
    })).toMatchObject({ kind: 'written', batchId: 4, inserted: 2, skipped: 1 });
  });

  it('accepts only the undo phrase and summarizes operations that undo would remove', () => {
    expect(IMPORT_UNDO_PHRASE).toBe('UNDO IMPORT');
    expect(undoPhraseMatches('UNDO IMPORT')).toBe(true);
    expect(undoPhraseMatches('undo import')).toBe(false);
    expect(undoPhraseMatches('RESET')).toBe(false);
    const removal = summarizeRemoval([
      { id: 1, account_id: 1, amount_minor: -2500, fingerprint: 'a' },
      { id: 2, account_id: 1, amount_minor: 900, fingerprint: 'b' },
    ], ACCOUNTS);
    expect(removal.count).toBe(2);
    expect(removal.groups[0]).toMatchObject({ accountName: 'Checking', currency: 'USD', amountMinor: -1600 });
  });
});

describe('category rules editor', () => {
  const rules = [
    { id: 2, pattern: 'RENT', match_field: 'description', category: 'Home', subcategory: null, priority: 20 },
    { id: 1, pattern: 'CAFE', match_field: 'merchant', category: 'Food', subcategory: 'Cafe', priority: 10 },
  ];

  it('collects categories already used by operations, plans, and rules', () => {
    const catalog = categoryCatalog({
      operations: [{ category: 'Food', subcategory: 'Cafe' }, { category: 'Food', subcategory: 'Market' }],
      planned: [{ category: 'Home', subcategory: '' }],
      recurring: [],
      rules,
    });
    expect(catalog.categories).toEqual(['Food', 'Home']);
    expect(catalog.byCategory.Food).toEqual(['Cafe', 'Market']);
  });

  it('swaps priority with the neighbour and validates a draft before save', () => {
    expect(priorityMove(rules, 2, 'up')).toEqual([
      { id: 2, priority: 10 },
      { id: 1, priority: 20 },
    ]);
    expect(priorityMove(rules, 1, 'up')).toEqual([]);
    expect(validateRuleDraft({ pattern: 'CAFE', matchField: 'merchant', category: 'Food', subcategory: 'Cafe', priority: 10 })).toBe(null);
    expect(validateRuleDraft({ pattern: '', matchField: 'any', category: 'Food', subcategory: '', priority: 10 })).toBe('pattern');
    expect(validateRuleDraft({ pattern: 'X', matchField: 'any', category: '', subcategory: 'Cafe', priority: 10 })).toBe('category');
    expect(rulePayload({ pattern: ' CAFE ', matchField: 'any', category: 'Food', subcategory: '', priority: '10' })).toEqual({
      pattern: 'CAFE',
      match_field: 'any',
      category: 'Food',
      subcategory: null,
      priority: 10,
    });
  });

  it('asks before deleting a rule and does not ask for the undo phrase', () => {
    const html = renderToStaticMarkup(React.createElement(CategoryRulesPanel, {
      rules,
      catalog: { categories: ['Food', 'Home'], byCategory: { Food: ['Cafe'], Home: [] } },
      draft: { pattern: '', matchField: 'any', category: '', subcategory: '', priority: 30 },
      setDraft: () => {},
      editingId: null,
      busy: false,
      error: null,
      formError: null,
      pendingDelete: rules[1],
      onSubmit: () => {},
      onCancelEdit: () => {},
      onEdit: () => {},
      onAskDelete: () => {},
      onCloseDelete: () => {},
      onConfirmDelete: () => {},
      onMove: () => {},
    }));
    expect(html).toContain(i18n.t('data.statementImport.ruleDeleteTitle'));
    expect(html).toContain(i18n.t('data.statementImport.ruleDeleteWarning', { pattern: 'CAFE' }));
    expect(html).toContain(i18n.t('data.statementImport.ruleDelete'));
    expect(html).not.toContain('UNDO IMPORT');
    expect(html).toContain('CAFE');
    expect(html).toContain(i18n.t('data.statementImport.matchField.merchant'));
    expect(html).toContain('list="rule-category-list"');
    expect(html).toContain(i18n.t('data.statementImport.newCategory'));
  });
});

describe('statement import screen', () => {
  const limits = LIMITS;
  const baseProps = {
    limits,
    presets: [{ id: 'us-bofa', label: 'Bank of America', format: 'csv' }, { id: 'rs-bps', label: 'Banka Poštanska štedionica', format: 'xls' }],
    presetId: 'auto',
    onPreset: () => {},
    categoryMode: 'manual',
    onCategoryMode: () => {},
    files: [],
    onAddFiles: () => {},
    onRemoveFile: () => {},
    onFilePreset: () => {},
    mapping: { date: 'Date', amount: 'Amount', debit: '', credit: '', currency: '', description: 'Description', merchant: '', counterparty: '', reference: '', balance: '' },
    setMapping: () => {},
    options: { delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', encoding: 'utf-8', hasHeader: true, defaultCurrency: '' },
    setOptions: () => {},
    rows: [],
    accounts: ACCOUNTS,
    catalog: { categories: ['Food'], byCategory: { Food: ['Cafe'] } },
    onAccount: () => {},
    onInclude: () => {},
    onCategory: () => {},
    onPreview: () => {},
    onClear: () => {},
    onReview: () => {},
    busy: null,
    localError: null,
    message: null,
    history: [],
    openBatchId: null,
    batchDetail: null,
    onToggleBatch: () => {},
    onAskUndo: () => {},
    confirmOpen: false,
    summary: { count: 0, groups: [] },
    idempotencyKey: '',
    confirmError: null,
    onCloseConfirm: () => {},
    onConfirm: () => {},
    undoBatch: null,
    undoRemoval: { count: 0, groups: [] },
    undoPhrase: '',
    onUndoPhrase: () => {},
    undoError: null,
    onCloseUndo: () => {},
    onUndo: () => {},
    onToggleExpanded: () => {},
  };

  it('renders the Data-section importer with limits, presets, and history', () => {
    const html = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, baseProps)));
    expect(html).toContain('id="import"');
    expect(html).toContain(i18n.t('data.statementImport.title'));
    expect(html).toContain(i18n.t('data.statementImport.limits', {
      files: 8,
      fileSize: '1 MiB',
      rows: 2000,
      bodySize: '10.7 MiB',
    }));
    expect(html).toContain('Bank of America');
    expect(html).toContain('Banka Poštanska štedionica');
    expect(html).toContain('type="file"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(i18n.t('data.statementImport.historyEmpty'));
    expect(html).toContain(i18n.t('data.statementImport.rulesTitle'));
    expect(tabFromHash('#/data/import')).toBe('data');
  });

  it('lists built-in templates and can save a manual mapping', () => {
    const html = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      presetId: 'generic',
      expanded: true,
    })));
    expect(html).toContain(i18n.t('data.statementImport.templatesTitle'));
    expect(html).toContain(i18n.t('data.statementImport.templatesBuiltin'));
    expect(html).toContain(i18n.t('data.statementImport.templatesMine'));
    expect(html).toContain(i18n.t('data.statementImport.templateDuplicate'));
    expect(html).toContain(i18n.t('data.statementImport.templateExport'));
    expect(html).toContain(i18n.t('data.statementImport.templateImport'));
    expect(html).toContain(i18n.t('data.statementImport.templateSaveMapping'));
    expect(html).toContain('Bank of America');
    const saved = templateFromMapping({
      id: 'city-bank',
      label: 'City bank',
      mapping: baseProps.mapping,
      options: baseProps.options,
    });
    expect(inspectTemplateDocument(saved).ok).toBe(true);
    expect(templateFileName('city-bank')).toBe('city-bank.json');
    const mine = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      presets: [
        ...baseProps.presets.map((preset) => ({ ...preset, source: 'builtin' })),
        { id: 'city-bank', label: 'City bank', format: 'csv', source: 'user' },
      ],
    })));
    expect(mine).toContain(i18n.t('data.statementImport.templatesMine'));
    expect(mine).toContain('City bank');
  });

  it('shows duplicate rows excluded and the own-account hint', () => {
    const rows = rowsFromPreview(previewFixture());
    const html = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      categoryMode: 'rules',
      rows,
      files: [{ id: 'file-1', name: 'sample.csv', size: 32, presetId: 'auto' }],
    })));
    expect(html).toContain('data-included="yes"');
    expect(html).toContain('data-included="no"');
    expect(html).toContain('data-duplicate="yes"');
    expect(html).toContain(i18n.t('data.statementImport.duplicate'));
    expect(html).toContain(i18n.t('data.statementImport.duplicateReason.bank_transaction_id'));
    expect(html).toContain(i18n.t('data.statementImport.ownTransfer'));
    expect(html).toContain('Food');
    expect(html).toContain('list="category-0:0:0"');
    expect(html).toContain(i18n.t('data.statementImport.newCategory'));
    expect(html).toContain(i18n.t('data.statementImport.accountMatched', { via: i18n.t('data.statementImport.match.iban') }));
  });

  it('lists remaining operations in the undo dialog and uses the empty text only at zero', () => {
    const batch = { id: 1, status: 'committed', row_count: 118, file_count: 1, created_at: '2026-11-04T14:00:00Z' };
    const active = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      undoBatch: batch,
      undoRemoval: {
        count: 118,
        groups: [{ accountId: 1, accountName: 'Everyday Checking', currency: 'USD', count: 118, amountMinor: -58600 }],
      },
    })));
    expect(active).toContain(i18n.t('data.statementImport.undoWillRemove'));
    expect(active).toContain(i18n.t('data.statementImport.undoLine', {
      account: 'Everyday Checking',
      count: 118,
      amount: formatMinor(-58600, 'USD'),
    }));
    expect(active).not.toContain(i18n.t('data.statementImport.undoEmpty'));

    const undone = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      undoBatch: { ...batch, status: 'undone' },
      undoRemoval: { count: 0, groups: [] },
    })));
    expect(undone).toContain(i18n.t('data.statementImport.undoEmpty'));
  });

  it('shows the account currency when the file did not name one', () => {
    const rows = rowsFromPreview({
      files: [{
        filename: 'boa.csv',
        format: 'csv',
        warnings: [],
        statements: [{
          account_ref: null,
          statement_currency: 'USD',
          account_id: 1,
          account_currency: 'USD',
          match: 'explicit',
          warnings: [],
          rows: [{
            index: 1,
            date: '2026-04-23',
            amount_minor: -1245,
            currency: 'USD',
            currency_from_account: true,
            description: 'ACME COFFEE',
            merchant: null,
            counterparty: null,
            bank_transaction_id: null,
            kind: 'expense',
            duplicate: false,
            duplicate_in_batch: false,
            duplicate_reason: null,
            possible_own_account_transfer: false,
            currency_mismatch: false,
            proposed_category: null,
            proposed_subcategory: null,
            category_rule_id: null,
            warnings: [],
          }],
        }],
      }],
    });
    expect(rows[0].currencyFromAccount).toBe(true);
    const html = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      expanded: true,
      rows,
      files: [{ id: 'file-1', name: 'boa.csv', size: 40, presetId: 'my-boa', accountId: 1 }],
    })));
    expect(html).toContain(i18n.t('data.statementImport.currencyFromAccount', { currency: 'USD' }));
    expect(html).toContain('Account for boa.csv');
    const moved = withStatementAccount(rows, '0:0', 1, ACCOUNTS);
    expect(moved[0].currency).toBe('USD');
    expect(moved[0].currencyMismatch).toBe(false);
    expect(preselectDateFormat(
      'Date,Description,Amount\n04/23/2026,ACME,-12.45\n',
      { date: 'Date', amount: 'Amount', description: 'Description' },
      { delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', encoding: 'utf-8', hasHeader: true, defaultCurrency: 'USD' },
    ).dateFormat).toBe('MM/DD/YYYY');
  });

  it('warns before commit when an existing duplicate expense is included', () => {
    const parsed = rowsFromPreview({
      files: [{
        filename: 'sample.csv',
        format: 'csv',
        warnings: [],
        statements: [{
          account_ref: null,
          statement_currency: 'USD',
          account_id: 1,
          account_currency: 'USD',
          match: 'explicit',
          warnings: [],
          rows: [{
            index: 0,
            date: '2026-02-01',
            amount_minor: -900,
            currency: 'USD',
            description: 'MARKET',
            merchant: 'Market',
            counterparty: null,
            bank_transaction_id: null,
            kind: 'expense',
            duplicate: true,
            duplicate_in_batch: false,
            duplicate_reason: 'expense_duplicate',
            possible_own_account_transfer: false,
            currency_mismatch: false,
            proposed_category: null,
            proposed_subcategory: null,
            category_rule_id: null,
            warnings: [],
          }],
        }],
      }],
    });
    expect(parsed[0].include).toBe(false);
    const included = withInclude(parsed, '0:0:0', true);
    expect(existingExpenseDuplicateRows(included)).toHaveLength(1);
    expect(describeStatementRows(included)).toBe('2026-02-01 MARKET');
    expect(buildCommitRow({ ...included[0], category: '  Groceries  ', subcategory: '  Store  ' }).category).toBe('Groceries');
    const html = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      rows: included,
      confirmOpen: true,
      summary: { count: 1, groups: [] },
      idempotencyKey: 'key-1',
    })));
    expect(html).toContain(i18n.t('data.statementImport.duplicateExpenseIncluded'));
    expect(html).toContain(i18n.t('data.statementImport.duplicateExpenseBeforeCommit', {
      count: 1,
      unit: i18n.t('plural.row', { count: 1 }),
      rows: '2026-02-01 MARKET',
    }));
  });

  it('keeps the import result in the dialog and describes a batch', async () => {
    const resultHtml = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      expanded: true,
      confirmOpen: true,
      confirmResult: { kind: 'written', batchId: 4, inserted: 2, skipped: 1, errors: 0 },
      summary: { count: 2, groups: [] },
    })));
    expect(resultHtml).toContain(i18n.t('data.statementImport.resultTitle'));
    expect(resultHtml).toContain(i18n.t('data.statementImport.resultImported', {
      count: 2,
      unit: i18n.t('plural.row', { count: 2 }),
    }));
    expect(resultHtml).toContain(i18n.t('data.statementImport.resultSkipped', {
      count: 1,
      unit: i18n.t('plural.row', { count: 1 }),
    }));
    expect(resultHtml).toContain(i18n.t('data.statementImport.resultErrors', { count: 0 }));
    expect(resultHtml).toContain(i18n.t('common.done'));
    expect(resultHtml).not.toContain(`>${i18n.t('data.statementImport.confirmAction')}</button>`);

    const detail = {
      batch: {
        id: 4,
        status: 'committed',
        row_count: 1,
        file_count: 1,
        created_at: '2026-10-29T21:50:00Z',
        undone_at: null,
        files: [{ filename: 'statement.csv', preset_id: 'us-bofa' }],
      },
      operations: [{
        id: 9,
        date: '2026-03-04',
        description: 'ACME COFFEE',
        category: 'Food',
        subcategory: null,
        kind: 'expense',
        amount_minor: -1245,
        account_id: 1,
        account_name: 'Checking',
        currency: 'USD',
      }],
    };
    expect(describeImportBatch(detail).emptyReason).toBeNull();
    expect(describeImportBatch({
      batch: { status: 'committed', row_count: 44, files: [] },
      operations: [],
    }).emptyReason).toBe('unlinked');
    expect(describeImportBatch({
      batch: { status: 'undone', row_count: 2, undone_at: '2026-10-29T22:00:00Z', files: [] },
      operations: [],
    }).emptyReason).toBe('undone');
    const html = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      expanded: true,
      history: [{
        id: 4,
        file_count: 1,
        row_count: 1,
        status: 'committed',
        created_at: '2026-10-29T21:50:00Z',
      }],
      openBatchId: 4,
      batchDetail: detail,
    })));
    expect(html).toContain('statement.csv');
    expect(html).toContain(i18n.t('data.statementImport.detailUndoLine', {
      status: i18n.t('data.statementImport.detailUndoNotUndone'),
    }));
    expect(html).toContain(i18n.t('data.statementImport.detailCurrencyLine', {
      currency: 'USD',
      expenses: formatMinor(-1245, 'USD'),
      income: formatMinor(0, 'USD'),
    }));
    expect(html).toContain('Bank of America');
    expect(html).toContain('ACME COFFEE');
    expect(html).toContain('Checking');
    expect(html).toContain(i18n.t('plural.file', { count: 1 }));
    await i18n.changeLanguage('ru');
    expect(i18n.t('plural.file', { count: 1 })).toBe('файл');
    expect(i18n.t('plural.file', { count: 2 })).toBe('файла');
    expect(i18n.t('plural.file', { count: 5 })).toBe('файлов');
    expect(i18n.t('plural.file', { count: 21 })).toBe('файл');
    await i18n.changeLanguage('sr');
    expect(i18n.t('plural.file', { count: 1 })).toBe('fajl');
    expect(i18n.t('plural.file', { count: 2 })).toBe('fajla');
    expect(i18n.t('plural.file', { count: 5 })).toBe('fajlova');
    await i18n.changeLanguage('en');
  });

  it('shows IMPORT_TOO_LARGE with the translated scope', () => {
    const html = renderToStaticMarkup(React.createElement(RefreshProvider, null, React.createElement(StatementImportView, {
      ...baseProps,
      localError: { code: 'IMPORT_TOO_LARGE', scope: 'file', limit: 262144, name: 'huge.csv' },
    })));
    expect(html).toContain('huge.csv');
    expect(html).toContain(i18n.t('errors.IMPORT_TOO_LARGE', {
      scope: i18n.t('data.statementImport.limitScope.file'),
      limit: '256 KiB',
    }));
  });
});
