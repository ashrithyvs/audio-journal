import { isRecordingRelativePath } from './ids';
import {
  isSha256Hex,
  NONTERMINAL_RECORDING_STATES,
  type RecordingRecord,
} from './entry';

// Startup reconciliation (LLD §9, ADR-017). Native code scans the recording
// root and authenticates AJR1 chunks; this decides what the database should
// say about each recording. It never deletes: malformed or unknown files are
// quarantined, and any authenticated audio stays recoverable.

export interface RecordingFileScan {
  relativePath: string;
  /** Header authenticated with the recording key. */
  headerValid: boolean;
  /** Leading chunks that authenticate in order. */
  authenticatedChunks: number;
  /** Audio covered by those chunks. */
  authenticatedMs: number;
  /** Bytes after the last authenticated chunk (a torn or corrupt tail). */
  trailingBytes: number;
  /** Ciphertext bytes covered by the authenticated chunks. */
  byteCount: number;
  /** SHA-256 of the authenticated plaintext PCM, when every chunk was read. */
  contentSha256?: string;
}

export type ReconciliationAction =
  | {
      type: 'promote';
      recordingId: string;
      entryId: string;
      durationMs: number;
      sealedChunks: number;
      byteCount: number;
      contentSha256: string;
    }
  | {
      type: 'mark_recoverable';
      recordingId: string;
      entryId: string;
      durationMs: number;
      sealedChunks: number;
      /** Native code truncates the file to these chunks before playback. */
      dropTornTail: boolean;
    }
  | {
      type: 'mark_failed';
      recordingId: string;
      entryId: string;
      cause: 'NO_AUDIO' | 'FILE_MISSING' | 'HEADER_INVALID';
    }
  | {
      type: 'flag_source_damaged';
      recordingId: string;
      entryId: string;
      cause:
        | 'FILE_MISSING'
        | 'HEADER_INVALID'
        | 'CHUNKS_MISSING'
        | 'TRAILING_DATA';
    }
  | {
      type: 'quarantine_file';
      relativePath: string;
      cause: 'UNKNOWN_FILE' | 'UNSAFE_NAME';
    };

const NONTERMINAL = new Set(NONTERMINAL_RECORDING_STATES);

export function planReconciliation(
  recordings: readonly RecordingRecord[],
  files: readonly RecordingFileScan[],
): ReconciliationAction[] {
  const actions: ReconciliationAction[] = [];
  const byPath = new Map(files.map(file => [file.relativePath, file]));
  const known = new Set<string>();

  for (const recording of [...recordings].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  )) {
    known.add(recording.relativePath);
    const file = byPath.get(recording.relativePath);
    const ids = { recordingId: recording.id, entryId: recording.entryId };

    if (NONTERMINAL.has(recording.state)) {
      if (!file) {
        // A row written before the native file existed: nothing was captured.
        actions.push({ type: 'mark_failed', ...ids, cause: 'FILE_MISSING' });
      } else if (!file.headerValid) {
        actions.push({ type: 'mark_failed', ...ids, cause: 'HEADER_INVALID' });
      } else if (file.authenticatedChunks === 0) {
        actions.push({ type: 'mark_failed', ...ids, cause: 'NO_AUDIO' });
      } else if (
        recording.state === 'finalizing' &&
        file.trailingBytes === 0 &&
        file.authenticatedChunks >= recording.sealedChunks &&
        isSha256Hex(file.contentSha256)
      ) {
        // Finish was requested and every byte authenticates: complete it.
        actions.push({
          type: 'promote',
          ...ids,
          durationMs: file.authenticatedMs,
          sealedChunks: file.authenticatedChunks,
          byteCount: file.byteCount,
          contentSha256: file.contentSha256,
        });
      } else {
        actions.push({
          type: 'mark_recoverable',
          ...ids,
          durationMs: file.authenticatedMs,
          sealedChunks: file.authenticatedChunks,
          dropTornTail: file.trailingBytes > 0,
        });
      }
    } else if (recording.state === 'ready') {
      // Finalized source must still be whole; damage is surfaced, never hidden.
      if (!file) {
        actions.push({
          type: 'flag_source_damaged',
          ...ids,
          cause: 'FILE_MISSING',
        });
      } else if (!file.headerValid) {
        actions.push({
          type: 'flag_source_damaged',
          ...ids,
          cause: 'HEADER_INVALID',
        });
      } else if (file.authenticatedChunks < recording.sealedChunks) {
        actions.push({
          type: 'flag_source_damaged',
          ...ids,
          cause: 'CHUNKS_MISSING',
        });
      } else if (file.trailingBytes > 0) {
        actions.push({
          type: 'flag_source_damaged',
          ...ids,
          cause: 'TRAILING_DATA',
        });
      }
    }
    // 'recoverable' and 'failed' rows wait for the user; nothing to do.
  }

  for (const file of [...files].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : 1,
  )) {
    if (!known.has(file.relativePath)) {
      actions.push({
        type: 'quarantine_file',
        relativePath: file.relativePath,
        cause: isRecordingRelativePath(file.relativePath)
          ? 'UNKNOWN_FILE'
          : 'UNSAFE_NAME',
      });
    }
  }
  return actions;
}
