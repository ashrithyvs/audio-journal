import {
  canonicalJson,
  resultViolation,
  type OrganizeInput,
  type OrganizeOutput,
  type OrganizeTask,
  type SourceRef,
} from '../src/features/organize/domain/contract';
import { buildOrganizeRequest } from '../src/features/organize/domain/request';
import { scopeKeyOf } from '../src/features/organize/domain/scope';
import {
  currentEntry,
  staleness,
} from '../src/features/organize/domain/staleness';
import type { OrganizeKind } from '../src/features/organize/domain/contract';
import { SqliteDerivationRepository } from '../src/platform/storage/SqliteDerivationRepository';
import { testOrganizeCrypto } from '../test/organizeCrypto';
import { openJournal, readyVoiceEntry } from '../test/sqlite/journalFixtures';

// ADR-020 on real SQLite: the canonical selection identity, history, computed
// staleness, task transitions, and conservative carry-over through the save
// transaction (corrected line, re-transcription, changed written text,
// merged duplicates, reordered output).

type Journal = Awaited<ReturnType<typeof openJournal>>;
const KEY = 'ab'.repeat(32);
let context: Journal;
let derivations: SqliteDerivationRepository;
let clock = 1_760_000_000_000;

beforeEach(async () => {
  context = await openJournal();
  derivations = new SqliteDerivationRepository(context.db, context.ids);
});

/** The request for these entries, as the app builds it. */
async function requestFor(entryIds: string[], kinds?: OrganizeKind[]) {
  const details = await Promise.all(
    entryIds.map(id => context.journal.getEntry(id)),
  );
  const built = buildOrganizeRequest({
    selection: details.map(d => d!),
    keyHex: KEY,
    crypto: testOrganizeCrypto,
    kinds,
    context: { locale: 'en-IN', timeZone: 'UTC' },
  });
  if (!built.ok) throw new Error(built.reason);
  return built;
}

/** A reference to `phrase` in the unit whose text contains it. */
function cite(input: OrganizeInput, phrase: string, nth = 0): SourceRef {
  const hits = input.entries.flatMap(entry =>
    entry.units
      .filter(unit => unit.text.includes(phrase))
      .map(unit => ({ entry, unit })),
  );
  const { entry, unit } = hits[nth];
  const start = unit.text.indexOf(phrase);
  const u = unit as typeof unit & { startMs?: number; endMs?: number };
  return {
    entryId: entry.entryId,
    unitId: unit.unitId,
    unitSha256: unit.sha256,
    charStart: start,
    charEnd: start + phrase.length,
    ...(entry.kind === 'voice'
      ? { audioStartMs: u.startMs, audioEndMs: u.endMs }
      : {}),
  };
}

/** Validates and stores a result whose tasks the test chooses. */
async function organize(
  entryIds: string[],
  tasks: (input: OrganizeInput) => OrganizeTask[],
  kinds: OrganizeKind[] = ['tasks'],
) {
  const built = await requestFor(entryIds, kinds);
  const output: OrganizeOutput = {
    contract: 'journal.organize@1',
    requestKey: built.input.requestKey,
    inputSha256: built.inputSha256,
    engine: { id: 'aj.rules', version: '1.0.0' },
    completeness: 'complete',
    ...(kinds.includes('ideas') ? { ideas: [] } : {}),
    tasks: tasks(built.input),
  };
  expect(resultViolation(output, built.input, built.inputSha256)).toBeNull();
  const saved = await derivations.saveValidated({
    input: built.input,
    inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(built.input)),
    output,
    createdAt: (clock += 1000),
  });
  expect(saved.duplicate).toBe(false);
  return saved.derivation;
}

const task = (
  text: string,
  sources: SourceRef[],
  extra: Partial<OrganizeTask> = {},
): OrganizeTask => ({ text, area: 'unsorted', sources, ...extra });

