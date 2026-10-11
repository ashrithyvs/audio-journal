import type { IdSource } from '../../features/journal/domain/ids';
import {
  canonicalJson,
  CONTRACT,
  type NamedItem,
  type OrganizeItem,
  type OrganizeOutput,
  type SourceRef,
} from '../../features/organize/domain/contract';
import type {
  DerivationRepository,
  DerivedTask,
  StoredDerivation,
  ValidatedResult,
} from '../../features/organize/ports/DerivationRepository';
import type { SqlDatabase, SqlExecutor } from './SqlDatabase';

// journal.organize@1 persistence (contract §7, migration 3). One transaction
// writes the derivation, its scope, its tasks, and every source reference;
// the triggers keep them immutable except for a task's state.

type DerivationRow = {
  id: string;
  request_key: string;
  engine_id: string;
  engine_version: string;
  revision: number;
  payload: string;
  created_at: number;
};
type TaskRow = {
  id: string;
  ordinal: number;
  text: string;
  area: DerivedTask['area'];
  state: DerivedTask['state'];
};

/** Thrown to roll a rehearsal back; never escapes rehearseSave. */
const REHEARSAL = new Error('rehearsal');

type ItemKind =
  | 'summary'
  | 'work'
  | 'personal'
  | 'task'
  | 'idea'
  | 'person'
  | 'project';

/** Every cited item with its stored kind and ordinal, in document order. */
function citedItems(
  output: OrganizeOutput,
): Array<{ kind: ItemKind; ordinal: number; sources: SourceRef[] }> {
  const items: Array<{
    kind: ItemKind;
    ordinal: number;
    sources: SourceRef[];
  }> = [];
  const add = (
    kind: ItemKind,
    list: ReadonlyArray<OrganizeItem | NamedItem> | undefined,
  ) =>
    list?.forEach((item, ordinal) =>
      items.push({ kind, ordinal, sources: item.sources }),
    );
  if (output.summary) add('summary', [output.summary]);
  for (const section of output.sections ?? []) add(section.area, section.items);
  add('task', output.tasks);
  add('idea', output.ideas);
  add('person', output.people);
  add('project', output.projects);
  return items;
}

