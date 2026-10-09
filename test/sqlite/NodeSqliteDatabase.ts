import { DatabaseSync } from 'node:sqlite';

import type {
  SqlDatabase,
  SqlExecutor,
  SqlRow,
  SqlValue,
} from '../../src/platform/storage/SqlDatabase';

// Test-only adapter over Node's built-in SQLite (no extra dependency). It is
// real SQLite with the production schema, constraints, and triggers, but not
// SQLCipher: encryption at rest is proven by the native adapter's own tests.

export class NodeSqliteDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private open = true;

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA foreign_keys = ON');
    if (location !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
  }

  private readonly direct: SqlExecutor = {
    run: async (sql, params = []) => {
      const result = this.db.prepare(sql).run(...(params as SqlValue[]));
      return { changes: Number(result.changes) };
    },
    all: async <T extends SqlRow>(
      sql: string,
      params: readonly SqlValue[] = [],
    ) => this.db.prepare(sql).all(...(params as SqlValue[])) as T[],
    get: async <T extends SqlRow>(
      sql: string,
      params: readonly SqlValue[] = [],
    ) => this.db.prepare(sql).get(...(params as SqlValue[])) as T | undefined,
  };

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (!this.open) {
        throw new Error('database is closed');
      }
      return work();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  run(sql: string, params?: readonly SqlValue[]) {
    return this.enqueue(() => this.direct.run(sql, params));
  }

  all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) {
    return this.enqueue(() => this.direct.all<T>(sql, params));
  }

  get<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) {
    return this.enqueue(() => this.direct.get<T>(sql, params));
  }

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(this.direct);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.open = false;
      this.db.close();
    }).catch(() => undefined);
  }
}
