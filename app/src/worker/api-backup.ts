// Backup export/import API (issue #515). Session guard lives on the parent
// /api/v2 app — these routes inherit it.
import { Hono } from 'hono';
import type { Env } from './types';
import { AppError, fail, failCaught } from './api-error';
import {
  backupFilename,
  exportUserState,
  importUserState,
  parseBackupDocument,
} from './backup';

const backupApi = new Hono<{ Bindings: Env }>();

backupApi.get('/export', async (c) => {
  const document = await exportUserState(c.env.DB);
  const filename = backupFilename(document.exported_at);
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.json(document);
});

backupApi.post('/import', async (c) => {
  try {
    const raw = await c.req.json().catch(() => null);
    const document = parseBackupDocument(raw);
    const result = await importUserState(c.env.DB, document.tables);
    return c.json(result);
  } catch (error) {
    if (error instanceof AppError) return failCaught(c, error);
    return fail(c, 'BACKUP_IMPORT_FAILED', 500);
  }
});

export default backupApi;
