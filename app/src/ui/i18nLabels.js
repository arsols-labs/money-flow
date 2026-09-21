/** Resolve a layout block title/description from i18n keys. */
export function blockTitle(def, t) {
  if (!def) return '';
  if (def.titleKey) return t(def.titleKey);
  return def.title || def.id || '';
}

export function blockDescription(def, t) {
  if (!def) return '';
  if (def.descriptionKey) return t(def.descriptionKey);
  return def.description || '';
}
