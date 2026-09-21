// Контраст палитры v2 по WCAG 2.2 (issue #252).
//
// Почему тест, а не разовый замер: цвета живут в CSS-переменных, глазами их не
// сверить, а браузерный замер через `getComputedStyle` требует поднятого стенда
// и проверяет ровно тот экран, который открыт. Здесь та же арифметика считается
// по самому `styles.css` и сразу по всем сочетаниям «токен × тема × фон» — то
// есть ловит и те места, куда токен доедет позже.
//
// Границы: тест проверяет ПАЛИТРУ, а не разметку. Он знает, на каких фонах
// токен реально оказывается (это перечислено ниже руками и сверено с CSS), но
// не умеет заметить, что кто-то покрасил новым токеном новый элемент на новом
// фоне. Появилась такая пара — её сюда дописывают.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Сам файл подкладывает vitest.config.ts: внутри workerd нет `node:fs`.
// Комментарии срезаются сразу: в них встречаются и `}`, и упоминания токенов,
// а разбор ниже границы блоков ищет по первой закрывающей скобке.
const css = env.PALETTE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

type Rgb = [number, number, number];

/** Значения `--*` из одного блока правил. */
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

/** Относительная яркость, WCAG 2.x, формула 1.4.3. */
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

/** Полупрозрачный слой поверх непрозрачного фона. */
function over(layer: Rgb, alpha: number, base: Rgb): Rgb {
  return layer.map((c, i) => c * alpha + base[i] * (1 - alpha)) as Rgb;
}

/**
 * Доли цветных подложек берутся из самого CSS, а не переписываются сюда
 * числом: копия молча разошлась бы с `color-mix()` — ровно то, из-за чего
 * литералы `rgba()` и разъехались с палитрой (issue #252). Если один токен
 * разведён в разных местах по-разному, берётся самая плотная подложка: она же
 * и самая тяжёлая для контраста в обеих темах.
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
// Светлая тема переопределяет часть токенов — остальное наследуется от :root.
const light = { ...dark, ...tokens('html[data-theme="light"] {') };

const THEMES = [
  { name: 'тёмная', t: dark, hover: (card: Rgb) => over([255, 255, 255], 0.05, card) },
  { name: 'светлая', t: light, hover: () => hex(light['--bg-hover']) },
];

// Токены, которыми набран обычный текст мельче 18.66px bold / 24px, — для них
// порог AA равен 4.5:1 без послаблений (SC 1.4.3).
const TEXT_TOKENS = ['--text', '--text-muted', '--text-faint', '--safe', '--warning', '--danger'];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3; // SC 1.4.11 — рамки и значки

const TINTS = tintAlphas();
// Токены, которые поверх собственной подложки несут ТЕКСТ (.data-kind-btn--
// active). У остальных подложка ходит с рамкой и значком — там порог 3:1.
const TEXT_ON_TINT = ['--danger', '--safe', '--overall'];

describe.each(THEMES)('палитра v2, $name тема', ({ t, hover }) => {
  const card = hex(t['--bg-card']);
  const bg = hex(t['--bg']);

  it.each(TEXT_TOKENS)('%s читается на --bg-card и на --bg', (token) => {
    const color = hex(t[token]);
    expect(contrast(color, card)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // .btn-danger:hover и .icon-btn:hover подкладывают под текст `--bg-hover`.
  // В тёмной теме это самый светлый фон приложения, и именно он, а не карточка,
  // задаёт нижнюю границу для `--danger`.
  it('--danger читается на --bg-hover', () => {
    expect(contrast(hex(t['--danger']), hover(card))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // .data-kind-btn--active — единственное место, где цветной токен несёт текст
  // поверх собственной подложки.
  it.each(TEXT_ON_TINT)('%s читается текстом на своей подложке', (token) => {
    const color = hex(t[token]);
    const alpha = TINTS.get(token);
    expect(alpha, `в styles.css нет color-mix() от ${token}`).toBeDefined();
    // Кнопки стоят внутри .data-form (фон --bg); карточка проверяется заодно.
    expect(contrast(color, over(color, alpha!, bg))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(color, over(color, alpha!, card))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // .data-error и .data-warning: текст там обычный, цвет несут рамка и значок.
  // Проверяются все токены с подложкой разом — включая те, что появятся позже.
  it('цветные подложки не съедают рамку и значок', () => {
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

describe('архивные строки (issue #269)', () => {
  it('приглушаются без потери контраста: без opacity и через переназначение токенов', () => {
    // В styles.css архивные строки и списки не должны использовать opacity,
    // так как это роняет контраст ниже AA 4.5:1.
    const listStart = css.indexOf('.data-list--archived');
    const listBlock = css.slice(listStart, css.indexOf('}', listStart));
    const rowStart = css.indexOf('.data-row--archived');
    const rowBlock = css.slice(rowStart, css.indexOf('}', rowStart));

    expect(listBlock).not.toMatch(/opacity\s*:/);
    expect(rowBlock).not.toMatch(/opacity\s*:/);

    const rowTokens = tokens('.data-row--archived {');
    // Убеждаемся, что строка понижает яркость текста, но держит порог AA
    expect(rowTokens['--text']).toBe('var(--text-muted)');
    expect(rowTokens['--text-muted']).toBe('var(--text-faint)');
  });
});
