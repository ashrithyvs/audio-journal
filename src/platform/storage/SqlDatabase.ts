// SQL port for the encrypted journal database (ADR-007, ADR-017). The
// production adapter is a native SQLCipher binding that holds the database key
// natively; tests use a plain SQLite adapter. Adapters must:
// - enable `PRAGMA foreign_keys = ON` before any statement;
// - serialize work so nothing interleaves with an open transaction;
// - roll back a transaction whose callback throws, then rethrow.

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlExecutor {
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;
  get<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T | undefined>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
