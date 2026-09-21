// Golden-тесты чистого ядра прогноза (issue #198, S1-4) — buildForecast не
// трогает D1 вовсе (см. докблок src/worker/forecast/build.ts), поэтому весь
// файл работает с руками собранными ForecastAccount/ForecastFlow, без
// D1-стенда. По духу — портированный `forecast golden` из archive/v2-codex
// (app/test/readmodel.test.ts), но под нашу схему: суммы со знаком, своя
// валюта на потоке, настраиваемая базовая валюта, измерение `currency`
// наравне с `country`/`overall` (ROADMAP, «Фаза 3 — Прогноз и дашборд»).
import { describe, expect, it } from 'vitest';
import { addDays } from '../src/worker/forecast/dates';
import { buildForecast, type BuildForecastInput } from '../src/worker/forecast/build';
import { expandRecurring } from '../src/worker/forecast/recurrence';
import type { ForecastAccount, ForecastFlow } from '../src/worker/forecast/load';

function account(overrides: Partial<ForecastAccount> & Pick<ForecastAccount, 'id' | 'currency' | 'balance_minor'>): ForecastAccount {
  return {
    name: `Счёт ${overrides.id}`,
    owner: 'Алекс',
    country: 'USA',
    balance_updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function flow(overrides: Partial<ForecastFlow> & Pick<ForecastFlow, 'account_id' | 'date' | 'amount_minor' | 'currency'>): ForecastFlow {
  return {
    title: 'Операция',
    kind: 'planned',
    source_id: 1,
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildForecastInput> = {}): BuildForecastInput {
  return {
    accounts: [],
    flows: [],
    ratesE9: new Map(),
    baseCurrency: 'USD',
    asOfDate: '2026-01-01',
    horizonDays: 7,
    lowBalanceThresholdMinor: 0n,
    cashFlowDays: 30,
    ...overrides,
  };
}

describe('buildForecast — без потоков, одна валюта = базовая', () => {
  it('ряд постоянен, lowest на первом дне, конверсия не нужна вовсе', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 100000 });
    const result = buildForecast(
      baseInput({ accounts: [acc], asOfDate: '2026-07-23', horizonDays: 5, cashFlowDays: 3 }),
    );

    expect(result.series).toHaveLength(5);
    for (const day of result.series) {
      expect(day.overallMinor).toBe(100000n);
      expect(day.byCountry.get('USA')).toBe(100000n);
    }
    expect(result.netWorthMinor).toBe(100000n);
    expect(result.cashFlowMinor).toBe(0n); // 3-й день такой же, как старт
    expect(result.lowest).toEqual({ date: '2026-07-24', amountMinor: 100000n });
    expect(result.warnings).toEqual([]);
    expect(result.missingRates).toEqual([]); // курс USD→USD никогда не запрашивался
    expect(result.accounts).toEqual([{ account: acc, balanceBaseMinor: 100000n }]);
    expect(result.countries).toEqual(['USA']);
    expect(result.owners).toEqual(['Алекс']);
    expect(result.series[0]!.byAccount.get(1)).toBe(100000n);
    expect(result.series[0]!.byOwner.get('Алекс')).toBe(100000n);
  });

  it('splits account and owner series so a negative card can sit below zero', () => {
    const cash = account({ id: 1, name: 'Cash', owner: 'Alex', country: 'USA', currency: 'USD', balance_minor: 20000 });
    const card = account({ id: 2, name: 'Everyday Card', owner: 'Sam', country: 'USA', currency: 'USD', balance_minor: -4000 });
    const result = buildForecast(baseInput({ accounts: [cash, card], horizonDays: 2 }));

    expect(result.owners).toEqual(['Alex', 'Sam']);
    expect(result.series[0]!.byAccount.get(1)).toBe(20000n);
    expect(result.series[0]!.byAccount.get(2)).toBe(-4000n);
    expect(result.series[0]!.byOwner.get('Alex')).toBe(20000n);
    expect(result.series[0]!.byOwner.get('Sam')).toBe(-4000n);
    expect(result.series[0]!.overallMinor).toBe(16000n);
    expect(result.warnings.map((w) => String(w.dimension))).not.toContain('owner');
  });
});

