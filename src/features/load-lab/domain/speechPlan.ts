import type {
  CapabilityUpdate,
  ExecutionTarget,
  HybridAiGateway,
} from '../../../platform/hybrid-ai/HybridAiGateway';
import { checkAnalysisOutput } from '../../private-node/domain/analysisResult';
import {
  transcriptText,
  type TranscriptionModelId,
  type TranscriptionResult,
  type TranscriptionService,
} from '../../transcription/ports/TranscriptionService';
import {
  normalizeTranscript,
  scoreTranscript,
} from '../../transcription/domain/wordErrorRate';
import { summarizeLatency } from './stats';

// Real-speech plan: on-device transcription (ADR-016) followed by an optional
// text-only handoff to Hybrid AI. Plans and audio are development fixtures
// pushed into the app's `speech-eval` directory by e2e/android/aj-speech.mjs.

export interface SpeechPlanItem {
  file: string;
  reference: string;
  durationSec: number;
  condition: string;
  set: string;
  gender: string;
}

export interface SpeechPlan {
  runId: string;
  model: TranscriptionModelId;
  threads: number;
  concurrency: number;
  /** Text handoff after transcription; audio is never sent. */
  sdkStage: 'none' | ExecutionTarget;
  soakMinutes?: number;
  /** Cancel this many requests early to measure cancellation latency. */
  cancelProbes?: number;
  items: SpeechPlanItem[];
}

export interface SdkHandoff {
  capability: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  code?: string;
  target?: string;
  routingReason?: string;
  latencyMs: number;
  valid?: boolean;
  /** Output is derived from the transcript (topics/summary present in it). */
  grounded?: boolean;
}

export interface SpeechItemResult {
  pass: number;
  file: string;
  condition: string;
  set: string;
  gender: string;
  durationSec: number;
  status: TranscriptionResult['status'];
  failure?: string;
  hypothesis: string;
  words?: {
    reference: number;
    errors: number;
    s: number;
    d: number;
    i: number;
  };
  chars?: { reference: number; errors: number };
  timings?: TranscriptionResult['timings'];
  segments: number;
  firstSegmentMs?: number;
  rtf?: number;
  memory?: TranscriptionResult['memory'];
  sdk?: SdkHandoff;
}

export interface SpeechSummary {
  runId: string;
  model: string;
  files: number;
  ok: number;
  failed: number;
  cancelled: number;
  audioMinutes: number;
  wer?: number;
  cer?: number;
  realTimeFactor?: number;
  rtf?: ReturnType<typeof summarizeLatency>;
  firstSegmentMs?: ReturnType<typeof summarizeLatency>;
  inferenceMs?: ReturnType<typeof summarizeLatency>;
  cancelLatencyMs?: ReturnType<typeof summarizeLatency>;
  peakRssKb?: number;
  sdk?: {
    requests: number;
    completed: number;
    valid: number;
    grounded: number;
    codes: Record<string, number>;
    latencyMs?: ReturnType<typeof summarizeLatency>;
  };
  byCondition: Record<string, { files: number; wer?: number; rtf?: number }>;
  passes: number;
  wallMs: number;
}

/** First words of the transcript within text.complete's 64-character prompt limit. */
export function promptFrom(text: string): string {
  let prompt = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const next = prompt ? `${prompt} ${word}` : word;
    if (next.length > 64) break;
    prompt = next;
  }
  return prompt || text.slice(0, 64);
}

/** document.analyze output must come from its input: topics and summary appear in it. */
export function isGrounded(output: unknown, document: string): boolean {
  if (!checkAnalysisOutput(output).valid) return false;
  const { summary, topics } = output as { summary: string; topics: string[] };
  const words = new Set(normalizeTranscript(document).split(' '));
  const lowered = document.toLowerCase();
  return (
    topics.every(topic => words.has(normalizeTranscript(topic))) &&
    (summary.length === 0 ||
      lowered.includes(summary.toLowerCase().slice(0, 20)))
  );
}

