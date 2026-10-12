import { act, fireEvent } from '@testing-library/react-native';

import {
  canonicalJson,
  type OrganizeInput,
} from '../src/features/organize/domain/contract';
import { FakeHybridAiGateway, pairedRecord } from '../test/FakeHybridAiGateway';
import type { TestJournal } from '../test/makeTestServices';
import { testOrganizeCrypto } from '../test/organizeCrypto';
import { flush, renderUnlocked, tab } from '../test/renderApp';

// The developer organize benchmark in the app shell: typed refusals send
// nothing, a measured run goes through the gateway port, and rehearsed
// persistence leaves the journal untouched.

async function openBench() {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  gateway.linkStatus = { state: 'connected', nodeId: pairedRecord().nodeId };
  let journal: TestJournal | undefined;
  const { view } = await renderUnlocked(gateway, undefined, opened => {
    journal = opened;
  });
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await fireEvent.press(tab(view, 'Settings'));
  await fireEvent.press(await view.findByTestId('open-diagnostics'));
  await fireEvent.press(await view.findByTestId('open-organize-bench'));
  await view.findByTestId('bench-status');
  await fireEvent.changeText(view.getByTestId('bench-count'), '1');
  return { view, gateway, journal: journal!, log };
}

const lines = (log: jest.SpyInstance, kind: string) =>
  log.mock.calls
    .map(([text]) => String(text))
    .filter(text => text.startsWith(`${kind} `))
    .map(text => JSON.parse(text.slice(kind.length + 1)));

afterEach(() => jest.restoreAllMocks());

it('refuses the 60-minute fixture with a typed reason and sends nothing', async () => {
  const { view, gateway, log } = await openBench();
  await fireEvent.press(view.getByTestId('bench-run-v60m'));
  await flush();
  expect(view.getByTestId('bench-status')).toHaveTextContent('done v60m');
  expect(lines(log, 'AJ_ORGANIZE_PERF')).toMatchObject([
    { scenario: 'v60m', outcome: 'refused', code: 'TOO_MANY_UNITS' },
  ]);
  expect(gateway.calls.filter(c => c.startsWith('run'))).toEqual([]);
});

it('measures a run and rehearses persistence without keeping it', async () => {
  const { view, gateway, journal, log } = await openBench();
  await fireEvent.press(view.getByTestId('bench-run-v30s'));
  await flush();
  const input = gateway.lastRequest!.input as OrganizeInput;
  const entry = input.entries[0];
  const unit = entry
    .units[0] as OrganizeInput['entries'][number]['units'][number] & {
    startMs: number;
    endMs: number;
  };
  const ref = {
    entryId: entry.entryId,
    unitId: unit.unitId,
    unitSha256: unit.sha256,
    charStart: 0,
    charEnd: unit.text.length,
    audioStartMs: unit.startMs,
    audioEndMs: unit.endMs,
  };
  await act(async () => {
    gateway.emitRun({ type: 'accepted' });
    gateway.emitRun({ type: 'progress', stage: 'received', fraction: 0.1 });
    gateway.emitRun({
      type: 'completed',
      output: {
        contract: 'journal.organize@1',
        requestKey: input.requestKey,
        inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(input)),
        engine: { id: 'aj.rules', version: '1.0.0' },
        completeness: 'complete',
        summary: { text: 'A short day.', sources: [ref] },
        sections: [],
        tasks: [{ text: 'Call Priya', area: 'work', sources: [ref] }],
        ideas: [],
        people: [],
        projects: [],
      },
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    });
  });
  await flush();
  await flush();
  expect(view.getByTestId('bench-status')).toHaveTextContent('done v30s');
  const [sample] = lines(log, 'AJ_ORGANIZE_PERF');
  expect(sample).toMatchObject({
    scenario: 'v30s',
    outcome: 'rehearsed',
    words: 70,
    inputBytes: expect.any(Number),
  });
  for (const key of ['acceptedMs', 'terminalMs', 'validateMs', 'persistMs']) {
    expect([key, typeof sample[key]]).toEqual([key, 'number']);
  }
  // The rehearsal rolled back: no derivation, task, or reference is kept.
  for (const table of ['derivations', 'derived_tasks', 'source_references']) {
    const row = await journal.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    expect([table, row!.n]).toEqual([table, 0]);
  }
  // No journal text reaches the log: samples carry sizes and timings only.
  expect(JSON.stringify(log.mock.calls)).not.toContain(unit.text);
});
