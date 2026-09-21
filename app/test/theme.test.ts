import { describe, expect, it } from 'vitest';
import { resolveTheme, themePng32Url } from '../src/ui/theme.js';

describe('resolveTheme', () => {
  it('returns light and dark preferences as-is', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('defaults system to dark when matchMedia is unavailable', () => {
    expect(resolveTheme('system')).toBe('dark');
  });
});

describe('themePng32Url', () => {
  it('uses the same 32px family as the favicon', () => {
    expect(themePng32Url('dark')).toBe('/icons/icon-dark-32.png');
    expect(themePng32Url('light')).toBe('/icons/icon-light-32.png');
  });
});
