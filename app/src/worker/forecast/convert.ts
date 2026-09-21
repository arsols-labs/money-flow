// Конверсия сумм между валютами через курсы к базовой (issue #198, S1-4).
//
// Отдельный модуль, а не приватная функция build.ts, потому что конвертируют
// двое и по-разному: ядро прогноза (build.ts) — агрегаты по группам счетов, а
// роут `/forecast` (api.ts) — суммы отдельных предстоящих операций для секции
// `upcoming`. Пока это были две реализации, они могли разойтись в округлении и
// в трактовке «курса нет» — и разошлись бы молча, потому что обе выдают
// правдоподобное число. Здесь путь один (Закон 3).
import { IDENTITY_RATE, convertMinor, rateFromE9, type FxRate } from './fx';
import { fractionDigits } from '../../shared/currency';

export interface Converter {
  /** `null` означает «нет курса хотя бы у одной стороны», а не «ноль». */
  (amountMinor: bigint, from: string, to: string): bigint | null;
}

/**
 * Конвертер поверх таблицы курсов `code -> rate_e9`.
 *
 * `onMissingRate` вызывается ровно тогда, когда курс реально понадобился и его
 * не оказалось — то есть список «валют без курса» собирается по факту нужды, а
 * не по факту присутствия валюты в данных. Разница видна на счёте в базовой
 * валюте с операцией в ней же: конверсия там не нужна вовсе, и сообщать о
 * недостающем курсе не о чем.
 */
export function makeConverter(
  ratesE9: Map<string, number>,
  baseCurrency: string,
  onMissingRate?: (code: string) => void,
): Converter {
  function rateOf(code: string): FxRate | null {
    if (code === 'USD') return IDENTITY_RATE;
    const e9 = ratesE9.get(code);
    if (e9 === undefined) {
      onMissingRate?.(code);
      return null;
    }
    return rateFromE9(e9);
  }

  return (amountMinor, from, to) => {
    // Одинаковые коды возвращаются как есть — без прогона через
    // BigInt-математику: платить округлением ROUND_HALF_EVEN за тождественную
    // конверсию незачем, да и курс для неё не нужен (см. rateOf выше).
    if (from === to) return amountMinor;
    const sourceRate = rateOf(from);
    const targetRate = rateOf(to);
    // Оба rateOf вызваны ДО проверки намеренно: когда курса нет у обеих сторон,
    // владелец должен увидеть в missing_rates обе валюты, а не первую.
    if (sourceRate === null || targetRate === null) return null;
    return convertMinor(
      amountMinor,
      { rate: sourceRate, currency: { exponent: fractionDigits(from) } },
      { rate: targetRate, currency: { exponent: fractionDigits(to) } },
    );
  };
}
