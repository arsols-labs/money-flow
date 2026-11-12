import { Hono } from 'hono';
import type { Env } from './types';
import apiV2, { countAccountRefs } from './api';
import { listAliases } from './account-aliases';
import { clipAuditSummary, pruneMcpAuditLog, recordMcpAuditLog } from './api-mcp';
import { BodyTooLargeError, MCP_MAX_JSON_BYTES, readLimitedText } from './limited-body';
import { getPulseHtml } from './mcp-pulse-ui';
import { getAnalyticsHtml } from './mcp-analytics-ui';
import { getWriteConfirmHtml } from './mcp-write-confirm-ui';
import { nextOccurrence, type RecurringRule } from './forecast/recurrence';
import { parseHttpUrl, RECEIPT_URL_MAX_LENGTH } from '../shared/http-url';
import { FISCAL_RECEIPT_ID_MAX_LENGTH, canonicalizePfr } from '../shared/fiscal-receipts';
import { isAnalyticalSkipOnlyRecurringId } from '../shared/booking-guards';
import { RESET_CONFIRM_PHRASE, USER_TABLES, backupOmitsOrderGroupings, countOrderGroupings, parseBackupDocument } from './backup';
import { STATEMENT_IMPORT_MCP_JSON_MAX_BYTES } from '../shared/statement-import/types';
import {
  STATEMENT_INLINE_TOOLS,
  STATEMENT_MUTATION_TOOLS,
  STATEMENT_NO_AUTO_CONFIRM,
  STATEMENT_READ_TOOL_NAMES,
  STATEMENT_WRITE_TOOL_NAMES,
  consumePreparedUploads,
  createStatementUploadForMcp,
  executeStatementMutation,
  prepareStatementImport,
  readStatementTemplateTool,
  statementMcpToolDefinitions,
  statementPreviewIdempotencyKey,
  templateUpdateAutoConfirmDecision,
  validateStatementWrite,
} from './mcp-statement';
import { ValidationError } from './api-error';
import { apiErrorBody } from '../shared/api-errors';
import { PURCHASE_ORDERS_EPOCH_KEY } from '../shared/purchase-orders';
import {
  PURCHASE_NO_AUTO_CONFIRM,
  PURCHASE_READ_TOOLS,
  PURCHASE_WRITE_TOOLS,
  purchaseOrderToolDefinitions,
  purchaseOrderWriteRequest,
  validatePurchaseOrderWrite,
} from './mcp-purchase-orders';
import {
  RECEIPT_GROUP_NO_AUTO_CONFIRM,
  RECEIPT_GROUP_READ_TOOLS,
  RECEIPT_GROUP_WRITE_TOOLS,
  receiptGroupToolDefinitions,
  receiptGroupWriteRequest,
  validateReceiptGroupWrite,
} from './mcp-receipt-groups';

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
  'account_aliases_list',
  'account_resolve',
  'pending_accounts_list',
  'settings_get',
  'backup_export',
  ...STATEMENT_READ_TOOL_NAMES,
  ...PURCHASE_READ_TOOLS,
  ...RECEIPT_GROUP_READ_TOOLS,
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
  'account_add',
  'account_update',
  'account_delete',
  'account_alias_add',
  'account_alias_delete',
  'pending_account_bind',
  'transfer_update',
  'transfer_delete',
  'setting_set',
  'backup_import',
  ...STATEMENT_WRITE_TOOL_NAMES,
  ...PURCHASE_WRITE_TOOLS,
  ...RECEIPT_GROUP_WRITE_TOOLS,
]);

/**
 * Tools that always need a human confirmation: auto_confirm is refused.
 * Every delete tool, data_reset, and backup_import. setting_set is separate
 * and refuses auto_confirm only for NO_AUTO_CONFIRM_SETTING_KEYS.
 */
const NO_AUTO_CONFIRM_TOOL_NAMES = [
  'account_delete',
  'account_alias_delete',
  'transfer_delete',
  'backup_import',
  'operation_delete',
  'planned_item_delete',
  'recurring_item_delete',
  'fx_rate_delete',
  'data_reset',
  ...STATEMENT_NO_AUTO_CONFIRM,
  ...PURCHASE_NO_AUTO_CONFIRM,
  ...RECEIPT_GROUP_NO_AUTO_CONFIRM,
] as const;
const NO_AUTO_CONFIRM_TOOLS = new Set<string>(NO_AUTO_CONFIRM_TOOL_NAMES);

/** auto_confirm is refused for these setting keys: a change recalculates every conversion and report. */
const NO_AUTO_CONFIRM_SETTING_KEYS = new Set(['base_currency']);

/** Exact refusal catalog. Tool descriptions and docs must keep this list. */
const NO_AUTO_CONFIRM_DESCRIPTION =
  `auto_confirm is not accepted for ${NO_AUTO_CONFIRM_TOOL_NAMES.join(', ')}, and for setting_set when the key is base_currency; a human confirmation is always required. `;

/** Keys accepted by PUT /api/v2/settings/:key (kept in sync with SETTINGS_WRITABLE_KEYS in api.ts). */
const SETTING_SET_KEYS = ['base_currency', 'low_balance_threshold_minor'] as const;

/** Maximum size (UTF-8 bytes of the JSON document) that backup_export returns inline: 512 KiB. */
export const BACKUP_EXPORT_MAX_BYTES = 512 * 1024;

/** Phrase that backup_import requires, the same pattern as RESET for data_reset. */
export const IMPORT_CONFIRM_PHRASE = 'IMPORT';

function backupTableCounts(tables: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of USER_TABLES) {
    const rows = (tables as Record<string, unknown>)[name];
    counts[name] = Array.isArray(rows) ? rows.length : 0;
  }
  return counts;
}

function capBackupExport(document: any): Record<string, unknown> {
  const sizeBytes = new TextEncoder().encode(JSON.stringify(document)).length;
  if (sizeBytes <= BACKUP_EXPORT_MAX_BYTES) return { truncated: false, size_bytes: sizeBytes, backup: document };
  return {
    truncated: true,
    size_bytes: sizeBytes,
    cap_bytes: BACKUP_EXPORT_MAX_BYTES,
    format: document?.format,
    version: document?.version,
    exported_at: document?.exported_at,
    counts: backupTableCounts(document?.tables ?? {}),
    ...(document?.omitted ? { omitted: document.omitted, warning: document.warning } : {}),
    message: `The backup is ${sizeBytes} bytes, above the MCP inline cap of ${BACKUP_EXPORT_MAX_BYTES} bytes, so only table and row counts are returned. Download the full JSON with Export backup in the Money Flow app settings (GET /api/v2/backup/export in a signed-in session).`,
  };
}

const TRANSFER_UPDATE_FIELDS = ['date', 'from_account_id', 'to_account_id', 'from_amount_minor', 'to_amount_minor', 'item', 'store', 'category', 'subcategory', 'comment', 'receipt_url', 'fiscal_receipt_id'] as const;

type TransferLeg = { id: number; kind: string; date: string; account_id: number; account_name: string; amount_minor: number; currency: string };

async function loadTransferLegs(db: D1Database, transferId: number): Promise<TransferLeg[]> {
  const rows = await db.prepare(
    `SELECT o.id, o.kind, o.date, o.account_id, a.name AS account_name, o.amount_minor, a.currency
       FROM operations o JOIN accounts a ON a.id = o.account_id
      WHERE o.transfer_id = ? ORDER BY CASE o.kind WHEN 'transfer_out' THEN 0 ELSE 1 END`,
  ).bind(transferId).all<TransferLeg>();
  return rows.results ?? [];
}

function describeTransferLegs(legs: TransferLeg[]): string {
  return legs.map((leg) => `${leg.kind === 'transfer_out' ? 'out' : 'in'} leg operation ID ${leg.id}: ${leg.amount_minor} ${leg.currency} on account ID ${leg.account_id} "${leg.account_name}", date ${leg.date}`).join('; ');
}

const ACCOUNT_UPDATE_FIELDS = ['name', 'bank', 'type', 'account_number', 'owner', 'country', 'currency', 'balance_minor', 'sort', 'archived'] as const;
const ACCOUNT_ADD_FIELDS = ['name', 'currency', 'owner', 'country', 'bank', 'type', 'account_number', 'balance_minor', 'sort'] as const;

