import { normalizeIso4217CurrencyCode } from '../currency';
import {
  assertRowBudget,
  kindFromSignedAmount,
  parseMajorToMinor,
  parseStatementDate,
} from './amounts';
import {
  type ParsedStatement,
  type StatementRow,
  StatementLimitError,
  StatementParseError,
} from './types';

const DEBIT_TYPES = new Set([
  'DEBIT', 'POS', 'FEE', 'SRVCHG', 'CHECK', 'ATM', 'CASH', 'DIRECTDEBIT', 'REPEATPMT',
]);
const CREDIT_TYPES = new Set(['CREDIT', 'DEP', 'INT', 'DIV', 'DIRECTDEP']);

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  if (!match) return null;
  const value = match[1]!.trim();
  return value.length > 0 ? value : null;
}

function ofxDate(raw: string | null): string {
  if (!raw) throw new StatementParseError('OFX date is missing');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) throw new StatementParseError(`invalid OFX date "${raw}"`);
  const compact = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return parseStatementDate(compact, 'YYYY-MM-DD');
}

function splitTransactions(section: string): string[] {
  const blocks: string[] = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|$)/gi;
  for (const match of section.matchAll(re)) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

function statementSections(text: string): string[] {
  const sections = text.split(/<STMTRS>|<CCSTMTRS>/i).slice(1);
  return sections.length > 0 ? sections : [text];
}

export function parseOfx(text: string): ParsedStatement[] {
  const source = text.replace(/^\uFEFF/, '');
  if (!/<OFX|<STMTTRN/i.test(source)) {
    throw new StatementParseError('OFX document was not recognized');
  }
  const statements: ParsedStatement[] = [];
  let total = 0;
  for (const section of statementSections(source)) {
    const currency = normalizeIso4217CurrencyCode(tagValue(section, 'CURDEF') ?? '');
    const accountRef = tagValue(section, 'ACCTID');
    const rows: StatementRow[] = [];
    const warnings: string[] = [];
    const blocks = splitTransactions(section);
    blocks.forEach((block, index) => {
      const sourceIndex = index + 1;
      try {
        if (!currency) throw new StatementParseError('OFX currency is missing or not ISO 4217');
        const rawAmount = tagValue(block, 'TRNAMT');
        if (!rawAmount) throw new StatementParseError('TRNAMT is missing');
        let amountMinor = parseMajorToMinor(rawAmount, '.', currency);
        const trnType = (tagValue(block, 'TRNTYPE') ?? '').toUpperCase();
        if (DEBIT_TYPES.has(trnType) && amountMinor > 0) amountMinor = -amountMinor;
        if (CREDIT_TYPES.has(trnType) && amountMinor < 0) amountMinor = -amountMinor;
        if (amountMinor === 0) {
          warnings.push(`transaction ${sourceIndex} skipped: amount is zero`);
          return;
        }
        const name = tagValue(block, 'NAME');
        const memo = tagValue(block, 'MEMO');
        const description = memo || name || 'Statement line';
        const fitid = tagValue(block, 'FITID');
        rows.push({
          sourceIndex,
          date: ofxDate(tagValue(block, 'DTPOSTED') ?? tagValue(block, 'DTUSER')),
          valueDate: null,
          amountMinor,
          currency,
          description,
          merchant: name,
          counterparty: null,
          reference: tagValue(block, 'CHECKNUM'),
          bankTransactionId: fitid,
          balanceMinor: null,
          kind: kindFromSignedAmount(amountMinor),
          warnings: [],
          possibleOwnAccountTransfer: false,
        });
        total += 1;
        assertRowBudget(total);
      } catch (error) {
        if (error instanceof StatementLimitError) throw error;
        const detail = error instanceof Error ? error.message : 'invalid transaction';
        warnings.push(`transaction ${sourceIndex} skipped: ${detail}`);
      }
    });
    if (rows.length > 0 || accountRef || currency) {
      statements.push({
        accountRef,
        currency,
        rows,
        warnings,
      });
    }
  }
  if (statements.length === 0) {
    throw new StatementParseError('OFX document has no statement');
  }
  return statements;
}
