import { act, fireEvent } from '@testing-library/react-native';

import {
  canonicalJson,
  type OrganizeInput,
  type OrganizeOutput,
  type OrganizeTask,
  type SourceRef,
} from '../src/features/organize/domain/contract';
import { deriveDue } from '../src/features/organize/domain/dueDates';
import { FakeHybridAiGateway, pairedRecord } from '../test/FakeHybridAiGateway';
import type { TestJournal } from '../test/makeTestServices';
import { testOrganizeCrypto } from '../test/organizeCrypto';
import { flush, renderUnlocked, tab } from '../test/renderApp';
import { readyVoiceEntry } from '../test/sqlite/journalFixtures';

// AJ-2.2 in the app shell (UX §7, ADR-019 A2, ADR-020): due-date groups and
// task transitions; stale marks, the originally cited text, explicit
// Reorganize with consent, conservative carry-over, and history.

const CREATED = Date.parse('2026-10-10T12:00:00.000Z'); // a Saturday
const TODAY = Date.parse('2026-10-11T12:00:00.000Z');

function connected() {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  gateway.linkStatus = { state: 'connected', nodeId: pairedRecord().nodeId };
  return gateway;
}

function cite(input: OrganizeInput, phrase: string): SourceRef {
  for (const entry of input.entries) {
    for (const unit of entry.units) {
      const at = unit.text.indexOf(phrase);
      if (at < 0) continue;
      const u = unit as typeof unit & { startMs?: number; endMs?: number };
      return {
        entryId: entry.entryId,
        unitId: unit.unitId,
        unitSha256: unit.sha256,
        charStart: at,
        charEnd: at + phrase.length,
        ...(entry.kind === 'voice'
          ? { audioStartMs: u.startMs, audioEndMs: u.endMs }
          : {}),
      };
    }
  }
  throw new Error(`no "${phrase}"`);
}

/** A task citing its sentence, dated by the app's own §3.3 derivation. */
function task(input: OrganizeInput, sentence: string, phrase?: string) {
  const sources = [cite(input, sentence)];
  const result: OrganizeTask = { text: sentence, area: 'unsorted', sources };
  if (phrase) {
    const source = cite(input, phrase);
    const entry = input.entries.find(e => e.entryId === source.entryId)!;
    const unit = entry.units.find(u => u.unitId === source.unitId)!;
    const due = deriveDue(
      unit.text,
      source.charStart,
      source.charEnd,
      entry.createdAt,
      input.timeZone,
    )!;
    result.due = { ...due, source };
  }
  return result;
}

function output(
  input: OrganizeInput,
  tasks: OrganizeTask[],
  summary: string,
): OrganizeOutput {
  return {
    contract: 'journal.organize@1',
    requestKey: input.requestKey,
    inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(input)),
    engine: { id: 'aj.rules', version: '1.0.0' },
    completeness: 'complete',
    summary: { text: 'A short day.', sources: [cite(input, summary)] },
    sections: [],
    tasks,
    ideas: [],
    people: [],
    projects: [],
  };
}

/** Confirms the consent sheet and answers the run with `result`. */
async function answer(
  view: Awaited<ReturnType<typeof renderUnlocked>>['view'],
  gateway: FakeHybridAiGateway,
  result: (input: OrganizeInput) => OrganizeOutput,
) {
  await fireEvent.press(await view.findByTestId('organize-confirm'));
  await act(async () => {
    gateway.emitRun({
      type: 'completed',
      output: result(gateway.lastRequest!.input as OrganizeInput),
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    });
  });
  await flush();
  await view.findByTestId('organize-stored');
  await fireEvent.press(view.getByTestId('organize-done'));
}

