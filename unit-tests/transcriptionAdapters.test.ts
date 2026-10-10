import type { Spec } from '../src/native/NativeAudioJournalSpeech';
import type { LiveWindow } from '../src/features/journal/domain/liveTranscript';
import { NativeLiveTranscriber } from '../src/features/transcription/adapters/NativeLiveTranscriber';
import { NativeRecordingTranscriber } from '../src/features/transcription/adapters/NativeRecordingTranscriber';

type SegmentEvent = Parameters<Parameters<Spec['onSegment']>[0]>[0];
type WindowEvent = Parameters<Parameters<Spec['onLiveWindow']>[0]>[0];

function fakeSpeech(overrides: Partial<Record<keyof Spec, unknown>> = {}) {
  const segmentListeners = new Set<(event: SegmentEvent) => void>();
  const windowListeners = new Set<(event: WindowEvent) => void>();
  const calls: unknown[][] = [];
  const native = {
    onSegment: (listener: (event: SegmentEvent) => void) => {
      segmentListeners.add(listener);
      return { remove: () => segmentListeners.delete(listener) };
    },
    onLiveWindow: (listener: (event: WindowEvent) => void) => {
      windowListeners.add(listener);
      return { remove: () => windowListeners.delete(listener) };
    },
    transcribeRecording: (...args: unknown[]) => {
      calls.push(['transcribeRecording', ...args]);
      return Promise.resolve(
        JSON.stringify({
          status: 'ok',
          segments: [{ t0Ms: 0, t1Ms: 900, text: 'hello' }],
        }),
      );
    },
    startLive: (...args: unknown[]) => {
      calls.push(['startLive', ...args]);
      return Promise.resolve(true);
    },
    stopLive: (...args: unknown[]) => calls.push(['stopLive', ...args]),
    cancel: (...args: unknown[]) => calls.push(['cancel', ...args]),
    ...overrides,
  } as unknown as Spec;
  return {
    native,
    calls,
    segment: (event: SegmentEvent) =>
      segmentListeners.forEach(listener => listener(event)),
    window: (event: WindowEvent) =>
      windowListeners.forEach(listener => listener(event)),
    listening: () => segmentListeners.size + windowListeners.size,
  };
}

const REC = 'rec_0123456789abcdefghjkmnpqrs';

describe('NativeRecordingTranscriber', () => {
  it('passes only IDs to native code and returns validated segments', async () => {
    const speech = fakeSpeech();
    const result = await new NativeRecordingTranscriber(
      speech.native,
    ).transcribe({ requestId: 'r1', recordingId: REC });
    expect(speech.calls).toEqual([
      ['transcribeRecording', 'r1', REC, 'base.en-q5_1', 4],
    ]);
    expect(result).toEqual({
      status: 'ok',
      modelId: 'base.en-q5_1',
      segments: [{ t0Ms: 0, t1Ms: 900, text: 'hello' }],
    });
    expect(speech.listening()).toBe(0);
  });

  it('maps native errors to codes and malformed results to a failure', async () => {
    const damaged = fakeSpeech({
      transcribeRecording: () =>
        Promise.reject(
          Object.assign(new Error('/data/x'), { code: 'SOURCE_DAMAGED' }),
        ),
    });
    expect(
      await new NativeRecordingTranscriber(damaged.native).transcribe({
        requestId: 'r',
        recordingId: REC,
      }),
    ).toMatchObject({ status: 'failed', failure: 'SOURCE_DAMAGED' });

    const malformed = fakeSpeech({
      transcribeRecording: () =>
        Promise.resolve('{"status":"ok","segments":[{"t0Ms":"0"}]}'),
    });
    expect(
      await new NativeRecordingTranscriber(malformed.native).transcribe({
        requestId: 'r',
        recordingId: REC,
      }),
    ).toMatchObject({ status: 'failed', failure: 'TRANSCRIPTION_FAILED' });
  });
});

describe('NativeLiveTranscriber', () => {
  it('forwards only its own windows and stops cleanly', async () => {
    const speech = fakeSpeech();
    const windows: LiveWindow[] = [];
    const handle = await new NativeLiveTranscriber(speech.native).start(
      REC,
      window => windows.push(window),
    );
    expect(speech.calls).toEqual([
      ['startLive', 'live-1', REC, 'base.en-q5_1', 2],
    ]);
    speech.window({
      requestId: 'live-1',
      startMs: 0,
      endMs: 4_000,
      segmentsJson: '[{"t0Ms":0,"t1Ms":800,"text":"hi"},{"bad":1}]',
    });
    speech.window({
      requestId: 'live-0',
      startMs: 0,
      endMs: 1,
      segmentsJson: '[]',
    });
    speech.window({
      requestId: 'live-1',
      startMs: 0,
      endMs: 1,
      segmentsJson: 'not json',
    });
    expect(windows).toEqual([
      {
        startMs: 0,
        endMs: 4_000,
        segments: [{ t0Ms: 0, t1Ms: 800, text: 'hi' }],
      },
    ]);
    handle?.stop();
    expect(speech.calls).toContainEqual(['stopLive', 'live-1']);
    expect(speech.listening()).toBe(0);
  });

  it('is unavailable when the capture is not open', async () => {
    const speech = fakeSpeech({ startLive: () => Promise.resolve(false) });
    expect(
      await new NativeLiveTranscriber(speech.native).start(
        REC,
        () => undefined,
      ),
    ).toBeUndefined();
    expect(speech.listening()).toBe(0);
  });
});
