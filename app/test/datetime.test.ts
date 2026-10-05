import { describe, expect, it } from 'vitest';
import { toIsoUtc } from '../src/worker/datetime';

describe('toIsoUtc (#325)', () => {
  it('returns null for empty values', () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc(undefined)).toBeNull();
    expect(toIsoUtc('')).toBeNull();
    expect(toIsoUtc('   ')).toBeNull();
  });

  it('treats SQLite datetime(now) as UTC and appends Z', () => {
    expect(toIsoUtc('2026-08-16 00:13:00')).toBe('2026-08-16T00:13:00Z');
  });

  it('also marks an ISO value with T and no zone as UTC', () => {
    expect(toIsoUtc('2026-08-16T00:13:00')).toBe('2026-08-16T00:13:00Z');
  });

  it('leaves an ISO value that already has Z unchanged', () => {
    expect(toIsoUtc('2026-08-15T12:00:00Z')).toBe('2026-08-15T12:00:00Z');
  });
});
