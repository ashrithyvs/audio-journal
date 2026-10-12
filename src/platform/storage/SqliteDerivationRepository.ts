import type { IdSource } from '../../features/journal/domain/ids';
import {
  canonicalJson,
  CONTRACT,
  type NamedItem,
  type OrganizeItem,
  type OrganizeOutput,
  type SourceRef,
} from '../../features/organize/domain/contract';
import {
  matchCarryOver,
  type PreviousTask,
} from '../../features/organize/domain/carryOver';
import { scopeKeyOf } from '../../features/organize/domain/scope';
import type {
  DerivationRepository,
  DerivedTask,
  StoredDerivation,
  TaskState,
  ValidatedResult,
} from '../../features/organize/ports/DerivationRepository';
import type { SqlDatabase, SqlExecutor } from './SqlDatabase';

// journal.organize@1 persistence (contract §7, migration 3). One transaction
// writes the derivation, its scope, its tasks, and every source reference;
// the triggers keep them immutable except for a task's state.

type DerivationRow = {
  id: string;
  request_key: string;
  scope_key: string;
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
  state_changed_at: number | null;
  due_date: string | null;
  predecessor_task_id: string | null;
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

  async newestPerScope(): Promise<StoredDerivation[]> {
    const rows = await this.db.all<DerivationRow>(
      `SELECT d.* FROM derivations d
        WHERE d.revision = (SELECT MAX(x.revision) FROM derivations x
          WHERE x.scope_key = d.scope_key)
        ORDER BY d.created_at DESC, d.rowid DESC`,
    );
    return Promise.all(rows.map(row => this.hydrate(this.db, row)));
  }

  async history(scopeKey: string): Promise<StoredDerivation[]> {
    const rows = await this.db.all<DerivationRow>(
      'SELECT * FROM derivations WHERE scope_key = ? ORDER BY revision DESC',
      [scopeKey],
    );
    return Promise.all(rows.map(row => this.hydrate(this.db, row)));
  }

  async setTaskState(taskId: string, state: TaskState, at: number) {
    const { changes } = await this.db.run(
      'UPDATE derived_tasks SET state = ?, state_changed_at = ? WHERE id = ?',
      [state, at, taskId],
    );
    if (changes !== 1) {
      throw new Error('task not found');
    }
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
    const scopeKey = scopeKeyOf(entryIds);
    const latest = await tx.get<{ revision: number | null }>(
      'SELECT MAX(revision) AS revision FROM derivations WHERE scope_key = ?',
      [scopeKey],
    );
    const carried = await this.carryOver(tx, scopeKey, entryIds, output);
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
      // ADR-020: a proven, unambiguous predecessor's state carries over;
      // anything else starts open. The predecessor's own row is unchanged.
      const predecessor = carried.get(ordinal);
      await tx.run(
        `INSERT INTO derived_tasks (id, derivation_id, ordinal, text, area,
            state, state_changed_at, due_date, predecessor_task_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.ids.next('tsk'),
          id,
          ordinal,
          task.text,
          task.area,
          predecessor?.state ?? 'open',
          predecessor?.stateChangedAt ?? null,
          task.due?.date ?? null,
          predecessor?.id ?? null,
        ],
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
    return row ? this.hydrate(tx, row) : undefined;
  }

  private async hydrate(
    tx: SqlExecutor,
    row: DerivationRow,
  ): Promise<StoredDerivation> {
    const scope = await tx.all<{ entry_id: string }>(
      `SELECT s.entry_id FROM derivation_entries s
        JOIN journal_entries e ON e.id = s.entry_id
        WHERE s.derivation_id = ? ORDER BY e.created_at, s.entry_id`,
      [row.id],
    );
    const tasks = await tx.all<TaskRow>(
      `SELECT id, ordinal, text, area, state, state_changed_at, due_date,
          predecessor_task_id
        FROM derived_tasks WHERE derivation_id = ? ORDER BY ordinal`,
      [row.id],
    );
    const output = JSON.parse(row.payload) as OrganizeOutput;
    return {
      id: row.id,
      requestKey: row.request_key,
      scopeKey: row.scope_key,
      revision: row.revision,
      createdAt: row.created_at,
      engine: { id: row.engine_id, version: row.engine_version },
      entryIds: scope.map(s => s.entry_id),
      output,
      tasks: tasks.map(task => ({
        id: task.id,
        ordinal: task.ordinal,
        text: task.text,
        area: task.area,
        state: task.state,
        ...(task.state_changed_at === null
          ? {}
          : { stateChangedAt: task.state_changed_at }),
        ...(task.due_date === null ? {} : { dueDate: task.due_date }),
        ...(task.predecessor_task_id === null
          ? {}
          : { predecessorTaskId: task.predecessor_task_id }),
      })),
    };
  }

  /**
   * ADR-020 carry-over: the previous revision of this scope, matched against
   * the new tasks with the correction lineage of the scope's transcripts.
   */
  private async carryOver(
    tx: SqlExecutor,
    scopeKey: string,
    entryIds: readonly string[],
    output: OrganizeOutput,
  ): Promise<Map<number, PreviousTask>> {
    const previousRow = await tx.get<DerivationRow>(
      `SELECT * FROM derivations WHERE scope_key = ?
        ORDER BY revision DESC LIMIT 1`,
      [scopeKey],
    );
    if (!previousRow || !output.tasks?.length) {
      return new Map();
    }
    const previousOutput = JSON.parse(previousRow.payload) as OrganizeOutput;
    const rows = await tx.all<TaskRow>(
      `SELECT id, ordinal, text, area, state, state_changed_at, due_date,
          predecessor_task_id
        FROM derived_tasks WHERE derivation_id = ? ORDER BY ordinal`,
      [previousRow.id],
    );
    const previous: PreviousTask[] = rows.map(row => ({
      id: row.id,
      ordinal: row.ordinal,
      text: row.text,
      state: row.state,
      ...(row.state_changed_at === null
        ? {}
        : { stateChangedAt: row.state_changed_at }),
      sources: previousOutput.tasks?.[row.ordinal]?.sources ?? [],
    }));
    const lineage = new Map<string, string>();
    const marks = entryIds.map(() => '?').join(', ');
    for (const segment of await tx.all<{
      id: string;
      supersedes_segment_id: string | null;
    }>(
      `SELECT id, supersedes_segment_id FROM transcript_segments
        WHERE entry_id IN (${marks}) AND supersedes_segment_id IS NOT NULL`,
      entryIds,
    )) {
      lineage.set(segment.id, segment.supersedes_segment_id!);
    }
    return matchCarryOver(
      previous,
      output.tasks.map((task, ordinal) => ({
        ordinal,
        text: task.text,
        sources: task.sources,
      })),
      segmentId => lineage.get(segmentId),
    );
  }
}