describe('buildForecast — monthly clamp 31→30→31 на горизонте 100 дней', () => {
  it('day_of_month=31 прижимается в коротких месяцах и возвращается в длинных', () => {
    const acc = account({ id: 1, currency: 'RUB', country: 'RUS', balance_minor: 470000 });
    const asOfDate = '2026-07-23';
    const horizonDays = 100; // покрывает до 2026-10-31 включительно
    const limitDate = addDays(asOfDate, horizonDays);

    // Даты берём из уже отдельно протестированного expandRecurring — здесь
    // проверяется агрегация build.ts, а не сама развёртка правила.
    const dates = expandRecurring(
      { id: 2, frequency: 'monthly', interval_count: 1, day_of_month: 31, month_of_year: null, next_due_date: '2026-07-31', end_date: null },
      asOfDate,
      limitDate,
    );
    const flows: ForecastFlow[] = dates.map((date, i) => flow({
      account_id: 1, date, amount_minor: -12000, currency: 'RUB', title: 'Groceries', kind: 'recurring', source_id: 2 + i,
    }));

    const result = buildForecast(baseInput({ accounts: [acc], flows, baseCurrency: 'RUB', asOfDate, horizonDays }));

    const on = (date: string) => result.series.find((s) => s.date === date)?.overallMinor;
    expect(on('2026-07-31')).toBe(458000n); // 470000 - 12000
    expect(on('2026-08-31')).toBe(446000n);
    expect(on('2026-09-30')).toBe(434000n); // клэмп 31→30 сентября — третье списание
    expect(on('2026-10-31')).toBe(422000n); // вернулся к 31-му — четвёртое списание
    expect(result.warnings).toEqual([]); // баланс весь горизонт положителен
  });
});

describe('buildForecast — мультивалютность: поток в валюте, отличной от валюты счёта', () => {
  it('EUR-поток конвертируется в RSD (валюту счёта), затем группа — в базовую USD', () => {
    const acc = account({ id: 1, currency: 'RSD', country: 'SRB', balance_minor: 200000 }); // 2000.00 RSD
    const ratesE9 = new Map([
      ['RSD', 9_700_000], // 0.0097 USD/RSD
      ['EUR', 1_140_000_000], // 1.14 USD/EUR
    ]);
    const f = flow({ account_id: 1, date: '2026-01-06', amount_minor: -1000, currency: 'EUR', title: 'Страховка' }); // -10.00 EUR, чужая валюта

    const result = buildForecast(
      baseInput({ accounts: [acc], flows: [f], ratesE9, asOfDate: '2026-01-01', horizonDays: 10 }),
    );

    // -10.00 EUR при курсах 1.14/0.0097 даёт -1175.26 RSD (ROUND_HALF_EVEN) —
    // независимо посчитано в момент написания теста, см. отчёт исполнителя.
    // 2000.00 - 1175.26 = 824.74 RSD → в USD по 0.0097: 19.40 до потока,
    // 8.00 после (824.74 * 0.0097 = 7.99998 → округление к чётному 8.00).
    const day = (date: string) => result.series.find((s) => s.date === date)!;
    expect(day('2026-01-05').overallMinor).toBe(1940n); // ещё до потока (он датирован 01-06)
    expect(day('2026-01-06').overallMinor).toBe(800n); // поток применился
    expect(result.series.at(-1)!.overallMinor).toBe(800n); // и остаётся до конца горизонта

    // accounts[].balanceBaseMinor — это СЕГОДНЯШНИЙ баланс, потоки на него не влияют.
    expect(result.accounts).toEqual([{ account: acc, balanceBaseMinor: 1940n }]);
    expect(result.missingRates).toEqual([]); // и RSD, и EUR — с курсом
  });
});

