// Backup export/import API. Session guard lives on the parent
// /api/v2 app — these routes inherit it.
import { Hono } from 'hono';
import type { Env } from './types';
import { AppError, fail, failCaught } from './api-error';
import {
  backupFilename,
  backupOmitsOrderGroupings,
  countOrderGroupings,
  exportUserState,
  importUserState,
  parseBackupDocument,
  presentBackupExport,
} from './backup';

const backupApi = new Hono<{ Bindings: Env }>();

backupApi.get('/export', async (c) => {
  try {
    const compat = c.req.query('compat');
    if (compat !== undefined && compat !== 'v2.35') return fail(c, 'BACKUP_FORMAT_INVALID', 400);
    const document = await exportUserState(c.env.DB);
    const compatV235 = compat === 'v2.35';
    const presented = presentBackupExport(document, { compatV235 });
    const filename = compatV235
      ? backupFilename(document.exported_at).replace(/\.json$/, '-compat-v235.json')
      : backupFilename(document.exported_at);
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.json(presented);
  } catch (error) {
    if (error instanceof AppError) return failCaught(c, error);
    throw error;
  }
});

backupApi.post('/import', async (c) => {
  try {
    const raw = await c.req.json().catch(() => null);
    const document = parseBackupDocument(raw);
    if (backupOmitsOrderGroupings(document.tables)) {
      const existing = await countOrderGroupings(c.env.DB);
      const removes = existing.purchase_orders > 0 || existing.purchase_order_components > 0;
      const acknowledged = typeof raw === 'object' && raw !== null
        && (raw as { acknowledge_order_removal?: unknown }).acknowledge_order_removal === true;
      if (removes && !acknowledged) {
        return fail(c, 'ORDER_GROUPINGS_REMOVAL_UNCONFIRMED', 409, {
          orders: existing.purchase_orders,
          components: existing.purchase_order_components,
        });
      }
    }
    const result = await importUserState(c.env.DB, document.tables);
    return c.json(result);
  } catch (error) {
    if (error instanceof AppError) return failCaught(c, error);
    return fail(c, 'BACKUP_IMPORT_FAILED', 500);
  }
});

export default backupApi;
