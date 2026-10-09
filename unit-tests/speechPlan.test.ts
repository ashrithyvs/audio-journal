import {
  isGrounded,
  promptFrom,
  runSpeechPlan,
  type SpeechItemResult,
  type SpeechPlan,
} from '../src/features/load-lab/domain/speechPlan';
import {
  normalizeTranscript,
  scoreTranscript,
} from '../src/features/transcription/domain/wordErrorRate';
import type {
  TranscriptionResult,
  TranscriptionService,
} from '../src/features/transcription/ports/TranscriptionService';
import { FakeHybridAiGateway } from '../test/FakeHybridAiGateway';

describe('in-app WER scorer (mirrors e2e/speech/lib/metrics.mjs)', () => {
  it('normalizes formatting only', () => {
    expect(
      normalizeTranscript("Mr. Quilter's 2 dogs, [BLANK_AUDIO] 1,500!"),
    ).toBe("mister quilter's two dogs one thousand five hundred");
  });

  it('counts S/D/I and computes WER and CER', () => {
    const score = scoreTranscript(
      'THE CAT SAT ON THE MAT',
      'The cat sat on a mat.',
    );
    expect(score.word).toEqual({
      substitutions: 1,
      deletions: 0,
      insertions: 0,
      errors: 1,
    });
    expect(score.wer).toBeCloseTo(1 / 6);
    // Minimum edits are 3; the tie resolves the same way as the host scorer.
    expect(scoreTranscript('A B C', 'A C D E').word).toEqual({
      substitutions: 2,
      deletions: 0,
      insertions: 1,
      errors: 3,
    });
    expect(scoreTranscript('HELLO', '').wer).toBe(1);
  });
});

describe('text handoff helpers', () => {
  it('builds a prompt within the 64-character text.complete limit at a word boundary', () => {
    const prompt = promptFrom(
      'He hoped there would be stew for dinner turnips and carrots and bruised potatoes',
    );
    expect(prompt.length).toBeLessThanOrEqual(64);
    expect(prompt).toBe(
      'He hoped there would be stew for dinner turnips and carrots and',
    );
  });

  it('accepts only analysis output grounded in the transcript', () => {
    const transcript = 'The garden needs tomato seedlings. Water them daily.';
    expect(
      isGrounded(
        {
          summary: 'The garden needs tomato seedlings.',
          topics: ['garden', 'seedlings'],
        },
        transcript,
      ),
    ).toBe(true);
    expect(
      isGrounded(
        { summary: 'The garden needs tomato seedlings.', topics: ['invented'] },
        transcript,
      ),
    ).toBe(false);
    expect(
      isGrounded(
        { summary: 'Something unrelated entirely here', topics: [] },
        transcript,
      ),
    ).toBe(false);
    expect(isGrounded({ unexpected: true }, transcript)).toBe(false);
  });
});

describe('speech plan runner', () => {
  const items = [
    {
      file: 'a.wav',
      reference: 'HELLO WORLD',
      durationSec: 2,
      condition: 'clean',
      set: 'test-clean',
      gender: 'F',
    },
    {
      file: 'b.wav',
      reference: 'GOOD MORNING TO YOU',
      durationSec: 4,
      condition: 'babble10',
      set: 'test-clean',
      gender: 'M',
    },
  ];
  const outputs: Record<string, TranscriptionResult> = {
    'a.wav': {
      status: 'ok',
      segments: [{ t0Ms: 0, t1Ms: 900, text: ' Hello world.' }],
      timings: {
        readMs: 1,
        modelLoadMs: 0,
        firstSegmentMs: 300,
        inferenceMs: 1000,
        totalMs: 1001,
        audioMs: 2000,
      },
      memory: { vmRssKb: 100, vmHwmKb: 150_000, nativeHeapKb: 1 },
    },
    'b.wav': {
      status: 'ok',
      segments: [{ t0Ms: 0, t1Ms: 2000, text: ' Good morning.' }],
      timings: {
        readMs: 1,
        modelLoadMs: 0,
        firstSegmentMs: 400,
        inferenceMs: 2000,
        totalMs: 2001,
        audioMs: 4000,
      },
    },
  };
  const transcriber: TranscriptionService = {
    models: async () => [],
    transcribe: async (request, onSegment) => {
      const output = outputs[request.audioPath.split('/').pop()!];
      output.segments.forEach(segment => onSegment?.(segment));
      return output;
    },
    cancel: () => {},
  };

  it('scores every file, records results, and summarizes by condition', async () => {
    const recorded: SpeechItemResult[] = [];
    const plan: SpeechPlan = {
      runId: 'r1',
      model: 'base.en-q5_1',
      threads: 4,
      concurrency: 2,
      sdkStage: 'none',
      items,
    };
    let clock = 0;
    const summary = await runSpeechPlan(plan, {
      transcriber,
      gateway: new FakeHybridAiGateway(),
      evalDirectory: '/eval',
      now: () => (clock += 10),
      record: async result => {
        recorded.push(result);
      },
      control: { stopped: false },
    });
    expect(recorded.map(result => result.hypothesis).sort()).toEqual([
      'Good morning.',
      'Hello world.',
    ]);
    expect(summary).toMatchObject({
      files: 2,
      ok: 2,
      failed: 0,
      wer: Math.round((2 / 6) * 10_000) / 10_000,
      peakRssKb: 150_000,
    });
    expect(summary.realTimeFactor).toBe(0.5);
    expect(summary.byCondition['test-clean/clean']).toEqual({
      files: 1,
      wer: 0,
      rtf: 0.5,
    });
    expect(summary.byCondition['test-clean/babble10'].wer).toBe(0.5);
  });

  it('hands only transcript text to the SDK and records the outcome', async () => {
    const gateway = new FakeHybridAiGateway();
    const runs: unknown[] = [];
    gateway.run = async (request, onUpdate) => {
      runs.push(request.input);
      onUpdate({
        type: 'completed',
        output: { text: 'and then' },
        target: 'local',
        routingReason: 'explicit_local',
      });
      return { events: 1, terminalEvents: 1, outOfOrder: false };
    };
    const recorded: SpeechItemResult[] = [];
    await runSpeechPlan(
      {
        runId: 'r2',
        model: 'tiny.en-q5_1',
        threads: 2,
        concurrency: 1,
        sdkStage: 'local',
        items: [items[0]],
      },
      {
        transcriber,
        gateway,
        evalDirectory: '/eval',
        now: () => 0,
        record: async result => {
          recorded.push(result);
        },
        control: { stopped: false },
      },
    );
    expect(runs).toEqual([{ prompt: 'Hello world.' }]);
    expect(recorded[0].sdk).toMatchObject({
      capability: 'text.complete',
      outcome: 'completed',
      valid: true,
      target: 'local',
    });
  });
});
