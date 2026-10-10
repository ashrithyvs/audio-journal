import {
  validateTitle,
  validateWrittenText,
  isSha256Hex,
  NONTERMINAL_RECORDING_STATES,
  type JournalEntry,
  type RecordingRecord,
} from '../../features/journal/domain/entry';
import {
  isLocalId,
  recordingRelativePath,
} from '../../features/journal/domain/ids';
import type { ReconciliationAction } from '../../features/journal/domain/reconciliation';
import {
  excerptOf,
  type TimelineEntry,
} from '../../features/journal/domain/timeline';
import {
  currentTranscript,
  withEmptyPass,
} from '../../features/journal/domain/transcript';
import { lastPassOf } from './SqliteTranscriptRepository';
import {
  RepositoryError,
  type FinalizeVoiceInput,
  type JournalEntryDetail,
  type JournalRepository,
  type RecordingProgress,
  type TimelineCursor,
  type VoiceDraftInput,
  type WrittenEntryInput,
} from '../../features/journal/ports/JournalRepository';
import {
  toEntry,
  toRecording,
  toSegment,
  type EntryRow,
  type RecordingRow,
  type SegmentRow,
} from './rows';
import type { SqlDatabase, SqlExecutor } from './SqlDatabase';

const isNonterminal = (state: string) =>
  (NONTERMINAL_RECORDING_STATES as readonly string[]).includes(state);

const NONTERMINAL_SQL = NONTERMINAL_RECORDING_STATES.map(
  state => `'${state}'`,
).join(', ');

export const MAX_TIMELINE_PAGE = 200;

async function recordingRow(
  tx: SqlExecutor,
  recordingId: string,
): Promise<RecordingRow> {
  const row = await tx.get<RecordingRow>(
    'SELECT * FROM recordings WHERE id = ?',
    [recordingId],
  );
  if (!row) {
    throw new RepositoryError('NOT_FOUND', 'recording');
  }
  return row;
}

export class SqliteJournalRepository implements JournalRepository {
  constructor(private readonly db: SqlDatabase) {}

  async createWritten(input: WrittenEntryInput): Promise<JournalEntry> {
    if (!isLocalId(input.id, 'ent')) {
      throw new RepositoryError('INVALID_INPUT', 'entry id');
    }
    const text = validateWrittenText(input.text);
    const title = validateTitle(input.title);
    if (!text.ok || !title.ok) {
      throw new RepositoryError('INVALID_INPUT', text.ok ? 'title' : 'text');
    }
    const entry: JournalEntry = {
      id: input.id,
      kind: 'written',
      status: 'ready',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      title: title.title,
      sourceText: text.text,
    };
    await this.db.run(
      `INSERT INTO journal_entries
        (id, kind, status, created_at, updated_at, title, source_text)
        VALUES (?, 'written', 'ready', ?, ?, ?, ?)`,
      [
        entry.id,
        entry.createdAt,
        entry.updatedAt,
        entry.title ?? null,
        text.text,
      ],
    );
    return entry;
  }

