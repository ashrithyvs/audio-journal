import {
  OrganizeController,
  type OrganizeSnapshot,
} from '../src/features/organize/application/OrganizeController';
import {
  canonicalJson,
  resultViolation,
  type OrganizeInput,
  type OrganizeOutput,
  type SourceRef,
} from '../src/features/organize/domain/contract';
import { SqliteDerivationRepository } from '../src/platform/storage/SqliteDerivationRepository';
import type {
  CapabilityRequest,
  CapabilityUpdate,
} from '../src/platform/hybrid-ai/HybridAiGateway';
import { migrate } from '../src/platform/storage/migrationRunner';
import { MIGRATIONS } from '../src/platform/storage/migrations';
import { SqliteJournalRepository } from '../src/platform/storage/SqliteJournalRepository';
import { SqliteTranscriptRepository } from '../src/platform/storage/SqliteTranscriptRepository';
import { testOrganizeCrypto, testRandomHex } from '../test/organizeCrypto';
import {
  openJournal,
  readyVoiceEntry,
  sequentialIds,
} from '../test/sqlite/journalFixtures';
import { NodeSqliteDatabase } from '../test/sqlite/NodeSqliteDatabase';

// journal.organize@1 persistence against the real schema (contract §7,
// migration 3): one transaction per result, immutable derivations and
// references, revisions per scope, and source rows never touched.

type Journal = Awaited<ReturnType<typeof openJournal>>;

const SOURCE_TABLES = [
  'journal_entries',
  'recordings',
  'transcript_segments',
  'transcript_passes',
];

