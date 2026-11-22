import { readFileSync } from 'node:fs';
import path from 'node:path';

export const STARTER_CURRENCY_RELATIVE_PATH = 'scripts/starter-currency.sql';

export const STARTER_CURRENCY_NOTICE =
  'Starter currency: USD (minor_digits: 2, is_fx_anchor: true) when currency_standards is empty. You can change this starter in Settings and add other currencies there.';

export function starterCurrencyFilePath(cwd) {
  return path.join(cwd, STARTER_CURRENCY_RELATIVE_PATH);
}

export function loadStarterCurrencySql(fromPath) {
  return readFileSync(fromPath, 'utf8');
}
