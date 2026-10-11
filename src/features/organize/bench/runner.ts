// The AJ-2 organize performance runner: the complete journal.organize@1
// path through the public SDK port with deterministic transcript fixtures.
// Each run builds the request with the app's own builder, streams it with
// execution 'node', validates the result with the app's own validator, and
// rehearses persistence (the same writes, rolled back), then waits for the
// result to be on screen. Samples carry sizes, codes, and durations only.
// Kept apart from the transcription benchmarks and the SDK's synthetic
// capability load lab.

import type {
  CapabilityUpdate,
  HybridAiGateway,
} from '../../../platform/hybrid-ai/HybridAiGateway';
import type { JournalEntryDetail } from '../../journal/ports/JournalRepository';
import {
  canonicalBytes,
  CAPABILITY,
  INPUT_CAP,
  ORGANIZE_TIMEOUT_MS,
  resultViolation,
  type OrganizeInput,
  type OrganizeOutput,
} from '../domain/contract';
import { buildOrganizeRequest, type OrganizeCrypto } from '../domain/request';
import type { DerivationRepository } from '../ports/DerivationRepository';
import {
  durationFixtures,
  forRun,
  sizedTo,
  transcriptFixture,
  type TranscriptFixture,
} from './fixtures';

export type BenchMode =
  /** Organize and time every phase. */
  | 'measure'
  /** The app's builder must refuse the request with a typed reason. */
  | 'refuse'
  /** An over-cap input sent straight to the SDK must fail with a typed code. */
  | 'sdk-reject'
  /** Cancel shortly after the node reports progress. */
  | 'cancel'
  /** The node is too slow; the run must end at the deadline. */
  | 'timeout';

export interface BenchScenario {
  id: string;
  label: string;
  mode: BenchMode;
  fixture: () => TranscriptFixture;
}

export interface BenchSample {
  scenario: string;
  mode: BenchMode;
  run: number;
  outcome: 'stored' | 'invalid' | 'failed' | 'cancelled' | 'refused';
  code?: string;
  durationMs: number;
  words: number;
  segments: number;
  inputBytes?: number;
  outputBytes?: number;
  buildMs: number;
  acceptedMs?: number;
  firstProgressMs?: number;
  firstPartialMs?: number;
  terminalMs?: number;
  validateMs?: number;
  persistMs?: number;
  visibleMs?: number;
  cancelLatencyMs?: number;
  deadlineOverrunMs?: number;
  events: number;
  partials: number;
}

export interface BenchDependencies {
  gateway: Pick<HybridAiGateway, 'run' | 'cancel'>;
  derivations: Pick<DerivationRepository, 'rehearseSave'>;
  crypto: OrganizeCrypto;
  /** A request-key secret for the benchmark only, never the journal's. */
  keyHex: string;
  context: { locale: string; timeZone: string };
  now: () => number;
  /** Shows the sample and resolves with now() once it is on screen. */
  present: (sample: BenchSample) => Promise<number>;
  log: (kind: string, payload: unknown) => void;
}

/** Cancel this long after the first progress event (the node has the job). */
export const CANCEL_AFTER_PROGRESS_MS = 300;

