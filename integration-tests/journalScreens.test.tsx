import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';

import {
  DiaryScreen,
  TIMELINE_PAGE,
} from '../src/features/journal/ui/DiaryScreen';
import { EntryDetailScreen } from '../src/features/journal/ui/EntryDetailScreen';
import { RecordingScreen } from '../src/features/journal/ui/RecordingScreen';
import { WriteEntryScreen } from '../src/features/journal/ui/WriteEntryScreen';
import {
  FakePlaybackService,
  journalHarness,
  settle,
} from '../test/journal/renderJournal';
import { readyVoiceEntry } from '../test/sqlite/journalFixtures';

// Journal screens against real SQLite and a scripted recorder. Assertions use
// test IDs and user-visible copy; no screen reads storage adapters directly.

const noop = () => undefined;
type Harness = Awaited<ReturnType<typeof journalHarness>>;
let harness: Harness;

afterEach(async () => {
  await harness.close();
});

describe('Diary and written entries', () => {
  it('starts empty, saves a written entry exactly, and lists it', async () => {
    harness = await journalHarness();
    const onSaved = jest.fn();
    const view = await harness.render(
      <>
        <WriteEntryScreen onSaved={onSaved} onCancel={noop} />
        <DiaryScreen onRecord={noop} onWrite={noop} onOpenEntry={noop} />
      </>,
    );
    expect(await view.findByTestId('diary-empty')).toBeTruthy();

    const text = 'Walked by the river.\n\nThe light was  gold.';
    await fireEvent.changeText(view.getByTestId('write-text'), text);
    await fireEvent.changeText(view.getByTestId('write-title'), 'Evening');
    await fireEvent.press(view.getByTestId('write-save'));
    await settle();

    const entryId = onSaved.mock.calls[0][0];
    expect(
      (await harness.context.journal.getEntry(entryId))?.entry.sourceText,
    ).toBe(text);
    expect(await view.findByTestId(`entry-row-${entryId}`)).toBeTruthy();
    expect(view.getByText('Evening')).toBeTruthy();
    expect(view.queryByTestId('diary-empty')).toBeNull();
  });

  it('keeps the text and explains when an entry cannot be saved', async () => {
    harness = await journalHarness();
    const view = await harness.render(
      <WriteEntryScreen onSaved={noop} onCancel={noop} />,
    );
    await fireEvent.press(view.getByTestId('write-save'));
    expect(view.getByTestId('write-message')).toHaveTextContent(
      'Write something to save.',
    );
    jest
      .spyOn(harness.context.journal, 'createWritten')
      .mockRejectedValueOnce(new Error('disk'));
    await fireEvent.changeText(view.getByTestId('write-text'), 'keep me');
    await fireEvent.press(view.getByTestId('write-save'));
    await settle();
    expect(view.getByTestId('write-message')).toHaveTextContent(
      /Your text is still here\.$/,
    );
    expect(view.getByTestId('write-text').props.value).toBe('keep me');
  });

  it('pages older entries from the last row with a keyset cursor', async () => {
    harness = await journalHarness();
    const ids: string[] = [];
    for (let index = 0; index < TIMELINE_PAGE + 5; index += 1) {
      const id = harness.context.ids.next('ent');
      ids.push(id);
      await harness.context.journal.createWritten({
        id,
        text: `entry ${index}`,
        createdAt: 1_760_000_000_000 + index * 60_000,
      });
    }
    const list = jest.spyOn(harness.context.journal, 'listTimeline');
    const view = await harness.render(
      <DiaryScreen onRecord={noop} onWrite={noop} onOpenEntry={noop} />,
    );
    await fireEvent.press(await view.findByTestId('diary-older'));
    await settle();
    // Newest first: the 50th row is ids[5]; the older page holds the rest.
    expect(list.mock.calls[1][0]).toEqual({
      limit: TIMELINE_PAGE,
      before: { createdAt: 1_760_000_000_000 + 5 * 60_000, id: ids[5] },
    });
    expect(await list.mock.results[1].value).toHaveLength(5);
    expect(view.queryByTestId('diary-older')).toBeNull();
  });

  it('flags entries that need attention with text, not color alone', async () => {
    harness = await journalHarness();
    const entryId = harness.context.ids.next('ent');
    const recordingId = harness.context.ids.next('rec');
    await harness.context.journal.createVoiceDraft({
      entryId,
      recordingId,
      startedAt: 1,
    });
    await harness.context.journal.applyReconciliation(
      [{ type: 'mark_failed', recordingId, entryId, cause: 'NO_AUDIO' }],
      2,
    );
    const view = await harness.render(
      <DiaryScreen onRecord={noop} onWrite={noop} onOpenEntry={noop} />,
    );
    expect(await view.findByText('Needs attention')).toBeTruthy();
    expect(
      view.getByTestId(`entry-row-${entryId}`).props.accessibilityLabel,
    ).toMatch(/needs attention$/);
  });
});

