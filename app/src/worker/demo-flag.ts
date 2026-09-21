/** Public demo gate. Set `DEMO_MODE=1` only on the demo Worker. */
export function isDemoMode(env: { DEMO_MODE?: string } | undefined): boolean {
  return env?.DEMO_MODE === '1';
}

export const DEMO_DISCLAIMER =
  'This is a public demo, not production data. Changes stay in this browser session. The Money Flow source code is licensed under PolyForm Noncommercial 1.0.0.';

/** Idle demo ledgers are deleted after this window. The cookie uses the same lifetime. */
export const DEMO_SESSION_TTL_SECONDS = 24 * 60 * 60;
