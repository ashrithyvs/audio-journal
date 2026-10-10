import React, { type PropsWithChildren } from 'react';
import { AppState, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

import {
  AppLockProvider,
  useAppLock,
} from '../src/features/app-lock/application/AppLockContext';
import { BackupProvider } from '../src/features/backup/application/BackupContext';
import {
  BACKUP_HISTORY_KEY,
  parseHistory,
} from '../src/features/backup/domain/backupHistory';
import { BackupScreen } from '../src/features/backup/ui/BackupScreen';
import { JournalProvider } from '../src/features/journal/application/JournalContext';
import { FakeBackupService } from '../test/backup/FakeBackupService';
import { FakeVaultService } from '../test/FakeVaultService';
import { FakeRecordingService } from '../test/journal/FakeRecordingService';
import { openJournal, readyVoiceEntry } from '../test/sqlite/journalFixtures';

// Backup & restore flows (ADR-017; owner decisions of 2026-10-10;
// AJ1-DEC-001 option B) over real SQLite, with the native codec scripted.

const PIN = '482915';
let listeners: Array<(state: string) => void> = [];
let spy: jest.SpyInstance;

beforeEach(() => {
  listeners = [];
  spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: string) => void,
  ) => {
    listeners.push(listener);
    return { remove: () => undefined };
  }) as never);
});

afterEach(() => spy.mockRestore());

let lockApi: ReturnType<typeof useAppLock> | undefined;
function Probe() {
  lockApi = useAppLock();
  return <Text testID="lock-phase">{lockApi.state.phase}</Text>;
}

async function setup(backup = new FakeBackupService()) {
  const context = await openJournal();
  const vault = new FakeVaultService(PIN);
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <AppLockProvider services={{ vault }}>
        <JournalProvider
          services={{
            journal: context.journal,
            transcripts: context.transcripts,
            recorder: new FakeRecordingService(),
            ids: context.ids,
            now: () => 1_760_000_000_000,
          }}
        >
          <BackupProvider service={backup}>
            {children}
            <Probe />
          </BackupProvider>
        </JournalProvider>
      </AppLockProvider>
    );
  }
  const view = await render(<BackupScreen />, { wrapper: Wrapper });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await act(async () => {
    await lockApi!.unlockWithPin(PIN);
  });
  expect(view.getByTestId('lock-phase')).toHaveTextContent('unlocked');
  return { view, backup, context };
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

async function usePassword(view: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(await view.findByTestId('backup-use-password'));
  await fireEvent.changeText(
    view.getByTestId('backup-password-1'),
    'quiet river morning walk',
  );
  await fireEvent.changeText(
    view.getByTestId('backup-password-2'),
    'quiet river morning walk',
  );
  await fireEvent.press(view.getByTestId('backup-password-continue'));
  await settle();
}

it('saves a complete backup, names it, and keeps counts-only history', async () => {
  const { view, backup, context } = await setup();
  expect(view.getByTestId('backup-last')).toHaveTextContent('No backup yet.');
  await fireEvent.press(view.getByTestId('backup-create'));
  await settle();
  await usePassword(view);
  expect(backup.calls).toContain('prepare password []');
  await fireEvent.press(await view.findByTestId('backup-save'));
  await settle();
  expect(backup.calls.find(call => call.startsWith('save'))).toMatch(
    /^save AudioJournal-\d{4}-\d{2}-\d{2}-\d{4}\.ajbackup$/,
  );
  expect(await view.findByTestId('backup-done')).toBeTruthy();
  expect(view.queryByTestId('backup-incomplete')).toBeNull();
  const stored = await context.journal.getSetting(BACKUP_HISTORY_KEY);
  expect(parseHistory(stored)).toEqual([
    { atMs: expect.any(Number), bytes: 70_000, excludedEntries: 0 },
  ]);
  // Counts only: nothing else is kept about the backup.
  expect(Object.keys(JSON.parse(stored!)[0]).sort()).toEqual([
    'atMs',
    'bytes',
    'excludedEntries',
  ]);
  await fireEvent.press(view.getByTestId('backup-done-close'));
  expect(await view.findByTestId('backup-last')).toHaveTextContent(
    /^Last backup: .*, 68 KB\.$/,
  );
  await context.db.close();
});

