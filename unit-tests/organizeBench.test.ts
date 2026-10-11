import {
  canonicalBytes,
  canonicalJson,
  INPUT_CAP,
  type OrganizeInput,
  type OrganizeOutput,
  type SourceRef,
} from '../src/features/organize/domain/contract';
import { buildOrganizeRequest } from '../src/features/organize/domain/request';
import { durationFixtures } from '../src/features/organize/bench/fixtures';
import {
  benchScenarios,
  runSample,
  type BenchDependencies,
} from '../src/features/organize/bench/runner';
import type {
  CapabilityRequest,
  CapabilityUpdate,
} from '../src/platform/hybrid-ai/HybridAiGateway';
import { testOrganizeCrypto } from '../test/organizeCrypto';

// The organize performance suite's fixtures and runner (AJ-2): fixed sizes,
// typed refusals at and beyond the input cap, and every timing captured.

const deps = {
  crypto: testOrganizeCrypto,
  keyHex: 'ab'.repeat(32),
  context: { locale: 'en-US', timeZone: 'Asia/Kolkata' },
};
const scenarios = benchScenarios(deps);
const scenario = (id: string) => scenarios.find(s => s.id === id)!;
const build = (id: string) =>
  buildOrganizeRequest({ selection: [scenario(id).fixture().detail], ...deps });

it('pins every duration fixture: words, segments, and request bytes', () => {
  const sizes = durationFixtures().map(f => {
    const built = buildOrganizeRequest({ selection: [f.detail], ...deps });
    return [f.id, f.words, f.segments, built.ok ? built.bytes : built.reason];
  });
  expect(sizes).toEqual([
    ['v30s', 70, 4, 1_413],
    ['v1m', 139, 9, 2_588],
    ['v3m', 422, 28, 7_199],
    ['v5m', 696, 48, 12_000],
    ['v10m', 1_401, 92, 22_970],
    ['v30m', 4_198, 283, 'TOO_LARGE'],
    ['v60m', 8_410, 558, 'TOO_MANY_UNITS'],
  ]);
});

it('sizes the boundary fixtures to the cap and one byte over', () => {
  const cap = build('cap');
  expect(cap.ok && cap.bytes).toBe(INPUT_CAP);
  expect(build('over')).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
  for (const id of ['cap', 'over']) {
    const lines = scenario(id).fixture().detail.transcript.lines;
    expect(Math.max(...lines.map(line => line.text.length))).toBeLessThan(
      4_000,
    );
  }
});

/**
 * A scripted node. A script without a terminal event keeps the job open
 * until the runner cancels it, as a real node does.
 */
function node(script: (input: OrganizeInput) => CapabilityUpdate[]) {
  const requests: CapabilityRequest[] = [];
  const cancelled: string[] = [];
  let open: ((update: CapabilityUpdate) => void) | undefined;
  return {
    requests,
    cancelled,
    run: async (
      request: CapabilityRequest,
      onUpdate: (u: CapabilityUpdate) => void,
    ) => {
      requests.push(request);
      const updates = script(request.input as OrganizeInput);
      for (const update of updates) {
        onUpdate(update);
        await new Promise(r => setTimeout(r, 1));
      }
      if (
        !updates.some(u =>
          ['completed', 'failed', 'cancelled'].includes(u.type),
        )
      ) {
        await new Promise<void>(resolve => {
          open = update => {
            onUpdate(update);
            resolve();
          };
        });
      }
      return { events: 1, terminalEvents: 1, outOfOrder: false };
    },
    cancel: (requestId: string) => {
      cancelled.push(requestId);
      open?.({ type: 'cancelled' });
    },
  };
}

function resultFor(input: OrganizeInput): OrganizeOutput {
  const entry = input.entries[0];
  const unit = entry.units[0] as {
    unitId: string;
    sha256: string;
    text: string;
    startMs: number;
    endMs: number;
  };
  const ref: SourceRef = {
    entryId: entry.entryId,
    unitId: unit.unitId,
    unitSha256: unit.sha256,
    charStart: 0,
    charEnd: unit.text.length,
    audioStartMs: unit.startMs,
    audioEndMs: unit.endMs,
  };
  return {
    contract: 'journal.organize@1',
    requestKey: input.requestKey,
    inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(input)),
    engine: { id: 'aj.rules', version: '1.0.0' },
    completeness: 'complete',
    summary: { text: 'A day.', sources: [ref] },
    sections: [],
    tasks: [],
    ideas: [],
    people: [],
    projects: [],
  };
}

