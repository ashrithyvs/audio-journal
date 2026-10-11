import { act, fireEvent } from '@testing-library/react-native';

import type {
  PlaybackEvent,
  PlaybackService,
} from '../src/features/journal/ports/PlaybackService';
import {
  canonicalJson,
  type OrganizeInput,
  type SourceRef,
} from '../src/features/organize/domain/contract';
import { FakeHybridAiGateway, pairedRecord } from '../test/FakeHybridAiGateway';
import type { TestJournal } from '../test/makeTestServices';
import { testOrganizeCrypto } from '../test/organizeCrypto';
import { flush, renderUnlocked } from '../test/renderApp';
import { readyVoiceEntry } from '../test/sqlite/journalFixtures';

// From an organized item back to its evidence (contract §3.1, UX §7,
// AJ-FR-025): a voice entry's task opens the entry at the cited transcript
// line and plays exactly the cited audio range.

class RangePlayback implements PlaybackService {
  readonly plays: Array<{
    recordingId: string;
    startMs: number;
    endMs?: number;
  }> = [];
  listener?: (event: PlaybackEvent) => void;
  async play(
    recordingId: string,
    range: { startMs: number; endMs?: number },
    onEvent: (event: PlaybackEvent) => void,
  ) {
    this.plays.push({ recordingId, ...range });
    this.listener = onEvent;
  }
  async pause() {}
  async stop() {}
}

async function voiceEntryOrganized() {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  gateway.linkStatus = { state: 'connected', nodeId: pairedRecord().nodeId };
  const playback = new RangePlayback();
  let seeded: { entryId: string; recordingId: string } | undefined;
  const { view } = await renderUnlocked(
    gateway,
    undefined,
    async (journal: TestJournal) => {
      if (seeded) return;
      seeded = await readyVoiceEntry(journal, 12_000);
      await journal.transcripts.saveEngineRevision({
        recordingId: seeded.recordingId,
        modelId: 'base.en-q5_1',
        segments: [
          { startMs: 0, endMs: 4_000, text: 'Morning walk by the river.' },
          {
            startMs: 4_000,
            endMs: 8_500,
            text: 'I need to call the plumber about the leak.',
          },
        ],
        createdAt: 2,
      });
    },
    playback,
  );
  await fireEvent.press(
    await view.findByTestId(`entry-row-${seeded!.entryId}`),
  );
  await view.findByTestId('organize-panel');
  await fireEvent.press(view.getByTestId('organize-start'));
  await fireEvent.press(await view.findByTestId('organize-confirm'));
  const input = gateway.lastRequest!.input as OrganizeInput;
  const entry = input.entries[0];
  const unit = entry.units[1] as (typeof entry.units)[number] & {
    startMs: number;
    endMs: number;
  };
  const source: SourceRef = {
    entryId: entry.entryId,
    unitId: unit.unitId,
    unitSha256: unit.sha256,
    charStart: 10,
    charEnd: unit.text.length - 1,
    audioStartMs: unit.startMs,
    audioEndMs: unit.endMs,
  };
  await act(async () => {
    gateway.emitRun({
      type: 'completed',
      output: {
        contract: 'journal.organize@1',
        requestKey: input.requestKey,
        inputSha256: testOrganizeCrypto.sha256Hex(canonicalJson(input)),
        engine: { id: 'aj.rules', version: '1.0.0' },
        completeness: 'complete',
        summary: { text: 'A walk and a chore.', sources: [source] },
        sections: [],
        tasks: [
          {
            text: 'Call the plumber about the leak',
            area: 'personal',
            sources: [source],
          },
        ],
        ideas: [],
        people: [],
        projects: [],
      },
      target: 'node',
      routingReason: 'EXPLICIT_NODE',
    });
  });
  await flush();
  await view.findByTestId('organize-stored');
  return { view, playback, seeded: seeded!, unit };
}

it('opens the cited transcript line and plays exactly the cited audio range', async () => {
  const { view, playback, seeded, unit } = await voiceEntryOrganized();
  const link = view.getByTestId('organize-task-0-source');
  expect(link).toHaveTextContent('Source · 0:04–0:08');
  await fireEvent.press(link);

  expect(await view.findByTestId('cited-source')).toBeTruthy();
  expect(view.getByTestId('cited-range')).toHaveTextContent('0:04–0:08');
  expect(view.getByTestId('cited-text')).toHaveTextContent(
    unit.text.slice(10, unit.text.length - 1),
  );
  expect(view.getByTestId('transcript-cited')).toHaveTextContent(
    `0:04${unit.text}`,
  );

  await fireEvent.press(view.getByTestId('cited-play'));
  expect(playback.plays).toEqual([
    { recordingId: seeded.recordingId, startMs: 4_000, endMs: 8_500 },
  ]);
  await act(async () => {
    playback.listener?.({ type: 'position', positionMs: 6_000 });
  });
  expect(view.getByTestId('cited-state')).toHaveTextContent('0:06');
  await act(async () => {
    playback.listener?.({ type: 'ended' });
  });
  expect(view.getByTestId('cited-state')).toHaveTextContent('Played');
});
