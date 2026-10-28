// @cloudflare/vitest-plugin@1.3.6 rewrote every `import.meta.url` textually
// before workerd parsed a module. Vitest 5 stores that text inside a string
// hint in dist/module-evaluator.js. The blind replace closed the string and
// workerd reported SyntaxError: Unexpected identifier 'file'.
//
// @cloudflare/vitest-plugin@1.4.x fixed this upstream: withImportMetaUrl now
// uses es-module-lexer and only rewrites real `import.meta.url` expressions.
// This script therefore handles three known states and fails on anything else:
//   1. upstream lexer-based rewrite (1.4.x+)  -> no-op
//   2. already patched by this script          -> no-op (idempotent)
//   3. naive textual replaceAll (1.3.x)        -> apply the string-aware patch
// Remove this script (and the postinstall hook) once 1.3.x is no longer
// supported anywhere in the repo.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = 'patch-vitest-plugin-import-meta';
const MARKER = 'string-aware import.meta.url rewrite';
const target = fileURLToPath(
  new URL(
    '../node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs',
    import.meta.url,
  ),
);

const naive = `function withImportMetaUrl(contents, url$2) {
	return contents.replaceAll("import.meta.url", JSON.stringify(url$2.toString()));
}`;

const patched = `function withImportMetaUrl(contents, url$2) {
	// ${MARKER}: Vitest 5 keeps import.meta.url inside string hints.
	const replacement = JSON.stringify(url$2.toString());
	const needle = "import.meta.url";
	let out = "";
	let quote = null;
	let escaped = false;
	for (let i = 0; i < contents.length; i++) {
		const ch = contents[i];
		if (quote) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\\\") escaped = true;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\\"" || ch === "'" || ch === "\`") {
			quote = ch;
			out += ch;
			continue;
		}
		if (contents.startsWith(needle, i)) {
			out += replacement;
			i += needle.length - 1;
			continue;
		}
		out += ch;
	}
	return out;
}`;

/** Returns the source text of withImportMetaUrl, or null if absent. */
export function extractWithImportMetaUrl(source) {
  const start = source.search(/(?:async\s+)?function\s+withImportMetaUrl\s*\(/);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Classifies the plugin bundle.
 * @returns {'patched' | 'naive' | 'upstream-fixed' | 'unknown'}
 */
export function classify(source) {
  if (source.includes(MARKER)) return 'patched';
  if (source.includes(naive)) return 'naive';
  const fn = extractWithImportMetaUrl(source);
  if (
    fn &&
    !/replaceAll\(\s*["']import\.meta\.url["']/.test(fn) &&
    // es-module-lexer marks `import.meta` with d === -2.
    /\.d\s*!==\s*-2/.test(fn)
  ) {
    return 'upstream-fixed';
  }
  return 'unknown';
}

function main() {
  if (!existsSync(target)) {
    // Dev dependencies are not installed (e.g. `npm ci --omit=dev`).
    console.log(`${TAG}: @cloudflare/vitest-plugin is not installed; nothing to patch.`);
    return 0;
  }
  const source = readFileSync(target, 'utf8');
  const state = classify(source);
  switch (state) {
    case 'patched':
      return 0;
    case 'upstream-fixed':
      console.log(
        `${TAG}: plugin already rewrites only real import.meta.url expressions (es-module-lexer); no patch needed.`,
      );
      return 0;
    case 'naive':
      writeFileSync(target, source.replace(naive, patched));
      if (classify(readFileSync(target, 'utf8')) !== 'patched') {
        console.error(`${TAG}: failed to apply the patch to ${target}.`);
        return 1;
      }
      console.log(`${TAG}: applied string-aware import.meta.url rewrite.`);
      return 0;
    default:
      console.error(
        `${TAG}: ${target} has an unrecognized withImportMetaUrl. ` +
          'Neither the 1.3.x textual replaceAll nor the 1.4.x es-module-lexer rewrite matched. ' +
          'Check whether the plugin still rewrites import.meta.url inside string literals, then update or drop this patch.',
      );
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
