type SqlValue = ArrayBuffer | string | number | null;

export type DemoLedgerStub = {
  ensureReady(): Promise<void>;
  ledgerQuery(sql: string, params: SqlValue[]): Promise<D1Result>;
  ledgerBatch(statements: { sql: string; params: SqlValue[] }[]): Promise<D1Result[]>;
  ledgerExec(sql: string): Promise<{ count: number; duration: number }>;
};

function bindValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (BigInt(asNumber) !== value) throw new Error('bind value exceeds the safe integer range');
    return asNumber;
  }
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new ArrayBuffer(view.byteLength);
    new Uint8Array(copy).set(view);
    return copy;
  }
  throw new Error('unsupported demo ledger bind value');
}

class DemoD1Statement {
  constructor(
    private readonly db: DemoD1Database,
    private readonly sqlText: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): DemoD1Statement {
    return new DemoD1Statement(this.db, this.sqlText, values.map(bindValue));
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const result = await this.db.perform(this.sqlText, this.params);
    const row = result.results[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName === undefined) return row as T;
    const value = row[colName];
    return (value === undefined ? null : value) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.perform(this.sqlText, this.params) as Promise<D1Result<T>>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const result = await this.db.perform(this.sqlText, this.params);
    const rows = result.results as Record<string, unknown>[];
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    const matrix = rows.map((row) => keys.map((key) => row[key]));
    if (options?.columnNames) return [keys, ...matrix] as T[];
    return matrix as T[];
  }

  toJSON(): { sql: string; params: SqlValue[] } {
    return { sql: this.sqlText, params: this.params };
  }
}

class DemoD1Database {
  constructor(private readonly stub: DemoLedgerStub) {}

  prepare(query: string): DemoD1Statement {
    return new DemoD1Statement(this, query);
  }

  async batch<T = unknown>(statements: DemoD1Statement[]): Promise<D1Result<T>[]> {
    const payload = statements.map((statement) => {
      if (!(statement instanceof DemoD1Statement)) {
        throw new Error('demo ledger batch received a foreign statement');
      }
      return statement.toJSON();
    });
    return this.stub.ledgerBatch(payload) as Promise<D1Result<T>[]>;
  }

  async exec(query: string): Promise<D1ExecResult> {
    return this.stub.ledgerExec(query);
  }

  async perform(sql: string, params: SqlValue[]): Promise<D1Result> {
    return this.stub.ledgerQuery(sql, params);
  }

  withSession(): D1Database {
    throw new Error('demo ledger does not use shared D1 sessions');
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('demo ledger dump is not available');
  }
}

export function createDemoD1(stub: DemoLedgerStub): D1Database {
  return new DemoD1Database(stub) as unknown as D1Database;
}
