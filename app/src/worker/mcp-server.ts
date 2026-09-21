import { Hono } from 'hono';
import type { Env } from './types';
import apiV2 from './api';
import { clipAuditSummary, pruneMcpAuditLog, recordMcpAuditLog } from './api-mcp';
import { BodyTooLargeError, MCP_MAX_JSON_BYTES, readLimitedJson } from './limited-body';
import { getPulseHtml } from './mcp-pulse-ui';
import { getAnalyticsHtml } from './mcp-analytics-ui';
import { getWriteConfirmHtml } from './mcp-write-confirm-ui';
import { nextOccurrence, type RecurringRule } from './forecast/recurrence';
import { parseHttpUrl, RECEIPT_URL_MAX_LENGTH } from '../shared/http-url';
import { FISCAL_RECEIPT_ID_MAX_LENGTH } from '../shared/fiscal-receipts';
import { isAnalyticalSkipOnlyRecurringId } from '../shared/booking-guards';
import { RESET_CONFIRM_PHRASE } from './backup';

const mcpApp = new Hono<{ Bindings: Env }>();

const READ_TOOLS = new Set([
  'accounts_list',
  'fx_rates_list',
  'planned_items_list',
  'recurring_items_list',
  'recurring_fulfillments_list',
  'operations_list',
  'forecast_get',
  'analytics_get',
]);

const WRITE_TOOLS = new Set([
  'operation_add',
  'operation_update',
  'operation_delete',
  'balance_correct',
  'planned_item_add',
  'planned_item_update',
  'planned_item_fulfill_existing',
  'planned_item_delete',
  'recurring_item_add',
  'recurring_item_update',
  'recurring_item_delete',
  'recurring_item_close_period',
  'recurring_item_fulfill_existing',
  'recurring_item_skip_period',
  'recurring_item_cancel_period_fulfillment',
  'transfer_add',
  'fx_rate_set',
  'fx_rate_delete',
  'data_reset',
]);

const PLANNED_UPDATE_FIELDS = ['date', 'title', 'amount_minor', 'currency', 'account_id', 'category', 'done'] as const;
const RECURRING_UPDATE_FIELDS = [
  'title', 'amount_minor', 'currency', 'account_id', 'category', 'frequency',
  'interval_count', 'day_of_month', 'month_of_year', 'next_due_date', 'end_date', 'active',
] as const;
const RECURRING_ADD_FIELD_SET = new Set([
  'title', 'amount_minor', 'account_id', 'frequency', 'next_due_date', 'currency', 'category',
  'interval_count', 'day_of_month', 'month_of_year', 'end_date', 'active', 'idempotency_key', 'requestState',
]);

const OPERATION_UPDATE_FIELDS = ['date', 'account_id', 'kind', 'store', 'item', 'category', 'subcategory', 'amount_minor', 'comment', 'receipt_url', 'fiscal_receipt_id'] as const;
const OPERATION_UPDATE_FIELD_SET = new Set<string>(OPERATION_UPDATE_FIELDS);
const OPERATION_UPDATE_CONTROL_FIELDS = new Set(['operation_id', 'idempotency_key', 'requestState']);
const OPERATION_KINDS = ['expense', 'income', 'refund', 'transfer_out', 'transfer_in'] as const;

function expectedRecurringRewind(
  snapshot: Record<string, unknown> | undefined,
  periodDueDate: string,
): { nextDueDate: string; active: boolean } | null {
  if (!snapshot) return null;
  const frequency = snapshot.frequency;
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(String(frequency))) return null;
  const rule: RecurringRule = {
    id: snapshot.id as number,
    frequency: frequency as RecurringRule['frequency'],
    interval_count: snapshot.interval_count as number,
    day_of_month: (snapshot.day_of_month ?? null) as number | null,
    month_of_year: (snapshot.month_of_year ?? null) as number | null,
    next_due_date: periodDueDate,
    end_date: (snapshot.end_date ?? null) as string | null,
  };
  const successor = nextOccurrence(rule, periodDueDate);
  const finished = rule.end_date !== null && successor > rule.end_date;
  if (finished) {
    return snapshot.next_due_date === periodDueDate
      ? { nextDueDate: periodDueDate, active: true }
      : null;
  }
  return snapshot.next_due_date === successor
    ? { nextDueDate: periodDueDate, active: snapshot.active === 1 || snapshot.active === true }
    : null;
}

function expectedRecurringAdvance(snapshot: Record<string, unknown> | undefined): { nextDueDate: string; active: boolean } | null {
  if (!snapshot) return null;
  const frequency = snapshot.frequency;
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(String(frequency))) return null;
  const rule: RecurringRule = {
    id: snapshot.id as number,
    frequency: frequency as RecurringRule['frequency'],
    interval_count: snapshot.interval_count as number,
    day_of_month: (snapshot.day_of_month ?? null) as number | null,
    month_of_year: (snapshot.month_of_year ?? null) as number | null,
    next_due_date: snapshot.next_due_date as string,
    end_date: (snapshot.end_date ?? null) as string | null,
  };
  const nextDueDate = nextOccurrence(rule, rule.next_due_date);
  const finished = rule.end_date !== null && nextDueDate > rule.end_date;
  return { nextDueDate: finished ? rule.next_due_date : nextDueDate, active: !finished };
}

function operationIdFromArgs(args: any): number | null {
  const raw = args?.operation_id;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function optionalTextValue(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${field} должен быть строкой или null` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function optionalHttpUrlValue(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const parsed = optionalTextValue(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return parsed;
  if (parsed.value.length > RECEIPT_URL_MAX_LENGTH || parseHttpUrl(parsed.value) === null) {
    return { ok: false, error: `${field} должен быть http(s) URL не длиннее ${RECEIPT_URL_MAX_LENGTH} символов` };
  }
  return parsed;
}

function optionalFiscalReceiptIdValue(value: unknown, field = 'fiscal_receipt_id'): { ok: true; value: string | null } | { ok: false; error: string } {
  const parsed = optionalTextValue(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return parsed;
  if (parsed.value.length > FISCAL_RECEIPT_ID_MAX_LENGTH) {
    return { ok: false, error: `${field} не длиннее ${FISCAL_RECEIPT_ID_MAX_LENGTH} символов (PFR / fiscal id, не класть в item)` };
  }
  return parsed;
}

function requiredTextValue(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: `${field} не может быть пустым` };
  }
  return { ok: true, value: value.trim() };
}

function signMatchesKind(kind: string, amountMinor: number): string | null {
  if ((kind === 'expense' || kind === 'transfer_out') && amountMinor > 0) {
    return `${kind === 'expense' ? 'Расход' : 'Списание перевода'} уменьшает баланс — amount_minor должен быть отрицательным`;
  }
  if (kind !== 'expense' && kind !== 'transfer_out' && amountMinor < 0) {
    return `${kind === 'income' ? 'Доход' : kind === 'refund' ? 'Возврат' : 'Зачисление перевода'} увеличивает баланс — amount_minor должен быть положительным`;
  }
  return null;
}

async function loadOperationForMcp(db: D1Database | undefined, operationId: number): Promise<any | null> {
  if (!db) return null;
  return db.prepare(
    `SELECT o.*, a.currency AS currency
     FROM operations o
     JOIN accounts a ON a.id = o.account_id
     WHERE o.id = ?`
  ).bind(operationId).first();
}

async function loadLedgerInvariant(db: D1Database | undefined): Promise<{ operation_count: number; balances: Array<{ id: number; balance_minor: number }> } | null> {
  if (!db) return null;
  const [count, accounts] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM operations').first<{ count: number }>(),
    db.prepare('SELECT id, balance_minor FROM accounts ORDER BY id').all<{ id: number; balance_minor: number }>(),
  ]);
  return { operation_count: count?.count ?? 0, balances: accounts.results };
}

const WRITE_TOOL_MRTR_NOTE =
  ' Первый вызов без requestState ничего не записывает: в structuredContent resultType=input_required и written=false. Сообщать пользователю об успехе нельзя, пока повторный вызов с requestState не вернёт written=true. Точный доменный эффект после подтверждения указан в описании каждого инструмента.';

const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

async function recordToolAudit(
  db: D1Database | undefined,
  clientId: string | undefined,
  toolName: string,
  status: 'success' | 'error' | 'pending',
  resultSummary?: string,
  idempotencyKey?: string,
): Promise<void> {
  if (!db || !clientId || clientId === 'anonymous') return;
  try {
    const clientExists = await db.prepare('SELECT id FROM oauth_clients WHERE id = ?').bind(clientId).first();
    if (!clientExists) return;
    await recordMcpAuditLog(db, clientId, toolName, status, resultSummary, idempotencyKey);
  } catch {
    // журнал не должен ронять tools/call
  }
}

type WriteExecutionClaim =
  | { claimed: true }
  | { claimed: false; status: string; toolName: string; resultSummary: string | null; createdAt: string };

const WRITE_CLAIM_LEASE_MS = 30_000;
const IDEMPOTENCY_FINGERPRINT_FIELD = '__mcp_idempotency_fingerprint';

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalJsonValue(entry);
    }
    return result;
  }
  return value;
}

async function writeArgumentFingerprint(args: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(canonicalJsonValue(args));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storedWriteFingerprint(resultSummary: string | null): string | null {
  if (!resultSummary) return null;
  if (resultSummary.startsWith('CLAIMED:')) return resultSummary.slice('CLAIMED:'.length) || null;
  try {
    const parsed = JSON.parse(resultSummary) as Record<string, unknown>;
    const fingerprint = parsed[IDEMPOTENCY_FINGERPRINT_FIELD];
    return typeof fingerprint === 'string' && fingerprint ? fingerprint : null;
  } catch {
    return null;
  }
}

function idempotencyArgumentConflictResult(id: unknown): Response {
  const error = 'Error executing tool: idempotency_key уже использован с другими аргументами или не содержит проверяемую привязку аргументов';
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: callToolResult({
      content: [{ type: 'text', text: error }],
      isError: true,
      structuredContent: { error },
    }),
  });
}

function writeClaimIsFresh(createdAt: string): boolean {
  const timestamp = Date.parse(`${createdAt.replace(' ', 'T')}Z`);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= WRITE_CLAIM_LEASE_MS;
}

/** The existing unique audit index is the atomic one-winner claim for a confirmed write. */
async function claimWriteExecution(
  db: D1Database | undefined,
  clientId: string,
  toolName: string,
  idempotencyKey: string,
  argumentFingerprint: string,
): Promise<WriteExecutionClaim> {
  if (!db) throw new Error('Idempotency storage is unavailable');
  await pruneMcpAuditLog(db);
  try {
    await db.prepare(
      `INSERT INTO mcp_audit_log (id, client_id, tool_name, status, result_summary, idempotency_key, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'))`,
    ).bind(crypto.randomUUID(), clientId, toolName, `CLAIMED:${argumentFingerprint}`, idempotencyKey).run();
    return { claimed: true };
  } catch {
    const existing = await db.prepare(
      'SELECT status, tool_name, result_summary, created_at FROM mcp_audit_log WHERE client_id = ? AND idempotency_key = ?',
    ).bind(clientId, idempotencyKey).first<{ status: string; tool_name: string; result_summary: string | null; created_at: string }>();
    if (!existing) throw new Error('Unable to claim idempotency_key');
    return { claimed: false, status: existing.status, toolName: existing.tool_name, resultSummary: existing.result_summary, createdAt: existing.created_at };
  }
}

async function findWriteExecution(
  db: D1Database | undefined,
  clientId: string,
  idempotencyKey: string,
): Promise<{ status: string; toolName: string; resultSummary: string | null; createdAt: string } | null> {
  if (!db) return null;
  const existing = await db.prepare(
    'SELECT status, tool_name, result_summary, created_at FROM mcp_audit_log WHERE client_id = ? AND idempotency_key = ?',
  ).bind(clientId, idempotencyKey).first<{ status: string; tool_name: string; result_summary: string | null; created_at: string }>();
  return existing
    ? { status: existing.status, toolName: existing.tool_name, resultSummary: existing.result_summary, createdAt: existing.created_at }
    : null;
}

async function finalizeWriteExecution(
  db: D1Database | undefined,
  clientId: string,
  idempotencyKey: string,
  resultSummary: string,
  argumentFingerprint: string,
): Promise<void> {
  if (!db) throw new Error('Idempotency storage is unavailable');
  const parsed = JSON.parse(clipAuditSummary(resultSummary) ?? '{}') as Record<string, unknown>;
  const durableSummary = JSON.stringify({
    ...parsed,
    [IDEMPOTENCY_FINGERPRINT_FIELD]: argumentFingerprint,
  });
  const updated = await db.prepare(
    `UPDATE mcp_audit_log
     SET status = 'success', result_summary = ?
     WHERE client_id = ? AND idempotency_key = ? AND status = 'pending'`,
  ).bind(durableSummary, clientId, idempotencyKey).run();
  if (updated.meta.changes !== 1) throw new Error('Idempotency claim was lost');
  await pruneMcpAuditLog(db);
}

async function markWriteExecutionUncertain(
  db: D1Database | undefined,
  clientId: string,
  idempotencyKey: string,
  errorMessage: string,
): Promise<void> {
  if (!db) throw new Error('Idempotency storage is unavailable');
  const updated = await db.prepare(
    `UPDATE mcp_audit_log
     SET result_summary = ?
     WHERE client_id = ? AND idempotency_key = ? AND status = 'pending'`,
  ).bind(`UNCERTAIN: ${errorMessage}`, clientId, idempotencyKey).run();
  if (updated.meta.changes !== 1) throw new Error('Idempotency claim was lost');
}

async function releaseFailedWriteExecution(
  db: D1Database | undefined,
  clientId: string,
  idempotencyKey: string,
): Promise<void> {
  if (!db) return;
  await db.prepare(
    `DELETE FROM mcp_audit_log
     WHERE client_id = ? AND idempotency_key = ? AND status = 'pending'`,
  ).bind(clientId, idempotencyKey).run();
}

