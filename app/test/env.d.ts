// The `env` type in tests is `Cloudflare.Env`; workers-types declares it
// empty and expects the project to declare its own bindings. Here is what
// vitest.config.ts sets up: the real DB binding from wrangler.jsonc plus
// the test TEST_MIGRATIONS.
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KV: KVNamespace;
      OAUTH_KV: KVNamespace;
      TEST_MIGRATIONS: D1Migration[];
      // Needed by createSessionCookie/verifySessionCookie in test/api-v2.test.ts (S1-2).
      SESSION_SECRET: string;
      // Dummy SETUP_TOKEN for WebAuthn registration tests.
      SETUP_TOKEN: string;
      // Contents of src/ui/styles.css — parsed by test/palette.test.ts.
      PALETTE_CSS: string;
    }
  }
}

export {};
