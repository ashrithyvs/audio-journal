import type { StartRefusal } from '../../src/features/journal/domain/recordingSession';
import type { RecordingFileScan } from '../../src/features/journal/domain/reconciliation';
import type {
  FinalizedRecording,
  RecordingEvent,
  RecordingService,
} from '../../src/features/journal/ports/RecordingService';
import { SHA_A } from '../sqlite/journalFixtures';

const MIB = 1024 * 1024;
/** One sealed AJR1 chunk: 1 s of PCM plus a GCM tag (header ignored). */
export const CHUNK_BYTES = 32_000 + 16;

/** Scriptable stand-in for the native recorder; holds no audio. */
export class FakeRecordingService implements RecordingService {
  free = 1_000 * MIB;
  refusal?: StartRefusal;
  finishFails = false;
  files = new Map<string, RecordingFileScan>();
  calls: string[] = [];
  private listener?: (event: RecordingEvent) => void;
  private active?: string;
  private capturedMs = 0;

  async freeBytes() {
    return this.free;
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
      byteCount: chunks * CHUNK_BYTES,
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
      byteCount: sealedChunks * CHUNK_BYTES,
      contentSha256: SHA_A,
    };
  }

  async discard(recordingId: string) {
    this.calls.push(`discard ${recordingId}`);
    this.files.delete(this.path(recordingId));
  }

  async scan(recordingId?: string) {
    this.calls.push(recordingId ? `scan ${recordingId}` : 'scan');
    return [...this.files.values()].filter(
      file => !recordingId || file.relativePath === this.path(recordingId),
    );
  }

  async dropTornTail(recordingId: string, sealedChunks: number) {
    this.calls.push(`dropTornTail ${recordingId} ${sealedChunks}`);
    const file = this.files.get(this.path(recordingId));
    if (file) {
      this.files.set(file.relativePath, { ...file, trailingBytes: 0 });
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
      this.files.set(file.relativePath, { ...file, trailingBytes: bytes });
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
    this.files.set(relativePath, {
      relativePath,
      headerValid: true,
      authenticatedChunks: chunks,
      authenticatedMs: ms,
      trailingBytes: 0,
      byteCount: chunks * CHUNK_BYTES,
      contentSha256: chunks > 0 ? SHA_A : undefined,
    });
  }
}