it('stops on a damaged recording until SKIP is typed, then marks the backup incomplete', async () => {
  const backup = new FakeBackupService();
  const { view, context } = await setup(backup);
  const { entryId, recordingId } = await readyVoiceEntry(context, 3_000);
  const before = await context.journal.listTimeline({ limit: 10 });
  backup.estimateResult = {
    status: 'damaged',
    entries: [
      {
        entryId,
        recordingId,
        createdAtMs: 1_700_000_100_000,
        title: 'Morning walk',
        component: 'recording',
      },
    ],
  };
  backup.prepareResults = [
    { status: 'ready', bytes: 50_000, excluded: 1, entries: 1, recordings: 0 },
  ];
  backup.saveResult = { status: 'complete', bytes: 50_000 };

  await fireEvent.press(view.getByTestId('backup-create'));
  expect(
    await view.findByTestId(`backup-damaged-${entryId}`),
  ).toHaveTextContent(/Morning walk · recording/);
  const confirm = view.getByTestId('backup-skip-confirm');
  expect(confirm).toBeDisabled();
  await fireEvent.changeText(view.getByTestId('backup-skip-input'), 'skip');
  expect(view.getByTestId('backup-skip-confirm')).toBeDisabled();
  await fireEvent.changeText(view.getByTestId('backup-skip-input'), 'SKIP');
  await fireEvent.press(view.getByTestId('backup-skip-confirm'));
  await usePassword(view);
  expect(backup.calls).toContain(`prepare password [${entryId}]`);
  await fireEvent.press(await view.findByTestId('backup-save'));
  await settle();
  expect(backup.calls.find(call => call.startsWith('save'))).toMatch(
    /-incomplete\.ajbackup$/,
  );
  expect(view.getByTestId('backup-incomplete')).toHaveTextContent(
    /incomplete: 1 entry was left out/,
  );
  expect(view.getByText(/Morning walk/)).toBeTruthy();
  expect(
    parseHistory(await context.journal.getSetting(BACKUP_HISTORY_KEY)),
  ).toEqual([{ atMs: expect.any(Number), bytes: 50_000, excludedEntries: 1 }]);
  // The journal itself is unchanged.
  expect(await context.journal.listTimeline({ limit: 10 })).toEqual(before);
  await context.db.close();
});

it('cancels without saving anything and leaves the journal unchanged', async () => {
  const backup = new FakeBackupService();
  const { view, context } = await setup(backup);
  await readyVoiceEntry(context, 3_000);
  const before = await context.journal.listTimeline({ limit: 10 });
  await fireEvent.press(view.getByTestId('backup-create'));
  await settle();
  await usePassword(view);
  await fireEvent.press(await view.findByTestId('backup-cancel'));
  expect(backup.calls).toContain('discard');
  expect(backup.calls.some(call => call.startsWith('save'))).toBe(false);
  expect(await context.journal.getSetting(BACKUP_HISTORY_KEY)).toBeUndefined();
  expect(await context.journal.listTimeline({ limit: 10 })).toEqual(before);
  await context.db.close();
});

it('confirms a recovery key with three hidden words, returning to the words on a miss', async () => {
  const { view, backup, context } = await setup();
  await fireEvent.press(view.getByTestId('backup-create'));
  await fireEvent.press(await view.findByTestId('backup-use-key'));
  expect(await view.findByTestId('backup-word-24')).toHaveTextContent(
    '24. word24',
  );
  await fireEvent.press(view.getByTestId('backup-key-written'));
  // The phrase is hidden during the challenge.
  expect(view.queryByTestId('backup-word-1')).toBeNull();
  expect(view.getByLabelText('Word 6')).toBeTruthy();
  expect(view.getByLabelText('Word 12')).toBeTruthy();
  expect(view.getByLabelText('Word 21')).toBeTruthy();
  await fireEvent.changeText(view.getByTestId('backup-challenge-0'), 'word6');
  await fireEvent.changeText(view.getByTestId('backup-challenge-1'), 'word21');
  await fireEvent.changeText(view.getByTestId('backup-challenge-2'), 'word12');
  await fireEvent.press(view.getByTestId('backup-challenge-continue'));
  // Out of order: back to the phrase, nothing prepared.
  expect(view.getByTestId('backup-show-key')).toBeTruthy();
  expect(backup.calls.some(call => call.startsWith('prepare'))).toBe(false);
  await fireEvent.press(view.getByTestId('backup-key-written'));
  await fireEvent.changeText(view.getByTestId('backup-challenge-0'), 'word6');
  await fireEvent.changeText(view.getByTestId('backup-challenge-1'), 'word12');
  await fireEvent.changeText(
    view.getByTestId('backup-challenge-2'),
    ' WORD21 ',
  );
  await fireEvent.press(view.getByTestId('backup-challenge-continue'));
  await settle();
  expect(backup.calls).toContain('prepare recoveryKey []');
  expect(backup.secrets).toEqual([backup.words.join(' ')]);
  await context.db.close();
});

