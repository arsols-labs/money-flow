// A single money color scale: "bad → uneasy → good".
//
// Before it, an amount's color was three steps (`tone-safe` / `tone-warning` /
// `tone-danger`) and was assigned by hand in each place by its own condition —
// so "Cash Flow −1 ¢" and "Cash Flow −9 000 €" looked equally
// uneasy, and two neighboring screens colored the same number differently.
// Here one function covers the whole app: a share 0…1 → a color.
//
// IMPORTANT for contrast. The scale mixes ONLY three palette tokens
// (`--danger`, `--warning`, `--safe`), and mixes them in sRGB. Contrast of the whole
// scale is not an argument, it is a measurement: test/ui-palette.test.ts computes the mix
// the same way the browser does, and runs 201 points of the scale on both backgrounds in both
// themes, requiring AA 4.5:1. The midpoint between two colors that pass AA does not
// pass AA by itself, so the check is continuous.
// Hence the rule: nothing but these three
// tokens may be mixed into the scale. A new shade needs a token with checked contrast first.
//
// Why `color-mix()`, not a ready hex: the tokens are overridden by the light
// theme, and the mix must move with them. A hex computed in JS
// would freeze in the color of whichever theme was active at render time.

/** Clamp a value into [0, 1] — "shares" come from data and can be anything. */
function clamp01(x) {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

/**
 * A point on the continuous scale: 0 is `--danger`, 0.5 is `--warning`, 1 is `--safe`.
 *
 * Returns a `color-mix()` string, not a hex (see the file header). Exact
 * ends are returned as the pure token: browsers compute `color-mix(... 100%, ...)`
 * correctly, but `var(--safe)` is easier to read in devtools and in tests.
 */
export function moneyScaleColor(ratio) {
  const r = clamp01(ratio);
  if (r <= 0) return 'var(--danger)';
  if (r >= 1) return 'var(--safe)';
  if (r === 0.5) return 'var(--warning)';
  if (r > 0.5) {
    const p = ((r - 0.5) / 0.5) * 100;
    return `color-mix(in srgb, var(--safe) ${p.toFixed(1)}%, var(--warning))`;
  }
  const p = (r / 0.5) * 100;
  return `color-mix(in srgb, var(--warning) ${p.toFixed(1)}%, var(--danger))`;
}

/**
 * Amount → a scale share relative to the "low balance" threshold (the
 * "Forecast / Low balance threshold" setting in the "Data" section).
 *
 * Zero and negative are the red end of the scale: that is a direct requirement
 * ("Zero or a minus is the red palette"). The threshold is "already calm", that is
 * the green end; between them the scale runs smoothly through orange.
 *
 * A threshold of zero is a degenerate case (there is nothing to divide by): the warning
 * was turned off, and the only signal left is the sign of the amount.
 */
export function balanceRatio(amountMinor, thresholdMinor) {
  if (!thresholdMinor || thresholdMinor <= 0) return amountMinor > 0 ? 1 : 0;
  if (amountMinor <= 0) return 0;
  return clamp01(amountMinor / thresholdMinor);
}

/** Ready color of an amount by threshold — `balanceRatio` + `moneyScaleColor`. */
export function balanceColor(amountMinor, thresholdMinor) {
  return moneyScaleColor(balanceRatio(amountMinor, thresholdMinor));
}

/**
 * Scale share for an amount that has no threshold — "how much of the largest
 * amount in the same list this amount takes up".
 *
 * The sign picks the half of the scale, the magnitude picks the position inside that half:
 * an expense is redder the larger it is relative to the list maximum; income is
 * greener. An exact zero is the middle of the scale, not the red end: in a list of
 * spending, zero means "nothing was spent", which is not an alarm.
 *
 * This "within its own list" comparison is what "Analytics" needs: a spending category has no absolute
 * scale, only its share of the largest one matters.
 */
export function relativeRatio(valueMinor, maxAbsMinor) {
  if (!maxAbsMinor) return 0.5;
  const share = clamp01(Math.abs(valueMinor) / maxAbsMinor);
  if (valueMinor === 0) return 0.5;
  return valueMinor > 0 ? 0.5 + share / 2 : 0.5 - share / 2;
}

/** Ready color for amounts with no threshold — `relativeRatio` + `moneyScaleColor`. */
export function relativeColor(valueMinor, maxAbsMinor) {
  return moneyScaleColor(relativeRatio(valueMinor, maxAbsMinor));
}

/**
 * Spending scale: 0 means nothing was spent (calm, the green end),
 * the list maximum is the reddest. Separate from `relativeRatio`, because
 * the sign carries no meaning for expenses — they all have the same sign, and coloring them by
 * sign would paint the whole list the same.
 */
export function spendRatio(valueMinor, maxAbsMinor) {
  if (!maxAbsMinor) return 1;
  return 1 - clamp01(Math.abs(valueMinor) / maxAbsMinor);
}

/** Ready color for the spending scale. */
export function spendColor(valueMinor, maxAbsMinor) {
  return moneyScaleColor(spendRatio(valueMinor, maxAbsMinor));
}

// ---------------------------------------------------------------------------
// Intensity: not a color, but "how loudly" an element is shown.
// ---------------------------------------------------------------------------

/**
 * Share → a continuous "loudness" in [min, 1] by cube root.
 *
 * The root, not the share itself: real distributions are long-tailed
 * (one account holds 80% of the money, a dozen hold a percent each), and on a linear scale the whole
 * tail collapses into one indistinguishable step. The root stretches the low
 * end of the scale while keeping the order of magnitude readable.
 *
 * The lower bound is non-zero: an element with a share of 0.001 should be quieter
 * than the rest, but stay visible — "invisible" and "quiet" are different
 * messages, and the second one is what is required here.
 */
export function emphasis(share, min = 0.35) {
  const s = clamp01(share);
  return min + (1 - min) * Math.cbrt(s);
}

/**
 * Background of an element whose "loudness" is proportional to its share: a wash of
 * the accent token, diluted down to fractions of a percent.
 *
 * What gets diluted is the BACKGROUND, not the text: the text stays on the ordinary tokens and
 * so holds contrast in both themes at any loudness. Transparency on
 * the text (`opacity`) would drop it below AA — the same ban is already written for
 * archived rows in styles.css.
 *
 * `maxAlpha` is kept small on purpose: the wash is a hint that "there is
 * more here", not a fill. The upper bound is checked in test/ui-palette.test.ts.
 */
export function emphasisTint(share, token = '--text', maxAlpha = 0.1) {
  const alpha = emphasis(share, 0) * maxAlpha;
  return `color-mix(in srgb, var(${token}) ${(alpha * 100).toFixed(1)}%, transparent)`;
}

/**
 * A border of the same loudness: from `--border` (quiet) to `--text-faint` (loud).
 *
 * Mixed with an opaque token, not with `transparent`: the border must
 * stay visible on any background, and a translucent one would look different on a card and on
 * a card's wash.
 */
export function emphasisBorder(share) {
  const p = (emphasis(share, 0) * 70).toFixed(1);
  return `color-mix(in srgb, var(--text-faint) ${p}%, var(--border))`;
}

/**
 * Label color of the same loudness: from `--text-muted` to `--text`.
 *
 * Two text tokens are mixed, rather than fading opacity: both ends
 * pass AA on every background in the app, and the whole scale between them is measured
 * in test/ui-palette.test.ts. Opacity drops contrast more
 * the quieter the element is — exactly where the text is already small.
 */
export function emphasisText(share) {
  const p = (emphasis(share, 0) * 100).toFixed(1);
  return `color-mix(in srgb, var(--text) ${p}%, var(--text-muted))`;
}