it('groups tasks by due date and moves them through done, dismissed, and restore', async () => {
  const gateway = connected();
  let entryId = '';
  const { view } = await renderUnlocked(
    gateway,
    undefined,
    async (journal: TestJournal) => {
      if (entryId) return;
      entryId = (
        await journal.journal.createWritten({
          id: journal.ids.next('ent'),
          text: 'Pay the rent today.\n\nCall the bank tomorrow.\n\nSend the invoice by Friday.\n\nBook the hall for 14 November.\n\nWater the plants.',
          createdAt: CREATED,
        })
      ).id;
    },
    undefined,
    () => TODAY,
  );
  await fireEvent.press(await view.findByTestId(`entry-row-${entryId}`));
  await fireEvent.press(await view.findByTestId('organize-start'));
  await answer(view, gateway, input =>
    output(
      input,
      [
        task(input, 'Pay the rent today.', 'today'),
        task(input, 'Call the bank tomorrow.', 'tomorrow'),
        task(input, 'Send the invoice by Friday.', 'Friday'),
        task(input, 'Book the hall for 14 November.', '14 November'),
        task(input, 'Water the plants.'),
      ],
      'Pay the rent today.',
    ),
  );

  await fireEvent.press(tab(view, 'Tasks'));
  await view.findByTestId('tasks-screen');
  await flush();
  const text = (id: string) => view.getByTestId(id).props.children;
  expect(text('task-overdue-0-text')).toBe('Pay the rent today.');
  expect(text('task-overdue-0-meta')).toBe('Overdue · Sat 10 Oct 2026');
  expect(text('task-today-0-text')).toBe('Call the bank tomorrow.');
  expect(text('task-today-0-meta')).toBe('Due today');
  expect(text('task-upcoming-0-meta')).toBe('Due Fri 16 Oct 2026');
  expect(text('task-upcoming-1-meta')).toBe('Due Sat 14 Nov 2026');
  expect(text('task-undated-0-text')).toBe('Water the plants.');

  await fireEvent.press(view.getByTestId('task-today-0-done'));
  await flush();
  expect(view.queryByTestId('tasks-group-today')).toBeNull();
  expect(text('task-done-0-text')).toBe('Call the bank tomorrow.');
  await fireEvent.press(view.getByTestId('task-done-0-restore'));
  await flush();
  expect(text('task-today-0-text')).toBe('Call the bank tomorrow.');
  await fireEvent.press(view.getByTestId('task-undated-0-dismiss'));
  await flush();
  expect(text('task-dismissed-0-text')).toBe('Water the plants.');

  // A task's source names its entry's moment and opens it at the sentence.
  expect(view.getByTestId('task-upcoming-0-source')).toHaveTextContent(
    /^Source · Oct 10, .+ · paragraph 3$/,
  );
  await fireEvent.press(view.getByTestId('task-upcoming-0-source'));
  expect(await view.findByTestId('cited-text')).toHaveTextContent(
    /Send the invoice by Friday\./,
  );
});