async function writtenEntry(text: string, createdAt = clock) {
  return (
    await context.journal.createWritten({
      id: context.ids.next('ent'),
      text,
      createdAt,
    })
  ).id;
}

async function voiceEntry(lines: string[]) {
  const { entryId, recordingId } = await readyVoiceEntry(
    context,
    lines.length * 4_000 + 500,
  );
  await context.transcripts.saveEngineRevision({
    recordingId,
    modelId: 'base.en-q5_1',
    segments: lines.map((text, i) => ({
      startMs: i * 4_000,
      endMs: (i + 1) * 4_000,
      text,
    })),
    createdAt: 2,
  });
  return { entryId, recordingId };
}

const headOf = async (recordingId: string, ordinal: number) =>
  (await context.transcripts.current(recordingId)).lines[ordinal].segmentId;

async function current(entryIds: string[]) {
  const map = new Map();
  for (const id of entryIds) {
    map.set(
      id,
      currentEntry(
        await context.journal.getEntry(id),
        testOrganizeCrypto.sha256Hex,
      ),
    );
  }
  return map;
}

it('a reordered selection is the same canonical scope, with one history', async () => {
  const a = await writtenEntry('Call the bank.');
  const b = await writtenEntry('Water the plants.');
  const first = await organize([a, b], input => [
    task('Call the bank.', [cite(input, 'Call the bank.')]),
  ]);
  // Same entries, other order and other kinds: a new revision of the scope.
  const second = await organize(
    [b, a, b],
    input => [task('Call the bank.', [cite(input, 'Call the bank.')])],
    ['tasks', 'ideas'],
  );
  expect(first.scopeKey).toBe(scopeKeyOf([b, a]));
  expect(second.scopeKey).toBe(first.scopeKey);
  expect([first.revision, second.revision]).toEqual([1, 2]);
  expect((await derivations.history(first.scopeKey)).map(d => d.id)).toEqual([
    second.id,
    first.id,
  ]);
  expect((await derivations.newestPerScope()).map(d => d.id)).toEqual([
    second.id,
  ]);
});

it('carries through an unchanged unit and through a corrected line; history keeps its states', async () => {
  const written = await writtenEntry('Call the bank.\n\nWater the plants.');
  const voice = await voiceEntry(['Book the dentist.', 'Plan the trip.']);
  const scope = [written, voice.entryId];
  const first = await organize(scope, input => [
    task('Call the bank.', [cite(input, 'Call the bank.')]),
    task('Book the dentist.', [cite(input, 'Book the dentist.')]),
  ]);
  const [call, dentist] = first.tasks;
  await derivations.setTaskState(call.id, 'done', 10);
  await derivations.setTaskState(dentist.id, 'dismissed', 11);

  // The user corrects the dentist line: its head is now a correction row.
  await context.transcripts.correct(
    await headOf(voice.recordingId, 0),
    'Book the dentist on Monday.',
    12,
  );
  const second = await organize(
    [voice.entryId, written], // reordered selection
    input => [
      // Reordered output too.
      task('Book the dentist.', [cite(input, 'Book the dentist')]),
      task('Call the bank.', [cite(input, 'Call the bank.')]),
    ],
  );
  expect(second.revision).toBe(2);
  expect(second.tasks.map(t => [t.text, t.state, t.predecessorTaskId])).toEqual(
    [
      ['Book the dentist.', 'dismissed', dentist.id],
      ['Call the bank.', 'done', call.id],
    ],
  );
  // Historical task states are unchanged.
  const [old] = (await derivations.history(first.scopeKey)).slice(-1);
  expect(old.tasks.map(t => t.state)).toEqual(['done', 'dismissed']);

  // The first revision is stale where it cites the corrected line only.
  const stale = staleness(first.output, await current(scope));
  expect([...stale.items]).toEqual(['task:1']);
  expect(staleness(second.output, await current(scope)).stale).toBe(false);
});

