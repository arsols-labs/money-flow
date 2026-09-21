// Состояние свёрнутых блоков экрана «Данные» (issue #260).
//
// DOM здесь не нужен: разбор и запись вынесены чистыми функциями в
// dataSections.js, как это уже сделано с подсказками формы счёта
// (accounts.js). Сам экран проверен вживую в браузере — правило про браузерную
// проверку экранов.
//
// Отдельный тест эти функции заслужили одной строкой требования: «localStorage
// может быть недоступен (приватный режим) — отсутствие хранилища не должно
// ронять экран». Хранилище, которое бросает, руками воспроизводится ровно
// здесь и никогда — в браузере под рукой.
import { describe, expect, it } from 'vitest';
import {
  DATA_SECTION_KEYS,
  DATA_SECTIONS_STORAGE_KEY,
  parseExpanded,
  serializeExpanded,
  readExpanded,
  writeExpanded,
  toggleExpanded,
  sectionFromHash,
} from '../src/ui/dataSections.js';

function fakeStorage(initial?: string) {
  const box: { value: string | null } = { value: initial ?? null };
  return {
    box,
    getItem: (key: string) => (key === DATA_SECTIONS_STORAGE_KEY ? box.value : null),
    setItem: (key: string, value: string) => {
      if (key === DATA_SECTIONS_STORAGE_KEY) box.value = value;
    },
  };
}

const throwingStorage = {
  getItem() { throw new Error('SecurityError: доступ к хранилищу запрещён'); },
  setItem() { throw new Error('QuotaExceededError'); },
};

describe('parseExpanded', () => {
  it('читает сохранённый набор ключей', () => {
    expect(parseExpanded('["operations","accounts"]')).toEqual(['operations', 'accounts']);
  });

  it('возвращает ключи в каноничном порядке, а не в порядке записи', () => {
    expect(parseExpanded('["accounts","operations"]')).toEqual(['operations', 'accounts']);
  });

  it('пустое и отсутствующее значение — всё свёрнуто', () => {
    expect(parseExpanded(null)).toEqual([]);
    expect(parseExpanded('')).toEqual([]);
  });

  it('битая запись не роняет разбор, а даёт дефолт', () => {
    expect(parseExpanded('{не json')).toEqual([]);
    expect(parseExpanded('"operations"')).toEqual([]);
    expect(parseExpanded('null')).toEqual([]);
    expect(parseExpanded('{"operations":true}')).toEqual([]);
  });

  it('незнакомый ключ отбрасывается — блок могли переименовать', () => {
    expect(parseExpanded('["expenses","operations"]')).toEqual(['operations']);
  });
});

describe('serializeExpanded', () => {
  it('пишет только известные ключи и в каноничном порядке', () => {
    expect(serializeExpanded(['accounts', 'expenses', 'operations']))
      .toBe('["operations","accounts"]');
  });

  it('пустой набор — валидный JSON, а не пустая строка', () => {
    expect(serializeExpanded([])).toBe('[]');
  });
});

describe('readExpanded / writeExpanded', () => {
  it('запись и чтение сходятся', () => {
    const storage = fakeStorage();
    writeExpanded(['planned'], storage);
    expect(storage.box.value).toBe('["planned"]');
    expect(readExpanded(storage)).toEqual(['planned']);
  });

  it('без хранилища читает дефолт и молча не пишет', () => {
    expect(readExpanded(null)).toEqual([]);
    expect(() => writeExpanded(['planned'], null)).not.toThrow();
  });

  it('бросающее хранилище не роняет экран', () => {
    // Приватный режим Safari: обращение к localStorage кидает SecurityError, а
    // не отдаёт null. Требование задачи — экран при этом продолжает работать,
    // просто без сохранения состояния.
    expect(readExpanded(throwingStorage)).toEqual([]);
    expect(() => writeExpanded(['rates'], throwingStorage)).not.toThrow();
  });
});

describe('toggleExpanded', () => {
  it('разворачивает и сворачивает один блок, не трогая остальные', () => {
    expect(toggleExpanded([], 'rates')).toEqual(['rates']);
    expect(toggleExpanded(['rates', 'planned'], 'rates')).toEqual(['planned']);
  });

  it('не мутирует исходный набор', () => {
    const before = ['rates'];
    toggleExpanded(before, 'planned');
    expect(before).toEqual(['rates']);
  });
});

describe('DATA_SECTION_KEYS', () => {
  it('перечисляет ровно шесть сворачиваемых блоков — «Прогноз» не сворачивается', () => {
    expect(DATA_SECTION_KEYS).toEqual(['operations', 'receipts', 'planned', 'recurring', 'rates', 'accounts']);
  });
});

describe('sectionFromHash', () => {
  it('распознаёт дип-линки известных секций', () => {
    expect(sectionFromHash('#/data/rates')).toBe('rates');
    expect(sectionFromHash('#/data/accounts')).toBe('accounts');
    expect(sectionFromHash('#/data/receipts')).toBe('receipts');
    expect(sectionFromHash('#/data/operations')).toBe('operations');
    expect(sectionFromHash('#/data/planned')).toBe('planned');
    expect(sectionFromHash('#/data/recurring')).toBe('recurring');
  });

  it('возвращает null для некорректных или неизвестных хэшей', () => {
    expect(sectionFromHash('#/data')).toBeNull();
    expect(sectionFromHash('#/data/')).toBeNull();
    expect(sectionFromHash('#/data/unknown')).toBeNull();
    expect(sectionFromHash('#/analytics')).toBeNull();
    expect(sectionFromHash('')).toBeNull();
    expect(sectionFromHash(null)).toBeNull();
    expect(sectionFromHash(undefined)).toBeNull();
  });
});

