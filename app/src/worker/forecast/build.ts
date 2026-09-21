// Чистое ядро прогноза (issue #198, S1-4) — без единого обращения к D1. Вся
// I/O живёт в load.ts; buildForecast принимает уже загруженные данные и
// возвращает посуточные ряды и предупреждения. Разделение принципиально: ядро
// тестируется без базы (test/forecast-build.test.ts), API (api.ts) лишь
// склеивает load.ts → buildForecast → JSON.
import { addDays } from './dates';
import { makeConverter } from './convert';
import type { ForecastAccount, ForecastFlow } from './load';

export interface BuildForecastInput {
  accounts: ForecastAccount[];
  flows: ForecastFlow[];
  ratesE9: Map<string, number>;
  baseCurrency: string;
  asOfDate: string;
  horizonDays: number; // 1..366
  lowBalanceThresholdMinor: bigint;
  cashFlowDays: number; // окно метрики Cash Flow
}

export interface ForecastWarning {
  dimension: 'account' | 'country' | 'currency' | 'overall';
  dimensionKey: string; // id счёта строкой / код страны / код валюты / 'overall'
  currencyCode: string; // валюта, в которой посчитан ряд
  thresholdMinor: string;
  earliestBelowThresholdDate: string | null;
  earliestNonPositiveDate: string | null;
  minimumProjectedMinor: string;
  minimumProjectedDate: string;
  /**
   * Значение измерения на asOfDate — то, от чего строится ряд.
   *
   * Здесь стоит именно сумма, а не ярлык состояния («уже ниже» / «приближается»),
   * и это не мелочь: один ярлык склеивал два РАЗНЫХ состояния — «уже ниже
   * порога» и «уже в минусе», — а экран из него не мог их различить и говорил
   * «уже в минусе» про счёт с положительным балансом, просто небогатый. Из
   * пары (startMinor, thresholdMinor) оба состояния выводятся точно, и ROADMAP
   * «Фаза 3» требует именно их различать.
   */
  startMinor: string;
}

export interface BuildForecastResult {
  asOfDate: string;
  horizonDays: number;
  baseCurrency: string;
  netWorthMinor: bigint; // сумма балансов на сегодня, в базовой валюте
  cashFlowMinor: bigint; // overall[cashFlowDays-1] - netWorth
  cashFlowDays: number;
  countries: string[]; // отсортированы
  owners: string[]; // отсортированы; пусто, если ни одну группу владельца не пересчитать
  series: Array<{
    date: string;
    overallMinor: bigint;
    byCountry: Map<string, bigint>;
    byAccount: Map<number, bigint>;
    byOwner: Map<string, bigint>;
  }>;
  lowest: { date: string; amountMinor: bigint } | null; // минимум overall по горизонту
  accounts: Array<{ account: ForecastAccount; balanceBaseMinor: bigint | null }>;
  warnings: ForecastWarning[];
  missingRates: string[]; // валюты в ходу без курса, отсортированы
}

