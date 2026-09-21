/**
 * Split a SQL script into individual statements.
 * Semicolons inside quotes or comments are not boundaries.
 */
export function splitSqlStatements(script: string): string[] {
  const source = script.charCodeAt(0) === 0xfeff ? script.slice(1) : script;
  const statements: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
    }
    if (ch === "'" && !inDouble) {
      if (inSingle && next === "'") {
        buf += "''";
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (ch === ';' && !inSingle && !inDouble) {
      const statement = buf.trim();
      if (statement) statements.push(statement);
      buf = '';
      continue;
    }
    buf += ch;
  }

  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}