export class SqliteDerivationRepository implements DerivationRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly ids: IdSource,
  ) {}

  async requestKeySecret(generateHex: () => string): Promise<string> {
    return this.db.transaction(async tx => {
      const row = await tx.get<{ key_hex: string }>(
        'SELECT key_hex FROM organize_secret WHERE id = 1',
      );
      if (row) {
        return row.key_hex;
      }
      const key = generateHex();
      await tx.run('INSERT INTO organize_secret (id, key_hex) VALUES (1, ?)', [
        key,
      ]);
      return key;
    });
  }

  findByRequestKey(requestKey: string): Promise<StoredDerivation | undefined> {
    return this.load(
      this.db,
      'SELECT * FROM derivations WHERE request_key = ?',
      [requestKey],
    );
  }

  latestForEntry(entryId: string): Promise<StoredDerivation | undefined> {
    return this.load(
      this.db,
      `SELECT d.* FROM derivations d
        JOIN derivation_entries s ON s.derivation_id = d.id
        WHERE s.entry_id = ?
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
      [entryId],
    );
  }

  async saveValidated(
    result: ValidatedResult,
  ): Promise<{ derivation: StoredDerivation; duplicate: boolean }> {
    const { input } = result;
    return this.db.transaction(async tx => {
      const existing = await this.load(
        tx,
        'SELECT * FROM derivations WHERE request_key = ?',
        [input.requestKey],
      );
      if (existing) {
        return { derivation: existing, duplicate: true };
      }
      const id = await this.write(tx, result);
      const stored = await this.load(
        tx,
        'SELECT * FROM derivations WHERE id = ?',
        [id],
      );
      if (!stored) {
        throw new Error('derivation not stored');
      }
      return { derivation: stored, duplicate: false };
    });
  }

  /**
   * Benchmark only (the AJ-2 organize performance suite): the same writes
   * and read-back as saveValidated, in a transaction that is always rolled
   * back. Foreign keys are deferred, so synthetic fixture entries need not
   * exist. Nothing is kept, and the commit itself is not measured.
   */
  async rehearseSave(result: ValidatedResult): Promise<void> {
    try {
      await this.db.transaction(async tx => {
        await tx.all('PRAGMA defer_foreign_keys = ON');
        const id = await this.write(tx, result);
        await this.load(tx, 'SELECT * FROM derivations WHERE id = ?', [id]);
        throw REHEARSAL;
      });
    } catch (error) {
      if (error !== REHEARSAL) {
        throw error;
      }
    }
  }

  /** Writes one derivation's rows; returns its ID. */
  private async write(
    tx: SqlExecutor,
    result: ValidatedResult,
  ): Promise<string> {
    const { input, inputSha256, output, createdAt } = result;
    const entryIds = input.entries.map(entry => entry.entryId);
    const scopeKey = [...entryIds].sort().join(',');
    const latest = await tx.get<{ revision: number | null }>(
      'SELECT MAX(revision) AS revision FROM derivations WHERE scope_key = ?',
      [scopeKey],
    );
    const id = this.ids.next('drv');
    await tx.run(
      `INSERT INTO derivations (id, request_key, contract, engine_id, engine_version,
          input_sha256, scope_key, revision, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.requestKey,
        CONTRACT,
        output.engine.id,
        output.engine.version,
        inputSha256,
        scopeKey,
        (latest?.revision ?? 0) + 1,
        canonicalJson(output),
        createdAt,
      ],
    );
    for (const entryId of entryIds) {
      await tx.run(
        'INSERT INTO derivation_entries (derivation_id, entry_id) VALUES (?, ?)',
        [id, entryId],
      );
    }
    for (const [ordinal, task] of (output.tasks ?? []).entries()) {
      await tx.run(
        `INSERT INTO derived_tasks (id, derivation_id, ordinal, text, area, state)
            VALUES (?, ?, ?, ?, ?, 'open')`,
        [this.ids.next('tsk'), id, ordinal, task.text, task.area],
      );
    }
    const voice = new Set(
      input.entries
        .filter(entry => entry.kind === 'voice')
        .map(entry => entry.entryId),
    );
    for (const item of citedItems(output)) {
      for (const [refOrdinal, ref] of item.sources.entries()) {
        const audio = voice.has(ref.entryId);
        await tx.run(
          `INSERT INTO source_references (id, derivation_id, item_kind, item_ordinal, ref_ordinal,
              entry_id, unit_id, unit_sha256, segment_id, char_start, char_end, audio_start_ms, audio_end_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.ids.next('src'),
            id,
            item.kind,
            item.ordinal,
            refOrdinal,
            ref.entryId,
            ref.unitId,
            ref.unitSha256,
            audio ? ref.unitId : null,
            ref.charStart,
            ref.charEnd,
            audio ? ref.audioStartMs ?? null : null,
            audio ? ref.audioEndMs ?? null : null,
          ],
        );
      }
    }
    return id;
  }

  private async load(
    tx: SqlExecutor,
    sql: string,
    params: readonly string[],
  ): Promise<StoredDerivation | undefined> {
    const row = await tx.get<DerivationRow>(sql, params);
    if (!row) {
      return undefined;
    }
    const scope = await tx.all<{ entry_id: string }>(
      `SELECT s.entry_id FROM derivation_entries s
        JOIN journal_entries e ON e.id = s.entry_id
        WHERE s.derivation_id = ? ORDER BY e.created_at, s.entry_id`,
      [row.id],
    );
    const tasks = await tx.all<TaskRow>(
      'SELECT id, ordinal, text, area, state FROM derived_tasks WHERE derivation_id = ? ORDER BY ordinal',
      [row.id],
    );
    const output = JSON.parse(row.payload) as OrganizeOutput;
    return {
      id: row.id,
      requestKey: row.request_key,
      revision: row.revision,
      createdAt: row.created_at,
      engine: { id: row.engine_id, version: row.engine_version },
      entryIds: scope.map(s => s.entry_id),
      output,
      tasks: tasks.map(task => ({ ...task })),
    };
  }
}
