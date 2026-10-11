import { act, fireEvent } from '@testing-library/react-native';

import {
  canonicalJson,
  type OrganizeInput,
  type OrganizeOutput,
} from '../src/features/organize/domain/contract';
import { FakeHybridAiGateway, pairedRecord } from '../test/FakeHybridAiGateway';
import type { TestJournal } from '../test/makeTestServices';
import { testOrganizeCrypto } from '../test/organizeCrypto';
import { flush, renderUnlocked } from '../test/renderApp';

// The minimum organize surface in the real app shell (AJ-2.1): consent before
// anything is sent, progress with counts only, cancel, the stored result, and
// the private-node status hooks. The SDK is the scripted gateway port.

const TEXT = 'I need to send the budget to Priya.\n\nCall Mom tonight.';

function resultFor(input: OrganizeInput): OrganizeOutput {
  const [entry] = input.entries;
  const unit = entry.units[0];
  const ref = {
    entryId: entry.entryId,
    unitId: unit.unitId,
    unitSha256: unit.sha256,
    charStart: 0,
    charEnd: unit.text.length,
  };
  return {
    contract: 'journal.organize@1',
    requestKey: input.requestKey,
    inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(input)),
    engine: { id: 'aj.rules', version: '1.0.0' },
    completeness: 'complete',
    summary: { text: 'Budget and a call.', sources: [ref] },
    sections: [{ area: 'work', items: [{ text: unit.text, sources: [ref] }] }],
    tasks: [
      {
        text: 'Send the budget to Priya',
        area: 'work',
        rule: 'task.need-to',
        sources: [ref],
      },
    ],
    ideas: [],
    people: [{ name: 'Priya', sources: [ref] }],
    projects: [],
  };
}

async function writtenEntryOpen(paired = true) {
  const gateway = new FakeHybridAiGateway();
  if (paired) {
    gateway.paired = [pairedRecord()];
    gateway.linkStatus = { state: 'connected', nodeId: pairedRecord().nodeId };
  }
  let journal: TestJournal | undefined;
  const { view } = await renderUnlocked(gateway, undefined, opened => {
    journal = opened;
  });
  await fireEvent.press(view.getByTestId('diary-write'));
  await fireEvent.changeText(await view.findByTestId('write-text'), TEXT);
  await fireEvent.press(view.getByTestId('write-save'));
  await view.findByTestId('organize-panel');
  await flush();
  return { view, gateway, journal: journal! };
}

const derivationCount = async (journal: TestJournal) =>
  (await journal.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM derivations',
  ))!.n;

it('asks consent, streams progress, and shows the stored result', async () => {
  const { view, gateway, journal } = await writtenEntryOpen();
  await fireEvent.press(view.getByTestId('organize-start'));
  const consent = await view.findByTestId('organize-consent');
  expect(consent).toHaveTextContent(/Study PC/);
  expect(view.getByTestId('organize-consent-text-only')).toHaveTextContent(
    /Audio never leaves this phone/,
  );
  // Nothing is sent before the user agrees.
  expect(gateway.calls.filter(call => call.startsWith('run'))).toEqual([]);

  await fireEvent.press(view.getByTestId('organize-confirm'));
  expect(gateway.lastRequest).toMatchObject({
    capability: 'journal.organize',
    version: '1.0.0',
    execution: 'node',
    timeoutMs: 60_000,
  });
  const input = gateway.lastRequest!.input as OrganizeInput;
  expect(input.entries[0].units.map(u => u.text)).toEqual([
    'I need to send the budget to Priya.',
    'Call Mom tonight.',
  ]);

  await act(async () => {
    gateway.emitRun({ type: 'accepted' });
    gateway.emitRun({ type: 'progress', stage: 'extracting', fraction: 0.5 });
    gateway.emitRun({ type: 'partial', delta: { counts: { tasks: 1 } } });
  });
  expect(view.getByTestId('organize-stage')).toHaveTextContent(
    'Finding tasks and ideas',
  );
  expect(view.getByTestId('organize-partial-counts')).toHaveTextContent(
    '1 task',
  );

  await act(async () => {
    gateway.emitRun({
      type: 'completed',
      output: resultFor(input),
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    });
  });
  await flush();
  await view.findByTestId('organize-stored');
  expect(view.getByTestId('organize-summary')).toHaveTextContent(
    'Budget and a call.',
  );
  expect(view.getByTestId('organize-task-0')).toHaveTextContent(
    '• Send the budget to Priya',
  );
  // The source entry is shown exactly as written.
  expect(view.getByTestId('entry-source-text').props.children).toBe(TEXT);
  expect(await derivationCount(journal)).toBe(1);
});

