import type { RawEngineSegment } from '../../src/features/journal/domain/transcript';
import type {
  RecordingTranscriber,
  RecordingTranscription,
} from '../../src/features/journal/ports/RecordingTranscriber';

/** Scriptable on-device engine: each request waits until the test completes it. */
export class FakeRecordingTranscriber implements RecordingTranscriber {
  calls: string[] = [];
  private readonly pending = new Map<
    string,
    (result: RecordingTranscription) => void
  >();

  transcribe(request: {
    requestId: string;
    recordingId: string;
  }): Promise<RecordingTranscription> {
    this.calls.push(`transcribe ${request.recordingId}`);
    return new Promise(resolve => this.pending.set(request.requestId, resolve));
  }

  cancel(requestId: string): void {
    this.calls.push(`cancel ${requestId}`);
    this.finish(requestId, { status: 'cancelled', segments: [] });
  }

  get waiting(): number {
    return this.pending.size;
  }

  /** Completes the oldest waiting request. */
  complete(
    result: Partial<RecordingTranscription> & { segments?: RawEngineSegment[] },
  ): void {
    const [requestId] = this.pending.keys();
    if (!requestId) {
      throw new Error('no transcription is waiting');
    }
    this.finish(requestId, result);
  }

  private finish(
    requestId: string,
    result: Partial<RecordingTranscription>,
  ): void {
    const resolve = this.pending.get(requestId);
    this.pending.delete(requestId);
    resolve?.({
      status: 'ok',
      modelId: 'base.en-q5_1',
      segments: [],
      ...result,
    });
  }
}
