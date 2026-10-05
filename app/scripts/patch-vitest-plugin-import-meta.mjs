// @cloudflare/vitest-plugin@1.3.6 rewrites every `import.meta.url` textually
// before workerd parses a module. Vitest 5 stores that text inside a string
// hint in dist/module-evaluator.js. The blind replace closes the string and
// workerd reports SyntaxError: Unexpected identifier 'file'.
// Real `import.meta.url` expressions must still be rewritten; text inside
// quotes must not. Remove this script when a plugin release stops rewriting
// string contents.
import { readFileSync, writeFileSync } from 'node:fs';

const MARKER = 'string-aware import.meta.url rewrite';
const target = new URL(
  '../node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs',
  import.meta.url,
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

const source = readFileSync(target, 'utf8');
if (source.includes(MARKER)) {
  process.exit(0);
}
if (!source.includes(naive)) {
  console.error(
    `patch-vitest-plugin-import-meta: ${target} no longer contains the expected withImportMetaUrl. Update the patch or drop it if the plugin already skips string literals.`,
  );
  process.exit(1);
}
writeFileSync(target, source.replace(naive, patched));
