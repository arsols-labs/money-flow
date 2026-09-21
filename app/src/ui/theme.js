// Разрешение сохранённой темы (light / dark / system) в фактическую
// светлую или тёмную. Тот же `resolved`, которым App ставит `data-theme`
// и favicon: `icon-${resolved}-32.png` / `icon-${resolved}.svg`.

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