  async createVoiceDraft(input: VoiceDraftInput): Promise<RecordingRecord> {
    if (
      !isLocalId(input.entryId, 'ent') ||
      !isLocalId(input.recordingId, 'rec')
    ) {
      throw new RepositoryError('INVALID_INPUT', 'ids');
    }
    const relativePath = recordingRelativePath(input.recordingId);
    await this.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO journal_entries (id, kind, status, created_at, updated_at)
          VALUES (?, 'voice', 'draft', ?, ?)`,
        [input.entryId, input.startedAt, input.startedAt],
      );
      await tx.run(
        `INSERT INTO recordings
          (id, entry_id, relative_path, state, format, started_at)
          VALUES (?, ?, ?, 'preparing', 'AJR1/pcm_s16le/16000/1', ?)`,
        [input.recordingId, input.entryId, relativePath, input.startedAt],
      );
    });
    return toRecording(await recordingRow(this.db, input.recordingId));
  }

  async updateRecordingProgress(
    recordingId: string,
    progress: RecordingProgress,
    at: number,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await recordingRow(tx, recordingId);
      if (!isNonterminal(row.state)) {
        throw new RepositoryError('INVALID_STATE', row.state);
      }
      // Progress only moves forward, even if reports arrive out of order.
      await tx.run(
        `UPDATE recordings SET state = ?,
          duration_ms = max(duration_ms, ?),
          sealed_chunks = max(sealed_chunks, ?),
          byte_count = max(byte_count, ?)
          WHERE id = ?`,
        [
          progress.state,
          progress.durationMs,
          progress.sealedChunks,
          progress.byteCount,
          recordingId,
        ],
      );
      await tx.run(
        'UPDATE journal_entries SET updated_at = max(updated_at, ?) WHERE id = ?',
        [at, row.entry_id],
      );
    });
  }

  async finalizeVoice(input: FinalizeVoiceInput): Promise<void> {
    if (
      !isSha256Hex(input.contentSha256) ||
      input.sealedChunks < 1 ||
      input.durationMs < 0
    ) {
      throw new RepositoryError('INVALID_INPUT', 'finalization');
    }
    await this.db.transaction(async tx => {
      const row = await recordingRow(tx, input.recordingId);
      const recovering = row.state === 'recoverable';
      if (!isNonterminal(row.state) && !recovering) {
        throw new RepositoryError('INVALID_STATE', row.state);
      }
      if ((input.finishReason === 'recovered') !== recovering) {
        throw new RepositoryError('INVALID_INPUT', 'finish reason');
      }
      await tx.run(
        `UPDATE recordings SET state = 'ready', ended_at = ?, duration_ms = ?,
          sealed_chunks = ?, byte_count = ?, content_sha256 = ?, finish_reason = ?
          WHERE id = ?`,
        [
          input.endedAt,
          input.durationMs,
          input.sealedChunks,
          input.byteCount,
          input.contentSha256,
          input.finishReason,
          input.recordingId,
        ],
      );
      await tx.run(
        `UPDATE journal_entries SET status = 'ready', updated_at = max(updated_at, ?)
          WHERE id = ?`,
        [input.endedAt, row.entry_id],
      );
    });
  }

  async discardDraft(recordingId: string, at: number): Promise<void> {
    await this.db.transaction(async tx => {
      const row = await recordingRow(tx, recordingId);
      if (!isNonterminal(row.state)) {
        throw new RepositoryError('INVALID_STATE', row.state);
      }
      await tx.run(
        "UPDATE recordings SET state = 'failed', ended_at = max(started_at, ?) WHERE id = ?",
        [at, recordingId],
      );
      await tx.run(
        `UPDATE journal_entries SET status = 'deleted', updated_at = max(updated_at, ?)
          WHERE id = ?`,
        [at, row.entry_id],
      );
    });
  }

  async getEntry(id: string): Promise<JournalEntryDetail | null> {
    if (!isLocalId(id, 'ent')) {
      return null;
    }
    const row = await this.db.get<EntryRow>(
      'SELECT * FROM journal_entries WHERE id = ?',
      [id],
    );
    if (!row || row.status === 'deleted') {
      return null;
    }
    const recording = await this.db.get<RecordingRow>(
      'SELECT * FROM recordings WHERE entry_id = ?',
      [id],
    );
    const segments = recording
      ? await this.db.all<SegmentRow>(
          'SELECT * FROM transcript_segments WHERE recording_id = ?',
          [recording.id],
        )
      : [];
    return {
      entry: toEntry(row),
      recording: recording ? toRecording(recording) : undefined,
      transcript: withEmptyPass(
        currentTranscript(segments.map(toSegment)),
        recording ? await lastPassOf(this.db, recording.id) : undefined,
      ),
    };
  }

  async listTimeline(query: {
    limit: number;
    before?: TimelineCursor;
  }): Promise<TimelineEntry[]> {
    const limit = Math.max(
      1,
      Math.min(MAX_TIMELINE_PAGE, Math.floor(query.limit)),
    );
    const before = query.before;
    // Keyset pagination on the partial timeline index: stable under inserts.
    const rows = await this.db.all<EntryRow & { duration_ms: number | null }>(
      `SELECT e.*, r.duration_ms FROM journal_entries e
        LEFT JOIN recordings r ON r.entry_id = e.id
        WHERE e.status IN ('ready', 'recovery_required')
        ${
          before
            ? 'AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))'
            : ''
        }
        ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
      before ? [before.createdAt, before.createdAt, before.id, limit] : [limit],
    );
    return rows.map(row => ({
      id: row.id,
      kind: row.kind as TimelineEntry['kind'],
      status: row.status as TimelineEntry['status'],
      createdAt: row.created_at,
      title: row.title ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      excerpt:
        row.source_text === null ? undefined : excerptOf(row.source_text),
    }));
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = await this.db.get<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = ?',
      [key],
    );
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async recordingsForReconciliation(): Promise<RecordingRecord[]> {
    const rows = await this.db.all<RecordingRow>(
      'SELECT * FROM recordings ORDER BY id',
    );
    return rows.map(toRecording);
  }

  async applyReconciliation(
    actions: readonly ReconciliationAction[],
    at: number,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      for (const action of actions) {
        switch (action.type) {
          case 'promote':
            // An unfinished capture whose authenticated audio is intact
            // completes as 'recovered' (ADR-017, owner decision 2026-10-10).
            await tx.run(
              `UPDATE recordings SET state = 'ready', ended_at = max(started_at, ?),
                duration_ms = ?, sealed_chunks = ?, byte_count = ?,
                content_sha256 = ?, finish_reason = 'recovered'
                WHERE id = ? AND state IN (${NONTERMINAL_SQL})`,
              [
                at,
                action.durationMs,
                action.sealedChunks,
                action.byteCount,
                action.contentSha256,
                action.recordingId,
              ],
            );
            await tx.run(
              `UPDATE journal_entries SET status = 'ready', updated_at = max(updated_at, ?)
                WHERE id = ? AND status = 'draft'`,
              [at, action.entryId],
            );
            break;
          case 'mark_recoverable':
            await tx.run(
              `UPDATE recordings SET state = 'recoverable', duration_ms = ?,
                sealed_chunks = ? WHERE id = ? AND state IN (${NONTERMINAL_SQL})`,
              [action.durationMs, action.sealedChunks, action.recordingId],
            );
            await this.markEntry(tx, action.entryId, 'recovery_required', at);
            break;
          case 'mark_failed':
            await tx.run(
              `UPDATE recordings SET state = 'failed'
                WHERE id = ? AND state IN (${NONTERMINAL_SQL})`,
              [action.recordingId],
            );
            await this.markEntry(tx, action.entryId, 'recovery_required', at);
            break;
          case 'flag_source_damaged':
            await this.markEntry(tx, action.entryId, 'recovery_required', at);
            break;
          case 'quarantine_file':
            // File-system only; the database has no row for it.
            break;
        }
      }
    });
  }

  private async markEntry(
    tx: SqlExecutor,
    entryId: string,
    status: 'recovery_required',
    at: number,
  ): Promise<void> {
    await tx.run(
      `UPDATE journal_entries SET status = ?, updated_at = max(updated_at, ?)
        WHERE id = ? AND status <> 'deleted'`,
      [status, at, entryId],
    );
  }
}
