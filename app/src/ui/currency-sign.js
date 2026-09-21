// Знак и флаг валюты для кнопок и списков.
//
// Кнопка базовой валюты в шапке — самый тесный элемент интерфейса: место есть
// ровно под один глиф. Поэтому там стоит знак валюты ($ € ₽ ₾ ฿), а трёхбуквенный
// код показывается уже в раскрытом списке, где рядом помещается и флаг страны.
//
// Таблицы знаков в репозитории нет намеренно: её пришлось бы вести руками и она
// разошлась бы с реальностью на первой же новой валюте. Знак берётся из ICU
// (`Intl.NumberFormat` + `currencyDisplay: 'narrowSymbol'`) — той же библиотеки,
// которой уже форматируются суммы в money.js.

/** Знак-заглушка ISO 4217 — «валюта вообще», когда своего знака у кода нет. */
export const GENERIC_CURRENCY_SIGN = '¤';

/** Флаг-заглушка для наднациональных и небумажных кодов (XAU, XDR). */
export const GENERIC_CURRENCY_FLAG = '🌐';

function normalize(code) {
  return String(code ?? '').trim().toUpperCase();
}

/**
 * Знак валюты одним-двумя глифами: `USD → $`, `RUB → ₽`, `PLN → zł`.
 *
 * ICU возвращает сам код (`RSD → "RSD"`), когда собственного знака у валюты
 * нет, — это и есть признак «знака не существует», а не короткая подпись:
 * трёхбуквенный код на кнопке шириной в один глиф не поместится и сольётся с
 * соседней кнопкой. В таком случае отдаётся `¤`, а какая именно валюта
 * выбрана — видно в раскрытом списке и в подписи кнопки для скринридера.
 *
 * Два глифа (`zł`, `kr`) допускаются: это настоящие знаки валют, просто
 * составные, и терять их ради ровно одного символа значит показать `¤` там,
 * где знак есть.
 */
export function currencySymbol(code) {
  const c = normalize(code);
  if (!/^[A-Z]{3}$/.test(c)) return GENERIC_CURRENCY_SIGN;
  let symbol = '';
  try {
    const parts = new Intl.NumberFormat('en', {
      style: 'currency', currency: c, currencyDisplay: 'narrowSymbol',
    }).formatToParts(0);
    symbol = parts.find((p) => p.type === 'currency')?.value ?? '';
  } catch {
    return GENERIC_CURRENCY_SIGN;
  }
  if (!symbol || symbol === c) return GENERIC_CURRENCY_SIGN;
  return [...symbol].length <= 2 ? symbol : GENERIC_CURRENCY_SIGN;
}

/**
 * Флаг страны валюты: `USD → 🇺🇸`, `RSD → 🇷🇸`, `EUR → 🇪🇺`.
 *
 * Первые две буквы кода ISO 4217 — это код страны ISO 3166-1 alpha-2, на том
 * же соглашении построена и сама нумерация валют. Исключения ровно два:
 * евро (`EU` — не страна, но флаг у неё есть) и коды на `X`, у которых страны
 * нет по определению (`XAU` — золото, `XDR` — расчётная единица МВФ).
 *
 * Флаг собирается из региональных индикаторов, а не берётся из таблицы: пар
 * «код → эмодзи» двести с лишним, и любая их копия в репозитории устареет.
 */
export function currencyFlag(code) {
  const c = normalize(code);
  if (!/^[A-Z]{3}$/.test(c) || c.startsWith('X')) return GENERIC_CURRENCY_FLAG;
  const region = c === 'EUR' ? 'EU' : c.slice(0, 2);
  return [...region]
    .map((ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65))
    .join('');
}
