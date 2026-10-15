import { validateEngineSegments } from '../domain/transcript';
import type { TranscriptRepository } from '../ports/JournalRepository';
import type { RecordingTranscriber } from '../ports/RecordingTranscriber';

// Final transcription passes (ADR-017) through the Hybrid AI SDK (AJ ADR-022).
// One runs at a time. They start after a capture is saved, after each unlock
// for every ready recording without a full pass (the explicit LLD §9 step 5
// policy, owner decision 2026-10-10), or when the user asks. A result is
// validated against the recording's duration and stored as a new engine
// revision; any failure or cancel leaves the recording and the stored
// transcript unchanged. Recordings longer than the SDK profile's limit stay
// stored and playable and are never sent, so nothing is silently truncated.

/** The accepted SDK profile transcribes at most 180 seconds (AJ ADR-022). */
export const MAX_TRANSCRIPTION_MS = 180_000;

export type TranscriptionStatus =
  | { phase: 'queued' }
  | { phase: 'running' }
  | { phase: 'cancelled' }
  | { phase: 'failed'; reason: string }
  /** Longer than the model profile accepts; retrying cannot help. */
  | { phase: 'unsupported'; reason: 'UNSUPPORTED_DURATION' };

export interface TranscriptionDependencies {
  transcriber: RecordingTranscriber;
  transcripts: TranscriptRepository;
  now: () => number;
  /** A new revision was stored (lists and details reload). */
  onSaved?: (recordingId: string) => void;
}

const UNSUPPORTED = {
  phase: 'unsupported',
  reason: 'UNSUPPORTED_DURATION',
} as const satisfies TranscriptionStatus;

/** Distinguishes controllers (one per unlock) within a JS runtime. */
let controllers = 0;

interface Job {
  recordingId: string;
  durationMs: number;
}

export class TranscriptionController {
  private snapshot: ReadonlyMap<string, TranscriptionStatus> = new Map();
  private readonly listeners = new Set<() => void>();
  private queue: Job[] = [];
  private running?: {
    recordingId: string;
    requestId: string;
    /** The user cancelled: no result of this request may be stored. */
    cancelled: boolean;
  };
  private sequence = 0;
  private disposed = false;
  /**
   * Request IDs stay unique across locks and JS reloads, so a cancel can never
   * reach another session's native request.
   */
  private readonly session: string;

  constructor(private readonly deps: TranscriptionDependencies) {
    controllers += 1;
    this.session = `${deps.now().toString(36)}-${controllers}`;
  }

  getSnapshot = (): ReadonlyMap<string, TranscriptionStatus> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  status(recordingId: string): TranscriptionStatus | undefined {
    return this.snapshot.get(recordingId);
  }

  private set(recordingId: string, status?: TranscriptionStatus): void {
    const next = new Map(this.snapshot);
    if (status) {
      next.set(recordingId, status);
    } else {
      next.delete(recordingId);
    }
    this.snapshot = next;
    this.listeners.forEach(listener => listener());
  }

  /**
   * Queues a final pass; a recording already queued or running is ignored.
   * An automatic request (after save or unlock) never retries a pass that
   * failed or was cancelled in this session: only the user does.
   */
  request(
    recordingId: string,
    durationMs: number,
    origin: 'user' | 'automatic' = 'user',
  ): void {
    const phase = this.snapshot.get(recordingId)?.phase;
    if (
      this.disposed ||
      phase === 'queued' ||
      phase === 'running' ||
      phase === 'unsupported' ||
      (origin === 'automatic' && (phase === 'failed' || phase === 'cancelled'))
    ) {
      return;
    }
    if (durationMs > MAX_TRANSCRIPTION_MS) {
      this.set(recordingId, UNSUPPORTED);
      return;
    }
    this.queue.push({ recordingId, durationMs });
    this.set(recordingId, { phase: 'queued' });
    this.pump();
  }

  cancel(recordingId: string): void {
    if (this.running?.recordingId === recordingId) {
      this.running.cancelled = true;
      this.deps.transcriber.cancel(this.running.requestId);
      return;
    }
    if (this.queue.some(job => job.recordingId === recordingId)) {
      this.queue = this.queue.filter(job => job.recordingId !== recordingId);
      this.set(recordingId, { phase: 'cancelled' });
    }
  }

  /** The journal is closing (lock): nothing more starts. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    if (this.running) {
      this.deps.transcriber.cancel(this.running.requestId);
    }
  }

  private pump(): void {
    if (this.running || this.disposed) {
      return;
    }
    const job = this.queue.shift();
    if (job) {
      this.run(job).catch(() => undefined);
    }
  }

  private async run(job: Job): Promise<void> {
    const { transcriber, transcripts, now } = this.deps;
    this.sequence += 1;
    const requestId = `transcribe-${this.session}-${this.sequence}`;
    const running = {
      recordingId: job.recordingId,
      requestId,
      cancelled: false,
    };
    this.running = running;
    this.set(job.recordingId, { phase: 'running' });
    try {
      const result = await transcriber.transcribe({
        requestId,
        recordingId: job.recordingId,
      });
      // A user cancel or a lock (dispose) cancels the request; a result that
      // still arrives is never stored.
      if (result.status === 'cancelled' || running.cancelled || this.disposed) {
        this.set(job.recordingId, { phase: 'cancelled' });
        return;
      }
      if (result.status === 'failed' && result.failure === UNSUPPORTED.reason) {
        this.set(job.recordingId, UNSUPPORTED);
        return;
      }
      if (result.status === 'failed') {
        this.set(job.recordingId, {
          phase: 'failed',
          reason: result.failure ?? 'TRANSCRIPTION_FAILED',
        });
        return;
      }
      const validated = validateEngineSegments(result.segments, job.durationMs);
      if (!validated.ok) {
        this.set(job.recordingId, {
          phase: 'failed',
          reason: 'INVALID_RESULT',
        });
        return;
      }
      await transcripts.saveEngineRevision({
        recordingId: job.recordingId,
        modelId: result.modelId,
        segments: validated.segments,
        createdAt: now(),
      });
      this.set(job.recordingId);
      this.deps.onSaved?.(job.recordingId);
    } catch {
      this.set(job.recordingId, {
        phase: 'failed',
        reason: 'TRANSCRIPTION_FAILED',
      });
    } finally {
      this.running = undefined;
      this.pump();
    }
  }
}
