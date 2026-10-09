import type { IdSource } from '../domain/ids';
import {
  initialRecordingSession,
  recordingSessionReducer,
  type RecordingSessionAction,
  type RecordingSessionState,
} from '../domain/recordingSession';
import type { JournalRepository } from '../ports/JournalRepository';
import type {
  FinalizedRecording,
  RecordingEvent,
  RecordingService,
} from '../ports/RecordingService';
import { reconcileAbnormalEnd } from './startupReconciliation';

// Drives one capture at a time (LLD §5). Native code owns the audio; the
// reducer owns the visible outcome; the repository mirrors progress with
// bounded loss. A database error during capture never stops the recorder: the
// sealed file is the source of truth and startup reconciliation repairs rows.
// Transcription is a separate operation and is not started from here.

export interface CaptureDependencies {
  journal: JournalRepository;
  recorder: RecordingService;
  ids: IdSource;
  now: () => number;
  /** Progress is written at most this often while capturing. */
  progressIntervalMs?: number;
}

export interface CaptureSnapshot {
  session: RecordingSessionState;
  /** Input level, 0..1; display only. */
  level: number;
}

export class CaptureController {
  private snapshot: CaptureSnapshot = {
    session: initialRecordingSession,
    level: 0,
  };
  private readonly listeners = new Set<() => void>();
  private lastPersistedAt = Number.NEGATIVE_INFINITY;
  private byteCount = 0;
  private finishing?: Promise<void>;

  constructor(private readonly deps: CaptureDependencies) {}

  getSnapshot = (): CaptureSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private dispatch(action: RecordingSessionAction, level?: number): void {
    const session = recordingSessionReducer(this.snapshot.session, action);
    if (session !== this.snapshot.session || level !== undefined) {
      this.snapshot = { session, level: level ?? this.snapshot.level };
      this.listeners.forEach(listener => listener());
    }
  }

  /** A call, not a getter: TypeScript must not narrow across dispatches. */
  private current(): RecordingSessionState {
    return this.snapshot.session;
  }

  async start(): Promise<RecordingSessionState> {
    const { journal, recorder, ids, now } = this.deps;
    if (this.current().phase !== 'idle') {
      return this.current();
    }
    const entryId = ids.next('ent');
    const recordingId = ids.next('rec');
    this.byteCount = 0;
    this.lastPersistedAt = Number.NEGATIVE_INFINITY;
    this.dispatch({
      type: 'PREPARE',
      entryId,
      recordingId,
      freeBytes: await recorder.freeBytes(),
    });
    if (this.current().phase !== 'preparing') {
      return this.current();
    }
    // Rows first: a crash before the file exists reconciles to "no audio".
    await journal.createVoiceDraft({ entryId, recordingId, startedAt: now() });
    const prepared = await recorder.prepare(recordingId);
    if (!prepared.ok) {
      await journal.discardDraft(recordingId, now());
      this.dispatch({ type: 'PREPARE_FAILED', refusal: prepared.refusal });
      return this.current();
    }
    await recorder.start(recordingId, event => {
      this.onEvent(event);
    });
    return this.current();
  }

  private onEvent(event: RecordingEvent): void {
    switch (event.type) {
      case 'started':
        this.dispatch({ type: 'STARTED' });
        this.persist(true);
        break;
      case 'progress':
        this.byteCount = Math.max(this.byteCount, event.byteCount);
        this.dispatch(
          {
            type: 'PROGRESS',
            capturedMs: event.capturedMs,
            sealedChunks: event.sealedChunks,
            freeBytes: event.freeBytes,
          },
          Math.min(1, Math.max(0, event.level)),
        );
        if (this.current().phase === 'finalizing') {
          // A storage or duration limit was reached.
          this.finish().catch(() => undefined);
        } else {
          this.persist(false);
        }
        break;
      case 'paused':
        this.dispatch({ type: 'PAUSE', reason: event.reason });
        this.persist(true);
        break;
      case 'resumed':
      case 'finalized':
        // Confirmations of calls this controller made; already reflected.
        break;
      case 'ended_abnormally':
        this.dispatch({
          type: 'ENDED_ABNORMALLY',
          cause: event.cause,
          capturedMs: event.capturedMs,
          sealedChunks: event.sealedChunks,
        });
        this.reconcileQuietly().catch(() => undefined);
        break;
    }
  }

