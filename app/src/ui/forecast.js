// Чистые клиентские помощники для экрана «Пульс» — отдельно от компонентов,
// чтобы формулы (особенно цвет предупреждения и порт из v1) были видны и
// проверяемы глазами без вёрстки вокруг.
import { fractionDigits } from './money';

/**
 * Минорные единицы в число для recharts. Деление здесь допустимо тем же
 * обоснованием, что и в money.js:formatMinor — это ТОЛЬКО отображение
 * (график, подписи), а не хранение или пересчёт: балансы на порядки меньше
 * MAX_SAFE_INTEGER, точность не страдает.
 */
export function toMajor(minor, currency) {
  return minor / 10 ** fractionDigits(currency);
}

/**
 * "YYYY-MM-DD" (контракт /forecast — календарная дата, не момент времени) →
 * Date локальной календарной даты, БЕЗ прогона через UTC. `new Date("2026-
 * 08-13")` трактует строку как UTC-полночь; часовой пояс западнее UTC при
 * пересчёте в локальное время сдвигает календарный день на сутки назад —
 * «завтра» в списке платежей превращается в «сегодня» (проверено живым
 * прогоном на стенде, tz UTC+2 сдвига не показал, баг ловится только западнее
 * UTC — отсюда и незаметность на этой машине). Разбор по компонентам такого
 * сдвига не делает.
 */
export function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Порог "зелёного" — порт формулы из app/src/ui/Pulse.jsx:21-30, но порог
// приходит параметром (low_balance_threshold_minor из /forecast), а не
// зашит константой LOWEST_BALANCE_SAFE_USD: настраиваемость порога — само
// содержание решения владельца 2026-08-04 (issue #198).
export function lowestBalanceColor(amountMinor, thresholdMinor) {
  // Нулевой порог — вырожденный случай формулы (amount/threshold делит на
  // ноль): владелец обнулил предупреждение, и единственный оставшийся сигнал —
  // знак суммы.
  if (thresholdMinor === 0) return amountMinor >= 0 ? 'var(--safe)' : 'var(--danger)';
  const ratio = Math.max(0, Math.min(1, amountMinor / thresholdMinor));
  if (ratio >= 1) return 'var(--safe)';
  if (ratio >= 0.5) {
    const p = ((ratio - 0.5) / 0.5) * 100;
    return `color-mix(in srgb, var(--safe) ${p}%, var(--warning))`;
  }
  const p = (ratio / 0.5) * 100;
  return `color-mix(in srgb, var(--warning) ${p}%, var(--danger))`;
}

/**
 * Ключ страны в точке графика. Префикс обязателен: `country` — свободный текст
 * из карточки счёта, и страна, названная `overall`, `ts` или `date`, молча
 * затёрла бы служебное поле точки — общий итог на графике стал бы страновым
 * рядом, и заметить это было бы нечем. Префикс `c:` в имена стран попасть не
 * может, потому что он добавляется здесь, а не берётся из данных.
 */
const COUNTRY_KEY_PREFIX = 'c:';
const ACCOUNT_KEY_PREFIX = 'a:';
const USER_KEY_PREFIX = 'u:';

export const FORECAST_GROUP_MODES = /** @type {const} */ (['country', 'account', 'user']);
export const DEFAULT_FORECAST_GROUP_MODE = 'country';

export function countryKey(country) {
  return COUNTRY_KEY_PREFIX + country;
}

export function accountKey(id) {
  return ACCOUNT_KEY_PREFIX + String(id);
}

export function userKey(owner) {
  return USER_KEY_PREFIX + owner;
}

/**
 * Обратно из ключа точки в имя страны — для подписей тултипа. Отдельной
 * функцией, а не `slice(2)` по месту: длина префикса не должна жить магическим
 * числом в другом файле. Ошибка там не упала бы, а тихо подписала бы денежную
 * строку не тем именем.
 */
