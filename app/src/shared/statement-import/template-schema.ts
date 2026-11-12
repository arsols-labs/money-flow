import schemaDocument from './templates/statement-template.schema.json';
import type {
  CsvColumnMapping,
  CsvParseOptions,
  DescriptionFlag,
  StatementDateFormat,
  XlsHeaderAliases,
  XlsHeaderVariant,
  XlsLayout,
} from './types';

export const STATEMENT_TEMPLATE_SCHEMA_VERSION = 1;
export const STATEMENT_TEMPLATE_SCHEMA = schemaDocument;

export interface SchemaError {
  path: string;
  message: string;
}

export interface CsvTemplateLayout {
  mapping: CsvColumnMapping;
  options: CsvParseOptions;
}

export interface XlsTemplateLayout extends XlsLayout {
  headerAliases: XlsHeaderAliases;
  amountMode: 'credit-debit';
  currencyMode: 'per-row';
  headerVariants?: readonly XlsHeaderVariant[];
  accountAliases?: readonly string[];
}

export interface OfxTemplateLayout {
  defaultCurrency?: string;
}

export interface PdfTemplateLayout {
  textLayer: true;
  pageSize?: 'A4' | 'Letter' | 'any';
  headerRow?: number;
  columns?: XlsLayout['columns'];
}

export interface StatementTemplate {
  schemaVersion: 1;
  id: string;
  label: string;
  format: 'csv' | 'xls' | 'ofx' | 'pdf';
  csv?: CsvTemplateLayout;
  xls?: XlsTemplateLayout;
  ofx?: OfxTemplateLayout;
  pdf?: PdfTemplateLayout;
}

export type TemplateValidation =
  | { ok: true; value: StatementTemplate }
  | { ok: false; errors: SchemaError[] };

type JsonSchema = boolean | {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
  default?: unknown;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  not?: JsonSchema;
  $defs?: Record<string, JsonSchema>;
};

const ROOT = schemaDocument as unknown as JsonSchema;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function resolveRef(ref: string): JsonSchema | null {
  if (typeof ROOT === 'boolean' || !ref.startsWith('#/$defs/')) return null;
  return ROOT.$defs?.[ref.slice('#/$defs/'.length)] ?? null;
}

function joinPath(path: string, key: string): string {
  return `${path}/${key}`;
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: SchemaError[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path: path || '/', message: 'is not allowed' });
    return;
  }
  if (schema.$ref) {
    const target = resolveRef(schema.$ref);
    if (!target) {
      errors.push({ path: path || '/', message: `unknown schema reference ${schema.$ref}` });
      return;
    }
    validateNode(value, target, path, errors);
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push({ path: path || '/', message: `must be ${types.join(' or ')}` });
      return;
    }
  }
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push({ path: path || '/', message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(value, item))) {
    errors.push({
      path: path || '/',
      message: `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`,
    });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: path || '/', message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path: path || '/', message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: path || '/', message: `must match ${schema.pattern}` });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path: path || '/', message: `must be at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path: path || '/', message: `must be at most ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: path || '/', message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path: path || '/', message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(item, schema.items as JsonSchema, joinPath(path, String(index)), errors));
    }
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path: joinPath(path, key), message: 'is required' });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push({ path: joinPath(path, key), message: 'is not allowed' });
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(value[key], propertySchema, joinPath(path, key), errors);
      }
    }
  }
  for (const part of schema.allOf ?? []) validateNode(value, part, path, errors);
  if (schema.if) {
    const branch: SchemaError[] = [];
    validateNode(value, schema.if, path, branch);
    if (branch.length === 0) {
      if (schema.then) validateNode(value, schema.then, path, errors);
    } else if (schema.else) {
      validateNode(value, schema.else, path, errors);
    }
  }
  if (schema.not) {
    const forbidden: SchemaError[] = [];
    validateNode(value, schema.not, path, forbidden);
    if (forbidden.length === 0) {
      errors.push({ path: path || '/', message: 'is not allowed for this format' });
    }
  }
}

export function formatTemplateErrors(errors: readonly SchemaError[]): string {
  const shown = errors.slice(0, 12).map((error) => `${error.path || '/'} ${error.message}`);
  const extra = errors.length > 12 ? `; and ${errors.length - 12} more` : '';
  return `${shown.join('; ')}${extra}`;
}

export function validateStatementTemplate(input: unknown): TemplateValidation {
  const errors: SchemaError[] = [];
  validateNode(input, ROOT, '', errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as StatementTemplate };
}

export function isDescriptionFlag(value: DescriptionFlag): boolean {
  return value.id === 'possible_own_account_transfer' && value.pattern.trim().length > 0;
}

export function isStatementDateFormat(value: string): value is StatementDateFormat {
  return value === 'YYYY-MM-DD'
    || value === 'MM/DD/YYYY'
    || value === 'DD/MM/YYYY'
    || value === 'DD.MM.YYYY'
    || value === 'YYYY/MM/DD';
}
