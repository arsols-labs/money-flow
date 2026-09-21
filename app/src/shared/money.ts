/** Safe JavaScript integer domain for minor-unit money values. */

export const SAFE_MINOR_MAX = Number.MAX_SAFE_INTEGER;
export const SAFE_MINOR_MIN = Number.MIN_SAFE_INTEGER;

export function isSafeMinor(value: number): boolean {
  return Number.isSafeInteger(value);
}

export function minorBigIntToNumber(value: bigint, field = 'amount_minor'): number {
  if (value > BigInt(SAFE_MINOR_MAX) || value < BigInt(SAFE_MINOR_MIN)) {
    throw new RangeError(`AMOUNT_OUT_OF_SAFE_RANGE:${field}`);
  }
  return Number(value);
}

export function scaledMinor(amountMinor: number, count: number, field = 'amount_minor'): number | null {
  try {
    return minorBigIntToNumber(BigInt(amountMinor) * BigInt(count), field);
  } catch {
    return null;
  }
}