export function countryFromKey(key) {
  return key.startsWith(COUNTRY_KEY_PREFIX) ? key.slice(COUNTRY_KEY_PREFIX.length) : key;
}

export function accountFromKey(key) {
  return key.startsWith(ACCOUNT_KEY_PREFIX) ? key.slice(ACCOUNT_KEY_PREFIX.length) : key;
}

export function userFromKey(key) {
  return key.startsWith(USER_KEY_PREFIX) ? key.slice(USER_KEY_PREFIX.length) : key;
}

/**
 * series (контракт /api/v2/forecast) → точки recharts:
 * `{ts, date, overall, ['c:'+country]: value, ['a:'+id]: value, ['u:'+owner]: value}`.
 * Суммы уже в base_currency (сервер их туда привёл) — здесь только minor→major.
 * by_account / by_owner могут отсутствовать у старого ответа — тогда ключей нет.
 */
export function chartData(series, baseCurrency) {
  return series.map((d) => {
    const point = {
      ts: parseDateOnly(d.date).getTime(),
      date: d.date,
      overall: toMajor(d.overall_minor, baseCurrency),
    };
    for (const [country, minor] of Object.entries(d.by_country || {})) {
      point[countryKey(country)] = toMajor(minor, baseCurrency);
    }
    for (const [id, minor] of Object.entries(d.by_account || {})) {
      point[accountKey(id)] = toMajor(minor, baseCurrency);
    }
    for (const [owner, minor] of Object.entries(d.by_owner || {})) {
      point[userKey(owner)] = toMajor(minor, baseCurrency);
    }
    return point;
  });
}

/**
 * Household members exist for the chart when the API emitted at least two owner series.
 * @param {unknown} owners
 */
export function forecastHasMultiUserSeries(owners) {
  return Array.isArray(owners) && new Set(owners.filter((owner) => typeof owner === 'string' && owner.length > 0)).size >= 2;
}

/**
 * Persisted grouping may be `user` after owners collapse to one person —
 * fall back to country rather than drawing a one-line "household" view.
 * @param {unknown} mode
 * @param {{ owners?: string[], accounts?: Array<{ id: number, name?: string }> }} [meta]
 * @returns {'country' | 'account' | 'user'}
 */
export function resolveForecastGroupMode(mode, { owners = [], accounts = [] } = {}) {
  if (mode === 'account' && Array.isArray(accounts) && accounts.length > 0) return 'account';
  if (mode === 'user' && forecastHasMultiUserSeries(owners)) return 'user';
  return DEFAULT_FORECAST_GROUP_MODE;
}

/**
 * @param {Array<{ id: number, name?: string }>} accounts
 * @param {Array<{ by_account?: Record<string, number> }> | undefined} series
 */
export function accountsWithForecastSeries(accounts, series) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const first = series?.[0]?.by_account;
  if (!first || typeof first !== 'object') return accounts;
  const ids = new Set(Object.keys(first));
  return accounts.filter((account) => ids.has(String(account.id)));
}

/**
 * Visible extra series (Total is always drawn separately).
 * @param {unknown} mode
 * @param {{ countries?: string[], accounts?: Array<{ id: number, name?: string }>, owners?: string[] }} [meta]
 * @returns {Array<{ key: string, label: string, color: string }>}
 */
export function forecastSeriesItems(mode, { countries = [], accounts = [], owners = [] } = {}) {
  const resolved = resolveForecastGroupMode(mode, { owners, accounts });
  if (resolved === 'account') {
    const labels = accounts.map((account) => account.name || String(account.id));
    const colors = countryColors(labels);
    return accounts.map((account, index) => ({
      key: accountKey(account.id),
      label: account.name || String(account.id),
      color: colors[labels[index]],
    }));
  }
  if (resolved === 'user') {
    const colors = countryColors(owners);
    return owners.map((owner) => ({
      key: userKey(owner),
      label: owner,
      color: colors[owner],
    }));
  }
  const colors = countryColors(countries);
  return countries.map((country) => ({
    key: countryKey(country),
    label: country,
    color: colors[country],
  }));
}

