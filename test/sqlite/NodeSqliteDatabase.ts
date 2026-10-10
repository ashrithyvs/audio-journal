import { DatabaseSync } from 'node:sqlite';

import {
  SerialSqlDatabase,
  type SqlDriver,
} from '../../src/platform/storage/SerialSqlDatabase';
import type { SqlRow, SqlValue } from '../../src/platform/storage/SqlDatabase';

// Test-only driver over Node's built-in SQLite (no extra dependency). It is
// real SQLite with the production schema, constraints, and triggers, but not
// SQLCipher: encryption at rest is proven by the native driver's own tests.
// Serialization and transactions come from the production SerialSqlDatabase.

function nodeSqliteDriver(location: string): SqlDriver {
  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON');
  if (location !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  return {
    run: async (sql, params) => {
      const result = db.prepare(sql).run(...(params as SqlValue[]));
      return { changes: Number(result.changes) };
    },
    all: async (sql, params) =>
      db.prepare(sql).all(...(params as SqlValue[])) as SqlRow[],
    begin: async () => {
      db.exec('BEGIN IMMEDIATE');
    },
    commit: async () => {
      db.exec('COMMIT');
    },
    rollback: async () => {
      db.exec('ROLLBACK');
    },
    close: async () => {
      db.close();
    },
  };
}

export class NodeSqliteDatabase extends SerialSqlDatabase {
  constructor(location = ':memory:') {
    super(nodeSqliteDriver(location));
  }
}
