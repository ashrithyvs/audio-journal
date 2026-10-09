import React from 'react';

import { DiaryScreen } from '../src/features/journal/ui/DiaryScreen';
import { RecordingScreen } from '../src/features/journal/ui/RecordingScreen';
import { WriteEntryScreen } from '../src/features/journal/ui/WriteEntryScreen';
import { journalHarness } from '../test/journal/renderJournal';

const noop = () => undefined;

it('mounts the journal screens in their initial states', async () => {
  const harness = await journalHarness();
  const view = await harness.render(
    <>
      <DiaryScreen onRecord={noop} onWrite={noop} onOpenEntry={noop} />
      <WriteEntryScreen onSaved={noop} onCancel={noop} />
      <RecordingScreen
        autoStart={false}
        onDone={noop}
        onOpenEntry={noop}
        onWriteInstead={noop}
      />
    </>,
  );
  expect(await view.findByTestId('diary-empty')).toBeTruthy();
  expect(view.getByTestId('write-save')).toBeTruthy();
  expect(view.getByTestId('recording-status')).toHaveTextContent(
    'Ready to record.',
  );
  await harness.close();
});
