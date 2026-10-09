import type {
  AppRoutingPolicy,
  ExecutionTarget,
} from '../../../platform/hybrid-ai/HybridAiGateway';
import { checkAnalysisOutput } from '../../private-node/domain/analysisResult';

// Load workloads for Hybrid AI v0.1 through Audio Journal. Inputs are
// synthetic and contain no journal content. Capabilities are the packaged
// SDK's local set (test.echo, test.stream, text.complete via llama.cpp,
// vector.embed via ONNX Runtime) plus the node fixture when a node is paired.

export type Expectation = 'success' | 'cancelled' | 'failure' | 'any';

export interface Workload {
  id: string;
  title: string;
  capability: string;
  target: ExecutionTarget;
  requests: number;
  concurrency: number;
  timeoutMs: number;
  /** Cancel each request this long after it starts. */
  cancelAfterMs?: number;
  /** Policy applied for this workload only, then restored. */
  policy?: AppRoutingPolicy;
  expect: Expectation;
  /** Expected public error code when `expect` is `failure`. */
  expectCodes?: string[];
  input(index: number): unknown;
  /** Checks a completed output against the capability's output contract. */
  validate(output: unknown, input: unknown): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const echoInput = (index: number) => ({ text: `load-${index}` });
const echoValid = (output: unknown, input: unknown) =>
  isRecord(output) &&
  isRecord(input) &&
  Object.keys(output).length === 1 &&
  output.text === input.text;

const PROMPTS = [
  'Once upon a time',
  'The little dog',
  'In the garden there was',
  'She opened the door and',
  'Tom wanted to play',
];
const completeInput = (index: number) => ({
  prompt: PROMPTS[index % PROMPTS.length],
});
const completeValid = (output: unknown) =>
  isRecord(output) &&
  Object.keys(output).length === 1 &&
  typeof output.text === 'string' &&
  output.text.length > 0;

const embedInput = (index: number) => ({
  features: [index % 7, 1, -0.5, (index % 3) * 0.25],
});
const embedValid = (output: unknown) =>
  isRecord(output) &&
  Array.isArray(output.embedding) &&
  output.embedding.length === 2 &&
  output.embedding.every(value => Number.isFinite(value));

const analyzeInput = (index: number) => ({
  document: `Synthetic load document ${index}. Review garden planning and seedlings.`,
});
const analyzeValid = (output: unknown) => checkAnalysisOutput(output).valid;

const kinds = {
  echo: { capability: 'test.echo', input: echoInput, validate: echoValid },
  stream: { capability: 'test.stream', input: echoInput, validate: echoValid },
  complete: {
    capability: 'text.complete',
    input: completeInput,
    validate: completeValid,
  },
  embed: {
    capability: 'vector.embed',
    input: embedInput,
    validate: embedValid,
  },
  analyze: {
    capability: 'document.analyze',
    input: analyzeInput,
    validate: analyzeValid,
  },
};

function workload(
  id: string,
  title: string,
  kind: keyof typeof kinds,
  options: Partial<Workload> & Pick<Workload, 'requests' | 'concurrency'>,
): Workload {
  return {
    id,
    title,
    target: 'local',
    timeoutMs: 30_000,
    expect: 'success',
    ...kinds[kind],
    ...options,
  };
}

/** The standard local suite: throughput, latency, queueing, and failure paths. */
export const localSuite: Workload[] = [
  workload('L01', 'echo · sequential', 'echo', {
    requests: 300,
    concurrency: 1,
  }),
  workload('L02', 'echo · 8 concurrent', 'echo', {
    requests: 1000,
    concurrency: 8,
  }),
  workload('L03', 'echo · 64 concurrent', 'echo', {
    requests: 2000,
    concurrency: 64,
  }),
  workload('L04', 'stream · 16 concurrent', 'stream', {
    requests: 500,
    concurrency: 16,
  }),
  workload('L05', 'text.complete (llama.cpp) · sequential', 'complete', {
    requests: 40,
    concurrency: 1,
  }),
  workload('L06', 'text.complete · 8 queued', 'complete', {
    requests: 80,
    concurrency: 8,
  }),
  workload('L07', 'vector.embed (ONNX) · sequential', 'embed', {
    requests: 300,
    concurrency: 1,
  }),
  workload('L08', 'vector.embed · 16 concurrent', 'embed', {
    requests: 1000,
    concurrency: 16,
  }),
  workload('L09', 'text.complete · auto routing', 'complete', {
    requests: 40,
    concurrency: 4,
    target: 'auto',
  }),
  workload('L10', 'cancellation storm · text.complete', 'complete', {
    requests: 64,
    concurrency: 32,
    cancelAfterMs: 2,
    expect: 'any',
  }),
  workload('L11', 'deadline 1 ms · text.complete', 'complete', {
    requests: 64,
    concurrency: 16,
    timeoutMs: 1,
    expect: 'any',
  }),
  workload('L12', 'policy denies local · explicit local', 'echo', {
    requests: 200,
    concurrency: 8,
    policy: { allowLocal: false, allowNode: true },
    expect: 'failure',
    expectCodes: ['POLICY_DENIED'],
  }),
  workload('L13', 'policy denies local · auto, no node', 'echo', {
    requests: 200,
    concurrency: 8,
    target: 'auto',
    policy: { allowLocal: false, allowNode: false },
    expect: 'failure',
    expectCodes: ['NO_ELIGIBLE_TARGET', 'POLICY_DENIED'],
  }),
  workload('L14', 'schema-invalid input', 'echo', {
    requests: 200,
    concurrency: 8,
    input: () => ({ text: '' }),
    expect: 'failure',
    expectCodes: ['SCHEMA_VALIDATION_FAILED', 'INVALID_ARGUMENT'],
  }),
  workload('L15', 'explicit node without a node', 'echo', {
    requests: 100,
    concurrency: 8,
    target: 'node',
    expect: 'failure',
    expectCodes: [
      'NO_ELIGIBLE_TARGET',
      'NODE_NOT_PAIRED',
      'NODE_UNAVAILABLE',
      'NODE_CAPABILITY_UNAVAILABLE',
      'CAPABILITY_NOT_FOUND',
    ],
  }),
];

/** One mixed round for the soak: every local capability, interleaved. */
export const mixedWorkload = workload(
  'M01',
  'mixed local · 16 concurrent',
  'echo',
  {
    requests: 400,
    concurrency: 16,
    capability: 'mixed',
    input: index => index,
    validate: () => true,
  },
);

const mixedKinds = [kinds.echo, kinds.stream, kinds.embed, kinds.complete];

/** Resolves a mixed workload's request into a concrete capability and input. */
export function requestFor(target: Workload, index: number) {
  if (target.capability !== 'mixed') {
    return {
      capability: target.capability,
      input: target.input(index),
      validate: target.validate,
    };
  }
  // text.complete is slow; keep it at 1 in 16 so the soak exercises all paths.
  const kind = index % 16 === 15 ? mixedKinds[3] : mixedKinds[index % 3];
  return {
    capability: kind.capability,
    input: kind.input(index),
    validate: kind.validate,
  };
}

/** Node fixture workloads, run only when a node is connected. */
export const nodeSuite: Workload[] = [
  workload('N01', 'document.analyze · node sequential', 'analyze', {
    requests: 100,
    concurrency: 1,
    target: 'node',
  }),
  workload('N02', 'document.analyze · node 16 concurrent', 'analyze', {
    requests: 400,
    concurrency: 16,
    target: 'node',
  }),
  workload('N03', 'document.analyze · auto', 'analyze', {
    requests: 100,
    concurrency: 8,
    target: 'auto',
  }),
];
