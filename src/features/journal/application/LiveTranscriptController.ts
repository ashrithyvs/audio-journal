import type { IdSource } from '../domain/ids';
import { planLiveWindow, type LiveWindow } from '../domain/liveTranscript';
import {
  applyProvisional,
  closeProvisional,
  emptyProvisional,
  orderedProvisional,
  retireProvisional,
  takeDirty,
  type ProvisionalTranscript,
  type ProvisionalUpdate,
} from '../domain/transcript';
import type { TranscriptRepository } from '../ports/JournalRepository';
import type { LiveTranscriber } from '../ports/RecordingTranscriber';

// Live provisional text for one capture at a time (ADR-017, LLD §6). Windows
// are applied in memory for display and stored in throttled batches, so a
// crash loses at most one interval of live text and never any audio. Storage
// failures are tolerated: the final pass replaces live text anyway.

export interface LiveSnapshot {
  recordingId?: string;
  lines: readonly ProvisionalUpdate[];
}

export interface LiveTranscriptDependencies {
  live: LiveTranscriber;
  transcripts: TranscriptRepository;
  ids: IdSource;
  now: () => number;
  /** Audio captured so far; live text never runs ahead of it. */
  capturedMs: () => number;
  /** Live rows are stored at most this often. */
  flushIntervalMs?: number;
}

export class LiveTranscriptController {
  private snapshot: LiveSnapshot = { lines: [] };
  private readonly listeners = new Set<() => void>();
  private state: ProvisionalTranscript = emptyProvisional;
  private recordingId?: string;
  private stopNative?: () => void;
  private generation = 0;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LiveTranscriptDependencies) {}

  getSnapshot = (): LiveSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(): void {
    this.snapshot = {
      recordingId: this.recordingId,
      lines: orderedProvisional(this.state),
    };
    this.listeners.forEach(listener => listener());
  }

  /** Starts live text for a capture; a repeat for the same one is ignored. */
  async start(recordingId: string): Promise<void> {
    if (this.recordingId === recordingId) {
      return;
    }
    await this.stop();
    this.generation += 1;
    const generation = this.generation;
    this.recordingId = recordingId;
    this.state = emptyProvisional;
    this.lastFlushAt = this.deps.now();
    this.publish();
    const handle = await this.deps.live
      .start(recordingId, window => {
        if (generation === this.generation) {
          this.apply(window);
        }
      })
      .catch(() => undefined);
    if (generation !== this.generation) {
      handle?.stop();
      return;
    }
    this.stopNative = handle?.stop;
  }

  private apply(window: LiveWindow): void {
    const capturedMs = this.deps.capturedMs();
    const plan = planLiveWindow(this.state, window, capturedMs, () =>
      this.deps.ids.next('seg'),
    );
    let next = retireProvisional(this.state, plan.retire);
    for (const update of plan.updates) {
      next = applyProvisional(next, update, capturedMs);
    }
    if (next !== this.state) {
      this.state = next;
      this.publish();
      this.flush(false);
    }
  }

  private flush(force: boolean): void {
    const recordingId = this.recordingId;
    const at = this.deps.now();
    const interval = this.deps.flushIntervalMs ?? 5_000;
    if (!recordingId || (!force && at - this.lastFlushAt < interval)) {
      return;
    }
    this.lastFlushAt = at;
    const { state, batch, retired } = takeDirty(this.state);
    this.state = state;
    if (batch.length === 0 && retired.length === 0) {
      return;
    }
    const { transcripts } = this.deps;
    this.flushing = this.flushing
      .then(async () => {
        await transcripts.upsertProvisional(recordingId, batch, at);
        await transcripts.retireProvisional(recordingId, retired, at);
      })
      .catch(() => undefined);
  }

  /**
   * The capture ended or the journal is closing: no more windows are
   * accepted, and what was shown is stored. The lines stay visible until the
   * next capture starts. Resolves once storage has settled.
   */
  stop(): Promise<void> {
    if (this.recordingId === undefined) {
      return this.flushing;
    }
    this.generation += 1;
    this.stopNative?.();
    this.stopNative = undefined;
    this.state = closeProvisional(this.state);
    this.flush(true);
    this.recordingId = undefined;
    return this.flushing;
  }
}