describe('buildForecast — отсутствующий курс', () => {
  it('счёт и его валюта выпадают из групповых измерений, валюта — в missing_rates', () => {
    const unconvertible = account({ id: 1, currency: 'XYZ', country: 'ZZZ', balance_minor: 500 });
    const result = buildForecast(baseInput({ accounts: [unconvertible], horizonDays: 3 }));

    expect(result.accounts).toEqual([{ account: unconvertible, balanceBaseMinor: null }]);
    expect(result.missingRates).toEqual(['XYZ']);
    // Групповые ряды исключают счёт целиком — сумма по валюте/стране/overall
    // остаётся 0, а не искажённым числом, притворяющимся настоящим.
    expect(result.netWorthMinor).toBe(0n);
    // Страны ZZZ на графике нет вовсе: все её счета в валюте без курса, и её
    // итог — не ноль, а неизвестность. Линия по нулю сказала бы «денег в этой
    // стране нет», хотя на счёте лежит 500 XYZ.
    expect(result.countries).toEqual([]);
    for (const day of result.series) {
      expect(day.overallMinor).toBe(0n);
      expect(day.byCountry.size).toBe(0);
    }
    // dimension=account считается в НАТИВНОЙ валюте и от курса не зависит:
    // 500 XYZ положителен, предупреждения по этому измерению нет.
    expect(result.warnings.find((w) => w.dimension === 'account')).toBeUndefined();
    // Групповых предупреждений тоже нет, и это главное в этом кейсе. Ряд
    // неполной группы — сумма подмножества счетов; здесь подмножество пустое,
    // то есть 0 означает «неизвестно», а не «денег нет». Утверждать по такому
    // ряду «уже ниже порога» — прямая ложная тревога, поэтому неполные группы
    // из предупреждений исключены целиком.
    expect(result.warnings.filter((w) => w.dimension !== 'account')).toHaveLength(0);
    // По той же причине не показывается и «минимум баланса впереди».
    expect(result.lowest).toBeNull();
  });

  it('неполная группа не предупреждает даже когда её усечённый ряд ушёл ниже порога', () => {
    // Порог 100 000. Счёт с курсом даёт 500 базовых минорных единиц — этого
    // мало, и на полном ряде предупреждение было бы честным. Но оба счёта
    // лежат в ОДНОЙ стране, и валюту второго не пересчитать: страновой итог
    // занижен на неизвестную величину, настоящие деньги могут быть и выше
    // порога. Поэтому по country=USA и по overall мы молчим.
    const withRate = account({ id: 1, currency: 'USD', country: 'USA', balance_minor: 500 });
    const noRate = account({ id: 2, currency: 'XYZ', country: 'USA', balance_minor: 900_000 });
    const result = buildForecast(
      baseInput({ accounts: [withRate, noRate], horizonDays: 3, lowBalanceThresholdMinor: 100_000n }),
    );

    expect(result.missingRates).toEqual(['XYZ']);
    expect(result.netWorthMinor).toBe(500n); // усечённый итог виден
    expect(result.warnings.find((w) => w.dimension === 'country')).toBeUndefined();
    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeUndefined();
    expect(result.lowest).toBeNull();
    // Полнота — свойство ГРУППЫ, а не базы: measure currency=USD состоит
    // только из USD, поэтому оно полное и предупреждает.
    expect(result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'USD')).toBeDefined();
    // А currency=XYZ пуста после отбрасывания — про неё тоже молчим.
    expect(result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'XYZ')).toBeUndefined();
  });

  it('группа целиком с курсом предупреждает как обычно, даже если рядом есть валюта без курса', () => {
    // Контрольный случай к двум предыдущим: измерение currency=USD полное
    // (в нём только USD), поэтому по нему предупреждение выпускается, хотя в
    // базе есть и валюта без курса. Полнота считается по группе, а не по базе.
    const poor = account({ id: 1, currency: 'USD', country: 'USA', balance_minor: 500 });
    const noRate = account({ id: 2, currency: 'XYZ', country: 'SRB', balance_minor: 900_000 });
    const result = buildForecast(
      baseInput({ accounts: [poor, noRate], horizonDays: 3, lowBalanceThresholdMinor: 100_000n }),
    );

    const usd = result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.startMinor).toBe('500'); // уже ниже порога 100 000 на день 0
    // а overall неполный — по нему молчим
    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeUndefined();
  });

  it('второй, конвертируемый счёт того же измерения не страдает от соседа без курса', () => {
    const bad = account({ id: 1, currency: 'XYZ', country: 'SRB', balance_minor: 500 });
    const good = account({ id: 2, currency: 'USD', country: 'SRB', balance_minor: 100000 });
    const result = buildForecast(baseInput({ accounts: [bad, good], horizonDays: 2 }));

    expect(result.missingRates).toEqual(['XYZ']);
    // country='SRB' объединяет оба счёта — но XYZ выпал, поэтому сумма равна
    // ТОЛЬКО конвертируемому счёту, а не занижена молча до странного числа.
    expect(result.series[0]!.byCountry.get('SRB')).toBe(100000n);
    expect(result.series[0]!.byAccount.has(1)).toBe(false);
    expect(result.series[0]!.byAccount.get(2)).toBe(100000n);
    expect(result.owners).toEqual(['Алекс']);
  });
});

