import type { Spec } from '../../../native/NativeAudioJournalSpeech';
import type { RawEngineSegment } from '../../journal/domain/transcript';
import type {
  RecordingTranscriber,
  RecordingTranscription,
} from '../../journal/ports/RecordingTranscriber';
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  type TranscriptionModelId,
} from '../ports/TranscriptionService';

const CODE = /^[A-Z][A-Z0-9_]{2,40}$/;

function segments(value: unknown): RawEngineSegment[] {
  if (!Array.isArray(value)) {
    throw new Error('TRANSCRIPTION_PROTOCOL');
  }
  return value.map(item => {
    const { t0Ms, t1Ms, text } = item as Record<string, unknown>;
    if (
      typeof t0Ms !== 'number' ||
      typeof t1Ms !== 'number' ||
      typeof text !== 'string'
    ) {
      throw new Error('TRANSCRIPTION_PROTOCOL');
    }
    return { t0Ms, t1Ms, text };
  });
}

/**
 * whisper.cpp over a sealed recording through the app's speech module
 * (ADR-016). The domain validates segments again before storing them.
 */
export class NativeRecordingTranscriber implements RecordingTranscriber {
  constructor(
    private readonly native: Spec,
    private readonly model: TranscriptionModelId = DEFAULT_TRANSCRIPTION_MODEL,
    private readonly threads = 4,
  ) {}

  async transcribe(
    request: { requestId: string; recordingId: string },
    onSegment?: (segment: RawEngineSegment) => void,
  ): Promise<RecordingTranscription> {
    const subscription = onSegment
      ? this.native.onSegment(event => {
          if (event.requestId === request.requestId) {
            onSegment({ t0Ms: event.t0Ms, t1Ms: event.t1Ms, text: event.text });
          }
        })
      : undefined;
    try {
      const raw = JSON.parse(
        await this.native.transcribeRecording(
          request.requestId,
          request.recordingId,
          this.model,
          this.threads,
        ),
      ) as Record<string, unknown>;
      const status = raw.status;
      if (status !== 'ok' && status !== 'cancelled' && status !== 'failed') {
        throw new Error('TRANSCRIPTION_PROTOCOL');
      }
      return {
        status,
        modelId: this.model,
        segments: status === 'ok' ? segments(raw.segments) : [],
        ...(status === 'failed' ? { failure: 'TRANSCRIPTION_FAILED' } : {}),
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        status: 'failed',
        modelId: this.model,
        segments: [],
        failure:
          typeof code === 'string' && CODE.test(code)
            ? code
            : 'TRANSCRIPTION_FAILED',
      };
    } finally {
      subscription?.remove();
    }
  }

  cancel(requestId: string): void {
    this.native.cancel(requestId);
  }
}
