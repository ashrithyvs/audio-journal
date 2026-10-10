import type { Spec } from '../../../native/NativeAudioJournalSpeech';
import type { RawEngineSegment } from '../../journal/domain/transcript';
import type { LiveTranscriber } from '../../journal/ports/RecordingTranscriber';
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  type TranscriptionModelId,
} from '../ports/TranscriptionService';

function parseSegments(json: string): RawEngineSegment[] | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) {
      return undefined;
    }
    return value.flatMap(item => {
      const { t0Ms, t1Ms, text } = (item ?? {}) as Record<string, unknown>;
      return typeof t0Ms === 'number' &&
        typeof t1Ms === 'number' &&
        typeof text === 'string'
        ? [{ t0Ms, t1Ms, text }]
        : [];
    });
  } catch {
    return undefined;
  }
}

/**
 * Live windows from the speech module (ADR-017). Two engine threads by
 * default, leaving cores for capture and the UI; like the window sizes, this
 * is PROVISIONAL until device measurements (Open decision 3).
 */
export class NativeLiveTranscriber implements LiveTranscriber {
  private sequence = 0;

  constructor(
    private readonly native: Spec,
    private readonly model: TranscriptionModelId = DEFAULT_TRANSCRIPTION_MODEL,
    private readonly threads = 2,
  ) {}

  async start(
    recordingId: string,
    onWindow: Parameters<LiveTranscriber['start']>[1],
  ) {
    this.sequence += 1;
    const requestId = `live-${this.sequence}`;
    const subscription = this.native.onLiveWindow(event => {
      if (event.requestId !== requestId) {
        return;
      }
      const segments = parseSegments(event.segmentsJson);
      if (segments) {
        onWindow({ startMs: event.startMs, endMs: event.endMs, segments });
      }
    });
    const attached = await this.native
      .startLive(requestId, recordingId, this.model, this.threads)
      .catch(() => false);
    if (!attached) {
      subscription.remove();
      return undefined;
    }
    return {
      stop: () => {
        subscription.remove();
        this.native.stopLive(requestId);
      },
    };
  }
}
