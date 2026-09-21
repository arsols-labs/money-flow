// Smoke-тест схемы D1 (S1-1, issue #195).
//
// Что он должен ловить: миграция вообще применяется; инвентарь таблиц и
// индексов совпадает с ТЗ (лишняя или потерянная таблица видна сразу, а не в
// S1-3); базовые инварианты живые. Проверки инвариантов негативные —
// «правильная строка вставилась» ничего не доказывает про CHECK, который
// написан с ошибкой и не срабатывает никогда.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const EXPECTED_TABLES = [
  'account_aliases',
  'accounts',
  'fx_rates',
  'imported_receipt_items',
  'mcp_audit_log',
  'oauth_clients',
  'oauth_consents',
  'oauth_tokens',
  'operation_fulfillment_links',
  'operations',
  'pending_account_strings',
  'planned_items',
  'receipts',
  'recurring_items',
  'recurring_period_fulfillments',
  'settings',
  'transfers',
];

const EXPECTED_INDEXES = [
  'idx_account_aliases_account_id',
  'idx_account_aliases_alias_norm',
  'idx_accounts_archived_sort',
  'idx_imported_receipt_items_acct',
  'idx_imported_receipt_items_op',
  'idx_mcp_audit_log_client_id',
  'idx_mcp_audit_log_created_at',
  'idx_mcp_audit_log_idempotency',
  'idx_oauth_consents_client_id',
  'idx_oauth_tokens_client_id',
  'idx_operation_fulfillment_planned_item',
  'idx_operation_fulfillment_recurring_period',
  'idx_operations_account_id',
  'idx_operations_category',
  'idx_operations_date',
  'idx_operations_fiscal_receipt_id',
  'idx_operations_id_recurring_item_id',
  'idx_operations_planned_item_id',
  'idx_operations_receipt_id',
  'idx_operations_recurring_item_id',
  'idx_operations_transfer_id',
  'idx_pending_account_strings_raw_norm',
  'idx_planned_items_account_id',
  'idx_planned_items_date',
  'idx_receipts_created_at',
  'idx_receipts_status',
  'idx_recurring_items_account_id',
  'idx_recurring_items_next_due_date',
];

const NOW = '2026-08-09T12:00:00Z';

// Изоляция хранилища в vitest-pool-workers — на тестовый ФАЙЛ, а не на тест:
// без явной очистки фикстуры соседних тестов видны друг другу и проверки
// начинают падать на чужих строках. Порядок удаления обратный ссылкам.
// settings не трогаем — там значения по умолчанию из самой миграции.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_audit_log'),
    env.DB.prepare('DELETE FROM oauth_tokens'),
    env.DB.prepare('DELETE FROM oauth_consents'),
    env.DB.prepare('DELETE FROM oauth_clients'),
    env.DB.prepare('DELETE FROM operation_fulfillment_links'),
    env.DB.prepare('DELETE FROM recurring_period_fulfillments'),
    env.DB.prepare('DELETE FROM operations'),
    env.DB.prepare('DELETE FROM transfers'),
    env.DB.prepare('DELETE FROM planned_items'),
    env.DB.prepare('DELETE FROM recurring_items'),
    env.DB.prepare('DELETE FROM receipts'),
    env.DB.prepare('DELETE FROM fx_rates'),
    env.DB.prepare('DELETE FROM accounts'),
  ]);
});

async function names(sql: string): Promise<string[]> {
  const { results } = await env.DB.prepare(sql).all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Счёт-фикстура: почти всё в схеме ссылается на accounts. */
async function insertAccount(): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO accounts (name, bank, type, owner, country, currency, balance_minor, balance_updated_at)
     VALUES ('Основной', 'Raiffeisen', 'Checking', 'Alex', 'SRB', 'RSD', 123456, ?)
     RETURNING id`,
  )
    .bind(NOW)
    .first<{ id: number }>();
  return row!.id;
}

/**
 * Утверждает, что запрос отклонён ИМЕННО ограничением схемы. Просто
 * `.rejects.toThrow()` зелёный и на опечатке в самом SQL — тогда тест
 * «проверяет CHECK», который на деле не срабатывает никогда.
 */
async function expectRejected(sql: string, ...binds: unknown[]): Promise<void> {
  await expect(env.DB.prepare(sql).bind(...binds).run()).rejects.toThrow(/constraint failed/i);
}

/**
 * Утверждает, что запрос отклонён ИМЕННО `NOT NULL` и ИМЕННО названной
 * колонки. Строже `expectRejected`, и разница здесь не косметическая: тот
 * зелен на любом «constraint failed», а рядом с `NOT NULL` у четырёх из шести
 * колонок accounts стоит собственный `CHECK`. Тест на `NOT NULL`, написанный
 * через общий матчер, поймал бы соседнюю проверку и остался бы зелёным при
 * полностью снятом `NOT NULL` — то есть проверял бы не то, что заявлено
 * именем.
 *
 * Колонка называется вместе с таблицей, ровно так, как её печатает SQLite:
 * `NOT NULL constraint failed: accounts.name`.
 */
async function expectRejectedNotNull(
  qualifiedColumn: string,
  sql: string,
  ...binds: unknown[]
): Promise<void> {
  // Экранируется всё имя целиком, а не одна точка: имя приходит из кода
  // теста, но частичное экранирование — ровно тот сорт «работает на текущих
  // данных», из-за которого потом ищут, почему матчер поймал не ту колонку.
  const escaped = qualifiedColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(env.DB.prepare(sql).bind(...binds).run()).rejects.toThrow(
    new RegExp(`NOT NULL constraint failed: ${escaped}\\b`),
  );
}

describe('инвентарь схемы', () => {
  it('содержит ровно ожидаемые таблицы схемы', async () => {
    // sqlite_* и _cf_* — служебные (последние заводит сама D1),
    // d1_migrations — журнал применённых миграций от wrangler.
    const tables = await names(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND name <> 'd1_migrations'
       ORDER BY name`,
    );
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it('содержит ожидаемые индексы', async () => {
    const indexes = await names(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`,
    );
    expect(indexes).toEqual(EXPECTED_INDEXES);
  });

  it('не заводит триггеров — ТЗ требует их отсутствия', async () => {
    expect(await names(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)).toEqual([]);
  });

  it('проходит quick_check и foreign_key_check', async () => {
    // integrity_check в D1 запрещён (SQLITE_AUTH) — доступен quick_check.
    const quick = await env.DB.prepare('PRAGMA quick_check').first<{ quick_check: string }>();
    expect(quick?.quick_check).toBe('ok');

    const { results } = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(results).toEqual([]);
  });

  it('держит проверку внешних ключей включённой — иначе половина тестов ниже фиктивна', async () => {
    const row = await env.DB.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it('кладёт настройки по умолчанию, чтобы пустая база была рабочей', async () => {
    const { results } = await env.DB.prepare(
      'SELECT key, value FROM settings ORDER BY key',
    ).all<{ key: string; value: string }>();
    expect(results).toEqual([
      { key: 'base_currency', value: 'USD' },
      { key: 'low_balance_threshold_minor', value: '100000' },
    ]);
  });
});

async function insertRecurringFulfillmentFixture(periodDueDate = '2026-09-01') {
  const accountId = await insertAccount();
  const recurring = await env.DB.prepare(
    `INSERT INTO recurring_items
       (title, amount_minor, currency, account_id, category, frequency, interval_count,
        day_of_month, month_of_year, next_due_date, end_date, active)
     VALUES ('Подписка', -1000, 'RSD', ?, 'Software', 'monthly', 1, 1, NULL, ?, NULL, 1)
     RETURNING id`,
  ).bind(accountId, periodDueDate).first<{ id: number }>();
  const operation = await env.DB.prepare(
    `INSERT INTO operations
       (date, account_id, kind, item, category, amount_minor, source, recurring_item_id)
     VALUES (?, ?, 'expense', 'Подписка', 'Software', -1000, 'recurring', ?)
     RETURNING id`,
  ).bind(periodDueDate, accountId, recurring!.id).first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, ?, 'materialized', ?)`,
    ).bind(recurring!.id, periodDueDate, NOW),
    env.DB.prepare(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, ?, ?, 'materialized', ?)`,
    ).bind(operation!.id, recurring!.id, periodDueDate, NOW),
  ]);
  return { accountId, recurringId: recurring!.id, operationId: operation!.id };
}

describe('expectation fulfillments — атомарные инварианты MF-21', () => {
  it('не допускает второй факт для того же recurring-периода', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-09-01', 'skipped', ?)`,
      fixture.recurringId, NOW,
    );
  });

  it('не допускает привязать одну operation к двум периодам', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-10-01', 'linked', ?)`,
    ).bind(fixture.recurringId, NOW).run();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, ?, '2026-10-01', 'linked', ?)`,
      fixture.operationId, fixture.recurringId, NOW,
    );
  });

  it('не допускает link без ровно одной planned или recurring цели', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, NULL, NULL, 'linked', ?)`,
      fixture.operationId, NOW,
    );
  });

  it('не допускает operation link с outcome, отличным от parent fulfillment', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    const operation = await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, category, amount_minor, source)
       VALUES ('2026-10-01', ?, 'expense', 'Внешний факт', 'Software', -1000, 'agent')
       RETURNING id`,
    ).bind(fixture.accountId).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-10-01', 'skipped', ?)`,
    ).bind(fixture.recurringId, NOW).run();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (?, NULL, ?, '2026-10-01', 'linked', ?)`,
      operation!.id, fixture.recurringId, NOW,
    );
  });

  it('держит внешние ключи и запрещает удалить operation из-под durable link', async () => {
    const byOperation = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO operation_fulfillment_links
         (operation_id, planned_item_id, recurring_item_id, period_due_date, fulfillment_type, linked_at)
       VALUES (999999, NULL, ?, '2026-09-01', 'linked', ?)`,
      byOperation.recurringId, NOW,
    );
    await expect(env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(byOperation.operationId).run()).rejects.toThrow();
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);

    const byRecurring = await insertRecurringFulfillmentFixture('2026-10-01');
    await env.DB.prepare('DELETE FROM recurring_items WHERE id = ?').bind(byRecurring.recurringId).run();
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM recurring_period_fulfillments').first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_fulfillment_links').first<{ count: number }>())?.count).toBe(1);
  });

  it('валидирует evidence_quantity как durable арифметическое доказательство', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments
         (recurring_item_id, period_due_date, outcome, evidence_quantity, fulfilled_at)
       VALUES (?, '2026-10-01', 'linked', 0, ?)`,
      fixture.recurringId, NOW,
    );
  });

  it('отклоняет невалидные period_due_date и fulfilled_at', async () => {
    const fixture = await insertRecurringFulfillmentFixture();
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-02-30', 'skipped', ?)`,
      fixture.recurringId, NOW,
    );
    await expectRejected(
      `INSERT INTO recurring_period_fulfillments (recurring_item_id, period_due_date, outcome, fulfilled_at)
       VALUES (?, '2026-10-01', 'skipped', '2026-08-09 12:00:00')`,
      fixture.recurringId,
    );
  });
});

