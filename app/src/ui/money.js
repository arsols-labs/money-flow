// Работа с деньгами и датами для UI «Данные».
// Разбор пользовательского ввода — строковыми операциями, без умножения на
// 100: `19.99 * 100 === 1998.9999999999998` — классический баг float, ради
// которого это писано именно так.

// Разрядность минорной единицы ISO 4217 нужна и воркеру (движок прогноза,
// issue #198) — единый источник в src/shared/currency.ts, здесь только
// реэкспорт: публичный экспорт fractionDigits из этого модуля используют
// другие модули UI и test/money.test.ts, ломать его нельзя. Комментарий с
// обоснованием таблицы (а не Intl) живёт там же, вторую копию не заводим.
import { fractionDigits } from '../shared/currency';
import i18n from './i18n';
import { intlLocale } from './language';
export { fractionDigits };

function currentIntlLocale() {
  return intlLocale(i18n.resolvedLanguage || i18n.language);
}

// Родительный падеж — форма для «10 августа». Экспортируется, потому что тем
// же списком пользуется recurrence.js: вторая копия названий месяцев в том же
// каталоге разошлась бы с этой на первой же правке.
export const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Пробелы-разделители тысяч, которые может вставить пользователь при копипасте.
const SPACE_CHARS = /[\s  ]/g;

/**
 * Строку от пользователя ("19,99", " 1 200.5 ") — в целые минорные единицы.
 * Никакого `parseFloat(...) * 100`: собираем цифры как строку и парсим её
 * целиком, чтобы не словить погрешность двоичной арифметики.
 */
export function parseAmountToMinor(input, currency) {
  const digits = fractionDigits(currency);
  let s = String(input ?? '').trim().replace(SPACE_CHARS, '').replace(',', '.');

  if (s === '') throw new Error(i18n.t('validation.enterAmount'));
  if (!/^-?\d*(\.\d*)?$/.test(s)) throw new Error(i18n.t('validation.invalidAmount'));

  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  if (s === '' || s === '.') throw new Error(i18n.t('validation.invalidAmount'));

  const [rawInt, rawFrac = ''] = s.split('.');
  if (rawFrac.length > digits) {
    throw new Error(i18n.t('validation.maxDecimalPlaces', { digits }));
  }

  const intPart = rawInt === '' ? '0' : rawInt;
  const fracPart = rawFrac.padEnd(digits, '0');
  const digitsOnly = (intPart + fracPart).replace(/^0+(?=\d)/, '');
  const minor = parseInt(digitsOnly || '0', 10);

  // Именно isSafeInteger, а не isFinite: parseInt на строке из двадцати цифр
  // возвращает конечное, но уже неточное число — сумма молча съехала бы ещё до
  // отправки на сервер. Лучше внятный отказ здесь, чем 400 с техническим
  // текстом оттуда.
  if (!Number.isSafeInteger(minor)) throw new Error(i18n.t('validation.amountTooLarge'));
  return negative && minor !== 0 ? -minor : minor;
}

/** Обратное преобразование для поля ввода — тоже строковыми операциями. */
export function minorToInputString(minor, currency) {
  const digits = fractionDigits(currency);
  const negative = minor < 0;
  const absStr = String(Math.abs(minor)).padStart(digits + 1, '0');
  if (digits === 0) return (negative ? '-' : '') + absStr;
  const cut = absStr.length - digits;
  const intPart = absStr.slice(0, cut) || '0';
  const fracPart = absStr.slice(cut);
  return (negative ? '-' : '') + intPart + '.' + fracPart;
}

/**
 * Для отображения деление допустимо (см. ТЗ) — балансы на порядки меньше
 * MAX_SAFE_INTEGER, здесь это не бьёт точность.
 */
export function formatMinor(minor, currency) {
  return formatMajor(minor / 10 ** fractionDigits(currency), currency);
}

/**
 * Майорные единицы (уже после minor→major) — в валютную строку с группировкой.
 * Отдельно от formatMinor: графики отдают recharts уже мажорные числа, и
 * повторное деление на 10**digits сдвинуло бы ось в тысячные доли.
 *
 * `compact: true` — без дробной части (тики оси, короткий min-маркер).
 * Группировку тысяч здесь нельзя срезать regex'ом по `[.,]\d+`: в en-US
 * `$17,521.60`.replace(/[.,]\d+/, '') даёт `$17.60` (issue #582).
 */
export function formatMajor(value, currency, locale = currentIntlLocale(), options = {}) {
  const currencyDigits = fractionDigits(currency);
  const digits = options.compact ? 0 : currencyDigits;
  const numeric = Number(value);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: true,
    }).format(numeric);
  } catch {
    return `${numeric.toFixed(digits)} ${currency}`;
  }
}

/** Компактная подпись оси / min-маркера: группировка есть, центов нет. */
export function formatMajorCompact(value, currency, locale = currentIntlLocale()) {
  return formatMajor(value, currency, locale, { compact: true });
}

/**
 * Курс валюты — отдельная от сумм счёта дорожка: до 9 знаков после точки,
 * без нуля и минуса. Через parseAmountToMinor его гнать нельзя — там дробь
 * дополняется нулями по знакам currency (обычно 2), что курсу не подходит.
 */
export function normalizeRateInput(input) {
  const s = String(input ?? '').trim().replace(SPACE_CHARS, '').replace(',', '.');
  if (s === '') throw new Error(i18n.t('validation.enterRate'));
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(i18n.t('validation.invalidRate'));
  }
  const [, frac = ''] = s.split('.');
  if (frac.length > 9) throw new Error(i18n.t('validation.rateMaxDecimals'));
  // Проверка нуля строкой, а не через Number(): в модуле, весь смысл которого
  // в отказе от float, приводить курс к double даже ради сравнения незачем.
  if (/^0+(\.0+)?$/.test(s)) throw new Error(i18n.t('validation.rateZero'));
  return s;
}

/**
 * Русское склонение числительного: `plural(1, 'день', 'дня', 'дней')`.
 * Обобщено из приватного pluralDays, когда «Пульсу» понадобилась вторая форма
 * («1 операция» / «2 операции» / «8 операций»): само правило одно на язык, и
 * второй его копии рядом быть не должно.
 */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function pluralDays(n) {
  return i18n.t('plural.day', { count: n });
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Возраст курса, после которого он считается устаревшим.
 *
 * Живёт здесь, а не в экранах: подвал курсов и экран «Данные» показывают одну и
 * ту же пометку, и разные пороги в них означали бы, что один и тот же курс
 * одновременно свежий и протухший.
 */
export const STALE_RATE_DAYS = 30;

/** Сколько дней прошло с момента `iso` — используется для пометки «курс устарел». */
export function daysSince(iso) {
  if (!iso) return Infinity;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Infinity;
  return Math.floor((Date.now() - startOfDay(date).getTime()) / 86400000);
}

/** «сегодня» / «вчера» / «3 дня назад» / «10 августа» / «10 августа 2024». */
export function formatRelativeDate(iso) {
  if (!iso) return i18n.t('date.noData');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return i18n.t('date.noData');

  const now = new Date();
  const diffDays = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000);

  if (diffDays === 0) return i18n.t('date.today');
  if (diffDays === 1) return i18n.t('date.yesterday');
  if (diffDays > 1 && diffDays < 30) {
    return i18n.t('date.daysAgo', { count: diffDays, unit: pluralDays(diffDays) });
  }

  const locale = currentIntlLocale();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    ...(includeYear ? { year: 'numeric' } : {}),
  });
}