function accountInUseMessage(accountId: number, refs: number): string {
  return `Account ID ${accountId} is referenced by ${refs} operation(s), planned item(s) or recurring rule(s) and cannot be deleted. Move or delete those operations first, or archive the account with account_update (archived: true).`;
}

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
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string or null` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function optionalHttpUrlValue(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const parsed = optionalTextValue(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return parsed;
  if (parsed.value.length > RECEIPT_URL_MAX_LENGTH || parseHttpUrl(parsed.value) === null) {
    return { ok: false, error: `${field} must be an http(s) URL no longer than ${RECEIPT_URL_MAX_LENGTH} characters` };
  }
  return parsed;
}

function optionalFiscalReceiptIdValue(value: unknown, field = 'fiscal_receipt_id'): { ok: true; value: string | null } | { ok: false; error: string } {
  const parsed = optionalTextValue(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return parsed;
  if (parsed.value.length > FISCAL_RECEIPT_ID_MAX_LENGTH) {
    return { ok: false, error: `${field} must be no longer than ${FISCAL_RECEIPT_ID_MAX_LENGTH} characters (PFR / fiscal id, do not put it in item)` };
  }
  return parsed;
}

function requiredTextValue(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: `${field} cannot be empty` };
  }
  return { ok: true, value: value.trim() };
}

function signMatchesKind(kind: string, amountMinor: number): string | null {
  if ((kind === 'expense' || kind === 'transfer_out') && amountMinor > 0) {
    return `${kind === 'expense' ? 'An expense' : 'A transfer debit'} decreases the balance — amount_minor must be negative`;
  }
  if (kind !== 'expense' && kind !== 'transfer_out' && amountMinor < 0) {
    return `${kind === 'income' ? 'Income' : kind === 'refund' ? 'A refund' : 'A transfer credit'} increases the balance — amount_minor must be positive`;
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
  ' The first call without requestState writes nothing: structuredContent has resultType=input_required and written=false. Do not report success to the user until a repeated call with requestState returns written=true. The exact domain effect after confirmation is stated in each tool description.';

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
    // the log must not take down tools/call
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
  const error = 'Error executing tool: idempotency_key was already used with different arguments or has no verifiable argument binding';
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
  'WRITE NOT PERFORMED. This is a confirmation request, not a fact. Do not tell the user the data has been written. Repeat the same tools/call with the requestState field from this response.';

const REQUEST_STATE_DESCRIPTION =
  'Token from the input_required response. Without it the tool writes nothing. Pass it to confirm the write.';

const WRITE_OUTPUT_COMMON = {
  resultType: { type: 'string', description: 'input_required — not written yet; complete — write performed' },
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
    description: 'List all accounts. Returns balance, currency, archive status and sort order.',
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
    description: 'Get saved exchange rates.',
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
    description: 'Get planned items.',
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
    description: 'Get recurring items.',
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
    description: 'Get the durable history of materialized, linked and skipped periods of recurring rules.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { recurring_item_id: { type: 'number', description: 'Optional recurring rule ID' } },
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
    description: 'Get the history of completed operations and spending.',
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
    description: 'Get the forecast of account balances and cash flow.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Forecast horizon in days. If omitted, the user default setting is used.',
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
    description: 'Get analytics data: expenses, income, spending trend and breakdowns by category/store.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Period start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'Period end date (YYYY-MM-DD)' },
        cats: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Filter by categories' },
        merchants: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Filter by stores' },
        accounts: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Filter by accounts' },
        currencies: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 32, description: 'Filter by currencies' },
        q: { type: 'string', maxLength: 200, description: 'Search query' }
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
    description: 'Add an operation (expense, income or refund). Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Operation date in YYYY-MM-DD format' },
        account_id: { type: 'number', description: 'Account ID' },
        kind: { type: 'string', enum: ['expense', 'income', 'refund'], description: 'Operation kind' },
        item: { type: 'string', description: 'Name or description of the goods/service' },
        amount_minor: { type: 'number', description: 'Amount in minor units (negative for expense, positive for income/refund)' },
        category: { type: 'string', description: 'Category (optional)' },
        subcategory: { type: 'string', description: 'Subcategory (optional, only when a category is set)' },
        store: { type: 'string', description: 'Store or counterparty (optional)' },
        comment: { type: 'string', description: 'Free-form comment on the operation (optional)' },
        receipt_url: { type: 'string', description: 'Fiscal/verification receipt URL (http/https, optional). Put PURS/TaxCore QR links here instead of the item field.' },
        fiscal_receipt_id: { type: 'string', description: 'PFR receipt number / TaxCore PFR — stable id of the fiscal document. Put it here, not in item or comment. Empty = non-fiscal operation.' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Partially update an existing operation by operation_id. Requires scope "write" and confirmation (MRTR); wraps the standard PATCH /operations/:id and keeps its domain invariants.' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'number', description: 'ID of the operation to change' },
        date: { type: 'string', description: 'New operation date YYYY-MM-DD (optional)' },
        account_id: { type: 'number', description: 'New account ID (optional; amount_minor is required when the currency changes)' },
        kind: { type: 'string', enum: ['expense', 'income', 'refund', 'transfer_out', 'transfer_in'], description: 'New operation kind (optional)' },
        store: { type: ['string', 'null'], description: 'Store/counterparty; null clears the field' },
        item: { type: 'string', description: 'Name or description of the goods/service (optional, non-empty string)' },
        category: { type: ['string', 'null'], description: 'Category; null clears the field' },
        subcategory: { type: ['string', 'null'], description: 'Subcategory; null clears the field, a non-empty subcategory requires category' },
        amount_minor: { type: 'number', description: 'New amount in minor units; the sign must match kind' },
        comment: { type: ['string', 'null'], description: 'Free-form comment; null clears the field' },
        receipt_url: { type: ['string', 'null'], description: 'Fiscal/verification receipt URL (http/https); null clears the field' },
        fiscal_receipt_id: { type: ['string', 'null'], description: 'PFR / TaxCore fiscal id; null clears the field. Do not put the PFR in item.' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Delete an operation by operation_id through the standard DELETE /operations/:id domain logic. A regular operation removes its contribution from the balance; an operation of a planned item clears done; a transfer operation deletes the whole transfer with both legs. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'number', description: 'ID of the operation to delete' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Add a transfer between accounts (ATM withdrawal, conversion, bank-to-bank transfer). Creates a transfers record plus two operations (transfer_out from the source account and transfer_in to the destination account) sharing a transfer_id. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Transfer date in YYYY-MM-DD format' },
        from_account_id: { type: 'number', description: 'Source account ID (debit)' },
        to_account_id: { type: 'number', description: 'Destination account ID (credit)' },
        from_amount_minor: { type: 'number', description: 'Debit amount in minor units of the source account currency (positive value)' },
        to_amount_minor: { type: 'number', description: 'Credit amount in minor units of the destination account currency (positive value). Differs from from_amount_minor on conversion; for a same-currency transfer it is usually equal minus fees.' },
        item: { type: 'string', description: 'Name or description of the transfer' },
        category: { type: 'string', description: 'Category (optional)' },
        subcategory: { type: 'string', description: 'Subcategory (optional, only when a category is set)' },
        comment: { type: 'string', description: 'Free-form comment (optional; written to both transfer legs)' },
        receipt_url: { type: 'string', description: 'Fiscal/verification receipt URL (http/https, optional)' },
        fiscal_receipt_id: { type: 'string', description: 'PFR / TaxCore fiscal id (optional; written to both transfer legs)' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Adjust the current account balance. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'number', description: 'Account ID' },
        balance_minor: { type: 'number', description: 'New account balance in minor units of the account currency' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Create a planned item (income or expense). Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Planned item date in YYYY-MM-DD format' },
        title: { type: 'string', description: 'Planned item title' },
        amount_minor: { type: 'number', description: 'Amount in minor units (negative for an expense, positive for income)' },
        account_id: { type: 'number', description: 'Account ID' },
        currency: { type: 'string', description: 'Planned item currency (defaults to the account currency)' },
        category: { type: 'string', description: 'Category (optional)' },
        done: { type: 'boolean', description: 'Whether the planned item is marked done right away (default false)' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Partially update a planned item by planned_item_id, including the standard done → operation transition. Requires scope "write" and confirmation (MRTR); uses PATCH /planned-items/:id.' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        planned_item_id: { type: 'number', description: 'Planned item ID' },
        date: { type: 'string', description: 'New date YYYY-MM-DD' },
        title: { type: 'string', description: 'New title' },
        amount_minor: { type: 'number', description: 'Amount in minor units' },
        currency: { type: 'string', description: 'Currency; when changing it, pass amount_minor in the same request' },
        account_id: { type: 'number', description: 'Account ID' },
        category: { type: ['string', 'null'], description: 'Category; null clears the field' },
        done: { type: 'boolean', description: 'true materializes plan → operation through the standard path when the account currency is compatible' },
        idempotency_key: { type: 'string', description: 'Unique idempotency key' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['planned_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { planned_item: { type: 'object' }, operation: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'planned_item_fulfill_existing',
    description: 'Fulfill a planned item with an already existing financial fact. Does not create or change an operation and does not change the balance; stores a durable linkage. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
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
    description: 'Delete a planned item by planned_item_id through the standard DELETE /planned-items/:id. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        planned_item_id: { type: 'number', description: 'ID of the planned item to delete' },
        idempotency_key: { type: 'string', description: 'Unique idempotency key' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['planned_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, planned_item_id: { type: 'number' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_add',
    description: 'Create a recurring rule. Requires scope "write" and confirmation (MRTR); creates a recurring item, not a planned item and not a debit fact.' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Recurring rule title' },
        amount_minor: { type: 'number', description: 'Amount in minor units; an expense is negative' },
        account_id: { type: 'number', description: 'Account ID' },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'], description: 'Rule frequency' },
        next_due_date: { type: 'string', description: 'Next period date YYYY-MM-DD' },
        currency: { type: 'string', description: 'Currency, defaults to the account currency' },
        category: { type: ['string', 'null'], description: 'Category; null clears/does not set it' },
        interval_count: { type: 'number', description: 'Interval from 1 to 365' },
        day_of_month: { type: ['number', 'null'], description: 'Day-of-month anchor for monthly/yearly' },
        month_of_year: { type: ['number', 'null'], description: 'Month anchor for yearly' },
        end_date: { type: ['string', 'null'], description: 'Last period date or null' },
        active: { type: 'boolean', description: 'Whether the rule is active; default true' },
        idempotency_key: { type: 'string', description: 'Unique idempotency key' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['title', 'amount_minor', 'account_id', 'frequency', 'next_due_date', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { recurring_item: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_update',
    description: 'Partially update a recurring rule by recurring_item_id through the standard PATCH /recurring-items/:id. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recurring_item_id: { type: 'number', description: 'Recurring rule ID' },
        title: { type: 'string' }, amount_minor: { type: 'number' }, currency: { type: 'string' }, account_id: { type: 'number' }, category: { type: ['string', 'null'] },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] }, interval_count: { type: 'number' }, day_of_month: { type: ['number', 'null'] }, month_of_year: { type: ['number', 'null'] },
        next_due_date: { type: 'string' }, end_date: { type: ['string', 'null'] }, active: { type: 'boolean' },
        idempotency_key: { type: 'string', description: 'Unique idempotency key' }, requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION },
      },
      required: ['recurring_item_id', 'idempotency_key'],
    },
    outputSchema: { type: 'object', properties: { recurring_item: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI },
  },
  {
    name: 'recurring_item_delete',
    description: 'Delete a recurring rule by recurring_item_id through the standard DELETE /recurring-items/:id. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
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
    description: 'Close the next period of a recurring rule through the standard route: atomically materializes the operation fact and advances the period. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
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
    description: 'Fulfill the current recurring occurrence with one or more already existing operations. Does not create or change operations and does not change the balance; stores an occurrence-level linkage. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recurring_item_id: { type: 'number' },
        period_due_date: { type: 'string', description: 'Exact current occurrence YYYY-MM-DD' },
        operation_ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'number' } },
        evidence_quantity: { type: 'number', description: 'Explicitly proven number of units for the amount check. Does not advance extra occurrences; default 1, maximum 100' },
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
    description: 'Skip the next period of a recurring rule without creating an operation and without changing the balance, through the standard route. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
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
    description: 'Undo the fulfillment of a specific recurring rule period (materialized, linked or skipped) through the standard route: removes operation_fulfillment_links and the period history, does not change operations or balances. After the undo, DELETE /operations/:id is allowed again. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        recurring_item_id: { type: 'number' },
        period_due_date: { type: 'string', description: 'YYYY-MM-DD anchor of the period to reopen' },
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
    description: 'Set or update an exchange rate. Not a money transfer and not a payment: this is only the rate reference table. Requires scope "write". For an authenticated (non-anonymous) client the write happens immediately by default (auto_confirm defaults to true): resultType=complete and written=true. MRTR confirmation runs only when auto_confirm: false is passed. That call returns resultType=input_required and written=false, and nothing is written until a repeated call with requestState returns written=true. An anonymous client still uses MRTR.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Currency code (for example USD, EUR, RUB)' },
        rate: { type: 'number', description: 'Exchange rate against the target currency' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Delete an exchange rate. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Currency code to delete (for example USD, EUR, RUB)' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
    description: 'Reset the financial ledger to an empty instance without redeploying. Deletes accounts, operations, plans, rates and ledger settings. Passkeys, sessions and OAuth/MCP clients are kept. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write", the RESET phrase and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        confirm_phrase: { type: 'string', description: `Exact phrase ${RESET_CONFIRM_PHRASE}` },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
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
  },
  {
    name: 'account_aliases_list',
    description: 'List the aliases (virtual cards, receipt charge-account strings) bound to an account. Uses GET /accounts/:id/aliases.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { account_id: { type: 'number', description: 'Account ID' } },
      required: ['account_id']
    },
    outputSchema: { type: 'object', properties: { aliases: { type: 'array', items: { type: 'object' } }, error: { type: 'string' } } }
  },
  {
    name: 'account_resolve',
    description: 'Resolve a charge-account string from a receipt (for example "Visa *6125") to an account_id through the alias table. Read-only: an unknown string is not stored as pending. Uses GET /accounts/resolve.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { q: { type: 'string', description: 'Charge-account string to resolve' } },
      required: ['q']
    },
    outputSchema: { type: 'object', properties: { account_id: { type: ['number', 'null'] }, pending: { type: 'boolean' }, error: { type: 'string' } } }
  },
  {
    name: 'pending_accounts_list',
    description: 'List unbound charge-account strings collected from receipts, waiting to be bound to a real account with pending_account_bind. Uses GET /accounts/pending.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { pending: { type: 'array', items: { type: 'object' } }, error: { type: 'string' } } }
  },
  {
    name: 'account_add',
    description: 'Create an account through the standard POST /accounts. name, currency, owner and country are required; balance_minor defaults to 0. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Account name' },
        currency: { type: 'string', description: 'ISO-4217 currency code, for example EUR' },
        owner: { type: 'string', description: 'Account owner' },
        country: { type: 'string', description: 'Country of the account' },
        bank: { type: 'string', description: 'Bank (optional)' },
        type: { type: 'string', description: 'Account kind, for example Checking (optional)' },
        account_number: { type: 'string', description: 'Account number (optional)' },
        balance_minor: { type: 'number', description: 'Opening balance in minor units (optional, default 0)' },
        sort: { type: 'number', description: 'Sort order (optional)' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['name', 'currency', 'owner', 'country', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { account: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'account_update',
    description: 'Partially update an account by account_id through the standard PATCH /accounts/:id. Owner, currency, country, bank and type are locked once the account has operations; a currency change needs balance_minor in the new currency in the same call. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_id: { type: 'number', description: 'Account ID' },
        name: { type: 'string' },
        bank: { type: ['string', 'null'] },
        type: { type: ['string', 'null'] },
        account_number: { type: ['string', 'null'] },
        owner: { type: 'string' },
        country: { type: 'string' },
        currency: { type: 'string' },
        balance_minor: { type: 'number', description: 'Balance in minor units' },
        sort: { type: 'number' },
        archived: { type: 'boolean' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['account_id', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { account: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'account_delete',
    description: 'Delete an account by account_id through the standard DELETE /accounts/:id. Its aliases are removed with it. An account referenced by operations, planned items or recurring rules is refused: move or delete those first, or archive the account. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_id: { type: 'number', description: 'Account ID to delete' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['account_id', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, account_id: { type: 'number' }, deleted_account: { type: 'object' }, removed_aliases: { type: 'array', items: { type: 'object' } }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'account_alias_add',
    description: 'Bind an alias (virtual card or receipt charge-account string) to an account through the standard POST /accounts/:id/aliases. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_id: { type: 'number', description: 'Account ID' },
        alias_text: { type: 'string', description: 'Alias text, for example "Visa *6125"' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['account_id', 'alias_text', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { alias: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'account_alias_delete',
    description: 'Remove an alias from an account through the standard DELETE /accounts/:id/aliases/:aliasId. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_id: { type: 'number', description: 'Account ID' },
        alias_id: { type: 'number', description: 'Alias ID' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['account_id', 'alias_id', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, account_id: { type: 'number' }, alias_id: { type: 'number' }, deleted_alias: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'pending_account_bind',
    description: 'Bind a pending charge-account string (from pending_accounts_list) to a real account through the standard POST /accounts/pending/:id/bind: creates an alias and removes the pending row. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pending_id: { type: 'number', description: 'Pending string ID' },
        account_id: { type: 'number', description: 'Account ID to bind it to' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['pending_id', 'account_id', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { alias: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'transfer_update',
    description: 'Atomically update both legs of a transfer by transfer_id through the standard PUT /transfers/:id. Omitted fields (including date) keep their current values. A currency change needs the amount in the new currency in the same call. Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transfer_id: { type: 'number', description: 'Transfer ID' },
        date: { type: 'string', description: 'Date YYYY-MM-DD' },
        from_account_id: { type: 'number' },
        to_account_id: { type: 'number' },
        from_amount_minor: { type: 'number', description: 'Amount leaving the source account, minor units, positive' },
        to_amount_minor: { type: 'number', description: 'Amount arriving on the target account, minor units, positive' },
        item: { type: ['string', 'null'] },
        store: { type: ['string', 'null'] },
        category: { type: ['string', 'null'] },
        subcategory: { type: ['string', 'null'] },
        comment: { type: ['string', 'null'] },
        receipt_url: { type: ['string', 'null'] },
        fiscal_receipt_id: { type: ['string', 'null'] },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['transfer_id', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { transfer: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'transfer_delete',
    description: 'Delete a whole transfer (both legs) by transfer_id through the standard DELETE /transfers/:id; both account balances are restored. The preview lists both legs. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transfer_id: { type: 'number', description: 'Transfer ID' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['transfer_id', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, transfer_id: { type: 'number' }, deleted_legs: { type: 'array', items: { type: 'object' } }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'settings_get',
    description: 'Read all app settings (for example base_currency and low_balance_threshold_minor). Uses GET /settings.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { settings: { type: 'object' }, error: { type: 'string' } } }
  },
  {
    name: 'backup_export',
    description: `Export the full ledger backup (the same JSON as the app's Export backup, GET /backup/export). Pass compat "v2.35" for an explicit older-version file that omits purchase orders and warns with the omitted counts. The full backup stays the default. Documents up to ${BACKUP_EXPORT_MAX_BYTES} bytes (512 KiB) are returned inline in "backup"; above that cap the tool returns truncated: true with table and row counts and explains how to download the full file from the app.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        compat: { type: 'string', enum: ['v2.35'], description: 'Omit purchase-order groupings for a v2.35-compatible file' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        truncated: { type: 'boolean' },
        size_bytes: { type: 'number' },
        cap_bytes: { type: 'number' },
        backup: { type: 'object' },
        counts: { type: 'object' },
        message: { type: 'string' },
        error: { type: 'string' }
      }
    }
  },
  {
    name: 'setting_set',
    description: 'Change one app setting through the standard PUT /settings/:key. Accepted keys: base_currency (ISO-4217 code) and low_balance_threshold_minor (integer >= 0). The preview shows the old and new value. Changing base_currency recalculates all conversions and reports, so auto_confirm is refused for that key. ' + NO_AUTO_CONFIRM_DESCRIPTION + 'Requires scope "write" and confirmation (MRTR).' + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', enum: [...SETTING_SET_KEYS], description: 'Setting key' },
        value: { type: ['string', 'number'], description: 'New value' },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['key', 'value', 'idempotency_key']
    },
    outputSchema: { type: 'object', properties: { settings: { type: 'object' }, ...WRITE_OUTPUT_COMMON } },
    _meta: { ui: WRITE_TOOL_UI }
  },
  {
    name: 'backup_import',
    description: `Replace ALL ledger data with a backup document through the standard POST /backup/import. Call first with dry_run: true: the document is validated and the row counts are returned, nothing is written and no confirmation is created. Then call without dry_run and with confirm_phrase "${IMPORT_CONFIRM_PHRASE}" to get the confirmation request (MRTR). ${NO_AUTO_CONFIRM_DESCRIPTION}The MCP request body is limited to 64 KiB, so larger backups must be imported in the app. Requires scope "write".` + WRITE_TOOL_MRTR_NOTE,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        backup: { type: 'object', description: 'Backup document (format money-flow-v2-backup, version 1)' },
        dry_run: { type: 'boolean', description: 'true: validate and count only, write nothing' },
        confirm_phrase: { type: 'string', description: `Exact phrase ${IMPORT_CONFIRM_PHRASE}; required unless dry_run is true` },
        idempotency_key: { type: 'string', description: 'Unique client-generated idempotency key (UUID)' },
        requestState: { type: 'string', description: REQUEST_STATE_DESCRIPTION }
      },
      required: ['backup', 'idempotency_key']
    },
    outputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean' },
        counts: { type: 'object' },
        current_counts: { type: 'object' },
        ok: { type: 'boolean' },
        imported: { type: 'object' },
        ...WRITE_OUTPUT_COMMON
      }
    },
    _meta: { ui: WRITE_TOOL_UI }
  },
  ...statementMcpToolDefinitions({
    mrtr: WRITE_TOOL_MRTR_NOTE,
    noAutoConfirm: NO_AUTO_CONFIRM_DESCRIPTION,
  }),
  ...purchaseOrderToolDefinitions({
    mrtr: WRITE_TOOL_MRTR_NOTE,
    noAutoConfirm: NO_AUTO_CONFIRM_DESCRIPTION,
  }),
  ...receiptGroupToolDefinitions({
    mrtr: WRITE_TOOL_MRTR_NOTE,
    noAutoConfirm: NO_AUTO_CONFIRM_DESCRIPTION,
  }),
];