export function buildForecast(input: BuildForecastInput): BuildForecastResult {
  const { accounts, flows, ratesE9, baseCurrency, asOfDate, horizonDays, lowBalanceThresholdMinor, cashFlowDays } =
    input;

  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) {
    throw new RangeError('buildForecast: horizonDays должен быть целым числом 1..366');
  }
  if (!Number.isInteger(cashFlowDays) || cashFlowDays < 1) {
    throw new RangeError('buildForecast: cashFlowDays должен быть целым числом >= 1');
  }
  const cashFlowIndex = Math.min(cashFlowDays, horizonDays) - 1;

  // ---------- курсы и конверсия ----------

  // Список валют без курса собирается побочным эффектом конверсии — то есть
  // ровно тогда, когда курс кому-то реально понадобился, а не для каждой
  // валюты, встреченной в данных (см. докблок makeConverter).
  const missingRatesSet = new Set<string>();
  const convert = makeConverter(ratesE9, baseCurrency, (code) => missingRatesSet.add(code));

  // ---------- потоки → валюта счёта, посуточные ряды по счетам ----------

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  // Кумулятивные дельты по (account, date) — в НАТИВНОЙ валюте счёта. Поток,
  // чью валюту не удалось перевести в валюту счёта (нет курса хотя бы одной
  // из сторон), пропускается: его валюта уже осела в missingRatesSet через
  // convert() выше, и это единственный сигнал о пропуске — молчаливым он не
  // остаётся на уровне ответа (UI показывает missing_rates предупреждением).
  const deltasByAccountDate = new Map<number, Map<string, bigint>>();
  for (const f of flows) {
    const account = accountById.get(f.account_id);
    if (!account) continue; // load.ts уже фильтрует по eligibleAccountIds, но защититься дёшево
    const converted = convert(BigInt(f.amount_minor), f.currency, account.currency);
    if (converted === null) continue;
    let byDate = deltasByAccountDate.get(f.account_id);
    if (!byDate) deltasByAccountDate.set(f.account_id, (byDate = new Map()));
    byDate.set(f.date, (byDate.get(f.date) ?? 0n) + converted);
  }

  // Посуточные закрывающие балансы по счетам, дни 1..horizonDays от asOfDate.
  // День 0 (сам asOfDate) в ряд не входит — он же стартовый баланс.
  const perAccountDaily = new Map<number, bigint[]>();
  for (const a of accounts) {
    const deltas = deltasByAccountDate.get(a.id);
    const daily: bigint[] = [];
    let bal = BigInt(a.balance_minor);
    for (let i = 1; i <= horizonDays; i++) {
      const date = addDays(asOfDate, i);
      bal += deltas?.get(date) ?? 0n;
      daily.push(bal);
    }
    perAccountDaily.set(a.id, daily);
  }

  // ---------- балансы счетов в базовой валюте (для accounts-секции ответа) ----------

  const accountsOut = accounts.map((a) => ({
    account: a,
    balanceBaseMinor: convert(BigInt(a.balance_minor), a.currency, baseCurrency),
  }));

  // ---------- групповые измерения: currency, country, overall ----------
  //
  // Один общий проход для всех трёх групповых измерений (архивный `forecast.ts`
  // делал ровно так же — массив `groups` с `keyOf`), а не три копии одного и
  // того же цикла.
  const groups: Array<{ dimension: 'currency' | 'country' | 'overall' | 'owner'; keyOf: (a: ForecastAccount) => string }> = [
    { dimension: 'currency', keyOf: (a) => a.currency },
    { dimension: 'country', keyOf: (a) => a.country },
    { dimension: 'owner', keyOf: (a) => a.owner },
    { dimension: 'overall', keyOf: () => 'overall' },
  ];

  interface GroupResult {
    dimension: 'currency' | 'country' | 'overall' | 'owner';
    key: string;
    startBalance: bigint;
    daily: bigint[];
    /**
     * Все ли счета группы удалось пересчитать в базовую валюту. `false`
     * означает, что ряд — сумма ПОДМНОЖЕСТВА счетов, то есть занижен на
     * неизвестную величину. Такой ряд ещё можно нарисовать (график с
     * предупреждением о валютах без курса лучше пустого экрана), но
     * УТВЕРЖДАТЬ по нему что-либо нельзя — см. фильтр предупреждений ниже.
     */
    complete: boolean;
    /**
     * Валютная группа дополнительно хранит собственный нативный ряд. Для
     * country/overall он не определён: внутри такой группы валют несколько и
     * единственной честной единицей остаётся baseCurrency.
     */
    nativeCurrency: string | null;
    nativeStartBalance: bigint | null;
    nativeDaily: bigint[] | null;
  }

  const groupResults: GroupResult[] = [];
  let overallStart = 0n;
  let overallDaily: bigint[] = new Array(horizonDays).fill(0n);
  // Изначально false: группа overall может не появиться вовсе (счетов нет или
  // ни одну их валюту не пересчитать), и тогда нулевой ряд выше — заглушка, а
  // не результат. Ставится в true только вместе с реальной полной группой.
  let overallComplete = false;
  const countrySeries = new Map<string, bigint[]>();
  const ownerSeries = new Map<string, bigint[]>();
  const accountSeries = new Map<number, bigint[]>();
  for (const a of accounts) {
    // Ряд счёта на графике — в базовой валюте. Нет курса — нет линии: нулевой
    // ряд утверждал бы, что на счёте ничего нет, хотя сумма просто неизвестна.
    if (convert(0n, a.currency, baseCurrency) === null) continue;
    const nativeDaily = perAccountDaily.get(a.id)!;
    accountSeries.set(
      a.id,
      nativeDaily.map((native) => convert(native, a.currency, baseCurrency)!),
    );
  }

  for (const g of groups) {
    const byKey = new Map<string, ForecastAccount[]>();
    for (const a of accounts) {
      const key = g.keyOf(a);
      let members = byKey.get(key);
      if (!members) byKey.set(key, (members = []));
      members.push(a);
    }
    for (const key of [...byKey.keys()].sort()) {
      const members = byKey.get(key)!;
      // Валюта → позиция в накопителе. Дневной цикл складывает в массив
      // фиксированной длины вместо новой Map на каждый из H дней: порядок
      // слагаемых — порядок первого появления валюты в members, то есть
      // результат конверсии детерминирован, а аллокаций на горизонт — ноль.
      const currencies: string[] = [];
      const currencyIndex = new Map<string, number>();
      const memberSlots: Array<{ daily: bigint[]; slot: number; balanceMinor: bigint }> = [];
      for (const a of members) {
        let slot = currencyIndex.get(a.currency);
        if (slot === undefined) {
          slot = currencies.length;
          currencies.push(a.currency);
          currencyIndex.set(a.currency, slot);
        }
        memberSlots.push({ daily: perAccountDaily.get(a.id)!, slot, balanceMinor: BigInt(a.balance_minor) });
      }
      // ROUND_HALF_EVEN не дистрибутивна: агрегируем нативные суммы по валюте
      // и конвертируем каждую валютную группу ровно один раз, а не по счёту.
      // Валюта, которую не пересчитать (convert вернул null), в сумму не
      // добавляется вовсе — счёт в такой валюте выпадает из группового ряда
      // целиком, иначе итог тихо занижен бы под видом «нормального» числа.
      const convertGroupTotal = (nativeByCurrency: bigint[]): bigint => {
        let sum = 0n;
        for (let c = 0; c < currencies.length; c++) {
          const converted = convert(nativeByCurrency[c]!, currencies[c]!, baseCurrency);
          if (converted !== null) sum += converted;
        }
        return sum;
      };

      // Полнота группы — свойство состава валют, а не конкретного дня: курс
      // либо есть, либо нет, и от суммы он не зависит. Поэтому считается один
      // раз, до дневного цикла.
      const convertible = currencies.filter((code) => convert(0n, code, baseCurrency) !== null);
      const complete = convertible.length === currencies.length;

      // Группа, где не пересчитывается НИ ОДНА валюта, не выпускается вовсе.
      // Правило одно на все группы: показываем то, что вычислимо. Частично
      // пересчитанная группа вычислима — это заниженная, но настоящая сумма
      // (утверждать по ней ничего нельзя, см. фильтр предупреждений ниже).
      // А сумма группы, где не пересчитывается ничего, — не «ноль», а
      // неизвестность, и нарисовать её нулём значило бы сказать «денег в этой
      // стране нет», хотя они там есть. Такие счета видны в списке счетов с
      // пометкой «нет курса», а причина — в missingRates.
      if (convertible.length === 0) continue;

      const native = new Array<bigint>(currencies.length).fill(0n);
      for (const m of memberSlots) native[m.slot] += m.balanceMinor;
      const startBalance = convertGroupTotal(native);
      const nativeCurrency = g.dimension === 'currency' ? currencies[0]! : null;
      const nativeStartBalance = g.dimension === 'currency' ? native[0]! : null;

      const daily: bigint[] = [];
      const nativeDaily: bigint[] | null = g.dimension === 'currency' ? [] : null;
      for (let i = 0; i < horizonDays; i++) {
        native.fill(0n);
        for (const m of memberSlots) native[m.slot] += m.daily[i]!;
        nativeDaily?.push(native[0]!);
        daily.push(convertGroupTotal(native));
      }

      groupResults.push({
        dimension: g.dimension,
        key,
        startBalance,
        daily,
        complete,
        nativeCurrency,
        nativeStartBalance,
        nativeDaily,
      });
      if (g.dimension === 'overall') {
        overallStart = startBalance;
        overallDaily = daily;
        overallComplete = complete;
      }
      if (g.dimension === 'country') {
        countrySeries.set(key, daily);
      }
      if (g.dimension === 'owner') {
        ownerSeries.set(key, daily);
      }
    }
  }

  // ---------- итоговые ряды и метрики ----------

  // Страны — только те, чей ряд удалось посчитать (см. пропуск группы выше).
  // Страна, где все счета в валютах без курса, на график не попадает вовсе:
  // линия по нулю утверждала бы, что денег там нет.
  const countries = [...countrySeries.keys()].sort();
  const owners = [...ownerSeries.keys()].sort();
  const accountIds = [...accountSeries.keys()].sort((a, b) => a - b);
  const series = Array.from({ length: horizonDays }, (_, i) => ({
    date: addDays(asOfDate, i + 1),
    overallMinor: overallDaily[i]!,
    byCountry: new Map(countries.map((c) => [c, countrySeries.get(c)![i]!])),
    byAccount: new Map(accountIds.map((id) => [id, accountSeries.get(id)![i]!])),
    byOwner: new Map(owners.map((owner) => [owner, ownerSeries.get(owner)![i]!])),
  }));

  const netWorthMinor = overallStart;
  // cashFlowIndex всегда внутри [0, horizonDays-1] (Math.min(cashFlowDays,
  // horizonDays) - 1, а horizonDays >= 1), поэтому индекс всегда определён.
  const cashFlowMinor = overallDaily[cashFlowIndex]! - netWorthMinor;

  // Минимум ищется только по ПОЛНОМУ ряду. Неполный занижен на неизвестную
  // величину, и «минимум впереди» по нему — не осторожная оценка, а неверное
  // число: карточка на «Пульсе» просто не показывается, а владелец видит
  // предупреждение о валютах без курса и заводит недостающий курс.
  let lowest: BuildForecastResult['lowest'] = null;
  if (accounts.length > 0 && overallComplete) {
    let minIdx = 0;
    let min = overallDaily[0]!;
    for (let i = 1; i < overallDaily.length; i++) {
      if (overallDaily[i]! < min) {
        min = overallDaily[i]!;
        minIdx = i;
      }
    }
    lowest = { date: addDays(asOfDate, minIdx + 1), amountMinor: min };
  }

  // ---------- предупреждения ----------

  function scanSeries(
    dimension: ForecastWarning['dimension'],
    dimensionKey: string,
    currencyCode: string,
    thresholdMinor: bigint,
    startBalance: bigint,
    daily: bigint[],
  ): ForecastWarning | null {
    // Измерение, где нет ни денег, ни движения, молчит: ровный ноль весь
    // горизонт — это «пусто», а не «низкий баланс». Без этого пустой счёт
    // предупреждал вечно, просто потому что 0 меньше порога, и на проде такие
    // строки составляли четверть списка (решение владельца 2026-08-12,
    // issue #256). Как только по измерению появляется баланс или хоть одна
    // операция, ряд перестаёт быть нулевым и правило работает как обычно.
    if (startBalance === 0n && daily.every((v) => v === 0n)) return null;

    let earliestBelowThresholdIdx = -1;
    let earliestNonPositiveIdx = -1;
    let minIdx = 0;
    let min = daily[0]!;
    for (let i = 0; i < daily.length; i++) {
      if (daily[i]! < min) {
        min = daily[i]!;
        minIdx = i;
      }
      if (thresholdMinor > 0n && earliestBelowThresholdIdx === -1 && daily[i]! <= thresholdMinor) {
        earliestBelowThresholdIdx = i;
      }
      if (earliestNonPositiveIdx === -1 && daily[i]! <= 0n) {
        earliestNonPositiveIdx = i;
      }
    }
    if (earliestBelowThresholdIdx === -1 && earliestNonPositiveIdx === -1) return null;
    return {
      dimension,
      dimensionKey,
      currencyCode,
      // account сканируется только против нуля; currency получает тот же порог,
      // заранее переведённый из базовой валюты в нативную валюту группы.
      thresholdMinor: thresholdMinor.toString(),
      earliestBelowThresholdDate: earliestBelowThresholdIdx === -1 ? null : addDays(asOfDate, earliestBelowThresholdIdx + 1),
      earliestNonPositiveDate: earliestNonPositiveIdx === -1 ? null : addDays(asOfDate, earliestNonPositiveIdx + 1),
      startMinor: startBalance.toString(),
      minimumProjectedMinor: min.toString(),
      minimumProjectedDate: addDays(asOfDate, minIdx + 1),
    };
  }

  const warnings: ForecastWarning[] = [];

  /**
   * Наибольшая сумма в `currency`, которая после штатного ROUND_HALF_EVEN всё
   * ещё не превосходит базовый порог. Простая обратная конверсия порога может
   * ошибиться на минорную единицу: например, вернуть 92851 EUR, хотя обратно
   * это уже 100001 USD. Монотонная граница сохраняет исходную классификацию в
   * baseCurrency и одновременно позволяет вернуть честный нативный порог UI.
   */
  function thresholdCutoffInCurrency(currency: string): bigint | null {
    // Нулевая настройка означает именно «только ноль/минус». Положительная
    // нативная сумма не становится пороговой лишь потому, что округлилась в
    // ноль при конверсии в дешёвой валюте.
    if (lowBalanceThresholdMinor === 0n) return 0n;

    const approximate = convert(lowBalanceThresholdMinor, baseCurrency, currency);
    if (approximate === null) return null;

    let low = approximate > 0n ? approximate : 0n;
    let high: bigint;
    const convertedLow = convert(low, currency, baseCurrency);
    if (convertedLow === null) return null;

    if (convertedLow > lowBalanceThresholdMinor) {
      high = low;
      low = 0n;
    } else {
      high = low + 1n;
      while (true) {
        const convertedHigh = convert(high, currency, baseCurrency);
        if (convertedHigh === null) return null;
        if (convertedHigh > lowBalanceThresholdMinor) break;
        low = high;
        high *= 2n;
      }
    }

    while (high - low > 1n) {
      const middle = (low + high) / 2n;
      const convertedMiddle = convert(middle, currency, baseCurrency);
      if (convertedMiddle === null) return null;
      if (convertedMiddle <= lowBalanceThresholdMinor) low = middle;
      else high = middle;
    }
    return low;
  }

  // dimension=account — нативная валюта, только против нуля.
  for (const a of accounts) {
    const w = scanSeries('account', String(a.id), a.currency, 0n, BigInt(a.balance_minor), perAccountDaily.get(a.id)!);
    if (w) warnings.push(w);
  }

  // Страна и общий итог — в базовой валюте; валютная группа — в своей
  // нативной валюте. Все три измерения проверяются против порога И против нуля.
  //
  // Неполная группа предупреждений не даёт вовсе. Причина: её ряд — сумма
  // только тех счетов, чью валюту удалось пересчитать, то есть заведомо
  // занижена. На таком ряде порог срабатывал бы там, где реальных денег
  // хватает, а вырожденный случай (единственный счёт в валюте без курса) давал
  // бы ряд из нулей и предупреждение «уже ниже порога» о сумме, которая на
  // самом деле НЕИЗВЕСТНА, а не равна нулю. Ложная тревога здесь дороже
  // пропуска: настоящий сигнал никуда не делся — валюта без курса приходит в
  // `missingRates`, и это состояние поправимо одним курсом. Предупреждения по
  // самим счетам (dimension=account) при этом работают всегда: они считаются в
  // нативной валюте и пересчёта не требуют.
  for (const g of groupResults) {
    if (!g.complete) continue;
    // owner — ряд для графика «по пользователю», не отдельное предупреждение:
    // сигнал низкого баланса по человеку уже покрыт account/country/overall.
    if (g.dimension === 'owner') continue;
    let w: ForecastWarning | null;
    if (g.dimension === 'currency') {
      // Подпись «Валюта RSD» обязана сопровождаться рядом в RSD, а не внешне
      // ошибочным знаком базовой валюты. Порог остаётся одной настройкой в
      // baseCurrency и переводится тем же серверным FX-путём перед сравнением.
      const nativeThreshold = thresholdCutoffInCurrency(g.nativeCurrency!);
      if (nativeThreshold === null) continue; // complete гарантирует обратимость, защита остаётся fail-closed
      w = scanSeries(
        g.dimension,
        g.key,
        g.nativeCurrency!,
        nativeThreshold,
        g.nativeStartBalance!,
        g.nativeDaily!,
      );
    } else {
      w = scanSeries(g.dimension, g.key, baseCurrency, lowBalanceThresholdMinor, g.startBalance, g.daily);
    }
    if (w) warnings.push(w);
  }

  warnings.sort((x, y) => (x.dimension === y.dimension ? (x.dimensionKey < y.dimensionKey ? -1 : 1) : x.dimension < y.dimension ? -1 : 1));

  return {
    asOfDate,
    horizonDays,
    baseCurrency,
    netWorthMinor,
    cashFlowMinor,
    cashFlowDays,
    countries,
    owners,
    series,
    lowest,
    accounts: accountsOut,
    warnings,
    missingRates: [...missingRatesSet].sort(),
  };
}
