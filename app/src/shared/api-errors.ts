// Machine-readable API error contract (issue #513).
//
// 4xx/5xx JSON is always:
//   { "error": { "code": "ACCOUNT_NOT_FOUND", "message": "Account not found" } }
//
// `message` is English for logs, MCP forwarding, and clients without i18n.
// The UI maps `code` (and optional `params`) through locales/*.json.

export const API_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_JSON',
  'INVALID_CREDENTIALS',
  'VALIDATION_FAILED',
  'OPERATION_FAILED',
  'NO_PATCH_FIELDS',
  'CONCURRENT_UPDATE',

  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_LOCKED',
  'ACCOUNT_IN_USE',
  'ACCOUNT_CURRENCY_CHANGE_REQUIRES_BALANCE',
  'FROM_ACCOUNT_NOT_FOUND',
  'TO_ACCOUNT_NOT_FOUND',
  'ACCOUNTS_MUST_DIFFER',
  'QUERY_REQUIRED',
  'ACCOUNT_ID_REQUIRED',

  'ALIAS_TEXT_REQUIRED',
  'ALIAS_ALREADY_BOUND',
  'ALIAS_NOT_FOUND',
  'PENDING_ACCOUNT_RESOLVED',

  'CURRENCY_CODE_INVALID',
  'BASE_CURRENCY_RATE_FORBIDDEN',
  'RATE_REQUIRED',
  'RATE_INVALID',
  'RATE_ZERO',
  'RATE_TOO_LARGE',
  'RATE_SAVE_FAILED',
  'RATE_IN_USE',

  'PLANNED_ITEM_STALE',
  'PLANNED_ITEM_ALREADY_FULFILLED',
  'PLANNED_ITEM_ALREADY_DONE_UNLINKED',
  'PLANNED_ITEM_LINKED_FACT',
  'PLANNED_CURRENCY_MISMATCH',
  'TRANSFER_CANNOT_FULFILL_PLANNED',

  'OPERATION_NOT_FOUND',
  'OPERATION_ALREADY_CLAIMED',
  'OPERATIONS_NOT_FOUND',
  'OPERATIONS_ALREADY_CLAIMED',
  'OPERATION_LINKED_EXPECTATION',
  'OPERATION_FULFILLS_RECURRING',
  'FULFILLMENT_CONFLICT',
  'FULFILLMENT_KIND_MISMATCH',
  'FULFILLMENT_ACCOUNT_MISMATCH',
  'FULFILLMENT_CURRENCY_MISMATCH',
  'FULFILLMENT_AMOUNT_MISMATCH',
  'FULFILLMENT_DATE_MISMATCH',
  'FULFILLMENT_CATEGORY_MISMATCH',
  'FULFILLMENT_SIGN_MISMATCH',
  'FULFILLMENT_EVIDENCE_AMOUNT_MISMATCH',

  'RECURRING_ITEM_STALE',
  'RECURRING_ITEM_INACTIVE_CLOSE',
  'RECURRING_ITEM_INACTIVE_FULFILL',
  'RECURRING_ITEM_INACTIVE_SKIP',
  'RECURRING_PERIOD_ALREADY_CLOSED',
  'RECURRING_OCCURRENCE_ALREADY_FULFILLED',
  'RECURRING_PERIOD_MISMATCH',
  'RECURRING_PERIOD_ALREADY_RESOLVED',
  'RECURRING_PERIOD_FULFILLMENT_NOT_FOUND',
  'ANALYTICAL_RECURRING_SKIP_ONLY',
  'DUPLICATE_EXPENSE',
  'INVALID_RECURRING_ITEM_ID',
  'TRANSFER_CANNOT_FULFILL_RECURRING',
  'RECURRING_CURRENCY_MISMATCH',
  'RECURRING_END_BEFORE_NEXT',

  'TRANSFER_NOT_FOUND',
  'TRANSFER_CORRUPT',
  'TRANSFER_VIA_OPERATIONS_FORBIDDEN',
  'TRANSFER_FIELDS_ATOMIC',
  'TRANSFER_AMOUNTS_NONZERO',
  'TRANSFER_FROM_CURRENCY_CHANGE_REQUIRES_AMOUNT',
  'TRANSFER_TO_CURRENCY_CHANGE_REQUIRES_AMOUNT',

  'CURRENCY_CHANGE_REQUIRES_AMOUNT',
  'AMOUNT_MUST_BE_NEGATIVE',
  'AMOUNT_MUST_BE_POSITIVE',
  'FIELD_REQUIRED',
  'FIELD_EMPTY',
  'FIELD_TYPE_STRING',
  'FIELD_TYPE_STRING_OR_NULL',
  'FIELD_TYPE_BOOLEAN',
  'FIELD_TYPE_INTEGER_MINOR',
  'FIELD_NOT_ZERO',
  'INVALID_ISO_DATE',
  'INVALID_CALENDAR_DATE',
  'INVALID_CURRENCY',
  'INVALID_SORT',
  'INVALID_KIND',
  'INVALID_FREQUENCY',
  'INVALID_INTERVAL_COUNT',
  'INVALID_RANGE',
  'INVALID_SOURCE',
  'INVALID_RECEIPT_URL',
  'INVALID_FISCAL_RECEIPT_ID',
  'SUBCATEGORY_REQUIRES_CATEGORY',
  'SOURCE_NOT_SETTABLE',
  'RECEIPT_ID_NOT_SETTABLE',
  'PLANNED_ITEM_ID_NOT_SETTABLE',
  'RECURRING_ITEM_ID_NOT_SETTABLE',
  'TRANSFER_ID_NOT_SETTABLE',
  'FREQUENCY_DAY_FORBIDDEN',
  'FREQUENCY_MONTH_FORBIDDEN',
  'FREQUENCY_MONTH_YEARLY_ONLY',
  'FREQUENCY_DAY_REQUIRED',
  'FREQUENCY_MONTH_DERIVED',
  'OPERATION_IDS_INVALID',
  'OPERATION_IDS_DUPLICATE',
  'EVIDENCE_QUANTITY_INVALID',
  'DAYS_INVALID',
  'SETTING_VALUE_INVALID',
  'SETTING_VALUE_TOO_LARGE',
  'SETTING_CURRENCY_INVALID',
  'DATE_RANGE_INVALID',
  'REQUEST_BODY_INVALID',

  'PASSKEY_NOT_FOUND',
  'PASSKEY_OPTIONS_FAILED',
  'PASSKEY_RESPONSE_REQUIRED',
  'PASSKEY_VERIFICATION_FAILED',
  'PASSKEY_LABEL_EMPTY',
  'PASSKEY_LABEL_TOO_LONG',
  'PASSKEY_CONFIRM_LAST',
  'PASSKEY_LIMIT_REACHED',
  'PASSKEY_CHALLENGE_EXPIRED',
  'PASSKEY_NOT_REGISTERED',
  'DEMO_PASSKEY_DISABLED',
  'DEMO_LEDGER_UNAVAILABLE',
  'STEP_UP_REQUIRED',

  'NAME_REQUIRED',
  'TOKEN_ID_REQUIRED',
  'CLIENT_ID_REQUIRED',
  'OAUTH_REVOKE_FAILED',
  'OAUTH_GRANT_RECORD_FAILED',
  'FILTER_TOO_LARGE',
  'FILTER_ITEM_TOO_LONG',
  'BALANCE_OUT_OF_SAFE_RANGE',
  'LEDGER_EFFECT_MISSING',
  'AMOUNT_OUT_OF_SAFE_RANGE',
  'RATE_LIMITED',
  'CSRF_ORIGIN_INVALID',
  'CSRF_REQUEST_REJECTED',
  'CONTENT_TYPE_INVALID',
  'LOGOUT_REVOKE_FAILED',
  'SESSION_STORE_UNAVAILABLE',

  'BACKUP_CONFIRM_REQUIRED',
  'BACKUP_FORMAT_INVALID',
  'BACKUP_VERSION_UNSUPPORTED',
  'BACKUP_TABLE_INVALID',
  'BACKUP_ROW_INVALID',
  'BACKUP_REFERENCE_INVALID',
  'BACKUP_IMPORT_FAILED',

  'RESET_CONFIRM_REQUIRED',
  'RESET_PHRASE_REQUIRED',
  'RESET_FAILED',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiErrorParams = Record<string, string | number>;

