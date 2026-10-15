import type { Spec } from '../src/native/NativeAudioJournalSpeech';
import { NativeRecordingTranscriber } from '../src/features/transcription/adapters/NativeRecordingTranscriber';

const REC = 'rec_0123456789abcdefghjkmnpqrs';
const MODEL = 'sdk.whisper.tiny-en-q5-1_1.0.0';

function fakeSpeech(transcribeRecording: Spec['transcribeRecording']) {
  const calls: unknown[][] = [];
  const native = {
    transcribeRecording: (...args: [string, string]) => {
      calls.push(['transcribeRecording', ...args]);
      return transcribeRecording(...args);
    },
    cancel: (...args: unknown[]) => calls.push(['cancel', ...args]),
    activeTranscriptions: () => 0,
    diagnostics: () => Promise.resolve('{}'),
  } as unknown as Spec;
  return { native, calls };
}

const reply = (value: unknown) => () => Promise.resolve(JSON.stringify(value));

describe('NativeRecordingTranscriber (packaged SDK, AJ ADR-022)', () => {
  it('passes only IDs to native code and returns the SDK model identity', async () => {
    const speech = fakeSpeech(
      reply({
        status: 'ok',
        modelId: MODEL,
        segments: [{ t0Ms: 0, t1Ms: 900, text: 'hello' }],
        timings: { audioMs: 1000, totalMs: 20, firstPartialMs: 10 },
      }),
    );
    const result = await new NativeRecordingTranscriber(
      speech.native,
    ).transcribe({ requestId: 'r1', recordingId: REC });
    expect(speech.calls).toEqual([['transcribeRecording', 'r1', REC]]);
    expect(result).toEqual({
      status: 'ok',
      modelId: MODEL,
      segments: [{ t0Ms: 0, t1Ms: 900, text: 'hello' }],
    });
  });

  it('keeps typed native failure codes and drops anything else', async () => {
    for (const [failure, expected] of [
      ['UNSUPPORTED_DURATION', 'UNSUPPORTED_DURATION'],
      ['MODEL_PACK_INVALID', 'MODEL_PACK_INVALID'],
      ['DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED'],
      ['/data/user/0/x path', 'TRANSCRIPTION_FAILED'],
      [undefined, 'TRANSCRIPTION_FAILED'],
    ]) {
      const speech = fakeSpeech(
        reply({ status: 'failed', modelId: MODEL, segments: [], failure }),
      );
      expect(
        await new NativeRecordingTranscriber(speech.native).transcribe({
          requestId: 'r',
          recordingId: REC,
        }),
      ).toEqual({
        status: 'failed',
        modelId: MODEL,
        segments: [],
        failure: expected,
      });
    }
  });

  it('never returns segments for a cancelled request', async () => {
    const speech = fakeSpeech(
      reply({
        status: 'cancelled',
        modelId: MODEL,
        segments: [{ t0Ms: 0, t1Ms: 900, text: 'late' }],
      }),
    );
    expect(
      await new NativeRecordingTranscriber(speech.native).transcribe({
        requestId: 'r',
        recordingId: REC,
      }),
    ).toEqual({ status: 'cancelled', modelId: MODEL, segments: [] });
  });

  it('maps rejections to codes and malformed results to a failure', async () => {
    const damaged = fakeSpeech(() =>
      Promise.reject(
        Object.assign(new Error('/data/x'), { code: 'SOURCE_DAMAGED' }),
      ),
    );
    expect(
      await new NativeRecordingTranscriber(damaged.native).transcribe({
        requestId: 'r',
        recordingId: REC,
      }),
    ).toMatchObject({ status: 'failed', failure: 'SOURCE_DAMAGED' });

    for (const malformed of [
      { status: 'ok', modelId: MODEL, segments: [{ t0Ms: '0' }] },
      { status: 'ok', segments: [] },
      { status: 'ok', modelId: 'sdk.whisper@1.0.0', segments: [] },
      { status: 'done', modelId: MODEL, segments: [] },
    ]) {
      expect(
        await new NativeRecordingTranscriber(
          fakeSpeech(reply(malformed)).native,
        ).transcribe({ requestId: 'r', recordingId: REC }),
      ).toMatchObject({
        status: 'failed',
        failure: 'TRANSCRIPTION_FAILED',
        segments: [],
      });
    }
  });

  it('forwards cancel by request ID only', () => {
    const speech = fakeSpeech(reply({}));
    new NativeRecordingTranscriber(speech.native).cancel('r9');
    expect(speech.calls).toEqual([['cancel', 'r9']]);
  });
});