function writeReplayResult(id: unknown, resultSummary: string): Response {
  let structured: Record<string, unknown> | null = null;
  try {
    structured = JSON.parse(resultSummary) as Record<string, unknown>;
    delete structured[IDEMPOTENCY_FINGERPRINT_FIELD];
  } catch {}
  const replaySummary = structured ? JSON.stringify(structured) : resultSummary;
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: callToolResult({
      content: [{ type: 'text', text: replaySummary }],
      structuredContent: {
        ...(structured ?? { error: resultSummary }),
        written: true,
        resultType: 'complete',
      },
    }),
  });
}

function summarizeToolResult(data: unknown): string {
  try {
    const text = JSON.stringify(data);
    if (!text) return '';
    return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
  } catch {
    return '';
  }
}

const WRITE_PENDING_TEXT =
  'ЗАПИСЬ НЕ ВЫПОЛНЕНА. Это запрос подтверждения, не факт. Не сообщайте пользователю, что данные уже записаны. Повторите тот же tools/call с полем requestState из этого ответа.';

const REQUEST_STATE_DESCRIPTION =
  'Токен из ответа input_required. Без него инструмент ничего не пишет. Передайте его, чтобы подтвердить запись.';

const WRITE_OUTPUT_COMMON = {
  resultType: { type: 'string', description: 'input_required — ещё не запись; complete — запись выполнена' },
  requestState: { type: 'string' },
  description: { type: 'string' },
  written: { type: 'boolean' },
  tool: { type: 'string' },
  idempotency_key: { type: 'string' },
  arguments: { type: 'object' },
  error: { type: 'string' },
} as const;

const NO_LEDGER_INVARIANT_OUTPUT = {
  operation_count_unchanged: { type: 'boolean', description: 'Provider read-back confirmed that no operation was added or removed' },
  balance_unchanged: { type: 'boolean', description: 'Provider read-back confirmed that every account balance is unchanged' },
} as const;

const WRITE_TOOL_UI = {
  resourceUri: 'ui://write-confirm',
  visibility: ['model', 'app'],
  csp: {
    resourceDomains: [] as string[]
  }
};

