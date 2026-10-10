import { PermissionsAndroid, Platform } from 'react-native';

import type { Spec } from '../src/native/NativeAudioJournalRecordings';
import type { PlaybackEvent } from '../src/features/journal/ports/PlaybackService';
import type { RecordingEvent } from '../src/features/journal/ports/RecordingService';
import { NativePlaybackService } from '../src/platform/recording/NativePlaybackService';
import {
  NativeRecordingService,
  requestAndroidMicrophone,
} from '../src/platform/recording/NativeRecordingService';
import {
  parseFinalized,
  parsePrepareResult,
  parseScan,
  toPlaybackEvent,
  toRecordingEvent,
} from '../src/platform/recording/nativeRecordingResults';
import { SHA_A } from '../test/sqlite/journalFixtures';

type RecordingPayload = Parameters<Parameters<Spec['onRecordingEvent']>[0]>[0];
type PlaybackPayload = Parameters<Parameters<Spec['onPlaybackEvent']>[0]>[0];

/** A scripted native module: records calls and lets tests emit events. */
function fakeNative() {
  const recordingListeners = new Set<(event: RecordingPayload) => void>();
  const playbackListeners = new Set<(event: PlaybackPayload) => void>();
  const calls: unknown[][] = [];
  const results: Record<string, string> = {
    prepare: '{"ok":true}',
    finish: JSON.stringify({
      durationMs: 2_500,
      sealedChunks: 3,
      byteCount: 64 + 3 * 32_028,
      contentSha256: SHA_A,
    }),
    scan: '[]',
  };
  const record =
    (name: string, result?: () => unknown) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(result?.());
    };
  const native = {
    onRecordingEvent: (listener: (event: RecordingPayload) => void) => {
      recordingListeners.add(listener);
      return { remove: () => recordingListeners.delete(listener) };
    },
    onPlaybackEvent: (listener: (event: PlaybackPayload) => void) => {
      playbackListeners.add(listener);
      return { remove: () => playbackListeners.delete(listener) };
    },
    freeBytes: record('freeBytes', () => 1e9),
    prepare: record('prepare', () => results.prepare),
    start: record('start'),
    pause: record('pause'),
    resume: record('resume'),
    finish: record('finish', () => results.finish),
    discard: record('discard'),
    scan: record('scan', () => results.scan),
    dropTornTail: record('dropTornTail'),
    quarantine: record('quarantine'),
    play: record('play'),
    pausePlayback: record('pausePlayback'),
    stopPlayback: record('stopPlayback'),
  } as unknown as Spec;
  const recording = (event: Partial<RecordingPayload>) =>
    recordingListeners.forEach(listener =>
      listener({
        recordingId: '',
        type: '',
        reason: '',
        capturedMs: 0,
        sealedChunks: 0,
        byteCount: 0,
        freeBytes: 0,
        level: 0,
        ...event,
      }),
    );
  const playback = (event: Partial<PlaybackPayload>) =>
    playbackListeners.forEach(listener =>
      listener({ playbackId: '', type: '', positionMs: 0, code: '', ...event }),
    );
  return {
    native,
    calls,
    results,
    recording,
    playback,
    listening: () => recordingListeners.size + playbackListeners.size,
  };
}

const REC = 'rec_0123456789abcdefghjkmnpqrs';

describe('native recording results', () => {
  it('accepts only the documented prepare outcomes', () => {
    expect(parsePrepareResult('{"ok":true}')).toEqual({ ok: true });
    expect(
      parsePrepareResult('{"ok":false,"refusal":"MICROPHONE_DENIED"}'),
    ).toEqual({ ok: false, refusal: 'MICROPHONE_DENIED' });
    expect(() =>
      parsePrepareResult('{"ok":false,"refusal":"SOMETHING_ELSE"}'),
    ).toThrow('RECORDER_PROTOCOL');
    expect(() => parsePrepareResult('[]')).toThrow('RECORDER_PROTOCOL');
  });

  it('rejects a finalized result without a digest or with bad counts', () => {
    const good = {
      durationMs: 1,
      sealedChunks: 1,
      byteCount: 2,
      contentSha256: SHA_A,
    };
    expect(parseFinalized(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      { ...good, contentSha256: 'ABC' },
      { ...good, sealedChunks: -1 },
      { ...good, durationMs: 1.5 },
    ]) {
      expect(() => parseFinalized(JSON.stringify(bad))).toThrow(
        'RECORDER_PROTOCOL',
      );
    }
  });

  it('parses both scan kinds and rejects anything else', () => {
    const scans = [
      {
        relativePath: `recordings/${REC}.ajr`,
        check: 'authenticated',
        headerValid: true,
        fileBytes: 32_092,
        authenticatedChunks: 1,
        authenticatedMs: 1_000,
        trailingBytes: 0,
        tail: 'none',
        byteCount: 32_092,
        contentSha256: SHA_A,
      },
      {
        relativePath: 'recordings/x.ajr',
        check: 'header',
        headerValid: false,
        fileBytes: 3,
      },
    ];
    expect(parseScan(JSON.stringify(scans))).toEqual(scans);
    expect(() =>
      parseScan(JSON.stringify([{ ...scans[1], check: 'guess' }])),
    ).toThrow('RECORDER_PROTOCOL');
    expect(() =>
      parseScan(JSON.stringify([{ ...scans[0], trailingBytes: -1 }])),
    ).toThrow('RECORDER_PROTOCOL');
  });

  it('maps events and drops unknown ones', () => {
    const base = {
      recordingId: REC,
      reason: '',
      capturedMs: 1_500,
      sealedChunks: 1,
      byteCount: 32_092,
      freeBytes: 1e9,
      level: 7,
    };
    expect(toRecordingEvent({ ...base, type: 'progress' })).toEqual({
      type: 'progress',
      capturedMs: 1_500,
      sealedChunks: 1,
      byteCount: 32_092,
      freeBytes: 1e9,
      level: 1, // clamped
    });
    expect(
      toRecordingEvent({ ...base, type: 'paused', reason: 'backgrounded' }),
    ).toEqual({ type: 'paused', reason: 'backgrounded' });
    expect(
      toRecordingEvent({ ...base, type: 'paused', reason: 'other' }),
    ).toBeUndefined();
    expect(
      toRecordingEvent({ ...base, type: 'ended_abnormally', reason: 'odd' }),
    ).toMatchObject({ type: 'ended_abnormally', cause: 'RECORDER_FAILED' });
    expect(toRecordingEvent({ ...base, type: 'noise' })).toBeUndefined();
    expect(
      toPlaybackEvent({
        playbackId: 'p',
        type: 'failed',
        positionMs: 0,
        code: '?',
      }),
    ).toEqual({ type: 'failed', code: 'PLAYBACK_UNAVAILABLE' });
  });
});

