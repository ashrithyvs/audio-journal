import type {
  JournalEntry,
  RecordingFinishReason,
  RecordingRecord,
  RecordingState,
} from '../domain/entry';
import type { ReconciliationAction } from '../domain/reconciliation';
import type { TimelineEntry } from '../domain/timeline';
import type {
  NormalizedSegment,
  ProvisionalUpdate,
  TranscriptSegmentRecord,
  TranscriptView,
} from '../domain/transcript';

// Repository ports (LLD §4). They take domain data, never UI or SDK objects,
// and every multi-record change is one transaction.

export interface WrittenEntryInput {
  id: string;
  text: string;
  title?: string;
  createdAt: number;
}

export interface VoiceDraftInput {
  entryId: string;
  recordingId: string;
  startedAt: number;
}

export interface RecordingProgress {
  state: Extract<RecordingState, 'recording' | 'paused' | 'finalizing'>;
  durationMs: number;
  sealedChunks: number;
  byteCount: number;
}

export interface FinalizeVoiceInput {
  recordingId: string;
  endedAt: number;
  durationMs: number;
  sealedChunks: number;
  byteCount: number;
  contentSha256: string;
  finishReason: RecordingFinishReason;
}

export interface TimelineCursor {
  createdAt: number;
  id: string;
}

export interface JournalEntryDetail {
  entry: JournalEntry;
  recording?: RecordingRecord;
  transcript: TranscriptView;
}

export interface JournalRepository {
  createWritten(input: WrittenEntryInput): Promise<JournalEntry>;
  createVoiceDraft(input: VoiceDraftInput): Promise<RecordingRecord>;
  updateRecordingProgress(
    recordingId: string,
    progress: RecordingProgress,
    at: number,
  ): Promise<void>;
  finalizeVoice(input: FinalizeVoiceInput): Promise<void>;
  /**
   * A confirmed cancel of an unfinished capture (AJ-FR-003). Rows are kept and
   * marked, not deleted: retention and deletion are still Open (decision 6).
   * Call before the native file is removed, so a crash in between leaves a
   * known path rather than an untracked file.
   */
  discardDraft(recordingId: string, at: number): Promise<void>;
  getEntry(id: string): Promise<JournalEntryDetail | null>;
  listTimeline(query: {
    limit: number;
    before?: TimelineCursor;
  }): Promise<TimelineEntry[]>;
  recordingsForReconciliation(): Promise<RecordingRecord[]>;
  /** Non-sensitive app settings (app_settings), e.g. local backup history. */
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  applyReconciliation(
    actions: readonly ReconciliationAction[],
    at: number,
  ): Promise<void>;
}

export interface TranscriptRepository {
  /**
   * Batched live text, bounded per recording. The first full engine pass marks
   * every live row superseded; superseded rows are kept but never shown.
   */
  upsertProvisional(
    recordingId: string,
    batch: readonly ProvisionalUpdate[],
    at: number,
  ): Promise<void>;
  /** Live rows a later window replaced (overlap de-duplication). */
  retireProvisional(
    recordingId: string,
    segmentIds: readonly string[],
    at: number,
  ): Promise<void>;
  /** Validates and stores one full engine pass atomically, as a new revision. */
  saveEngineRevision(input: {
    recordingId: string;
    modelId: string;
    segments: readonly NormalizedSegment[];
    createdAt: number;
  }): Promise<{ engineRevision: number; segmentCount: number }>;
  /**
   * Ready recordings of visible entries that have no full pass yet (an empty
   * pass counts as done), oldest first: queued after each unlock.
   */
  awaitingFinalPass(): Promise<{ recordingId: string; durationMs: number }[]>;
  correct(
    segmentId: string,
    text: string,
    at: number,
  ): Promise<TranscriptSegmentRecord>;
  records(recordingId: string): Promise<TranscriptSegmentRecord[]>;
  current(recordingId: string): Promise<TranscriptView>;
}

export type RepositoryErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'CONFLICT'
  | 'LIMIT_EXCEEDED';

export class RepositoryError extends Error {
  constructor(readonly code: RepositoryErrorCode, readonly reason: string) {
    // The message carries codes only, never journal content.
    super(`${code}: ${reason}`);
    this.name = 'RepositoryError';
  }
}
