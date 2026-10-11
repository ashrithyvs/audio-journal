import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planReconciliation } from '../src/features/journal/domain/reconciliation';
import { RepositoryError } from '../src/features/journal/ports/JournalRepository';
import {
  migrate,
  MigrationError,
  schemaVersion,
} from '../src/platform/storage/migrationRunner';
import { MIGRATIONS, type Migration } from '../src/platform/storage/migrations';
import { SqliteJournalRepository } from '../src/platform/storage/SqliteJournalRepository';
import { SqliteTranscriptRepository } from '../src/platform/storage/SqliteTranscriptRepository';
import { NodeSqliteDatabase } from '../test/sqlite/NodeSqliteDatabase';
import {
  openJournal,
  readyVoiceEntry,
  sequentialIds,
  SHA_A,
} from '../test/sqlite/journalFixtures';

// Real SQLite (node:sqlite) with the production schema and repositories. The
// native SQLCipher adapter must pass this same suite once it exists.

type Journal = Awaited<ReturnType<typeof openJournal>>;
let context: Journal;

beforeEach(async () => {
  context = await openJournal();
});

afterEach(async () => {
  await context.db.close();
});

describe('migrations', () => {
  const latest = MIGRATIONS.length;

  it('creates the current schema and is idempotent', async () => {
    expect(await schemaVersion(context.db)).toBe(latest);
    expect(await migrate(context.db, 2)).toEqual({
      from: latest,
      to: latest,
      applied: [],
    });
  });

  it('upgrades a v1 journal and backfills its stored passes', async () => {
    const db = new NodeSqliteDatabase();
    await migrate(db, 1, MIGRATIONS.slice(0, 1));
    const v1 = {
      db,
      journal: new SqliteJournalRepository(db),
      transcripts: new SqliteTranscriptRepository(db, sequentialIds(500)),
      ids: sequentialIds(900),
    };
    const { recordingId } = await readyVoiceEntry(v1, 3_000);
    await db.run(
      `INSERT INTO transcript_segments (id, entry_id, recording_id, engine_revision,
        ordinal, start_ms, end_ms, text, state, source, model_id, created_at)
        SELECT ?, entry_id, id, 1, 0, 0, 900, 'hi', 'final', 'engine', 'base.en-q5_1', 7
        FROM recordings WHERE id = ?`,
      [v1.ids.next('seg'), recordingId],
    );
    expect(await migrate(db, 2)).toEqual({
      from: 1,
      to: latest,
      applied: [2, 3],
    });
    expect(
      await db.get(
        'SELECT engine_revision, segment_count FROM transcript_passes',
      ),
    ).toEqual({ engine_revision: 1, segment_count: 1 });
    await db.close();
  });

  it('applies all pending steps atomically or not at all', async () => {
    const db = new NodeSqliteDatabase();
    const broken: Migration[] = [
      ...MIGRATIONS,
      {
        version: latest + 1,
        name: 'bad',
        statements: ['CREATE TABLE ok (x INTEGER)', 'NOT SQL'],
      },
    ];
    await expect(migrate(db, 1, broken)).rejects.toMatchObject({
      failure: 'STEP_FAILED',
      version: latest + 1,
    });
    // Every earlier version was pending in the same transaction, so nothing
    // was applied.
    expect(await schemaVersion(db)).toBe(0);
    expect(
      await db.get(
        "SELECT name FROM sqlite_master WHERE name IN ('journal_entries', 'ok')",
      ),
    ).toBeUndefined();
    await db.close();
  });

  it('refuses a database from a newer app (downgrade)', async () => {
    const newer: Migration[] = [
      ...MIGRATIONS,
      {
        version: latest + 1,
        name: 'future',
        statements: ['CREATE TABLE future (x INTEGER)'],
      },
    ];
    await migrate(context.db, 3, newer);
    await expect(migrate(context.db, 4)).rejects.toMatchObject({
      failure: 'DOWNGRADE_UNSUPPORTED',
    });
  });

  it('refuses an edited migration history', async () => {
    const edited: Migration[] = [
      {
        ...MIGRATIONS[0],
        statements: [...MIGRATIONS[0].statements, 'SELECT 1'],
      },
    ];
    const error = await migrate(context.db, 5, edited).catch(e => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.failure).toBe('HISTORY_MISMATCH');
    expect(error.message).not.toMatch(/CREATE|SELECT/);
  });

  it('rejects non-contiguous definitions before touching the database', async () => {
    await expect(
      migrate(context.db, 6, [{ ...MIGRATIONS[0], version: 2 }]),
    ).rejects.toMatchObject({ failure: 'INVALID_DEFINITIONS' });
  });
});

