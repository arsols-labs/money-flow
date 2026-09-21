// Календарь финансовых дат v2 (issue #198): financial date — строка YYYY-MM-DD,
// не зависящая от таймзоны просмотра. Все операции — целочисленные, без
// Date-парсинга локали. Используется расписаниями (recurrence.ts) и движком
// прогноза (build.ts, load.ts). Конвенция дат — шапка
// migrations/0001_initial_schema.sql: даты TEXT 'YYYY-MM-DD'.

// Год 0000 отвергается здесь же, а не только в formatIsoDate: без этого
// isIsoDateString('0000-01-01') возвращал true, дата проходила валидацию и
// сохранялась (миграционные CHECK'и её тоже принимали — SQLite считает
// date('0000-01-01') корректной), а падало уже потом, на addDays() или
// генерации прогноза, когда formatIsoDate доходил до своей границы 0001–9999.
// Диапазон модуля один и объявлен в одном месте — в этой регулярке.
export const ISO_DATE_RE = /^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export interface IsoDate {
  year: number;
  month: number; // 1–12
  day: number; // 1–31, валидный для месяца
}

export function isIsoDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const { year, month, day } = splitIsoDate(value);
  return day <= daysInMonth(year, month);
}

function splitIsoDate(value: string): IsoDate {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

export function parseIsoDate(value: string): IsoDate {
  if (!isIsoDateString(value)) {
    throw new RangeError(`parseIsoDate: не валидная YYYY-MM-DD дата: ${JSON.stringify(value)}`);
  }
  return splitIsoDate(value);
}

export function formatIsoDate({ year, month, day }: IsoDate): string {
  // Отрицательный год давал '00-1' вместо отказа: строка переставала совпадать
  // с ISO_DATE_RE и неверно сравнивалась со всеми остальными датами. Остальные
  // функции модуля бросают RangeError — эта молчала.
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError(`formatIsoDate: год вне диапазона 0001–9999: ${year}`);
  }
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new RangeError(`daysInMonth: месяц вне диапазона: ${month}`);
  }
}

/** Дни с эпохи 1970-01-01 (день 0) — чисто календарная арифметика. */
export function isoDateToEpochDay(date: string): number {
  const { year, month, day } = parseIsoDate(date);
  // Алгоритм Хиннанта (civil_from_days наоборот) — целочисленный, без Date.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function epochDayToIsoDate(epochDay: number): string {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return formatIsoDate({ year: month <= 2 ? y + 1 : y, month, day });
}

export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError('addDays: days должен быть целым');
  return epochDayToIsoDate(isoDateToEpochDay(date) + days);
}

/** Разница dateB - dateA в днях. */
export function diffDays(dateA: string, dateB: string): number {
  return isoDateToEpochDay(dateB) - isoDateToEpochDay(dateA);
}

/**
 * День месяца с clamp: 29–31 в коротких месяцах прижимаются к последнему
 * календарному дню.
 */
export function clampedDate(year: number, month: number, dayOfMonth: number): string {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    throw new RangeError(`clampedDate: day_of_month вне диапазона 1–31: ${dayOfMonth}`);
  }
  const day = Math.min(dayOfMonth, daysInMonth(year, month));
  return formatIsoDate({ year, month, day });
}
