import fs from 'node:fs';
import path from 'node:path';

import type { JournalEntryDetail } from '../src/features/journal/ports/JournalRepository';
import {
  OrganizeController,
  type NodeRunReport,
} from '../src/features/organize/application/OrganizeController';
import {
  canonicalJson,
  parseStrictJson,
  type OrganizeInput,
  type OrganizeOutput,
} from '../src/features/organize/domain/contract';
import { buildOrganizeRequest } from '../src/features/organize/domain/request';
import type {
  DerivationRepository,
  StoredDerivation,
  ValidatedResult,
} from '../src/features/organize/ports/DerivationRepository';
import type {
  CapabilityRequest,
  CapabilityUpdate,
  RunAudit,
} from '../src/platform/hybrid-ai/HybridAiGateway';
import { testOrganizeCrypto } from '../test/organizeCrypto';

// The organize run against the frozen contract vectors: the app's builder
// reproduces every fixture byte for byte from journal entries, and every
// event sequence reaches its expected outcome through the controller.

const ROOT = path.join(__dirname, '..', 'schemas', 'journal', 'v1');
const read = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
const fixtures: Record<string, OrganizeInput> = read('vectors/fixtures.json');
const results = read('vectors/results.json');
const events = read('vectors/events.json');
const { testKeyHex } = read('vectors/request-keys.json');

/** Journal entries that hold exactly a fixture's content. */
function detailsFor(input: OrganizeInput): JournalEntryDetail[] {
  return input.entries.map(e => {
    const createdAt = Date.parse(e.createdAt);
    const base = {
      id: e.entryId,
      status: 'ready' as const,
      createdAt,
      updatedAt: createdAt,
      title: 'Never sent',
    };
    if (e.kind === 'written') {
      let sourceText = '';
      for (const unit of e.units) {
        sourceText = sourceText.padEnd(unit.offset, '\n') + unit.text;
      }
      return {
        entry: { ...base, kind: 'written', sourceText },
        transcript: { kind: 'none', engineRevision: 0, lines: [] },
      };
    }
    return {
      entry: { ...base, kind: 'voice' },
      recording: {
        id: e.recordingId,
        entryId: e.entryId,
        relativePath: `recordings/${e.recordingId}.ajr`,
        state: 'ready',
        format: 'AJR1/pcm_s16le/16000/1',
        startedAt: createdAt,
        durationMs: e.durationMs,
        sealedChunks: 1,
        byteCount: 64,
      },
      transcript: {
        kind: 'final',
        engineRevision: e.transcriptRevision,
        lines: e.units.map((unit, ordinal) => ({
          segmentId: unit.unitId,
          originSegmentId: unit.unitId,
          ordinal,
          startMs: unit.startMs,
          endMs: unit.endMs,
          text: unit.text,
          state: 'final',
          engineRevision: e.transcriptRevision,
        })),
      },
    };
  });
}

class MemoryDerivations implements DerivationRepository {
  readonly stored = new Map<string, StoredDerivation>();
  async requestKeySecret() {
    return testKeyHex as string;
  }
  async findByRequestKey(requestKey: string) {
    return this.stored.get(requestKey);
  }
  async latestForEntry() {
    return undefined;
  }
  async saveValidated(result: ValidatedResult) {
    const existing = this.stored.get(result.input.requestKey);
    if (existing) {
      return { derivation: existing, duplicate: true };
    }
    const derivation: StoredDerivation = {
      id: `drv_${String(this.stored.size).padStart(26, '0')}`,
      requestKey: result.input.requestKey,
      revision: 1,
      createdAt: result.createdAt,
      engine: result.output.engine,
      entryIds: result.input.entries.map(e => e.entryId),
      output: result.output,
      tasks: [],
    };
    this.stored.set(derivation.requestKey, derivation);
    return { derivation, duplicate: false };
  }
}