for (const tool of TOOLS) {
  if (READ_TOOLS.has(tool.name)) {
    (tool as any).annotations = { ...READ_TOOL_ANNOTATIONS };
  } else if (['fx_rate_delete', 'operation_delete', 'planned_item_delete', 'recurring_item_delete', 'recurring_item_cancel_period_fulfillment', 'data_reset', 'account_delete', 'account_alias_delete', 'transfer_delete', 'backup_import', ...STATEMENT_NO_AUTO_CONFIRM, ...PURCHASE_NO_AUTO_CONFIRM, ...RECEIPT_GROUP_NO_AUTO_CONFIRM].includes(tool.name)) {
    (tool as any).annotations = { ...WRITE_DELETE_ANNOTATIONS };
  } else if (WRITE_TOOLS.has(tool.name)) {
    (tool as any).annotations = { ...WRITE_TOOL_ANNOTATIONS };
  }
}

/** CallToolResult 2025-11-25: only content / structuredContent / isError / _meta. */
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
const WRITE_CREATE_TOOLS = new Set(['operation_add', 'planned_item_add', 'recurring_item_add', 'account_add']);

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
  if (['account_update', 'account_delete', 'account_alias_add', 'account_alias_delete', 'pending_account_bind'].includes(name)) {
    redacted.account_id = firstId(confirmedArgs.account_id);
  }
  if (name === 'account_alias_add' || name === 'pending_account_bind') {
    redacted.alias_id = firstId(written.alias);
  }
  if (name === 'account_alias_delete') redacted.alias_id = firstId(confirmedArgs.alias_id);
  if (name === 'transfer_update' || name === 'transfer_delete') redacted.transfer_id = firstId(confirmedArgs.transfer_id);
  return redacted;
}

