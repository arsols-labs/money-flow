// Resolves a saved theme (light / dark / system) into the actual
// light or dark theme. The same `resolved` that App uses to set `data-theme`
// and the favicon: `icon-${resolved}-32.png` / `icon-${resolved}.svg`.

export function resolveTheme(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

export function themePng32Url(resolved) {
  return `/icons/icon-${resolved}-32.png`;
}
