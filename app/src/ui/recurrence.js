// Помощники для секций «Плановые» и «Регулярные» на экране «Данные»:
// человекочитаемое описание правила повторения и мелкие форматтеры дат для
// форм. Чистые функции без React — чтобы их можно было протестировать
// отдельно (см. test/recurrence.test.ts), по той же логике, что money.js.

import { RU_MONTHS } from './money';
import i18n from './i18n';
import { intlLocale } from './language';

function currentLang() {
  return i18n.resolvedLanguage || i18n.language || 'en';
}

/** Склонение существительного периода под конкретное число: 2 недели, 5 недель. */
export function intervalUnitLabel(frequency, count) {
  const key = `recurrence.unit.${frequency}`;
  return i18n.t(key, { count: Math.abs(Number(count) || 0) });
}

/** Список для `select` периодичности в формах плановых/регулярных операций. */
export const FREQUENCY_OPTIONS = [
  { value: 'daily', get label() { return i18n.t('recurrence.everyOption.daily'); } },
  { value: 'weekly', get label() { return i18n.t('recurrence.everyOption.weekly'); } },
  { value: 'monthly', get label() { return i18n.t('recurrence.everyOption.monthly'); } },
  { value: 'yearly', get label() { return i18n.t('recurrence.everyOption.yearly'); } },
];

function dayOfMonthFromDate(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length < 10) return null;
  const day = Number(dateStr.slice(8, 10));
  return Number.isFinite(day) && day > 0 ? day : null;
}

function monthIndexFromDate(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length < 10) return null;
  const month = Number(dateStr.slice(5, 7));
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month - 1 : null;
}

/**
 * Человекочитаемое описание правила повторения: «каждый месяц 15 числа»,
 * «раз в 2 недели», «каждый год 29 февраля», «каждый день».
 */
export function describeRecurrence(item) {
  const frequency = item?.frequency;
  const intervalCount = Number(item?.interval_count) || 1;
  const everyKey = `recurrence.every.${frequency}`;
  const base = intervalCount === 1
    ? i18n.t(i18n.exists(everyKey) ? everyKey : 'recurrence.every.daily')
    : i18n.t('recurrence.everyN', {
      count: intervalCount,
      unit: intervalUnitLabel(frequency, intervalCount),
    });

  if (frequency !== 'monthly' && frequency !== 'yearly') return base;

  const actualDay = dayOfMonthFromDate(item?.next_due_date);
  const pinnedDay = item?.day_of_month ?? actualDay;
  if (pinnedDay == null) return base;

  const clamped = actualDay != null && actualDay !== pinnedDay;

  if (frequency === 'yearly') {
    const monthIdx = monthIndexFromDate(item?.next_due_date);
    const monthName = monthIdx != null
      ? (currentLang() === 'ru'
        ? RU_MONTHS[monthIdx]
        : new Date(2000, monthIdx, 1).toLocaleDateString(intlLocale(currentLang()), { month: 'long' }))
      : '';
    return i18n.t(clamped ? 'recurrence.yearlyOnDateClamped' : 'recurrence.yearlyOnDate', {
      base,
      day: pinnedDay,
      month: monthName,
      actual: actualDay,
    });
  }

  return i18n.t(clamped ? 'recurrence.monthlyOnDayClamped' : 'recurrence.monthlyOnDay', {
    base,
    day: pinnedDay,
    actual: actualDay,
  });
}

/**
 * «15 сентября» / «15 сентября 2027» — год виден только не в текущем году.
 */
export function formatDayMonth(dateStr) {
  if (typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  if (currentLang() === 'ru') {
    const yearSuffix = y !== new Date().getFullYear() ? ` ${y}` : '';
    return `${d} ${RU_MONTHS[m - 1]}${yearSuffix}`;
  }
  const date = new Date(y, m - 1, d);
  const includeYear = y !== new Date().getFullYear();
  return date.toLocaleDateString(intlLocale(currentLang()), {
    day: 'numeric',
    month: 'long',
    ...(includeYear ? { year: 'numeric' } : {}),
  });
}

/** Сегодняшняя дата в формате поля даты, по локальному времени — не UTC. */
export function todayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Описание срока ближайшего платежа относительно текущего дня.
 */
export function describeDueDate(dateStr, baseDateStr = todayDateString()) {
  if (typeof dateStr !== 'string' || !dateStr) return { text: '', tone: 'future' };

  const [y1, m1, d1] = dateStr.split('-').map(Number);
  const [y2, m2, d2] = baseDateStr.split('-').map(Number);
  if (!y1 || !m1 || !d1 || !y2 || !m2 || !d2) {
    return { text: formatDayMonth(dateStr), tone: 'future' };
  }

  const targetDate = new Date(y1, m1 - 1, d1);
  const baseDate = new Date(y2, m2 - 1, d2);
  const diffDays = Math.round((targetDate.getTime() - baseDate.getTime()) / 86400000);

  const formattedDate = formatDayMonth(dateStr);

  if (diffDays < 0) {
    return { text: i18n.t('recurrence.due.overdue', { date: formattedDate }), tone: 'overdue' };
  }
  if (diffDays === 0) {
    return { text: i18n.t('recurrence.due.today', { date: formattedDate }), tone: 'today' };
  }
  if (diffDays === 1) {
    return { text: i18n.t('recurrence.due.tomorrow', { date: formattedDate }), tone: 'tomorrow' };
  }
  if (diffDays <= 3) {
    return { text: i18n.t('recurrence.due.soon', { count: diffDays, date: formattedDate }), tone: 'soon' };
  }
  return { text: i18n.t('recurrence.due.next', { date: formattedDate }), tone: 'future' };
}