async function handOff(
  gateway: HybridAiGateway,
  stage: ExecutionTarget,
  text: string,
  requestId: string,
  now: () => number,
): Promise<SdkHandoff> {
  const local = stage === 'local';
  const capability = local ? 'text.complete' : 'document.analyze';
  const input = local
    ? { prompt: promptFrom(text) }
    : { document: text.slice(0, 4000) };
  const started = now();
  let terminal: CapabilityUpdate | undefined;
  await gateway.run(
    {
      capability,
      version: '1',
      input,
      execution: stage,
      timeoutMs: 30_000,
      requestId,
    },
    update => {
      if (
        update.type === 'completed' ||
        update.type === 'failed' ||
        update.type === 'cancelled'
      ) {
        terminal = update;
      }
    },
  );
  const latencyMs = now() - started;
  const result = terminal as CapabilityUpdate | undefined;
  if (result?.type === 'completed') {
    const output = result.output as Record<string, unknown>;
    const valid = local
      ? typeof output?.text === 'string' && (output.text as string).length > 0
      : checkAnalysisOutput(output).valid;
    return {
      capability,
      outcome: 'completed',
      target: result.target,
      routingReason: result.routingReason,
      latencyMs,
      valid,
      grounded: local
        ? undefined
        : isGrounded(output, input.document as string),
    };
  }
  return {
    capability,
    outcome: result?.type === 'cancelled' ? 'cancelled' : 'failed',
    code: result?.type === 'failed' ? result.failure.code : undefined,
    latencyMs,
  };
}

export async function runSpeechPlan(
  plan: SpeechPlan,
  deps: {
    transcriber: TranscriptionService;
    gateway: HybridAiGateway;
    evalDirectory: string;
    now: () => number;
    record(result: SpeechItemResult): Promise<void>;
    onProgress?(done: number, total: number): void;
    control: { stopped: boolean };
  },
): Promise<SpeechSummary> {
  const results: SpeechItemResult[] = [];
  const cancelLatencies: number[] = [];
  const started = deps.now();
  let pass = 0;
  let sequence = 0;

  // Cancellation probes: start, cancel shortly after, time the terminal.
  for (
    let probe = 0;
    probe < (plan.cancelProbes ?? 0) && probe < plan.items.length;
    probe += 1
  ) {
    const item = plan.items[probe];
    const requestId = `speech-cancel-${probe}`;
    const pending = deps.transcriber.transcribe({
      requestId,
      audioPath: `${deps.evalDirectory}/audio/${item.file}`,
      model: plan.model,
      threads: plan.threads,
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    const cancelledAt = deps.now();
    deps.transcriber.cancel(requestId);
    const outcome = await pending;
    if (outcome.status === 'cancelled')
      cancelLatencies.push(deps.now() - cancelledAt);
  }

  do {
    pass += 1;
    let next = 0;
    const worker = async () => {
      while (!deps.control.stopped && next < plan.items.length) {
        const item = plan.items[next];
        next += 1;
        sequence += 1;
        const requestId = `speech-${pass}-${sequence}`;
        let firstSegmentMs: number | undefined;
        let segments = 0;
        const t0 = deps.now();
        const outcome = await deps.transcriber.transcribe(
          {
            requestId,
            audioPath: `${deps.evalDirectory}/audio/${item.file}`,
            model: plan.model,
            threads: plan.threads,
          },
          () => {
            segments += 1;
            firstSegmentMs ??= deps.now() - t0;
          },
        );
        const hypothesis = transcriptText(outcome);
        const result: SpeechItemResult = {
          pass,
          file: item.file,
          condition: item.condition,
          set: item.set,
          gender: item.gender,
          durationSec: item.durationSec,
          status: outcome.status,
          failure: outcome.failure,
          hypothesis,
          timings: outcome.timings,
          segments,
          firstSegmentMs,
          memory: outcome.memory,
        };
        if (outcome.status === 'ok') {
          const score = scoreTranscript(item.reference, hypothesis);
          result.words = {
            reference: score.referenceWords,
            errors: score.word.errors,
            s: score.word.substitutions,
            d: score.word.deletions,
            i: score.word.insertions,
          };
          result.chars = {
            reference: score.referenceChars,
            errors: score.char.errors,
          };
          result.rtf =
            (outcome.timings?.inferenceMs ?? 0) / 1000 / item.durationSec;
          if (plan.sdkStage !== 'none' && hypothesis) {
            result.sdk = await handOff(
              deps.gateway,
              plan.sdkStage,
              hypothesis,
              `${requestId}-sdk`,
              deps.now,
            );
          }
        }
        results.push(result);
        await deps.record(result);
        deps.onProgress?.(results.length, plan.items.length * pass);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, plan.concurrency) }, worker),
    );
  } while (
    !deps.control.stopped &&
    plan.soakMinutes !== undefined &&
    deps.now() - started < plan.soakMinutes * 60_000
  );

  return summarizeSpeech(
    plan,
    results,
    cancelLatencies,
    pass,
    deps.now() - started,
  );
}