describe('journal repository', () => {
  it('stores written source text byte-for-byte (ADR-002)', async () => {
    const id = context.ids.next('ent');
    const text = '  Line one\n\tLine two — ünïcødé 🎙  ';
    await context.journal.createWritten({
      id,
      text,
      title: ' Day ',
      createdAt: 100,
    });
    const detail = await context.journal.getEntry(id);
    expect(detail?.entry).toMatchObject({
      kind: 'written',
      status: 'ready',
      sourceText: text,
      title: 'Day',
    });
    expect(detail?.recording).toBeUndefined();
    expect(detail?.transcript.kind).toBe('none');
  });

  it('rejects invalid input with codes only', async () => {
    const error = await context.journal
      .createWritten({ id: 'ent_bad', text: 'secret words', createdAt: 1 })
      .catch(e => e);
    expect(error).toBeInstanceOf(RepositoryError);
    expect(error.message).not.toContain('secret');
    await expect(
      context.journal.createWritten({
        id: context.ids.next('ent'),
        text: '  ',
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('runs a voice draft through progress to a finalized recording', async () => {
    const entryId = context.ids.next('ent');
    const recordingId = context.ids.next('rec');
    const draft = await context.journal.createVoiceDraft({
      entryId,
      recordingId,
      startedAt: 1_000,
    });
    expect(draft).toMatchObject({
      state: 'preparing',
      relativePath: `recordings/${recordingId}.ajr`,
    });
    // Drafts are invisible in the timeline.
    expect(await context.journal.listTimeline({ limit: 10 })).toEqual([]);
    await context.journal.updateRecordingProgress(
      recordingId,
      {
        state: 'recording',
        durationMs: 4_000,
        sealedChunks: 4,
        byteCount: 128_000,
      },
      5_000,
    );
    // An older progress report never moves the recording backwards.
    await context.journal.updateRecordingProgress(
      recordingId,
      { state: 'recording', durationMs: 1_000, sealedChunks: 1, byteCount: 1 },
      5_001,
    );
    expect((await context.journal.getEntry(entryId))?.recording).toMatchObject({
      durationMs: 4_000,
      sealedChunks: 4,
    });
    await context.journal.finalizeVoice({
      recordingId,
      endedAt: 6_000,
      durationMs: 5_000,
      sealedChunks: 5,
      byteCount: 160_100,
      contentSha256: SHA_A,
      finishReason: 'user',
    });
    const [summary] = await context.journal.listTimeline({ limit: 10 });
    expect(summary).toMatchObject({
      id: entryId,
      kind: 'voice',
      durationMs: 5_000,
    });
  });

  it('makes a finalized recording immutable at the schema level', async () => {
    const { recordingId } = await readyVoiceEntry(context, 3_000);
    await expect(
      context.db.run('UPDATE recordings SET duration_ms = 1 WHERE id = ?', [
        recordingId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      context.db.run('DELETE FROM recordings WHERE id = ?', [recordingId]),
    ).rejects.toThrow(/not deleted/);
    await expect(
      context.journal.updateRecordingProgress(
        recordingId,
        { state: 'recording', durationMs: 1, sealedChunks: 1, byteCount: 1 },
        9,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('enforces recording invariants in the schema, not only in code', async () => {
    const entryId = context.ids.next('ent');
    const recordingId = context.ids.next('rec');
    await context.journal.createVoiceDraft({
      entryId,
      recordingId,
      startedAt: 1,
    });
    // A ready recording needs a digest; a path must match its ID.
    await expect(
      context.db.run("UPDATE recordings SET state = 'ready' WHERE id = ?", [
        recordingId,
      ]),
    ).rejects.toThrow(/CHECK/);
    await expect(
      context.db.run('UPDATE recordings SET relative_path = ? WHERE id = ?', [
        '../escape.ajr',
        recordingId,
      ]),
    ).rejects.toThrow(/CHECK/);
    // STRICT tables refuse non-integer durations.
    await expect(
      context.db.run('UPDATE recordings SET duration_ms = 1.5 WHERE id = ?', [
        recordingId,
      ]),
    ).rejects.toThrow();
  });

  it('discards a confirmed cancel without deleting rows', async () => {
    const entryId = context.ids.next('ent');
    const recordingId = context.ids.next('rec');
    await context.journal.createVoiceDraft({
      entryId,
      recordingId,
      startedAt: 1,
    });
    await context.journal.discardDraft(recordingId, 50);
    expect(await context.journal.getEntry(entryId)).toBeNull();
    expect(
      await context.db.get('SELECT state FROM recordings WHERE id = ?', [
        recordingId,
      ]),
    ).toEqual({
      state: 'failed',
    });
    await expect(
      context.journal.discardDraft(recordingId, 60),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('rolls back a multi-row write when any part fails', async () => {
    const entryId = context.ids.next('ent');
    await context.journal.createWritten({
      id: entryId,
      text: 'x',
      createdAt: 1,
    });
    // Same entry ID again: the entry insert fails, so no recording row survives.
    await expect(
      context.journal.createVoiceDraft({
        entryId,
        recordingId: context.ids.next('rec'),
        startedAt: 2,
      }),
    ).rejects.toThrow();
    expect(
      await context.db.get('SELECT count(*) AS n FROM recordings'),
    ).toEqual({ n: 0 });
  });

  it('pages the timeline by keyset, newest first, without gaps or repeats', async () => {
    const created: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const id = context.ids.next('ent');
      created.push(id);
      // Pairs share a timestamp to exercise the ID tie-break.
      await context.journal.createWritten({
        id,
        text: `entry ${index}`,
        createdAt: 1_000 + Math.floor(index / 2),
      });
    }
    const seen: string[] = [];
    let before: { createdAt: number; id: string } | undefined;
    for (;;) {
      const page = await context.journal.listTimeline({ limit: 7, before });
      if (page.length === 0) {
        break;
      }
      seen.push(...page.map(item => item.id));
      const last = page[page.length - 1];
      before = { createdAt: last.createdAt, id: last.id };
    }
    expect(seen).toEqual([...created].reverse());
    expect(new Set(seen).size).toBe(25);
  });
});

describe('transcript repository', () => {
  it('stores an engine pass atomically and corrections append-only', async () => {
    const { entryId, recordingId } = await readyVoiceEntry(context, 10_000);
    const saved = await context.transcripts.saveEngineRevision({
      recordingId,
      modelId: 'base.en-q5_1',
      segments: [
        { startMs: 0, endMs: 4_000, text: 'helo world' },
        { startMs: 4_000, endMs: 9_500, text: 'second line' },
      ],
      createdAt: 20,
    });
    expect(saved).toEqual({ engineRevision: 1, segmentCount: 2 });
    const view = await context.transcripts.current(recordingId);
    const corrected = await context.transcripts.correct(
      view.lines[0].segmentId,
      'hello world',
      30,
    );
    expect(corrected).toMatchObject({
      state: 'corrected',
      source: 'user',
      startMs: 0,
    });

    const detail = await context.journal.getEntry(entryId);
    expect(
      detail?.transcript.lines.map(line => [line.text, line.state]),
    ).toEqual([
      ['hello world', 'corrected'],
      ['second line', 'final'],
    ]);
    // The engine row is unchanged and cannot be changed.
    await expect(
      context.db.run("UPDATE transcript_segments SET text = 'x' WHERE id = ?", [
        view.lines[0].segmentId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      context.db.run('DELETE FROM transcript_segments WHERE id = ?', [
        corrected.id,
      ]),
    ).rejects.toThrow(/append-only/);
    // A second correction of the superseded row is a conflict.
    await expect(
      context.transcripts.correct(view.lines[0].segmentId, 'again', 40),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a pass that escapes the recording or arrives before Finish', async () => {
    const { recordingId } = await readyVoiceEntry(context, 5_000);
    await expect(
      context.transcripts.saveEngineRevision({
        recordingId,
        modelId: 'base.en-q5_1',
        segments: [{ startMs: 0, endMs: 5_001, text: 'too long' }],
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await context.transcripts.records(recordingId)).toEqual([]);

    const draftRecording = context.ids.next('rec');
    await context.journal.createVoiceDraft({
      entryId: context.ids.next('ent'),
      recordingId: draftRecording,
      startedAt: 1,
    });
    await expect(
      context.transcripts.saveEngineRevision({
        recordingId: draftRecording,
        modelId: 'base.en-q5_1',
        segments: [],
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('replaces live provisional text with the first full pass', async () => {
    const entryId = context.ids.next('ent');
    const recordingId = context.ids.next('rec');
    await context.journal.createVoiceDraft({
      entryId,
      recordingId,
      startedAt: 1,
    });
    await context.journal.updateRecordingProgress(
      recordingId,
      {
        state: 'recording',
        durationMs: 3_000,
        sealedChunks: 3,
        byteCount: 96_000,
      },
      2,
    );
    const live = context.ids.next('seg');
    await context.transcripts.upsertProvisional(
      recordingId,
      [
        {
          segmentId: live,
          revision: 1,
          startMs: 0,
          endMs: 2_000,
          text: 'helo',
        },
      ],
      3,
    );
    await context.transcripts.upsertProvisional(
      recordingId,
      [
        {
          segmentId: live,
          revision: 2,
          startMs: 0,
          endMs: 2_500,
          text: 'hello',
        },
      ],
      4,
    );
    expect(await context.transcripts.current(recordingId)).toMatchObject({
      kind: 'provisional',
      lines: [{ text: 'hello', endMs: 2_500 }],
    });
    await context.journal.finalizeVoice({
      recordingId,
      endedAt: 10,
      durationMs: 3_000,
      sealedChunks: 3,
      byteCount: 96_100,
      contentSha256: SHA_A,
      finishReason: 'user',
    });
    // Live text is closed once capture ends.
    await expect(
      context.transcripts.upsertProvisional(
        recordingId,
        [{ segmentId: live, revision: 3, startMs: 0, endMs: 1, text: 'late' }],
        11,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await context.transcripts.saveEngineRevision({
      recordingId,
      modelId: 'base.en-q5_1',
      segments: [{ startMs: 0, endMs: 2_900, text: 'Hello there.' }],
      createdAt: 12,
    });
    expect(await context.transcripts.current(recordingId)).toMatchObject({
      kind: 'final',
      engineRevision: 1,
      lines: [{ text: 'Hello there.', state: 'final' }],
    });
  });
});

describe('startup reconciliation against the database', () => {
  it('applies a reconciliation plan in one transaction', async () => {
    const crashed = {
      entryId: context.ids.next('ent'),
      recordingId: context.ids.next('rec'),
    };
    const finishing = {
      entryId: context.ids.next('ent'),
      recordingId: context.ids.next('rec'),
    };
    for (const ids of [crashed, finishing]) {
      await context.journal.createVoiceDraft({ ...ids, startedAt: 1 });
    }
    await context.journal.updateRecordingProgress(
      crashed.recordingId,
      { state: 'recording', durationMs: 2_000, sealedChunks: 2, byteCount: 1 },
      2,
    );
    await context.journal.updateRecordingProgress(
      finishing.recordingId,
      { state: 'finalizing', durationMs: 3_000, sealedChunks: 3, byteCount: 1 },
      2,
    );
    const rows = await context.journal.recordingsForReconciliation();
    const plan = planReconciliation(rows, [
      {
        relativePath: `recordings/${crashed.recordingId}.ajr`,
        check: 'authenticated',
        fileBytes: 64_456,
        headerValid: true,
        authenticatedChunks: 2,
        authenticatedMs: 2_000,
        // Damage, not a torn write: the capture needs attention.
        trailingBytes: 400,
        tail: 'damaged',
        byteCount: 64_056,
      },
      {
        relativePath: `recordings/${finishing.recordingId}.ajr`,
        check: 'authenticated',
        fileBytes: 96_084,
        headerValid: true,
        authenticatedChunks: 3,
        authenticatedMs: 3_000,
        trailingBytes: 0,
        tail: 'none',
        byteCount: 96_084,
        contentSha256: SHA_A,
      },
    ]);
    await context.journal.applyReconciliation(plan, 99);

    expect(await context.journal.getEntry(crashed.entryId)).toMatchObject({
      entry: { status: 'recovery_required' },
      recording: { state: 'recoverable', durationMs: 2_000 },
    });
    expect(await context.journal.getEntry(finishing.entryId)).toMatchObject({
      entry: { status: 'ready' },
      recording: {
        state: 'ready',
        finishReason: 'recovered',
        contentSha256: SHA_A,
      },
    });
    // The user can then keep the recovered audio.
    await context.journal.finalizeVoice({
      recordingId: crashed.recordingId,
      endedAt: 100,
      durationMs: 2_000,
      sealedChunks: 2,
      byteCount: 64_056,
      contentSha256: SHA_A,
      finishReason: 'recovered',
    });
    expect(
      (await context.journal.getEntry(crashed.entryId))?.entry.status,
    ).toBe('ready');
  });
});

describe('restart', () => {
  it('reopens a file-backed database with every committed row intact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aj1-db-'));
    const location = path.join(directory, 'journal.db');
    try {
      const first = await openJournal(location, 3);
      const { entryId, recordingId } = await readyVoiceEntry(first, 4_000);
      await first.transcripts.saveEngineRevision({
        recordingId,
        modelId: 'tiny.en-q5_1',
        segments: [{ startMs: 0, endMs: 3_000, text: 'persisted' }],
        createdAt: 5,
      });
      await first.db.close();

      const second = await openJournal(location, 4);
      expect(await second.journal.getEntry(entryId)).toMatchObject({
        entry: { status: 'ready' },
        recording: { durationMs: 4_000 },
        transcript: {
          kind: 'final',
          modelId: 'tiny.en-q5_1',
          lines: [{ text: 'persisted' }],
        },
      });
      await second.db.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('live transcript retention (owner decision 2026-10-10)', () => {
  async function capturingRecording() {
    const entryId = context.ids.next('ent');
    const recordingId = context.ids.next('rec');
    await context.journal.createVoiceDraft({
      entryId,
      recordingId,
      startedAt: 1,
    });
    await context.journal.updateRecordingProgress(
      recordingId,
      {
        state: 'recording',
        durationMs: 20_000,
        sealedChunks: 20,
        byteCount: 1,
      },
      2,
    );
    return { entryId, recordingId };
  }

  const live = (segmentId: string, text = 'words') => ({
    segmentId,
    revision: 1,
    startMs: 0,
    endMs: 1_000,
    text,
  });

  it('keeps live rows marked superseded after the full pass and freezes them', async () => {
    const { recordingId } = await capturingRecording();
    const segment = context.ids.next('seg');
    await context.transcripts.upsertProvisional(
      recordingId,
      [live(segment, 'live')],
      3,
    );
    await context.journal.finalizeVoice({
      recordingId,
      endedAt: 30,
      durationMs: 20_000,
      sealedChunks: 20,
      byteCount: 640_320,
      contentSha256: SHA_A,
      finishReason: 'user',
    });
    await context.transcripts.saveEngineRevision({
      recordingId,
      modelId: 'base.en-q5_1',
      segments: [{ startMs: 0, endMs: 900, text: 'final' }],
      createdAt: 40,
    });
    const records = await context.transcripts.records(recordingId);
    expect(records.find(r => r.id === segment)).toMatchObject({
      state: 'provisional',
      supersededAt: 40,
      text: 'live',
    });
    expect((await context.transcripts.current(recordingId)).lines).toEqual([
      expect.objectContaining({ text: 'final' }),
    ]);
    await expect(
      context.db.run("UPDATE transcript_segments SET text = 'x' WHERE id = ?", [
        segment,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      context.db.run('DELETE FROM transcript_segments WHERE id = ?', [segment]),
    ).rejects.toThrow(/append-only/);
  });

  it('retires a replaced live row without deleting it', async () => {
    const { recordingId } = await capturingRecording();
    const [first, second] = [context.ids.next('seg'), context.ids.next('seg')];
    await context.transcripts.upsertProvisional(
      recordingId,
      [live(first, 'overlap a'), live(second, 'overlap b')],
      3,
    );
    await context.transcripts.retireProvisional(recordingId, [first], 4);
    expect(
      (await context.transcripts.current(recordingId)).lines.map(l => l.text),
    ).toEqual(['overlap b']);
    // A late update for the retired row changes nothing.
    await context.transcripts.upsertProvisional(
      recordingId,
      [live(first, 'late')],
      5,
    );
    expect(
      (await context.transcripts.records(recordingId)).find(
        r => r.id === first,
      ),
    ).toMatchObject({ text: 'overlap a', supersededAt: 4 });
  });

  it('bounds live rows per recording in the repository and the schema', async () => {
    const { entryId, recordingId } = await capturingRecording();
    const batch = Array.from({ length: 4_000 }, () =>
      live(context.ids.next('seg')),
    );
    await context.transcripts.upsertProvisional(recordingId, batch, 3);
    await expect(
      context.transcripts.upsertProvisional(
        recordingId,
        [live(context.ids.next('seg'))],
        4,
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    // Revising an existing live row is still allowed at the bound.
    await context.transcripts.upsertProvisional(
      recordingId,
      [{ ...batch[0], revision: 2, text: 'revised' }],
      5,
    );
    // The schema enforces the same bound if code is bypassed.
    await expect(
      context.db.run(
        `INSERT INTO transcript_segments (id, entry_id, recording_id, engine_revision,
          ordinal, start_ms, end_ms, text, state, source, created_at)
          VALUES (?, ?, ?, 0, 0, 0, 1, 'x', 'provisional', 'engine', 6)`,
        [context.ids.next('seg'), entryId, recordingId],
      ),
    ).rejects.toThrow(/provisional segment limit/);
  });
});
