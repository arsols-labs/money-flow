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

interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  text: string;
}

function localName(raw: string): string {
  const name = raw.trim();
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Small XML reader for ISO 20022 documents. Namespaces are stripped to the local name. */
export function parseXml(source: string): XmlEl {
  const xml = source.replace(/^\uFEFF/, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) => text);
  let i = 0;
  function skipDeclarationAndComments(): void {
    while (i < xml.length) {
      if (xml.startsWith('<?', i)) {
        const end = xml.indexOf('?>', i);
        if (end < 0) throw new StatementParseError('XML declaration is not closed');
        i = end + 2;
        continue;
      }
      if (xml.startsWith('<!--', i)) {
        const end = xml.indexOf('-->', i);
        if (end < 0) throw new StatementParseError('XML comment is not closed');
        i = end + 3;
        continue;
      }
      if (xml[i] === ' ' || xml[i] === '\n' || xml[i] === '\r' || xml[i] === '\t') {
        i += 1;
        continue;
      }
      break;
    }
  }
  function parseElement(): XmlEl {
    skipDeclarationAndComments();
    if (xml[i] !== '<') throw new StatementParseError('XML element was expected');
    i += 1;
    const start = i;
    while (i < xml.length && xml[i] !== '>' && xml[i] !== ' ' && xml[i] !== '\n' && xml[i] !== '\t' && xml[i] !== '/') {
      i += 1;
    }
    const name = localName(xml.slice(start, i));
    const attrs: Record<string, string> = {};
    while (i < xml.length && xml[i] !== '>' && xml[i] !== '/') {
      while (xml[i] === ' ' || xml[i] === '\n' || xml[i] === '\t' || xml[i] === '\r') i += 1;
      if (xml[i] === '>' || xml[i] === '/') break;
      const attrStart = i;
      while (i < xml.length && xml[i] !== '=' && xml[i] !== ' ' && xml[i] !== '>') i += 1;
      const attrName = localName(xml.slice(attrStart, i));
      while (xml[i] === ' ') i += 1;
      if (xml[i] !== '=') throw new StatementParseError('XML attribute is malformed');
      i += 1;
      while (xml[i] === ' ') i += 1;
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") throw new StatementParseError('XML attribute value is not quoted');
      i += 1;
      const valueStart = i;
      while (i < xml.length && xml[i] !== quote) i += 1;
      attrs[attrName] = xml.slice(valueStart, i);
      i += 1;
    }
    if (xml[i] === '/') {
      i += 2;
      return { name, attrs, children: [], text: '' };
    }
    if (xml[i] !== '>') throw new StatementParseError('XML tag is not closed');
    i += 1;
    const children: XmlEl[] = [];
    let text = '';
    while (i < xml.length) {
      if (xml.startsWith(`</`, i)) {
        const close = xml.indexOf('>', i);
        const closeName = localName(xml.slice(i + 2, close));
        if (closeName !== name) throw new StatementParseError(`XML close tag ${closeName} does not match ${name}`);
        i = close + 1;
        return { name, attrs, children, text: text.trim() };
      }
      if (xml[i] === '<') {
        if (xml.startsWith('<!--', i) || xml.startsWith('<?', i)) {
          skipDeclarationAndComments();
          continue;
        }
        children.push(parseElement());
        continue;
      }
      const next = xml.indexOf('<', i);
      const chunk = xml.slice(i, next < 0 ? xml.length : next);
      text += chunk;
      i = next < 0 ? xml.length : next;
    }
    throw new StatementParseError(`XML element ${name} is not closed`);
  }
  const root = parseElement();
  return root;
}

function childrenNamed(el: XmlEl, name: string): XmlEl[] {
  return el.children.filter((child) => child.name === name);
}

function firstChild(el: XmlEl | null, name: string): XmlEl | null {
  if (!el) return null;
  return el.children.find((child) => child.name === name) ?? null;
}

function descendantText(el: XmlEl | null, path: string[]): string {
  let current = el;
  for (const name of path) {
    current = firstChild(current, name);
    if (!current) return '';
  }
  return current?.text.trim() ?? '';
}

function allDescendants(el: XmlEl, name: string, out: XmlEl[] = []): XmlEl[] {
  for (const child of el.children) {
    if (child.name === name) out.push(child);
    allDescendants(child, name, out);
  }
  return out;
}

