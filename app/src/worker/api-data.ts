// Data-area instance reset (issue #579). Session guard lives on the parent
// /api/v2 app — these routes inherit it.
import { Hono } from 'hono';
import type { Env } from './types';
import { AppError, fail, failCaught } from './api-error';
import { parseResetConfirmation, resetUserState } from './backup';

const dataApi = new Hono<{ Bindings: Env }>();

dataApi.post('/reset', async (c) => {
  try {
    const raw = await c.req.json().catch(() => null);
    parseResetConfirmation(raw);
    const result = await resetUserState(c.env.DB);
    return c.json(result);
  } catch (error) {
    if (error instanceof AppError) return failCaught(c, error);
    return fail(c, 'RESET_FAILED', 500);
  }
});

export default dataApi;