  /** Mirrors progress; failures are tolerated (see the class comment). */
  private persist(force: boolean): void {
    const session = this.current();
    if (
      session.phase !== 'recording' &&
      session.phase !== 'paused' &&
      session.phase !== 'finalizing'
    ) {
      return;
    }
    const at = this.deps.now();
    if (
      !force &&
      at - this.lastPersistedAt < (this.deps.progressIntervalMs ?? 5_000)
    ) {
      return;
    }
    this.lastPersistedAt = at;
    this.deps.journal
      .updateRecordingProgress(
        session.recordingId,
        {
          state: session.phase,
          durationMs: session.capturedMs,
          sealedChunks: session.sealedChunks,
          byteCount: this.byteCount,
        },
        at,
      )
      .catch(() => undefined);
  }

  async pause(): Promise<void> {
    if (this.current().phase !== 'recording') {
      return;
    }
    await this.deps.recorder.pause();
    this.dispatch({ type: 'PAUSE', reason: 'user' });
    this.persist(true);
  }

  async resume(): Promise<void> {
    if (this.current().phase !== 'paused') {
      return;
    }
    this.dispatch({
      type: 'RESUME',
      freeBytes: await this.deps.recorder.freeBytes(),
    });
    if (this.current().phase === 'finalizing') {
      await this.finish();
    } else if (this.current().phase === 'recording') {
      await this.deps.recorder.resume();
    }
  }

  finish(): Promise<void> {
    this.dispatch({ type: 'FINISH' });
    if (this.current().phase !== 'finalizing') {
      return this.finishing ?? Promise.resolve();
    }
    this.finishing ??= this.finalize().finally(() => {
      this.finishing = undefined;
    });
    return this.finishing;
  }

  private async finalize(): Promise<void> {
    const { journal, recorder, now } = this.deps;
    const finalizing = this.current();
    if (finalizing.phase !== 'finalizing') {
      return;
    }
    // Record the intent so a crash inside native finalization promotes.
    this.persist(true);
    let result: FinalizedRecording;
    try {
      result = await recorder.finish();
    } catch {
      this.dispatch({
        type: 'ENDED_ABNORMALLY',
        cause: 'RECORDER_FAILED',
        capturedMs: finalizing.capturedMs,
        sealedChunks: finalizing.sealedChunks,
      });
      await this.reconcileQuietly();
      return;
    }
    this.dispatch({
      type: 'FINALIZED',
      capturedMs: result.durationMs,
      sealedChunks: result.sealedChunks,
    });
    const session = this.current();
    if (session.phase === 'ready') {
      await journal
        .finalizeVoice({
          recordingId: session.recordingId,
          endedAt: now(),
          durationMs: result.durationMs,
          sealedChunks: result.sealedChunks,
          byteCount: result.byteCount,
          contentSha256: result.contentSha256,
          finishReason: session.reason,
        })
        // The file is sealed; the 'finalizing' row promotes at next startup.
        .catch(() => undefined);
    } else if (session.phase === 'failed') {
      await journal
        .discardDraft(session.recordingId, now())
        .catch(() => undefined);
    }
  }

  /** AJ-FR-003: only after the user confirmed in the UI. */
  async discard(confirmed: boolean): Promise<void> {
    const before = this.current();
    this.dispatch({ type: 'DISCARD', confirmed });
    const after = this.current();
    if (after.phase !== 'discarded' || before === after) {
      return;
    }
    const { recordingId } = after;
    await this.deps.journal.discardDraft(recordingId, this.deps.now());
    await this.deps.recorder.discard(recordingId);
  }

  acknowledge(): void {
    this.dispatch({ type: 'ACKNOWLEDGE' });
  }

  private async reconcileQuietly(): Promise<void> {
    const session = this.current();
    if (session.phase !== 'recoverable' && session.phase !== 'failed') {
      return;
    }
    await reconcileAbnormalEnd(
      this.deps.journal,
      this.deps.recorder,
      session.recordingId,
      this.deps.now,
    ).catch(() => undefined);
  }
}