/** Delivers whatever the test scripts, including events after a terminal. */
class ScriptedGateway {
  readonly requests: CapabilityRequest[] = [];
  readonly cancelled: string[] = [];
  private pending?: {
    onUpdate: (update: CapabilityUpdate) => void;
    resolve: (audit: RunAudit) => void;
  };

  run(request: CapabilityRequest, onUpdate: (u: CapabilityUpdate) => void) {
    this.requests.push(request);
    return new Promise<RunAudit>(resolve => {
      this.pending = { onUpdate, resolve };
    });
  }

  cancel(requestId: string) {
    this.cancelled.push(requestId);
  }

  play(updates: CapabilityUpdate[]) {
    const run = this.pending;
    this.pending = undefined;
    updates.forEach(update => run?.onUpdate(update));
    run?.resolve({
      events: updates.length,
      terminalEvents: 1,
      outOfOrder: false,
    });
  }
}

const resultOf = (name: string): unknown => {
  const c = results.find((r: { name: string }) => r.name === name);
  return c.resultText ? parseStrictJson(c.resultText) : c.result;
};

function updatesOf(list: Array<Record<string, unknown>>): CapabilityUpdate[] {
  return list.map(e => {
    switch (e.type) {
      case 'completed':
        return {
          type: 'completed',
          output: resultOf(e.result as string),
          target: 'node',
          routingReason: 'EXPLICIT_NODE',
        };
      case 'failed':
        return { type: 'failed', failure: { code: e.code as string } };
      case 'progress':
        return {
          type: 'progress',
          stage: e.stage as string,
          fraction: e.fraction as number,
        };
      case 'partial':
        return { type: 'partial', delta: e.delta };
      default:
        return { type: e.type } as CapabilityUpdate;
    }
  });
}

function setup(fixture: OrganizeInput) {
  const gateway = new ScriptedGateway();
  const derivations = new MemoryDerivations();
  const details = new Map(detailsFor(fixture).map(d => [d.entry.id, d]));
  const reports: NodeRunReport[] = [];
  const controller = new OrganizeController({
    gateway,
    derivations,
    loadEntry: async entryId => details.get(entryId) ?? null,
    crypto: testOrganizeCrypto,
    randomHex: bytes => 'a'.repeat(bytes * 2),
    now: () => 1_760_000_000_000,
    onNodeRun: report => reports.push(report),
    context: { locale: fixture.locale, timeZone: fixture.timeZone },
  });
  const prepare = () =>
    controller.prepare(
      fixture.entries.map(e => e.entryId),
      fixture.kinds,
    );
  return { gateway, derivations, controller, reports, prepare };
}

it('rebuilds every fixture byte for byte from journal entries', () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const built = buildOrganizeRequest({
      selection: detailsFor(fixture),
      keyHex: testKeyHex,
      crypto: testOrganizeCrypto,
      kinds: fixture.kinds,
      context: { locale: fixture.locale, timeZone: fixture.timeZone },
    });
    expect([name, built.ok && canonicalJson(built.input)]).toEqual([
      name,
      canonicalJson(fixture),
    ]);
  }
});

it('sends nothing before consent, and nothing after declining', async () => {
  const { gateway, controller, prepare } = setup(fixtures.mixed);
  await prepare();
  expect(controller.getSnapshot()).toMatchObject({
    phase: 'consent',
    request: { included: fixtures.mixed.entries.map(e => e.entryId) },
  });
  expect(gateway.requests).toHaveLength(0);
  controller.reset();
  await controller.confirm();
  expect(gateway.requests).toHaveLength(0);
  expect(controller.getSnapshot()).toEqual({ phase: 'idle' });
});

it('sends the request through the SDK port: node only, 60 s, the exact input', async () => {
  const { gateway, controller, prepare } = setup(fixtures.mixed);
  await prepare();
  const running = controller.confirm();
  expect(gateway.requests).toEqual([
    {
      capability: 'journal.organize',
      version: '1.0.0',
      input: fixtures.mixed,
      execution: 'node',
      timeoutMs: 60_000,
      requestId: expect.stringMatching(/^org-[0-9a-f]{16}$/),
    },
  ]);
  gateway.play([{ type: 'cancelled' }]);
  await running;
});