// Вставка счёта с обязательным минимумом колонок. Минимум этот вырос в
// миграции 0004: `owner` и `country` стали NOT NULL, и вставка без них теперь
// отклоняется ДО того, как СУБД посмотрит на проверяемое условие. Для
// негативных тестов ниже это критично — `expectRejected` зелен на любом
// «constraint failed», поэтому тест про формат валюты, забывший владельца,
// проверял бы NOT NULL под чужим именем и остался бы зелёным при полностью
// снятом GLOB.
const ACCOUNT_MINIMAL = `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)`;

describe('accounts', () => {
  it('пишет и читает счёт без потери значений', async () => {
    const id = await insertAccount();
    const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      name: 'Основной',
      bank: 'Raiffeisen',
      type: 'Checking',
      owner: 'Alex',
      country: 'SRB',
      currency: 'RSD',
      balance_minor: 123456,
      balance_updated_at: NOW,
      sort: 0,
      archived: 0,
    });
  });

  it('допускает отрицательный баланс — кредитка в минусе это норма', async () => {
    await env.DB.prepare(
      `INSERT INTO accounts (name, owner, country, currency, balance_minor, balance_updated_at)
       VALUES ('Visa', 'Alex', 'SRB', 'USD', -50000, ?)`,
    )
      .bind(NOW)
      .run();
    const row = await env.DB.prepare(
      `SELECT balance_minor FROM accounts WHERE name = 'Visa'`,
    ).first<{ balance_minor: number }>();
    expect(row?.balance_minor).toBe(-50000);
  });

  it('отклоняет валюту не в формате ISO-4217', async () => {
    await expectRejected(`${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'rsd', ?)`, NOW);
  });

  it('отклоняет момент не в формате ISO-UTC', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-08-09 12:00:00')`,
    );
  });

  it('отклоняет несуществующую дату в моменте', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-02-30T00:00:00Z')`,
    );
  });

  it('отклоняет мусор вместо момента — round-trip даёт NULL, ловит только IS NOT NULL', async () => {
    // Единственный тест, который держит первый конъюнкт проверки
    // `balance_updated_at`. Механика ровно та, о которой предупреждает шапка
    // 0001: `strftime` на такой строке возвращает NULL, round-trip становится
    // NULL, а обе оставшиеся половины (`>= '0001-01-01'` и час `<= '23'`) на
    // ней истинны — NULL AND TRUE AND TRUE даёт NULL, то есть «не нарушено».
    // Без явного `IS NOT NULL` строка проходит; проверено мутацией — снятие
    // этого конъюнкта делало прогон зелёным, потому что случая «мусор вместо
    // момента» в блоке accounts не было вовсе (у recurring_items он есть).
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '9999-99-99T00:00:00Z')`,
    );
  });

  it('отклоняет нулевой год — date() пропускает его сам', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '0000-01-01T00:00:00Z')`,
    );
  });

  it('отклоняет 24-й час — strftime() его не нормализует и round-trip проходит', async () => {
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-08-09T24:30:15Z')`,
    );
    await expectRejected(
      `${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', '2026-08-09T24:00:00Z')`,
    );
  });
});

// Владелец и страна обязательны в самой схеме — миграция 0004, issue #234.
// До неё тот же инвариант держал только API (#232), и любой второй путь записи
// проходил мимо: правка БД руками, откат кода, отладочный скрипт. Проверки
// здесь идут ПРЯМЫМ SQL мимо воркера именно поэтому — доказывают, что отказ
// приходит от базы, а не от валидации в api.ts.
describe('accounts — владелец и страна обязательны в схеме', () => {
  const cases: Array<[string, string]> = [
    ['owner как NULL', `VALUES ('X', NULL, 'SRB', 'USD', ?)`],
    ['country как NULL', `VALUES ('X', 'Alex', NULL, 'USD', ?)`],
    ['owner пустой строкой', `VALUES ('X', '', 'SRB', 'USD', ?)`],
    ['country пустой строкой', `VALUES ('X', 'Alex', '', 'USD', ?)`],
    // Пробелы отдельным случаем: их не ловит NOT NULL, ловит только
    // CHECK (length(trim(...)) > 0). Без этих двух тестов проверку можно было
    // бы потерять целиком, оставив зелёный CI.
    ['owner из одних пробелов', `VALUES ('X', '   ', 'SRB', 'USD', ?)`],
    ['country из одних пробелов', `VALUES ('X', 'Alex', '  ', 'USD', ?)`],
  ];

  it.each(cases)('отклоняет счёт: %s', async (_name, values) => {
    await expectRejected(`${ACCOUNT_MINIMAL} ${values}`, NOW);
  });

  // Колонку нельзя опустить в INSERT — отдельный случай от явного NULL: так
  // выглядит забытое поле в чужом коде, а не попытка стереть значение.
  it('отклоняет счёт, где колонки владельца нет в INSERT вовсе', async () => {
    await expectRejected(
      `INSERT INTO accounts (name, country, currency, balance_updated_at) VALUES ('X', 'SRB', 'USD', ?)`,
      NOW,
    );
  });

  // UPDATE — второй путь, которым пустое измерение могло бы появиться уже
  // после вставки. CHECK живой и на нём.
  it('не даёт стереть владельца или страну через UPDATE', async () => {
    await insertAccount();
    await expectRejected('UPDATE accounts SET owner = NULL');
    await expectRejected("UPDATE accounts SET country = '  '");
  });
});

