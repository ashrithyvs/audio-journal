import type {
  FinalizedRecording,
  RecordingService,
} from '../ports/RecordingService';

// Stand-in where there is no native recorder (iOS until it is built, and
// tests). Capture is refused up front, so written entries keep working and
// nothing is half-recorded. scan() refuses too: startup reconciliation must
// not mistake "no recorder" for "files missing".

const unavailable = () => Promise.reject(new Error('RECORDER_UNAVAILABLE'));

export class UnavailableRecordingService implements RecordingService {
  freeBytes() {
    return Promise.resolve(Number.POSITIVE_INFINITY);
  }

  /** Nothing to ask: prepare() refuses as RECORDER_UNAVAILABLE. */
  requestMicrophone() {
    return Promise.resolve(true);
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
