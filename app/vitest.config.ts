// Тесты v2 гоняются в настоящем workerd (@cloudflare/vitest-pool-workers), а не
// в node с эмуляцией: D1 поднимается локально в miniflare, поэтому smoke-тест
// схемы не ходит в аккаунт Cloudflare и работает в CI без секретов.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      // Палитра проверяется тестом по самому CSS (issue #252). Файл читается
      // здесь, а не в тесте: внутри workerd нет ни `node:fs`, ни рабочего
      // импорта `?raw` — он отдаёт пустую строку, и проверка молча вырождается.
      // Цена этого приёма: значение снимается один раз при старте vitest. Для
      // `npm test` и CI это всё, но в watch-режиме правка палитры сама по себе
      // тест не перезапустит и не переоткроет файл — vitest перезапустить.
      const paletteCss = await readFile(
        path.join(import.meta.dirname, 'src/ui/styles.css'),
        'utf8',
      );
      return {
        // Compatibility date и binding DB берутся из самого wrangler.jsonc —
        // второй копии этих значений в репозитории быть не должно.
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // Тестовый binding: сами миграции применяет setup-файл.
            TEST_MIGRATIONS: migrations,
            // Фиктивный секрет для подписи сессионной cookie в тестах API v2
            // (S1-2) — значение не секрет, это тестовое окружение, не прод.
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