describe('buildForecast — порог: уже ниже vs пересечёт позже', () => {
  it('баланс уже ниже порога на день 0 — это видно по startMinor', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 50000 }); // $500
    const result = buildForecast(
      baseInput({ accounts: [acc], lowBalanceThresholdMinor: 100000n, horizonDays: 3 }), // порог $1000
    );
    const overall = result.warnings.find((w) => w.dimension === 'overall')!;
    // startMinor вместе с thresholdMinor и даёт состояние «уже ниже порога»:
    // 50 000 <= 100 000, но при этом > 0 — то есть НЕ «уже в минусе». Ярлык
    // state склеивал эти два случая, и экран на нём говорил про минус у счёта
    // с положительным балансом.
    expect(overall.startMinor).toBe('50000');
    expect(overall.thresholdMinor).toBe('100000');
    expect(overall.earliestBelowThresholdDate).toBe('2026-01-02');
    expect(overall.earliestNonPositiveDate).toBeNull(); // 500 > 0, в ноль не уходит
    // account-измерение порог не видит — только ноль, а тут баланс положителен.
    expect(result.warnings.find((w) => w.dimension === 'account')).toBeUndefined();
  });

  it('порог и ноль пересекаются в РАЗНЫЕ дни — обе даты в одном предупреждении', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 150000 }); // $1500, выше порога
    const flows: ForecastFlow[] = [
      flow({ account_id: 1, date: '2026-01-06', amount_minor: -70000, currency: 'USD', source_id: 1 }), // → $800, ниже порога, ещё > 0
      flow({ account_id: 1, date: '2026-01-11', amount_minor: -100000, currency: 'USD', source_id: 2 }), // → -$200, в минус
    ];
    const result = buildForecast(
      baseInput({ accounts: [acc], flows, lowBalanceThresholdMinor: 100000n, horizonDays: 15 }),
    );
    const overall = result.warnings.find((w) => w.dimension === 'overall')!;
    expect(overall.startMinor).toBe('150000'); // на день 0 порог ещё не пробит
    expect(overall.earliestBelowThresholdDate).toBe('2026-01-06');
    expect(overall.earliestNonPositiveDate).toBe('2026-01-11');
    expect(overall.minimumProjectedMinor).toBe('-20000');
    expect(overall.minimumProjectedDate).toBe('2026-01-11');
  });
});

