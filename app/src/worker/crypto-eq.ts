/**
 * Constant-time string compare for Workers (no Node `crypto.timingSafeEqual`).
 * Length is mixed into the accumulator so a mismatch is not an early return
 * on the first differing byte. Callers should still reject obviously
 * malformed values before comparing secrets of known encoding.
 */
export function timingSafeEqualString(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const len = Math.max(a.length, b.length, 1);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
