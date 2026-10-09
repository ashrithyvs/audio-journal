import type {
  AppRoutingPolicy,
  CapabilityUpdate,
  HybridAiGateway,
} from '../../../platform/hybrid-ai/HybridAiGateway';
import {
  type RequestSample,
  summarizeWorkload,
  type WorkloadResult,
} from './stats';
import { requestFor, type Workload } from './workloads';

export interface RunControl {
  stopped: boolean;
}

let sequence = 0;

/** Runs one request through the public SDK and records an audited sample. */
async function runOne(
  gateway: HybridAiGateway,
  workload: Workload,
  index: number,
  now: () => number,
): Promise<RequestSample> {
  sequence += 1;
  const requestId = `load-${workload.id}-${sequence}`;
  const { capability, input, validate } = requestFor(workload, index);
  const started = now();
  let firstEventMs: number | undefined;
  let terminal: CapabilityUpdate | undefined;
  const timer =
    workload.cancelAfterMs === undefined
      ? undefined
      : setTimeout(() => gateway.cancel(requestId), workload.cancelAfterMs);
  const audit = await gateway.run(
    {
      capability,
      version: '1',
      input,
      execution: workload.target,
      timeoutMs: workload.timeoutMs,
      requestId,
    },
    update => {
      firstEventMs ??= now() - started;
      if (
        update.type === 'completed' ||
        update.type === 'failed' ||
        update.type === 'cancelled'
      ) {
        terminal = update;
      }
    },
  );
  const totalMs = now() - started;
  if (timer) clearTimeout(timer);
  const result = terminal as CapabilityUpdate | undefined;
  if (result?.type === 'completed') {
    return {
      totalMs,
      firstEventMs,
      outcome: 'completed',
      target: result.target,
      routingReason: result.routingReason,
      valid: validate(result.output, input),
      audit,
    };
  }
  if (result?.type === 'cancelled') {
    return { totalMs, firstEventMs, outcome: 'cancelled', audit };
  }
  return {
    totalMs,
    firstEventMs,
    outcome: 'failed',
    code: result?.type === 'failed' ? result.failure.code : 'NO_TERMINAL',
    audit,
  };
}

/** Runs a workload with a bounded worker pool. */
export async function runWorkload(
  gateway: HybridAiGateway,
  workload: Workload,
  options: {
    now: () => number;
    appPolicy: AppRoutingPolicy;
    control: RunControl;
    onProgress?(done: number): void;
  },
): Promise<WorkloadResult> {
  if (workload.policy) gateway.setPolicy(workload.policy);
  const samples: RequestSample[] = [];
  let next = 0;
  const started = options.now();
  try {
    const worker = async () => {
      while (!options.control.stopped && next < workload.requests) {
        const index = next;
        next += 1;
        samples.push(await runOne(gateway, workload, index, options.now));
        options.onProgress?.(samples.length);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(workload.concurrency, workload.requests) },
        worker,
      ),
    );
  } finally {
    if (workload.policy) gateway.setPolicy(options.appPolicy);
  }
  return summarizeWorkload(workload, samples, options.now() - started);
}