export type ApiErrorPayload = {
  code: string;
  message: string;
  params?: ApiErrorParams;
};

export type ApiErrorBody = {
  error: ApiErrorPayload;
};

export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  INVALID_JSON: 'Invalid JSON',
  INVALID_CREDENTIALS: 'Invalid credentials',
  VALIDATION_FAILED: 'Validation failed',
  OPERATION_FAILED: 'Operation failed',
  NO_PATCH_FIELDS: 'Provide at least one known field to update',
  CONCURRENT_UPDATE: 'The record changed concurrently; refresh and try again',

  ACCOUNT_NOT_FOUND: 'Account not found',
  ACCOUNT_LOCKED:
    'This account is already used by operations, planned items, or recurring rules — owner, currency, country, bank, and type can no longer change. Create a new account and move the balance',
  ACCOUNT_IN_USE:
    'This account is used by operations, planned items, or recurring payments — change those first or archive the account',
  ACCOUNT_CURRENCY_CHANGE_REQUIRES_BALANCE:
    'Changing currency changes the meaning of the balance — send balance_minor in the new currency in the same request',
  FROM_ACCOUNT_NOT_FOUND: 'Source account not found',
  TO_ACCOUNT_NOT_FOUND: 'Destination account not found',
  ACCOUNTS_MUST_DIFFER: 'Source and destination accounts must be different',
  QUERY_REQUIRED: 'Query parameter q (source account) is required',
  ACCOUNT_ID_REQUIRED: 'account_id is required and must be a number',

  ALIAS_TEXT_REQUIRED: 'alias_text is required and cannot be empty',
  ALIAS_ALREADY_BOUND: 'This alias is already bound to an account',
  ALIAS_NOT_FOUND: 'Alias not found on this account',
  PENDING_ACCOUNT_RESOLVED: 'Unknown account is already processed or does not exist',

  CURRENCY_CODE_INVALID: 'Currency code must be exactly three Latin letters (ISO 4217), for example USD',
  BASE_CURRENCY_RATE_FORBIDDEN:
    'A USD rate is not needed: all rates are stored as usd_per_unit, so 1 USD = 1 USD by definition. Delete the row if it already exists',
  RATE_REQUIRED: 'Send the rate in the rate field',
  RATE_INVALID:
    'Invalid FX rate "{{value}}" — expected a non-negative decimal with at most nine fraction digits, no exponent, and no sign',
  RATE_ZERO: 'Rate cannot be zero',
  RATE_TOO_LARGE: 'Rate is too large — check that the conversion direction is not reversed',
  RATE_SAVE_FAILED: 'Could not save the rate',
  RATE_IN_USE:
    'Currency {{code}} is used by accounts or operations — their amounts cannot be converted without a rate. Change the currency on those rows or delete them first',

  PLANNED_ITEM_STALE: 'The planned item changed after confirmation; request a new confirmation',
  PLANNED_ITEM_ALREADY_FULFILLED: 'The planned item is already fulfilled by another financial fact',
  PLANNED_ITEM_ALREADY_DONE_UNLINKED: 'The planned item is already marked done without an available link',
  PLANNED_ITEM_LINKED_FACT:
    'The planned item is linked to an independent financial fact; reopen it before changing: {{fields}}',
  PLANNED_CURRENCY_MISMATCH:
    'A planned item can be marked done only when its currency matches the account currency ({{accountCurrency}}); it is currently {{plannedCurrency}}',
  TRANSFER_CANNOT_FULFILL_PLANNED: 'A transfer cannot fulfill a planned item',

  OPERATION_NOT_FOUND: 'Operation not found',
  OPERATION_ALREADY_CLAIMED: 'The operation already fulfills another expectation',
  OPERATIONS_NOT_FOUND: 'One or more operations were not found',
  OPERATIONS_ALREADY_CLAIMED: 'One or more operations already fulfill another expectation',
  OPERATION_LINKED_EXPECTATION:
    'The operation is linked to an expectation; unlink it before changing: {{fields}}',
  OPERATION_FULFILLS_RECURRING:
    'The operation fulfills a recurring occurrence of rule ID {{recurringItemId}}; cancel that period fulfillment first',
  FULFILLMENT_CONFLICT: 'The operation or planned item was linked concurrently',
  FULFILLMENT_KIND_MISMATCH: 'Operation kind does not match the planned or recurring item',
  FULFILLMENT_ACCOUNT_MISMATCH: 'Operation account does not match the planned or recurring item',
  FULFILLMENT_CURRENCY_MISMATCH: 'Operation currency does not match the planned or recurring item',
  FULFILLMENT_AMOUNT_MISMATCH: 'Operation amount does not match the planned item',
  FULFILLMENT_DATE_MISMATCH: 'Operation date does not match the planned or recurring item',
  FULFILLMENT_CATEGORY_MISMATCH: 'Operation category does not match the planned or recurring item',
  FULFILLMENT_SIGN_MISMATCH: 'Operation sign does not match the recurring rule',
  FULFILLMENT_EVIDENCE_AMOUNT_MISMATCH:
    'The operation group total does not match the recurring rule amount × evidence_quantity',

  RECURRING_ITEM_STALE: 'The recurring rule changed after confirmation; request a new confirmation',
  RECURRING_ITEM_INACTIVE_CLOSE: 'An inactive recurring rule cannot be closed',
  RECURRING_ITEM_INACTIVE_FULFILL: 'An inactive recurring rule cannot be fulfilled',
  RECURRING_ITEM_INACTIVE_SKIP: 'An inactive recurring rule cannot be advanced',
  RECURRING_PERIOD_ALREADY_CLOSED: 'This recurring-rule period is already closed',
  RECURRING_OCCURRENCE_ALREADY_FULFILLED: 'This recurring occurrence already has another fulfillment',
  RECURRING_PERIOD_MISMATCH: 'period_due_date does not match the current recurring-rule occurrence',
  RECURRING_PERIOD_ALREADY_RESOLVED: 'This recurring-rule period is already fulfilled or skipped',
  RECURRING_PERIOD_FULFILLMENT_NOT_FOUND: 'No recurring period fulfillment exists for this rule and date',
  ANALYTICAL_RECURRING_SKIP_ONLY:
    'Analytical recurring rule {{recurringItemId}} accepts skip_period only',
  DUPLICATE_EXPENSE: 'This expense looks like a duplicate of operation {{existingOperationId}}',
  INVALID_RECURRING_ITEM_ID: 'Invalid recurring_item_id',
  TRANSFER_CANNOT_FULFILL_RECURRING: 'A transfer cannot fulfill a recurring occurrence',
  RECURRING_CURRENCY_MISMATCH:
    'A period can be closed only when the rule currency matches the account currency ({{accountCurrency}}); it is currently {{ruleCurrency}}',
  RECURRING_END_BEFORE_NEXT: 'end_date cannot be earlier than next_due_date',

  TRANSFER_NOT_FOUND: 'Transfer not found',
  TRANSFER_CORRUPT: 'Transfer is corrupt — exactly two operations are required',
  TRANSFER_VIA_OPERATIONS_FORBIDDEN: 'Create a transfer via /api/v2/transfers, not directly via /operations',
  TRANSFER_FIELDS_ATOMIC: 'Transfer amount, account, and kind cannot be changed separately — delete the transfer and create it again',
  TRANSFER_AMOUNTS_NONZERO: 'Transfer amounts cannot be zero',
  TRANSFER_FROM_CURRENCY_CHANGE_REQUIRES_AMOUNT:
    'Changing the account changes the debit currency from {{fromCurrency}} to {{toCurrency}} — send from_amount_minor in the new currency',
  TRANSFER_TO_CURRENCY_CHANGE_REQUIRES_AMOUNT:
    'Changing the account changes the credit currency from {{fromCurrency}} to {{toCurrency}} — send to_amount_minor in the new currency',

  CURRENCY_CHANGE_REQUIRES_AMOUNT:
    'Changing currency changes the meaning of the amount — send amount_minor in the new currency in the same request',
  AMOUNT_MUST_BE_NEGATIVE: '{{kind}} decreases the balance — amount_minor must be negative',
  AMOUNT_MUST_BE_POSITIVE: '{{kind}} increases the balance — amount_minor must be positive',
  FIELD_REQUIRED: '{{field}} is required',
  FIELD_EMPTY: '{{field}} cannot be empty',
  FIELD_TYPE_STRING: '{{field}} must be a string',
  FIELD_TYPE_STRING_OR_NULL: '{{field}} must be a string or null',
  FIELD_TYPE_BOOLEAN: '{{field}} must be true or false',
  FIELD_TYPE_INTEGER_MINOR: '{{field}} must be an integer in minor currency units',
  FIELD_NOT_ZERO: '{{field}} cannot be zero — an operation without an amount is meaningless',
  INVALID_ISO_DATE: '{{field}} is required and must be a YYYY-MM-DD string',
  INVALID_CALENDAR_DATE: '{{field}}: calendar date "{{value}}" does not exist',
  INVALID_CURRENCY: 'currency must be exactly three Latin letters (ISO 4217), for example USD',
  INVALID_SORT: 'sort must be an integer within ±1 000 000 000',
  INVALID_KIND: 'kind is required and must be one of: {{values}}',
  INVALID_FREQUENCY: 'frequency is required and must be one of: {{values}}',
  INVALID_INTERVAL_COUNT: 'interval_count must be an integer from 1 to 365',
  INVALID_RANGE: '{{field}} must be an integer from {{min}} to {{max}} or omitted',
  INVALID_SOURCE: 'source must be "manual", "receipt", or "agent"',
  INVALID_RECEIPT_URL: 'receipt_url must be an http or https URL of at most 4096 characters',
  INVALID_FISCAL_RECEIPT_ID: 'fiscal_receipt_id must be at most 128 characters (PFR / fiscal document id; do not put it in item)',
  SUBCATEGORY_REQUIRES_CATEGORY: 'subcategory without category is meaningless — set a category or remove the subcategory',
  SOURCE_NOT_SETTABLE: 'source cannot be set from a browser session — only the internal MCP write path may record source = "agent"',
  RECEIPT_ID_NOT_SETTABLE: 'receipt_id cannot be set here: receipt lines are created by receipt parsing (S2), not manual entry',
  PLANNED_ITEM_ID_NOT_SETTABLE: 'planned_item_id cannot be set here: marking a plan done creates the operation',
  RECURRING_ITEM_ID_NOT_SETTABLE: 'recurring_item_id cannot be set here: closing a period creates the operation',
  TRANSFER_ID_NOT_SETTABLE: 'transfer_id cannot be set here: create a transfer via /api/v2/transfers',
  FREQUENCY_DAY_FORBIDDEN: 'day_of_month must be empty for daily/weekly frequency — those rules have no day of month',
  FREQUENCY_MONTH_FORBIDDEN: 'month_of_year must be empty for daily/weekly frequency',
  FREQUENCY_MONTH_YEARLY_ONLY: 'month_of_year must be empty for monthly frequency — only yearly rules have it',
  FREQUENCY_DAY_REQUIRED: 'day_of_month is required for frequency {{frequency}}',
  FREQUENCY_MONTH_DERIVED:
    'A yearly rule month_of_year is taken from next_due_date (month {{month}}) — send a matching value or omit it',
  OPERATION_IDS_INVALID: 'operation_ids must be a non-empty array of at most 100 IDs',
  OPERATION_IDS_DUPLICATE: 'operation_ids must not contain duplicates',
  EVIDENCE_QUANTITY_INVALID: 'evidence_quantity must be from 1 to 100',
  DAYS_INVALID: 'days must be an integer from 1 to 366',
  SETTING_VALUE_INVALID: 'value must be an integer >= 0',
  SETTING_VALUE_TOO_LARGE: 'value is too large',
  SETTING_CURRENCY_INVALID: 'value must be a valid ISO 4217 currency code',
  DATE_RANGE_INVALID: 'start_date cannot be later than end_date',
  REQUEST_BODY_INVALID: 'Request body must be a JSON object',

  PASSKEY_NOT_FOUND: 'Passkey not found',
  PASSKEY_OPTIONS_FAILED: 'Could not generate registration options',
  PASSKEY_RESPONSE_REQUIRED: 'Missing response parameter',
  PASSKEY_VERIFICATION_FAILED: 'Passkey verification failed',
  PASSKEY_LABEL_EMPTY: 'Device name cannot be empty',
  PASSKEY_LABEL_TOO_LONG: 'Name is too long (maximum 64 characters)',
  PASSKEY_CONFIRM_LAST:
    'This is the last active passkey. The next sign-in will require your SETUP_TOKEN. Confirm the action',
  PASSKEY_LIMIT_REACHED: 'Limit reached: maximum 10 passkeys',
  PASSKEY_CHALLENGE_EXPIRED: 'Challenge expired — try again',
  PASSKEY_NOT_REGISTERED: 'No passkey is registered — start with /setup/passkey',
  DEMO_PASSKEY_DISABLED: 'Passkey enrollment is disabled on the public demo',
  DEMO_LEDGER_UNAVAILABLE: 'The demo ledger is unavailable',
  STEP_UP_REQUIRED: 'Confirm with an existing passkey or SETUP_TOKEN before changing login factors',

  NAME_REQUIRED: 'name is required',
  TOKEN_ID_REQUIRED: 'tokenId is required',
  CLIENT_ID_REQUIRED: 'clientId is required',
  OAUTH_REVOKE_FAILED:
    'Could not revoke the OAuth grant in provider storage — the token was not marked revoked',
  OAUTH_GRANT_RECORD_FAILED: 'Could not record the OAuth grant — authorization was cancelled',
  FILTER_TOO_LARGE: 'Analytics filter is too large',
  FILTER_ITEM_TOO_LONG: 'Analytics filter value is too long',
  BALANCE_OUT_OF_SAFE_RANGE: 'The resulting balance is outside the safe integer range',
  LEDGER_EFFECT_MISSING: 'The financial mutation did not apply its ledger effect',
  AMOUNT_OUT_OF_SAFE_RANGE: 'Monetary total "{{field}}" is outside the safe integer range',
  RATE_LIMITED: 'Too many requests — try again later',
  CSRF_ORIGIN_INVALID: 'Request origin is not the application origin',
  CSRF_REQUEST_REJECTED: 'Cross-site mutation is not allowed',
  CONTENT_TYPE_INVALID: 'Send application/json for this request',
  LOGOUT_REVOKE_FAILED: 'Could not revoke the session — try again',
  SESSION_STORE_UNAVAILABLE: 'Session store is unavailable',

  BACKUP_CONFIRM_REQUIRED:
    'Restore replaces all user data — send confirm: true after the UI warning',
  BACKUP_FORMAT_INVALID: 'Not a Money Flow v2 backup file',
  BACKUP_VERSION_UNSUPPORTED: 'This backup version is not supported',
  BACKUP_TABLE_INVALID: 'Backup table "{{table}}" is missing or not an array',
  BACKUP_ROW_INVALID: 'Backup row {{index}} in {{table}} has an invalid {{field}}',
  BACKUP_REFERENCE_INVALID: 'Backup {{table}}.{{field}} references missing {{value}}',
  BACKUP_IMPORT_FAILED: 'Could not restore the backup',

  RESET_CONFIRM_REQUIRED:
    'Reset wipes all financial data — send confirm: true after the UI warning',
  RESET_PHRASE_REQUIRED: 'Type RESET to confirm wiping all financial data',
  RESET_FAILED: 'Could not reset the instance',
};

