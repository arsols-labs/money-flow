// Palette v2 contrast per WCAG 2.2 (issue #252).
//
// Why a test, and not a one-off measurement: colors live in CSS variables, they
// cannot be checked by eye, and a browser measurement via `getComputedStyle`
// needs a running stand and checks exactly the screen that is open. Here the
// same arithmetic is computed from `styles.css` itself and across every
// "token × theme × background" combination at once — so it also catches the
// places a token will reach later.
//
// Scope: the test checks the PALETTE, not the markup. It knows which
// backgrounds a token actually lands on (listed by hand below and checked
// against the CSS), but it cannot notice that someone painted a new element
// with a new token on a new background. When such a pair appears, it gets
// added here.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// vitest.config.ts supplies the file itself: there is no `node:fs` inside workerd.
// Comments are stripped first: they contain both `}` and mentions of tokens,
// and the block-boundary parse below searches for the first closing brace.
const css = env.PALETTE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

type Rgb = [number, number, number];

/** `--*` values from a single rule block. */
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

/** Relative luminance, WCAG 2.x, formula 1.4.3. */
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

/** A translucent layer over an opaque background. */
function over(layer: Rgb, alpha: number, base: Rgb): Rgb {
  return layer.map((c, i) => c * alpha + base[i] * (1 - alpha)) as Rgb;
}

/**
 * Tint fractions are taken from the CSS itself, not copied here as numbers:
 * a copy would silently drift from `color-mix()` — exactly why the `rgba()`
 * literals drifted from the palette (issue #252). If one token is diluted
 * differently in different places, the densest tint is used: it is also the
 * hardest for contrast in both themes.
 */
function tintAlphas(): Map<string, number> {
  const out = new Map<string, number>();
  const re = /color-mix\(\s*in srgb,\s*var\((--[a-z-]+)\)\s*(\d+)%\s*,\s*transparent\s*\)/g;
  for (const m of css.matchAll(re)) {
    const alpha = Number(m[2]) / 100;
    out.set(m[1], Math.max(out.get(m[1]) ?? 0, alpha));
  }
  return out;
}

const dark = tokens(':root {');
// The light theme overrides some tokens — the rest is inherited from :root.
const light = { ...dark, ...tokens('html[data-theme="light"] {') };

const THEMES = [
  { name: 'dark', t: dark, hover: (card: Rgb) => over([255, 255, 255], 0.05, card) },
  { name: 'light', t: light, hover: () => hex(light['--bg-hover']) },
];

// Tokens used for ordinary text smaller than 18.66px bold / 24px — for them
// the AA threshold is 4.5:1 with no relief (SC 1.4.3).
const TEXT_TOKENS = ['--text', '--text-muted', '--text-faint', '--safe', '--warning', '--danger'];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3; // SC 1.4.11 — borders and icons

const TINTS = tintAlphas();
// Tokens that carry TEXT on top of their own tint (.data-kind-btn--
// active). For the rest the tint goes with a border and an icon — the threshold there is 3:1.
const TEXT_ON_TINT = ['--danger', '--safe', '--overall'];

describe.each(THEMES)('palette v2, $name theme', ({ t, hover }) => {
  const card = hex(t['--bg-card']);
  const bg = hex(t['--bg']);

  it.each(TEXT_TOKENS)('%s is readable on --bg-card and on --bg', (token) => {
    const color = hex(t[token]);
    expect(contrast(color, card)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // .btn-danger:hover and .icon-btn:hover place `--bg-hover` under the text.
  // In the dark theme that is the lightest background in the app, and it, not the card,
  // sets the lower bound for `--danger`.
  it('--danger is readable on --bg-hover', () => {
    expect(contrast(hex(t['--danger']), hover(card))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // .data-kind-btn--active is the only place where a colored token carries text
  // on top of its own tint.
  it.each(TEXT_ON_TINT)('%s is readable as text on its own tint', (token) => {
    const color = hex(t[token]);
    const alpha = TINTS.get(token);
    expect(alpha, `в styles.css нет color-mix() от ${token}`).toBeDefined();
    // Buttons sit inside .data-form (background --bg); the card is checked as well.
    expect(contrast(color, over(color, alpha!, bg))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(color, over(color, alpha!, card))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // .data-error and .data-warning: the text there is ordinary, the color is carried by the border and the icon.
  // Every token that has a tint is checked at once — including ones that will appear later.
  it('colored tints do not swallow the border and the icon', () => {
    expect(TINTS.size).toBeGreaterThan(0);
    for (const [token, alpha] of TINTS) {
      const color = hex(t[token]);
      expect(
        contrast(color, over(color, alpha, card)),
        `${token} на своей подложке ${alpha * 100}%`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});

describe('archived rows (issue #269)', () => {
  it('are dimmed without losing contrast: no opacity, via token reassignment', () => {
    // In styles.css archived rows and lists must not use opacity,
    // because that drops contrast below AA 4.5:1.
    const listStart = css.indexOf('.data-list--archived');
    const listBlock = css.slice(listStart, css.indexOf('}', listStart));
    const rowStart = css.indexOf('.data-row--archived');
    const rowBlock = css.slice(rowStart, css.indexOf('}', rowStart));

    expect(listBlock).not.toMatch(/opacity\s*:/);
    expect(rowBlock).not.toMatch(/opacity\s*:/);

    const rowTokens = tokens('.data-row--archived {');
    // Confirm the row lowers text luminance but holds the AA threshold
    expect(rowTokens['--text']).toBe('var(--text-muted)');
    expect(rowTokens['--text-muted']).toBe('var(--text-faint)');
  });
});