describe('buildForecast — пустое измерение молчит (issue #256)', () => {
  it('счёт с нулевым балансом и без операций не даёт предупреждений вовсе', () => {
    // Найдено владельцем на проде: пустой EUR-счёт предупреждал всегда, просто
    // потому что 0 меньше порога в 1000 $. Предупреждать не о чем — денег нет
    // и движения нет.
    const empty = account({ id: 1, currency: 'USD', country: 'SRB', balance_minor: 0 });
    const result = buildForecast(
      baseInput({ accounts: [empty], horizonDays: 5, lowBalanceThresholdMinor: 100_000n }),
    );

    expect(result.warnings).toEqual([]);
    // Счёт при этом никуда не делся: он есть в списке и в рядах, просто про
    // него нечего сказать.
    expect(result.accounts).toHaveLength(1);
    expect(result.netWorthMinor).toBe(0n);
  });

  it('нулевой баланс, но операция на горизонте — предупреждение возвращается', () => {
    const acc = account({ id: 1, currency: 'USD', country: 'SRB', balance_minor: 0 });
    const flows = [flow({ account_id: 1, date: '2026-01-04', amount_minor: -5000, currency: 'USD' })];
    const result = buildForecast(
      baseInput({ accounts: [acc], flows, horizonDays: 5, lowBalanceThresholdMinor: 100_000n }),
    );

    // Ряд перестал быть нулевым — правило работает как обычно, и по счёту, и
    // по группам.
    expect(result.warnings.find((w) => w.dimension === 'account')).toBeDefined();
    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeDefined();
  });

  it('ненулевой баланс с ровным рядом молчания не даёт — порог тут ни при чём', () => {
    // Контроль к первому кейсу: тишина наступает именно от «ноль И без
    // движения», а не от «ряд постоянен».
    const acc = account({ id: 1, currency: 'USD', country: 'SRB', balance_minor: 500 });
    const result = buildForecast(
      baseInput({ accounts: [acc], horizonDays: 5, lowBalanceThresholdMinor: 100_000n }),
    );

    expect(result.warnings.find((w) => w.dimension === 'overall')).toBeDefined();
  });
});

describe('buildForecast — lowest при равных минимумах берёт самую раннюю дату', () => {
  it('два одинаковых минимума на горизонте — выбран первый по времени', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 1000 });
    const flows: ForecastFlow[] = [
      flow({ account_id: 1, date: '2026-01-02', amount_minor: -500, currency: 'USD', source_id: 1 }), // день1: 500
      flow({ account_id: 1, date: '2026-01-03', amount_minor: 500, currency: 'USD', source_id: 2 }), // день2: 1000
      flow({ account_id: 1, date: '2026-01-04', amount_minor: -500, currency: 'USD', source_id: 3 }), // день3: 500 — тот же минимум
    ];
    const result = buildForecast(baseInput({ accounts: [acc], flows, horizonDays: 3 }));

    expect(result.series.map((s) => s.overallMinor)).toEqual([500n, 1000n, 500n]);
    expect(result.lowest).toEqual({ date: '2026-01-02', amountMinor: 500n }); // не 2026-01-04
  });

  it('lowest — null, только если счетов нет вовсе', () => {
    const result = buildForecast(baseInput({ accounts: [], horizonDays: 3 }));
    expect(result.lowest).toBeNull();
    expect(result.series).toHaveLength(3);
    expect(result.series[0]!.overallMinor).toBe(0n);
    expect(result.warnings).toEqual([]);
    expect(result.countries).toEqual([]);
  });
});

describe('buildForecast — cash_flow при cashFlowDays > horizonDays', () => {
  it('индекс метрики зажимается в последний день горизонта', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 100000 });
    const flows: ForecastFlow[] = [
      flow({ account_id: 1, date: '2026-01-05', amount_minor: -30000, currency: 'USD', source_id: 1 }),
    ];
    const result = buildForecast(baseInput({ accounts: [acc], flows, horizonDays: 5, cashFlowDays: 30 }));

    expect(result.cashFlowDays).toBe(30); // поле отражает ЗАПРОШЕННОЕ окно, не зажатое
    expect(result.series).toHaveLength(5);
    expect(result.series[4]!.overallMinor).toBe(70000n); // 100000 - 30000, последний день
    expect(result.cashFlowMinor).toBe(-30000n); // 70000 - 100000, а не выход за границу массива
  });

  it('горизонт вне 1..366 или cashFlowDays < 1 — RangeError', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 0 });
    expect(() => buildForecast(baseInput({ accounts: [acc], horizonDays: 0 }))).toThrow(RangeError);
    expect(() => buildForecast(baseInput({ accounts: [acc], horizonDays: 367 }))).toThrow(RangeError);
    expect(() => buildForecast(baseInput({ accounts: [acc], cashFlowDays: 0 }))).toThrow(RangeError);
  });
});

