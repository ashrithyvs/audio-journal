import {
  AJR1_FORMAT,
  type EntryKind,
  type EntryStatus,
  type JournalEntry,
  type RecordingFinishReason,
  type RecordingRecord,
  type RecordingState,
} from '../../features/journal/domain/entry';
import type {
  SegmentSource,
  SegmentState,
  TranscriptSegmentRecord,
} from '../../features/journal/domain/transcript';

// Row <-> domain mapping. Column constraints in `migrations.ts` guarantee the
// enum values, so these casts narrow rather than trust arbitrary input.

export interface EntryRow {
  [column: string]: string | number | null;
  id: string;
  kind: string;
  status: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  source_text: string | null;
}

export interface RecordingRow {
  [column: string]: string | number | null;
  id: string;
  entry_id: string;
  relative_path: string;
  state: string;
  format: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number;
  sealed_chunks: number;
  byte_count: number;
  content_sha256: string | null;
  finish_reason: string | null;
}

export interface SegmentRow {
  [column: string]: string | number | null;
  id: string;
  entry_id: string;
  recording_id: string;
  engine_revision: number;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  text: string;
  state: string;
  source: string;
  model_id: string | null;
  supersedes_segment_id: string | null;
  superseded_at: number | null;
  created_at: number;
}

const optional = <T>(value: T | null): T | undefined =>
  value === null ? undefined : value;

export function toEntry(row: EntryRow): JournalEntry {
  return {
    id: row.id,
    kind: row.kind as EntryKind,
    status: row.status as EntryStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: optional(row.title),
    sourceText: optional(row.source_text),
  };
}

export function toRecording(row: RecordingRow): RecordingRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    relativePath: row.relative_path,
    state: row.state as RecordingState,
    format: AJR1_FORMAT,
    startedAt: row.started_at,
    endedAt: optional(row.ended_at),
    durationMs: row.duration_ms,
    sealedChunks: row.sealed_chunks,
    byteCount: row.byte_count,
    contentSha256: optional(row.content_sha256),
    finishReason: optional(row.finish_reason) as
      | RecordingFinishReason
      | undefined,
  };
}

export function toSegment(row: SegmentRow): TranscriptSegmentRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    recordingId: row.recording_id,
    engineRevision: row.engine_revision,
    ordinal: row.ordinal,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    state: row.state as SegmentState,
    source: row.source as SegmentSource,
    modelId: optional(row.model_id),
    supersedesSegmentId: optional(row.supersedes_segment_id),
    supersededAt: optional(row.superseded_at),
    createdAt: row.created_at,
  };
}
