import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('statement template files', () => {
  it('registers every bank JSON file in the template loader', () => {
    const dir = path.join(appRoot, 'src/shared/statement-import/templates');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'statement-template.schema.json');
    const source = readFileSync(path.join(appRoot, 'src/shared/statement-import/templates.ts'), 'utf8');
    assert.ok(files.includes('us-bofa.json'));
    assert.ok(files.includes('rs-bps.json'));
    for (const file of files) {
      assert.match(source, new RegExp(file.replace(/\./g, '\\.')));
    }
  });
});
