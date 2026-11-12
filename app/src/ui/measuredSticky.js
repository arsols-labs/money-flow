// Sticky offsets follow a measured element, not a guessed pixel gap.
// Shell measures the app bar into `--appbar-h`. Data measures the filter bar
// into `--data-filter-bar-h`. Callers add those variables in CSS.

export function measuredHeightVariable(offsetHeight) {
  if (typeof offsetHeight !== 'number' || !Number.isFinite(offsetHeight) || offsetHeight <= 0) {
    return null;
  }
  return `${Math.round(offsetHeight)}px`;
}

export function publishMeasuredHeight(element, variableName, target) {
  const value = measuredHeightVariable(element?.offsetHeight);
  if (value === null || !target?.style?.setProperty) return;
  target.style.setProperty(variableName, value);
}
