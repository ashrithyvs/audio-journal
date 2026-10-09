import { MIGRATIONS, migrationChecksum, type Migration } from './migrations';
import type { SqlDatabase, SqlExecutor } from './SqlDatabase';

// Transactional migrations (LLD §3, §10 MIGRATION_FAILED). All pending
// migrations apply in one transaction: the database ends fully migrated or
// exactly as it was. Nothing is deleted to make a migration succeed.

export type MigrationFailure =
  | 'INVALID_DEFINITIONS'
  | 'DOWNGRADE_UNSUPPORTED'
  | 'HISTORY_MISMATCH'
  | 'STEP_FAILED'
  | 'FOREIGN_KEY_VIOLATION';

export class MigrationError extends Error {
  constructor(readonly failure: MigrationFailure, readonly version?: number) {
    super(
      version === undefined
        ? `MIGRATION_FAILED: ${failure}`
        : `MIGRATION_FAILED: ${failure} at ${version}`,
    );
    this.name = 'MigrationError';
  }
}

export interface MigrationReport {
  from: number;
  to: number;
  applied: number[];
}

const HISTORY_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT`;

function checkDefinitions(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || migration.statements.length === 0) {
      throw new MigrationError('INVALID_DEFINITIONS', migration.version);
    }
  });
}

async function readHistory(tx: SqlExecutor) {
  return tx.all<{ version: number; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
}

export async function migrate(
  db: SqlDatabase,
  now: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationReport> {
  checkDefinitions(migrations);
  return db.transaction(async tx => {
    await tx.run(HISTORY_TABLE);
    const history = await readHistory(tx);
    history.forEach((row, index) => {
      const known = migrations[index];
      if (row.version !== index + 1) {
        throw new MigrationError('HISTORY_MISMATCH', row.version);
      }
      if (!known) {
        throw new MigrationError('DOWNGRADE_UNSUPPORTED', row.version);
      }
      if (
        row.name !== known.name ||
        row.checksum !== migrationChecksum(known)
      ) {
        throw new MigrationError('HISTORY_MISMATCH', row.version);
      }
    });

    const applied: number[] = [];
    for (const migration of migrations.slice(history.length)) {
      try {
        for (const statement of migration.statements) {
          await tx.run(statement);
        }
      } catch {
        // The adapter rolls the whole transaction back.
        throw new MigrationError('STEP_FAILED', migration.version);
      }
      await tx.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [migration.version, migration.name, migrationChecksum(migration), now],
      );
      applied.push(migration.version);
    }

    const violations = await tx.all('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw new MigrationError('FOREIGN_KEY_VIOLATION');
    }
    return { from: history.length, to: migrations.length, applied };
  });
}

export async function schemaVersion(db: SqlDatabase): Promise<number> {
  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (!table) {
    return 0;
  }
  const row = await db.get<{ version: number | null }>(
    'SELECT max(version) AS version FROM schema_migrations',
  );
  return row?.version ?? 0;
}
