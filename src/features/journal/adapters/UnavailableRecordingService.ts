import type {
  FinalizedRecording,
  RecordingService,
} from '../ports/RecordingService';

// Stand-in until the native AJR1 recorder exists (paused on ADR Open
// decision 7). Capture is refused up front, so written entries keep working
// and nothing is half-recorded. scan() refuses too: startup reconciliation
// must not mistake "no recorder" for "files missing".

const unavailable = () => Promise.reject(new Error('RECORDER_UNAVAILABLE'));

export class UnavailableRecordingService implements RecordingService {
  freeBytes() {
    return Promise.resolve(Number.POSITIVE_INFINITY);
  }

  prepare() {
    return Promise.resolve({
      ok: false as const,
      refusal: 'RECORDER_UNAVAILABLE' as const,
    });
  }

  start = unavailable;
  pause = unavailable;
  resume = unavailable;
  finish: () => Promise<FinalizedRecording> = unavailable;
  discard = unavailable;
  scan = unavailable;
  dropTornTail = unavailable;
  quarantine = unavailable;
}
