import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';

import { RecordingScreen } from '../src/features/journal/ui/RecordingScreen';
import { FakeLiveTranscriber } from '../test/journal/FakeLiveTranscriber';
import { FakeRecordingTranscriber } from '../test/journal/FakeRecordingTranscriber';
import { journalHarness, settle } from '../test/journal/renderJournal';

// Live text while recording, then the final pass (ADR-017), end to end over
// real SQLite with scripted native parts.

const noop = () => undefined;

it('shows live text, stores it, and replaces it with the final pass', async () => {
  const live = new FakeLiveTranscriber();
  const engine = new FakeRecordingTranscriber();
  const harness = await journalHarness({ live, transcriber: engine });
  const view = await harness.render(
    <RecordingScreen onDone={noop} onOpenEntry={noop} onWriteInstead={noop} />,
  );
  await settle();
  expect(live.attached).toBe(true);
  expect(view.getByTestId('live-transcript')).toHaveTextContent(
    /after a few seconds/,
  );

  await act(async () => harness.recorder.capture(4_000));
  await act(async () =>
    live.emit({
      startMs: 0,
      endMs: 4_000,
      segments: [{ t0Ms: 0, t1Ms: 3_500, text: 'Dear diary, today' }],
    }),
  );
  expect(view.getByTestId('live-transcript-text')).toHaveTextContent(
    'Dear diary, today',
  );

  await fireEvent.press(view.getByTestId('recording-finish'));
  await settle();
  await settle();
  expect(live.attached).toBe(false);
  // Live text was stored before the final pass began.
  const recordingId = engine.calls[0]?.replace('transcribe ', '');
  expect(recordingId).toMatch(/^rec_/);
  const stored = await harness.context.transcripts.records(recordingId!);
  expect(stored).toEqual([
    expect.objectContaining({
      state: 'provisional',
      text: 'Dear diary, today',
    }),
  ]);

  await act(async () =>
    engine.complete({
      segments: [{ t0Ms: 0, t1Ms: 3_900, text: 'Dear diary, today I rested.' }],
    }),
  );
  await settle();
  const transcript = await harness.context.transcripts.current(recordingId!);
  expect(transcript.kind).toBe('final');
  expect(
    transcript.kind === 'final' && transcript.lines.map(line => line.text),
  ).toEqual(['Dear diary, today I rested.']);
  await harness.close();
});

it('records normally when live text is unavailable', async () => {
  const live = new FakeLiveTranscriber();
  live.available = false;
  const harness = await journalHarness({ live });
  const view = await harness.render(
    <RecordingScreen onDone={noop} onOpenEntry={noop} onWriteInstead={noop} />,
  );
  await settle();
  await act(async () => harness.recorder.capture(2_000));
  expect(view.getByTestId('recording-timer')).toHaveTextContent('0:02');
  await fireEvent.press(view.getByTestId('recording-finish'));
  await settle();
  expect(view.getByTestId('recording-status')).toHaveTextContent(/Saved/);
  await harness.close();
});