function byId(id: string): TranscriptFixture {
  const found = durationFixtures().find(fixture => fixture.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
}

/** A transcript sized so the built request is exactly `bytes` long. */
function boundary(
  id: string,
  label: string,
  bytes: number,
  measure: (detail: JournalEntryDetail) => number,
): TranscriptFixture {
  // About 24 minutes of speech reaches the cap. Grow in 15 s steps to the
  // longest transcript under the target, then pad its last segment, so no
  // segment nears the 4,000-character unit limit.
  let base = transcriptFixture(id, label, 20 * 60_000, 'c');
  for (let ms = base.durationMs + 15_000; ; ms += 15_000) {
    const longer = transcriptFixture(id, label, ms, 'c');
    if (measure(longer.detail) > bytes) break;
    base = longer;
  }
  const detail = sizedTo(base.detail, bytes, measure);
  const words = detail.transcript.lines.reduce(
    (n, line) => n + line.text.split(' ').length,
    0,
  );
  return { ...base, detail, words };
}

export function benchScenarios(
  deps: Pick<BenchDependencies, 'crypto' | 'keyHex' | 'context'>,
): BenchScenario[] {
  const measure = (detail: JournalEntryDetail) => {
    const built = buildOrganizeRequest({
      selection: [detail],
      keyHex: deps.keyHex,
      crypto: deps.crypto,
      context: deps.context,
    });
    // A refused request still has a size; rebuild it without the cap.
    return built.ok ? built.bytes : oversizeInput(detail, deps).bytes;
  };
  const cap = () => boundary('cap', 'exact input cap', INPUT_CAP, measure);
  const over = () =>
    boundary('over', 'input cap + 1 byte', INPUT_CAP + 1, measure);
  return [
    ...['v30s', 'v1m', 'v3m', 'v5m', 'v10m'].map(id => ({
      id,
      label: byId(id).label,
      mode: 'measure' as const,
      fixture: () => byId(id),
    })),
    { id: 'cap', label: 'exact input cap', mode: 'measure', fixture: cap },
    { id: 'over', label: 'input cap + 1', mode: 'refuse', fixture: over },
    {
      id: 'sdk-over',
      label: 'input cap + 1 sent to the SDK',
      mode: 'sdk-reject',
      fixture: over,
    },
    {
      id: 'v30m',
      label: '30 min',
      mode: 'refuse',
      fixture: () => byId('v30m'),
    },
    {
      id: 'v60m',
      label: '60 min',
      mode: 'refuse',
      fixture: () => byId('v60m'),
    },
    {
      id: 'cancel',
      label: '5 min, cancelled',
      mode: 'cancel',
      fixture: () => byId('v5m'),
    },
    {
      id: 'timeout',
      label: '1 min, deadline',
      mode: 'timeout',
      fixture: () => byId('v1m'),
    },
  ];
}

/**
 * The request the app's builder would make if it had no limits: the same
 * shape and key, used only to size and to send an over-cap input to the SDK.
 */
function oversizeInput(
  detail: JournalEntryDetail,
  deps: Pick<BenchDependencies, 'crypto' | 'keyHex' | 'context'>,
): { input: OrganizeInput; bytes: number } {
  const recording = detail.recording!;
  const input: OrganizeInput = {
    contract: 'journal.organize@1',
    requestKey: `org_${'0'.repeat(26)}`,
    locale: deps.context.locale,
    timeZone: deps.context.timeZone,
    kinds: ['summary', 'sections', 'tasks', 'ideas', 'people', 'projects'],
    entries: [
      {
        entryId: detail.entry.id,
        kind: 'voice',
        createdAt: new Date(detail.entry.createdAt).toISOString(),
        recordingId: recording.id,
        transcriptRevision: detail.transcript.engineRevision,
        durationMs: recording.durationMs,
        units: detail.transcript.lines.map(line => ({
          unitId: line.segmentId,
          text: line.text,
          sha256: deps.crypto.sha256Hex(line.text),
          startMs: line.startMs,
          endMs: line.endMs,
        })),
      },
    ],
  };
  return { input, bytes: canonicalBytes(input) };
}

let requestCounter = 0;

/** Runs one sample of a scenario. `run` numbers the run token. */
export async function runSample(
  scenario: BenchScenario,
  fixture: TranscriptFixture,
  run: number,
  deps: BenchDependencies,
): Promise<BenchSample> {
  const { now } = deps;
  const detail = forRun(fixture.detail, run);
  const base = {
    scenario: scenario.id,
    mode: scenario.mode,
    run,
    durationMs: fixture.durationMs,
    words: fixture.words,
    segments: fixture.segments,
    events: 0,
    partials: 0,
  };
  const buildStart = now();
  const built = buildOrganizeRequest({
    selection: [detail],
    keyHex: deps.keyHex,
    crypto: deps.crypto,
    context: deps.context,
  });
  const buildMs = now() - buildStart;

  let input: OrganizeInput;
  let inputSha256 = '';
  if (scenario.mode === 'sdk-reject') {
    input = oversizeInput(detail, deps).input;
  } else if (!built.ok) {
    return {
      ...base,
      outcome: 'refused',
      code: built.reason,
      buildMs,
      inputBytes: oversizeInput(detail, deps).bytes,
    };
  } else {
    input = built.input;
    inputSha256 = built.inputSha256;
  }

  requestCounter += 1;
  const requestId = `orgbench-${requestCounter}-${run}`;
  const sample: BenchSample = {
    ...base,
    outcome: 'failed',
    buildMs,
    inputBytes: canonicalBytes(input),
  };
  let terminal: CapabilityUpdate | undefined;
  let cancelAt: number | undefined;
  const started = now();
  const since = () => now() - started;
  await deps.gateway.run(
    {
      capability: CAPABILITY.id,
      version: CAPABILITY.version,
      input,
      execution: 'node',
      timeoutMs: ORGANIZE_TIMEOUT_MS,
      requestId,
    },
    update => {
      if (terminal) return;
      sample.events += 1;
      if (update.type === 'accepted') sample.acceptedMs ??= since();
      if (update.type === 'progress') {
        if (sample.firstProgressMs === undefined) {
          sample.firstProgressMs = since();
          if (scenario.mode === 'cancel') {
            setTimeout(() => {
              cancelAt = since();
              deps.gateway.cancel(requestId);
            }, CANCEL_AFTER_PROGRESS_MS);
          }
        }
      }
      if (update.type === 'partial') {
        sample.partials += 1;
        sample.firstPartialMs ??= since();
      }
      if (
        update.type === 'completed' ||
        update.type === 'failed' ||
        update.type === 'cancelled'
      ) {
        terminal = update;
        sample.terminalMs = since();
      }
    },
  );
  sample.terminalMs ??= since();

  if (terminal?.type === 'cancelled') {
    sample.outcome = 'cancelled';
    if (cancelAt !== undefined) {
      sample.cancelLatencyMs = sample.terminalMs - cancelAt;
    }
  } else if (terminal?.type === 'completed') {
    const output = terminal.output;
    sample.outputBytes = canonicalBytes(output);
    const validateStart = now();
    const code = resultViolation(output, input, inputSha256);
    sample.validateMs = now() - validateStart;
    if (code) {
      sample.outcome = 'invalid';
      sample.code = code;
    } else {
      const persistStart = now();
      await deps.derivations.rehearseSave?.({
        input,
        inputSha256,
        output: output as OrganizeOutput,
        createdAt: Date.now(),
      });
      sample.persistMs = now() - persistStart;
      sample.outcome = 'stored';
    }
  } else {
    sample.outcome = 'failed';
    sample.code =
      terminal?.type === 'failed' ? terminal.failure.code : 'NO_TERMINAL';
    if (scenario.mode === 'timeout') {
      sample.deadlineOverrunMs = sample.terminalMs - ORGANIZE_TIMEOUT_MS;
    }
  }
  sample.visibleMs = (await deps.present(sample)) - started;
  return sample;
}

export interface BenchControl {
  stopped: boolean;
}

/** Runs `count` samples of a scenario, logging each as one metrics line. */
export async function runScenario(
  scenario: BenchScenario,
  count: number,
  deps: BenchDependencies,
  control: BenchControl,
  onProgress: (done: number) => void,
): Promise<BenchSample[]> {
  const fixture = scenario.fixture();
  const builtSize = buildOrganizeRequest({
    selection: [fixture.detail],
    keyHex: deps.keyHex,
    crypto: deps.crypto,
    context: deps.context,
  });
  deps.log('AJ_ORGANIZE_PERF_START', {
    scenario: scenario.id,
    mode: scenario.mode,
    count,
    durationMs: fixture.durationMs,
    words: fixture.words,
    segments: fixture.segments,
    inputBytes: builtSize.ok
      ? builtSize.bytes
      : oversizeInput(fixture.detail, deps).bytes,
  });
  const samples: BenchSample[] = [];
  for (let run = 1; run <= count && !control.stopped; run += 1) {
    const sample = await runSample(scenario, fixture, run, deps);
    samples.push(sample);
    deps.log('AJ_ORGANIZE_PERF', sample);
    onProgress(run);
  }
  deps.log('AJ_ORGANIZE_PERF_DONE', {
    scenario: scenario.id,
    runs: samples.length,
    stopped: control.stopped,
  });
  return samples;
}
