import type { Spec } from '../../../native/NativeAudioJournalSpeech';
import type { RawEngineSegment } from '../../journal/domain/transcript';
import type {
  RecordingTranscriber,
  RecordingTranscription,
} from '../../journal/ports/RecordingTranscriber';

const CODE = /^[A-Z][A-Z0-9_]{2,40}$/;
// `<profileId>_<profileVersion>` of the SDK model that made the result, in the
// stored model-ID grammar (journal store and AJB1 backup).
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
 * The SDK's `audio.transcribe@1` over a sealed recording, through the app's
 * native adapter (AJ ADR-022). Only IDs go in; codes, the model identity, and
 * already contract-checked segments come back, and the domain validates the
 * segments again before storing them.
 */
export class NativeRecordingTranscriber implements RecordingTranscriber {
  constructor(private readonly native: Spec) {}

  async transcribe(request: {
    requestId: string;
    recordingId: string;
  }): Promise<RecordingTranscription> {
    try {
      const raw = JSON.parse(
        await this.native.transcribeRecording(
          request.requestId,
          request.recordingId,
        ),
      ) as Record<string, unknown>;
      const { status, modelId, failure } = raw;
      if (
        (status !== 'ok' && status !== 'cancelled' && status !== 'failed') ||
        typeof modelId !== 'string' ||
        !MODEL_ID.test(modelId)
      ) {
        throw new Error('TRANSCRIPTION_PROTOCOL');
      }
      if (status === 'failed') {
        return {
          status,
          modelId,
          segments: [],
          failure:
            typeof failure === 'string' && CODE.test(failure)
              ? failure
              : 'TRANSCRIPTION_FAILED',
        };
      }
      return {
        status,
        modelId,
        segments: status === 'ok' ? segments(raw.segments) : [],
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        status: 'failed',
        modelId: '',
        segments: [],
        failure:
          typeof code === 'string' && CODE.test(code)
            ? code
            : 'TRANSCRIPTION_FAILED',
      };
    }
  }

  cancel(requestId: string): void {
    this.native.cancel(requestId);
  }
}