function clientWriteDescription(
  name: string,
  detailed: string | undefined,
  hasRead: boolean,
  confirmedArgs?: Record<string, unknown>,
): string {
  if (detailed && (hasRead || WRITE_CREATE_TOOLS.has(name) || STATEMENT_MUTATION_TOOLS.has(name))) return detailed;
  if (name === 'transfer_add') return 'Confirm the transfer';
  if (name === 'balance_correct' && confirmedArgs) {
    return `Confirm the balance adjustment of account ID ${confirmedArgs.account_id}: new balance ${confirmedArgs.balance_minor}`;
  }
  return `Confirm ${name}`;
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
): Promise<{ error?: string; description?: string; confirmedArgs?: any; confirmationSnapshot?: any; uploadIds?: string[] }> {
  const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
  if (!idempotencyKey) {
    return { error: 'The idempotency_key field is required for all write operations' };
  }

  if ((PURCHASE_WRITE_TOOLS as readonly string[]).includes(name)) {
    return validatePurchaseOrderWrite(name, args, idempotencyKey);
  }

  if ((RECEIPT_GROUP_WRITE_TOOLS as readonly string[]).includes(name)) {
    return validateReceiptGroupWrite(name, args, idempotencyKey);
  }

  if (STATEMENT_MUTATION_TOOLS.has(name)) {
    const statementValidation = await validateStatementWrite(name, args, db, idempotencyKey);
    if (statementValidation.confirmedArgs && name === 'template_create') {
      statementValidation.confirmedArgs.created_by_client_id = null;
    }
    return statementValidation;
  }

  if (name === 'operation_add') {
    const { date, account_id, kind, item, amount_minor, category, subcategory, store, comment, receipt_url, fiscal_receipt_id } = args;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return { error: 'Invalid date (expected format YYYY-MM-DD)' };
    }
    if (typeof account_id !== 'number' || !Number.isInteger(account_id) || account_id <= 0) {
      return { error: 'Invalid account_id' };
    }
    if (!['expense', 'income', 'refund'].includes(kind)) {
      return { error: 'kind must be one of: expense, income, refund' };
    }
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { error: 'item cannot be empty' };
    }
    if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor) || amount_minor === 0) {
      return { error: 'amount_minor must be a non-zero integer' };
    }
    if (kind === 'expense' && amount_minor > 0) {
      return { error: 'An expense amount must be negative' };
    }
    if ((kind === 'income' || kind === 'refund') && amount_minor < 0) {
      return { error: 'An income/refund amount must be positive' };
    }
    if (subcategory && !category) {
      return { error: 'A subcategory cannot be set without a category' };
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
        return { error: 'Account not found' };
      }
    }

    const kindLabel = kind === 'expense' ? 'expense' : kind === 'income' ? 'income' : 'refund';
    const description = `Confirm adding the operation: ${kindLabel} "${item.trim()}" for ${amount_minor} (account ID ${account_id}${category ? `, category: ${category}` : ''})`;
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
      return { error: 'Invalid operation_id' };
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
        error: `Fields not allowed for operation_update: ${rejectedFields.join(', ')}. Allowed fields: operation_id, ${OPERATION_UPDATE_FIELDS.join(', ')}, idempotency_key, requestState`,
      };
    }

    const patchArgs: Record<string, unknown> = {};
    for (const field of OPERATION_UPDATE_FIELDS) {
      if (field in args) patchArgs[field] = args[field];
    }
    if (Object.keys(patchArgs).length === 0) {
      return { error: `Pass at least one field to change. Allowed fields: ${OPERATION_UPDATE_FIELDS.join(', ')}` };
    }

    const current = await loadOperationForMcp(db, operationId);
    if (!current) {
      return { error: 'Operation not found' };
    }

    const normalized: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(patchArgs)) {
      switch (field) {
        case 'date':
          if (typeof raw !== 'string' || !isIsoDate(raw)) return { error: 'Invalid date (expected format YYYY-MM-DD)' };
          normalized.date = raw;
          break;
        case 'account_id':
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return { error: 'Invalid account_id' };
          normalized.account_id = raw;
          break;
        case 'kind':
          if (typeof raw !== 'string' || !(OPERATION_KINDS as readonly string[]).includes(raw)) {
            return { error: `kind must be one of: ${OPERATION_KINDS.join(', ')}` };
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
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw === 0) return { error: 'amount_minor must be a non-zero integer' };
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
      return { error: 'The amount, account and kind of a transfer cannot be changed separately — delete the transfer and create it again' };
    }
    const signError = signMatchesKind(nextKind, nextAmount);
    if (signError) return { error: signError };
    if (nextSubcategory !== null && nextCategory === null) {
      return { error: 'subcategory without category makes no sense — set a category or remove the subcategory' };
    }
    if (db && nextAccountId !== current.account_id) {
      const target = await db.prepare('SELECT id, name, currency FROM accounts WHERE id = ?').bind(nextAccountId).first<{ id: number; name: string; currency: string }>();
      if (!target) return { error: 'Account not found' };
      if (target.currency !== current.currency && !('amount_minor' in normalized)) {
        return { error: `Changing the account changes the operation currency from ${current.currency} to ${target.currency} — pass amount_minor in the new currency in the same request` };
      }
    }

    const changedFields = Object.keys(normalized).join(', ');
    const description = `Confirm the change of operation ID ${operationId}: fields ${changedFields}`;
    return { description, confirmedArgs: { operation_id: operationId, ...normalized, idempotency_key: idempotencyKey } };
  }

  if (name === 'operation_delete') {
    const operationId = operationIdFromArgs(args);
    if (operationId === null) {
      return { error: 'Invalid operation_id' };
    }
    const allowed = new Set(['operation_id', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((key) => !allowed.has(key));
    if (rejected.length > 0) {
      return { error: `Fields not allowed for operation_delete: ${rejected.join(', ')}. Allowed fields: operation_id, idempotency_key, requestState` };
    }
    const current = await loadOperationForMcp(db, operationId);
    if (!current) {
      return { error: 'Operation not found' };
    }
    let transferNote = '';
    if (current.transfer_id !== null) {
      const legs = db ? await loadTransferLegs(db, current.transfer_id) : [];
      transferNote = ` WARNING: this operation is a leg of transfer_id=${current.transfer_id}, so the WHOLE transfer (both legs) will be deleted${legs.length > 0 ? `: ${describeTransferLegs(legs)}` : ''}. Prefer transfer_delete with transfer_id=${current.transfer_id} for an explicit transfer deletion.`;
    }
    const plannedNote = current.planned_item_id !== null ? ` The linked planned item planned_item_id=${current.planned_item_id} will have done cleared.` : '';
    const description = `Confirm deleting operation ID ${operationId}: ${current.kind} "${current.item}" for ${current.amount_minor} ${current.currency}.${transferNote}${plannedNote}`;
    return { description, confirmedArgs: { operation_id: operationId, idempotency_key: idempotencyKey } };
  }

  if (name === 'transfer_add') {
    const { date, from_account_id, to_account_id, from_amount_minor, to_amount_minor, item, category, subcategory, comment, receipt_url, fiscal_receipt_id } = args;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return { error: 'Invalid date (expected format YYYY-MM-DD)' };
    }
    if (typeof from_account_id !== 'number' || !Number.isInteger(from_account_id) || from_account_id <= 0) {
      return { error: 'Invalid from_account_id' };
    }
    if (typeof to_account_id !== 'number' || !Number.isInteger(to_account_id) || to_account_id <= 0) {
      return { error: 'Invalid to_account_id' };
    }
    if (from_account_id === to_account_id) {
      return { error: 'The debit account and the credit account must differ' };
    }
    if (typeof from_amount_minor !== 'number' || !Number.isInteger(from_amount_minor) || from_amount_minor <= 0) {
      return { error: 'from_amount_minor must be a positive integer' };
    }
    if (typeof to_amount_minor !== 'number' || !Number.isInteger(to_amount_minor) || to_amount_minor <= 0) {
      return { error: 'to_amount_minor must be a positive integer' };
    }
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { error: 'item cannot be empty' };
    }
    if (subcategory && !category) {
      return { error: 'A subcategory cannot be set without a category' };
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
        return { error: 'Debit account not found' };
      }
      if (!accTo) {
        return { error: 'Credit account not found' };
      }
      const currencyNote =
        accFrom.currency !== accTo.currency
          ? ` (conversion ${accFrom.currency} → ${accTo.currency})`
          : '';
      const description = `Confirm the transfer "${item.trim()}"${currencyNote}: ${from_amount_minor} ${accFrom.currency} from account "${accFrom.name}" → ${to_amount_minor} ${accTo.currency} to account "${accTo.name}"${category ? `, category: ${category}` : ''}`;
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

    const description = `Confirm the transfer "${item.trim()}": ${from_amount_minor} from account ID ${from_account_id} → ${to_amount_minor} to account ID ${to_account_id}`;
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
      return { error: 'Invalid account_id' };
    }
    if (typeof balance_minor !== 'number' || !Number.isInteger(balance_minor)) {
      return { error: 'balance_minor must be an integer' };
    }

    if (db) {
      const account = await db.prepare('SELECT id, name, currency, balance_minor FROM accounts WHERE id = ?').bind(account_id).first<{ id: number; name: string; currency: string; balance_minor: number }>();
      if (!account) {
        return { error: 'Account not found' };
      }
      const description = `Confirm the balance adjustment of account "${account.name}" (ID ${account_id}): new balance ${balance_minor} ${account.currency} (current: ${account.balance_minor})`;
      const confirmedArgs = { account_id, balance_minor, idempotency_key: idempotencyKey };
      return { description, confirmedArgs };
    }

    const description = `Confirm the balance adjustment of account ID ${account_id}: new balance ${balance_minor}`;
    const confirmedArgs = { account_id, balance_minor, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'planned_item_add') {
    const { date, title, amount_minor, account_id, currency, category, done } = args;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return { error: 'Invalid date (expected format YYYY-MM-DD)' };
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      return { error: 'title cannot be empty' };
    }
    if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor) || amount_minor === 0) {
      return { error: 'amount_minor must be a non-zero integer' };
    }
    if (typeof account_id !== 'number' || !Number.isInteger(account_id) || account_id <= 0) {
      return { error: 'Invalid account_id' };
    }

    if (db) {
      const account = await db.prepare('SELECT id, currency FROM accounts WHERE id = ?').bind(account_id).first<{ id: number; currency: string }>();
      if (!account) {
        return { error: 'Account not found' };
      }
    }

    const description = `Confirm creating the planned item "${title.trim()}" on ${date} for ${amount_minor} (account ID ${account_id})`;
    const confirmedArgs = { date, title: title.trim(), amount_minor, account_id, currency, category, done, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'planned_item_fulfill_existing') {
    const allowed = new Set(['planned_item_id', 'operation_id', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}` };
    const plannedItemId = args.planned_item_id;
    const operationId = args.operation_id;
    if (typeof plannedItemId !== 'number' || !Number.isInteger(plannedItemId) || plannedItemId <= 0) return { error: 'Invalid planned_item_id' };
    if (typeof operationId !== 'number' || !Number.isInteger(operationId) || operationId <= 0) return { error: 'Invalid operation_id' };
    if (!db) return { error: 'Storage unavailable' };
    const [planned, operation] = await Promise.all([
      db.prepare('SELECT * FROM planned_items WHERE id = ?').bind(plannedItemId).first<Record<string, unknown>>(),
      loadOperationForMcp(db, operationId),
    ]);
    if (!planned) return { error: 'Planned item not found' };
    if (!operation) return { error: 'Operation not found' };
    const confirmationSnapshot = {
      type: 'planned_fulfill', id: planned.id, revision: planned.revision,
      date: planned.date, title: planned.title, amount_minor: planned.amount_minor,
      currency: planned.currency, account_id: planned.account_id,
      category: planned.category, done: planned.done,
    };
    return {
      description: `Confirm fulfilling planned item ID ${plannedItemId} with existing operation ID ${operationId}. No new operation is created and the balance does not change.`,
      confirmedArgs: { planned_item_id: plannedItemId, operation_id: operationId, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'planned_item_update' || name === 'recurring_item_update') {
    const idField = name === 'planned_item_update' ? 'planned_item_id' : 'recurring_item_id';
    const fields = name === 'planned_item_update' ? PLANNED_UPDATE_FIELDS : RECURRING_UPDATE_FIELDS;
    const rawId = args[idField];
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
      return { error: `Invalid ${idField}` };
    }
    const allowed = new Set<string>([idField, ...fields, 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) {
      return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}. Allowed fields: ${idField}, ${fields.join(', ')}, idempotency_key, requestState` };
    }
    const patchArgs: Record<string, unknown> = {};
    for (const field of fields) if (field in args) patchArgs[field] = args[field];
    if (Object.keys(patchArgs).length === 0) {
      return { error: `Pass at least one field to change: ${fields.join(', ')}` };
    }
    let confirmationSnapshot: Record<string, unknown> | undefined;
    if (db) {
      const table = name === 'planned_item_update' ? 'planned_items' : 'recurring_items';
      const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(rawId).first<Record<string, unknown>>();
      if (!existing) return { error: `${name === 'planned_item_update' ? 'Planned item' : 'Recurring rule'} not found` };
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
      description: `Confirm the change of ${name === 'planned_item_update' ? 'planned item' : 'recurring rule'} ID ${rawId}: fields ${Object.keys(patchArgs).join(', ')}`,
      confirmedArgs: { [idField]: rawId, ...patchArgs, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'planned_item_delete' || name === 'recurring_item_delete') {
    const idField = name === 'planned_item_delete' ? 'planned_item_id' : 'recurring_item_id';
    const rawId = args[idField];
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) return { error: `Invalid ${idField}` };
    const allowed = new Set([idField, 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}` };
    let confirmationSnapshot: Record<string, unknown> | undefined;
    if (db) {
      const table = name === 'planned_item_delete' ? 'planned_items' : 'recurring_items';
      const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(rawId).first<Record<string, unknown>>();
      if (!existing) return { error: `${name === 'planned_item_delete' ? 'Planned item' : 'Recurring rule'} not found` };
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
      description: `Confirm deletion of ID ${rawId}`,
      confirmedArgs: { [idField]: rawId, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'recurring_item_fulfill_existing') {
    const allowed = new Set(['recurring_item_id', 'period_due_date', 'operation_ids', 'evidence_quantity', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}` };
    const recurringItemId = args.recurring_item_id;
    const periodDueDate = args.period_due_date;
    const operationIds = args.operation_ids;
    if (typeof recurringItemId !== 'number' || !Number.isInteger(recurringItemId) || recurringItemId <= 0) return { error: 'Invalid recurring_item_id' };
    if (typeof periodDueDate !== 'string' || !isIsoDate(periodDueDate)) return { error: 'Invalid period_due_date' };
    if (!Array.isArray(operationIds) || operationIds.length === 0 || operationIds.length > 100 || operationIds.some((value) => typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
      return { error: 'operation_ids must be a non-empty array of at most 100 positive IDs' };
    }
    if (new Set(operationIds).size !== operationIds.length) return { error: 'operation_ids must not contain duplicates' };
    const evidenceQuantity = args.evidence_quantity === undefined ? 1 : args.evidence_quantity;
    if (typeof evidenceQuantity !== 'number' || !Number.isInteger(evidenceQuantity) || evidenceQuantity < 1 || evidenceQuantity > 100) {
      return { error: 'evidence_quantity must be an integer from 1 to 100' };
    }
    if (!db) return { error: 'Recurring storage unavailable' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?')
      .bind(recurringItemId).first<Record<string, unknown>>();
    if (!existing) return { error: 'Recurring rule not found' };
    if (isAnalyticalSkipOnlyRecurringId(recurringItemId)) {
      return { error: `Analytical rule ID ${recurringItemId} only accepts skip_period` };
    }
    if (existing.active !== 1) return { error: 'Recurring rule is inactive' };
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
      description: `Confirm fulfilling one recurring occurrence ${periodDueDate} of rule ID ${recurringItemId} with existing operations [${sortedIds.join(', ')}]. The explicit unit count ${evidenceQuantity} is used only for the amount check; this call does not advance extra occurrences. No new operations are created and the balance does not change.`,
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
    if (rejected.length > 0) return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}` };
    const recurringItemId = args.recurring_item_id;
    const periodDueDate = args.period_due_date;
    if (typeof recurringItemId !== 'number' || !Number.isInteger(recurringItemId) || recurringItemId <= 0) {
      return { error: 'Invalid recurring_item_id' };
    }
    if (typeof periodDueDate !== 'string' || !isIsoDate(periodDueDate)) {
      return { error: 'Invalid period_due_date' };
    }
    if (!db) return { error: 'Recurring storage unavailable' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?')
      .bind(recurringItemId).first<Record<string, unknown>>();
    if (!existing) return { error: 'Recurring rule not found' };
    const fulfillment = await db.prepare(
      'SELECT outcome FROM recurring_period_fulfillments WHERE recurring_item_id = ? AND period_due_date = ?',
    ).bind(recurringItemId, periodDueDate).first<{ outcome: string }>();
    if (!fulfillment) return { error: 'Period fulfillment not found' };
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
      description: `Confirm undoing the fulfillment of period ${periodDueDate} (${fulfillment.outcome}) of recurring rule ID ${recurringItemId}. Linked operations and balances do not change; the period is reopened.`,
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
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) return { error: 'Invalid recurring_item_id' };
    const allowed = new Set(['recurring_item_id', 'idempotency_key', 'requestState']);
    const rejected = Object.keys(args).filter((field) => !allowed.has(field));
    if (rejected.length > 0) return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}` };
    if (!db) return { error: 'Recurring storage unavailable' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?').bind(rawId).first<Record<string, unknown>>();
    if (!existing) return { error: 'Recurring rule not found' };
    if (existing.active !== 1) return { error: 'Recurring rule is inactive' };
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
      description: `Confirm skipping period ${existing.next_due_date} for recurring rule ID ${rawId} without creating an operation or changing the balance`,
      confirmedArgs: { recurring_item_id: rawId, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'recurring_item_add') {
    const rejected = Object.keys(args).filter((field) => !RECURRING_ADD_FIELD_SET.has(field));
    if (rejected.length > 0) return { error: `Fields not allowed for recurring_item_add: ${rejected.join(', ')}` };
    const { title, amount_minor, account_id, frequency, next_due_date } = args;
    if (typeof title !== 'string' || title.trim().length === 0) return { error: 'title cannot be empty' };
    if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor) || amount_minor === 0) return { error: 'amount_minor must be a non-zero integer' };
    if (typeof account_id !== 'number' || !Number.isInteger(account_id) || account_id <= 0) return { error: 'Invalid account_id' };
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) return { error: 'frequency must be one of: daily, weekly, monthly, yearly' };
    if (typeof next_due_date !== 'string' || !isIsoDate(next_due_date)) return { error: 'Invalid next_due_date (expected format YYYY-MM-DD)' };
    return {
      description: `Confirm creating the recurring rule "${title.trim()}": ${amount_minor} on account ID ${account_id}, ${frequency}, next period ${next_due_date}. This is a rule, not a planned item and not a debit fact.`,
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
    if (rejected.length > 0) return { error: `Fields not allowed for recurring_item_close_period: ${rejected.join(', ')}` };
    const recurringItemId = args.recurring_item_id;
    if (typeof recurringItemId !== 'number' || !Number.isInteger(recurringItemId) || recurringItemId <= 0) return { error: 'Invalid recurring_item_id' };
    if (!db) return { error: 'Recurring storage unavailable' };
    const existing = await db.prepare('SELECT * FROM recurring_items WHERE id = ?')
      .bind(recurringItemId)
      .first<Record<string, unknown>>();
    if (!existing) return { error: 'Recurring rule not found' };
    if (isAnalyticalSkipOnlyRecurringId(recurringItemId)) {
      return { error: `Analytical rule ID ${recurringItemId} only accepts skip_period` };
    }
    if (existing.active !== 1) return { error: 'Recurring rule is inactive' };
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
      description: `Confirm closing the period of recurring rule ID ${recurringItemId}: a fact of ${confirmedClose.amount_minor} will be created on account ID ${confirmedClose.account_id} for ${confirmedClose.date} and the next period will be advanced.`,
      confirmedArgs: writeOnlyCloseArgs ?? { recurring_item_id: recurringItemId, ...confirmedClose, idempotency_key: idempotencyKey },
      confirmationSnapshot,
    };
  }

  if (name === 'fx_rate_set') {
    const { code, rate } = args;
    if (typeof code !== 'string' || !/^[a-zA-Z]{3}$/.test(code)) {
      return { error: 'The currency code must be exactly three Latin letters (ISO-4217), for example USD' };
    }
    if (typeof rate !== 'number' || rate <= 0) {
      return { error: 'The exchange rate (rate) must be a positive number' };
    }
    const description = `Confirm setting the rate for ${code.toUpperCase()}: ${rate}`;
    const confirmedArgs = { code: code.toUpperCase(), rate, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'fx_rate_delete') {
    const { code } = args;
    if (typeof code !== 'string' || !/^[a-zA-Z]{3}$/.test(code)) {
      return { error: 'The currency code must be exactly three Latin letters (ISO-4217), for example USD' };
    }
    const description = `Confirm deleting the rate for ${code.toUpperCase()}`;
    const confirmedArgs = { code: code.toUpperCase(), idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'data_reset') {
    if (args.confirm_phrase !== RESET_CONFIRM_PHRASE) {
      return { error: `confirm_phrase must be exactly ${RESET_CONFIRM_PHRASE}` };
    }
    const description = `Confirm a full reset of financial data to an empty instance. Passkeys and MCP clients are kept.`;
    const confirmedArgs = { confirm_phrase: RESET_CONFIRM_PHRASE, idempotency_key: idempotencyKey };
    return { description, confirmedArgs };
  }

  if (name === 'account_add' || name === 'account_update' || name === 'account_delete'
    || name === 'account_alias_add' || name === 'account_alias_delete' || name === 'pending_account_bind') {
    const control = new Set(['idempotency_key', 'requestState']);
    const allowedByTool: Record<string, readonly string[]> = {
      account_add: ACCOUNT_ADD_FIELDS,
      account_update: ['account_id', ...ACCOUNT_UPDATE_FIELDS],
      account_delete: ['account_id'],
      account_alias_add: ['account_id', 'alias_text'],
      account_alias_delete: ['account_id', 'alias_id'],
      pending_account_bind: ['pending_id', 'account_id'],
    };
    const allowed = allowedByTool[name];
    const rejected = Object.keys(args).filter((key) => !control.has(key) && !allowed.includes(key));
    if (rejected.length > 0) {
      return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}. Allowed fields: ${allowed.join(', ')}, idempotency_key, requestState` };
    }
    const positiveId = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;
    const loadAccount = async (id: number) => db
      ? db.prepare('SELECT id, name, currency, balance_minor, archived FROM accounts WHERE id = ?').bind(id)
        .first<{ id: number; name: string; currency: string; balance_minor: number; archived: number }>()
      : null;

    if (name === 'account_add') {
      for (const field of ['name', 'currency', 'owner', 'country'] as const) {
        if (typeof args[field] !== 'string' || args[field].trim().length === 0) {
          return { error: `${field} is required and must be a non-empty string` };
        }
      }
      const confirmedArgs: Record<string, unknown> = {};
      for (const field of ACCOUNT_ADD_FIELDS) if (field in args) confirmedArgs[field] = args[field];
      confirmedArgs.idempotency_key = idempotencyKey;
      return {
        description: `Confirm creating account "${String(args.name).trim()}" (${String(args.currency).trim().toUpperCase()}, owner ${String(args.owner).trim()}, ${String(args.country).trim()})${args.balance_minor !== undefined ? ` with opening balance ${args.balance_minor}` : ''}`,
        confirmedArgs,
      };
    }

    if (!positiveId(args.account_id)) return { error: 'Invalid account_id' };
    const accountId = args.account_id as number;
    const account = await loadAccount(accountId);
    if (db && !account) return { error: 'Account not found' };

    if (name === 'account_update') {
      const patch: Record<string, unknown> = {};
      for (const field of ACCOUNT_UPDATE_FIELDS) if (field in args) patch[field] = args[field];
      if (Object.keys(patch).length === 0) {
        return { error: `Pass at least one field to change. Allowed fields: ${ACCOUNT_UPDATE_FIELDS.join(', ')}` };
      }
      return {
        description: `Confirm the change of account ID ${accountId}${account ? ` "${account.name}"` : ''}: fields ${Object.keys(patch).join(', ')}`,
        confirmedArgs: { account_id: accountId, ...patch, idempotency_key: idempotencyKey },
      };
    }

    if (name === 'account_delete') {
      if (db) {
        const refs = await countAccountRefs(db, accountId);
        if (refs > 0) return { error: accountInUseMessage(accountId, refs) };
      }
      const aliases = db ? await listAliases(db, accountId) : [];
      const aliasNote = aliases.length > 0
        ? ` Its ${aliases.length} alias(es) will be removed with it: ${aliases.map((alias) => `"${alias.alias_text}" (ID ${alias.id})`).join(', ')}.`
        : ' It has no aliases.';
      return {
        description: `Confirm deleting account ID ${accountId}${account ? ` "${account.name}" (${account.currency}, balance ${account.balance_minor})` : ''}. It has no operations, planned items or recurring rules.${aliasNote}`,
        confirmedArgs: { account_id: accountId, idempotency_key: idempotencyKey },
      };
    }

    if (name === 'account_alias_add') {
      if (typeof args.alias_text !== 'string' || args.alias_text.trim().length === 0) {
        return { error: 'alias_text is required and cannot be empty' };
      }
      return {
        description: `Confirm binding alias "${args.alias_text.trim()}" to account ID ${accountId}${account ? ` "${account.name}"` : ''}`,
        confirmedArgs: { account_id: accountId, alias_text: args.alias_text.trim(), idempotency_key: idempotencyKey },
      };
    }

    if (name === 'account_alias_delete') {
      if (!positiveId(args.alias_id)) return { error: 'Invalid alias_id' };
      const alias = db
        ? await db.prepare('SELECT id, alias_text FROM account_aliases WHERE id = ? AND account_id = ?').bind(args.alias_id, accountId)
          .first<{ id: number; alias_text: string }>()
        : null;
      if (db && !alias) return { error: 'Alias not found on this account' };
      return {
        description: `Confirm removing alias ID ${args.alias_id}${alias ? ` "${alias.alias_text}"` : ''} from account ID ${accountId}${account ? ` "${account.name}"` : ''}. Only the alias is removed; operations and balances are unchanged.`,
        confirmedArgs: { account_id: accountId, alias_id: args.alias_id, idempotency_key: idempotencyKey },
      };
    }

    // pending_account_bind
    if (!positiveId(args.pending_id)) return { error: 'Invalid pending_id' };
    const pending = db
      ? await db.prepare('SELECT id, raw_string FROM pending_account_strings WHERE id = ?').bind(args.pending_id)
        .first<{ id: number; raw_string: string }>()
      : null;
    if (db && !pending) return { error: 'Pending account string not found' };
    return {
      description: `Confirm binding pending string ID ${args.pending_id}${pending ? ` "${pending.raw_string}"` : ''} to account ID ${accountId}${account ? ` "${account.name}"` : ''}: an alias is created and the pending row is removed`,
      confirmedArgs: { pending_id: args.pending_id, account_id: accountId, idempotency_key: idempotencyKey },
    };
  }

  if (name === 'transfer_update' || name === 'transfer_delete') {
    const allowed: readonly string[] = name === 'transfer_update' ? ['transfer_id', ...TRANSFER_UPDATE_FIELDS] : ['transfer_id'];
    const rejected = Object.keys(args).filter((key) => key !== 'idempotency_key' && key !== 'requestState' && !allowed.includes(key));
    if (rejected.length > 0) {
      return { error: `Fields not allowed for ${name}: ${rejected.join(', ')}. Allowed fields: ${allowed.join(', ')}, idempotency_key, requestState` };
    }
    const transferId = args.transfer_id;
    if (typeof transferId !== 'number' || !Number.isInteger(transferId) || transferId <= 0) return { error: 'Invalid transfer_id' };
    const legs = db ? await loadTransferLegs(db, transferId) : [];
    if (db && legs.length === 0) return { error: 'Transfer not found' };
    if (name === 'transfer_delete') {
      return {
        description: `Confirm deleting transfer ID ${transferId} with both legs: ${describeTransferLegs(legs)}. Both account balances are restored.`,
        confirmedArgs: { transfer_id: transferId, idempotency_key: idempotencyKey },
      };
    }
    const patch: Record<string, unknown> = {};
    for (const field of TRANSFER_UPDATE_FIELDS) if (field in args) patch[field] = args[field];
    if (Object.keys(patch).length === 0) {
      return { error: `Pass at least one field to change. Allowed fields: ${TRANSFER_UPDATE_FIELDS.join(', ')}` };
    }
    return {
      description: `Confirm the change of transfer ID ${transferId} (${describeTransferLegs(legs)}): fields ${Object.keys(patch).join(', ')}`,
      confirmedArgs: { transfer_id: transferId, ...patch, idempotency_key: idempotencyKey },
    };
  }

  if (name === 'setting_set') {
    const rejected = Object.keys(args).filter((key) => !['key', 'value', 'idempotency_key', 'requestState'].includes(key));
    if (rejected.length > 0) {
      return { error: `Fields not allowed for setting_set: ${rejected.join(', ')}. Allowed fields: key, value, idempotency_key, requestState` };
    }
    if (args.key === PURCHASE_ORDERS_EPOCH_KEY) {
      return { error: 'purchase_orders_epoch is reserved and cannot be changed through setting_set' };
    }
    if (typeof args.key !== 'string' || !(SETTING_SET_KEYS as readonly string[]).includes(args.key)) {
      return { error: `key must be one of: ${SETTING_SET_KEYS.join(', ')}` };
    }
    if (typeof args.value !== 'string' && typeof args.value !== 'number') {
      return { error: 'value is required and must be a string or a number' };
    }
    const current = db
      ? await db.prepare('SELECT value FROM settings WHERE key = ?').bind(args.key).first<{ value: string }>()
      : null;
    const oldValue = current?.value ?? '(not set)';
    const newValue = args.key === 'base_currency' && typeof args.value === 'string' ? args.value.trim().toUpperCase() : String(args.value);
    const description = args.key === 'base_currency'
      ? `Confirm changing the base currency from ${oldValue} to ${newValue}. WARNING: all conversions and reports (balances in the base currency, forecast, analytics) will be recalculated in ${newValue}. Stored amounts and exchange rates are not changed.`
      : `Confirm changing ${args.key} from ${oldValue} to ${newValue}`;
    return { description, confirmedArgs: { key: args.key, value: args.value, idempotency_key: idempotencyKey } };
  }

  if (name === 'backup_import') {
    const rejected = Object.keys(args).filter((key) => !['backup', 'dry_run', 'confirm_phrase', 'idempotency_key', 'requestState'].includes(key));
    if (rejected.length > 0) {
      return { error: `Fields not allowed for backup_import: ${rejected.join(', ')}. Allowed fields: backup, dry_run, confirm_phrase, idempotency_key, requestState` };
    }
    if (args.confirm_phrase !== IMPORT_CONFIRM_PHRASE) {
      return { error: `confirm_phrase must be exactly ${IMPORT_CONFIRM_PHRASE}. Run backup_import with dry_run: true first to check the document.` };
    }
    let counts: Record<string, number>;
    try {
      counts = backupTableCounts(parseBackupDocument({ confirm: true, backup: args.backup }).tables);
    } catch (e: any) {
      return { error: `The backup document is invalid: ${e?.code ?? 'BACKUP_FORMAT_INVALID'}${e?.message ? ` (${e.message})` : ''}` };
    }
    const summary = Object.entries(counts).map(([table, n]) => `${table}: ${n}`).join(', ');
    let orderWarning = '';
    let acknowledge = false;
    if (db && backupOmitsOrderGroupings(parseBackupDocument({ confirm: true, backup: args.backup }).tables)) {
      const existing = await countOrderGroupings(db);
      if (existing.purchase_orders > 0 || existing.purchase_order_components > 0) {
        acknowledge = true;
        orderWarning = ` This backup contains no order groupings. ${existing.purchase_orders} existing groupings and ${existing.purchase_order_components} links will be removed.`;
      }
    }
    return {
      description: `Confirm replacing ALL ledger data with the backup. Every current row in the backup tables is deleted and replaced by: ${summary}.${orderWarning} This cannot be undone; export a backup first if you need the current data.`,
      confirmedArgs: {
        backup: args.backup,
        confirm_phrase: IMPORT_CONFIRM_PHRASE,
        idempotency_key: idempotencyKey,
        ...(acknowledge ? { acknowledge_order_removal: true } : {}),
      },
    };
  }

  return { error: `Unknown tool: ${name}` };
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
  let rawText = '';
  try {
    rawText = await readLimitedText(c.req.raw, STATEMENT_IMPORT_MCP_JSON_MAX_BYTES);
    body = rawText.trim().length === 0 ? {} : JSON.parse(rawText);
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

  const earlyToolName = method === 'tools/call'
    ? (typeof params?.name === 'string' && params.name.trim() ? params.name.trim() : (headerName?.trim() ?? ''))
    : '';
  const rawBytes = new TextEncoder().encode(rawText).byteLength;
  if (rawBytes > MCP_MAX_JSON_BYTES && !STATEMENT_INLINE_TOOLS.has(earlyToolName)) {
    return c.json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'FILTER_TOO_LARGE' },
      id,
    });
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

  // Refresh the active client token's last-used time in the background
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
          name: 'Pulse Dashboard',
          description: 'Interactive cash-flow and account health dashboard',
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
          name: 'Analytics Dashboard',
          description: 'Interactive spending analytics and breakdown dashboard',
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
        name: 'Write confirmation',
        description: 'Write confirmation button: without it MRTR writes nothing',
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
      if (WRITE_TOOLS.has(tool.name) && !NO_AUTO_CONFIRM_TOOLS.has(tool.name) && tool.name !== 'statement_import_upload_create') {
        return {
          ...tool,
          inputSchema: {
            ...sanitizedSchema,
            properties: {
              ...sanitizedSchema.properties,
              auto_confirm: {
                type: 'boolean',
                description: 'Optional flag for background agents. If true, the operation runs immediately without a confirmation request (MRTR).'
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

      if (name === 'template_list' || name === 'template_get' || name === 'statement_import_preview') {
        try {
          if (name === 'statement_import_preview') {
            const key = statementPreviewIdempotencyKey(args);
            const prepared = await prepareStatementImport(c.env.DB, args, key);
            if (!prepared.ok) {
              const errMsg = `Error executing tool: ${prepared.code}: ${prepared.message}`;
              await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
              return c.json({
                jsonrpc: '2.0',
                id,
                result: callToolResult({
                  content: [{ type: 'text', text: errMsg }],
                  isError: true,
                  structuredContent: {
                    error: errMsg,
                    code: prepared.code,
                    committable: false,
                    ...(prepared.preview ?? {}),
                  },
                }),
              });
            }
            const fingerprint = await writeArgumentFingerprint(prepared.confirmedArgs);
            const confirmHandle = await storeWriteConfirmation(c.env, {
              confirmedArgs: prepared.confirmedArgs,
              confirmationSnapshot: null,
            });
            const requestState = await encodeRequestState(c.env.SESSION_SECRET, {
              name: 'statement_import_commit',
              confirmHandle,
              clientId,
              idempotency_key: key,
              argumentFingerprint: fingerprint,
              createdAt: Date.now(),
            });
            await consumePreparedUploads(c.env.DB, prepared.uploadIds);
            const data = {
              ...prepared.preview,
              idempotency_key: key,
              requestState,
              resultType: 'complete',
              written: false,
            };
            await recordToolAudit(c.env.DB, clientId, name, 'success', prepared.description);
            return c.json({
              jsonrpc: '2.0',
              id,
              result: callToolResult({
                content: [{ type: 'text', text: JSON.stringify(data) }],
                structuredContent: data,
              }),
            });
          }
          const data = await readStatementTemplateTool(c.env.DB, name, args);
          await recordToolAudit(c.env.DB, clientId, name, 'success', summarizeToolResult(data));
          return c.json({
            jsonrpc: '2.0',
            id,
            result: callToolResult({
              content: [{ type: 'text', text: JSON.stringify(data) }],
              structuredContent: data,
            }),
          });
        } catch (error) {
          const detail = error instanceof ValidationError
            ? `${error.code}: ${error.message}`
            : (error instanceof Error ? error.message : 'Statement tool failed');
          const errMsg = `Error executing tool: ${detail}`;
          await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
          return c.json({
            jsonrpc: '2.0',
            id,
            result: callToolResult({
              content: [{ type: 'text', text: errMsg }],
              isError: true,
              structuredContent: { error: errMsg, code: error instanceof ValidationError ? error.code : 'IMPORT_FILE_INVALID' },
            }),
          });
        }
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
        case 'account_aliases_list':
          if (typeof args.account_id !== 'number' || !Number.isInteger(args.account_id) || args.account_id <= 0) {
            const errMsg = 'Error executing tool: Invalid account_id';
            await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          path = `/accounts/${args.account_id}/aliases`;
          break;
        case 'account_resolve':
          if (typeof args.q !== 'string' || args.q.trim().length === 0) {
            const errMsg = 'Error executing tool: q is required and cannot be empty';
            await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          path = `/accounts/resolve?q=${encodeURIComponent(args.q)}`;
          break;
        case 'pending_accounts_list':
          path = '/accounts/pending';
          break;
        case 'settings_get':
          path = '/settings';
          break;
        case 'backup_export':
          if (args.compat !== undefined && args.compat !== 'v2.35') {
            const errMsg = 'Error executing tool: compat must be "v2.35" when set';
            await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          path = args.compat === 'v2.35' ? '/backup/export?compat=v2.35' : '/backup/export';
          break;
        case 'purchase_orders_list': {
          const search = new URLSearchParams();
          if (typeof args.q === 'string' && args.q.length > 0) search.set('q', args.q);
          if (args.limit !== undefined) {
            if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
              const errMsg = 'Error executing tool: limit must be an integer from 1 to 100';
              await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
              return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
            }
            search.set('limit', String(args.limit));
          }
          if (args.cursor !== undefined) {
            if (args.limit === undefined || typeof args.cursor !== 'number' || !Number.isInteger(args.cursor) || args.cursor < 1) {
              const errMsg = 'Error executing tool: cursor must be a positive integer and requires limit';
              await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
              return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
            }
            search.set('cursor', String(args.cursor));
          }
          const query = search.toString();
          path = query.length > 0 ? `/purchase-orders?${query}` : '/purchase-orders';
          break;
        }
        case 'purchase_order_get':
          if (typeof args.order_id !== 'number' || !Number.isInteger(args.order_id) || args.order_id <= 0) {
            const errMsg = 'Error executing tool: Invalid order_id';
            await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          path = `/purchase-orders/${args.order_id}`;
          break;
        case 'receipt_groups_list': {
          const search = new URLSearchParams();
          if (typeof args.q === 'string' && args.q.length > 0) search.set('q', args.q);
          if (args.limit !== undefined) {
            if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
              const errMsg = 'Error executing tool: limit must be an integer from 1 to 100';
              await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
              return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
            }
            search.set('limit', String(args.limit));
          }
          if (args.cursor !== undefined) {
            if (args.limit === undefined || typeof args.cursor !== 'number' || !Number.isInteger(args.cursor) || args.cursor < 1) {
              const errMsg = 'Error executing tool: cursor must be a positive integer and requires limit';
              await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
              return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
            }
            search.set('cursor', String(args.cursor));
          }
          const query = search.toString();
          path = query.length > 0 ? `/receipt-groups?${query}` : '/receipt-groups';
          break;
        }
        case 'receipt_group_get':
          if (typeof args.group_id !== 'number' || !Number.isInteger(args.group_id) || args.group_id <= 0) {
            const errMsg = 'Error executing tool: Invalid group_id';
            await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          path = `/receipt-groups/${args.group_id}`;
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

        const rawData = await response.json();
        const data = name === 'backup_export' ? capBackupExport(rawData) : rawData;
        await recordToolAudit(c.env.DB, clientId, name, 'success', name === 'backup_export'
          ? `backup_export ${(data as any).truncated ? 'summary' : 'inline'} ${(data as any).size_bytes} bytes`
          : summarizeToolResult(data));

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

      if (name === 'statement_import_upload_create') {
        try {
          const data = await createStatementUploadForMcp(c.env.DB, c.env.SESSION_SECRET, args.filename, new URL(c.req.url).origin);
          await recordToolAudit(c.env.DB, clientId, name, 'success', `upload slot ${String(data.upload_id)}`);
          return c.json({
            jsonrpc: '2.0',
            id,
            result: callToolResult({
              content: [{ type: 'text', text: JSON.stringify(data) }],
              structuredContent: data,
            }),
          });
        } catch (error) {
          const detail = error instanceof ValidationError ? `${error.code}: ${error.message}` : (error instanceof Error ? error.message : 'Upload slot failed');
          const errMsg = `Error executing tool: ${detail}`;
          await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
          return c.json({
            jsonrpc: '2.0',
            id,
            result: callToolResult({
              content: [{ type: 'text', text: errMsg }],
              isError: true,
              structuredContent: { error: errMsg },
            }),
          });
        }
      }

      const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
      if (!idempotencyKey) {
        const errMsg = 'Error executing tool: The idempotency_key field is required for all write operations';
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

      // MRTR (confirmation) check
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
            const errMsg = `Error executing tool: idempotency_key was already used by tool ${existing.toolName}`;
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
          if (existing.status === 'success' && existing.resultSummary) {
            if (storedWriteFingerprint(existing.resultSummary) !== incomingArgumentFingerprint) {
              return idempotencyArgumentConflictResult(id);
            }
            return writeReplayResult(id, existing.resultSummary);
          }
          if (existing.status === 'pending' && existing.resultSummary?.startsWith('UNCERTAIN:')) {
            const errMsg = 'Error executing tool: the previous write may have completed, but the provider read-back did not finish; repeated mutation is blocked until the provider is reconciled';
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
              ? 'Error executing tool: an operation with this idempotency_key is already in progress; retry later'
              : 'Error executing tool: the claim expired without a reliable result; repeated mutation is blocked until the provider is reconciled manually';
            return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
          }
        }
      }

      let state: any = null;

      if (!requestStateStr) {
        // Step 1: validate the arguments and request confirmation (MRTR)
        if ('auto_confirm' in args && typeof args.auto_confirm !== 'boolean') {
          const errMsg = 'Error executing tool: auto_confirm must be a boolean';
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
        // auto_confirm is an execution control advertised for write tools that
        // are not in NO_AUTO_CONFIRM_TOOLS. Domain validators must see only
        // domain arguments so the control cannot be rejected as an unknown
        // financial field or become part of the signed/persisted mutation payload.
        if (name === 'template_update' && args.auto_confirm === true) {
          const decision = await templateUpdateAutoConfirmDecision(c.env.DB, clientId, args.template_id);
          if (decision === 'deny') {
            const errMsg = 'Error executing tool: auto_confirm is not accepted for template_update unless this MCP client created the template and it has not been used in an import batch; a human confirmation through requestState is required';
            await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
            return c.json({
              jsonrpc: '2.0', id,
              result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } },
            });
          }
        }
        if (name === 'setting_set' && NO_AUTO_CONFIRM_SETTING_KEYS.has(String(args.key)) && 'auto_confirm' in args) {
          const errMsg = `Error executing tool: auto_confirm is not accepted for setting_set with key ${String(args.key)}; changing the base currency recalculates all conversions and reports and always needs a human confirmation through requestState`;
          await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
          return c.json({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } },
          });
        }
        if (name === 'backup_import' && args.dry_run === true && !('auto_confirm' in args)) {
          // Dry run: validate through parseBackupDocument and count rows. Nothing is written,
          // no confirmation is stored and no idempotency execution is claimed.
          const extra = Object.keys(args).filter((key) => !['backup', 'dry_run', 'confirm_phrase', 'idempotency_key'].includes(key));
          let structured: Record<string, unknown>;
          let isError = false;
          if (extra.length > 0) {
            structured = { error: `Error executing tool: Fields not allowed for backup_import: ${extra.join(', ')}. Allowed fields: backup, dry_run, confirm_phrase, idempotency_key, requestState` };
            isError = true;
          } else {
            try {
              const document = parseBackupDocument({ confirm: true, backup: args.backup });
              const current: Record<string, number> = {};
              for (const table of USER_TABLES) {
                const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
                current[table] = row?.n ?? 0;
              }
              const existingOrders = backupOmitsOrderGroupings(document.tables)
                ? await countOrderGroupings(c.env.DB)
                : { purchase_orders: 0, purchase_order_components: 0 };
              const orderRemoval = existingOrders.purchase_orders > 0 || existingOrders.purchase_order_components > 0
                ? `This backup contains no order groupings. ${existingOrders.purchase_orders} existing groupings and ${existingOrders.purchase_order_components} links will be removed.`
                : undefined;
              structured = {
                dry_run: true, written: false, resultType: 'complete', tool: name,
                counts: backupTableCounts(document.tables), current_counts: current,
                ...(orderRemoval ? { order_removal_warning: orderRemoval, omitted_groupings: existingOrders } : {}),
                description: `Dry run only, nothing was written. To import, call backup_import again without dry_run and with confirm_phrase ${IMPORT_CONFIRM_PHRASE}, then confirm.`,
              };
            } catch (e: any) {
              structured = { error: `Error executing tool: The backup document is invalid: ${e?.code ?? 'BACKUP_FORMAT_INVALID'}${e?.message ? ` (${e.message})` : ''}` };
              isError = true;
            }
          }
          await recordToolAudit(c.env.DB, clientId, name, isError ? 'error' : 'success', isError ? String(structured.error) : 'dry run: nothing written');
          return c.json({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: JSON.stringify(structured) }], ...(isError ? { isError: true } : {}), structuredContent: structured },
          });
        }
        if (NO_AUTO_CONFIRM_TOOLS.has(name) && 'auto_confirm' in args) {
          const errMsg = `Error executing tool: auto_confirm is not accepted for ${name}; a destructive change always needs a human confirmation through requestState`;
          await recordToolAudit(c.env.DB, clientId, name, 'error', errMsg);
          return c.json({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } },
          });
        }
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
        // Allow a non-anonymous client to perform a direct write (Single Round-Trip).
        // auto_confirm defaults to true for fx_rate_set (unattended daily FX skill).
        const autoConfirm = args.auto_confirm === true || (name === 'fx_rate_set' && args.auto_confirm !== false);
        const shouldDirectExecute = isAgent && autoConfirm;

        if (shouldDirectExecute) {
          // Direct execution (Single Round-Trip)
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
          // Two-phase MRTR: snapshot stays server-side; token is an opaque handle.
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
          if (validation.uploadIds && validation.uploadIds.length > 0) {
            await consumePreparedUploads(c.env.DB, validation.uploadIds);
          }

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
        // Step 2: a repeated call carrying the confirmation state (MRTR).
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
        const errMsg = 'Error executing tool: requestState does not match the OAuth client, idempotency_key or confirmed arguments';
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
        const errMsg = 'Error executing tool: the object changed after confirmation; request a new confirmation for the current money values';
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
          errMsg = `Error executing tool: idempotency_key was already used by tool ${claim.toolName}`;
        } else if (claim.status === 'success' && claim.resultSummary) {
          if (storedWriteFingerprint(claim.resultSummary) !== state.argumentFingerprint) {
            return idempotencyArgumentConflictResult(id);
          }
          if (!hasReadScope && !WRITE_CREATE_TOOLS.has(name) && !STATEMENT_MUTATION_TOOLS.has(name)) {
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
          errMsg = 'Error executing tool: the previous write may have completed, but the provider read-back did not finish; repeated mutation is blocked until the provider is reconciled';
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
            ? 'Error executing tool: an operation with this idempotency_key is already in progress; retry later'
            : 'Error executing tool: the claim expired without a reliable result; repeated mutation is blocked until the provider is reconciled manually';
        } else {
          errMsg = 'Error executing tool: idempotency_key is in an unknown state';
        }
        return c.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errMsg }], isError: true, structuredContent: { error: errMsg } } });
      }

      const reqUrl = new URL(c.req.url);
      const subHeaders = new Headers(c.req.raw.headers);
      subHeaders.set('content-type', 'application/json');
      let subReq: Request;
      let operationDeleteSnapshot: Record<string, unknown> | null = null;
      let accountDeleteSnapshot: Record<string, any> | null = null;
      const ledgerInvariantBefore = (
        name === 'planned_item_fulfill_existing'
        || name === 'recurring_item_fulfill_existing'
        || name === 'recurring_item_skip_period'
        || name === 'recurring_item_cancel_period_fulfillment'
        || (PURCHASE_WRITE_TOOLS as readonly string[]).includes(name)
        || (RECEIPT_GROUP_WRITE_TOOLS as readonly string[]).includes(name)
      ) ? await loadLedgerInvariant(c.env.DB) : null;

      const purchaseRequest = purchaseOrderWriteRequest(name, state.confirmedArgs, reqUrl.origin, subHeaders);
      const receiptGroupRequest = receiptGroupWriteRequest(name, state.confirmedArgs, reqUrl.origin, subHeaders);
      if (purchaseRequest) {
        subReq = purchaseRequest;
      } else if (receiptGroupRequest) {
        subReq = receiptGroupRequest;
      } else if (name === 'operation_add') {
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
      } else if (name === 'account_add') {
        const { idempotency_key: _ignoredIdempotencyKey, ...createArgs } = state.confirmedArgs;
        subReq = new Request(new URL('/accounts', reqUrl.origin).toString(), {
          method: 'POST', headers: subHeaders, body: JSON.stringify(createArgs),
        });
      } else if (name === 'account_update') {
        const { account_id, idempotency_key: _ignoredIdempotencyKey, ...patchArgs } = state.confirmedArgs;
        subReq = new Request(new URL(`/accounts/${account_id}`, reqUrl.origin).toString(), {
          method: 'PATCH', headers: subHeaders, body: JSON.stringify(patchArgs),
        });
      } else if (name === 'account_delete') {
        accountDeleteSnapshot = {
          account: await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(state.confirmedArgs.account_id).first(),
          aliases: await listAliases(c.env.DB, state.confirmedArgs.account_id),
        };
        subReq = new Request(new URL(`/accounts/${state.confirmedArgs.account_id}`, reqUrl.origin).toString(), {
          method: 'DELETE', headers: subHeaders,
        });
      } else if (name === 'account_alias_add') {
        subReq = new Request(new URL(`/accounts/${state.confirmedArgs.account_id}/aliases`, reqUrl.origin).toString(), {
          method: 'POST', headers: subHeaders, body: JSON.stringify({ alias_text: state.confirmedArgs.alias_text }),
        });
      } else if (name === 'account_alias_delete') {
        accountDeleteSnapshot = {
          alias: await c.env.DB.prepare('SELECT id, account_id, alias_text, created_at FROM account_aliases WHERE id = ? AND account_id = ?')
            .bind(state.confirmedArgs.alias_id, state.confirmedArgs.account_id).first(),
        };
        subReq = new Request(new URL(`/accounts/${state.confirmedArgs.account_id}/aliases/${state.confirmedArgs.alias_id}`, reqUrl.origin).toString(), {
          method: 'DELETE', headers: subHeaders,
        });
      } else if (name === 'pending_account_bind') {
        subReq = new Request(new URL(`/accounts/pending/${state.confirmedArgs.pending_id}/bind`, reqUrl.origin).toString(), {
          method: 'POST', headers: subHeaders, body: JSON.stringify({ account_id: state.confirmedArgs.account_id }),
        });
      } else if (name === 'transfer_update') {
        const { transfer_id, idempotency_key: _ignoredIdempotencyKey, ...patchArgs } = state.confirmedArgs;
        subReq = new Request(new URL(`/transfers/${transfer_id}`, reqUrl.origin).toString(), {
          method: 'PUT', headers: subHeaders, body: JSON.stringify(patchArgs),
        });
      } else if (name === 'transfer_delete') {
        accountDeleteSnapshot = { legs: await loadTransferLegs(c.env.DB, state.confirmedArgs.transfer_id) };
        subReq = new Request(new URL(`/transfers/${state.confirmedArgs.transfer_id}`, reqUrl.origin).toString(), {
          method: 'DELETE', headers: subHeaders,
        });
      } else if (name === 'setting_set') {
        subReq = new Request(new URL(`/settings/${encodeURIComponent(state.confirmedArgs.key)}`, reqUrl.origin).toString(), {
          method: 'PUT', headers: subHeaders, body: JSON.stringify({ value: state.confirmedArgs.value }),
        });
      } else if (name === 'backup_import') {
        subReq = new Request(new URL('/backup/import', reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({
            confirm: true,
            backup: state.confirmedArgs.backup,
            ...(state.confirmedArgs.acknowledge_order_removal === true ? { acknowledge_order_removal: true } : {}),
          }),
        });
      } else if (name === 'data_reset') {
        subReq = new Request(new URL('/data/reset', reqUrl.origin).toString(), {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify({ confirm: true, phrase: RESET_CONFIRM_PHRASE }),
        });
      } else if (STATEMENT_MUTATION_TOOLS.has(name)) {
        subReq = new Request(new URL('/statement-mcp', reqUrl.origin).toString(), { method: 'POST', headers: subHeaders });
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
        const response = STATEMENT_MUTATION_TOOLS.has(name)
          ? await (async () => {
            try {
              const data = await executeStatementMutation(c.env.DB, name, state.confirmedArgs, clientId);
              return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
            } catch (error) {
              if (error instanceof ValidationError) {
                return new Response(JSON.stringify(apiErrorBody(error.code, error.params)), {
                  status: error.status,
                  headers: { 'content-type': 'application/json' },
                });
              }
              throw error;
            }
          })()
          : await apiV2.fetch(subReq, c.env, { ...(c.executionCtx as any), isInternalMcp: true });
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

          const errMsg = name === 'account_delete' && response.status === 409
            ? `Error executing tool: ${accountInUseMessage(state.confirmedArgs.account_id, await countAccountRefs(c.env.DB, state.confirmedArgs.account_id))}`
            : `Error executing tool: ${errText}`;
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

        // DELETE /fx-rates/:code answers 204 with no body (the api.ts contract).
        // response.json() throws on an empty body — the client would see
        // isError even though the rate is already deleted. A 204 has no body by definition.
        const mutationData: Record<string, any> =
          response.status === 204 ? {} : ((await response.json()) as Record<string, any>);

        // MCP does not treat the mutation response as the source of truth. For new
        // planning writes, read the provider first through the same apiV2, and only
        // then record audit success and answer the client.
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

        if ((PURCHASE_WRITE_TOOLS as readonly string[]).includes(name)) {
          const listed = await providerGet('/purchase-orders');
          if (name === 'purchase_order_delete') {
            if (listed.orders?.some((order: { id: number }) => order.id === state.confirmedArgs.order_id)) {
              throw new Error('Provider read-back failed: purchase order still exists');
            }
          } else if (name === 'purchase_order_component_unlink') {
            const order = listed.orders?.find((item: { id: number }) => item.id === state.confirmedArgs.order_id);
            if (order?.components?.some((component: { id: number }) => component.id === state.confirmedArgs.component_id)) {
              throw new Error('Provider read-back failed: purchase order component still exists');
            }
          } else if (
            name === 'purchase_order_upsert'
            || name === 'purchase_order_update'
            || name === 'purchase_order_component_link'
            || name === 'purchase_order_component_update'
          ) {
            const orderId = data.order?.id ?? state.confirmedArgs.order_id;
            const order = listed.orders?.find((item: { id: number }) => item.id === orderId);
            if (!order) throw new Error('Provider read-back failed: purchase order not found');
            if (name === 'purchase_order_update') {
              for (const field of ['order_date', 'order_total_minor', 'order_total_currency', 'order_total_source', 'order_total_reference', 'note'] as const) {
                if (field in state.confirmedArgs && order[field] !== state.confirmedArgs[field]) {
                  throw new Error('Provider read-back failed: purchase order metadata was not saved');
                }
              }
            }
            if (name === 'purchase_order_component_link' && !order.components?.some((component: { id: number }) => component.id === data.component_id)) {
              throw new Error('Provider read-back failed: purchase order component not found');
            }
            if (name === 'purchase_order_component_update') {
              const component = order.components?.find((item: { id: number }) => item.id === state.confirmedArgs.component_id);
              if (!component) throw new Error('Provider read-back failed: purchase order component not found');
              if (state.confirmedArgs.component_type !== undefined && component.component_type !== state.confirmedArgs.component_type) {
                throw new Error('Provider read-back failed: component role was not saved');
              }
              if (typeof state.confirmedArgs.fiscal_receipt_id === 'string') {
                const parsed = canonicalizePfr(state.confirmedArgs.fiscal_receipt_id);
                if (!parsed.ok || component.pfr_canonical !== parsed.value) {
                  throw new Error('Provider read-back failed: component link was not saved');
                }
              }
            }
          }
          data = { ...data, ...(await verifyLedgerInvariant()) };
        }

        if ((RECEIPT_GROUP_WRITE_TOOLS as readonly string[]).includes(name)) {
          const listed = await providerGet('/receipt-groups');
          if (name === 'receipt_group_delete') {
            if (listed.groups?.some((group: { id: number }) => group.id === state.confirmedArgs.group_id)) {
              throw new Error('Provider read-back failed: receipt group still exists');
            }
          } else if (name === 'receipt_group_receipt_unlink') {
            const group = listed.groups?.find((item: { id: number }) => item.id === state.confirmedArgs.group_id);
            const removed = !group?.receipts?.some((receipt: { receipt_key: string }) => receipt.receipt_key === state.confirmedArgs.receipt_key);
            if (!removed) throw new Error('Provider read-back failed: receipt is still in the group');
          } else if (name === 'receipt_group_create') {
            const groupId = data.group?.id;
            const group = listed.groups?.find((item: { id: number }) => item.id === groupId);
            if (!group) throw new Error('Provider read-back failed: receipt group not found');
            const keys = new Set((state.confirmedArgs.receipt_keys as string[]).slice().sort());
            const stored = new Set((group.receipts as Array<{ receipt_key: string }>).map((receipt) => receipt.receipt_key));
            if (keys.size !== stored.size || [...keys].some((key) => !stored.has(key))) {
              throw new Error('Provider read-back failed: receipt group members do not match');
            }
          } else if (name === 'receipt_group_rename') {
            const group = listed.groups?.find((item: { id: number }) => item.id === state.confirmedArgs.group_id);
            if (!group) throw new Error('Provider read-back failed: receipt group not found');
            const typed = typeof state.confirmedArgs.name === 'string' ? state.confirmedArgs.name.trim() : '';
            if (typed) {
              if (group.place !== typed && group.name !== typed) {
                throw new Error('Provider read-back failed: receipt group title was not saved');
              }
            } else if (typeof group.place !== 'string' || group.place.trim().length === 0) {
              throw new Error('Provider read-back failed: receipt group place was not resolved');
            }
            const returned = new Set((data.group?.receipts as Array<{ receipt_key: string }> | undefined)?.map((receipt) => receipt.receipt_key));
            const stored = new Set((group.receipts as Array<{ receipt_key: string }>).map((receipt) => receipt.receipt_key));
            if (returned.size !== stored.size || [...returned].some((key) => !stored.has(key))) {
              throw new Error('Provider read-back failed: receipt group members do not match');
            }
          }
          data = { ...data, ...(await verifyLedgerInvariant()) };
        }

        // fx_rate_delete answers { success: true, ...WRITE_OUTPUT_COMMON } per outputSchema;
        // a 204 has no body, so success is filled in explicitly without touching the API contract.
        let written: Record<string, unknown> =
          name === 'statement_import_commit'
            ? { ...data, resultType: 'complete', written: data.written === true }
          : name === 'fx_rate_delete'
            ? { ...data, success: true, written: true, resultType: 'complete' }
            : name === 'data_reset'
              ? { ...data, success: true, reset: true, written: true, resultType: 'complete' }
            : name === 'account_delete'
              ? {
                  ...data, success: true, account_id: state.confirmedArgs.account_id,
                  deleted_account: accountDeleteSnapshot?.account ?? null,
                  removed_aliases: accountDeleteSnapshot?.aliases ?? [],
                  written: true, resultType: 'complete',
                }
            : name === 'transfer_delete'
              ? {
                  ...data, success: true, transfer_id: state.confirmedArgs.transfer_id,
                  deleted_legs: accountDeleteSnapshot?.legs ?? [],
                  written: true, resultType: 'complete',
                }
            : name === 'account_alias_delete'
              ? {
                  ...data, success: true, account_id: state.confirmedArgs.account_id, alias_id: state.confirmedArgs.alias_id,
                  deleted_alias: accountDeleteSnapshot?.alias ?? null,
                  written: true, resultType: 'complete',
                }
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
        if (!hasReadScope && !WRITE_CREATE_TOOLS.has(name) && !STATEMENT_MUTATION_TOOLS.has(name)) {
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