async function sourceRows(context: Journal) {
  const rows: Record<string, unknown[]> = {};
  for (const table of SOURCE_TABLES) {
    rows[table] = await context.db.all(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  return rows;
}

const count = async (context: Journal, table: string) =>
  (await context.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!
    .n;

/** A minimal valid node result: a summary and one task per entry. */
function resultFor(input: OrganizeInput, inputSha256: string): OrganizeOutput {
  const ref = (entryIndex: number): SourceRef => {
    const entry = input.entries[entryIndex];
    const unit = entry
      .units[0] as OrganizeInput['entries'][number]['units'][number] & {
      startMs?: number;
      endMs?: number;
    };
    return {
      entryId: entry.entryId,
      unitId: unit.unitId,
      unitSha256: unit.sha256,
      charStart: 0,
      charEnd: unit.text.length,
      ...(entry.kind === 'voice'
        ? { audioStartMs: unit.startMs, audioEndMs: unit.endMs }
        : {}),
    };
  };
  return {
    contract: 'journal.organize@1',
    requestKey: input.requestKey,
    inputSha256,
    engine: { id: 'aj.rules', version: '1.0.0' },
    completeness: 'complete',
    summary: { text: 'A short day.', sources: [ref(0)] },
    sections: [],
    tasks: input.entries.map((_, i) => ({
      text: `Task ${i + 1}`,
      area: 'work' as const,
      rule: 'task.need-to',
      sources: [ref(i)],
    })),
    ideas: [],
    people: [],
    projects: [],
  };
}

/** Answers each run with whatever the test decides from the request. */
class NodeStub {
  readonly requests: CapabilityRequest[] = [];
  answer: (input: OrganizeInput, sha: string) => CapabilityUpdate[] = (
    input,
    sha,
  ) => [
    { type: 'accepted' },
    {
      type: 'completed',
      output: resultFor(input, sha),
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    },
  ];
  async run(
    request: CapabilityRequest,
    onUpdate: (update: CapabilityUpdate) => void,
  ) {
    this.requests.push(request);
    const input = request.input as OrganizeInput;
    const sha = testOrganizeCrypto.sha256Hex(canonicalJson(input));
    const updates = this.answer(input, sha);
    updates.forEach(onUpdate);
    return { events: updates.length, terminalEvents: 1, outOfOrder: false };
  }
  cancel() {}
}

async function seed(context: Journal) {
  const written = await context.journal.createWritten({
    id: context.ids.next('ent'),
    text: 'Send the budget to Priya.\n\nCall Mom tonight.',
    createdAt: 1_700_000_000_000,
  });
  const { entryId: voiceId, recordingId } = await readyVoiceEntry(
    context,
    9_000,
  );
  await context.transcripts.saveEngineRevision({
    recordingId,
    modelId: 'base.en-q5_1',
    segments: [
      { startMs: 0, endMs: 4_000, text: 'Book the dentist.' },
      { startMs: 4_000, endMs: 8_500, text: 'Plan the trip.' },
    ],
    createdAt: 2,
  });
  const [first] = (await context.transcripts.current(recordingId)).lines;
  const corrected = await context.transcripts.correct(
    first.segmentId,
    'Book the dentist on Monday.',
    3,
  );
  return { writtenId: written.id, voiceId, correctedId: corrected.id };
}

let context: Journal;
let derivations: SqliteDerivationRepository;
let node: NodeStub;
let controller: OrganizeController;

beforeEach(async () => {
  context = await openJournal();
  derivations = new SqliteDerivationRepository(context.db, context.ids);
  node = new NodeStub();
  controller = new OrganizeController({
    gateway: node,
    derivations,
    loadEntry: id => context.journal.getEntry(id),
    crypto: testOrganizeCrypto,
    randomHex: testRandomHex,
    now: () => 1_760_000_000_000,
    context: { locale: 'en-IN', timeZone: 'Asia/Kolkata' },
  });
});

async function organize(entryIds: string[]): Promise<OrganizeSnapshot> {
  await controller.prepare(entryIds);
  if (controller.getSnapshot().phase !== 'consent') {
    return controller.getSnapshot();
  }
  await controller.confirm();
  return controller.getSnapshot();
}

it('stores a valid result in one transaction and never touches sources', async () => {
  const { writtenId, voiceId, correctedId } = await seed(context);
  const before = await sourceRows(context);
  const snapshot = await organize([voiceId, writtenId]);
  expect(snapshot).toMatchObject({
    phase: 'done',
    outcome: { kind: 'stored' },
  });
  expect(await sourceRows(context)).toEqual(before);

  const stored = await derivations.latestForEntry(voiceId);
  expect(stored).toMatchObject({
    revision: 1,
    entryIds: [writtenId, voiceId],
    engine: { id: 'aj.rules', version: '1.0.0' },
    output: { completeness: 'complete' },
    tasks: [
      { ordinal: 0, text: 'Task 1', area: 'work', state: 'open' },
      { ordinal: 1, text: 'Task 2', area: 'work', state: 'open' },
    ],
  });
  // The voice task cites the correction head with its segment's audio range.
  const refs = await context.db.all(
    `SELECT item_kind, item_ordinal, entry_id, unit_id, segment_id,
      audio_start_ms, audio_end_ms FROM source_references ORDER BY rowid`,
  );
  expect(refs).toEqual([
    {
      item_kind: 'summary',
      item_ordinal: 0,
      entry_id: writtenId,
      unit_id: 'w0',
      segment_id: null,
      audio_start_ms: null,
      audio_end_ms: null,
    },
    {
      item_kind: 'task',
      item_ordinal: 0,
      entry_id: writtenId,
      unit_id: 'w0',
      segment_id: null,
      audio_start_ms: null,
      audio_end_ms: null,
    },
    {
      item_kind: 'task',
      item_ordinal: 1,
      entry_id: voiceId,
      unit_id: correctedId,
      segment_id: correctedId,
      audio_start_ms: 0,
      audio_end_ms: 4_000,
    },
  ]);
  const input = node.requests[0].input as OrganizeInput;
  expect(
    resultViolation(
      stored!.output,
      input,
      testOrganizeCrypto.sha256Hex(canonicalJson(input)),
    ),
  ).toBeNull();
});

it('stores nothing for a failure, an invalid result, or a cancellation', async () => {
  const { writtenId, voiceId } = await seed(context);
  const before = await sourceRows(context);
  const cases: Array<[CapabilityUpdate[], string]> = [
    [[{ type: 'failed', failure: { code: 'DEADLINE_EXCEEDED' } }], 'failed'],
    [[{ type: 'cancelled' }], 'cancelled'],
    [
      [
        { type: 'partial', delta: { counts: { tasks: 1 } } },
        { type: 'failed', failure: { code: 'EXECUTION_FAILED' } },
      ],
      'failed',
    ],
  ];
  for (const [updates, kind] of cases) {
    node.answer = () => updates;
    expect(await organize([writtenId, voiceId])).toMatchObject({
      outcome: { kind },
    });
    controller.reset();
  }
  // A result citing a unit the request never had.
  node.answer = (input, sha) => {
    const output = resultFor(input, sha);
    output.summary!.sources[0].unitId = 'w9';
    return [
      {
        type: 'completed',
        output,
        target: 'node',
        routingReason: 'EXPLICIT_NODE',
      },
    ];
  };
  expect(await organize([writtenId, voiceId])).toMatchObject({
    outcome: { kind: 'invalid', subCode: 'RESULT_REFERENCE' },
  });
  for (const table of [
    'derivations',
    'derivation_entries',
    'derived_tasks',
    'source_references',
  ]) {
    expect([table, await count(context, table)]).toEqual([table, 0]);
  }
  expect(await sourceRows(context)).toEqual(before);
});

it('rolls back the whole derivation when any row fails', async () => {
  const { writtenId, voiceId } = await seed(context);
  // Valid by the contract, but its voice reference names a segment row that
  // does not exist in this journal, so the foreign key fails mid-transaction.
  node.answer = (input, sha) => {
    const output = resultFor(input, sha);
    return [
      {
        type: 'completed',
        output,
        target: 'node',
        routingReason: 'EXPLICIT_NODE',
      },
    ];
  };
  await controller.prepare([writtenId, voiceId]);
  const pendingInput = () => node.requests.at(-1)!.input as OrganizeInput;
  const realSave = derivations.saveValidated.bind(derivations);
  derivations.saveValidated = async result => {
    const output = structuredClone(result.output);
    output.tasks![1].sources[0].unitId = `seg_${'z'.repeat(26)}`;
    output.tasks![1].sources[0].unitSha256 =
      pendingInput().entries[1].units[0].sha256;
    return realSave({ ...result, output });
  };
  await controller.confirm();
  expect(controller.getSnapshot()).toMatchObject({
    outcome: { kind: 'failed', code: 'STORAGE_FAILED' },
  });
  for (const table of [
    'derivations',
    'derivation_entries',
    'derived_tasks',
    'source_references',
  ]) {
    expect([table, await count(context, table)]).toEqual([table, 0]);
  }
});

it('keeps derivations immutable; only task state may change', async () => {
  const { writtenId } = await seed(context);
  await organize([writtenId]);
  await expect(
    context.db.run("UPDATE derivations SET payload = '{}'"),
  ).rejects.toThrow(/immutable/);
  await expect(context.db.run('DELETE FROM derivations')).rejects.toThrow(
    /kept/,
  );
  await expect(
    context.db.run('UPDATE source_references SET char_start = 1'),
  ).rejects.toThrow(/immutable/);
  await expect(
    context.db.run("UPDATE derived_tasks SET text = 'edited'"),
  ).rejects.toThrow(/immutable/);
  await context.db.run(
    "UPDATE derived_tasks SET state = 'done', state_changed_at = 5",
  );
  expect((await derivations.latestForEntry(writtenId))!.tasks[0].state).toBe(
    'done',
  );
});

it('reuses the key for an identical request and adds a revision for a changed one', async () => {
  const { writtenId, voiceId, correctedId } = await seed(context);
  await organize([writtenId, voiceId]);
  controller.reset();
  // Identical: recognised before anything is sent.
  expect(await organize([voiceId, writtenId])).toMatchObject({
    phase: 'existing',
  });
  expect(node.requests).toHaveLength(1);
  controller.reset();

  // A corrected transcript changes the request: new key, revision 2.
  await context.transcripts.correct(
    correctedId,
    'Book the dentist on Tuesday.',
    9,
  );
  expect(await organize([writtenId, voiceId])).toMatchObject({
    outcome: { kind: 'stored', derivation: { revision: 2 } },
  });
  const [first, second] = node.requests.map(
    r => (r.input as OrganizeInput).requestKey,
  );
  expect(first).not.toBe(second);
  // A different scope starts its own revisions.
  controller.reset();
  expect(await organize([writtenId])).toMatchObject({
    outcome: { kind: 'stored', derivation: { revision: 1 } },
  });
  expect(await count(context, 'derivations')).toBe(3);
});

it('keeps one request-key secret per journal, outside app settings', async () => {
  const a = await derivations.requestKeySecret(() => testRandomHex(32));
  const b = await derivations.requestKeySecret(() => 'f'.repeat(64));
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(await count(context, 'app_settings')).toBe(0);
  await expect(
    context.db.run('INSERT INTO organize_secret (id, key_hex) VALUES (2, ?)', [
      'a'.repeat(64),
    ]),
  ).rejects.toThrow();
});

it('upgrades a v2 journal to the latest schema without touching its rows, then organizes', async () => {
  const db = new NodeSqliteDatabase();
  await migrate(db, 1, MIGRATIONS.slice(0, 2));
  const ids = sequentialIds(700);
  const v2 = {
    db,
    ids,
    journal: new SqliteJournalRepository(db),
    transcripts: new SqliteTranscriptRepository(db, ids),
  } as Journal;
  const { writtenId, voiceId } = await seed(v2);
  const before = await sourceRows(v2);
  expect(await migrate(db, 9)).toEqual({ from: 2, to: 4, applied: [3, 4] });
  expect(await sourceRows(v2)).toEqual(before);

  derivations = new SqliteDerivationRepository(db, ids);
  controller = new OrganizeController({
    gateway: node,
    derivations,
    loadEntry: id => v2.journal.getEntry(id),
    crypto: testOrganizeCrypto,
    randomHex: testRandomHex,
    now: () => 1_760_000_000_000,
    context: { locale: 'en-IN', timeZone: 'Asia/Kolkata' },
  });
  expect(await organize([writtenId, voiceId])).toMatchObject({
    outcome: { kind: 'stored', derivation: { revision: 1 } },
  });
  expect(await sourceRows(v2)).toEqual(before);
});