// Остальные `NOT NULL` таблицы accounts — issue #247.
//
// Поведенческого теста у них не было НИ ОДНОГО: `owner` и `country` покрыты
// только потому, что тесты им написала задача #234 здесь же, соседям такие
// никто не писал. Держал их один эталон DDL ниже, а он ловит правку лишь
// тогда, когда её внесли в миграцию и забыли в эталоне: согласованное снятие
// `NOT NULL` в обоих местах проходило зелёным прогоном — проверено мутациями,
// каждая колонка по отдельности.
//
// Прямой SQL мимо воркера — по той же причине, что и в блоке выше: отказ
// обязан приходить от базы, а не от валидации в api.ts.
//
// Что именно теряется у каждой колонки после снятия `NOT NULL` — три разных
// случая, и различать их стоит:
//   * `name`, `currency`, `archived` — соседний `CHECK` на NULL даёт NULL, то
//     есть «не нарушено», и NULL проходит насквозь.
//   * `balance_minor`, `sort` — `CHECK` рядом нет вовсе.
//   * `balance_updated_at` — её `CHECK` NULL как раз ОТВЕРГАЕТ: первый
//     конъюнкт `strftime(...) IS NOT NULL` даёт 0, а не NULL (оператор
//     `IS NOT` в SQLite NULL не возвращает никогда). Здесь `NOT NULL`
//     избыточен по существу — и ровно поэтому тест на него возможен только
//     через строгий матчер: общий остался бы зелёным, поймав отказ от CHECK
//     (проверено подменой матчера на общий — три теста колонки остаются
//     зелёными при полностью снятом NOT NULL). Строгий краснеет, потому что
//     после снятия `NOT NULL` меняется САМА ПРИЧИНА отказа, а не факт отказа.
//
//     Цену этого приёма стоит знать заранее: он опирается на то, что SQLite
//     проверяет NOT NULL РАНЬШЕ CHECK. Это наблюдаемое поведение движка, а не
//     обещанный контракт. Покраснеет однажды сам по себе, без правок схемы —
//     смотреть надо сюда, а не искать поломку в accounts.
describe('accounts — NOT NULL у остальных колонок', () => {
  /** Колонки accounts с `NOT NULL`, кроме `owner` и `country` (блок выше). */
  const COLUMNS = [
    'name',
    'currency',
    'balance_updated_at',
    'balance_minor',
    'sort',
    'archived',
  ];

  // Явный NULL. Значения соседних колонок заведомо валидны — иначе отказ
  // пришёл бы от чужой проверки, и тест проверял бы её под чужим именем.
  const explicitNull: Array<[string, string]> = [
    [
      'name',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)
       VALUES (NULL, 'Alex', 'SRB', 'USD', '${NOW}')`,
    ],
    [
      'currency',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)
       VALUES ('X', 'Alex', 'SRB', NULL, '${NOW}')`,
    ],
    [
      'balance_updated_at',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at)
       VALUES ('X', 'Alex', 'SRB', 'USD', NULL)`,
    ],
    [
      'balance_minor',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at, balance_minor)
       VALUES ('X', 'Alex', 'SRB', 'USD', '${NOW}', NULL)`,
    ],
    [
      'sort',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at, sort)
       VALUES ('X', 'Alex', 'SRB', 'USD', '${NOW}', NULL)`,
    ],
    [
      'archived',
      `INSERT INTO accounts (name, owner, country, currency, balance_updated_at, archived)
       VALUES ('X', 'Alex', 'SRB', 'USD', '${NOW}', NULL)`,
    ],
  ];

  it.each(explicitNull)('отклоняет счёт, где %s задана как NULL', async (column, sql) => {
    await expectRejectedNotNull(`accounts.${column}`, sql);
  });

  // Колонка опущена в INSERT — отдельный случай от явного NULL: так выглядит
  // забытое поле в чужом коде, а не попытка стереть значение.
  //
  // Случаев здесь три, а не шесть, и это не забывчивость: у `balance_minor`,
  // `sort` и `archived` есть DEFAULT, и пропуск колонки там ЗАКОНЕН. Что он
  // действительно законен — утверждает позитивный тест сразу под списком,
  // чтобы разница между «нельзя опустить» и «можно опустить» держалась
  // тестами, а не памятью читающего.
  const omitted: Array<[string, string]> = [
    [
      'name',
      `INSERT INTO accounts (owner, country, currency, balance_updated_at)
       VALUES ('Alex', 'SRB', 'USD', '${NOW}')`,
    ],
    [
      'currency',
      `INSERT INTO accounts (name, owner, country, balance_updated_at)
       VALUES ('X', 'Alex', 'SRB', '${NOW}')`,
    ],
    [
      'balance_updated_at',
      `INSERT INTO accounts (name, owner, country, currency)
       VALUES ('X', 'Alex', 'SRB', 'USD')`,
    ],
  ];

  it.each(omitted)('отклоняет счёт, где колонки %s нет в INSERT вовсе', async (column, sql) => {
    await expectRejectedNotNull(`accounts.${column}`, sql);
  });

  it('заполняет по умолчанию колонки с DEFAULT, если их в INSERT нет', async () => {
    await env.DB.prepare(`${ACCOUNT_MINIMAL} VALUES ('X', 'Alex', 'SRB', 'USD', ?)`)
      .bind(NOW)
      .run();
    const row = await env.DB.prepare(
      `SELECT balance_minor, sort, archived FROM accounts WHERE name = 'X'`,
    ).first<{ balance_minor: number; sort: number; archived: number }>();
    expect(row).toEqual({ balance_minor: 0, sort: 0, archived: 0 });
  });

  // UPDATE — второй путь записи, которым NULL мог бы появиться уже после
  // вставки. NOT NULL живой и на нём.
  it.each(COLUMNS)('не даёт занулить %s через UPDATE', async (column) => {
    await insertAccount();
    await expectRejectedNotNull(`accounts.${column}`, `UPDATE accounts SET ${column} = NULL`);
  });

  // Полнота списков выше держится не глазами, а самой таблицей: `table_info`
  // говорит, какие колонки действительно `NOT NULL` и у каких есть `DEFAULT`.
  // Смысл ровно в том, из-за чего заведена #247: список, который никто не
  // сверяет, молчит. Добавит будущая миграция ещё один `NOT NULL` — этот тест
  // покраснеет и потребует случая, а не оставит колонку без теста на годы.
  it('покрывает все NOT NULL таблицы, кроме owner и country', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(accounts)').all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    // `owner` и `country` покрыты блоком #234 выше; `id` — rowid-алиас, и
    // `notnull` у такого PRIMARY KEY в SQLite равен 0, отдельно исключать не
    // нужно.
    const notNull = results.filter(
      (c) => c.notnull === 1 && c.name !== 'owner' && c.name !== 'country',
    );
    const expected = [...COLUMNS].sort();
    // Сравниваются МНОЖЕСТВА покрытых колонок, а не длины списков: второй
    // случай на ту же колонку (тот же NULL при другом наборе соседей) —
    // законное усиление, и краснеть на нём этот тест не должен. Он про
    // «колонка осталась без теста», а не про «случаев ровно столько».
    const covered = (cases: Array<[string, string]>): string[] =>
      [...new Set(cases.map(([column]) => column))].sort();

    expect(notNull.map((c) => c.name).sort()).toEqual(expected);
    expect(covered(explicitNull)).toEqual(expected);
    // Пропуск колонки в INSERT проверяется только там, где он вообще незаконен,
    // то есть у колонок без DEFAULT. Список выводится, а не переписывается.
    expect(covered(omitted)).toEqual(
      notNull
        .filter((c) => c.dflt_value === null)
        .map((c) => c.name)
        .sort(),
    );
  });
});

// Миграция 0004 пересобирает accounts целиком — SQLite не умеет ALTER COLUMN.
// Определение таблицы переписано руками, поэтому эталон здесь тот же приём и по
// той же причине, что у recurring_items ниже. Держит он всё, у чего
// поведенческого теста нет.
//
// Список этот менялся, и читать его надо как утверждение о СЕГОДНЯШНЕМ
// состоянии файла, а не как исторический факт. До issue #247 эталон был
// единственной защитой ВСЕХ `NOT NULL` таблицы, кроме `owner` и `country`;
// сейчас каждый из них покрыт поведенческим тестом в блоке «accounts —
// NOT NULL у остальных колонок» выше, и каждый проверен мутацией. Шапка
// миграции 0004 описывает состояние на момент своего мержа и здесь уже
// устарела — применённая миграция не редактируется, канон по покрытию
// тестами живёт в этом файле.
//
// Что остаётся за одним эталоном и потерялось бы молча (проверено мутациями).
// Из ПРОВЕРОК — `CHECK (length(trim(name)) > 0)` и `CHECK (archived IN (0, 1))`:
// обе про форму значения, а не про его наличие, и в задачу про `NOT NULL` не
// входили. Но проверками эталон не исчерпывается, и сузить перечень до них
// значило бы соврать ровно тем же способом, каким врал перечень до #247.
// Согласованная правка в миграции и здесь проходит зелёной ещё и для ПОРЯДКА
// колонок, и для ОБЪЯВЛЕННОГО ТИПА nullable-колонки: перестановка `bank` и
// `type` местами, как и замена `bank TEXT` на `bank INTEGER`, даёт полный
// зелёный прогон. Перечень поэтому открытый — закрыть его нечем, кроме самого
// эталона, и в этом его смысл.
//
// Краснеет и без эталона: `currency GLOB`, каждый из четырёх конъюнктов
// `balance_updated_at`, `PRIMARY KEY`, оба `NOT NULL` из #234, все шесть
// `NOT NULL` из #247 и `DEFAULT` у `balance_minor`, `sort` и `archived`. Что
// нормализация терпит, а что нет — в комментарии к RECURRING_ITEMS_DDL ниже,
// повторять незачем.
//
// Кавычки вокруг имени таблицы — след `ALTER TABLE ... RENAME TO`, а не часть
// смысла схемы.
const ACCOUNTS_DDL = `
  CREATE TABLE "accounts" (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    bank TEXT,
    type TEXT,
    owner TEXT NOT NULL CHECK (length(trim(owner)) > 0),
    country TEXT NOT NULL CHECK (length(trim(country)) > 0),
    currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
    balance_minor INTEGER NOT NULL DEFAULT 0,
    balance_updated_at TEXT NOT NULL CHECK (
      strftime('%Y-%m-%dT%H:%M:%SZ', balance_updated_at) IS NOT NULL
      AND balance_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', balance_updated_at)
      AND balance_updated_at >= '0001-01-01'
      AND substr(balance_updated_at, 12, 2) <= '23'
    ),
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)) , account_number TEXT)`;

describe('accounts — пересборка таблицы миграцией 0004', () => {
  it('сохранила определение таблицы целиком: колонки, DEFAULT, все CHECK', async () => {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`,
    ).first<{ sql: string }>();
    expect(normalizeDdl(row!.sql)).toBe(normalizeDdl(ACCOUNTS_DDL));
  });

  /** Повторный прогон самой миграции — единственный способ увидеть перелив. */
  async function replayMigration(): Promise<void> {
    const rebuild = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0004'));
    expect(rebuild, 'миграция 0004 не найдена в TEST_MIGRATIONS').toBeDefined();
    await env.DB.batch(rebuild!.queries.map((q) => env.DB.prepare(q)));
  }

  it('перелила строку без потерь — списки колонок INSERT ... SELECT сходятся', async () => {
    // Эталон DDL выше держит ОПРЕДЕЛЕНИЕ новой таблицы, но о самом переливе не
    // знает ничего, а порча данных живёт именно там: переставленные местами
    // колонки в списках копирования — валидный SQL, валидная схема и
    // перепутанные значения. Setup применяет миграции к пустой базе, поэтому
    // перелив там не исполняется ни на одной строке — и пересборка гоняется
    // повторно, уже на непустой таблице.
    //
    // Фикстура здесь СВОЯ, а не `insertAccount()`, и это не дублирование.
    // Тест сравнивает строку до и после, поэтому видит ровно те перестановки,
    // где значения РАЗЛИЧНЫ; на паре одинаковых он слеп. `insertAccount()`
    // оставляет `sort` и `archived` на DEFAULT 0, а `id` после `DELETE` в
    // `beforeEach` снова равен 1 и до, и после перелива, — с ней перестановка
    // `sort`/`archived`, выпадение `sort` и выпадение `id` из списков
    // копирования проходили молча (проверено мутациями). Поэтому здесь заданы
    // все одиннадцать колонок, попарно различными значениями: `id` заметный,
    // `sort` ненулевой и не равный `archived`, тексты разные.
    await env.DB.prepare(
      `INSERT INTO accounts
         (id, name, bank, type, owner, country, currency, balance_minor, balance_updated_at, sort, archived)
       VALUES (42, 'Основной', 'Raiffeisen', 'Checking', 'Алекс', 'SRB', 'RSD', 123456, ?, 7, 1)`,
    )
      .bind(NOW)
      .run();
    const before = await env.DB.prepare('SELECT * FROM accounts').first();
    await replayMigration();
    // Миграция 0016 (account_number) применена в setup, но replayMigration
    // пересобирает только 0004 и эту колонку не сохраняет. Сравниваем ровно
    // те колонки, что переливает 0004, — иначе тест краснел бы на любую
    // добавленную позже колонку счёта (см. #376).
    const strip = (r: Record<string, unknown> | null) => { if (!r) return r; const { account_number, ...rest } = r; return rest; };
    expect(strip(await env.DB.prepare('SELECT * FROM accounts').first())).toEqual(strip(before));
  });

  it('ЗАФИКСИРОВАННАЯ ГРАНИЦА: пересборка отвергается, если на счёт уже ссылается операция', async () => {
    // Это не дефект, а осознанная граница миграции 0004, и тест держит её,
    // чтобы следующий автор не выяснял всё заново. `accounts` — РОДИТЕЛЬ, а
    // `DROP TABLE` при foreign_keys = 1 делает неявный DELETE всех строк:
    // каждая строка, на которую ссылается операция, даёт нарушение FK.
    // Обойти его в D1 нечем — `foreign_keys = OFF` там не действует, а
    // `defer_foreign_keys` не спасает (разбор — в шапке миграции). Проходит
    // только пересборка ВМЕСТЕ С ДЕТЬМИ, и она в 0004 намеренно не сделана:
    // CRUD плановых и регулярных операций пишется в S1-3, до тех пор такой
    // строки в базе не существует.
    //
    // Тест краснеет ровно тогда, когда это перестанет быть правдой, — то есть
    // когда `accounts` тронет миграция уже после S1-3.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)`,
    )
      .bind(accountId)
      .run();
    // Регулярка узкая намеренно: на общем `constraint failed` тест зеленел бы
    // от любого постороннего нарушения, а падать должен именно внешний ключ.
    await expect(replayMigration()).rejects.toThrow(/FOREIGN KEY/i);
  });

  // Теста «ссылка на несуществующий счёт отвергается» здесь намеренно НЕТ,
  // хотя в блоке про пересборку 0003 такой есть. Там пересобиралась таблица,
  // в определении которой живёт сам внешний ключ, — потерять его было чем.
  // Здесь пересобирается РОДИТЕЛЬ, а `REFERENCES` записан у детей, и миграция
  // их не трогает вовсе; если бы `accounts` не вернулась под своим именем, это
  // поймал бы `PRAGMA foreign_key_check` в инвентаре схемы, а живость самого
  // ключа уже держит `planned_items > отклоняет ссылку на несуществующий счёт`.
  // Копия этого теста здесь давала бы второе падение на один дефект.

  it('пересоздала индекс с тем же определением, а не только с тем же именем', async () => {
    // Инвентарь схемы выше проверяет имена; здесь — состав колонок и порядок.
    const { results } = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'accounts' AND name LIKE 'idx_%'`,
    ).all<{ sql: string }>();
    expect(results.map((i) => i.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE INDEX idx_accounts_archived_sort ON accounts (archived, sort)',
    ]);
  });
});

describe('planned_items', () => {
  it('пишет плановую операцию со знаком', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, category)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?, 'Жильё')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare(
      'SELECT amount_minor, done FROM planned_items',
    ).first<{ amount_minor: number; done: number }>();
    expect(row).toEqual({ amount_minor: -95000, done: 0 });
  });

  it('отклоняет нулевую сумму', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Пустая', 0, 'RSD', ?)`,
      accountId,
    );
  });

  it('отклоняет дату с несуществующим днём', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-02-30', 'Аренда', -1, 'RSD', ?)`,
      accountId,
    );
  });

  it('отклоняет ссылку на несуществующий счёт', async () => {
    await expectRejected(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -1, 'RSD', 999999)`,
    );
  });

  it('не даёт удалить счёт, пока на нём висят плановые операции', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -1, 'RSD', ?)`,
    )
      .bind(accountId)
      .run();
    await expectRejected('DELETE FROM accounts WHERE id = ?', accountId);
  });
});