const CODE_SET = new Set<string>(API_ERROR_CODES);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

export function interpolateApiErrorMessage(template: string, params?: ApiErrorParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    params[key] === undefined ? `{{${key}}}` : String(params[key]),
  );
}

export function apiErrorMessage(code: ApiErrorCode, params?: ApiErrorParams): string {
  return interpolateApiErrorMessage(API_ERROR_MESSAGES[code], params);
}

export function apiErrorPayload(code: ApiErrorCode, params?: ApiErrorParams): ApiErrorPayload {
  const message = apiErrorMessage(code, params);
  return params ? { code, message, params } : { code, message };
}

export function apiErrorBody(code: ApiErrorCode, params?: ApiErrorParams): ApiErrorBody {
  return { error: apiErrorPayload(code, params) };
}

/** Domain error with a stable code and HTTP status. Worker routes map this to the envelope. */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly params?: ApiErrorParams;

  constructor(code: ApiErrorCode, status: number, params?: ApiErrorParams) {
    super(apiErrorMessage(code, params));
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.params = params;
  }
}

export function parseApiError(body: unknown): ApiErrorPayload | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (typeof code === 'string' && typeof message === 'string') {
      const params = (error as { params?: unknown }).params;
      return {
        code,
        message,
        ...(params && typeof params === 'object' && !Array.isArray(params)
          ? { params: params as ApiErrorParams }
          : {}),
      };
    }
  }
  if (typeof error === 'string' && error.length > 0) {
    return { code: 'OPERATION_FAILED', message: error };
  }
  return null;
}