const TOOLS = [
  {
    name: 'accounts_list',
    description: 'Получить список всех счетов (Accounts). Возвращает баланс, валюту, статус архивации и сортировку.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              currency: { type: 'string' },
              balance_minor: { type: 'number' },
              archived: { type: 'boolean' }
            }
          }
        },
        error: { type: 'string' }
      }
    }
  },
  {
    name: 'fx_rates_list',
    description: 'Получить сохранённые курсы валют (Exchange rates).',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        rates: {
          type: 'array',
          items: { type: 'object' }
        },
        error: { type: 'string' }
      }
    }
  },
  {
    name: 'planned_items_list',
    description: 'Получить плановые операции (Planned items).',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        planned_items: {
          type: 'array',
          items: { type: 'object' }
        },
        error: { type: 'string' }
      }
    }
  },
  {
    name: 'recurring_items_list',
    description: 'Получить регулярные операции (Recurring items).',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        recurring_items: {
          type: 'array',
          items: { type: 'object' }
        },
        error: { type: 'string' }
      }
    }
  },
  {
    name: 'recurring_fulfillments_list',
    description: 'Получить durable историю materialized, linked и skipped периодов recurring rules.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { recurring_item_id: { type: 'number', description: 'Опциональный ID recurring rule' } },
    },
    outputSchema: {
      type: 'object',
      properties: {
        recurring_fulfillments: { type: 'array', items: { type: 'object' } },
        error: { type: 'string' },
      },
    },
  },
  {
    name: 'operations_list',
    description: 'Получить историю завершенных операций и трат (Operations).',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: { type: 'object' }
        },
        error: { type: 'string' }
      }
    }
  },
  {
    name: 'forecast_get',
    description: 'Получить прогноз состояния счетов и денежного потока (Forecast).',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Горизонт прогноза в днях. Если не указан, используется настройка пользователя по умолчанию.',
          // @ts-ignore
          'x-mcp-header': true
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        accounts: { type: 'array', items: { type: 'object' } },
        incomes: { type: 'array', items: { type: 'object' } },
        expenses: { type: 'array', items: { type: 'object' } },
        transfers: { type: 'array', items: { type: 'object' } },
        limits: { type: 'array', items: { type: 'object' } },
        total_balance_minor: { type: 'number' },
        total_delta_minor: { type: 'number' },
        target_currency: { type: 'string' },
        horizon_days: { type: 'number' },
        error: { type: 'string' }
      }
    },
    _meta: {
      ui: {
        resourceUri: 'ui://pulse',
        visibility: ['model', 'app'],
        csp: {
          resourceDomains: ['https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net']
        }
      }
    }
  },
  {
    name: 'analytics_get',
    description: 'Получить данные аналитики расходов, доходов, динамики трат и разрезов по категориям/магазинам (Analytics).',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Начальная дата периода (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'Конечная дата периода (YYYY-MM-DD)' },
        cats: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Фильтр по категориям' },
        merchants: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Фильтр по магазинам' },
        accounts: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Фильтр по счетам' },
        currencies: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Фильтр по валютам' },
        q: { type: 'string', maxLength: 200, description: 'Поисковый запрос' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        stats: { type: 'object' },
        series: { type: 'object' },
        categories: { type: 'array', items: { type: 'object' } },
        merchants: { type: 'array', items: { type: 'object' } },
        top_items: { type: 'object' },
        receipts: { type: 'array', items: { type: 'object' } },
        error: { type: 'string' }
      }
    },
    _meta: {
      ui: {
        resourceUri: 'ui://analytics',
        visibility: ['model', 'app'],
        csp: {
          resourceDomains: ['https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net']
        }
      }
    }
  },
  {
    name: 'operation_add',
    description: 'Добавить операцию (расход, доход или возврат). Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата операции в формате YYYY-MM-DD' },
        account_id: { type: 'number', description: 'ID счёта' },
        kind: { type: 'string', enum: ['expense', 'income', 'refund'], description: 'Тип операции' },
        item: { type: 'string', description: 'Название или описание товара/услуги' },
        amount_minor: { type: 'number', description: 'Сумма в минорных единицах (отрицательная для expense, положительная для income/refund)' },
        category: { type: 'string', description: 'Категория (опционально)' },
        subcategory: { type: 'string', description: 'Подкатегория (опционально, только если указана категория)' },
        store: { type: 'string', description: 'Магазин или контрагент (опционально)' },
        comment: { type: 'string', description: 'Свободный комментарий к операции (опционально)' },
        receipt_url: { type: 'string', description: 'URL фискального/проверочного чека (http/https, опционально). Сюда пишут PURS/TaxCore QR-ссылки вместо поля item.' },
        fiscal_receipt_id: { type: 'string', description: 'ПФР број рачуна / TaxCore PFR — стабильный id фискального документа. Писать сюда, не в item и не в comment. Пустое = нефискальная операция.' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['date', 'account_id', 'kind', 'item', 'amount_minor', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'operation_update',
    description: 'Частично обновить существующую операцию по operation_id. Требует scope "write" и подтверждения (MRTR); оборачивает штатный PATCH /operations/:id и сохраняет его доменные инварианты.' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'number', description: 'ID операции для изменения' },
        date: { type: 'string', description: 'Новая дата операции YYYY-MM-DD (опционально)' },
        account_id: { type: 'number', description: 'Новый ID счёта (опционально; при смене валюты требуется amount_minor)' },
        kind: { type: 'string', enum: ['expense', 'income', 'refund', 'transfer_out', 'transfer_in'], description: 'Новый вид операции (опционально)' },
        store: { type: ['string', 'null'], description: 'Магазин/контрагент; null очищает поле' },
        item: { type: 'string', description: 'Название или описание товара/услуги (опционально, непустая строка)' },
        category: { type: ['string', 'null'], description: 'Категория; null очищает поле' },
        subcategory: { type: ['string', 'null'], description: 'Подкатегория; null очищает поле, непустая подкатегория требует category' },
        amount_minor: { type: 'number', description: 'Новая сумма в минорных единицах; знак должен соответствовать kind' },
        comment: { type: ['string', 'null'], description: 'Свободный комментарий; null очищает поле' },
        receipt_url: { type: ['string', 'null'], description: 'URL фискального/проверочного чека (http/https); null очищает поле' },
        fiscal_receipt_id: { type: ['string', 'null'], description: 'ПФР / TaxCore fiscal id; null очищает поле. Не класть PFR в item.' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['operation_id', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'operation_delete',
    description: 'Удалить операцию по operation_id через штатную доменную логику DELETE /operations/:id. Обычная операция снимает вклад с баланса; операция плановой снимает done; операция перевода удаляет весь transfer с обеими ногами. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'number', description: 'ID операции для удаления' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['operation_id', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        operation_id: { type: 'number' },
        deleted_operation: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'transfer_add',
    description: 'Добавить перевод между счетами (ATM-снятие, конвертация, перевод между банками). Создаёт запись в transfers плюс две операции (transfer_out со счёта-источника и transfer_in на счёт-назначения) с общим transfer_id. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата перевода в формате YYYY-MM-DD' },
        from_account_id: { type: 'number', description: 'ID счёта-источника (списание)' },
        to_account_id: { type: 'number', description: 'ID счёта-назначения (зачисление)' },
        from_amount_minor: { type: 'number', description: 'Сумма списания в минорных единицах валюты счёта-источника (положительная величина)' },
        to_amount_minor: { type: 'number', description: 'Сумма зачисления в минорных единицах валюты счёта-назначения (положительная величина). При конверсии отличается от from_amount_minor; при переводе в той же валюте обычно равна ей за вычетом комиссии.' },
        item: { type: 'string', description: 'Название или описание перевода' },
        category: { type: 'string', description: 'Категория (опционально)' },
        subcategory: { type: 'string', description: 'Подкатегория (опционально, только если указана категория)' },
        comment: { type: 'string', description: 'Свободный комментарий (опционально; пишется на обе ноги перевода)' },
        receipt_url: { type: 'string', description: 'URL фискального/проверочного чека (http/https, опционально)' },
        fiscal_receipt_id: { type: 'string', description: 'ПФР / TaxCore fiscal id (опционально; пишется на обе ноги перевода)' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['date', 'from_account_id', 'to_account_id', 'from_amount_minor', 'to_amount_minor', 'item', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        transfer: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'balance_correct',
    description: 'Скорректировать текущий баланс счёта. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'number', description: 'ID счёта' },
        balance_minor: { type: 'number', description: 'Новый баланс счёта в минорных единицах валюты счёта' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['account_id', 'balance_minor', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        account: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'planned_item_add',
    description: 'Завести плановую операцию (доход или расход). Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата плановой операции в формате YYYY-MM-DD' },
        title: { type: 'string', description: 'Название плановой операции' },
        amount_minor: { type: 'number', description: 'Сумма в минорных единицах (отрицательная для расхода, положительная для дохода)' },
        account_id: { type: 'number', description: 'ID счёта' },
        currency: { type: 'string', description: 'Валюта плановой операции (по умолчанию валюта счёта)' },
        category: { type: 'string', description: 'Категория (опционально)' },
        done: { type: 'boolean', description: 'Отмечена ли плановая операция как выполненная сразу (по умолчанию false)' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['date', 'title', 'amount_minor', 'account_id', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        planned_item: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'planned_item_update',
    description: 'Частично обновить плановую операцию по planned_item_id, включая штатный переход done → operation. Требует scope "write" и подтверждения (MRTR); использует PATCH /planned-items/:id.' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        planned_item_id: { type: 'number', description: 'ID плановой операции' },
        date: { type: 'string', description: 'Новая дата YYYY-MM-DD' },
        title: { type: 'string', description: 'Новое название' },
        amount_minor: { type: 'number', description: 'Сумма в минорных единицах' },
        currency: { type: 'string', description: 'Валюта; при смене передайте amount_minor тем же запросом' },
        account_id: { type: 'number', description: 'ID счёта' },
        category: { type: ['string', 'null'], description: 'Категория; null очищает поле' },
        done: { type: 'boolean', description: 'true штатно материализует plan → operation при совместимой валюте счёта' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['planned_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { planned_item: { type: 'object' }, operation: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'planned_item_fulfill_existing',
    description: 'Выполнить плановую операцию уже существующим финансовым фактом. Не создаёт и не изменяет operation, не меняет баланс; сохраняет durable linkage. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        planned_item_id: { type: 'number' },
        operation_id: { type: 'number' },
        idempotency_key: { type: 'string' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['planned_item_id', 'operation_id', 'idempotency_key'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['linked', 'already-linked'] },
        planned_item: { type: 'object' }, operation: { type: 'object' },
        ...NO_LEDGER_INVARIANT_OUTPUT,
        ...WRITE_OUTPUT_COMMON,
      },
    },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'planned_item_delete',
    description: 'Удалить плановую операцию по planned_item_id через штатный DELETE /planned-items/:id. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        planned_item_id: { type: 'number', description: 'ID плановой операции для удаления' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['planned_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, planned_item_id: { type: 'number' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_add',
    description: 'Создать регулярное правило. Требует scope "write" и подтверждения (MRTR); создаёт recurring item, а не плановую операцию и не факт списания.' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Название регулярного правила' },
        amount_minor: { type: 'number', description: 'Сумма в минорных единицах; расход отрицателен' },
        account_id: { type: 'number', description: 'ID счёта' },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'], description: 'Частота правила' },
        next_due_date: { type: 'string', description: 'Дата следующего периода YYYY-MM-DD' },
        currency: { type: 'string', description: 'Валюта, по умолчанию валюта счёта' },
        category: { type: ['string', 'null'], description: 'Категория; null очищает/не задаёт' },
        interval_count: { type: 'number', description: 'Интервал от 1 до 365' },
        day_of_month: { type: ['number', 'null'], description: 'Якорь дня месяца для monthly/yearly' },
        month_of_year: { type: ['number', 'null'], description: 'Якорь месяца для yearly' },
        end_date: { type: ['string', 'null'], description: 'Дата последнего периода или null' },
        active: { type: 'boolean', description: 'Активно ли правило; по умолчанию true' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['title', 'amount_minor', 'account_id', 'frequency', 'next_due_date', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { recurring_item: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_update',
    description: 'Частично обновить регулярное правило по recurring_item_id через штатный PATCH /recurring-items/:id. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recurring_item_id: { type: 'number', description: 'ID регулярного правила' },
        title: { type: 'string' }, amount_minor: { type: 'number' }, currency: { type: 'string' }, account_id: { type: 'number' }, category: { type: ['string', 'null'] },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] }, interval_count: { type: 'number' }, day_of_month: { type: ['number', 'null'] }, month_of_year: { type: ['number', 'null'] },
        next_due_date: { type: 'string' }, end_date: { type: ['string', 'null'] }, active: { type: 'boolean' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности' }, requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['recurring_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { recurring_item: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_delete',
    description: 'Удалить регулярное правило по recurring_item_id через штатный DELETE /recurring-items/:id. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { recurring_item_id: { type: 'number' }, idempotency_key: { type: 'string' }, requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION } },
      required: ['recurring_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, recurring_item_id: { type: 'number' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_close_period',
    description: 'Закрыть очередной период регулярного правила через штатный маршрут: атомарно материализует факт операции и сдвигает период. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recurring_item_id: { type: 'number' }, date: { type: 'string' }, amount_minor: { type: 'number' }, account_id: { type: 'number' }, item: { type: 'string' }, category: { type: ['string', 'null'] }, subcategory: { type: ['string', 'null'] },
        idempotency_key: { type: 'string' }, requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['recurring_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { recurring_item: { type: 'object' }, operation: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_fulfill_existing',
    description: 'Выполнить текущий recurring occurrence одной или несколькими уже существующими operations. Не создаёт и не изменяет operations, не меняет баланс; сохраняет occurrence-level linkage. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recurring_item_id: { type: 'number' },
        period_due_date: { type: 'string', description: 'Точный текущий occurrence YYYY-MM-DD' },
        operation_ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'number' } },
        evidence_quantity: { type: 'number', description: 'Явно доказанное число единиц для проверки суммы. Не продвигает дополнительные occurrences; по умолчанию 1, максимум 100' },
        idempotency_key: { type: 'string' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['recurring_item_id', 'period_due_date', 'operation_ids', 'idempotency_key'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['linked', 'already-linked'] },
        evidence_quantity: { type: 'number' },
        recurring_item: { type: 'object' }, fulfillment: { type: 'object' },
        operations: { type: 'array', items: { type: 'object' } },
        ...NO_LEDGER_INVARIANT_OUTPUT,
        ...WRITE_OUTPUT_COMMON,
      },
    },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_skip_period',
    description: 'Пропустить очередной период регулярного правила без создания операции и без изменения баланса через штатный маршрут. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { recurring_item_id: { type: 'number' }, idempotency_key: { type: 'string' }, requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION } },
      required: ['recurring_item_id', 'idempotency_key'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        recurring_item: { type: 'object' }, fulfillment: { type: 'object' },
        ...NO_LEDGER_INVARIANT_OUTPUT,
        ...WRITE_OUTPUT_COMMON,
      },
    },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_cancel_period_fulfillment',
    description: 'Отменить выполнение конкретного периода регулярного правила (materialized, linked или skipped) через штатный маршрут: снимает operation_fulfillment_links и историю периода, не меняет operations и балансы. После отмены DELETE /operations/:id снова разрешён. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recurring_item_id: { type: 'number' },
        period_due_date: { type: 'string', description: 'YYYY-MM-DD якоря периода, который нужно открыть заново' },
        idempotency_key: { type: 'string' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['recurring_item_id', 'period_due_date', 'idempotency_key'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        recurring_item: { type: 'object' },
        canceled: { type: 'object' },
        ...NO_LEDGER_INVARIANT_OUTPUT,
        ...WRITE_OUTPUT_COMMON,
      },
    },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'fx_rate_set',
    description: 'Установить или обновить курс валюты. Не перевод денег и не платёж: это только справочник курсов. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Код валюты (например, USD, EUR, RUB)' },
        rate: { type: 'number', description: 'Курс валюты к целевой валюте' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['code', 'rate', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        rate: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'fx_rate_delete',
    description: 'Удалить курс валюты. Требует scope "write" и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Код валюты для удаления (например, USD, EUR, RUB)' },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['code', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'data_reset',
    description: 'Сбросить финансовый журнал до пустого инстанса без повторного деплоя. Удаляет счета, операции, планы, курсы и настройки журнала. Passkeys, сессии и клиенты OAuth/MCP сохраняются. Требует scope "write", фразу RESET и подтверждения (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        confirm_phrase: { type: 'string', description: `Точная фраза ${RESET_CONFIRM_PHRASE}` },
        idempotency_key: { type: 'string', description: 'Уникальный ключ идемпотентности (UUID), генерируемый клиентом' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['confirm_phrase', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        reset: { type: 'boolean' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  }
];

for (const tool of TOOLS) {
  if (READ_TOOLS.has(tool.name)) {
    (tool as any).annotations = { ...READ_TOOL_ANNOTATIONS };
  } else if (['fx_rate_delete', 'operation_delete', 'planned_item_delete', 'recurring_item_delete', 'recurring_item_cancel_period_fulfillment', 'data_reset'].includes(tool.name)) {
    (tool as any).annotations = { ...WRITE_DELETE_ANNOTATIONS };
  } else if (WRITE_TOOLS.has(tool.name)) {
    (tool as any).annotations = { ...WRITE_TOOL_ANNOTATIONS };
  }
}

/** CallToolResult 2025-11-25: только content / structuredContent / isError / _meta. */
function callToolResult(partial: {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}): Record<string, unknown> {
  const result: Record<string, unknown> = { content: partial.content };
  if (partial.structuredContent !== undefined) result.structuredContent = partial.structuredContent;
  if (partial.isError) result.isError = true;
  if (partial._meta) result._meta = partial._meta;
  return result;
}

const REQUEST_STATE_TTL_MS = 15 * 60 * 1000;
const REQUEST_STATE_MAX_FUTURE_SKEW_MS = 60 * 1000;
const REQUEST_STATE_DOMAIN = 'money-flow:mcp-request-state:v1:';

function requestStateBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function requestStateFromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function requestStateKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('requestState signing is unavailable');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

const MCP_CONFIRM_PREFIX = 'mcp_confirm:';
const WRITE_CREATE_TOOLS = new Set(['operation_add', 'planned_item_add', 'recurring_item_add']);

function firstId(...values: unknown[]): number | string | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value === 'object' && 'id' in value) {
      const id = (value as { id: unknown }).id;
      if (typeof id === 'number' || typeof id === 'string') return id;
    }
  }
  return null;
}

/** Write-only clients may see ids of what they just mutated, not pre-existing rows. */
function redactWriteOnlyMutationResult(
  name: string,
  written: Record<string, unknown>,
  confirmedArgs: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {
    written: true,
    resultType: 'complete',
    success: written.success ?? true,
  };
  const operationId = firstId(
    confirmedArgs.operation_id,
    written.operation_id,
    written.operation,
  );
  const recurringId = firstId(confirmedArgs.recurring_item_id, written.recurring_item_id, written.recurring_item);
  const plannedId = firstId(confirmedArgs.planned_item_id, written.planned_item_id, written.planned_item);
  const accountId = firstId(confirmedArgs.account_id, written.account_id);
  if (operationId !== null) redacted.operation_id = operationId;
  if (recurringId !== null) redacted.recurring_item_id = recurringId;
  if (plannedId !== null) redacted.planned_item_id = plannedId;
  if (accountId !== null && name === 'balance_correct') redacted.account_id = accountId;
  if (name === 'transfer_add') {
    const transfer = written.transfer && typeof written.transfer === 'object'
      ? written.transfer as { id?: unknown; from_operation?: { id?: unknown }; to_operation?: { id?: unknown } }
      : null;
    redacted.transfer_id = firstId(transfer?.id);
    redacted.from_operation_id = firstId(transfer?.from_operation);
    redacted.to_operation_id = firstId(transfer?.to_operation);
  }
  if (name === 'fx_rate_set' || name === 'fx_rate_delete') {
    redacted.code = confirmedArgs.code ?? written.code ?? null;
  }
  if (name === 'operation_delete') {
    redacted.operation_id = firstId(confirmedArgs.operation_id, written.operation_id);
  }
  return redacted;
}

function clientWriteDescription(
  name: string,
  detailed: string | undefined,
  hasRead: boolean,
  confirmedArgs?: Record<string, unknown>,
): string {
  if (hasRead && detailed) return detailed;
  if (WRITE_CREATE_TOOLS.has(name) && detailed) return detailed;
  if (name === 'transfer_add') return 'Подтвердите перевод';
  if (name === 'balance_correct' && confirmedArgs) {
    return `Подтвердите корректировку баланса счёта ID ${confirmedArgs.account_id}: новый баланс ${confirmedArgs.balance_minor}`;
  }
  return `Подтвердите ${name}`;
}

async function storeWriteConfirmation(env: Env, payload: Record<string, unknown>): Promise<string> {
  const handle = crypto.randomUUID();
  await env.KV.put(`${MCP_CONFIRM_PREFIX}${handle}`, JSON.stringify(payload), { expirationTtl: 900 });
  return handle;
}

async function loadWriteConfirmation(env: Env, handle: string): Promise<Record<string, unknown> | null> {
  const stored = await env.KV.get<Record<string, unknown>>(`${MCP_CONFIRM_PREFIX}${handle}`, 'json');
  return stored && typeof stored === 'object' ? stored : null;
}

async function consumeWriteConfirmation(env: Env, handle: string): Promise<void> {
  await env.KV.delete(`${MCP_CONFIRM_PREFIX}${handle}`);
}

async function encodeRequestState(secret: string, state: Record<string, unknown>): Promise<string> {
  const payload = requestStateBase64Url(new TextEncoder().encode(JSON.stringify(state)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await requestStateKey(secret),
    new TextEncoder().encode(`${REQUEST_STATE_DOMAIN}${payload}`),
  );
  return `${payload}.${requestStateBase64Url(new Uint8Array(signature))}`;
}

async function decodeRequestState(secret: string, token: string): Promise<any | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, signatureValue] = parts;
    const signature = requestStateFromBase64Url(signatureValue);
    const payloadBytes = requestStateFromBase64Url(payload);
    if (!signature || !payloadBytes) return null;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await requestStateKey(secret),
      signature,
      new TextEncoder().encode(`${REQUEST_STATE_DOMAIN}${payload}`),
    );
    if (!valid) return null;
    const state = JSON.parse(new TextDecoder().decode(payloadBytes));
    const createdAt = state?.createdAt;
    const now = Date.now();
    if (
      typeof createdAt !== 'number' ||
      !Number.isFinite(createdAt) ||
      createdAt > now + REQUEST_STATE_MAX_FUTURE_SKEW_MS ||
      now - createdAt > REQUEST_STATE_TTL_MS
    ) return null;
    return state;
  } catch {
    return null;
  }
}

async function validateWriteArgs(
  name: string,
  args: any,
  db: D1Database | undefined,
  hasReadScope = true,
): Promise<{ error?: string; description?: string; confirmedArgs?: any; confirmationSnapshot?: any }> {
  const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
  if (!idempotencyKey) {
    return { error: 'Поле idempotency_key обязательно для всех операций записи' };
  }

  if (name === 'operation_add') {
    const { date, account_id, kind, item, amount_minor, category, subcategory, store, comment, receipt_url, fiscal_receipt_id } = args;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return { error: 'Некорректная дата (ожидается формат YYYY-MM-DD)' };
    }
    if (typeof account_id !== 'number' || !Number.isInteger(account_id) || account_id <= 0) {
      return { error: 'Некорректный account_id' };
    }
    if (!['expense', 'income', 'refund'].includes(kind)) {
      return { error: 'kind должен быть одним из: expense, income, refund' };
    }
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { error: 'item не может быть пустым' };
    }
    if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor) || amount_minor === 0) {
      return { error: 'amount_minor должен быть целым ненулевым числом' };
    }
    if (kind === 'expense' && amount_minor > 0) {
      return { error: 'Сумма расхода (expense) должна быть отрицательной' };
    }
    if ((kind === 'income' || kind === 'refund') && amount_minor < 0) {
      return { error: 'Сумма дохода/возврата (income/refund) должна быть положительной' };
    }
    if (subcategory && !category) {
      return { error: 'Подкатегория не может быть указана без категории' };
    }
    const commentParsed = optionalTextValue(comment ?? null, 'comment');
    if (!commentParsed.ok) return { error: commentParsed.error };
    const urlParsed = optionalHttpUrlValue(receipt_url ?? null, 'receipt_url');
    if (!urlParsed.ok) return { error: urlParsed.error };
    const fiscalParsed = optionalFiscalReceiptIdValue(fiscal_receipt_id ?? null);
    if (!fiscalParsed.ok) return { error: fiscalParsed.error };

    if (db) {
      const account = await db.prepare('SELECT id, currency FROM accounts WHERE id = ?').bind(account_id).first<{ id: number; currency: string }>();
      if (!account) {
        return { error: 'Счёт не найден' };
      }
    }

    const kindLabel = kind === 'expense' ? 'расход' : kind === 'income' ? 'доход' : 'возврат';
    const description = `Подтвердите добавление операции: ${kindLabel} "${item.trim()}" на сумму ${amount_minor} (счёт ID ${account_id}${category ? `, категория: ${category}` : ''})`;
    const confirmedArgs = {
      date, account_id, kind, item: item.trim(), amount_minor, category, subcategory, store,
      comment: commentParsed.value, receipt_url: urlParsed.value, fiscal_receipt_id: fiscalParsed.value,
      idempotency_key: idempotencyKey,
    };
    return { description, confirmedArgs };
  }

  if (name === 'operation_update') {
    const operationId = operationIdFromArgs(args);
    if (operationId === null) {
      return { error: 'Некорректный operation_id' };
    }

    const unknownFields = Object.keys(args).filter(
      (key) => !OPERATION_UPDATE_CONTROL_FIELDS.has(key) && !OPERATION_UPDATE_FIELD_SET.has(key),
    );
    const systemFields = Object.keys(args).filter((key) =>
      ['id', 'source', 'receipt_id', 'planned_item_id', 'recurring_item_id', 'transfer_id', 'currency'].includes(key),
    );
    const rejectedFields = Array.from(new Set([...unknownFields, ...systemFields]));
    if (rejectedFields.length > 0) {
      return {
        error: `Недопустимые поля operation_update: ${rejectedFields.join(', ')}. Разрешённые поля: operation_id, ${OPERATION_UPDATE_FIELDS.join(', ')}, idempotency_key, requestState`,
      };
    }

    const patchArgs: Record<string, unknown> = {};
    for (const field of OPERATION_UPDATE_FIELDS) {
      if (field in args) patchArgs[field] = args[field];
    }
    if (Object.keys(patchArgs).length === 0) {
      return { error: `Нужно передать хотя бы одно поле для изменения. Разрешённые поля: ${OPERATION_UPDATE_FIELDS.join(', ')}` };
    }

    const current = await loadOperationForMcp(db, operationId);
    if (!current) {
      return { error: 'Операция не найдена' };
    }

    const normalized: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(patchArgs)) {
      switch (field) {
        case 'date':
          if (typeof raw !== 'string' || !isIsoDate(raw)) return { error: 'Некорректная дата (ожидается формат YYYY-MM-DD)' };
          normalized.date = raw;
          break;
        case 'account_id':
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return { error: 'Некорректный account_id' };
          normalized.account_id = raw;
          break;
        case 'kind':
          if (typeof raw !== 'string' || !(OPERATION_KINDS as readonly string[]).includes(raw)) {
            return { error: `kind должен быть одним из: ${OPERATION_KINDS.join(', ')}` };
          }
          normalized.kind = raw;
          break;
        case 'store':
        case 'category':
        case 'subcategory':
        case 'comment': {
          const parsed = optionalTextValue(raw, field);
          if (!parsed.ok) return { error: parsed.error };
          normalized[field] = parsed.value;
          break;
        }
        case 'receipt_url': {
          const parsed = optionalHttpUrlValue(raw, field);
          if (!parsed.ok) return { error: parsed.error };
          normalized[field] = parsed.value;
          break;
        }
        case 'fiscal_receipt_id': {
          const parsed = optionalFiscalReceiptIdValue(raw);
          if (!parsed.ok) return { error: parsed.error };
          normalized[field] = parsed.value;
          break;
        }
        case 'item': {
          const parsed = requiredTextValue(raw, 'item');
          if (!parsed.ok) return { error: parsed.error };
          normalized.item = parsed.value;
          break;
        }
        case 'amount_minor':
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw === 0) return { error: 'amount_minor должен быть целым ненулевым числом' };
          normalized.amount_minor = raw;
          break;
      }
    }

    const nextKind = (normalized.kind as string | undefined) ?? current.kind;
    const nextAmount = (normalized.amount_minor as number | undefined) ?? current.amount_minor;
    const nextAccountId = (normalized.account_id as number | undefined) ?? current.account_id;
    const nextCategory = Object.prototype.hasOwnProperty.call(normalized, 'category') ? normalized.category as string | null : current.category;
    const nextSubcategory = Object.prototype.hasOwnProperty.call(normalized, 'subcategory') ? normalized.subcategory as string | null : current.subcategory;

    if (current.transfer_id !== null && ('kind' in normalized || 'account_id' in normalized || 'amount_minor' in normalized)) {
      return { error: 'Сумму, счёт и вид перевода нельзя менять по отдельности — удалите перевод и создайте заново' };
    }
    const signError = signMatchesKind(nextKind, nextAmount);
    if (signError) return { error: signError };
    if (nextSubcategory !== null && nextCategory === null) {
      return { error: 'subcategory без category не имеет смысла — укажите категорию или уберите подкатегорию' };
    }
    if (db && nextAccountId !== current.account_id) {
      const target = await db.prepare('SELECT id, name, currency FROM accounts WHERE id = ?').bind(nextAccountId).first<{ id: number; name: string; currency: string }>();
      if (!target) return { error: 'Счёт не найден' };
      if (target.currency !== current.currency && !('amount_minor' in normalized)) {
        return { error: `Смена счёта меняет валюту операции с ${current.currency} на ${target.currency} — передайте amount_minor в новой валюте тем же запросом` };
      }
    }

    const changedFields = Object.keys(normalized).join(', ');
    const description = `Подтвердите изменение операции ID ${operationId}: поля ${changedFields}`;
    return { description, confirmedArgs: { operation_id: operationId, ...normalized, idempotency_key: idempotencyKey } };
  }

  if (name === 'operation_delete') {
    const operationId = operationIdFromArgs(args);
    if (operationId === null) {
      return { error: 'Некорректный operation_id' };
    }
    const allowed = new Set(['operation_id', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((key) => !allowed.has(key));
    if (rejected.length > 0) {
      return { error: `Недопустимые поля operation_delete: ${rejected.join(', ')}. Разрешённые поля: operation_id, idempotency_key, requestState` };
    }
    const current = await loadOperationForMcp(db, operationId);
    if (!current) {
      return { error: 'Операция не найдена' };
    }
    const transferNote = current.transfer_id !== null ? ` Будет удалён весь связанный перевод transfer_id=${current.transfer_id} с обеими ногами.` : '';
    const plannedNote = current.planned_item_id !== null ? ` У связанной плановой операции planned_item_id=${current.planned_item_id} будет снят done.` : '';
    const description = `Подтвердите удаление операции ID ${operationId}: ${current.kind} "${current.item}" на сумму ${current.amount_minor} ${current.currency}.${transferNote}${plannedNote}`;
    return { description, confirmedArgs: { operation_id: operationId, idempotency_key: idempotencyKey } };
  }

  if (name === 'transfer_add') {
    const { date, from_account_id, to_account_id, from_amount_minor, to_amount_minor, item, category, subcategory, comment, receipt_url, fiscal_receipt_id } = args;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return { error: 'Некорректная дата (ожидается формат YYYY-MM-DD)' };
    }
    if (typeof from_account_id !== 'number' || !Number.isInteger(from_account_id) || from_account_id <= 0) {
      return { error: 'Некорректный from_account_id' };
    }
    if (typeof to_account_id !== 'number' || !Number.isInteger(to_account_id) || to_account_id <= 0) {
      return { error: 'Некорректный to_account_id' };
    }
    if (from_account_id === to_account_id) {
      return { error: 'Счёт списания и счёт зачисления должны отличаться' };
    }
    if (typeof from_amount_minor !== 'number' || !Number.isInteger(from_amount_minor) || from_amount_minor <= 0) {
      return { error: 'from_amount_minor должен быть целым положительным числом' };
    }
    if (typeof to_amount_minor !== 'number' || !Number.isInteger(to_amount_minor) || to_amount_minor <= 0) {
      return { error: 'to_amount_minor должен быть целым положительным числом' };
    }
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { error: 'item не может быть пустым' };
    }
    if (subcategory && !category) {
      return { error: 'Подкатегория не может быть указана без категории' };
    }
    const commentParsed = optionalTextValue(comment ?? null, 'comment');
    if (!commentParsed.ok) return { error: commentParsed.error };
    const urlParsed = optionalHttpUrlValue(receipt_url ?? null, 'receipt_url');
    if (!urlParsed.ok) return { error: urlParsed.error };
    const fiscalParsed = optionalFiscalReceiptIdValue(fiscal_receipt_id ?? null);
    if (!fiscalParsed.ok) return { error: fiscalParsed.error };
    const transferMeta = { comment: commentParsed.value, receipt_url: urlParsed.value, fiscal_receipt_id: fiscalParsed.value };

    if (db) {
      const [accFrom, accTo] = await Promise.all([
        db.prepare('SELECT id, name, currency FROM accounts WHERE id = ?').bind(from_account_id).first<{ id: number; name: string; currency: string }>(),
        db.prepare('SELECT id, name, currency FROM accounts WHERE id = ?').bind(to_account_id).first<{ id: number; name: string; currency: string }>(),
      ]);
      if (!accFrom) {
        return { error: 'Счёт списания не найден' };
      }
      if (!accTo) {
        return { error: 'Счёт зачисления не найден' };
      }
      const currencyNote =
        accFrom.currency !== accTo.currency
          ? ` (конвертация ${accFrom.currency} → ${accTo.currency})`
          : '';
      const description = `Подтвердите перевод "${item.trim()}"${currencyNote}: ${from_amount_minor} ${accFrom.currency} со счёта «${accFrom.name}» → ${to_amount_minor} ${accTo.currency} на счёт «${accTo.name}»${category ? `, категория: ${category}` : ''}`;
      const confirmedArgs = {
        date,
        from_account_id,
        to_account_id,
        from_amount_minor,
        to_amount_minor,
        item: item.trim(),
        category,
        subcategory,
        ...transferMeta,
        idempotency_key: idempotencyKey,
      };
      return { description, confirmedArgs };
    }

    const description = `Подтвердите перевод "${item.trim()}": ${from_amount_minor} со счёта ID ${from_account_id} → ${to_amount_minor} на счёт ID ${to_account_id}`;
    const confirmedArgs = {
      date,
      from_account_id,
      to_account_id,
      from_amount_minor,
      to_amount_minor,
      item: item.trim(),
      category,
      subcategory,
      ...transferMeta,
      idempotency_key: idempotencyKey,
    };
    return { description, confirmedArgs };
  }

  if (name === 'balance_correct') {
    const { account_id, balance_minor } = args;
    if (typeof account_id !== 'number' || !Number.isInteger(account_id) || account_id <= 0) {
      return { error: 'Некорректный account_id' };
    }
    if (typeof balance_minor !== 'number' || !Number.isInteger(balance_minor)) {
      return { error: 'balance_minor должен быть целым числом' };
    }

    if (db) {
      const account = await db.prepare('SELECT id, name, currency, balance_minor FROM accounts WHERE id = ?').bind(account_id).first<{ id: number; name: string; currency: string; balance_minor: number }>();
      if (!account) {
        return { error: 'Счёт не найден' };
      }
      const description = `Подтвердите корректировку баланса счёта "${account.name}" (ID ${account_id}): новый баланс ${balance_minor} ${account.currency} (текущий: ${account.balance_minor})`;
      const confirmedArgs = { account_id, balance_minor, idempotency_key: idempotencyKey };
      return { description, confirmedArgs };
    }

    const description = `Подтвердите корректировку баланса счёта ID ${account_id}: новый баланс ${balance_minor}`;
    const confirmedArgs = { account_id, balance_minor, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'planned_item_add') {
    const { date, title, amount_minor, account_id, currency, category, done } = args;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return { error: 'Некорректная дата (ожидается формат YYYY-MM-DD)' };
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      return { error: 'title не может быть пустым' };
    }
    if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor) || amount_minor === 0) {
      return { error: 'amount_minor должен быть целым ненулевым числом' };
    }
    if (typeof account_id !== 'number' || !Number.isInteger(account_id) || account_id <= 0) {
      return { error: 'Некорректный account_id' };
    }

    if (db) {
      const account = await db.prepare('SELECT id, currency FROM accounts WHERE id = ?').bind(account_id).first<{ id: number; currency: string }>();
      if (!account) {
        return { error: 'Счёт не найден' };
      }
    }

    const description = `Подтвердите создание плановой операции "${title.trim()}" на дату ${date} на сумму ${amount_minor} (счёт ID ${account_id})`;
    const confirmedArgs = { date, title: title.trim(), amount_minor, account_id, currency, category, done, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'planned_item_fulfill_existing') {
    const allowed = new Set(['planned_item_id', 'operation_id', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Недопустимые поля ${name}: ${rejected.join(', ')}` };
    const plannedItemId = args.planned_item_id;
    const operationId = args.operation_id;
    if (typeof plannedItemId !== 'number' || !Number.isInteger(plannedItemId) || plannedItemId <= 0) return { error: 'Некорректный planned_item_id' };
    if (typeof operationId !== 'number' || !Number.isInteger(operationId) || operationId <= 0) return { error: 'Некорректный operation_id' };
    if (!db) return { error: 'Хранилище недоступно' };
    const [planned, operation] = await Promise.all([
      db.prepare('SELECT * FROM planned_items WHERE id = ?').bind(plannedItemId).first<Record<string, unknown>>(),
      loadOperationForMcp(db, operationId),
    ]);
    if (!planned) return { error: 'Плановая операция не найдена' };
    if (!operation) return { error: 'Операция не найдена' };
    const confirmationSnapshot = {
      type: 'planned_fulfill', id: planned.id, revision: planned.revision,
      date: planned.date, title: planned.title, amount_minor: planned.amount_minor,
      currency: planned.currency, account_id: planned.account_id,
      category: planned.category, done: planned.done,
    };
    return {
      description: `Подтвердите выполнение плановой операции ID ${plannedItemId} существующей operation ID ${operationId}. Новая operation не создаётся, баланс не изменяется.`,
      confirmedArgs: { planned_item_id: plannedItemId, operation_id: operationId, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'planned_item_update' || name === 'recurring_item_update') {
    const idField = name === 'planned_item_update' ? 'planned_item_id' : 'recurring_item_id';
    const fields = name === 'planned_item_update' ? PLANNED_UPDATE_FIELDS : RECURRING_UPDATE_FIELDS;
    const rawId = args[idField];
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
      return { error: `Некорректный ${idField}` };
    }
    const allowed = new Set<string>([idField, ...fields, 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) {
      return { error: `Недопустимые поля ${name}: ${rejected.join(', ')}. Разрешённые поля: ${idField}, ${fields.join(', ')}, idempotency_key, requestState` };
    }
    const patchArgs: Record<string, unknown> = {};
    for (const field of fields) if (field in args) patchArgs[field] = args[field];
    if (Object.keys(patchArgs).length === 0) {
      return { error: `Нужно передать хотя бы одно поле для изменения: ${fields.join(', ')}` };
    }
    let confirmationSnapshot: Record<string, unknown> | undefined;
    if (db) {
      const table = name === 'planned_item_update' ? 'planned_items' : 'recurring_items';
      const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(rawId).first<Record<string, unknown>>();
      if (!existing) return { error: `${name === 'planned_item_update' ? 'Плановая операция' : 'Регулярное правило'} не найдено` };
      if (name === 'planned_item_update') {
        confirmationSnapshot = {
          type: 'planned_item',
          id: existing.id,
          revision: existing.revision,
          date: existing.date,
          title: existing.title,
          amount_minor: existing.amount_minor,
          currency: existing.currency,
          account_id: existing.account_id,
          category: existing.category,
          done: existing.done,
        };
      } else {
        confirmationSnapshot = {
          type: 'recurring_item',
          id: existing.id,
          revision: existing.revision,
          title: existing.title,
          amount_minor: existing.amount_minor,
          currency: existing.currency,
          account_id: existing.account_id,
          category: existing.category,
          frequency: existing.frequency,
          interval_count: existing.interval_count,
          day_of_month: existing.day_of_month,
          month_of_year: existing.month_of_year,
          next_due_date: existing.next_due_date,
          end_date: existing.end_date,
          active: existing.active,
        };
      }
    }
    return {
      description: `Подтвердите изменение ${name === 'planned_item_update' ? 'плановой операции' : 'регулярного правила'} ID ${rawId}: поля ${Object.keys(patchArgs).join(', ')}`,
      confirmedArgs: { [idField]: rawId, ...patchArgs, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'planned_item_delete' || name === 'recurring_item_delete') {
    const idField = name === 'planned_item_delete' ? 'planned_item_id' : 'recurring_item_id';
    const rawId = args[idField];
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) return { error: `Некорректный ${idField}` };
    const allowed = new Set([idField, 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Недопустимые поля ${name}: ${rejected.join(', ')}` };
    let confirmationSnapshot: Record<string, unknown> | undefined;
    if (db) {
      const table = name === 'planned_item_delete' ? 'planned_items' : 'recurring_items';
      const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(rawId).first<Record<string, unknown>>();
      if (!existing) return { error: `${name === 'planned_item_delete' ? 'Плановая операция' : 'Регулярное правило'} не найдено` };
      confirmationSnapshot = name === 'planned_item_delete'
        ? {
            type: 'planned_item', id: existing.id, revision: existing.revision,
            date: existing.date, title: existing.title, amount_minor: existing.amount_minor,
            currency: existing.currency, account_id: existing.account_id,
            category: existing.category, done: existing.done,
          }
        : {
            type: 'recurring_item', id: existing.id, revision: existing.revision,
            title: existing.title, amount_minor: existing.amount_minor,
            currency: existing.currency, account_id: existing.account_id,
            category: existing.category, frequency: existing.frequency,
            interval_count: existing.interval_count, day_of_month: existing.day_of_month,
            month_of_year: existing.month_of_year, next_due_date: existing.next_due_date,
            end_date: existing.end_date, active: existing.active,
          };
    }
    return {
      description: `Подтвердите удаление для ID ${rawId}`,
      confirmedArgs: { [idField]: rawId, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'recurring_item_fulfill_existing') {
    const allowed = new Set(['recurring_item_id', 'period_due_date', 'operation_ids', 'evidence_quantity', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Недопустимые поля ${name}: ${rejected.join(', ')}` };
    const recurringItemId = args.recurring_item_id;
    const periodDueDate = args.period_due_date;
    const operationIds = args.operation_ids;
    if (typeof recurringItemId !== 'number' || !Number.isInteger(recurringItemId) || recurringItemId <= 0) return { error: 'Некорректный recurring_item_id' };
    if (typeof periodDueDate !== 'string' || !isIsoDate(periodDueDate)) return { error: 'Некорректный period_due_date' };
    if (!Array.isArray(operationIds) || operationIds.length === 0 || operationIds.length > 100 || operationIds.some((value) => typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
      return { error: 'operation_ids должен быть непустым массивом максимум из 100 положительных ID' };
    }
    if (new Set(operationIds).size !== operationIds.length) return { error: 'operation_ids не должен содержать дубликаты' };
    const evidenceQuantity = args.evidence_quantity === undefined ? 1 : args.evidence_quantity;
    if (typeof evidenceQuantity !== 'number' || !Number.isInteger(evidenceQuantity) || evidenceQuantity < 1 || evidenceQuantity > 100) {
      return { error: 'evidence_quantity должен быть целым числом от 1 до 100' };
    }
    if (!db) return { error: 'Хранилище recurring недоступно' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?')
      .bind(recurringItemId).first<Record<string, unknown>>();
    if (!existing) return { error: 'Регулярное правило не найдено' };
    if (isAnalyticalSkipOnlyRecurringId(recurringItemId)) {
      return { error: `Аналитическое правило ID ${recurringItemId} принимает только skip_period` };
    }
    if (existing.active !== 1) return { error: 'Регулярное правило неактивно' };
    const confirmationSnapshot = {
      type: 'recurring_fulfill', id: existing.id, revision: existing.revision,
      title: existing.title, amount_minor: existing.amount_minor, currency: existing.currency,
      account_id: existing.account_id, category: existing.category, frequency: existing.frequency,
      interval_count: existing.interval_count, day_of_month: existing.day_of_month,
      month_of_year: existing.month_of_year, next_due_date: existing.next_due_date,
      end_date: existing.end_date, active: existing.active,
    };
    const sortedIds = [...operationIds].sort((a, b) => a - b);
    return {
      description: `Подтвердите выполнение одной recurring occurrence ${periodDueDate} правила ID ${recurringItemId} существующими operations [${sortedIds.join(', ')}]. Явное количество единиц ${evidenceQuantity} используется только для проверки суммы; дополнительные occurrences этим вызовом не продвигаются. Новые operations не создаются, баланс не изменяется.`,
      confirmedArgs: {
        recurring_item_id: recurringItemId,
        period_due_date: periodDueDate,
        operation_ids: sortedIds,
        evidence_quantity: evidenceQuantity,
        idempotency_key: idempotencyKey,
      },
      confirmationSnapshot,
    };
  }

  if (name === 'recurring_item_cancel_period_fulfillment') {
    const allowed = new Set(['recurring_item_id', 'period_due_date', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Недопустимые поля ${name}: ${rejected.join(', ')}` };
    const recurringItemId = args.recurring_item_id;
    const periodDueDate = args.period_due_date;
    if (typeof recurringItemId !== 'number' || !Number.isInteger(recurringItemId) || recurringItemId <= 0) {
      return { error: 'Некорректный recurring_item_id' };
    }
    if (typeof periodDueDate !== 'string' || !isIsoDate(periodDueDate)) {
      return { error: 'Некорректный period_due_date' };
    }
    if (!db) return { error: 'Хранилище recurring недоступно' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?')
      .bind(recurringItemId).first<Record<string, unknown>>();
    if (!existing) return { error: 'Регулярное правило не найдено' };
    const fulfillment = await db.prepare(
      'SELECT outcome FROM recurring_period_fulfillments WHERE recurring_item_id = ? AND period_due_date = ?',
    ).bind(recurringItemId, periodDueDate).first<{ outcome: string }>();
    if (!fulfillment) return { error: 'Выполнение периода не найдено' };
    const confirmationSnapshot = {
      type: 'recurring_cancel',
      id: existing.id,
      revision: existing.revision,
      title: existing.title,
      amount_minor: existing.amount_minor,
      currency: existing.currency,
      account_id: existing.account_id,
      category: existing.category,
      frequency: existing.frequency,
      interval_count: existing.interval_count,
      day_of_month: existing.day_of_month,
      month_of_year: existing.month_of_year,
      next_due_date: existing.next_due_date,
      end_date: existing.end_date,
      active: existing.active,
    };
    return {
      description: `Подтвердите отмену выполнения периода ${periodDueDate} (${fulfillment.outcome}) регулярного правила ID ${recurringItemId}. Связанные operations и балансы не изменяются; период открывается заново.`,
      confirmedArgs: {
        recurring_item_id: recurringItemId,
        period_due_date: periodDueDate,
        idempotency_key: idempotencyKey,
      },
      confirmationSnapshot,
    };
  }

  if (name === 'recurring_item_skip_period') {
    const rawId = args.recurring_item_id;
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) return { error: 'Некорректный recurring_item_id' };
    const allowed = new Set(['recurring_item_id', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Недопустимые поля ${name}: ${rejected.join(', ')}` };
    if (!db) return { error: 'Хранилище recurring недоступно' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?').bind(rawId).first<Record<string, unknown>>();
    if (!existing) return { error: 'Регулярное правило не найдено' };
    if (existing.active !== 1) return { error: 'Регулярное правило неактивно' };
    const confirmationSnapshot = {
      type: 'recurring_skip',
      id: existing.id,
      revision: existing.revision,
      title: existing.title,
      amount_minor: existing.amount_minor,
      currency: existing.currency,
      account_id: existing.account_id,
      category: existing.category,
      frequency: existing.frequency,
      interval_count: existing.interval_count,
      day_of_month: existing.day_of_month,
      month_of_year: existing.month_of_year,
      next_due_date: existing.next_due_date,
      end_date: existing.end_date,
      active: existing.active,
    };
    return {
      description: `Подтвердите пропуск периода ${existing.next_due_date} для регулярного правила ID ${rawId} без создания операции и изменения баланса`,
      confirmedArgs: { recurring_item_id: rawId, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'recurring_item_add') {
    const rejected = Object.keys(args).filter((field) => !RECURRING_ADD_FIELD_SET.has(field));
    if (rejected.length > 0) return { error: `Недопустимые поля recurring_item_add: ${rejected.join(', ')}` };
    const { title, amount_minor, account_id, frequency, next_due_date } = args;
    if (typeof title !== 'string' || title.trim().length === 0) return { error: 'title не может быть пустым' };
    if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor) || amount_minor === 0) return { error: 'amount_minor должен быть целым ненулевым числом' };
    if (typeof account_id !== 'number' || !Number.isInteger(account_id) || account_id <= 0) return { error: 'Некорректный account_id' };
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) return { error: 'frequency должен быть одним из: daily, weekly, monthly, yearly' };
    if (typeof next_due_date !== 'string' || !isIsoDate(next_due_date)) return { error: 'Некорректная next_due_date (ожидается формат YYYY-MM-DD)' };
    return {
      description: `Подтвердите создание регулярного правила "${title.trim()}": ${amount_minor} на счёте ID ${account_id}, ${frequency}, следующий период ${next_due_date}. Это правило, не плановая операция и не факт списания.`,
      confirmedArgs: {
        title: title.trim(), amount_minor, account_id, frequency, next_due_date,
        currency: args.currency, category: args.category, interval_count: args.interval_count,
        day_of_month: args.day_of_month, month_of_year: args.month_of_year, end_date: args.end_date,
        active: args.active, idempotency_key: idempotencyKey,
      },
    };
  }

  if (name === 'recurring_item_close_period') {
    const allowed = new Set(['recurring_item_id', 'date', 'amount_minor', 'account_id', 'item', 'category', 'subcategory', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Недопустимые поля recurring_item_close_period: ${rejected.join(', ')}` };
    const recurringItemId = args.recurring_item_id;
    if (typeof recurringItemId !== 'number' || !Number.isInteger(recurringItemId) || recurringItemId <= 0) return { error: 'Некорректный recurring_item_id' };
    if (!db) return { error: 'Хранилище recurring недоступно' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?')
      .bind(recurringItemId)
      .first<Record<string, unknown>>();
    if (!existing) return { error: 'Регулярное правило не найдено' };
    if (isAnalyticalSkipOnlyRecurringId(recurringItemId)) {
      return { error: `Аналитическое правило ID ${recurringItemId} принимает только skip_period` };
    }
    if (existing.active !== 1) return { error: 'Регулярное правило неактивно' };
    const closeFields = ['date', 'amount_minor', 'account_id', 'item'] as const;
    if (!hasReadScope) {
      const missing = closeFields.filter((field) => !(field in args));
      if (missing.length > 0) {
        return { error: `write-only token must supply ${missing.join(', ')} explicitly` };
      }
    }
    const confirmedClose = {
      date: 'date' in args ? args.date : existing.next_due_date,
      amount_minor: 'amount_minor' in args ? args.amount_minor : existing.amount_minor,
      account_id: 'account_id' in args ? args.account_id : existing.account_id,
      item: 'item' in args ? args.item : existing.title,
      category: 'category' in args ? args.category : existing.category,
      subcategory: 'subcategory' in args ? args.subcategory : null,
    };
    const writeOnlyCloseArgs = !hasReadScope
      ? {
          recurring_item_id: recurringItemId,
          date: args.date,
          amount_minor: args.amount_minor,
          account_id: args.account_id,
          item: args.item,
          category: 'category' in args ? args.category : null,
          subcategory: 'subcategory' in args ? args.subcategory : null,
          idempotency_key: idempotencyKey,
        }
      : null;
    const confirmationSnapshot = {
      type: 'recurring_close',
      id: existing.id,
      revision: existing.revision,
      title: existing.title,
      amount_minor: existing.amount_minor,
      currency: existing.currency,
      account_id: existing.account_id,
      category: existing.category,
      frequency: existing.frequency,
      interval_count: existing.interval_count,
      day_of_month: existing.day_of_month,
      month_of_year: existing.month_of_year,
      next_due_date: existing.next_due_date,
      end_date: existing.end_date,
      active: existing.active,
    };
    return {
      description: `Подтвердите закрытие периода регулярного правила ID ${recurringItemId}: будет создан факт ${confirmedClose.amount_minor} на счёте ID ${confirmedClose.account_id} за ${confirmedClose.date} и сдвинут следующий период.`,
      confirmedArgs: writeOnlyCloseArgs ?? { recurring_item_id: recurringItemId, ...confirmedClose, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'fx_rate_set') {
    const { code, rate } = args;
    if (typeof code !== 'string' || !/^[a-zA-Z]{3}$/.test(code)) {
      return { error: 'Код валюты должен состоять ровно из трёх латинских букв (ISO-4217), например USD' };
    }
    if (typeof rate !== 'number' || rate <= 0) {
      return { error: 'Курс валюты (rate) должен быть положительным числом' };
    }
    const description = `Подтвердите установку курса для ${code.toUpperCase()}: ${rate}`;
    const confirmedArgs = { code: code.toUpperCase(), rate, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'fx_rate_delete') {
    const { code } = args;
    if (typeof code !== 'string' || !/^[a-zA-Z]{3}$/.test(code)) {
      return { error: 'Код валюты должен состоять ровно из трёх латинских букв (ISO-4217), например USD' };
    }
    const description = `Подтвердите удаление курса для ${code.toUpperCase()}`;
    const confirmedArgs = { code: code.toUpperCase(), idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'data_reset') {
    if (args.confirm_phrase !== RESET_CONFIRM_PHRASE) {
      return { error: `confirm_phrase должен быть ровно ${RESET_CONFIRM_PHRASE}` };
    }
    const description = `Подтвердите полный сброс финансовых данных до пустого инстанса. Passkeys и клиенты MCP сохраняются.`;
    const confirmedArgs = { confirm_phrase: RESET_CONFIRM_PHRASE, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  return { error: `Неизвестный инструмент: ${name}` };
}

async function confirmationSnapshotStillCurrent(
  db: D1Database | undefined,
  snapshot: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (!snapshot) return true;
  if (!db) return false;
  if (snapshot.type === 'planned_item' || snapshot.type === 'planned_done' || snapshot.type === 'planned_fulfill') {
    const row = await db.prepare(
      'SELECT id, revision, date, title, amount_minor, currency, account_id, category, done FROM planned_items WHERE id = ?',
    ).bind(snapshot.id).first<Record<string, unknown>>();
    if (!row) return false;
    return JSON.stringify({ type: snapshot.type, ...row }) === JSON.stringify(snapshot);
  }
  if (
    snapshot.type === 'recurring_item' || snapshot.type === 'recurring_close'
    || snapshot.type === 'recurring_skip' || snapshot.type === 'recurring_fulfill'
    || snapshot.type === 'recurring_cancel'
  ) {
    const row = await db.prepare(
      `SELECT id, revision, title, amount_minor, currency, account_id, category, frequency,
              interval_count, day_of_month, month_of_year, next_due_date, end_date, active
       FROM recurring_items WHERE id = ?`,
    ).bind(snapshot.id).first<Record<string, unknown>>();
    if (!row) return false;
    return JSON.stringify({ type: snapshot.type, ...row }) === JSON.stringify(snapshot);
  }
  return false;
}

mcpApp.get('/mcp', (c) => c.json({ status: 'ok', message: 'MCP API endpoint' }));

const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const MCP_PROTOCOL_DEFAULT = '2026-07-28';

function negotiateMcpProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return MCP_PROTOCOL_DEFAULT;
}

mcpApp.post('/mcp', async (c) => {
  const headerMethod = c.req.header('Mcp-Method') || c.req.header('mcp-method');
  const headerName = c.req.header('Mcp-Name') || c.req.header('mcp-name');

  let body: any = null;
  try {
    body = await readLimitedJson(c.req.raw, MCP_MAX_JSON_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'FILTER_TOO_LARGE' },
        id: null,
      });
    }
    if (!headerMethod) {
      return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    body = {};
  }

  if (body !== null && typeof body !== 'object') {
    return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
  }

  const jsonrpc = body?.jsonrpc || '2.0';
  const id = body?.id !== undefined ? body.id : null;
  const method = (typeof body?.method === 'string' && body.method.trim().length > 0)
    ? body.method.trim()
    : (typeof headerMethod === 'string' && headerMethod.trim().length > 0 ? headerMethod.trim() : '');
  const params = (body?.params && typeof body.params === 'object') ? body.params : {};

  if (jsonrpc !== '2.0' || !method) {
    return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id });
  }

  c.header('Mcp-Method', method);

  if (method === 'initialize') {
    return c.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiateMcpProtocolVersion(params?.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: 'money-flow',
          version: '0.1.0',
        },
      },
    });
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204 });
  }

  if (method === 'ping') {
    return c.json({ jsonrpc: '2.0', id, result: {} });
  }

  const ctx = c.executionCtx as any;
  const scopes: string[] = ctx?.props?.scopes || [];
  const clientId: string = ctx?.props?.clientId || ctx?.props?.client_id || 'anonymous';
  const hasReadScope = scopes.includes('read');
  const hasWriteScope = scopes.includes('write');

  // Обновляем время использования активного токена клиента в фоне
  if (clientId && clientId !== 'anonymous' && c.env?.DB) {
    const ip = c.req.header('cf-connecting-ip');
    const country = c.req.header('cf-ipcountry');
    const touchPromise = c.env.DB.prepare(
      `UPDATE oauth_tokens
       SET last_used_at = datetime('now'),
           last_ip = COALESCE(?, last_ip),
           last_country = COALESCE(?, last_country)
       WHERE client_id = ? AND revoked_at IS NULL`
    ).bind(ip ?? null, country ?? null, clientId).run().catch(() => {});
    if (ctx?.waitUntil) {
      ctx.waitUntil(touchPromise);
    }
  }

  if (method === 'resources/list') {
    if (!hasReadScope && !hasWriteScope) {
      return c.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'Insufficient permissions. "read" or "write" scope required.' }
      });
    }
    const resources: any[] = [];
    if (hasReadScope) {
      resources.push(
        {
          uri: 'ui://pulse',
          name: 'Пульс (Pulse Dashboard)',
          description: 'Интерактивный пульт диагностики денежного потока и состояния счетов',
          mimeType: 'text/html;profile=mcp-app',
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                resourceDomains: ['https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net']
              }
            }
          }
        },
        {
          uri: 'ui://analytics',
          name: 'Аналитика (Analytics Dashboard)',
          description: 'Интерактивный интерфейс аналитики расходов и структуры трат',
          mimeType: 'text/html;profile=mcp-app',
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                resourceDomains: ['https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net']
              }
            }
          }
        }
      );
    }
    if (hasWriteScope) {
      resources.push({
        uri: 'ui://write-confirm',
        name: 'Подтверждение записи',
        description: 'Кнопка подтверждения write: без неё MRTR ничего не записывает',
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          ui: {
            prefersBorder: true
          }
        }
      });
    }
    return c.json({
      jsonrpc: '2.0',
      id,
      result: { resources }
    });
  }

  if (method === 'resources/read') {
    const uri = (typeof params?.uri === 'string' && params.uri.trim().length > 0)
      ? params.uri.trim()
      : (typeof headerName === 'string' && headerName.trim().length > 0 ? headerName.trim() : undefined);
    if (uri) {
      c.header('Mcp-Name', uri);
    }
    if (uri === 'ui://write-confirm') {
      if (!hasWriteScope) {
        return c.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32001, message: 'Insufficient permissions. "write" scope required.' }
        });
      }
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: 'ui://write-confirm',
              mimeType: 'text/html;profile=mcp-app',
              text: getWriteConfirmHtml(),
              _meta: {
                ui: {
                  prefersBorder: true
                }
              }
            }
          ]
        }
      });
    }
    if (!hasReadScope) {
      return c.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'Insufficient permissions. "read" scope required.' }
      });
    }
    if (uri === 'ui://pulse') {
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: 'ui://pulse',
              mimeType: 'text/html;profile=mcp-app',
              text: getPulseHtml(),
              _meta: {
                ui: {
                  prefersBorder: true,
                  csp: {
                    resourceDomains: ['https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net']
                  }
                }
              }
            }
          ]
        }
      });
    }
    if (uri === 'ui://analytics') {
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: 'ui://analytics',
              mimeType: 'text/html;profile=mcp-app',
              text: getAnalyticsHtml(),
              _meta: {
                ui: {
                  prefersBorder: true,
                  csp: {
                    resourceDomains: ['https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net']
                  }
                }
              }
            }
          ]
        }
      });
    }
    return c.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Resource not found: ${uri}` }
    });
  }

  if (method === 'tools/list') {
    function sanitizeJsonSchema(schema: any): any {
      if (typeof schema !== 'object' || schema === null) return schema;
      if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);

      const result: any = {};
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'type' && Array.isArray(value)) {
          const nonNullType = value.find((v: any) => v !== 'null');
          result[key] = nonNullType || 'string';
        } else {
          result[key] = sanitizeJsonSchema(value);
        }
      }
      return result;
    }

    const availableTools = TOOLS.filter((tool) => {
      if (READ_TOOLS.has(tool.name) && hasReadScope) return true;
      if (WRITE_TOOLS.has(tool.name) && hasWriteScope) return true;
      return false;
    }).map((tool) => {
      let sanitizedSchema = sanitizeJsonSchema(tool.inputSchema);
      if (WRITE_TOOLS.has(tool.name)) {
        return {
          ...tool,
          inputSchema: {
            ...sanitizedSchema,
            properties: {
              ...sanitizedSchema.properties,
              auto_confirm: {
                type: 'boolean',
                description: 'Опциональный флаг для фоновых агентов. Если true, операция выполняется сразу без запроса подтверждения (MRTR).'
              }
            }
          }
        };
      }
      return {
        ...tool,
        inputSchema: sanitizedSchema
      };
    });
    return c.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: availableTools
      }
    });
  }

  if (method === 'tools/call') {
    const name = (typeof params?.name === 'string' && params.name.trim().length > 0)
      ? params.name.trim()
      : (typeof headerName === 'string' && headerName.trim().length > 0 ? headerName.trim() : '');
    const args = (params?.arguments && typeof params.arguments === 'object') ? params.arguments : {};
    if (name) {
      c.header('Mcp-Name', name);
    }

    const toolDef = TOOLS.find((t) => t.name === name);
    if (!toolDef) {
      await recordToolAudit(c.env.DB, clientId, name || '(unknown)', 'error', `Tool not found: ${name}`);
      return c.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Tool not found: ${name}` }
      });
    }

    if (READ_TOOLS.has(name)) {
      if (!hasReadScope) {
        await recordToolAudit(c.env.DB, clientId, name, 'error', 'Insufficient permissions. "read" scope required.');
        return c.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32001, message: 'Insufficient permissions. "read" scope required.' }
        });
      }

      let path = '';
      let httpMethod = 'GET';
      let reqBody: any = undefined;
      const reqUrl = new URL(c.req.url);

      switch (name) {
        case 'accounts_list':
          path = '/accounts';
          break;
        case 'fx_rates_list':
          path = '/fx-rates';
          break;
        case 'planned_items_list':
          path = '/planned-items';
          break;
        case 'recurring_items_list':
          path = '/recurring-items';
          break;
        case 'recurring_fulfillments_list':
          path = '/recurring-fulfillments';
          if (args.recurring_item_id !== undefined) path += `?recurring_item_id=${args.recurring_item_id}`;
          break;
        case 'operations_list':
          path = '/operations';
          break;
        case 'forecast_get':
          path = '/forecast';
          if (args.days !== undefined) {
            path += `?days=${args.days}`;
          }
          break;
        case 'analytics_get':
          path = '/analytics';
          httpMethod = 'POST';
          reqBody = JSON.stringify(args || {});
          break;
      }

      const subHeaders = new Headers(c.req.raw.headers);
      if (httpMethod === 'POST') {
        subHeaders.set('content-type', 'application/json');
      }

      const subReq = new Request(new URL(path, reqUrl.origin).toString(), {
        method: httpMethod,
        headers: subHeaders,
        body: reqBody
      });

      try {
        const response = await apiV2.fetch(subReq, c.env, { ...(c.executionCtx as any), isInternalMcp: true });
        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json();
        await recordToolAudit(c.env.DB, clientId, name, 'success', summarizeToolResult(data));

        return c.json({
          jsonrpc: '2.0',
          id,
          result: callToolResult({
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data as Record<string, unknown>
          })
        });
      } catch (error: any) {
        const errMsg = `Error executing tool: ${error.message}`;
        await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: errMsg
              }
            ],
            isError: true,
            structuredContent: { error: errMsg }
          }
        });
      }
    }

    if (WRITE_TOOLS.has(name)) {
      if (!hasWriteScope) {
        await recordToolAudit(c.env.DB, clientId, name, 'error', 'Insufficient permissions. "write" scope required.');
        return c.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32001, message: 'Insufficient permissions. "write" scope required.' }
        });
      }

      const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
      if (!idempotencyKey) {
        const errMsg = 'Error executing tool: Поле idempotency_key обязательно для всех операций записи';
        await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: errMsg
              }
            ],
            isError: true,
            structuredContent: { error: errMsg }
          }
        });
      }

      // Проверка MRTR (подтверждения)
      const requestStateStr = params?.requestState || args?.requestState;
      const {
        auto_confirm: _fingerprintAutoConfirm,
        requestState: _fingerprintRequestState,
        ...fingerprintArgs
      } = args as Record<string, unknown>;
      const incomingArgumentFingerprint = await writeArgumentFingerprint(fingerprintArgs);

      // A completed key is replayed before issuing another confirmation. The
      // later atomic claim remains the one-winner guard for concurrent confirms.
      if (!requestStateStr) {
        const existing = await findWriteExecution(c.env.DB, clientId, idempotencyKey);
        if (existing) {
          if (existing.toolName !== name) {
            const errMsg = `Error executing tool: idempotency_key уже использован инструментом ${existing.toolName}`;
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          if (existing.status === 'success' && existing.resultSummary) {
            if (storedWriteFingerprint(existing.resultSummary) !== incomingArgumentFingerprint) {
              return idempotencyArgumentConflictResult(id);
            }
            return writeReplayResult(id, existing.resultSummary);
          }
          if (existing.status === 'pending' && existing.resultSummary?.startsWith('UNCERTAIN:')) {
            const errMsg = 'Error executing tool: предыдущая запись могла выполниться, но provider read-back не завершился; повторная мутация заблокирована до сверки провайдера';
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          if (existing.status === 'pending') {
            const existingFingerprint = storedWriteFingerprint(existing.resultSummary);
            if (existingFingerprint && existingFingerprint !== incomingArgumentFingerprint) {
              return idempotencyArgumentConflictResult(id);
            }
            const fresh = writeClaimIsFresh(existing.createdAt);
            if (!fresh) {
              await markWriteExecutionUncertain(c.env.DB, clientId, idempotencyKey, 'execution lease expired before durable provider result');
            }
            const errMsg = fresh
              ? 'Error executing tool: операция с этим idempotency_key уже выполняется; повторите запрос позже'
              : 'Error executing tool: срок claim истёк без надёжного результата; повторная мутация заблокирована до ручной сверки провайдера';
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
        }
      }

      let state: any = null;

      if (!requestStateStr) {
        // Шаг 1: Валидация аргументов и запрос подтверждения (MRTR)
        if ('auto_confirm' in args && typeof args.auto_confirm !== 'boolean') {
          const errMsg = 'Error executing tool: auto_confirm должен быть boolean';
          await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
          return c.json({
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: errMsg }],
              isError: true,
              structuredContent: { error: errMsg },
            },
          });
        }
        // auto_confirm is an execution control advertised uniformly for write
        // tools. Domain validators must see only domain arguments so the
        // control cannot be rejected as an unknown financial field or become
        // part of the signed/persisted mutation payload.
        const { auto_confirm: _ignoredAutoConfirm, ...validationArgs } = args;
        const validation = await validateWriteArgs(name, validationArgs, c.env.DB, hasReadScope);
        if (validation.error) {
          const errMsg = `Error executing tool: ${validation.error}`;
          await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: errMsg
                }
              ],
              isError: true,
              structuredContent: { error: errMsg }
            }
          });
        }

        const isAgent = clientId !== 'anonymous';
        // Позволяем агентам выполнять прямую запись (Single Round-Trip).
        // Для fx_rate_set по умолчанию разрешаем (как просил Gemini), если явно не передано auto_confirm: false (для тестов MRTR).
        const autoConfirm = args.auto_confirm === true || (name === 'fx_rate_set' && args.auto_confirm !== false);
        const shouldDirectExecute = isAgent && autoConfirm;

        if (shouldDirectExecute) {
          // Прямое выполнение (Single Round-Trip)
          state = {
            name,
            confirmedArgs: validation.confirmedArgs,
            confirmationSnapshot: validation.confirmationSnapshot,
            clientId,
            idempotency_key: idempotencyKey,
            argumentFingerprint: incomingArgumentFingerprint,
            createdAt: Date.now()
          };
        } else {
          // Двухфазный MRTR: snapshot stays server-side; token is an opaque handle.
          const confirmHandle = await storeWriteConfirmation(c.env, {
            confirmationSnapshot: validation.confirmationSnapshot ?? null,
            confirmedArgs: validation.confirmedArgs,
          });
          const stateToken = await encodeRequestState(c.env.SESSION_SECRET, {
            name,
            confirmHandle,
            clientId,
            idempotency_key: idempotencyKey,
            argumentFingerprint: incomingArgumentFingerprint,
            createdAt: Date.now()
          });

          const visibleDescription = clientWriteDescription(
            name,
            validation.description,
            hasReadScope,
            validation.confirmedArgs,
          );
          const pendingText = `${WRITE_PENDING_TEXT} ${visibleDescription}`;

          await recordToolAudit(c.env.DB, clientId, name, 'pending', pendingText);

          return c.json({
            jsonrpc: '2.0',
            id,
            result: callToolResult({
              content: [{ type: 'text', text: pendingText }],
              structuredContent: {
                resultType: 'input_required',
                written: false,
                requestState: stateToken,
                description: pendingText,
                tool: name,
                idempotency_key: idempotencyKey,
                arguments: validation.confirmedArgs
              },
              _meta: { ui: WRITE_TOOL_UI }
            })
          });
        }
      } else {
        // Шаг 2: Повторный вызов с переданным состоянием подтверждения (MRTR).
        state = await decodeRequestState(c.env.SESSION_SECRET, requestStateStr);
        if (state?.confirmHandle && typeof state.confirmHandle === 'string') {
          const stored = await loadWriteConfirmation(c.env, state.confirmHandle);
          if (stored) {
            state = {
              ...state,
              confirmedArgs: stored.confirmedArgs,
              confirmationSnapshot: stored.confirmationSnapshot,
            };
          }
        }
      }
      if (
        !state ||
        state.name !== name ||
        !state.confirmedArgs ||
        state.clientId !== clientId ||
        state.idempotency_key !== idempotencyKey ||
        typeof state.argumentFingerprint !== 'string' ||
        !state.argumentFingerprint ||
        state.confirmedArgs.idempotency_key !== state.idempotency_key
      ) {
        const errMsg = 'Error executing tool: requestState не соответствует OAuth-клиенту, idempotency_key или подтверждённым аргументам';
        await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: errMsg }],
            isError: true,
            structuredContent: { error: errMsg }
          }
        });
      }

      if (!await confirmationSnapshotStillCurrent(c.env.DB, state.confirmationSnapshot)) {
        const errMsg = 'Error executing tool: объект изменился после подтверждения; запросите новое подтверждение для актуальных денежных значений';
        await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: errMsg }],
            isError: true,
            structuredContent: { error: errMsg },
          },
        });
      }

      let claim: WriteExecutionClaim;
      try {
        claim = await claimWriteExecution(c.env.DB, clientId, name, idempotencyKey, state.argumentFingerprint);
      } catch (error: any) {
        const errMsg = `Error executing tool: ${error.message}`;
        return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
      }
      if (!claim.claimed) {
        let errMsg: string;
        if (claim.toolName !== name) {
          errMsg = `Error executing tool: idempotency_key уже использован инструментом ${claim.toolName}`;
        } else if (claim.status === 'success' && claim.resultSummary) {
          if (storedWriteFingerprint(claim.resultSummary) !== state.argumentFingerprint) {
            return idempotencyArgumentConflictResult(id);
          }
          if (!hasReadScope && !WRITE_CREATE_TOOLS.has(name)) {
            try {
              const parsed = JSON.parse(claim.resultSummary) as Record<string, unknown>;
              delete parsed[IDEMPOTENCY_FINGERPRINT_FIELD];
              return writeReplayResult(
                id,
                JSON.stringify(redactWriteOnlyMutationResult(name, parsed, state.confirmedArgs)),
              );
            } catch {
              return writeReplayResult(id, JSON.stringify(redactWriteOnlyMutationResult(name, {}, state.confirmedArgs)));
            }
          }
          return writeReplayResult(id, claim.resultSummary);
        } else if (claim.status === 'pending' && claim.resultSummary?.startsWith('UNCERTAIN:')) {
          errMsg = 'Error executing tool: предыдущая запись могла выполниться, но provider read-back не завершился; повторная мутация заблокирована до сверки провайдера';
        } else if (claim.status === 'pending') {
          const claimFingerprint = storedWriteFingerprint(claim.resultSummary);
          if (claimFingerprint && claimFingerprint !== state.argumentFingerprint) {
            return idempotencyArgumentConflictResult(id);
          }
          const fresh = writeClaimIsFresh(claim.createdAt);
          if (!fresh) {
            await markWriteExecutionUncertain(c.env.DB, clientId, idempotencyKey, 'execution lease expired before durable provider result');
          }
          errMsg = fresh
            ? 'Error executing tool: операция с этим idempotency_key уже выполняется; повторите запрос позже'
            : 'Error executing tool: срок claim истёк без надёжного результата; повторная мутация заблокирована до ручной сверки провайдера';
        } else {
          errMsg = 'Error executing tool: idempotency_key уже находится в неизвестном состоянии';
        }
        return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
      }

      const reqUrl = new URL(c.req.url);
      const subHeaders = new Headers(c.req.raw.headers);
      subHeaders.set('content-type', 'application/json');
      let subReq: Request;
      let operationDeleteSnapshot: Record<string, unknown> | null = null;
      const ledgerInvariantBefore = (
        name === 'planned_item_fulfill_existing'
        || name === 'recurring_item_fulfill_existing'
        || name === 'recurring_item_skip_period'
        || name === 'recurring_item_cancel_period_fulfillment'
      ) ? await loadLedgerInvariant(c.env.DB) : null;

      if (name === 'operation_add') {
        subReq = new Request(new URL('/operations', reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({
            ...state.confirmedArgs,
            source: 'agent'
          })
        });
      } else if (name === 'operation_update') {
        const { operation_id, idempotency_key: _ignoredIdempotencyKey, ...patchArgs } = state.confirmedArgs;
        subReq = new Request(new URL(`/operations/${operation_id}`, reqUrl.origin).toString(), {
          method: 'PATCH',
          headers: subHeaders,
          body: JSON.stringify(patchArgs)
        });
      } else if (name === 'operation_delete') {
        operationDeleteSnapshot = await loadOperationForMcp(c.env.DB, state.confirmedArgs.operation_id);
        subReq = new Request(new URL(`/operations/${state.confirmedArgs.operation_id}`, reqUrl.origin).toString(), {
          method: 'DELETE',
          headers: subHeaders
        });
      } else if (name === 'transfer_add') {
        subReq = new Request(new URL('/transfers', reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({
            ...state.confirmedArgs,
            source: 'agent'
          })
        });
      } else if (name === 'balance_correct') {
        subReq = new Request(new URL(`/accounts/${state.confirmedArgs.account_id}`, reqUrl.origin).toString(), {
          method: 'PATCH',
          headers: subHeaders,
          body: JSON.stringify({
            balance_minor: state.confirmedArgs.balance_minor
          })
        });
      } else if (name === 'planned_item_add') {
        subReq = new Request(new URL('/planned-items', reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify(state.confirmedArgs)
        });
      } else if (name === 'planned_item_update') {
        const { planned_item_id, idempotency_key: _ignoredIdempotencyKey, ...patchArgs } = state.confirmedArgs;
        subReq = new Request(new URL(`/planned-items/${planned_item_id}`, reqUrl.origin).toString(), {
          method: 'PATCH',
          headers: subHeaders,
          body: JSON.stringify({ ...patchArgs, __mcp_expected_snapshot: state.confirmationSnapshot })
        });
      } else if (name === 'planned_item_fulfill_existing') {
        subReq = new Request(new URL(`/planned-items/${state.confirmedArgs.planned_item_id}/fulfill-existing`, reqUrl.origin).toString(), {
          method: 'POST', headers: subHeaders,
          body: JSON.stringify({
            operation_id: state.confirmedArgs.operation_id,
            __mcp_expected_snapshot: state.confirmationSnapshot,
          }),
        });
      } else if (name === 'planned_item_delete') {
        subReq = new Request(new URL(`/planned-items/${state.confirmedArgs.planned_item_id}`, reqUrl.origin).toString(), {
          method: 'DELETE', headers: subHeaders,
          body: JSON.stringify({ __mcp_expected_snapshot: state.confirmationSnapshot }),
        });
      } else if (name === 'recurring_item_add') {
        const { idempotency_key: _ignoredIdempotencyKey, ...createArgs } = state.confirmedArgs;
        subReq = new Request(new URL('/recurring-items', reqUrl.origin).toString(), {
          method: 'POST', headers: subHeaders, body: JSON.stringify(createArgs)
        });
      } else if (name === 'recurring_item_update') {
        const { recurring_item_id, idempotency_key: _ignoredIdempotencyKey, ...patchArgs } = state.confirmedArgs;
        subReq = new Request(new URL(`/recurring-items/${recurring_item_id}`, reqUrl.origin).toString(), {
          method: 'PATCH', headers: subHeaders,
          body: JSON.stringify({ ...patchArgs, __mcp_expected_snapshot: state.confirmationSnapshot })
        });
      } else if (name === 'recurring_item_delete') {
        subReq = new Request(new URL(`/recurring-items/${state.confirmedArgs.recurring_item_id}`, reqUrl.origin).toString(), {
          method: 'DELETE', headers: subHeaders,
          body: JSON.stringify({ __mcp_expected_snapshot: state.confirmationSnapshot })
        });
      } else if (name === 'recurring_item_close_period') {
        const { recurring_item_id, idempotency_key: _ignoredIdempotencyKey, ...closeArgs } = state.confirmedArgs;
        subReq = new Request(new URL(`/recurring-items/${recurring_item_id}/close-period`, reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({ ...closeArgs, __mcp_expected_snapshot: state.confirmationSnapshot })
        });
      } else if (name === 'recurring_item_fulfill_existing') {
        subReq = new Request(new URL(`/recurring-items/${state.confirmedArgs.recurring_item_id}/fulfill-existing`, reqUrl.origin).toString(), {
          method: 'POST', headers: subHeaders,
          body: JSON.stringify({
            period_due_date: state.confirmedArgs.period_due_date,
            operation_ids: state.confirmedArgs.operation_ids,
            evidence_quantity: state.confirmedArgs.evidence_quantity,
            __mcp_expected_snapshot: state.confirmationSnapshot,
          }),
        });
      } else if (name === 'recurring_item_skip_period') {
        subReq = new Request(new URL(`/recurring-items/${state.confirmedArgs.recurring_item_id}/skip-period`, reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({ __mcp_expected_snapshot: state.confirmationSnapshot })
        });
      } else if (name === 'recurring_item_cancel_period_fulfillment') {
        subReq = new Request(new URL(`/recurring-items/${state.confirmedArgs.recurring_item_id}/cancel-period-fulfillment`, reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({
            period_due_date: state.confirmedArgs.period_due_date,
            __mcp_expected_snapshot: state.confirmationSnapshot,
          }),
        });
      } else if (name === 'fx_rate_set') {
        subReq = new Request(new URL(`/fx-rates/${state.confirmedArgs.code}`, reqUrl.origin).toString(), {
          method: 'PUT',
          headers: subHeaders,
          body: JSON.stringify({ rate: state.confirmedArgs.rate })
        });
      } else if (name === 'fx_rate_delete') {
        subReq = new Request(new URL(`/fx-rates/${state.confirmedArgs.code}`, reqUrl.origin).toString(), {
          method: 'DELETE',
          headers: subHeaders
        });
      } else if (name === 'data_reset') {
        subReq = new Request(new URL('/data/reset', reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({ confirm: true, phrase: RESET_CONFIRM_PHRASE }),
        });
      } else {
        return c.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Tool not found: ${name}` }
        });
      }

      let mutationStarted = false;
      try {
        mutationStarted = true;
        const response = await apiV2.fetch(subReq, c.env, { ...(c.executionCtx as any), isInternalMcp: true });
        if (!response.ok) {
          const errText = await response.text();
          if (response.status >= 500) {
            // The provider may have applied a mutation before a server failure.
            // Preserve the keyed claim to make an automatic replay impossible.
            await markWriteExecutionUncertain(c.env.DB, clientId, idempotencyKey, `API ${response.status}: ${errText}`);
          } else {
            // The domain API rejects validation/not-found errors before mutation.
            await releaseFailedWriteExecution(c.env.DB, clientId, idempotencyKey);
          }
          await recordToolAudit(c.env.DB, clientId, name, 'error', errText);

          const errMsg = `Error executing tool: ${errText}`;
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: errMsg
                }
              ],
              isError: true,
              structuredContent: { error: errMsg }
            }
          });
        }

        // DELETE /fx-rates/:code отвечает 204 без тела (контракт api.ts).
        // response.json() на пустом теле бросает исключение — клиент видел бы
        // isError, хотя курс уже удалён (#327). У 204 тела нет по определению.
        const mutationData: Record<string, any> =
          response.status === 204 ? {} : ((await response.json()) as Record<string, any>);

        // MCP не объявляет mutation response источником истины. Для новых
        // planning writes сначала читаем провайдера через тот же apiV2, а уже
        // затем фиксируем audit success и отвечаем агенту.
        const providerGet = async (path: string): Promise<Record<string, any>> => {
          const readResponse = await apiV2.fetch(
            new Request(new URL(path, reqUrl.origin).toString(), { headers: subHeaders }),
            c.env,
            { ...(c.executionCtx as any), isInternalMcp: true },
          );
          if (!readResponse.ok) throw new Error(`Provider read-back failed: ${readResponse.status} ${await readResponse.text()}`);
          return readResponse.json() as Promise<Record<string, any>>;
        };
        const verifyLedgerInvariant = async (): Promise<{ operation_count_unchanged: true; balance_unchanged: true }> => {
          if (!ledgerInvariantBefore) throw new Error('Provider read-back failed: missing pre-write ledger invariant');
          const after = await loadLedgerInvariant(c.env.DB);
          if (!after || after.operation_count !== ledgerInvariantBefore.operation_count) {
            throw new Error('Provider read-back failed: fulfillment changed operation count');
          }
          if (JSON.stringify(after.balances) !== JSON.stringify(ledgerInvariantBefore.balances)) {
            throw new Error('Provider read-back failed: fulfillment changed account balance');
          }
          return { operation_count_unchanged: true, balance_unchanged: true };
        };

        let data: Record<string, any> = mutationData;
        if (name === 'recurring_item_add' || name === 'recurring_item_update' || name === 'recurring_item_skip_period') {
          const recurringItemId = name === 'recurring_item_add'
            ? mutationData.recurring_item?.id
            : state.confirmedArgs.recurring_item_id;
          const listed = await providerGet('/recurring-items');
          const recurringItem = listed.recurring_items?.find((item: any) => item.id === recurringItemId);
          if (!recurringItem) throw new Error(`Provider read-back failed: recurring item ${recurringItemId} not found`);
          if (name === 'recurring_item_skip_period') {
            const expected = expectedRecurringAdvance(state.confirmationSnapshot);
            if (
              !expected
              || recurringItem.next_due_date !== expected.nextDueDate
              || recurringItem.active !== expected.active
            ) {
              throw new Error(`Provider read-back failed: recurring period ${state.confirmationSnapshot?.next_due_date} did not advance exactly once`);
            }
            const history = await providerGet(`/recurring-fulfillments?recurring_item_id=${recurringItemId}`);
            const fulfillment = history.recurring_fulfillments?.find(
              (item: any) => item.period_due_date === state.confirmationSnapshot?.next_due_date && item.outcome === 'skipped',
            );
            if (!fulfillment) throw new Error('Provider read-back failed: skipped occurrence history is missing');
            data = { recurring_item: recurringItem, fulfillment, ...(await verifyLedgerInvariant()) };
          } else {
            data = { recurring_item: recurringItem };
          }
        } else if (name === 'recurring_item_delete') {
          const recurringItemId = state.confirmedArgs.recurring_item_id;
          const listed = await providerGet('/recurring-items');
          if (listed.recurring_items?.some((item: any) => item.id === recurringItemId)) {
            throw new Error(`Provider read-back failed: recurring item ${recurringItemId} still exists`);
          }
          data = { success: true, recurring_item_id: recurringItemId };
        } else if (name === 'planned_item_fulfill_existing') {
          const [plannedItems, operations] = await Promise.all([
            providerGet('/planned-items'), providerGet('/operations'),
          ]);
          const plannedItem = plannedItems.planned_items?.find((item: any) => item.id === state.confirmedArgs.planned_item_id);
          const operation = operations.operations?.find((item: any) => item.id === state.confirmedArgs.operation_id);
          if (
            !plannedItem || plannedItem.done !== true
            || plannedItem.fulfillment?.type !== 'linked'
            || plannedItem.fulfillment?.operation_id !== state.confirmedArgs.operation_id
            || !operation
            || operation.fulfillment?.planned_item_id !== state.confirmedArgs.planned_item_id
          ) {
            throw new Error('Provider read-back failed: planned existing-operation fulfillment is incomplete');
          }
          data = {
            status: mutationData.status,
            planned_item: plannedItem,
            operation,
            ...(await verifyLedgerInvariant()),
          };
        } else if (name === 'planned_item_update') {
          const plannedItemId = state.confirmedArgs.planned_item_id;
          const listed = await providerGet('/planned-items');
          const plannedItem = listed.planned_items?.find((item: any) => item.id === plannedItemId);
          if (!plannedItem) throw new Error(`Provider read-back failed: planned item ${plannedItemId} not found`);
          if ('done' in state.confirmedArgs) {
            const operations = await providerGet('/operations');
            const operation = operations.operations?.find((item: any) => item.planned_item_id === plannedItemId);
            if (state.confirmedArgs.done === true && state.confirmationSnapshot?.done === 0) {
              if (
                plannedItem.done !== true ||
                !operation ||
                operation.source !== 'planned' ||
                operation.amount_minor !== plannedItem.amount_minor ||
                operation.account_id !== plannedItem.account_id ||
                operation.date !== plannedItem.date ||
                operation.item !== plannedItem.title ||
                operation.category !== plannedItem.category
              ) {
                throw new Error(`Provider read-back failed: planned item ${plannedItemId} was not materialized atomically`);
              }
              data = { planned_item: plannedItem, operation };
            } else if (state.confirmedArgs.done === true) {
              if (plannedItem.done !== true) {
                throw new Error(`Provider read-back failed: planned item ${plannedItemId} is not done`);
              }
              // A fact linked to an already-done plan is an independent record:
              // editing/reconfirming the plan must not require that historical
              // operation to mirror the plan's current descriptive fields.
              data = { planned_item: plannedItem };
            } else {
              if (plannedItem.done !== false || operation) {
                throw new Error(`Provider read-back failed: planned item ${plannedItemId} was not reopened atomically`);
              }
              data = { planned_item: plannedItem };
            }
          } else {
            data = { planned_item: plannedItem };
          }
        } else if (name === 'planned_item_delete') {
          const plannedItemId = state.confirmedArgs.planned_item_id;
          const listed = await providerGet('/planned-items');
          if (listed.planned_items?.some((item: any) => item.id === plannedItemId)) {
            throw new Error(`Provider read-back failed: planned item ${plannedItemId} still exists`);
          }
          data = { success: true, planned_item_id: plannedItemId };
        } else if (name === 'recurring_item_fulfill_existing') {
          const recurringItemId = state.confirmedArgs.recurring_item_id;
          const [recurringItems, history, operations] = await Promise.all([
            providerGet('/recurring-items'),
            providerGet(`/recurring-fulfillments?recurring_item_id=${recurringItemId}`),
            providerGet('/operations'),
          ]);
          const recurringItem = recurringItems.recurring_items?.find((item: any) => item.id === recurringItemId);
          const fulfillment = history.recurring_fulfillments?.find(
            (item: any) => item.period_due_date === state.confirmedArgs.period_due_date,
          );
          const expectedIds = [...state.confirmedArgs.operation_ids].sort((a: number, b: number) => a - b);
          const actualIds = [...(fulfillment?.operation_ids ?? [])].sort((a: number, b: number) => a - b);
          const linkedOperations = operations.operations?.filter((item: any) => expectedIds.includes(item.id)) ?? [];
          const expected = expectedRecurringAdvance(state.confirmationSnapshot);
          if (
            !recurringItem || !fulfillment || fulfillment.outcome !== 'linked'
            || fulfillment.evidence_quantity !== state.confirmedArgs.evidence_quantity
            || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
            || linkedOperations.length !== expectedIds.length
            || !expected
            || recurringItem.next_due_date !== expected.nextDueDate
            || recurringItem.active !== expected.active
            || linkedOperations.some((item: any) =>
              item.fulfillment?.recurring_item_id !== recurringItemId
              || item.fulfillment?.period_due_date !== state.confirmedArgs.period_due_date
            )
          ) {
            throw new Error('Provider read-back failed: recurring existing-operation fulfillment is incomplete');
          }
          data = {
            status: mutationData.status,
            evidence_quantity: state.confirmedArgs.evidence_quantity,
            recurring_item: recurringItem,
            fulfillment,
            operations: linkedOperations,
            ...(await verifyLedgerInvariant()),
          };
        } else if (name === 'recurring_item_close_period') {
          const [recurringItems, operations] = await Promise.all([providerGet('/recurring-items'), providerGet('/operations')]);
          const recurringItem = recurringItems.recurring_items?.find((item: any) => item.id === state.confirmedArgs.recurring_item_id);
          const operationId = mutationData.operation?.id;
          const operation = operations.operations?.find((item: any) => item.id === operationId);
          const expected = expectedRecurringAdvance(state.confirmationSnapshot);
          if (
            !recurringItem ||
            !operation ||
            !expected ||
            recurringItem.next_due_date !== expected.nextDueDate ||
            recurringItem.active !== expected.active ||
            operation.source !== 'recurring' ||
            operation.recurring_item_id !== state.confirmedArgs.recurring_item_id ||
            operation.date !== state.confirmedArgs.date ||
            operation.amount_minor !== state.confirmedArgs.amount_minor ||
            operation.account_id !== state.confirmedArgs.account_id ||
            operation.item !== state.confirmedArgs.item ||
            operation.category !== state.confirmedArgs.category ||
            operation.subcategory !== state.confirmedArgs.subcategory
          ) {
            throw new Error('Provider read-back failed: closed recurring period does not match the confirmed fact');
          }
          data = { recurring_item: recurringItem, operation };
        } else if (name === 'recurring_item_cancel_period_fulfillment') {
          const recurringItemId = state.confirmedArgs.recurring_item_id;
          const periodDueDate = state.confirmedArgs.period_due_date;
          const [recurringItems, history, operations] = await Promise.all([
            providerGet('/recurring-items'),
            providerGet(`/recurring-fulfillments?recurring_item_id=${recurringItemId}`),
            providerGet('/operations'),
          ]);
          const recurringItem = recurringItems.recurring_items?.find((item: any) => item.id === recurringItemId);
          const stillPresent = history.recurring_fulfillments?.some(
            (item: any) => item.period_due_date === periodDueDate,
          );
          const laterExists = history.recurring_fulfillments?.some(
            (item: any) => item.period_due_date > periodDueDate,
          );
          const canceledIds = [...(mutationData.canceled?.operation_ids ?? [])];
          const leftoverOps = operations.operations?.filter((item: any) => canceledIds.includes(item.id)) ?? [];
          const expectedRewind = expectedRecurringRewind(state.confirmationSnapshot, periodDueDate);
          if (
            !recurringItem
            || stillPresent
            || leftoverOps.length !== canceledIds.length
            || leftoverOps.some((item: any) => item.fulfillment?.recurring_item_id)
            || (!laterExists && expectedRewind && (
              recurringItem.next_due_date !== expectedRewind.nextDueDate
              || recurringItem.active !== expectedRewind.active
            ))
          ) {
            throw new Error('Provider read-back failed: recurring period fulfillment was not canceled');
          }
          data = {
            recurring_item: recurringItem,
            canceled: mutationData.canceled,
            ...(await verifyLedgerInvariant()),
          };
        }

        // fx_rate_delete по outputSchema отвечает { success: true, ...WRITE_OUTPUT_COMMON };
        // у 204 тела нет, поэтому success доливаем явно, не трогая контракт API.
        let written: Record<string, unknown> =
          name === 'fx_rate_delete'
            ? { ...data, success: true, written: true, resultType: 'complete' }
            : name === 'data_reset'
              ? { ...data, success: true, reset: true, written: true, resultType: 'complete' }
            : name === 'operation_delete'
              ? {
                  ...data,
                  success: true,
                  operation_id: state.confirmedArgs.operation_id,
                  deleted_operation: operationDeleteSnapshot,
                  written: true,
                  resultType: 'complete'
                }
              : { ...data, written: true, resultType: 'complete' };
        if (!hasReadScope && !WRITE_CREATE_TOOLS.has(name)) {
          written = redactWriteOnlyMutationResult(name, written, state.confirmedArgs);
        }
        const summary = JSON.stringify(written);

        await finalizeWriteExecution(c.env.DB, clientId, idempotencyKey, summary, state.argumentFingerprint);
        if (typeof state.confirmHandle === 'string') {
          await consumeWriteConfirmation(c.env, state.confirmHandle);
        }

        return c.json({
          jsonrpc: '2.0',
          id,
          result: callToolResult({
            content: [{ type: 'text', text: summary }],
            structuredContent: written
          })
        });
      } catch (error: any) {
        // Once a provider mutation has been attempted, a network/read-back
        // failure cannot prove that nothing changed. Retain an explicit
        // non-replayable state rather than issuing the mutation again.
        try {
          if (mutationStarted) {
            await markWriteExecutionUncertain(c.env.DB, clientId, idempotencyKey, error.message);
          } else {
            await releaseFailedWriteExecution(c.env.DB, clientId, idempotencyKey);
          }
        } catch {
          // A durable pending claim is also fail-closed: it prevents replay.
        }

        const errMsg = `Error executing tool: ${error.message}`;
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: errMsg
              }
            ],
            isError: true,
            structuredContent: { error: errMsg }
          }
        });
      }
    }
  }

  return c.json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
});

export default mcpApp;
