import type {
  AbnormalEnd,
  PauseReason,
  StartRefusal,
} from '../domain/recordingSession';
import type { RecordingFileScan } from '../domain/reconciliation';

// Native capture port (ADR-008, ADR-017, LLD §5). Audio, PCM frames, and keys
// stay native: JavaScript sees only progress, levels, and terminal results.
// Live transcription is fed natively from the recorder's in-memory PCM.

export type RecordingEvent =
  | { type: 'started' }
  | {
      type: 'progress';
      capturedMs: number;
      sealedChunks: number;
      /** Ciphertext bytes written so far. */
      byteCount: number;
      freeBytes: number;
      /** Bounded meter value, 0..1. */
      level: number;
    }
  | { type: 'paused'; reason: PauseReason }
  | { type: 'resumed' }
  | { type: 'finalized'; capturedMs: number; sealedChunks: number }
  | {
      type: 'ended_abnormally';
      cause: AbnormalEnd;
      capturedMs: number;
      sealedChunks: number;
    };

export interface FinalizedRecording {
  durationMs: number;
  sealedChunks: number;
  byteCount: number;
  contentSha256: string;
}

export interface RecordingService {
  freeBytes(): Promise<number>;
  /** Creates the sealed AJR1 file; refuses without the microphone or space. */
  prepare(
    recordingId: string,
  ): Promise<{ ok: true } | { ok: false; refusal: StartRefusal }>;
  start(
    recordingId: string,
    onEvent: (event: RecordingEvent) => void,
  ): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  finish(): Promise<FinalizedRecording>;
  /** Discards an unfinished capture after the user confirmed (AJ-FR-003). */
  discard(recordingId: string): Promise<void>;
  /**
   * Scans the recording root, or one recording's file. Unfinished captures are
   * authenticated chunk by chunk; finalized ones may be checked by header and
   * length so startup cost does not grow with the whole archive.
   */
  scan(recordingId?: string): Promise<RecordingFileScan[]>;
  /** Truncates to the authenticated prefix (recoverable recordings). */
  dropTornTail(recordingId: string, sealedChunks: number): Promise<void>;
  quarantine(relativePath: string): Promise<void>;
}
