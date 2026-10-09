import {
  summarizeLatency,
  summarizeWorkload,
} from '../src/features/load-lab/domain/stats';
import {
  localSuite,
  requestFor,
  mixedWorkload,
} from '../src/features/load-lab/domain/workloads';

const audit = { events: 2, terminalEvents: 1, outOfOrder: false };
const echo = localSuite.find(item => item.id === 'L01')!;

it('computes nearest-rank percentiles', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  expect(summarizeLatency(values)).toEqual({
    p50: 50,
    p90: 90,
    p95: 95,
    p99: 99,
    max: 100,
    mean: 50.5,
  });
  expect(summarizeLatency([])).toBeUndefined();
});

it('passes a clean workload and counts targets and reasons', () => {
  const samples = Array.from({ length: echo.requests }, () => ({
    totalMs: 2,
    firstEventMs: 1,
    outcome: 'completed' as const,
    target: 'local' as const,
    routingReason: 'explicit_local',
    valid: true,
    audit,
  }));
  const result = summarizeWorkload(echo, samples, 600);
  expect(result).toMatchObject({
    passed: true,
    completed: echo.requests,
    throughputPerSecond: 500,
    targets: { local: echo.requests },
    routingReasons: { explicit_local: echo.requests },
  });
});

it('flags every invariant violation', () => {
  const result = summarizeWorkload(
    { ...echo, requests: 5 },
    [
      { totalMs: 1, outcome: 'completed', target: 'node', valid: true, audit },
      {
        totalMs: 1,
        outcome: 'completed',
        target: 'local',
        valid: false,
        audit,
      },
      { totalMs: 1, outcome: 'failed', code: 'EXECUTION_FAILED', audit },
      {
        totalMs: 1,
        outcome: 'completed',
        target: 'local',
        valid: true,
        audit: { ...audit, terminalEvents: 2 },
      },
      {
        totalMs: 1,
        outcome: 'completed',
        target: 'local',
        valid: true,
        audit: { ...audit, outOfOrder: true },
      },
    ],
    10,
  );
  expect(result.passed).toBe(false);
  expect(result.violations).toEqual({
    terminalNotOne: 1,
    outOfOrder: 1,
    explicitTargetSwitched: 1,
    invalidOutput: 1,
    unexpectedOutcome: 1,
  });
});

it('accepts only the expected failure codes', () => {
  const denied = localSuite.find(item => item.id === 'L12')!;
  const ok = summarizeWorkload(
    { ...denied, requests: 1 },
    [{ totalMs: 1, outcome: 'failed', code: 'POLICY_DENIED', audit }],
    1,
  );
  const wrong = summarizeWorkload(
    { ...denied, requests: 1 },
    [{ totalMs: 1, outcome: 'failed', code: 'EXECUTION_FAILED', audit }],
    1,
  );
  expect([ok.passed, wrong.passed]).toEqual([true, false]);
});

it('builds schema-shaped synthetic inputs without journal content', () => {
  const ids = new Set(localSuite.map(item => item.id));
  expect(ids.size).toBe(localSuite.length);
  for (const workload of localSuite) {
    const { input } = requestFor(workload, 3);
    expect(JSON.stringify(input).length).toBeLessThan(200);
  }
  const kinds = new Set(
    Array.from(
      { length: 16 },
      (_, index) => requestFor(mixedWorkload, index).capability,
    ),
  );
  expect(kinds).toEqual(
    new Set(['test.echo', 'test.stream', 'vector.embed', 'text.complete']),
  );
  expect(requestFor(localSuite[4], 0).validate({ text: 'tale' }, {})).toBe(
    true,
  );
  expect(
    requestFor(localSuite[6], 0).validate({ embedding: [1, Number.NaN] }, {}),
  ).toBe(false);
});