describe('entry detail', () => {
  it('shows voice source first and labels user corrections', async () => {
    harness = await journalHarness();
    const { entryId, recordingId } = await readyVoiceEntry(
      harness.context,
      8_000,
    );
    await harness.context.transcripts.saveEngineRevision({
      recordingId,
      modelId: 'base.en-q5_1',
      segments: [
        { startMs: 0, endMs: 3_000, text: 'helo there' },
        { startMs: 3_000, endMs: 7_000, text: 'second thought' },
      ],
      createdAt: 1,
    });
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    expect(await view.findByText('helo there')).toBeTruthy();
    expect(view.getByTestId('entry-recording')).toHaveTextContent(
      'Voice · 0:08 · Saved on this device',
    );

    await fireEvent.press(view.getByTestId('transcript-text-0'));
    await fireEvent.changeText(
      view.getByTestId('transcript-edit-0'),
      'hello there',
    );
    await fireEvent.press(view.getByTestId('transcript-save-0'));
    await settle();

    expect(await view.findByText('hello there')).toBeTruthy();
    expect(view.getByText('Edited by you')).toBeTruthy();
    // The engine row and the recording are untouched (append-only history).
    const records = await harness.context.transcripts.records(recordingId);
    expect(
      records.find(r => r.source === 'engine' && r.ordinal === 0)?.text,
    ).toBe('helo there');
    expect(
      (await harness.context.journal.getEntry(entryId))?.recording?.durationMs,
    ).toBe(8_000);
  });

  it('shows the written source exactly as saved', async () => {
    harness = await journalHarness();
    const id = harness.context.ids.next('ent');
    const text = '  indented\nsecond line  ';
    await harness.context.journal.createWritten({ id, text, createdAt: 5 });
    const view = await harness.render(<EntryDetailScreen entryId={id} />);
    expect((await view.findByTestId('entry-source-text')).props.children).toBe(
      text,
    );
  });

  it('says so when no transcript exists yet', async () => {
    harness = await journalHarness();
    const { entryId } = await readyVoiceEntry(harness.context, 2_000);
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    expect(await view.findByTestId('transcript-none')).toBeTruthy();
  });

  it('plays through the native port when available', async () => {
    const playback = new FakePlaybackService();
    harness = await journalHarness({ playback });
    const { entryId, recordingId } = await readyVoiceEntry(
      harness.context,
      5_000,
    );
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    await fireEvent.press(await view.findByTestId('entry-play'));
    expect(playback.calls).toEqual([`play ${recordingId} 0`]);
    await act(async () =>
      playback.listener?.({ type: 'position', positionMs: 2_000 }),
    );
    expect(view.getByTestId('entry-position')).toHaveTextContent('0:02 / 0:05');
    await act(async () =>
      playback.listener?.({ type: 'failed', code: 'SOURCE_DAMAGED' }),
    );
    expect(view.getByText(/could not be played/)).toBeTruthy();
  });

  it('hides playback until the native player exists', async () => {
    harness = await journalHarness();
    const { entryId } = await readyVoiceEntry(harness.context, 5_000);
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    expect(await view.findByTestId('entry-recording')).toBeTruthy();
    expect(view.queryByTestId('entry-play')).toBeNull();
  });
});

