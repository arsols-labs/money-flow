// Денежная шкала цвета: арифметика долей и контраст всей шкалы — UI-стандарт v2, 2026-08-21.
//
// test/palette.test.ts проверяет ТОКЕНЫ из styles.css. Здесь проверяется то,
// что собирается из них в рантайме: `color-mix()` между токенами, который
// возвращает palette.js. Такой цвет в CSS-файле не встречается вовсе, поэтому
// прежний тест его не видит, а глазами промежуточные оттенки не сверить —
// их бесконечно много.
//
// Способ: посчитать смесь ровно так, как её считает браузер для `in srgb`
// (покомпонентно по гамма-кодированным каналам), и прогнать по шкале сетку
// значений в обеих темах. Это не доказательство «на всех вещественных», но
// шаг сетки мельче, чем различимая глазом разница цвета.
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
 * Разбор значения, которое возвращает palette.js: либо `var(--token)`, либо
 * `color-mix(in srgb, <a> N%, <b>)`, где `b` — токен или `transparent`.
 *
 * `in srgb` в CSS Color 5 — гамма-кодированное пространство, то есть смесь
 * считается прямо по байтам каналов. Именно так это и делает браузер, поэтому
 * тест меряет тот же цвет, что увидит владелец, а не его линейное приближение.
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
  { name: 'тёмная', t: dark },
  { name: 'светлая', t: light },
];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

// Сетка мельче различимой глазом разницы: 201 точка на шкалу.
const SAMPLES = Array.from({ length: 201 }, (_, i) => i / 200);

describe('денежная шкала: доли', () => {
  it('ноль и минус — красный конец, порог — зелёный', () => {
    expect(balanceRatio(0, 100_00)).toBe(0);
    expect(balanceRatio(-1, 100_00)).toBe(0);
    expect(balanceRatio(100_00, 100_00)).toBe(1);
    expect(balanceRatio(500_00, 100_00)).toBe(1);
    // Половина порога — ровно середина шкалы, «тревожный» оранжевый.
    expect(balanceRatio(50_00, 100_00)).toBe(0.5);
  });

  it('без порога остаётся только знак суммы', () => {
    expect(balanceRatio(10, 0)).toBe(1);
    expect(balanceRatio(-10, 0)).toBe(0);
    expect(balanceRatio(0, 0)).toBe(0);
  });

  it('доля растёт монотонно вместе с суммой', () => {
    const values = [0, 1000, 2000, 5000, 9999, 10_000, 20_000];
    const ratios = values.map((v) => balanceRatio(v, 10_000));
    for (let i = 1; i < ratios.length; i += 1) {
      expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
    }
  });

  it('знаковая шкала держит ноль в середине', () => {
    expect(relativeRatio(0, 1000)).toBe(0.5);
    expect(relativeRatio(1000, 1000)).toBe(1);
    expect(relativeRatio(-1000, 1000)).toBe(0);
    expect(relativeRatio(-500, 1000)).toBe(0.25);
    // Пустой список: красить нечем и не с чем сравнивать — середина.
    expect(relativeRatio(50, 0)).toBe(0.5);
  });

  it('расходная шкала: чем крупнее трата, тем краснее', () => {
    expect(spendRatio(0, 1000)).toBe(1);
    expect(spendRatio(1000, 1000)).toBe(0);
    expect(spendRatio(250, 1000)).toBe(0.75);
    // Знак расхода в данных бывает любым — важна величина.
    expect(spendRatio(-1000, 1000)).toBe(0);
  });

  it('громкость растёт от min до 1 и не проваливается в ноль', () => {
    expect(emphasis(0)).toBeCloseTo(0.35, 5);
    expect(emphasis(1)).toBeCloseTo(1, 5);
    expect(emphasis(0.001, 0)).toBeGreaterThan(0.09); // 0.1 — корень из 0.001
    for (let i = 1; i < SAMPLES.length; i += 1) {
      expect(emphasis(SAMPLES[i])).toBeGreaterThanOrEqual(emphasis(SAMPLES[i - 1]));
    }
  });

  it('концы шкалы отдаются чистыми токенами', () => {
    expect(moneyScaleColor(0)).toBe('var(--danger)');
    expect(moneyScaleColor(0.5)).toBe('var(--warning)');
    expect(moneyScaleColor(1)).toBe('var(--safe)');
    // Значения вне [0,1] и мусор не роняют рендер.
    expect(moneyScaleColor(-5)).toBe('var(--danger)');
    expect(moneyScaleColor(42)).toBe('var(--safe)');
    expect(moneyScaleColor(NaN)).toBe('var(--danger)');
  });
});

describe.each(THEMES)('денежная шкала: контраст, $name тема', ({ t }) => {
  const card = hex(t['--bg-card']);
  const bg = hex(t['--bg']);

  // Главное свойство шкалы: любая её точка читается как текст на обоих фонах
  // приложения. Без этого «плавная градация» превращалась бы в лотерею —
  // середина между двумя проходящими AA цветами AA не гарантирует.
  it('любая точка шкалы читается на --bg-card и на --bg', () => {
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

  // Карточки счетов приглушаются смесью двух фонов. Обе стороны непрозрачны,
  // поэтому достаточно проверить крайние фоны — но проверяются все ступени.
  it('текст читается на любом приглушении карточки счёта', () => {
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

  it('подсветка чипов не мешает читать подпись и рамку', () => {
    for (const s of SAMPLES) {
      for (const base of [card, bg]) {
        const surface = resolve(emphasisTint(s), t, base);
        expect(contrast(resolve(emphasisText(s), t, surface), surface), `доля ${s}`)
          .toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrast(resolve(emphasisBorder(s), t, surface), surface), `доля ${s}`)
          .toBeGreaterThanOrEqual(1.2); // рамка — не носитель смысла, только группировка
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

  it('подложка предупреждения не съедает его текст', () => {
    // Пульс подкладывает под строку предупреждения смесь цвета шкалы с фоном,
    // 2…8 % — см. WarningRow. Текст там набран обычными токенами.
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
