import type { RunAudit } from '../../../platform/hybrid-ai/HybridAiGateway';
import type { Workload } from './workloads';

export interface RequestSample {
  totalMs: number;
  firstEventMs?: number;
  outcome: 'completed' | 'failed' | 'cancelled';
  code?: string;
  target?: 'local' | 'node';
  routingReason?: string;
  valid?: boolean;
  audit: RunAudit;
}

export interface LatencySummary {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Privacy-safe workload result: codes, counts, and durations only. */
export interface WorkloadResult {
  id: string;
  title: string;
  capability: string;
  target: string;
  concurrency: number;
  requests: number;
  wallMs: number;
  throughputPerSecond: number;
  completed: number;
  cancelled: number;
  failed: number;
  failureCodes: Record<string, number>;
  targets: Record<string, number>;
  routingReasons: Record<string, number>;
  latencyMs?: LatencySummary;
  firstEventMs?: LatencySummary;
  violations: {
    terminalNotOne: number;
    outOfOrder: number;
    explicitTargetSwitched: number;
    invalidOutput: number;
    unexpectedOutcome: number;
  };
  passed: boolean;
}

export function summarizeLatency(values: number[]): LatencySummary | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    ];
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

const bump = (table: Record<string, number>, key: string | undefined) => {
  if (key) {
    table[key] = (table[key] ?? 0) + 1;
  }
};

export function summarizeWorkload(
  workload: Workload,
  samples: RequestSample[],
  wallMs: number,
): WorkloadResult {
  const failureCodes: Record<string, number> = {};
  const targets: Record<string, number> = {};
  const routingReasons: Record<string, number> = {};
  const violations = {
    terminalNotOne: 0,
    outOfOrder: 0,
    explicitTargetSwitched: 0,
    invalidOutput: 0,
    unexpectedOutcome: 0,
  };
  for (const sample of samples) {
    if (sample.audit.terminalEvents !== 1) violations.terminalNotOne += 1;
    if (sample.audit.outOfOrder) violations.outOfOrder += 1;
    if (sample.outcome === 'failed') bump(failureCodes, sample.code);
    bump(targets, sample.target);
    bump(routingReasons, sample.routingReason);
    if (
      sample.outcome === 'completed' &&
      workload.target !== 'auto' &&
      sample.target !== workload.target
    ) {
      violations.explicitTargetSwitched += 1;
    }
    if (sample.outcome === 'completed' && sample.valid === false) {
      violations.invalidOutput += 1;
    }
    const expected =
      workload.expect === 'any' ||
      (workload.expect === 'success' && sample.outcome === 'completed') ||
      (workload.expect === 'cancelled' && sample.outcome === 'cancelled') ||
      (workload.expect === 'failure' &&
        sample.outcome === 'failed' &&
        (!workload.expectCodes ||
          workload.expectCodes.includes(sample.code ?? '')));
    if (!expected) violations.unexpectedOutcome += 1;
  }
  const completed = samples.filter(sample => sample.outcome === 'completed');
  return {
    id: workload.id,
    title: workload.title,
    capability: workload.capability,
    target: workload.target,
    concurrency: workload.concurrency,
    requests: samples.length,
    wallMs: Math.round(wallMs),
    throughputPerSecond:
      Math.round((samples.length / Math.max(wallMs, 1)) * 100_000) / 100,
    completed: completed.length,
    cancelled: samples.filter(sample => sample.outcome === 'cancelled').length,
    failed: samples.filter(sample => sample.outcome === 'failed').length,
    failureCodes,
    targets,
    routingReasons,
    latencyMs: summarizeLatency(samples.map(sample => sample.totalMs)),
    firstEventMs: summarizeLatency(
      samples.flatMap(sample =>
        sample.firstEventMs === undefined ? [] : [sample.firstEventMs],
      ),
    ),
    violations,
    passed:
      samples.length === workload.requests &&
      Object.values(violations).every(count => count === 0),
  };
}