function dependencies(
  gateway: ReturnType<typeof node>,
): BenchDependencies & { rehearsals: number } {
  let clock = 0;
  const result = {
    ...deps,
    gateway,
    rehearsals: 0,
    derivations: {
      rehearseSave: async () => {
        result.rehearsals += 1;
      },
    },
    now: () => (clock += 1),
    present: async () => clock + 1,
    log: () => undefined,
  };
  return result;
}

it('times every phase of a run and rehearses persistence (rolled back)', async () => {
  const gateway = node(input => [
    { type: 'accepted' },
    { type: 'progress', stage: 'received', fraction: 0.1 },
    { type: 'partial', delta: { counts: { tasks: 0 } } },
    {
      type: 'completed',
      output: resultFor(input),
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    },
  ]);
  const d = dependencies(gateway);
  const s = scenario('v1m');
  const sample = await runSample(s, s.fixture(), 3, d);
  expect(sample).toMatchObject({
    scenario: 'v1m',
    outcome: 'rehearsed',
    words: 139,
    inputBytes: 2_588,
    events: 4,
    partials: 1,
  });
  for (const key of [
    'acceptedMs',
    'firstProgressMs',
    'firstPartialMs',
    'terminalMs',
    'validateMs',
    'persistMs',
    'visibleMs',
  ] as const) {
    expect([key, typeof sample[key]]).toEqual([key, 'number']);
  }
  expect(sample.outputBytes).toBe(
    canonicalBytes(resultFor(gateway.requests[0].input as OrganizeInput)),
  );
  expect(d.rehearsals).toBe(1);
  expect(gateway.requests[0]).toMatchObject({
    capability: 'journal.organize',
    execution: 'node',
    timeoutMs: 60_000,
  });
  // The run token changes the request, not its size.
  const again = await runSample(s, s.fixture(), 4, d);
  expect(again.inputBytes).toBe(sample.inputBytes);
  expect((gateway.requests[1].input as OrganizeInput).requestKey).not.toBe(
    (gateway.requests[0].input as OrganizeInput).requestKey,
  );
});

it('refuses over-cap fixtures in the builder and sends nothing', async () => {
  const gateway = node(() => []);
  for (const [id, reason] of [
    ['over', 'TOO_LARGE'],
    ['v30m', 'TOO_LARGE'],
    ['v60m', 'TOO_MANY_UNITS'],
  ]) {
    const s = scenario(id);
    const sample = await runSample(s, s.fixture(), 1, dependencies(gateway));
    expect([id, sample.outcome, sample.code]).toEqual([id, 'refused', reason]);
  }
  expect(gateway.requests).toHaveLength(0);
});

it('sends exactly one byte over the cap to the SDK for its typed rejection', async () => {
  const gateway = node(() => [
    { type: 'failed', failure: { code: 'SCHEMA_VALIDATION_FAILED' } },
  ]);
  const s = scenario('sdk-over');
  const sample = await runSample(s, s.fixture(), 1, dependencies(gateway));
  expect(canonicalBytes(gateway.requests[0].input)).toBe(INPUT_CAP + 1);
  expect(sample).toMatchObject({
    outcome: 'failed',
    code: 'SCHEMA_VALIDATION_FAILED',
    inputBytes: INPUT_CAP + 1,
  });
});

it('cancels after the first progress and measures the latency', async () => {
  const gateway = node(() => [
    { type: 'accepted' },
    { type: 'progress', stage: 'received', fraction: 0.1 },
  ]);
  const d = dependencies(gateway);
  const s = scenario('cancel');
  const running = runSample(s, s.fixture(), 1, d);
  const sample = await running;
  expect(gateway.cancelled).toHaveLength(1);
  expect(sample.outcome).toBe('cancelled');
  expect(typeof sample.cancelLatencyMs).toBe('number');
});