describe('recording screen', () => {
  it('records, pauses, resumes, finishes, and opens the saved entry', async () => {
    harness = await journalHarness();
    const onOpenEntry = jest.fn();
    const view = await harness.render(
      <RecordingScreen
        onDone={noop}
        onOpenEntry={onOpenEntry}
        onWriteInstead={noop}
      />,
    );
    await settle();
    expect(view.getByTestId('recording-status')).toHaveTextContent(
      'Recording · Saved on this device',
    );
    await act(async () => harness.recorder.capture(2_000, 0.4));
    expect(view.getByTestId('recording-timer')).toHaveTextContent('0:02');
    expect(view.getByLabelText('Input level 40 percent')).toBeTruthy();

    await fireEvent.press(view.getByTestId('recording-pause'));
    await settle();
    expect(view.getByTestId('recording-status')).toHaveTextContent('Paused.');
    await fireEvent.press(view.getByTestId('recording-resume'));
    await settle();
    await act(async () => harness.recorder.capture(1_500));
    await fireEvent.press(view.getByTestId('recording-finish'));
    await settle();

    expect(view.getByTestId('recording-status')).toHaveTextContent(
      'Saved on this device · 0:03',
    );
    await fireEvent.press(view.getByTestId('recording-open-entry'));
    const entryId = onOpenEntry.mock.calls[0][0];
    expect(
      (await harness.context.journal.getEntry(entryId))?.recording?.state,
    ).toBe('ready');
  });

  it('explains an automatic pause for a call', async () => {
    harness = await journalHarness();
    const view = await harness.render(
      <RecordingScreen
        onDone={noop}
        onOpenEntry={noop}
        onWriteInstead={noop}
      />,
    );
    await settle();
    await act(async () =>
      harness.recorder.emit({ type: 'paused', reason: 'audio_focus_lost' }),
    );
    expect(view.getByTestId('recording-status')).toHaveTextContent(
      /^Paused for a call or another app\./,
    );
    expect(view.getByTestId('recording-resume')).toBeTruthy();
  });

  it('discards only after a second, explicit confirmation', async () => {
    harness = await journalHarness();
    const view = await harness.render(
      <RecordingScreen
        onDone={noop}
        onOpenEntry={noop}
        onWriteInstead={noop}
      />,
    );
    await settle();
    await act(async () => harness.recorder.capture(1_000));
    await fireEvent.press(view.getByTestId('recording-discard'));
    await fireEvent.press(view.getByTestId('discard-confirm-no'));
    expect(view.getByTestId('recording-status')).toHaveTextContent(
      'Recording · Saved on this device',
    );
    await fireEvent.press(view.getByTestId('recording-discard'));
    await fireEvent.press(view.getByTestId('discard-confirm-yes'));
    await settle();
    expect(view.getByTestId('recording-status')).toHaveTextContent(
      'Recording discarded.',
    );
    expect(harness.recorder.files.size).toBe(0);
  });

  it('offers a written entry when the microphone is denied', async () => {
    harness = await journalHarness();
    harness.recorder.refusal = 'MICROPHONE_DENIED';
    const onWriteInstead = jest.fn();
    const view = await harness.render(
      <RecordingScreen
        onDone={noop}
        onOpenEntry={noop}
        onWriteInstead={onWriteInstead}
      />,
    );
    await settle();
    expect(view.getByTestId('recording-status')).toHaveTextContent(
      /^Microphone access is off\./,
    );
    await fireEvent.press(view.getByTestId('recording-write-instead'));
    expect(onWriteInstead).toHaveBeenCalled();
  });

  it('refuses to start without space and records nothing', async () => {
    harness = await journalHarness();
    harness.recorder.free = 1024;
    const view = await harness.render(
      <RecordingScreen
        onDone={noop}
        onOpenEntry={noop}
        onWriteInstead={noop}
      />,
    );
    await settle();
    expect(view.getByTestId('recording-status')).toHaveTextContent(
      /not enough free space to record safely/,
    );
    expect(harness.recorder.calls).toEqual([]);
  });
});