describe('recurring_items — якоря правила', () => {
  const base = `INSERT INTO recurring_items
    (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date)`;

  it('принимает месячное правило с днём месяца', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, 31, NULL, '2026-08-31')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare(
      'SELECT day_of_month, active FROM recurring_items',
    ).first<{ day_of_month: number; active: number }>();
    expect(row).toEqual({ day_of_month: 31, active: 1 });
  });

  it('требует день месяца для monthly — иначе якорь потерян при прижатии к 28-му', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, NULL, NULL, '2026-08-31')`,
      accountId,
    );
  });

  it('требует месяц и день для yearly', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, NULL, '2028-02-29')`,
      accountId,
    );
  });

  it('запрещает день месяца у daily и weekly — там его смысла нет', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кофе', -300, 'RSD', ?, 'weekly', 1, 5, NULL, '2026-08-10')`,
      accountId,
    );
    await expectRejected(
      `${base} VALUES ('Кофе', -300, 'RSD', ?, 'daily', 1, 5, NULL, '2026-08-10')`,
      accountId,
    );
  });

  it('отклоняет неизвестную частоту', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Странное', -1, 'RSD', ?, 'fortnightly', 1, NULL, NULL, '2026-08-10')`,
      accountId,
    );
  });
});

// Вставка со сроком — общая для двух блоков ниже. Отдельно от `base` в блоке
// «якоря правила»: там колонки end_date намеренно нет, чтобы проверки якорей не
// зависели от миграции 0002.
const BASE_WITH_END_DATE = `INSERT INTO recurring_items
  (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date, end_date)`;

// Дата окончания правила — миграция 0002, issue #211. `end_date` включительна:
// так её читает потребитель `expandRecurring` (`while (cur <= hardEnd)`).
describe('recurring_items — дата окончания', () => {
  const base = BASE_WITH_END_DATE;

  it('принимает правило без срока — колонка nullable', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, 15, NULL, '2026-08-15', NULL)`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT end_date FROM recurring_items').first<{
      end_date: string | null;
    }>();
    expect(row?.end_date).toBeNull();
  });

  it('хранит дату окончания — кредит на фиксированный срок', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2029-09-05')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT end_date FROM recurring_items').first<{
      end_date: string;
    }>();
    expect(row?.end_date).toBe('2029-09-05');
  });

  it('допускает срок, равный якорю — это правило ровно с одним платежом', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Последний взнос', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2026-09-05')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT end_date FROM recurring_items').first<{
      end_date: string;
    }>();
    expect(row?.end_date).toBe('2026-09-05');
  });

  it('отклоняет срок раньше якоря — правило, у которого нет ни одного платежа', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2026-08-05')`,
      accountId,
    );
  });

  it('отклоняет неканоничный формат даты — сравнение колонки строковое', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2029-9-5')`,
      accountId,
    );
  });

  it('отклоняет несуществующую дату — date() её НОРМАЛИЗУЕТ, ловит round-trip', async () => {
    // date('2026-02-30') возвращает не NULL, а '2026-03-02'. Проверки на
    // «date(x) IS NOT NULL» одной было бы мало — работает именно равенство.
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-01-05', '2026-02-30')`,
      accountId,
    );
  });

  it('отклоняет мусор вместо даты', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', 'никогда')`,
      accountId,
    );
  });

  // Теста на нижнюю границу '0001-01-01' здесь намеренно НЕТ. Год ноль в
  // end_date требует такого же якоря, а его отклоняет проверка next_due_date из
  // миграции 0001 — сработает она, а не граница end_date. Такой тест был бы
  // зелёным и при полностью снятой границе, то есть покрывал бы чужой CHECK под
  // своим именем. Почему граница всё же стоит в миграции — в её шапке.
});

