import type { StartRefusal } from '../../src/features/journal/domain/recordingSession';
import type {
  AuthenticatedFileScan,
  RecordingFileScan,
} from '../../src/features/journal/domain/reconciliation';
import type {
  FinalizedRecording,
  RecordingEvent,
  RecordingService,
} from '../../src/features/journal/ports/RecordingService';
import { SHA_A } from '../sqlite/journalFixtures';

const MIB = 1024 * 1024;
/** The AJR1 header (LLD §5.1). */
export const HEADER_BYTES = 64;
/** One sealed frame: index and length, 1 s of PCM, and a GCM tag. */
export const CHUNK_BYTES = 12 + 32_000 + 16;

/** Scriptable stand-in for the native recorder; holds no audio. */
export class FakeRecordingService implements RecordingService {
  free = 1_000 * MIB;
  microphone = true;
  refusal?: StartRefusal;
  startFails = false;
  finishFails = false;
  /** What a full authentication of each file would find. */
  files = new Map<string, AuthenticatedFileScan>();
  calls: string[] = [];
  private listener?: (event: RecordingEvent) => void;
  private active?: string;
  private capturedMs = 0;

  async freeBytes() {
    return this.free;
  }

  async requestMicrophone() {
    this.calls.push('requestMicrophone');
    return this.microphone;
  }

  async prepare(recordingId: string) {
    this.calls.push(`prepare ${recordingId}`);
    if (this.refusal) {
      return { ok: false as const, refusal: this.refusal };
    }
    this.active = recordingId;
    this.capturedMs = 0;
    this.write(0);
    return { ok: true as const };
  }

  async start(recordingId: string, onEvent: (event: RecordingEvent) => void) {
    this.calls.push(`start ${recordingId}`);
    if (this.startFails) {
      throw new Error('RECORDER_FAILED');
    }
    this.listener = onEvent;
    onEvent({ type: 'started' });
  }

  /** Simulates captured audio; sealed chunks follow whole seconds. */
  capture(ms: number, level = 0.5) {
    this.capturedMs += ms;
    const chunks = Math.floor(this.capturedMs / 1000);
    this.write(chunks);
    this.listener?.({
      type: 'progress',
      capturedMs: this.capturedMs,
      sealedChunks: chunks,
      byteCount: HEADER_BYTES + chunks * CHUNK_BYTES,
      freeBytes: this.free,
      level,
    });
  }

  emit(event: RecordingEvent) {
    this.listener?.(event);
  }

  async pause() {
    this.calls.push('pause');
  }

  async resume() {
    this.calls.push('resume');
  }

  async finish(): Promise<FinalizedRecording> {
    this.calls.push('finish');
    if (this.finishFails) {
      throw new Error('native finish failed');
    }
    // Finish seals the partial last chunk.
    const sealedChunks = Math.ceil(this.capturedMs / 1000);
    this.write(sealedChunks, this.capturedMs);
    return {
      durationMs: this.capturedMs,
      sealedChunks,
      byteCount: HEADER_BYTES + sealedChunks * CHUNK_BYTES,
      contentSha256: SHA_A,
    };
  }

  async discard(recordingId: string) {
    this.calls.push(`discard ${recordingId}`);
    this.files.delete(this.path(recordingId));
  }

  /** Authenticates the named recordings; the rest get a header check. */
  async scan(authenticate: readonly string[]): Promise<RecordingFileScan[]> {
    this.calls.push(`scan ${authenticate.join(',')}`.trim());
    const full = new Set(authenticate.map(id => this.path(id)));
    return [...this.files.values()].map(file =>
      full.has(file.relativePath)
        ? file
        : {
            relativePath: file.relativePath,
            check: 'header' as const,
            headerValid: file.headerValid,
            fileBytes: file.fileBytes,
          },
    );
  }

  async dropTornTail(recordingId: string, sealedChunks: number) {
    this.calls.push(`dropTornTail ${recordingId} ${sealedChunks}`);
    const file = this.files.get(this.path(recordingId));
    if (file) {
      this.files.set(file.relativePath, {
        ...file,
        trailingBytes: 0,
        tail: 'none',
        fileBytes: file.byteCount,
      });
    }
  }

  async quarantine(relativePath: string) {
    this.calls.push(`quarantine ${relativePath}`);
    this.files.delete(relativePath);
  }

  /** A crash mid-write: an unauthenticated tail after the sealed chunks. */
  tearTail(bytes = 700) {
    const file = this.active && this.files.get(this.path(this.active));
    if (file) {
      this.files.set(file.relativePath, {
        ...file,
        trailingBytes: bytes,
        tail: 'torn',
        fileBytes: file.byteCount + bytes,
      });
    }
  }

  private path(recordingId: string) {
    return `recordings/${recordingId}.ajr`;
  }

  private write(chunks: number, ms = chunks * 1000) {
    if (!this.active) {
      return;
    }
    const relativePath = this.path(this.active);
    const byteCount = HEADER_BYTES + chunks * CHUNK_BYTES;
    this.files.set(relativePath, {
      relativePath,
      check: 'authenticated',
      headerValid: true,
      fileBytes: byteCount,
      authenticatedChunks: chunks,
      authenticatedMs: ms,
      trailingBytes: 0,
      tail: 'none',
      byteCount,
      contentSha256: chunks > 0 ? SHA_A : undefined,
    });
  }
}
