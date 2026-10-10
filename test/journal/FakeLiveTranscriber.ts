import type { LiveWindow } from '../../src/features/journal/domain/liveTranscript';
import type { LiveTranscriber } from '../../src/features/journal/ports/RecordingTranscriber';

/** Scriptable live engine: the test emits windows for the attached capture. */
export class FakeLiveTranscriber implements LiveTranscriber {
  available = true;
  calls: string[] = [];
  private listener?: (window: LiveWindow) => void;

  async start(recordingId: string, onWindow: (window: LiveWindow) => void) {
    this.calls.push(`start ${recordingId}`);
    if (!this.available) {
      return undefined;
    }
    this.listener = onWindow;
    return {
      stop: () => {
        this.calls.push(`stop ${recordingId}`);
        this.listener = undefined;
      },
    };
  }

  get attached(): boolean {
    return this.listener !== undefined;
  }

  emit(window: LiveWindow): void {
    this.listener?.(window);
  }
}