// Контракт `..._after_anchor` для S1-3 и S1-4: CHECK живой на ЛЮБОМ UPDATE
// строки. Это ограничивает не только продвижение якоря вперёд, но и укорочение
// срока задним числом — второе неочевидно и стоило бы сессии S1-3 отладки.
describe('recurring_items — дата окончания против скользящего якоря', () => {
  const base = BASE_WITH_END_DATE;

  /** Правило со сроком, якорь на первом платеже. */
  async function insertBounded(accountId: number): Promise<void> {
    await env.DB.prepare(
      `${base} VALUES ('Кредит', -50000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-09-05', '2026-10-05')`,
    )
      .bind(accountId)
      .run();
  }

  it('не даёт продвинуть якорь за дату окончания', async () => {
    const accountId = await insertAccount();
    await insertBounded(accountId);
    await expectRejected("UPDATE recurring_items SET next_due_date = '2026-11-05'");
  });

  it('гасит правило флагом active = 0, не трогая якорь', async () => {
    const accountId = await insertAccount();
    await insertBounded(accountId);
    await env.DB.prepare('UPDATE recurring_items SET active = 0').run();
    const row = await env.DB.prepare('SELECT active, next_due_date FROM recurring_items').first<{
      active: number;
      next_due_date: string;
    }>();
    expect(row).toEqual({ active: 0, next_due_date: '2026-09-05' });
  });

  it('не даёт укоротить срок ниже уехавшего якоря — и active = 0 тут НЕ выход', async () => {
    // Правило без срока, отработавшее полгода: якорь уехал в будущее. Владелец
    // задаёт дату окончания задним числом — «аренда кончилась в сентябре».
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Аренда', -100000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-11-05', NULL)`,
    )
      .bind(accountId)
      .run();
    await expectRejected("UPDATE recurring_items SET end_date = '2026-09-30'");
    // CHECK не смотрит на active — на погашенной строке отказ ровно тот же.
    await env.DB.prepare('UPDATE recurring_items SET active = 0').run();
    await expectRejected("UPDATE recurring_items SET end_date = '2026-09-30'");
  });

  it('пропускает закрытие задним числом, когда якорь и срок меняются одним UPDATE', async () => {
    // Штатный путь для S1-3: CHECK проверяется после применения всего UPDATE,
    // поэтому пара проходит там, где каждая половина по отдельности отвергается.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Аренда', -100000, 'RSD', ?, 'monthly', 1, 5, NULL, '2026-11-05', NULL)`,
    )
      .bind(accountId)
      .run();
    await env.DB.prepare(
      "UPDATE recurring_items SET next_due_date = '2026-09-05', end_date = '2026-09-30', active = 0",
    ).run();
    const row = await env.DB.prepare(
      'SELECT next_due_date, end_date, active FROM recurring_items',
    ).first<{ next_due_date: string; end_date: string; active: number }>();
    expect(row).toEqual({ next_due_date: '2026-09-05', end_date: '2026-09-30', active: 0 });
  });
});

// Якорь месяца у годового правила — миграция 0003, issue #225. Проверяется
// ИМЕННО месяц: день `next_due_date` расходиться с `day_of_month` вправе, и
// почему — в шапке миграции. Тесты ниже закрепляют обе половины решения.
describe('recurring_items — годовое правило и его месяц-якорь', () => {
  // Без end_date: к сроку окончания эти проверки отношения не имеют.
  const base = `INSERT INTO recurring_items
    (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date)`;

  it('принимает годовое правило, стоящее в своём месяце', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2028-02-29')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare(
      'SELECT month_of_year, next_due_date FROM recurring_items',
    ).first<{ month_of_year: number; next_due_date: string }>();
    expect(row).toEqual({ month_of_year: 2, next_due_date: '2028-02-29' });
  });

  it('отклоняет годовое правило, чья ближайшая дата не в месяце-якоре', async () => {
    // Ровно строка из issue #225: якорь февральский, дата августовская. Дальше
    // прогноз S1-4 расходится сам с собой — advanceByPeriods берёт месяц из
    // даты, nextOccurrence из month_of_year.
    const accountId = await insertAccount();
    await expectRejected(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2026-08-10')`,
      accountId,
    );
  });

  it('не даёт увести якорь в чужой месяц UPDATE-ом — CHECK живой и на нём', async () => {
    // Это путь S1-3 и S1-4: скользящий якорь двигают именно UPDATE'ом, и
    // годовому правилу его можно двигать только внутри месяца-якоря —
    // проверяется месяц, день ему не указ.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-28')`,
    )
      .bind(accountId)
      .run();
    await expectRejected("UPDATE recurring_items SET next_due_date = '2027-03-29'");
    await env.DB.prepare("UPDATE recurring_items SET next_due_date = '2028-02-29'").run();
    const row = await env.DB.prepare('SELECT next_due_date FROM recurring_items').first<{
      next_due_date: string;
    }>();
    expect(row?.next_due_date).toBe('2028-02-29');
  });

  it('принимает 29 февраля, прижатое к 28-му в невисокосный год', async () => {
    // Прижатие 29–31 к последнему дню месяца — часть контракта правила, а не
    // порча строки. Проверка месяца обязана его пропускать.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-28')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT next_due_date FROM recurring_items').first<{
      next_due_date: string;
    }>();
    expect(row?.next_due_date).toBe('2027-02-28');
  });

  it('допускает день, разошедшийся с якорем дня, — сдвиг одного платежа законен', async () => {
    // Осознанная граница задачи #225, а не пропущенный случай: день оба
    // потребителя прогноза берут из day_of_month, поэтому разойтись из-за него
    // им нечем — отличается только первое вхождение, которым и является сам
    // скользящий якорь. Тест держит это решение: если день начнут проверять,
    // он покраснеет и заставит обновить шапку миграции 0003.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-15')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT next_due_date FROM recurring_items').first<{
      next_due_date: string;
    }>();
    expect(row?.next_due_date).toBe('2027-02-15');
  });

  it('пропускает смену месяца-якоря вместе с датой одним UPDATE — путь S1-3', async () => {
    // «Страховку перенесли с февраля на август». Половинами это не делается:
    // CHECK живой на UPDATE, поэтому один только month_of_year отвергается, а
    // пара проходит — проверяется она уже после применения всего UPDATE.
    const accountId = await insertAccount();
    await env.DB.prepare(
      `${base} VALUES ('Страховка', -100000, 'RSD', ?, 'yearly', 1, 29, 2, '2027-02-28')`,
    )
      .bind(accountId)
      .run();
    await expectRejected('UPDATE recurring_items SET month_of_year = 8');
    await env.DB.prepare(
      "UPDATE recurring_items SET month_of_year = 8, next_due_date = '2027-08-29'",
    ).run();
    const row = await env.DB.prepare(
      'SELECT month_of_year, next_due_date FROM recurring_items',
    ).first<{ month_of_year: number; next_due_date: string }>();
    expect(row).toEqual({ month_of_year: 8, next_due_date: '2027-08-29' });
  });
});

