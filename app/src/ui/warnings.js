// Чистая логика очереди предупреждений «Пульса». Компонент отвечает только за
// разметку; лимит, фильтры и порядок проверяются отдельно без DOM.

import { fractionDigits } from './money';
import i18n from './i18n';

export const WARNING_LIMIT = 3;

const DIMENSION_ORDER = { overall: 0, country: 1, account: 2, currency: 3 };

const FILTER_DEFINITIONS = [
  { key: 'critical', labelKey: 'warnings.severity.critical', kind: 'severity' },
  { key: 'important', labelKey: 'warnings.severity.important', kind: 'severity' },
  { key: 'all', labelKey: 'filter.all' },
  { key: 'overall', labelKey: 'dimension.overall', kind: 'dimension' },
  { key: 'country', labelKey: 'dimension.countries', kind: 'dimension' },
  { key: 'account', labelKey: 'dimension.accounts', kind: 'dimension' },
  { key: 'currency', labelKey: 'dimension.currencies', kind: 'dimension' },
];

export function warningState(warning) {
  if (warning.start_minor < 0) return 'negative';
  if (warning.start_minor === 0) return 'zero';
  if (warning.threshold_minor > 0 && warning.start_minor <= warning.threshold_minor) return 'below';
  return 'ahead';
}

export function warningRatio(warning) {
  // Обычный clamp(minimum / threshold) превращал любой минус в один и тот же
  // красный. Отрицательная часть теперь остаётся в красной половине денежной
  // шкалы, но signed-log сохраняет внутри неё порядок глубины: чем глубже
  // минус, тем ближе цвет к `--danger`. Ноль — 0.35, не оранжевая середина.
  // У счёта нет общего порога, поэтому масштабом служит его стартовый баланс
  // (не меньше одной мажорной единицы своей валюты).
  const unit = 10 ** fractionDigits(warning.currency_code);
  const reference = warning.threshold_minor > 0
    ? warning.threshold_minor
    : Math.max(Math.abs(warning.start_minor), unit);
  const relative = warning.minimum_projected_minor / reference;
  if (!Number.isFinite(relative)) return 0;
  if (relative <= 0) return 0.35 / (1 + Math.log2(1 + Math.abs(relative)));
  return 0.35 + 0.65 * Math.min(1, relative);
}

// Сопоставимые денежные шкалы образуют явные buckets. Иначе попарное решение
// «сравнивать / не сравнивать» создаёт цикл A < B < C < A и Array.sort меняет
// первые пять в зависимости от входного порядка.
function impactBucket(warning) {
  return warning.threshold_minor > 0 ? '0:threshold' : `1:${warning.currency_code}`;
}

function warningImpact(warning) {
  if (warning.threshold_minor > 0) {
    return warning.minimum_projected_minor / warning.threshold_minor;
  }
  return warning.minimum_projected_minor / 10 ** fractionDigits(warning.currency_code);
}

export function warningSeverity(warning) {
  const state = warningState(warning);
  if (state === 'negative') return { rank: 0, key: 'critical', label: i18n.t('warnings.severity.critical') };
  if (state === 'zero') return { rank: 1, key: 'critical', label: i18n.t('warnings.severity.critical') };
  if (warning.earliest_non_positive_date) return { rank: 2, key: 'important', label: i18n.t('warnings.severity.important') };
  if (state === 'below') return { rank: 3, key: 'attention', label: i18n.t('warnings.severity.attention') };
  return { rank: 4, key: 'attention', label: i18n.t('warnings.severity.attention') };
}

function impactDate(warning) {
  const state = warningState(warning);
  if (state === 'negative' || state === 'zero') return '';
  return warning.earliest_non_positive_date
    || warning.earliest_below_threshold_date
    || warning.minimum_projected_date
    || '9999-12-31';
}

export function compareWarnings(a, b) {
  const severity = warningSeverity(a).rank - warningSeverity(b).rank;
  if (severity) return severity;

  const date = impactDate(a).localeCompare(impactDate(b));
  if (date) return date;

  const bucket = impactBucket(a).localeCompare(impactBucket(b));
  if (bucket) return bucket;

  const impact = warningImpact(a) - warningImpact(b);
  if (impact) return impact;

  const dimension = (DIMENSION_ORDER[a.dimension] ?? 99) - (DIMENSION_ORDER[b.dimension] ?? 99);
  if (dimension) return dimension;

  return String(a.dimension_key).localeCompare(String(b.dimension_key), 'ru', { numeric: true });
}

export function warningFilters(warnings) {
  const dimensions = new Map();
  const severities = new Map();
  for (const warning of warnings) {
    dimensions.set(warning.dimension, (dimensions.get(warning.dimension) ?? 0) + 1);
    const severity = warningSeverity(warning).key;
    severities.set(severity, (severities.get(severity) ?? 0) + 1);
  }

  return FILTER_DEFINITIONS
    .map((filter) => ({
      key: filter.key,
      label: i18n.t(filter.labelKey),
      count: filter.key === 'all'
        ? warnings.length
        : ((filter.kind === 'severity' ? severities : dimensions).get(filter.key) ?? 0),
    }))
    .filter((filter) => filter.key === 'all' || filter.count > 0);
}

export function warningSelection(warnings, filter = 'all', limit = WARNING_LIMIT) {
  const availableFilters = warningFilters(warnings);
  const activeFilter = availableFilters.some((item) => item.key === filter) ? filter : 'all';
  const filtered = warnings
    .filter((warning) => (
      activeFilter === 'all'
      || warning.dimension === activeFilter
      || warningSeverity(warning).key === activeFilter
    ))
    .sort(compareWarnings);

  return {
    activeFilter,
    availableFilters,
    total: filtered.length,
    visible: filtered.slice(0, limit),
    hidden: Math.max(0, filtered.length - limit),
  };
}