describe('event vectors (§4)', () => {
  for (const c of events) {
    it(c.name, async () => {
      const fixture = fixtures[c.fixture ?? 'mixed'];
      const { gateway, derivations, controller, reports, prepare } =
        setup(fixture);
      await prepare();
      expect(controller.getSnapshot().phase).toBe('consent');
      if (c.expect.outcome === 'duplicate') {
        // Another run stored the identical request while this one ran.
        await derivations.saveValidated({
          input: fixture,
          inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(fixture)),
          output: resultOf('valid-mixed') as OrganizeOutput,
          createdAt: 1,
        });
      }
      const running = controller.confirm();
      gateway.play(updatesOf(c.events.filter((e: { type: string }) => e)));
      await running;
      const snapshot = controller.getSnapshot();
      if (snapshot.phase !== 'done') throw new Error(snapshot.phase);
      const { outcome } = snapshot;
      expect({
        outcome: outcome.kind,
        ...(outcome.kind === 'failed' ? { code: outcome.code } : {}),
        ...(outcome.kind === 'invalid'
          ? { code: 'INVALID_RESULT', subCode: outcome.subCode }
          : {}),
        partials: snapshot.partials,
        ...(snapshot.ignoredPartials
          ? { ignoredPartials: snapshot.ignoredPartials }
          : {}),
      }).toEqual(c.expect);
      // Only a valid, new result is stored; nothing else ever is.
      expect(derivations.stored.size).toBe(
        c.expect.outcome === 'stored' || c.expect.outcome === 'duplicate'
          ? 1
          : 0,
      );
      expect(reports).toHaveLength(1);
    });
  }
});

it('cancels through the SDK and waits for its terminal', async () => {
  const { gateway, controller, prepare } = setup(fixtures.voice);
  await prepare();
  const running = controller.confirm();
  controller.cancel();
  expect(controller.getSnapshot()).toMatchObject({
    phase: 'running',
    cancelling: true,
  });
  expect(gateway.cancelled).toEqual([gateway.requests[0].requestId]);
  gateway.play([{ type: 'cancelled' }]);
  await running;
  expect(controller.getSnapshot()).toMatchObject({
    phase: 'done',
    outcome: { kind: 'cancelled' },
  });
});

it('does not send an identical request that is already stored', async () => {
  const { gateway, derivations, controller, prepare } = setup(fixtures.mixed);
  await derivations.saveValidated({
    input: fixtures.mixed,
    inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(fixtures.mixed)),
    output: resultOf('valid-mixed') as OrganizeOutput,
    createdAt: 1,
  });
  await prepare();
  expect(controller.getSnapshot().phase).toBe('existing');
  expect(gateway.requests).toHaveLength(0);
});

it('reports node contact and link failures to the status hooks', async () => {
  const done = setup(fixtures.mixed);
  await done.prepare();
  let running = done.controller.confirm();
  done.gateway.play(updatesOf([{ type: 'completed', result: 'valid-mixed' }]));
  await running;
  expect(done.reports).toEqual([{ nodeResult: true, failureCode: undefined }]);

  const down = setup(fixtures.mixed);
  await down.prepare();
  running = down.controller.confirm();
  down.gateway.play([
    { type: 'failed', failure: { code: 'NODE_UNAVAILABLE' } },
  ]);
  await running;
  expect(down.reports).toEqual([
    { nodeResult: false, failureCode: 'NODE_UNAVAILABLE' },
  ]);
});

it('cancels a running organize when the journal locks', async () => {
  const { gateway, controller, derivations, prepare } = setup(fixtures.mixed);
  await prepare();
  const running = controller.confirm();
  controller.dispose();
  expect(gateway.cancelled).toHaveLength(1);
  gateway.play(updatesOf([{ type: 'completed', result: 'valid-mixed' }]));
  await running;
  expect(derivations.stored.size).toBe(0);
});
