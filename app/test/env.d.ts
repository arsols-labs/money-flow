// Тип `env` в тестах — это `Cloudflare.Env`; workers-types объявляет его
// пустым и рассчитывает, что проект дообъявит свои bindings. Здесь — то, что
// поднимает vitest.config.ts: реальный binding DB из wrangler.jsonc плюс
// тестовый TEST_MIGRATIONS.
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KV: KVNamespace;
      OAUTH_KV: KVNamespace;
      TEST_MIGRATIONS: D1Migration[];
      // Нужен createSessionCookie/verifySessionCookie в test/api-v2.test.ts (S1-2).
      SESSION_SECRET: string;
      // Фиктивный SETUP_TOKEN для тестов регистрации WebAuthn.
      SETUP_TOKEN: string;
      // Содержимое src/ui/styles.css — его разбирает test/palette.test.ts.
      PALETTE_CSS: string;
    }
  }
}

export {};
