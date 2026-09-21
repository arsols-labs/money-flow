import { describe, expect, it } from 'vitest';
import { toIsoUtc } from '../src/worker/datetime';

describe('toIsoUtc (#325)', () => {
  it('пустые значения даёт null', () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc(undefined)).toBeNull();
    expect(toIsoUtc('')).toBeNull();
    expect(toIsoUtc('   ')).toBeNull();
  });

  it('datetime(now) SQLite считает UTC и ставит Z', () => {
    expect(toIsoUtc('2026-08-16 00:13:00')).toBe('2026-08-16T00:13:00Z');
  });

  it('уже ISO с T без пояса тоже помечает как UTC', () => {
    expect(toIsoUtc('2026-08-16T00:13:00')).toBe('2026-08-16T00:13:00Z');
  });

  it('уже ISO с Z оставляет как есть', () => {
    expect(toIsoUtc('2026-08-15T12:00:00Z')).toBe('2026-08-15T12:00:00Z');
  });
});