it('stores a partial result and discloses the omitted items', async () => {
  const { view, gateway, journal } = await writtenEntryOpen();
  await fireEvent.press(view.getByTestId('organize-start'));
  await fireEvent.press(await view.findByTestId('organize-confirm'));
  const output = resultFor(gateway.lastRequest!.input as OrganizeInput);
  output.completeness = 'partial';
  output.omitted = { tasks: 3, people: 1 };
  await act(async () => {
    gateway.emitRun({
      type: 'completed',
      output,
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    });
  });
  await flush();
  expect(await view.findByTestId('organize-stored')).toHaveTextContent(
    /the result is partial/,
  );
  expect(await view.findByTestId('organize-partial')).toHaveTextContent(
    'This result is partial. Some lower-ranked items were omitted to fit: 3 tasks, 1 person.',
  );
  const row = await journal.db.get<{ payload: string }>(
    'SELECT payload FROM derivations',
  );
  expect(JSON.parse(row!.payload)).toMatchObject({
    completeness: 'partial',
    omitted: { tasks: 3, people: 1 },
  });
});

it('cancels through the SDK and stores nothing', async () => {
  const { view, gateway, journal } = await writtenEntryOpen();
  await fireEvent.press(view.getByTestId('organize-start'));
  await fireEvent.press(await view.findByTestId('organize-confirm'));
  await fireEvent.press(await view.findByTestId('organize-cancel'));
  await flush();
  expect(gateway.calls).toContain('cancel');
  await view.findByTestId('organize-cancelled');
  expect(await derivationCount(journal)).toBe(0);
});

it('stores nothing for an invalid result and says so', async () => {
  const { view, gateway, journal } = await writtenEntryOpen();
  await fireEvent.press(view.getByTestId('organize-start'));
  await fireEvent.press(await view.findByTestId('organize-confirm'));
  const output = resultFor(gateway.lastRequest!.input as OrganizeInput);
  output.inputSha256 = '0'.repeat(64);
  await act(async () => {
    gateway.emitRun({
      type: 'completed',
      output,
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    });
  });
  await flush();
  await view.findByTestId('organize-invalid');
  expect(await derivationCount(journal)).toBe(0);
});

it('reconciles the link once after a node link failure', async () => {
  const { view, gateway } = await writtenEntryOpen();
  const connects = () => gateway.calls.filter(c => c === 'connect').length;
  const before = connects();
  await fireEvent.press(view.getByTestId('organize-start'));
  await fireEvent.press(await view.findByTestId('organize-confirm'));
  await act(async () => {
    gateway.emitRun({
      type: 'failed',
      failure: { code: 'NODE_UNAVAILABLE' },
    });
  });
  await flush();
  await view.findByTestId('organize-failed');
  expect(connects()).toBe(before + 1);
  // The request itself is never retried.
  expect(gateway.calls.filter(c => c.startsWith('run'))).toHaveLength(1);
});

it('offers nothing to send without a paired node', async () => {
  const { view, gateway } = await writtenEntryOpen(false);
  expect(view.getByTestId('organize-unavailable')).toBeTruthy();
  await fireEvent.press(view.getByTestId('organize-start'));
  await flush();
  expect(view.queryByTestId('organize-consent')).toBeNull();
  expect(gateway.calls.filter(c => c.startsWith('run'))).toEqual([]);
});