describe('NativeRecordingService', () => {
  it('forwards only its own capture events and stops after finish', async () => {
    const fake = fakeNative();
    const service = new NativeRecordingService(fake.native, async () => true);
    const events: RecordingEvent[] = [];
    await service.start(REC, event => events.push(event));
    fake.recording({ recordingId: REC, type: 'started' });
    fake.recording({ recordingId: 'rec_other', type: 'started' });
    expect(events).toEqual([{ type: 'started' }]);

    expect(await service.finish()).toMatchObject({
      sealedChunks: 3,
      contentSha256: SHA_A,
    });
    fake.recording({ recordingId: REC, type: 'started' });
    expect(events).toHaveLength(1);
    expect(fake.listening()).toBe(0);
  });

  it('detaches when start fails', async () => {
    const fake = fakeNative();
    (fake.native as { start: unknown }).start = () =>
      Promise.reject(new Error('RECORDER_STATE'));
    const service = new NativeRecordingService(fake.native, async () => true);
    await expect(service.start(REC, () => undefined)).rejects.toThrow();
    expect(fake.listening()).toBe(0);
  });

  it('asks native code to authenticate exactly the named recordings', async () => {
    const fake = fakeNative();
    const service = new NativeRecordingService(fake.native, async () => true);
    await service.scan([REC]);
    expect(fake.calls).toContainEqual(['scan', JSON.stringify([REC])]);
  });

  it('treats a failing permission request as denied', async () => {
    const fake = fakeNative();
    const service = new NativeRecordingService(fake.native, () =>
      Promise.reject(new Error('no activity')),
    );
    expect(await service.requestMicrophone()).toBe(false);
  });
});

describe('NativePlaybackService', () => {
  it('silences an older playback when a newer one starts', async () => {
    const fake = fakeNative();
    const service = new NativePlaybackService(fake.native);
    const first: PlaybackEvent[] = [];
    const second: PlaybackEvent[] = [];
    await service.play(REC, { startMs: 1_234.7 }, event => first.push(event));
    await service.play(REC, { startMs: 0, endMs: 900 }, event =>
      second.push(event),
    );
    fake.playback({ playbackId: 'play-1', type: 'position', positionMs: 5 });
    fake.playback({ playbackId: 'play-2', type: 'paused', positionMs: 400 });
    expect(first).toEqual([]);
    expect(second).toEqual([{ type: 'paused', positionMs: 400 }]);
    expect(fake.calls).toContainEqual(['play', 'play-1', REC, 1_234, -1]);
    expect(fake.calls).toContainEqual(['play', 'play-2', REC, 0, 900]);
    await service.stop();
    expect(fake.listening()).toBe(0);
  });
});

describe('microphone permission and the lock grace (ADR-017)', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens the grace only around a real dialog, and always releases it', async () => {
    const calls: string[] = [];
    const expectSystemUi = () => {
      calls.push('grace');
      return () => calls.push('release');
    };
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    expect(await requestAndroidMicrophone(expectSystemUi)).toBe(true);
    expect(calls).toEqual([]); // already granted: no dialog, no grace

    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
    expect(await requestAndroidMicrophone(expectSystemUi)).toBe(false);
    expect(calls).toEqual(['grace', 'release']);

    jest
      .spyOn(PermissionsAndroid, 'request')
      .mockRejectedValue(new Error('no activity'));
    await expect(requestAndroidMicrophone(expectSystemUi)).rejects.toThrow();
    expect(calls).toEqual(['grace', 'release', 'grace', 'release']);
  });
});