// Миграция 0003 пересобирает recurring_items целиком — SQLite не умеет
// ALTER TABLE ADD CONSTRAINT. Определение таблицы переписано руками, и почти
// ничего из него тесты выше не держат: поведенческие проверки есть у якорей
// правила, обеих проверок `end_date` и нового якоря месяца, а у границ
// `interval_count`, `day_of_month`, `month_of_year`, формата `next_due_date` и
// проверок `title`, `amount_minor`, `currency`, `active` их нет — ни до этой
// миграции, ни после. Потеря любой из них прошла бы CI молча.
//
// Поэтому эталон один и целиком: нормализованный DDL таблицы. Он ловит всё
// сразу — колонки, их порядок и типы, DEFAULT, КАЖДЫЙ CHECK, внешний ключ, —
// вместо десятка негативных тестов, каждый из которых пришлось бы придумывать
// отдельно.
//
// Что нормализация терпит, а что нет — важно знать заранее, чтобы красный тест
// читался правильно. Терпит: правку комментариев и любое КОЛИЧЕСТВО пробелов.
// Не терпит: перенос строки на границе токенов, смену регистра ключевых слов —
// такое даёт ЛОЖНЫЙ красный, семантика при этом не менялась. Ошибается она,
// таким образом, в безопасную сторону: пропустить потерю ограничения не может,
// а лишний раз потребовать обновить эталон — может. Единственная настоящая
// слепота — пробелы и `--` ВНУТРИ строковых литералов; в сегодняшнем
// определении таких литералов нет, но колонка с `DEFAULT 'не задано'` их
// принесёт, и тогда нормализацию придётся уточнять.
//
// Следующая миграция, меняющая эту таблицу, обязана обновить эталон. Это не
// накладной расход, а единственное место, где в дифф попадает СМЫСЛ изменения
// схемы: строка эталона показывает, что именно стало другим.
//
// Кавычки вокруг имени таблицы — след `ALTER TABLE ... RENAME TO` из миграции
// 0003, а не часть смысла схемы: так SQLite переписывает сохранённый DDL.
// Миграция, которая создаст эту таблицу напрямую, кавычек не даст — и эталон
// придётся поправить именно здесь, не приняв это за потерю.
const RECURRING_ITEMS_DDL = `
  CREATE TABLE "recurring_items" (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    category TEXT,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
    interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 365),
    day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    month_of_year INTEGER CHECK (month_of_year IS NULL OR month_of_year BETWEEN 1 AND 12),
    next_due_date TEXT NOT NULL CHECK (
      date(next_due_date) IS NOT NULL
      AND next_due_date = date(next_due_date)
      AND next_due_date >= '0001-01-01'
    ),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    end_date TEXT
      CONSTRAINT recurring_items_end_date_format CHECK (
        end_date IS NULL
        OR (
          date(end_date) IS NOT NULL
          AND end_date = date(end_date)
          AND end_date >= '0001-01-01'
        )
      )
      CONSTRAINT recurring_items_end_date_after_anchor CHECK (
        end_date IS NULL OR end_date >= next_due_date
      ),
    revision TEXT,
    CONSTRAINT recurring_items_rule_anchors CHECK (
      (frequency IN ('daily', 'weekly') AND day_of_month IS NULL AND month_of_year IS NULL)
      OR (frequency = 'monthly' AND day_of_month IS NOT NULL AND month_of_year IS NULL)
      OR (frequency = 'yearly' AND day_of_month IS NOT NULL AND month_of_year IS NOT NULL)
    ),
    CONSTRAINT recurring_items_yearly_month_matches_anchor CHECK (
      frequency <> 'yearly'
      OR (
        strftime('%m', next_due_date) IS NOT NULL
        AND CAST(strftime('%m', next_due_date) AS INTEGER) = month_of_year
      )
    )
  )`;

