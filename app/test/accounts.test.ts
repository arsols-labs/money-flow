// Подсказки формы счёта (issue #235): имя по умолчанию и поиск похожего счёта.
//
// Обе подсказки ничего не запрещают, и цена ошибки у них разная. Имя —
// стартовое значение: затри оно набранное руками, владелец потеряет ввод
// молча. Похожий счёт — предупреждение: пропущенный дубль тройки даёт два
// одинаково выглядящих счёта, по которым прогноз (S1-4) покажет разъехавшиеся
// балансы, а лишнее предупреждение на совпадении одного лишь имени приучает
// его игнорировать — правило одинаковые имена разрешает.
//
// DOM здесь не нужен: логика вынесена в чистые функции accounts.js, и тесты
// гоняются в том же workerd-пуле, что и остальные тесты v2. Рендер формы
// проверялся вживую в браузере (правило про браузерную проверку экранов).
import { describe, expect, it } from 'vitest';
import { suggestAccountName, suggestedNameUpdate, findSimilarAccount } from '../src/ui/accounts.js';

describe('suggestAccountName', () => {
  it('собирает «Вид · Валюта · Страна»', () => {
    expect(suggestAccountName({ type: 'Наличные', currency: 'USD', country: 'США' }))
      .toBe('Наличные · USD · США');
  });

  it('приводит валюту к верхнему регистру и снимает краевые пробелы', () => {
    expect(suggestAccountName({ type: '  Наличные ', currency: ' usd ', country: ' Global ' }))
      .toBe('Наличные · USD · Global');
  });

  it('владельца в имя не берёт — он подпись карточки, а не часть имени', () => {
    expect(suggestAccountName({ type: 'Наличные', currency: 'EUR', country: 'Global', owner: 'User' }))
      .toBe('Наличные · EUR · Global');
  });

  it('молчит, пока тройка неполна', () => {
    expect(suggestAccountName({ type: 'Наличные', currency: 'USD', country: '' })).toBe('');
    expect(suggestAccountName({ type: '', currency: 'USD', country: 'США' })).toBe('');
    expect(suggestAccountName({ type: 'Наличные', currency: '   ', country: 'США' })).toBe('');
    expect(suggestAccountName({})).toBe('');
  });
});

describe('suggestedNameUpdate', () => {
  const full = { type: 'Наличные', currency: 'USD', country: 'США', name: '' };

  it('подставляет имя, пока владелец его не трогал', () => {
    expect(suggestedNameUpdate(full, { touched: false })).toBe('Наличные · USD · США');
  });

  // Главный тест этого файла: набранное руками не перетирается никогда.
  it('не затирает ручной ввод', () => {
    expect(suggestedNameUpdate({ ...full, name: 'Кошелёк' }, { touched: true })).toBeNull();
  });

  // Стёртое до пустоты — тоже ручной ввод: подсказка задаёт стартовое
  // значение, а не формат, и возвращаться после удаления не должна.
  it('не возвращает стёртое имя', () => {
    expect(suggestedNameUpdate({ ...full, name: '' }, { touched: true })).toBeNull();
  });

  it('не дёргает поле, когда там уже стоит ровно предложенное', () => {
    expect(suggestedNameUpdate({ ...full, name: 'Наличные · USD · США' }, { touched: false })).toBeNull();
  });

  it('обновляет подсказку вслед за сменой валюты', () => {
    expect(suggestedNameUpdate({ ...full, currency: 'EUR', name: 'Наличные · USD · США' }, { touched: false }))
      .toBe('Наличные · EUR · США');
  });

  it('неполная тройка не стирает то, что уже в поле', () => {
    expect(suggestedNameUpdate({ ...full, currency: '', name: 'Наличные · USD · США' }, { touched: false }))
      .toBeNull();
  });
});

describe('findSimilarAccount', () => {
  const accounts = [
    { id: 1, name: 'Кошелёк', owner: 'User', currency: 'USD', country: 'Global', archived: false },
    { id: 2, name: 'Основной', owner: 'User', currency: 'EUR', country: 'Германия', archived: false },
    { id: 3, name: 'Старый сейф', owner: 'User', currency: 'USD', country: 'США', archived: true },
  ];

  it('находит счёт с той же тройкой (владелец, валюта, страна)', () => {
    const found = findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: 'Global', name: 'Дома в сейфе' });
    expect(found?.name).toBe('Кошелёк');
  });

  it('сравнивает без учёта регистра и краевых пробелов', () => {
    const found = findSimilarAccount(accounts, { owner: ' user ', currency: 'usd', country: 'GLOBAL ' });
    expect(found?.id).toBe(1);
  });

  it('совпадение одного лишь имени похожим счётом не считается', () => {
    // Имя то же, тройка другая (валюта). Правило одинаковые имена разрешает,
    // предупреждать тут не о чем.
    expect(findSimilarAccount(accounts, { name: 'Кошелёк', owner: 'User', currency: 'EUR', country: 'Global' })).toBeNull();
  });

  it('различает счета по каждому из трёх измерений', () => {
    expect(findSimilarAccount(accounts, { owner: 'Мария', currency: 'USD', country: 'Global' })).toBeNull();
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'EUR', country: 'Global' })).toBeNull();
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: 'США' })).toBeNull();
  });

  it('архивные не в счёт', () => {
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: 'США' })).toBeNull();
  });

  it('молчит, пока тройка неполна', () => {
    expect(findSimilarAccount(accounts, { owner: 'User', currency: 'USD', country: '' })).toBeNull();
    expect(findSimilarAccount(accounts, {})).toBeNull();
  });

  it('переживает пустой список', () => {
    expect(findSimilarAccount([], { owner: 'User', currency: 'USD', country: 'Global' })).toBeNull();
    expect(findSimilarAccount(undefined, { owner: 'User', currency: 'USD', country: 'Global' })).toBeNull();
  });
});