it('marks stale items, keeps the cited text, reorganizes with consent, carries state, and keeps history', async () => {
  const gateway = connected();
  let voice: { entryId: string; recordingId: string } | undefined;
  const { view } = await renderUnlocked(
    gateway,
    undefined,
    async (journal: TestJournal) => {
      if (voice) return;
      voice = await readyVoiceEntry(journal, 8_500);
      await journal.transcripts.saveEngineRevision({
        recordingId: voice.recordingId,
        modelId: 'base.en-q5_1',
        segments: [
          { startMs: 0, endMs: 4_000, text: 'Book the dentist.' },
          { startMs: 4_000, endMs: 8_000, text: 'Plan the trip.' },
        ],
        createdAt: 2,
      });
    },
    undefined,
    () => TODAY,
  );
  const organizeDentist = (input: OrganizeInput) =>
    output(input, [task(input, 'Book the dentist')], 'Book the dentist');

  await fireEvent.press(await view.findByTestId(`entry-row-${voice!.entryId}`));
  await fireEvent.press(await view.findByTestId('organize-start'));
  await answer(view, gateway, organizeDentist);

  // Dismiss the task, then correct its transcript line in the entry.
  await fireEvent.press(tab(view, 'Tasks'));
  await fireEvent.press(await view.findByTestId('task-undated-0-dismiss'));
  await flush();
  await fireEvent.press(tab(view, 'Diary'));
  await fireEvent.press(await view.findByTestId('transcript-text-0'));
  await fireEvent.changeText(
    view.getByTestId('transcript-edit-0'),
    'Book the dentist on Monday.',
  );
  await fireEvent.press(view.getByTestId('transcript-save-0'));
  await flush();

  // The Organized view marks what changed, and hides nothing.
  await fireEvent.press(tab(view, 'Organized'));
  await view.findByTestId('organized-0-stale');
  expect(view.getByTestId('organized-0-stale-task-0')).toHaveTextContent(
    'Source changed since organized',
  );
  expect(view.getByTestId('organized-0-item-task-0')).toHaveTextContent(
    '• Book the dentist',
  );
  // The source still opens as cited, labelled as edited since.
  await fireEvent.press(view.getByTestId('organized-0-source-task-0'));
  await view.findByTestId('cited-edited');
  expect(view.getByTestId('cited-text')).toHaveTextContent(/Book the dentist/);
  expect(view.getByTestId('cited-now')).toHaveTextContent(
    /Book the dentist on Monday\./,
  );
  await fireEvent.press(tab(view, 'Organized'));

  // Reorganize is explicit and asks for consent again.
  const runs = gateway.calls.filter(c => c.startsWith('run')).length;
  await fireEvent.press(await view.findByTestId('organized-0-reorganize'));
  await view.findByTestId('organize-consent');
  expect(gateway.calls.filter(c => c.startsWith('run'))).toHaveLength(runs);
  await answer(view, gateway, organizeDentist);
  await flush();
  expect(view.queryByTestId('organized-0-stale')).toBeNull();
  expect(view.getByTestId('organized-0-scope')).toHaveTextContent(/revision 2/);

  // History keeps both revisions; the first stays marked stale.
  await fireEvent.press(view.getByTestId('organized-0-history'));
  await view.findByTestId('history-revision-2');
  expect(view.getByTestId('history-revision-1-stale')).toBeTruthy();

  // The dismissed state carried through the correction lineage.
  await fireEvent.press(tab(view, 'Tasks'));
  await flush();
  expect(view.getByTestId('task-dismissed-0-text')).toHaveTextContent(
    'Book the dentist',
  );
  expect(view.getByTestId('task-dismissed-0-meta')).toHaveTextContent(
    /kept from earlier/,
  );
});

it('never shows a wrong excerpt for a written paragraph that no longer matches its citation', async () => {
  const gateway = connected();
  let journal: TestJournal | undefined;
  let entryId = '';
  const { view } = await renderUnlocked(
    gateway,
    undefined,
    async (opened: TestJournal) => {
      journal = opened;
      if (entryId) return;
      entryId = (
        await opened.journal.createWritten({
          id: opened.ids.next('ent'),
          text: 'Call the bank today.',
          createdAt: CREATED,
        })
      ).id;
    },
    undefined,
    () => TODAY,
  );
  await fireEvent.press(await view.findByTestId(`entry-row-${entryId}`));
  await fireEvent.press(await view.findByTestId('organize-start'));
  await answer(view, gateway, input =>
    output(input, [task(input, 'Call the bank')], 'Call the bank'),
  );
  // Written text cannot be edited in v1; this stands in for a later edit.
  await journal!.db.run(
    'UPDATE journal_entries SET source_text = ? WHERE id = ?',
    ['Pay the gym tomorrow.', entryId],
  );

  await fireEvent.press(tab(view, 'Tasks'));
  await view.findByTestId('task-undated-0-stale');
  await fireEvent.press(view.getByTestId('task-undated-0-source'));
  expect(await view.findByTestId('cited-edited')).toHaveTextContent(
    /no longer reads as cited/,
  );
  expect(view.queryByTestId('cited-text')).toBeNull();
  expect(view.queryByTestId('cited-missing')).toBeNull();
});
