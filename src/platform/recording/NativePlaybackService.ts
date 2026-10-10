import type { Spec } from '../../native/NativeAudioJournalRecordings';
import type {
  PlaybackEvent,
  PlaybackService,
} from '../../features/journal/ports/PlaybackService';
import { toPlaybackEvent } from './nativeRecordingResults';

/**
 * Native AJR1 playback (ADR-017): decrypted natively into the audio output.
 * One playback at a time; a newer play() silences the older one's events.
 */
export class NativePlaybackService implements PlaybackService {
  private subscription?: { remove(): void };
  private sequence = 0;

  constructor(private readonly native: Spec) {}

  async play(
    recordingId: string,
    range: { startMs: number; endMs?: number },
    onEvent: (event: PlaybackEvent) => void,
  ): Promise<void> {
    this.detach();
    this.sequence += 1;
    const playbackId = `play-${this.sequence}`;
    this.subscription = this.native.onPlaybackEvent(raw => {
      if (raw.playbackId !== playbackId) {
        return;
      }
      const event = toPlaybackEvent(raw);
      if (event) {
        onEvent(event);
      }
    });
    await this.native.play(
      playbackId,
      recordingId,
      Math.max(0, Math.floor(range.startMs)),
      range.endMs === undefined ? -1 : Math.max(0, Math.floor(range.endMs)),
    );
  }

  /** The native side reports the stop position as a 'paused' event. */
  pause(): Promise<void> {
    return this.native.pausePlayback();
  }

  async stop(): Promise<void> {
    this.detach();
    await this.native.stopPlayback();
  }

  private detach(): void {
    this.subscription?.remove();
    this.subscription = undefined;
  }
}