it('keeps the app unlocked while its own save picker is open', async () => {
  const backup = new FakeBackupService();
  // The picker pauses the app and returns. Inside the grace neither event
  // changes lock state, so no act() is needed here.
  backup.duringPicker = async () => {
    listeners.forEach(listener => listener('background'));
    listeners.forEach(listener => listener('active'));
  };
  const { view, context } = await setup(backup);
  await fireEvent.press(view.getByTestId('backup-create'));
  await settle();
  await usePassword(view);
  await fireEvent.press(await view.findByTestId('backup-save'));
  await settle();
  expect(view.getByTestId('lock-phase')).toHaveTextContent('unlocked');
  expect(await view.findByTestId('backup-done')).toBeTruthy();
  // Outside the picker, leaving the app still locks at once.
  await act(async () => {
    listeners.forEach(listener => listener('background'));
  });
  expect(view.getByTestId('lock-phase')).toHaveTextContent('locked');
  await context.db.close();
});

it('refuses to restore over visible journal content', async () => {
  const backup = new FakeBackupService();
  backup.target = { ...backup.target, readyEntries: 1 };
  const { view, context } = await setup(backup);
  await fireEvent.press(view.getByTestId('backup-restore'));
  expect(await view.findByTestId('restore-not-empty')).toBeTruthy();
  expect(backup.calls).not.toContain('pickArchive');
  await context.db.close();
});

it('restores: counts what is discarded, checks the secret and the current PIN, then locks', async () => {
  const backup = new FakeBackupService();
  backup.target = { ...backup.target, hiddenRows: 2, leftoverFiles: 1 };
  backup.openResults = [
    { status: 'failed', code: 'AUTH_FAILED', stage: 'unwrap' },
    backup.openResults[0],
  ];
  backup.activations = [{ result: 'wrong_pin' }, { result: 'activated' }];
  const { view, context } = await setup(backup);
  await fireEvent.press(view.getByTestId('backup-restore'));
  expect(await view.findByTestId('restore-discard')).toHaveTextContent(
    /2 hidden records and 1 leftover file/,
  );
  await fireEvent.press(view.getByTestId('restore-pick'));
  await settle();
  await fireEvent.changeText(
    view.getByTestId('restore-secret-input'),
    'wrong secret!!',
  );
  await fireEvent.press(view.getByTestId('restore-open'));
  await settle();
  expect(await view.findByText(/does not open this backup/)).toBeTruthy();
  await fireEvent.changeText(
    view.getByTestId('restore-secret-input'),
    'quiet river morning walk',
  );
  await fireEvent.press(view.getByTestId('restore-open'));
  expect(await view.findByTestId('restore-counts')).toHaveTextContent(
    /4 entries · 2 recordings/,
  );
  await fireEvent.press(view.getByTestId('restore-confirm'));
  await settle();
  await fireEvent.changeText(
    await view.findByTestId('restore-pin-input'),
    '000000',
  );
  await fireEvent.press(view.getByTestId('restore-activate'));
  await settle();
  expect(await view.findByText('That PIN is not correct.')).toBeTruthy();
  expect(view.getByTestId('lock-phase')).toHaveTextContent('unlocked');
  await fireEvent.changeText(view.getByTestId('restore-pin-input'), PIN);
  await fireEvent.press(view.getByTestId('restore-activate'));
  await settle();
  // Activated: the app locks; a normal unlock opens the restored journal.
  expect(view.getByTestId('lock-phase')).toHaveTextContent('locked');
  expect(backup.calls).toEqual(
    expect.arrayContaining(['pickArchive', 'stage', 'activate 6']),
  );
  await context.db.close();
});

it('describes a one-entry backup without recordings in plain words', async () => {
  const backup = new FakeBackupService();
  backup.openResults = [
    {
      status: 'opened',
      createdAtMs: 1_760_000_000_000,
      entries: 1,
      recordings: 0,
      segments: 1,
      pcmBytes: 0,
      requiredBytes: 600_000_000,
    },
  ];
  const { view, context } = await setup(backup);
  await fireEvent.press(view.getByTestId('backup-restore'));
  await fireEvent.press(await view.findByTestId('restore-pick'));
  await settle();
  await fireEvent.changeText(
    view.getByTestId('restore-secret-input'),
    'quiet river morning walk',
  );
  await fireEvent.press(view.getByTestId('restore-open'));
  expect(await view.findByTestId('restore-counts')).toHaveTextContent(
    '1 entry · no recordings. Needs 572.2 MB free.',
  );
  await context.db.close();
});