// Уточнение контракта (ROADMAP «Фаза 3 — Прогноз и дашборд на своих данных»):
// «для каждого счёта, страны И ВАЛЮТЫ — первая дата пересечения нуля и
// минимальный баланс». Измерение currency — та же группировка, что country и
// overall, но по коду валюты счёта, а не по стране.
describe('buildForecast — измерение currency', () => {
  it('два счёта в одной валюте: предупреждение по СУММЕ, а не по каждому счёту отдельно', () => {
    const acc1 = account({ id: 1, currency: 'USD', country: 'USA', balance_minor: 70000 }); // $700
    const acc2 = account({ id: 2, currency: 'USD', country: 'CAN', balance_minor: 20000 }); // $200
    // Сумма $900 — ниже порога $1000, хотя оба счёта по отдельности не в нуле.
    const result = buildForecast(
      baseInput({ accounts: [acc1, acc2], lowBalanceThresholdMinor: 100000n, horizonDays: 3 }),
    );

    const currencyWarnings = result.warnings.filter((w) => w.dimension === 'currency');
    expect(currencyWarnings).toHaveLength(1);
    expect(currencyWarnings[0]).toMatchObject({
      dimension: 'currency',
      dimensionKey: 'USD',
      currencyCode: 'USD',
      thresholdMinor: '100000',
      earliestBelowThresholdDate: '2026-01-02',
      earliestNonPositiveDate: null,
      minimumProjectedMinor: '90000',
      startMinor: '90000',
    });

    // dimension=account по отдельности порог не пробивает ни у одного счёта —
    // ни один из них не уходит в ноль.
    expect(result.warnings.filter((w) => w.dimension === 'account')).toEqual([]);
  });

  it('разные валюты — разные группы, предупреждение только у просевшей', () => {
    const usd = account({ id: 1, currency: 'USD', balance_minor: 50000 }); // $500, ниже порога
    const eur = account({ id: 2, currency: 'EUR', balance_minor: 500000 }); // 5000.00 EUR, выше
    const ratesE9 = new Map([['EUR', 1_140_000_000]]);
    const result = buildForecast(
      baseInput({ accounts: [usd, eur], ratesE9, lowBalanceThresholdMinor: 100000n, horizonDays: 2 }),
    );

    const byKey = new Map(result.warnings.filter((w) => w.dimension === 'currency').map((w) => [w.dimensionKey, w]));
    expect(byKey.has('USD')).toBe(true);
    expect(byKey.has('EUR')).toBe(false);
  });

  it('валютная группа отдаёт минимум и порог в своей нативной валюте', () => {
    const eur = account({ id: 1, currency: 'EUR', balance_minor: 80_000 }); // €800
    const ratesE9 = new Map([['EUR', 1_140_000_000]]); // €1 = $1.14
    const result = buildForecast(
      baseInput({ accounts: [eur], ratesE9, lowBalanceThresholdMinor: 100_000n, horizonDays: 2 }),
    );

    const currency = result.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'EUR');
    expect(currency).toMatchObject({
      currencyCode: 'EUR',
      startMinor: '80000',
      minimumProjectedMinor: '80000',
      thresholdMinor: '87719',
    });
  });

  it('не даёт ложное валютное предупреждение на границе банковского округления', () => {
    const ratesE9 = new Map([['EUR', 1_077_000_000]]); // 92851 EUR minor -> 100001 USD minor
    const above = account({ id: 1, currency: 'EUR', balance_minor: 92_851 });
    const resultAbove = buildForecast(
      baseInput({ accounts: [above], ratesE9, lowBalanceThresholdMinor: 100_000n, horizonDays: 2 }),
    );
    expect(resultAbove.warnings.some((w) => w.dimension === 'currency' && w.dimensionKey === 'EUR')).toBe(false);

    const atBoundary = account({ id: 1, currency: 'EUR', balance_minor: 92_850 });
    const resultAtBoundary = buildForecast(
      baseInput({ accounts: [atBoundary], ratesE9, lowBalanceThresholdMinor: 100_000n, horizonDays: 2 }),
    );
    expect(resultAtBoundary.warnings.find((w) => w.dimension === 'currency' && w.dimensionKey === 'EUR')).toMatchObject({
      currencyCode: 'EUR',
      thresholdMinor: '92850',
      startMinor: '92850',
    });
  });

  it('сохраняет буквальный нулевой порог для дешёвой валюты', () => {
    const rsd = account({ id: 1, currency: 'RSD', balance_minor: 54 }); // 0.54 RSD округляется в 0 USD minor
    const result = buildForecast(
      baseInput({
        accounts: [rsd],
        ratesE9: new Map([['RSD', 9_200_000]]),
        lowBalanceThresholdMinor: 0n,
        horizonDays: 2,
      }),
    );

    expect(result.warnings.some((w) => w.dimension === 'currency' && w.dimensionKey === 'RSD')).toBe(false);
  });
});

