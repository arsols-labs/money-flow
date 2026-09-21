#!/usr/bin/env node
/**
 * Stranger / CI fingerprint gate for the public cut.
 * Fails if private-reserved-names inventory is non-empty OR known kitchen
 * host/id strings appear outside intentional allowlisted meta files.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const overlayPath = join(
  root,
  'app/scripts/lib/cloudflare-setup/private-reserved-names.mjs',
);

const overlay = await import(pathToFileURL(overlayPath).href);
const inventories = [
  ['RESERVED_PRODUCTION_RESOURCE_IDS', overlay.RESERVED_PRODUCTION_RESOURCE_IDS],
  ['RESERVED_PRODUCTION_HOST_MARKERS', overlay.RESERVED_PRODUCTION_HOST_MARKERS],
  ['RESERVED_PRODUCTION_WORKERS_DEV_LABELS', overlay.RESERVED_PRODUCTION_WORKERS_DEV_LABELS],
  ['RESERVED_PRODUCTION_D1_NAMES', overlay.RESERVED_PRODUCTION_D1_NAMES],
  ['RESERVED_PRODUCTION_RATE_LIMIT_IDS', overlay.RESERVED_PRODUCTION_RATE_LIMIT_IDS],
];

let failed = false;
for (const [name, value] of inventories) {
  if (!Array.isArray(value) || value.length !== 0) {
    console.error(`FAIL: ${name} must be empty for public cut (got ${JSON.stringify(value)})`);
    failed = true;
  }
}
if (overlay.RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT) {
  console.error(
    `FAIL: RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT must be empty (got ${JSON.stringify(overlay.RESERVED_PRODUCTION_WORKERS_DEV_ACCOUNT)})`,
  );
  failed = true;
}

const kitchenNeedles = [
  'utgardar.net',
  'ar-solutions.workers.dev',
  'money-flow.utgardar',
  '9b3f81f4-3647-4aeb-8bec-fc9783b9cb47',
  '8cf6e433bea4491c8732058208354518',
  '30d4c520-24ec-4efa-836a-b8c3202a6195',
  'fc548906cede48118eff69aecae6570f',
  'money-flow-v2-db',
  'money-flow-v2-preview',
];

const skipDirs = new Set(['node_modules', '.git', 'dist', '.wrangler', 'coverage']);
const binaryExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.pdf']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allowRel = new Set([
  relative(root, overlayPath),
  'scripts/assert-public-fingerprints.mjs',
  'OVERLAY.md',
  'MANIFEST.md',
]);

for (const file of walk(root)) {
  const rel = relative(root, file);
  if (allowRel.has(rel)) continue;
  if (rel.endsWith('package-lock.json')) continue;
  const ext = rel.slice(rel.lastIndexOf('.'));
  if (binaryExt.has(ext)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lower = text.toLowerCase();
  for (const needle of kitchenNeedles) {
    if (lower.includes(needle.toLowerCase())) {
      console.error(`FAIL: kitchen fingerprint "${needle}" in ${rel}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log('OK: public fingerprint assert passed (empty reserved inventory; no kitchen needles).');
