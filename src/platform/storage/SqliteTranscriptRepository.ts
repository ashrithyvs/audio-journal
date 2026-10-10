import type { IdSource } from '../../features/journal/domain/ids';
import {
  buildEngineRevision,
  currentTranscript,
  withEmptyPass,
  nextEngineRevision,
  normalizeSegmentText,
  planCorrection,
  TRANSCRIPT_LIMITS,
  type NormalizedSegment,
  type ProvisionalUpdate,
  type TranscriptSegmentRecord,
  type TranscriptView,
} from '../../features/journal/domain/transcript';
import {
  RepositoryError,
  type TranscriptRepository,
} from '../../features/journal/ports/JournalRepository';
import { toSegment, type RecordingRow, type SegmentRow } from './rows';
import type { SqlDatabase, SqlExecutor } from './SqlDatabase';

const INSERT_SEGMENT = `INSERT INTO transcript_segments
  (id, entry_id, recording_id, engine_revision, ordinal, start_ms, end_ms,
   text, state, source, model_id, supersedes_segment_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

async function insertSegment(
  tx: SqlExecutor,
  record: TranscriptSegmentRecord,
): Promise<void> {
  await tx.run(INSERT_SEGMENT, [
    record.id,
    record.entryId,
    record.recordingId,
    record.engineRevision,
    record.ordinal,
    record.startMs,
    record.endMs,
    record.text,
    record.state,
    record.source,
    record.modelId ?? null,
    record.supersedesSegmentId ?? null,
    record.createdAt,
  ]);
}

async function segmentsOf(
  tx: SqlExecutor,
  recordingId: string,
): Promise<TranscriptSegmentRecord[]> {
  const rows = await tx.all<SegmentRow>(
    'SELECT * FROM transcript_segments WHERE recording_id = ?',
    [recordingId],
  );
  return rows.map(toSegment);
}

/** Live text is only accepted while capturing and before any full pass. */
async function capturing(
  tx: SqlExecutor,
  recordingId: string,
): Promise<RecordingRow> {
  const recording = await tx.get<RecordingRow>(
    'SELECT * FROM recordings WHERE id = ?',
    [recordingId],
  );
  if (
    !recording ||
    !['recording', 'paused', 'finalizing'].includes(recording.state)
  ) {
    throw new RepositoryError('INVALID_STATE', 'recording not capturing');
  }
  return recording;
}

export class SqliteTranscriptRepository implements TranscriptRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly ids: IdSource,
  ) {}

  async upsertProvisional(
    recordingId: string,
    batch: readonly ProvisionalUpdate[],
    at: number,
  ): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    await this.db.transaction(async tx => {
      const recording = await capturing(tx, recordingId);
      const known = new Set(
        (
          await tx.all<{ id: string }>(
            'SELECT id FROM transcript_segments WHERE recording_id = ? AND engine_revision = 0',
            [recordingId],
          )
        ).map(row => row.id),
      );
      const added = new Set(
        batch.map(update => update.segmentId).filter(id => !known.has(id)),
      );
      if (known.size + added.size > TRANSCRIPT_LIMITS.maxProvisionalSegments) {
        throw new RepositoryError('LIMIT_EXCEEDED', 'provisional segments');
      }
      for (const update of batch) {
        // A superseded row is frozen: a late update for it changes nothing.
        await tx.run(
          `INSERT INTO transcript_segments
            (id, entry_id, recording_id, engine_revision, ordinal, start_ms,
             end_ms, text, state, source, created_at)
            VALUES (?, ?, ?, 0, 0, ?, ?, ?, 'provisional', 'engine', ?)
            ON CONFLICT (id) DO UPDATE SET start_ms = excluded.start_ms,
              end_ms = excluded.end_ms, text = excluded.text
            WHERE transcript_segments.recording_id = excluded.recording_id
              AND transcript_segments.state = 'provisional'
              AND transcript_segments.superseded_at IS NULL`,
          [
            update.segmentId,
            recording.entry_id,
            recordingId,
            update.startMs,
            update.endMs,
            normalizeSegmentText(update.text).slice(
              0,
              TRANSCRIPT_LIMITS.maxSegmentChars,
            ),
            at,
          ],
        );
      }
    });
  }

  async retireProvisional(
    recordingId: string,
    segmentIds: readonly string[],
    at: number,
  ): Promise<void> {
    if (segmentIds.length === 0) {
      return;
    }
    await this.db.transaction(async tx => {
      await capturing(tx, recordingId);
      for (const id of segmentIds) {
        await tx.run(
          `UPDATE transcript_segments SET superseded_at = ?
            WHERE id = ? AND recording_id = ? AND state = 'provisional'
              AND superseded_at IS NULL`,
          [at, id, recordingId],
        );
      }
    });
  }

  async saveEngineRevision(input: {
    recordingId: string;
    modelId: string;
    segments: readonly NormalizedSegment[];
    createdAt: number;
  }): Promise<{ engineRevision: number; segmentCount: number }> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.modelId)) {
      throw new RepositoryError('INVALID_INPUT', 'model id');
    }
    return this.db.transaction(async tx => {
      const recording = await tx.get<RecordingRow>(
        'SELECT * FROM recordings WHERE id = ?',
        [input.recordingId],
      );
      if (!recording) {
        throw new RepositoryError('NOT_FOUND', 'recording');
      }
      // A full pass reads the sealed recording, so it must be finalized.
      if (recording.state !== 'ready') {
        throw new RepositoryError('INVALID_STATE', recording.state);
      }
      // Re-check the already-validated segments against the stored duration.
      let previousStart = 0;
      for (const segment of input.segments) {
        if (
          !Number.isInteger(segment.startMs) ||
          !Number.isInteger(segment.endMs) ||
          segment.startMs < previousStart ||
          segment.endMs < segment.startMs ||
          segment.endMs > recording.duration_ms ||
          segment.text.length === 0 ||
          segment.text.length > TRANSCRIPT_LIMITS.maxSegmentChars
        ) {
          throw new RepositoryError('INVALID_INPUT', 'segment bounds');
        }
        previousStart = segment.startMs;
      }
      // Empty passes leave no segments, so the pass log counts too.
      const lastPass = await tx.get<{ revision: number | null }>(
        'SELECT max(engine_revision) AS revision FROM transcript_passes WHERE recording_id = ?',
        [input.recordingId],
      );
      const engineRevision = Math.max(
        nextEngineRevision(await segmentsOf(tx, input.recordingId)),
        (lastPass?.revision ?? 0) + 1,
      );
      const records = buildEngineRevision({
        entryId: recording.entry_id,
        recordingId: input.recordingId,
        modelId: input.modelId,
        engineRevision,
        segments: input.segments,
        createdAt: input.createdAt,
        ids: this.ids,
      });
      for (const record of records) {
        await insertSegment(tx, record);
      }
      await tx.run(
        `INSERT INTO transcript_passes
          (recording_id, engine_revision, model_id, segment_count, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        [
          input.recordingId,
          engineRevision,
          input.modelId,
          records.length,
          input.createdAt,
        ],
      );
      // The full pass supersedes all live text in the same transaction.
      await tx.run(
        `UPDATE transcript_segments SET superseded_at = ?
          WHERE recording_id = ? AND state = 'provisional'
            AND superseded_at IS NULL`,
        [input.createdAt, input.recordingId],
      );
      return { engineRevision, segmentCount: records.length };
    });
  }

  async awaitingFinalPass(): Promise<
    { recordingId: string; durationMs: number }[]
  > {
    // A restored journal has final segments but no pass log; both count.
    const rows = await this.db.all<{ id: string; duration_ms: number }>(
      `SELECT r.id, r.duration_ms FROM recordings r
        JOIN journal_entries e ON e.id = r.entry_id
        WHERE r.state = 'ready' AND e.status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM transcript_passes p WHERE p.recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM transcript_segments s
            WHERE s.recording_id = r.id AND s.engine_revision > 0)
        ORDER BY r.started_at, r.id`,
    );
    return rows.map(row => ({
      recordingId: row.id,
      durationMs: row.duration_ms,
    }));
  }

  async correct(
    segmentId: string,
    text: string,
    at: number,
  ): Promise<TranscriptSegmentRecord> {
    return this.db.transaction(async tx => {
      const target = await tx.get<SegmentRow>(
        'SELECT recording_id FROM transcript_segments WHERE id = ?',
        [segmentId],
      );
      if (!target) {
        throw new RepositoryError('NOT_FOUND', 'segment');
      }
      const plan = planCorrection({
        records: await segmentsOf(tx, target.recording_id),
        segmentId,
        text,
        createdAt: at,
        ids: this.ids,
      });
      if (!plan.ok) {
        throw new RepositoryError(
          plan.reason === 'STALE' || plan.reason === 'NOT_CURRENT_REVISION'
            ? 'CONFLICT'
            : 'INVALID_INPUT',
          plan.reason,
        );
      }
      await insertSegment(tx, plan.record);
      return plan.record;
    });
  }

  async records(recordingId: string): Promise<TranscriptSegmentRecord[]> {
    return segmentsOf(this.db, recordingId);
  }

  async current(recordingId: string): Promise<TranscriptView> {
    return withEmptyPass(
      currentTranscript(await segmentsOf(this.db, recordingId)),
      await lastPassOf(this.db, recordingId),
    );
  }
}

/** The latest logged full pass of a recording (migration 2). */
export async function lastPassOf(
  db: SqlExecutor,
  recordingId: string,
): Promise<{ engineRevision: number; modelId: string } | undefined> {
  const row = await db.get<{ engine_revision: number; model_id: string }>(
    `SELECT engine_revision, model_id FROM transcript_passes
      WHERE recording_id = ? ORDER BY engine_revision DESC LIMIT 1`,
    [recordingId],
  );
  return row
    ? { engineRevision: row.engine_revision, modelId: row.model_id }
    : undefined;
}