describe('buildForecast — валидация', () => {
  it('дробный или нецелый horizonDays/cashFlowDays отклоняется тем же RangeError', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 0 });
    expect(() => buildForecast(baseInput({ accounts: [acc], horizonDays: 1.5 }))).toThrow(RangeError);
    expect(() => buildForecast(baseInput({ accounts: [acc], cashFlowDays: 1.5 }))).toThrow(RangeError);
  });
});

describe('buildForecast — просроченный регулярный платёж (issue #279)', () => {
  it('агрегированный долг на первом дне горизонта сдвигает весь посуточный ряд и cash_flow', () => {
    const acc = account({ id: 1, currency: 'USD', balance_minor: 100000 }); // $1000.00
    const asOfDate = '2026-08-15';
    // Долг за 2 пропущенных периода (-$100 * 2 = -$200) на первом дне (2026-08-16)
    // плюс будущий платёж -$100 на 2026-09-15
    const flows: ForecastFlow[] = [
      flow({
        account_id: 1,
        date: '2026-08-16',
        amount_minor: -20000,
        currency: 'USD',
        title: 'Аренда',
        kind: 'recurring',
        source_id: 10,
      }),
      flow({
        account_id: 1,
        date: '2026-09-15',
        amount_minor: -10000,
        currency: 'USD',
        title: 'Аренда',
        kind: 'recurring',
        source_id: 10,
      }),
    ];

    const result = buildForecast(
      baseInput({ accounts: [acc], flows, baseCurrency: 'USD', asOfDate, horizonDays: 60, cashFlowDays: 30 }),
    );

    // День 0 (старт / net worth) = $1000.00 (100000n)
    expect(result.netWorthMinor).toBe(100000n);
    // День 1 (2026-08-16) закрывается с учётом долга -$200.00 = $800.00
    expect(result.series[0].date).toBe('2026-08-16');
    expect(result.series[0].overallMinor).toBe(80000n);
    // День 30 (2026-09-14) баланс по-прежнему $800.00
    expect(result.series[29].date).toBe('2026-09-14');
    expect(result.series[29].overallMinor).toBe(80000n);
    // День 31 (2026-09-15) второе списание -$100.00 = $700.00
    expect(result.series[30].date).toBe('2026-09-15');
    expect(result.series[30].overallMinor).toBe(70000n);

    // cashFlowMinor на окне 30 дней = 80000n - 100000n = -20000n
    expect(result.cashFlowMinor).toBe(-20000n);
  });
});
