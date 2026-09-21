// Каждая тестовая изоляция получает свежую D1 с применённой схемой.
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
