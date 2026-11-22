import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('statement template files', () => {
  it('ships no built-in bank JSON files in code', () => {
    const dir = path.join(appRoot, 'src/shared/statement-import/templates');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'statement-template.schema.json');
    const source = readFileSync(path.join(appRoot, 'src/shared/statement-import/templates.ts'), 'utf8');
    assert.deepEqual(files, []);
    assert.doesNotMatch(source, /us-bofa\.json|rs-bps\.json/);
  });
});