it('does not carry across a re-transcription', async () => {
  const voice = await voiceEntry(['Book the dentist.']);
  const first = await organize([voice.entryId], input => [
    task('Book the dentist.', [cite(input, 'Book the dentist.')]),
  ]);
  await derivations.setTaskState(first.tasks[0].id, 'done', 10);
  // A new full pass: new segments with no correction lineage.
  await context.transcripts.saveEngineRevision({
    recordingId: voice.recordingId,
    modelId: 'base.en-q5_1',
    segments: [{ startMs: 0, endMs: 4_000, text: 'Book the dentist.' }],
    createdAt: 20,
  });
  const second = await organize([voice.entryId], input => [
    task('Book the dentist.', [cite(input, 'Book the dentist.')]),
  ]);
  expect(second.tasks[0]).toMatchObject({ state: 'open' });
  expect(second.tasks[0].predecessorTaskId).toBeUndefined();
  expect(
    staleness(first.output, await current([voice.entryId])).items.has('task:0'),
  ).toBe(true);
});

it('does not carry when the written text changed', async () => {
  const entry = await writtenEntry('Call the bank today.');
  const first = await organize([entry], input => [
    task('Call the bank.', [cite(input, 'Call the bank')]),
  ]);
  await derivations.setTaskState(first.tasks[0].id, 'done', 10);
  // Written text cannot be edited in v1; this stands in for a later edit.
  await context.db.run(
    'UPDATE journal_entries SET source_text = ? WHERE id = ?',
    ['Call the bank tomorrow.', entry],
  );
  expect(
    staleness(first.output, await current([entry])).items.has('task:0'),
  ).toBe(true);
  const second = await organize([entry], input => [
    task('Call the bank.', [cite(input, 'Call the bank')]),
  ]);
  expect(second.tasks[0]).toMatchObject({ state: 'open' });
  expect(second.tasks[0].predecessorTaskId).toBeUndefined();
});

it('carries a task merged from duplicate sentences once', async () => {
  const entry = await writtenEntry('Water the plants.\n\nWater the plants.');
  const both = (input: OrganizeInput) => [
    task('Water the plants.', [
      cite(input, 'Water the plants.', 0),
      cite(input, 'Water the plants.', 1),
    ]),
  ];
  const first = await organize([entry], both);
  await derivations.setTaskState(first.tasks[0].id, 'dismissed', 10);
  const second = await organize([entry], both, ['tasks', 'ideas']);
  expect(second.tasks).toHaveLength(1);
  expect(second.tasks[0]).toMatchObject({
    state: 'dismissed',
    predecessorTaskId: first.tasks[0].id,
  });
});

it('stores due dates; transitions restore; due date and lineage are immutable', async () => {
  const entry = await writtenEntry(
    'Send the invoice by Friday.',
    Date.parse('2026-10-17T08:00:00.000Z'), // Saturday, UTC
  );
  const saved = await organize([entry], input => [
    task(
      'Send the invoice by Friday.',
      [cite(input, 'Send the invoice by Friday.')],
      {
        due: {
          date: '2026-10-23',
          rule: 'due.weekday',
          source: cite(input, 'Friday'),
        },
      },
    ),
  ]);
  expect(saved.tasks[0].dueDate).toBe('2026-10-23');
  const id = saved.tasks[0].id;
  await derivations.setTaskState(id, 'done', 20);
  await derivations.setTaskState(id, 'open', 21); // restore
  const [reloaded] = await derivations.history(saved.scopeKey);
  expect(reloaded.tasks[0]).toMatchObject({
    state: 'open',
    stateChangedAt: 21,
  });
  await expect(
    context.db.run("UPDATE derived_tasks SET due_date = '2026-10-24'"),
  ).rejects.toThrow(/immutable/);
  await expect(
    context.db.run('UPDATE derived_tasks SET predecessor_task_id = id'),
  ).rejects.toThrow(/immutable/);
  await expect(
    derivations.setTaskState('tsk_missing', 'done', 1),
  ).rejects.toThrow();
});