/**
 * Y-axis domain. Country mode keeps Recharts auto-scale (current look).
 * When any plotted value is negative, the axis includes that floor and 0
 * so Everyday Card (and similar) can render below $0.
 */
export function forecastYDomain(points, extraKeys = []) {
  if (!Array.isArray(points) || points.length === 0) return ['auto', 'auto'];
  const keys = extraKeys.includes('overall') ? extraKeys : ['overall', ...extraKeys];
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    for (const key of keys) {
      const value = point[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ['auto', 'auto'];
  if (min >= 0) return ['auto', 'auto'];
  const top = Math.max(max, 0);
  const pad = (top - min) * 0.08 || 1;
  return [min - pad, top + pad];
}

// Палитра линий по странам. v1 держал RUS/USA/SRB зашитыми в CSS-переменные
// (--rus/--usa/--srb) — в v2 country произвольная строка (issue #198 снял
// привязку к трём странам), поэтому цвет назначается по индексу из общей
// палитры, а знакомым кодам оставлен их привычный цвет, чтобы график не
// «переехал» для тех, кто уже привык к оттенкам v1.
// `token` идёт в SVG (чтобы оттенок жил по теме, как в v1), `hex` — то же
// значение литералом, и оно нужно не для отрисовки, а чтобы палитра ниже могла
// эти цвета ОБХОДИТЬ: три первых её оттенка и есть эти самые три, поэтому
// незнакомая страна с индексом 0 получала в точности цвет USA — две линии на
// графике становились неразличимы. Сравнить `var(--usa)` с литералом нельзя,
// отсюда вторая колонка. Разъехаться она может только вместе с правкой токена
// в styles.css, и худшее последствие тогда — незнакомая страна возьмёт
// оттенок, который снова стал свободным.
const KNOWN_COUNTRY_COLORS = {
  Global: { token: 'var(--overall)', hex: '#9AA3B5' },
  RUS: { token: 'var(--rus)', hex: '#D98757' },
  USA: { token: 'var(--usa)', hex: '#5B8FC7' },
  SRB: { token: 'var(--srb)', hex: '#6FBF8B' },
};

// Палитра, читаемая в обеих темах (те же принципы, что у --safe/--warning/
// --danger в styles.css: насыщенность средняя, не чистые primary-цвета).
const COUNTRY_PALETTE = [
  '#5B8FC7', // синий
  '#D98757', // оранжевый
  '#6FBF8B', // зелёный
  '#B07FD9', // фиолетовый
  '#D9C15B', // жёлтый
  '#5BC7B4', // бирюзовый
  '#D95B8F', // розовый
];

/**
 * Цвета линий для ВСЕГО списка стран сразу, а не по одной.
 *
 * По одной было нельзя: цвет незнакомой страны зависит от того, какие цвета
 * уже заняли знакомые соседи, а этого знания у вызова с одним аргументом нет.
 * Возвращает объект `{ [country]: color }`; порядок входного списка задаёт
 * порядок выдачи цветов, то есть при неизменном наборе стран цвет стабилен.
 */
export function countryColors(countries) {
  const taken = new Set(countries.map((c) => KNOWN_COUNTRY_COLORS[c]?.hex).filter(Boolean));
  const free = COUNTRY_PALETTE.filter((color) => !taken.has(color));
  // Все семь оттенков заняты знакомыми странами — теоретически невозможно
  // (знакомых всего три), но пустой список цветов оставил бы страну без линии,
  // а повтор оттенка её хотя бы покажет.
  const pool = free.length > 0 ? free : COUNTRY_PALETTE;

  const colors = {};
  let next = 0;
  for (const c of countries) {
    colors[c] = KNOWN_COUNTRY_COLORS[c]?.token ?? pool[next++ % pool.length];
  }
  return colors;
}