function bookingDate(entry: XmlEl): string {
  const raw = descendantText(entry, ['BookgDt', 'Dt'])
    || descendantText(entry, ['BookgDt', 'DtTm'])
    || descendantText(entry, ['ValDt', 'Dt'])
    || descendantText(entry, ['ValDt', 'DtTm']);
  if (!raw) throw new StatementParseError('CAMT entry date is missing');
  const day = raw.slice(0, 10);
  return parseStatementDate(day, 'YYYY-MM-DD');
}

export function parseCamt053(text: string): ParsedStatement[] {
  if (!/BkToCstmrStmt|camt\.053/i.test(text)) {
    throw new StatementParseError('CAMT.053 document was not recognized');
  }
  const root = parseXml(text);
  const statements = allDescendants(root, 'Stmt');
  if (statements.length === 0) throw new StatementParseError('CAMT.053 document has no statement');
  let total = 0;
  return statements.map((stmt) => {
    const iban = descendantText(stmt, ['Acct', 'Id', 'IBAN'])
      || descendantText(stmt, ['Acct', 'Id', 'Othr', 'Id']);
    const statementCurrency = normalizeIso4217CurrencyCode(descendantText(stmt, ['Acct', 'Ccy']));
    const rows: StatementRow[] = [];
    const warnings: string[] = [];
    childrenNamed(stmt, 'Ntry').forEach((entry, index) => {
      const sourceIndex = index + 1;
      try {
        const amountEl = firstChild(entry, 'Amt');
        if (!amountEl) throw new StatementParseError('Amt is missing');
        const currency = normalizeIso4217CurrencyCode(amountEl.attrs.Ccy || statementCurrency || '');
        if (!currency) throw new StatementParseError('entry currency is missing or not ISO 4217');
        const indicator = descendantText(entry, ['CdtDbtInd']).toUpperCase();
        let amountMinor = parseMajorToMinor(amountEl.text, '.', currency);
        if (amountMinor < 0) amountMinor = -amountMinor;
        if (indicator === 'DBIT') amountMinor = -amountMinor;
        else if (indicator !== 'CRDT') throw new StatementParseError('CdtDbtInd must be CRDT or DBIT');
        if (amountMinor === 0) {
          warnings.push(`entry ${sourceIndex} skipped: amount is zero`);
          return;
        }
        const acctSvcrRef = descendantText(entry, ['AcctSvcrRef']);
        const endToEnd = allDescendants(entry, 'EndToEndId').map((node) => node.text.trim()).find(Boolean) ?? '';
        const bankTransactionId = acctSvcrRef || endToEnd || null;
        const unstructured = allDescendants(entry, 'Ustrd').map((node) => node.text.trim()).filter(Boolean);
        const extra = descendantText(entry, ['AddtlNtryInf']);
        const partyNames = ['Cdtr', 'Dbtr', 'UltmtCdtr', 'UltmtDbtr']
          .map((party) => descendantText(entry, ['NtryDtls', 'TxDtls', 'RltdPties', party, 'Nm'])
            || descendantText(entry, ['NtryDtls', 'TxDtls', 'RltdPties', party, 'Pty', 'Nm']))
          .filter(Boolean);
        const counterparty = indicator === 'DBIT'
          ? (partyNames.find(Boolean) ?? null)
          : (partyNames.find(Boolean) ?? null);
        const description = unstructured.join(' ') || extra || counterparty || 'Statement line';
        rows.push({
          sourceIndex,
          date: bookingDate(entry),
          valueDate: null,
          amountMinor,
          currency,
          description,
          merchant: counterparty,
          counterparty,
          reference: endToEnd || null,
          bankTransactionId,
          balanceMinor: null,
          kind: kindFromSignedAmount(amountMinor),
          warnings: [],
          possibleOwnAccountTransfer: false,
        });
        total += 1;
        assertRowBudget(total);
      } catch (error) {
        if (error instanceof StatementLimitError) throw error;
        const detail = error instanceof Error ? error.message : 'invalid entry';
        warnings.push(`entry ${sourceIndex} skipped: ${detail}`);
      }
    });
    return {
      accountRef: iban || null,
      currency: statementCurrency,
      rows,
      warnings,
    };
  });
}
