import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('demo session schema imports', () => {
  it('imports every migration file so the demo ledger matches D1', () => {
    const migrationsDir = path.join(appRoot, 'migrations');
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    const source = readFileSync(path.join(appRoot, 'src/worker/demo-session.ts'), 'utf8');
    for (const file of files) {
      assert.match(source, new RegExp(`migrations/${file.replace(/[.]/g, '\\.')}`));
    }
  });

  it('keeps the duplicate-expense lookup on operations only', () => {
    const source = readFileSync(path.join(appRoot, 'src/worker/duplicate-expense.ts'), 'utf8');
    assert.doesNotMatch(source, /purchase_order/);
    assert.match(source, /FROM operations/);
  });
});
