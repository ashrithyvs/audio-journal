import { PermissionsAndroid, Platform } from 'react-native';

import type { Spec } from '../../native/NativeAudioJournalRecordings';
import type {
  RecordingEvent,
  RecordingService,
} from '../../features/journal/ports/RecordingService';
import {
  parseFinalized,
  parsePrepareResult,
  parseScan,
  toRecordingEvent,
} from './nativeRecordingResults';

/**
 * UX §5: asked when recording is first invoked, never at launch. The system
 * dialog pauses the app, so the lock grace covers it (ADR-017).
 */
export async function requestAndroidMicrophone(
  expectSystemUi: () => () => void = () => () => undefined,
): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) {
    return true;
  }
  const release = expectSystemUi();
  try {
    return (
      (await PermissionsAndroid.request(permission)) ===
      PermissionsAndroid.RESULTS.GRANTED
    );
  } finally {
    release();
  }
}

/**
 * The native AJR1 recorder (ADR-017). Audio and keys stay native; this
 * adapter forwards one capture's events and validates every result.
 */
export class NativeRecordingService implements RecordingService {
  private subscription?: { remove(): void };

  constructor(
    private readonly native: Spec,
    private readonly microphone: () => Promise<boolean> = requestAndroidMicrophone,
  ) {}

  freeBytes(): Promise<number> {
    return this.native.freeBytes();
  }

  requestMicrophone(): Promise<boolean> {
    return this.microphone().catch(() => false);
  }

  async prepare(recordingId: string) {
    return parsePrepareResult(await this.native.prepare(recordingId));
  }

  async start(
    recordingId: string,
    onEvent: (event: RecordingEvent) => void,
  ): Promise<void> {
    this.detach();
    const subscription = this.native.onRecordingEvent(raw => {
      if (raw.recordingId !== recordingId) {
        return;
      }
      const event = toRecordingEvent(raw);
      if (event) {
        onEvent(event);
      }
    });
    this.subscription = subscription;
    try {
      await this.native.start(recordingId);
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  pause(): Promise<void> {
    return this.native.pause();
  }

  resume(): Promise<void> {
    return this.native.resume();
  }

  async finish() {
    try {
      return parseFinalized(await this.native.finish());
    } finally {
      this.detach();
    }
  }

  async discard(recordingId: string): Promise<void> {
    this.detach();
    await this.native.discard(recordingId);
  }

  async scan(authenticate: readonly string[]) {
    return parseScan(await this.native.scan(JSON.stringify(authenticate)));
  }

  dropTornTail(recordingId: string, sealedChunks: number): Promise<void> {
    return this.native.dropTornTail(recordingId, sealedChunks);
  }

  quarantine(relativePath: string): Promise<void> {
    return this.native.quarantine(relativePath);
  }

  /** Stops forwarding events (the journal is closing). */
  detach(): void {
    this.subscription?.remove();
    this.subscription = undefined;
  }
}
