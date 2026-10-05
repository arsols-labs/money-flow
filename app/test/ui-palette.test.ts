// Money color scale: ratio arithmetic and contrast of the whole scale — UI standard v2, 2026-08-21.
//
// test/palette.test.ts checks TOKENS from styles.css. Here we check what is
// assembled from them at runtime: `color-mix()` between tokens, which
// palette.js returns. That color does not appear in the CSS file at all, so
// the previous test does not see it, and intermediate shades cannot be checked
// by eye — there are infinitely many of them.
//
// Method: compute the mix exactly as the browser does for `in srgb`
// (per component on gamma-encoded channels), and run a grid of values
// across the scale in both themes. This is not a proof "for all reals", but
// the grid step is finer than a color difference the eye can distinguish.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  moneyScaleColor, balanceRatio, relativeRatio, spendRatio,
  emphasis, emphasisTint, emphasisBorder, emphasisText,
} from '../src/ui/palette.js';

const css = (env.PALETTE_CSS as string).replace(/\/\*[\s\S]*?\*\//g, '');

type Rgb = [number, number, number];

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`в styles.css нет блока ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const line of css.slice(open + 1, close).split('\n')) {
    const m = line.match(/^\s*(--[a-z-]+):\s*([^;]+);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function hex(color: string): Rgb {
  const h = color.replace('#', '');
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) throw new Error(`не hex-цвет: ${color}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function over(layer: Rgb, alpha: number, base: Rgb): Rgb {
  return layer.map((c, i) => c * alpha + base[i] * (1 - alpha)) as Rgb;
}

/**
 * Parse the value palette.js returns: either `var(--token)`, or
 * `color-mix(in srgb, <a> N%, <b>)`, where `b` is a token or `transparent`.
 *
 * `in srgb` in CSS Color 5 is a gamma-encoded space, so the mix is
 * computed directly on channel bytes. That is exactly what the browser does,
 * so the test measures the same color the owner will see, not a linear
 * approximation of it.
 */
function resolve(value: string, theme: Record<string, string>, base: Rgb): Rgb {
  const varMatch = value.match(/^var\((--[a-z-]+)\)$/);
  if (varMatch) return hex(theme[varMatch[1]]);

  const mix = value.match(
    /^color-mix\(in srgb, var\((--[a-z-]+)\) ([\d.]+)%, (var\((--[a-z-]+)\)|transparent)\)$/,
  );
  if (!mix) throw new Error(`не разобрать цвет: ${value}`);
  const first = hex(theme[mix[1]]);
  const p = Number(mix[2]) / 100;
  if (mix[3] === 'transparent') return over(first, p, base);
  return first.map((c, i) => c * p + hex(theme[mix[4]])[i] * (1 - p)) as Rgb;
}

const dark = tokens(':root {');
const light = { ...dark, ...tokens('html[data-theme="light"] {') };

const THEMES = [
  { name: 'dark', t: dark },
  { name: 'light', t: light },
];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

// Grid finer than a difference the eye can distinguish: 201 points on the scale.
const SAMPLES = Array.from({ length: 201 }, (_, i) => i / 200);

describe('money scale: ratios', () => {
  it('zero and negative are the red end, the threshold is green', () => {
    expect(balanceRatio(0, 100_00)).toBe(0);
    expect(balanceRatio(-1, 100_00)).toBe(0);
    expect(balanceRatio(100_00, 100_00)).toBe(1);
    expect(balanceRatio(500_00, 100_00)).toBe(1);
    // Half the threshold is exactly the middle of the scale, the "alarm" orange.
    expect(balanceRatio(50_00, 100_00)).toBe(0.5);
  });

  it('without a threshold only the sign of the amount remains', () => {
    expect(balanceRatio(10, 0)).toBe(1);
    expect(balanceRatio(-10, 0)).toBe(0);
    expect(balanceRatio(0, 0)).toBe(0);
  });

  it('the ratio grows monotonically with the amount', () => {
    const values = [0, 1000, 2000, 5000, 9999, 10_000, 20_000];
    const ratios = values.map((v) => balanceRatio(v, 10_000));
    for (let i = 1; i < ratios.length; i += 1) {
      expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
    }
  });

  it('the signed scale keeps zero in the middle', () => {
    expect(relativeRatio(0, 1000)).toBe(0.5);
    expect(relativeRatio(1000, 1000)).toBe(1);
    expect(relativeRatio(-1000, 1000)).toBe(0);
    expect(relativeRatio(-500, 1000)).toBe(0.25);
    // Empty list: nothing to color and nothing to compare against — the middle.
    expect(relativeRatio(50, 0)).toBe(0.5);
  });

  it('spend scale: the larger the spend, the redder', () => {
    expect(spendRatio(0, 1000)).toBe(1);
    expect(spendRatio(1000, 1000)).toBe(0);
    expect(spendRatio(250, 1000)).toBe(0.75);
    // The sign of a spend in the data can be either way — the magnitude matters.
    expect(spendRatio(-1000, 1000)).toBe(0);
  });

  it('emphasis grows from min to 1 and does not collapse to zero', () => {
    expect(emphasis(0)).toBeCloseTo(0.35, 5);
    expect(emphasis(1)).toBeCloseTo(1, 5);
    expect(emphasis(0.001, 0)).toBeGreaterThan(0.09); // 0.1 is the square root of 0.001
    for (let i = 1; i < SAMPLES.length; i += 1) {
      expect(emphasis(SAMPLES[i])).toBeGreaterThanOrEqual(emphasis(SAMPLES[i - 1]));
    }
  });

  it('scale ends are returned as pure tokens', () => {
    expect(moneyScaleColor(0)).toBe('var(--danger)');
    expect(moneyScaleColor(0.5)).toBe('var(--warning)');
    expect(moneyScaleColor(1)).toBe('var(--safe)');
    // Values outside [0,1] and garbage do not crash the render.
    expect(moneyScaleColor(-5)).toBe('var(--danger)');
    expect(moneyScaleColor(42)).toBe('var(--safe)');
    expect(moneyScaleColor(NaN)).toBe('var(--danger)');
  });
});

describe.each(THEMES)('money scale: contrast, $name theme', ({ t }) => {
  const card = hex(t['--bg-card']);
  const bg = hex(t['--bg']);

  // The main property of the scale: any point of it reads as text on both
  // app backgrounds. Without that, a "smooth gradient" would become a lottery —
  // the midpoint between two colors that pass AA is not guaranteed to pass AA.
  it('any point of the scale is readable on --bg-card and on --bg', () => {
    for (const s of SAMPLES) {
      const value = moneyScaleColor(s);
      for (const [name, base] of [['--bg-card', card], ['--bg', bg]] as const) {
        expect(
          contrast(resolve(value, t, base), base),
          `${value} (доля ${s}) на ${name}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  // Account cards are dimmed by a mix of two backgrounds. Both sides are opaque,
  // so checking the extreme backgrounds would be enough — but every step is checked.
  it('text is readable at any dimming of an account card', () => {
    for (const s of SAMPLES) {
      const dim = (1 - emphasis(s, 0)) * 70;
      const surface = hex(t['--bg']).map(
        (c, i) => c * (dim / 100) + card[i] * (1 - dim / 100),
      ) as Rgb;
      expect(contrast(hex(t['--text']), surface), `дим ${dim.toFixed(1)}%`)
        .toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(hex(t['--text-faint']), surface), `дим ${dim.toFixed(1)}%`)
        .toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('chip highlight does not get in the way of reading the label and the border', () => {
    for (const s of SAMPLES) {
      for (const base of [card, bg]) {
        const surface = resolve(emphasisTint(s), t, base);
        expect(contrast(resolve(emphasisText(s), t, surface), surface), `доля ${s}`)
          .toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrast(resolve(emphasisBorder(s), t, surface), surface), `доля ${s}`)
          .toBeGreaterThanOrEqual(1.2); // the border is not a carrier of meaning, only grouping
      }
    }
  });

  it('overdue payment amounts and labels remain AA on the actual row tint', () => {
    const rule = css.match(/\.upcoming-row--overdue\s*\{([^}]+)\}/)?.[1] || '';
    const tint = rule.match(/var\(--danger\)\s+([\d.]+)%/);
    expect(tint).not.toBeNull();
    const alpha = Number(tint![1]) / 100;
    const surface = over(hex(t['--danger']), alpha, card);
    for (const s of SAMPLES) {
      const scale = resolve(moneyScaleColor(s), t, card);
      for (const foreground of [scale, hex(t['--text']), hex(t['--text-muted']), hex(t['--text-faint'])]) {
        expect(contrast(foreground, surface), `payment ratio ${s}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('the warning underlay does not swallow its text', () => {
    // Pulse lays a mix of the scale color and the background under a warning row,
    // 2…8% — see WarningRow. The text there uses ordinary tokens.
    for (const s of SAMPLES) {
      const alpha = (8 - emphasis(s, 0) * 6) / 100;
      const scale = resolve(moneyScaleColor(s), t, card);
      const surface = over(scale, alpha, card);
      expect(contrast(hex(t['--text']), surface)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(hex(t['--text-muted']), surface)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(scale, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});
