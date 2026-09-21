// v2 tests run in real workerd (@cloudflare/vitest-pool-workers), not in Node
// with an emulation layer: D1 comes up locally in miniflare, so the schema
// smoke test does not call a Cloudflare account and works in CI without secrets.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

function sqlTextPlugin() {
  return {
    name: 'sql-text',
    enforce: 'pre' as const,
    async load(id: string) {
      const file = id.split('?')[0] ?? id;
      if (!file.endsWith('.sql')) return null;
      const text = await readFile(file, 'utf8');
      return `export default ${JSON.stringify(text)};`;
    },
  };
}

export default defineConfig({
  plugins: [
    sqlTextPlugin(),
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      // The palette is checked by a test against the CSS itself (issue #252).
      // The file is read here, not in the test: workerd has neither `node:fs`
      // nor a working `?raw` import. That import returns an empty string and
      // the check fails silently.
      // The cost of this approach: the value is captured once when vitest
      // starts. That covers `npm test` and CI, but in watch mode editing the
      // palette alone does not rerun the test or reopen the file. Restart vitest.
      const paletteCss = await readFile(
        path.join(import.meta.dirname, 'src/ui/styles.css'),
        'utf8',
      );
      return {
        // Compatibility date and the DB binding come from wrangler.jsonc.
        // The repository must not keep a second copy of those values.
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // Test binding: the setup file applies the migrations.
            TEST_MIGRATIONS: migrations,
            // Stand-in secret for signing the session cookie in API v2 tests
            // (S1-2). The value is not a secret; this is a test environment.
            SESSION_SECRET: 'test-session-secret-not-a-real-secret',
            SETUP_TOKEN: 'test-setup-token',
            PALETTE_CSS: paletteCss,
          },
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
