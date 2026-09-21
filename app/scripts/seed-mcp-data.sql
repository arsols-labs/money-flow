-- Seed data for MCP Access and Audit (Issue #501 staging test data)

-- 1. OAuth Clients
INSERT OR REPLACE INTO oauth_clients (id, name, metadata_document_url, created_at) VALUES
  ('client_cursor', 'Cursor IDE', 'https://cursor.com/.well-known/oauth.json', datetime('now', '-14 days')),
  ('client_gemini', 'Gemini Desktop', NULL, datetime('now', '-10 days')),
  ('client_claude', 'Claude Desktop', 'https://claude.ai/.well-known/oauth.json', datetime('now', '-7 days'));

-- 2. OAuth Tokens
INSERT OR REPLACE INTO oauth_tokens (id, client_id, scopes, created_at, expires_at, last_used_at, last_ip, last_country, revoked_at) VALUES
  ('tok_cursor_1', 'client_cursor', '["read", "write"]', datetime('now', '-14 days'), NULL, datetime('now', '-12 minutes'), '178.220.14.92', 'US', NULL),
  ('tok_gemini_1', 'client_gemini', '["read"]', datetime('now', '-10 days'), datetime('now', '+20 days'), datetime('now', '-2 hours'), '85.214.132.4', 'DE', NULL),
  ('tok_claude_1', 'client_claude', '["read", "write"]', datetime('now', '-7 days'), NULL, datetime('now', '-1 day'), '54.210.88.19', 'US', NULL);

-- 3. MCP Audit Log Entries (25 diverse entries)
DELETE FROM mcp_audit_log WHERE client_id IN ('client_cursor', 'client_gemini', 'client_claude');

INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, created_at) VALUES
  -- 1: Operation Add (Success, Long detail)
  ('audit_01', 'client_cursor', 'operation_add', 'success', 
   'Операция успешно создана: ID op-7749, сумма -45.00 USD (счёт Main Checking), категория «Еда / Супермаркеты», магазин «Supermarket». Текущий остаток счёта: 5 420.00 USD.', 
   datetime('now', '-8 minutes')),

  -- 2: Analytics Get (Success)
  ('audit_02', 'client_gemini', 'analytics_get', 'success', 
   'Сформирован аналитический срез за 30 дней: суммарные расходы 1 642.50 USD, доходы 3 200.00 USD, средний чек 45.00 USD. Топ категория: Продукты (42%).', 
   datetime('now', '-25 minutes')),

  -- 3: Transfer Add (Error, Long error detail)
  ('audit_03', 'client_cursor', 'transfer_add', 'error', 
   'Ошибка перевода: недостаточный баланс на счёте списания acc-eur-checking. Запрошено: 2 500.00 EUR, доступно: 1 120.50 EUR. Операция отменена.', 
   datetime('now', '-45 minutes')),

  -- 4: Accounts List (Success)
  ('audit_04', 'client_claude', 'accounts_list', 'success', 
   'Возвращен список из 5 активных счетов: Main Checking (USD), European Bank (EUR), Cash (USD), Savings (GBP), Binance (USDT).', 
   datetime('now', '-1 hour', '-15 minutes')),

  -- 5: Planned Item Add (Pending)
  ('audit_05', 'client_cursor', 'planned_item_add', 'pending', 
   'Создание запланированного платежа: «Аренда квартиры» 1 200.00 USD на 2026-10-01. Ожидает подтверждения пользователя.', 
   datetime('now', '-2 hours')),

  -- 6: Balance Correct (Success)
  ('audit_06', 'client_cursor', 'balance_correct', 'success', 
   'Баланс счёта acc-main-usd скорректирован: старый 5 385.00 USD, новый 5 420.00 USD (дельта: +35.00 USD). Создана операция выравнивания.', 
   datetime('now', '-3 hours', '-20 minutes')),

  -- 7: Recurring Items List (Success)
  ('audit_07', 'client_gemini', 'recurring_items_list', 'success', 
   'Найдено 8 активных регулярных платежей (YouTube Premium, Spotify, Интернет-провайдер, ЖКХ, Спортзал, iCloud 2TB, ChatGPT Plus, Страховка).', 
   datetime('now', '-4 hours')),

  -- 8: Operation Add (Error)
  ('audit_08', 'client_claude', 'operation_add', 'error', 
   'Неверные параметры запроса: поле amount_minor должно быть целым числом, получено null. Проверьте схему вызова инструмента.', 
   datetime('now', '-5 hours', '-10 minutes')),

  -- 9: FX Rates List (Success)
  ('audit_09', 'client_gemini', 'fx_rates_list', 'success', 
   'Возвращены актуальные курсы валют к базовой USD: EUR (1.085), GBP (1.295), USDT (1.000). Дата актуализации: 2026-09-09.', 
   datetime('now', '-7 hours')),

  -- 10: Operation Add (Success)
  ('audit_10', 'client_cursor', 'operation_add', 'success', 
   'Создана операция: Обед в ресторане Bistro, сумма -48.00 USD, категория «Кафе и рестораны».', 
   datetime('now', '-9 hours')),

  -- 11: Transfer Add (Success)
  ('audit_11', 'client_claude', 'transfer_add', 'success', 
   'Перевод между счетами выполнен: 500.00 EUR списано с European Bank, 542.50 USD зачислено на Main Checking по курсу 1.085.', 
   datetime('now', '-12 hours')),

  -- 12: Analytics Get (Success)
  ('audit_12', 'client_gemini', 'analytics_get', 'success', 
   'Запрос трендов расходов по дням недели за последние 90 дней. Максимальные траты приходятся на субботу (средний расход 124.00 USD).', 
   datetime('now', '-16 hours')),

  -- 13: Accounts List (Success)
  ('audit_13', 'client_cursor', 'accounts_list', 'success', 
   'Синхронизация счетов: получено 5 записей, все балансы подтверждены.', 
   datetime('now', '-20 hours')),

  -- 14: Operation Update (Success)
  ('audit_14', 'client_cursor', 'operation_update', 'success', 
   'Обновлена операция op-7620: скорректировано описание с «Бензин» на «АЗС Gas Station — полный бак».', 
   datetime('now', '-1 day', '-2 hours')),

  -- 15: Planned Item Delete (Success)
  ('audit_15', 'client_claude', 'planned_item_delete', 'success', 
   'Удален устаревший запланированный платёж item-plan-89 («Покупка монитора 34 дюйма»).', 
   datetime('now', '-1 day', '-5 hours')),

  -- 16: Operation Add (Success)
  ('audit_16', 'client_cursor', 'operation_add', 'success', 
   'Создана операция: подписка Telegram Premium -4.99 USD, списано с карты Revolut.', 
   datetime('now', '-1 day', '-9 hours')),

  -- 17: Operation Add (Error)
  ('audit_17', 'client_gemini', 'operation_add', 'error', 
   'Клиент не имеет прав на запись (скоуп read-only). Запрос отклонен политикой авторизации OAuth 2.1.', 
   datetime('now', '-1 day', '-14 hours')),

  -- 18: Recurring Fulfill (Success)
  ('audit_18', 'client_cursor', 'recurring_item_fulfill_existing', 'success', 
   'Регулярный платёж «Интернет» за сентябрь закрыт существующей операцией op-7590 на сумму 50.00 USD.', 
   datetime('now', '-2 days', '-1 hour')),

  -- 19: Analytics Get (Success)
  ('audit_19', 'client_claude', 'analytics_get', 'success', 
   'Подсчёт прогнозируемого остатка капитала к концу месяца: ожидаемый профицит +1 420.00 USD.', 
   datetime('now', '-2 days', '-6 hours')),

  -- 20: Accounts List (Success)
  ('audit_20', 'client_gemini', 'accounts_list', 'success', 
   'Запрос списка счетов для генерации сводки в чате.', 
   datetime('now', '-2 days', '-12 hours')),

  -- 21: Operation Add (Success)
  ('audit_21', 'client_cursor', 'operation_add', 'success', 
   'Расход: Аптека Pharmacy, лекарства и витамины -35.00 USD.', 
   datetime('now', '-3 days')),

  -- 22: Transfer Add (Success)
  ('audit_22', 'client_cursor', 'transfer_add', 'success', 
   'Пополнение наличных: снятие 200.00 USD в банкомате.', 
   datetime('now', '-3 days', '-8 hours')),

  -- 23: Balance Correct (Success)
  ('audit_23', 'client_claude', 'balance_correct', 'success', 
   'Сверка остатка наличных: расхождение 0 USD, баланс подтверждён.', 
   datetime('now', '-4 days')),

  -- 24: Operation Add (Success)
  ('audit_24', 'client_cursor', 'operation_add', 'success', 
   'Покупка авиабилетов Международные авиалинии -240.00 EUR.', 
   datetime('now', '-5 days')),

  -- 25: Analytics Get (Success)
  ('audit_25', 'client_gemini', 'analytics_get', 'success', 
   'Квартальный отчёт по расходам: суммарно 8 490.00 USD. Категории-лидеры: Жильё, Продукты, Путешествия.', 
   datetime('now', '-6 days'));