export function summarizeSpeech(
  plan: SpeechPlan,
  results: SpeechItemResult[],
  cancelLatencies: number[],
  passes: number,
  wallMs: number,
): SpeechSummary {
  const ok = results.filter(result => result.status === 'ok');
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0);
  const words = sum(ok.map(result => result.words?.reference ?? 0));
  const chars = sum(ok.map(result => result.chars?.reference ?? 0));
  const audio = sum(ok.map(result => result.durationSec));
  const inference = sum(
    ok.map(result => (result.timings?.inferenceMs ?? 0) / 1000),
  );
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  const byCondition: SpeechSummary['byCondition'] = {};
  for (const condition of new Set(
    results.map(result => `${result.set}/${result.condition}`),
  )) {
    const group = ok.filter(
      result => `${result.set}/${result.condition}` === condition,
    );
    const groupWords = sum(group.map(result => result.words?.reference ?? 0));
    const groupAudio = sum(group.map(result => result.durationSec));
    byCondition[condition] = {
      files: group.length,
      wer: groupWords
        ? round(
            sum(group.map(result => result.words?.errors ?? 0)) / groupWords,
          )
        : undefined,
      rtf: groupAudio
        ? round(
            sum(
              group.map(result => (result.timings?.inferenceMs ?? 0) / 1000),
            ) / groupAudio,
          )
        : undefined,
    };
  }
  const handoffs = results.flatMap(result => (result.sdk ? [result.sdk] : []));
  const codes: Record<string, number> = {};
  for (const handoff of handoffs) {
    if (handoff.code) codes[handoff.code] = (codes[handoff.code] ?? 0) + 1;
  }
  return {
    runId: plan.runId,
    model: plan.model,
    files: results.length,
    ok: ok.length,
    failed: results.filter(result => result.status === 'failed').length,
    cancelled: results.filter(result => result.status === 'cancelled').length,
    audioMinutes: Math.round((audio / 60) * 100) / 100,
    wer: words
      ? round(sum(ok.map(result => result.words?.errors ?? 0)) / words)
      : undefined,
    cer: chars
      ? round(sum(ok.map(result => result.chars?.errors ?? 0)) / chars)
      : undefined,
    realTimeFactor: audio ? round(inference / audio) : undefined,
    rtf: summarizeLatency(ok.map(result => result.rtf ?? 0)),
    firstSegmentMs: summarizeLatency(
      ok.flatMap(result =>
        result.firstSegmentMs === undefined ? [] : [result.firstSegmentMs],
      ),
    ),
    inferenceMs: summarizeLatency(
      ok.map(result => result.timings?.inferenceMs ?? 0),
    ),
    cancelLatencyMs: summarizeLatency(cancelLatencies),
    peakRssKb: Math.max(0, ...ok.map(result => result.memory?.vmHwmKb ?? 0)),
    sdk: handoffs.length
      ? {
          requests: handoffs.length,
          completed: handoffs.filter(handoff => handoff.outcome === 'completed')
            .length,
          valid: handoffs.filter(handoff => handoff.valid).length,
          grounded: handoffs.filter(handoff => handoff.grounded).length,
          codes,
          latencyMs: summarizeLatency(
            handoffs.map(handoff => handoff.latencyMs),
          ),
        }
      : undefined,
    byCondition,
    passes,
    wallMs: Math.round(wallMs),
  };
}
