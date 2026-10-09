import NativeAudioJournalSpeech from '../../../native/NativeAudioJournalSpeech';
import type {
  TranscriptionModelInfo,
  TranscriptionResult,
  TranscriptionService,
} from '../ports/TranscriptionService';

/** On-device whisper.cpp through the app's own TurboModule (ADR-016). */
export class NativeTranscriptionService implements TranscriptionService {
  get available() {
    return NativeAudioJournalSpeech !== null;
  }

  private get native() {
    if (!NativeAudioJournalSpeech) {
      throw new Error('TRANSCRIPTION_UNAVAILABLE');
    }
    return NativeAudioJournalSpeech;
  }

  async models(): Promise<TranscriptionModelInfo[]> {
    return JSON.parse(await this.native.models()).models;
  }

  async transcribe(
    request: Parameters<TranscriptionService['transcribe']>[0],
    onSegment?: Parameters<TranscriptionService['transcribe']>[1],
  ): Promise<TranscriptionResult> {
    const subscription = onSegment
      ? this.native.onSegment(event => {
          if (event.requestId === request.requestId) {
            onSegment({ t0Ms: event.t0Ms, t1Ms: event.t1Ms, text: event.text });
          }
        })
      : undefined;
    try {
      const raw = await this.native.transcribe(
        request.requestId,
        request.audioPath,
        request.model,
        request.threads ?? 4,
      );
      return JSON.parse(raw) as TranscriptionResult;
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'TRANSCRIPTION_FAILED';
      return {
        status: 'failed',
        segments: [],
        failure: `${code}:${(error as Error).message ?? ''}`,
      };
    } finally {
      subscription?.remove();
    }
  }

  cancel(requestId: string): void {
    this.native.cancel(requestId);
  }

  activeCount(): number {
    return this.native.activeTranscriptions();
  }

  /** Development-only fixture I/O, confined to the app's `speech-eval` directory. */
  evalDirectory(): string {
    return this.native.evalDirectory();
  }

  readEvalFile(relativePath: string): Promise<string> {
    return this.native.readEvalFile(relativePath);
  }

  appendEvalFile(relativePath: string, line: string): Promise<void> {
    return this.native.appendEvalFile(relativePath, line);
  }
}
