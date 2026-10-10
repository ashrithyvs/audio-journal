import type { SqlDatabase, SqlExecutor, SqlRow, SqlValue } from './SqlDatabase';

// One implementation of the SqlDatabase contract for every driver: work is
// serialized, so nothing interleaves with an open transaction, and a failed
// transaction rolls back before its error is rethrown. Drivers only execute.

export interface SqlDriver {
  run(sql: string, params: readonly SqlValue[]): Promise<{ changes: number }>;
  all(sql: string, params: readonly SqlValue[]): Promise<SqlRow[]>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export class SerialSqlDatabase implements SqlDatabase {
  private queue: Promise<unknown> = Promise.resolve();
  private open = true;

  constructor(private readonly driver: SqlDriver) {}

  private readonly direct: SqlExecutor = {
    run: (sql, params = []) => this.driver.run(sql, params),
    all: async <T extends SqlRow>(
      sql: string,
      params: readonly SqlValue[] = [],
    ) => (await this.driver.all(sql, params)) as T[],
    get: async <T extends SqlRow>(
      sql: string,
      params: readonly SqlValue[] = [],
    ) => ((await this.driver.all(sql, params)) as T[])[0],
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
      await this.driver.begin();
      try {
        const result = await work(this.direct);
        await this.driver.commit();
        return result;
      } catch (error) {
        await this.driver.rollback();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.open = false;
      await this.driver.close();
    }).catch(() => undefined);
  }
}