/** Комментарии прочь, пробелы в один — сравнивается смысл, а не форматирование. */
function normalizeDdl(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('recurring_items — пересборка таблицы миграцией 0003', () => {
  it('сохранила определение таблицы целиком: колонки, DEFAULT, все CHECK и FK', async () => {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recurring_items'`,
    ).first<{ sql: string }>();
    expect(normalizeDdl(row!.sql)).toBe(normalizeDdl(RECURRING_ITEMS_DDL));
  });

  it('перелив 0003 перечисляет одинаковые колонки INSERT и SELECT', () => {
    // Повторно применять историческую 0003 к финальной схеме нельзя: поздняя
    // 0017 добавляет `revision`, которой в 0003 ещё не существовало. Вместо
    // разрушительного replay проверяем сам контракт перелива статически.
    const rebuild = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0003'));
    expect(rebuild, 'миграция 0003 не найдена в TEST_MIGRATIONS').toBeDefined();
    const sql = rebuild!.queries.join(' ').replace(/\s+/g, ' ');
    const expectedColumns = 'id, title, amount_minor, currency, account_id, category, frequency, interval_count, day_of_month, month_of_year, next_due_date, active, end_date';
    expect(sql).toContain(`INSERT INTO recurring_items_new ( ${expectedColumns} ) SELECT ${expectedColumns} FROM recurring_items`);
  });

  it('сохранила внешний ключ живым, а не только записанным в DDL', async () => {
    // Эталон выше держит наличие `REFERENCES` в тексте схемы; здесь — что ключ
    // реально принуждается на записи. `PRAGMA foreign_key_check` в инвентаре
    // схемы этого не покажет: он гоняется по пустой базе, проверять там нечего.
    await expectRejected(
      `INSERT INTO recurring_items
         (title, amount_minor, currency, account_id, frequency, interval_count, day_of_month, month_of_year, next_due_date)
       VALUES ('Страховка', -100000, 'RSD', 999999, 'yearly', 1, 29, 2, '2027-02-28')`,
    );
  });

  it('сохранила определения индексов, а не только имена — частичный остался частичным', async () => {
    // Инвентарь схемы выше проверяет имена; здесь важен `WHERE active = 1`:
    // без него частичный индекс молча станет полным, и прогноз потащит вес
    // неактивных правил. Переносы строк схлопнуты — форматирование не инвариант.
    const { results } = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recurring_items'
       ORDER BY name`,
    ).all<{ name: string; sql: string }>();
    expect(results.map((i) => i.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE INDEX idx_recurring_items_account_id ON recurring_items (account_id)',
      'CREATE INDEX idx_recurring_items_next_due_date ON recurring_items (next_due_date) WHERE active = 1',
    ]);
  });
});

describe('fx_rates', () => {
  it('хранит курс целым числом с масштабом 1e9', async () => {
    // RSD ≈ 0.0092 USD.
    await env.DB.prepare('INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)')
      .bind('RSD', 9_200_000, NOW)
      .run();
    const row = await env.DB.prepare('SELECT rate_e9 FROM fx_rates WHERE code = ?')
      .bind('RSD')
      .first<{ rate_e9: number }>();
    expect(row?.rate_e9).toBe(9_200_000);
  });

  it('отклоняет 24-й час — условие скопировано в три таблицы, тест нужен в каждой', async () => {
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'RUB',
      1,
      '2026-08-09T24:30:15Z',
    );
  });

  it('отклоняет момент с миллисекундами — точность колонки секундная', async () => {
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'RUB',
      1,
      '2026-08-09T12:00:00.000Z',
    );
  });

  it('отклоняет неположительный курс', async () => {
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'RUB',
      0,
      NOW,
    );
  });

  it('не допускает двух строк на одну валюту', async () => {
    await env.DB.prepare('INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)')
      .bind('EUR', 1_090_000_000, NOW)
      .run();
    await expectRejected(
      'INSERT INTO fx_rates (code, rate_e9, updated_at) VALUES (?, ?, ?)',
      'EUR',
      1_100_000_000,
      NOW,
    );
  });
});

describe('operations и receipts', () => {
  async function insertReceipt(): Promise<number> {
    const row = await env.DB.prepare(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/2026/abc.jpg', 'parsed', ?)
       RETURNING id`,
    )
      .bind(NOW)
      .first<{ id: number }>();
    return row!.id;
  }

  it('пишет ручную операцию без чека', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, store, item, category, subcategory, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Maxi', 'Хлеб', 'Продукты', 'Выпечка', -12000, 'manual')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT source, receipt_id, subcategory FROM operations').first<{
      source: string;
      receipt_id: number | null;
      subcategory: string | null;
    }>();
    expect(row).toEqual({ source: 'manual', receipt_id: null, subcategory: 'Выпечка' });
  });

  it('держит comment, receipt_url и fiscal_receipt_id nullable без значения по умолчанию', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Хлеб', -12000, 'manual')`,
    )
      .bind(accountId)
      .run();
    const empty = await env.DB.prepare('SELECT comment, receipt_url, fiscal_receipt_id FROM operations').first<{
      comment: string | null;
      receipt_url: string | null;
      fiscal_receipt_id: string | null;
    }>();
    expect(empty).toEqual({ comment: null, receipt_url: null, fiscal_receipt_id: null });

    await env.DB.prepare(
      `UPDATE operations SET comment = ?, receipt_url = ?, fiscal_receipt_id = ?`,
    )
      .bind('скидка по карте', 'https://suf.purs.gov.rs/v/?vl=abc', 'PFR-GROCERY-1')
      .run();
    const filled = await env.DB.prepare('SELECT comment, receipt_url, fiscal_receipt_id FROM operations').first<{
      comment: string | null;
      receipt_url: string | null;
      fiscal_receipt_id: string | null;
    }>();
    expect(filled).toEqual({
      comment: 'скидка по карте',
      receipt_url: 'https://suf.purs.gov.rs/v/?vl=abc',
      fiscal_receipt_id: 'PFR-GROCERY-1',
    });
  });

  // Счёт у операции обязателен с 0005 (решение владельца 2026-08-12): операция
  // без счёта не «отдельный поток для Аналитики», а строка, которая ничего не
  // говорит о движении денег.
  it('не даёт операции остаться без счёта', async () => {
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', NULL, 'expense', 'Хлеб', -12000, 'manual')`,
    );
  });

  it('не даёт удалить счёт, пока на нём висят операции', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Хлеб', -12000, 'manual')`,
    )
      .bind(accountId)
      .run();
    await expectRejected('DELETE FROM accounts WHERE id = ?', accountId);
  });

  // Знак — дельта баланса, и схема держит это сама, а не только API: расход
  // строго отрицателен, доход и возврат строго положительны.
  it('отклоняет расход с положительной суммой', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Хлеб', 12000, 'manual')`,
      accountId,
    );
  });

  it('отклоняет доход с отрицательной суммой', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'income', 'Зарплата', -500000, 'manual')`,
      accountId,
    );
  });

  it('пишет возврат положительной суммой', async () => {
    const accountId = await insertAccount();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'refund', 'Возврат наушников', 499900, 'manual')`,
    )
      .bind(accountId)
      .run();
    const row = await env.DB.prepare('SELECT kind, amount_minor FROM operations').first<{
      kind: string;
      amount_minor: number;
    }>();
    expect(row).toEqual({ kind: 'refund', amount_minor: 499900 });
  });

  it('отклоняет неизвестный вид операции', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'transfer', 'Перевод', -12000, 'manual')`,
      accountId,
    );
  });

  it('отклоняет нулевую сумму', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Ничего', 0, 'manual')`,
      accountId,
    );
  });

  // «Овощи и фрукты» без «Продуктов» не уточняют ничего.
  it('не даёт подкатегорию без категории', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, subcategory, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Огурцы', 'Овощи и фрукты', -12000, 'manual')`,
      accountId,
    );
  });

  it('связывает позицию с чеком', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, ?, 'receipt')`,
    )
      .bind(accountId, receiptId)
      .run();
    const row = await env.DB.prepare('SELECT receipt_id FROM operations').first<{
      receipt_id: number;
    }>();
    expect(row?.receipt_id).toBe(receiptId);
  });

  it('не даёт ручной операции ссылаться на чек', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, ?, 'manual')`,
      accountId,
      receiptId,
    );
  });

  it('не даёт операции из чека остаться без чека', async () => {
    const accountId = await insertAccount();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, 'receipt')`,
      accountId,
    );
  });

  it('отклоняет 24-й час у чека — третья копия того же условия', async () => {
    await expectRejected(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/y.jpg', 'uploaded', ?)`,
      '2026-08-09T24:30:15Z',
    );
  });

  it('отклоняет неизвестный статус чека', async () => {
    await expectRejected(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/x.jpg', 'pending', ?)`,
      NOW,
    );
  });

  it('не допускает двух чеков на один ключ R2', async () => {
    await insertReceipt();
    await expectRejected(
      `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/2026/abc.jpg', 'uploaded', ?)`,
      NOW,
    );
  });

  it('не даёт удалить чек, пока живы его позиции', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source)
       VALUES ('2026-08-09', ?, 'expense', 'Молоко', -18000, ?, 'receipt')`,
    )
      .bind(accountId, receiptId)
      .run();
    await expectRejected('DELETE FROM receipts WHERE id = ?', receiptId);
  });

  // Issue #267: отметка «выполнено» порождает операцию. source = planned —
  // происхождение, а не «ручная». receipt_id у неё пуст, как у manual.
  it('пишет операцию из плановой без чека', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id, done)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?, 1)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'planned', ?)`,
    )
      .bind(accountId, planned!.id)
      .run();
    const row = await env.DB.prepare('SELECT source, receipt_id, planned_item_id FROM operations').first<{
      source: string;
      receipt_id: number | null;
      planned_item_id: number | null;
    }>();
    expect(row).toEqual({ source: 'planned', receipt_id: null, planned_item_id: planned!.id });
  });

  it('не даёт плановой операции ссылаться на чек', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, ?, 'planned', ?)`,
      accountId,
      receiptId,
      planned!.id,
    );
  });

  it('не даёт ручной операции держать ссылку на плановую', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'manual', ?)`,
      accountId,
      planned!.id,
    );
  });

  it('не даёт двум операциям ссылаться на одну плановую', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'planned', ?)`,
    )
      .bind(accountId, planned!.id)
      .run();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-02', ?, 'expense', 'Аренда ещё раз', -95000, 'planned', ?)`,
      accountId,
      planned!.id,
    );
  });

  it('удаление плановой не трогает уже свершившуюся операцию', async () => {
    const accountId = await insertAccount();
    const planned = await env.DB.prepare(
      `INSERT INTO planned_items (date, title, amount_minor, currency, account_id)
       VALUES ('2026-09-01', 'Аренда', -95000, 'RSD', ?)
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, planned_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Аренда', -95000, 'planned', ?)`,
    )
      .bind(accountId, planned!.id)
      .run();
    await env.DB.prepare('DELETE FROM planned_items WHERE id = ?').bind(planned!.id).run();
    const row = await env.DB.prepare('SELECT source, planned_item_id, amount_minor FROM operations').first<{
      source: string;
      planned_item_id: number | null;
      amount_minor: number;
    }>();
    expect(row).toEqual({ source: 'planned', planned_item_id: null, amount_minor: -95000 });
  });

  it('принимает операцию из регулярного правила: source = recurring и recurring_item_id', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    const row = await env.DB.prepare('SELECT source, receipt_id, recurring_item_id FROM operations').first<{
      source: string;
      receipt_id: number | null;
      recurring_item_id: number | null;
    }>();
    expect(row).toEqual({ source: 'recurring', receipt_id: null, recurring_item_id: recurring!.id });
  });

  it('не даёт регулярной операции ссылаться на чек', async () => {
    const accountId = await insertAccount();
    const receiptId = await insertReceipt();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, receipt_id, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, ?, 'recurring', ?)`,
      accountId,
      receiptId,
      recurring!.id,
    );
  });

  it('не даёт ручной операции держать ссылку на регулярное правило', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, 'manual', ?)`,
      accountId,
      recurring!.id,
    );
  });

  it('позволяет нескольким операциям ссылаться на одно регулярное правило', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет за сентябрь', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-10-01', ?, 'expense', 'Интернет за октябрь', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    const { results } = await env.DB.prepare('SELECT id, recurring_item_id FROM operations ORDER BY date').all<{
      id: number;
      recurring_item_id: number | null;
    }>();
    expect(results).toHaveLength(2);
    expect(results[0].recurring_item_id).toBe(recurring!.id);
    expect(results[1].recurring_item_id).toBe(recurring!.id);
  });

  it('удаление регулярного правила не трогает уже свершившуюся операцию (ON DELETE SET NULL)', async () => {
    const accountId = await insertAccount();
    const recurring = await env.DB.prepare(
      `INSERT INTO recurring_items (title, amount_minor, currency, account_id, frequency, day_of_month, next_due_date)
       VALUES ('Интернет', -3000, 'RSD', ?, 'monthly', 1, '2026-09-01')
       RETURNING id`,
    )
      .bind(accountId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, recurring_item_id)
       VALUES ('2026-09-01', ?, 'expense', 'Интернет', -3000, 'recurring', ?)`,
    )
      .bind(accountId, recurring!.id)
      .run();
    await env.DB.prepare('DELETE FROM recurring_items WHERE id = ?').bind(recurring!.id).run();
    const row = await env.DB.prepare('SELECT source, recurring_item_id, amount_minor FROM operations').first<{
      source: string;
      recurring_item_id: number | null;
      amount_minor: number;
    }>();
    expect(row).toEqual({ source: 'recurring', recurring_item_id: null, amount_minor: -3000 });
  });
});

// Пересборка operations миграцией 0007 — тот же контракт, что у 0003 и 0006:
// эталон DDL ловит колонки/CHECK/FK, повторный прогон на непустой таблице —
// сам перелив (перестановка колонок в INSERT ... SELECT эталону не видна).
const OPERATIONS_DDL = `
  CREATE TABLE "operations" (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL CHECK (
      date(date) IS NOT NULL AND date = date(date) AND date >= '0001-01-01'
    ),
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'refund', 'transfer_out', 'transfer_in')),
    store TEXT,
    item TEXT NOT NULL CHECK (length(trim(item)) > 0),
    category TEXT,
    subcategory TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    receipt_id INTEGER REFERENCES receipts (id),
    source TEXT NOT NULL CHECK (source IN ('manual', 'receipt', 'planned', 'recurring', 'agent')),
    planned_item_id INTEGER REFERENCES planned_items (id) ON DELETE SET NULL,
    recurring_item_id INTEGER REFERENCES recurring_items (id) ON DELETE SET NULL,
    transfer_id INTEGER REFERENCES transfers (id) ON DELETE CASCADE,
    comment TEXT,
    receipt_url TEXT,
    fiscal_receipt_id TEXT,
    CONSTRAINT operations_source_matches_receipt CHECK (
      (source IN ('manual', 'planned', 'recurring', 'agent') AND receipt_id IS NULL)
      OR (source = 'receipt' AND receipt_id IS NOT NULL)
    ),
    CONSTRAINT operations_sign_matches_kind CHECK (
      (kind IN ('expense', 'transfer_out') AND amount_minor < 0)
      OR (kind IN ('income', 'refund', 'transfer_in') AND amount_minor > 0)
    ),
    CONSTRAINT operations_subcategory_needs_category CHECK (
      subcategory IS NULL OR category IS NOT NULL
    ),
    CONSTRAINT operations_planned_link_matches_source CHECK (
      planned_item_id IS NULL OR source = 'planned'
    ),
    CONSTRAINT operations_recurring_link_matches_source CHECK (
      recurring_item_id IS NULL OR source = 'recurring'
    ),
    CONSTRAINT operations_transfer_link_matches_kind CHECK (
      (transfer_id IS NULL AND kind NOT IN ('transfer_out', 'transfer_in'))
      OR (transfer_id IS NOT NULL AND kind IN ('transfer_out', 'transfer_in'))
    )
  )`;

describe('operations — пересборка таблицы миграцией 0011', () => {
  it('сохранила определение таблицы целиком: колонки, все CHECK и FK', async () => {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'`,
    ).first<{ sql: string }>();
    expect(normalizeDdl(row!.sql)).toBe(normalizeDdl(OPERATIONS_DDL));
  });

  it('перелив 0011 перечисляет одинаковые колонки INSERT и SELECT', () => {
    // 0017 добавляет composite parent index для closure. Повторный replay 0011
    // после неё удалил бы этот поздний индекс и сделал FK некорректным, поэтому
    // проверяем исторический контракт перелива без мутации финальной схемы.
    const rebuild = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0011'));
    expect(rebuild, 'миграция 0011 не найдена в TEST_MIGRATIONS').toBeDefined();
    const sql = rebuild!.queries.join(' ').replace(/\s+/g, ' ');
    const expectedColumns = 'id, date, account_id, kind, store, item, category, subcategory, amount_minor, receipt_id, source, planned_item_id, recurring_item_id, transfer_id';
    expect(sql).toContain(`INSERT INTO operations_new ( ${expectedColumns} ) SELECT ${expectedColumns} FROM operations`);
  });

  it('сохранила определения индексов, а не только имена', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'operations'
       ORDER BY name`,
    ).all<{ name: string; sql: string }>();
    expect(results.map((i) => i.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE INDEX idx_operations_account_id ON operations (account_id)',
      'CREATE INDEX idx_operations_category ON operations (category)',
      'CREATE INDEX idx_operations_date ON operations (date DESC)',
      'CREATE INDEX idx_operations_fiscal_receipt_id ON operations (fiscal_receipt_id) WHERE fiscal_receipt_id IS NOT NULL',
      'CREATE UNIQUE INDEX idx_operations_id_recurring_item_id ON operations (id, recurring_item_id)',
      'CREATE UNIQUE INDEX idx_operations_planned_item_id ON operations (planned_item_id) WHERE planned_item_id IS NOT NULL',
      'CREATE INDEX idx_operations_receipt_id ON operations (receipt_id)',
      'CREATE INDEX idx_operations_recurring_item_id ON operations (recurring_item_id) WHERE recurring_item_id IS NOT NULL',
      'CREATE INDEX idx_operations_transfer_id ON operations (transfer_id) WHERE transfer_id IS NOT NULL',
    ]);
  });

  it('каскадно удаляет связанные операции при удалении transfer (ON DELETE CASCADE)', async () => {
    const accountId = await insertAccount();
    const transfer = await env.DB.prepare('INSERT INTO transfers DEFAULT VALUES RETURNING id').first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_out', 'Списание перевода', -5000, 'manual', ?)`,
    ).bind(accountId, transfer!.id).run();
    await env.DB.prepare(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_in', 'Зачисление перевода', 5000, 'manual', ?)`,
    ).bind(accountId, transfer!.id).run();

    expect((await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>())?.count).toBe(2);

    await env.DB.prepare('DELETE FROM transfers WHERE id = ?').bind(transfer!.id).run();

    expect((await env.DB.prepare('SELECT COUNT(*) as count FROM operations').first<{ count: number }>())?.count).toBe(0);
  });

  it('запрещает transfer_out с положительной суммой и transfer_in с отрицательной суммой', async () => {
    const accountId = await insertAccount();
    const transfer = await env.DB.prepare('INSERT INTO transfers DEFAULT VALUES RETURNING id').first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_out', 'Ошибка знака', 5000, 'manual', ?)`,
      accountId,
      transfer!.id,
    );
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'transfer_in', 'Ошибка знака', -5000, 'manual', ?)`,
      accountId,
      transfer!.id,
    );
  });

  it('запрещает transfer_id без transfer_out/transfer_in и наоборот', async () => {
    const accountId = await insertAccount();
    const transfer = await env.DB.prepare('INSERT INTO transfers DEFAULT VALUES RETURNING id').first<{ id: number }>();
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, transfer_id)
       VALUES ('2026-08-15', ?, 'expense', 'Обычная трата', -5000, 'manual', ?)`,
      accountId,
      transfer!.id,
    );
    await expectRejected(
      `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
       VALUES ('2026-08-15', ?, 'transfer_out', 'Перевод без id', -5000, 'manual')`,
      accountId,
    );
  });

  describe('oauth_clients, oauth_consents, oauth_tokens (S2-1, issue #261)', () => {
    it('создаёт клиента и отклоняет без обязательного имени', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name, metadata_document_url)
         VALUES ('https://claude.ai/mcp.json', 'Claude Desktop', 'https://claude.ai/mcp.json')`,
      ).run();

      const client = await env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?')
        .bind('https://claude.ai/mcp.json')
        .first<{ id: string; name: string }>();
      expect(client?.name).toBe('Claude Desktop');

      await expectRejectedNotNull(
        'oauth_clients.name',
        `INSERT INTO oauth_clients (id, name) VALUES ('client-2', NULL)`,
      );
    });

    it('каскадно удаляет согласия и токены при удалении клиента', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name) VALUES ('client-test', 'Test Client')`,
      ).run();

      await env.DB.prepare(
        `INSERT INTO oauth_consents (id, client_id, scopes, redirect_uri)
         VALUES ('consent-1', 'client-test', '["read"]', 'https://client.test/callback')`,
      ).run();

      await env.DB.prepare(
        `INSERT INTO oauth_tokens (id, client_id, scopes, last_ip, last_country)
         VALUES ('token-1', 'client-test', '["read"]', '1.2.3.4', 'US')`,
      ).run();

      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_consents').first<{ count: number }>())?.count,
      ).toBe(1);
      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_tokens').first<{ count: number }>())?.count,
      ).toBe(1);

      await env.DB.prepare(`DELETE FROM oauth_clients WHERE id = 'client-test'`).run();

      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_consents').first<{ count: number }>())?.count,
      ).toBe(0);
      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM oauth_tokens').first<{ count: number }>())?.count,
      ).toBe(0);
    });

    it('запрещает создание согласия или токена на несуществующего клиента (FK)', async () => {
      await expectRejected(
        `INSERT INTO oauth_consents (id, client_id, scopes, redirect_uri)
         VALUES ('consent-bad', 'unknown-client', '["read"]', 'https://client.test/callback')`,
      );
      await expectRejected(
        `INSERT INTO oauth_tokens (id, client_id, scopes)
         VALUES ('token-bad', 'unknown-client', '["read"]')`,
      );
    });
  });

  describe('mcp_audit_log и source = "agent" (S2-4, issue #264)', () => {
    it('разрешает операцию с source = "agent" и без receipt_id', async () => {
      const accountId = await insertAccount();
      await env.DB.prepare(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source)
         VALUES ('2026-08-15', ?, 'expense', 'Кофе от агента', -350, 'agent')`
      ).bind(accountId).run();

      const op = await env.DB.prepare('SELECT source FROM operations WHERE account_id = ?').bind(accountId).first<{ source: string }>();
      expect(op?.source).toBe('agent');
    });

    it('запрещает операцию с source = "agent" и непустым receipt_id', async () => {
      const accountId = await insertAccount();
      const receipt = await env.DB.prepare(
        `INSERT INTO receipts (r2_key, status, created_at) VALUES ('receipts/2026/agent.jpg', 'parsed', ?) RETURNING id`
      )
        .bind(NOW)
        .first<{ id: number }>();

      await expectRejected(
        `INSERT INTO operations (date, account_id, kind, item, amount_minor, source, receipt_id)
         VALUES ('2026-08-15', ?, 'expense', 'Невалидный чек', -350, 'agent', ?)`,
        accountId,
        receipt!.id
      );
    });

    it('обеспечивает уникальность idempotency_key для одного client_id', async () => {
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name) VALUES ('client-mcp-1', 'Test MCP Client')`
      ).run();

      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key)
         VALUES ('log-1', 'client-mcp-1', 'operation_add', 'success', '{"ok":true}', 'key-123')`
      ).run();

      // Повторная вставка с тем же client_id и idempotency_key должна быть отклонена
      await expectRejected(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key)
         VALUES ('log-2', 'client-mcp-1', 'operation_add', 'success', '{"ok":true}', 'key-123')`
      );

      // Но для другого client_id тот же idempotency_key разрешен
      await env.DB.prepare(
        `INSERT INTO oauth_clients (id, name) VALUES ('client-mcp-2', 'Second MCP Client')`
      ).run();

      await env.DB.prepare(
        `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key)
         VALUES ('log-3', 'client-mcp-2', 'operation_add', 'success', '{"ok":true}', 'key-123')`
      ).run();

      expect(
        (await env.DB.prepare('SELECT COUNT(*) as count FROM mcp_audit_log WHERE idempotency_key = "key-123"').first<{ count: number }>())?.count
      ).toBe(2);
    });
  });
});
