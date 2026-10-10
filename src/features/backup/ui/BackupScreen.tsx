import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from '../../../theme/colors';
import {
  useAppLock,
  waitText,
} from '../../app-lock/application/AppLockContext';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { useJournal } from '../../journal/application/JournalContext';
import { useBackup } from '../application/BackupContext';
import {
  appendHistory,
  BACKUP_HISTORY_KEY,
  parseHistory,
  suggestedFileName,
  type BackupHistoryItem,
} from '../domain/backupHistory';
import { checkChallenge, pickChallenge } from '../domain/recoveryKeyChallenge';
import { assessRestoreTarget } from '../domain/restoreTarget';
import type {
  DamagedEntry,
  OpenedArchive,
  PickedArchive,
} from '../ports/BackupService';

// Settings → Backup & restore (UX §11; backup-and-restore.md §2; owner
// decisions of 2026-10-10). Progress is phases, never content. Damaged
// entries are listed by date and title on this device only.

const SKIP_WORD = 'SKIP';

const failureCopy: Record<string, string> = {
  AUTH_FAILED: 'That password or recovery key does not open this backup.',
  WEAK_PASSWORD: 'Use at least 12 characters. A long passphrase is best.',
  TOO_LONG: 'That password is too long.',
  WORD_COUNT: 'A recovery key has exactly 24 words.',
  UNKNOWN_WORD: 'One of the words is not a recovery-key word. Check them.',
  CHECKSUM: 'The words do not form a valid recovery key. Check them.',
  INSUFFICIENT_STORAGE: 'There is not enough free space on this device.',
  LIMIT_EXCEEDED: 'This journal is larger than one backup can hold.',
  NOT_AJB1: 'This file is not an Audio Journal backup.',
  TRUNCATED: 'This backup file is incomplete or damaged.',
  UNSUPPORTED_VERSION: 'This backup was made by a newer version of the app.',
  UNSUPPORTED_SCHEMA: 'This backup was made by a newer version of the app.',
  SECRET_KIND_MISMATCH: 'This backup uses the other kind of secret.',
  JOURNAL_NOT_EMPTY: 'Restore needs an empty journal on this device.',
  PICKER_UNAVAILABLE: 'The file picker could not be opened.',
};

function describe(code: string, journalUnchanged = true) {
  const base = failureCopy[code] ?? 'The operation could not be completed.';
  return journalUnchanged ? `${base} Your journal has not been changed.` : base;
}

const formatDate = (atMs: number) => new Date(atMs).toLocaleString();
const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const counted = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export function BackupScreen() {
  const backup = useBackup();
  const { journal } = useJournal();
  const [mode, setMode] = useState<'home' | 'create' | 'restore'>('home');
  const [history, setHistory] = useState<BackupHistoryItem[]>([]);

  const reload = useCallback(() => {
    journal
      .getSetting(BACKUP_HISTORY_KEY)
      .then(value => setHistory(parseHistory(value)))
      .catch(() => undefined);
  }, [journal]);
  useEffect(reload, [reload]);

  if (!backup) {
    return (
      <View style={styles.page} testID="backup-screen">
        <Text style={styles.body}>Backup is not available on this device.</Text>
      </View>
    );
  }
  if (mode === 'create') {
    return (
      <CreateBackup
        onDone={() => {
          reload();
          setMode('home');
        }}
        onSaved={item => {
          const next = appendHistory(history, item);
          setHistory(next);
          journal
            .setSetting(BACKUP_HISTORY_KEY, JSON.stringify(next))
            .catch(() => undefined);
        }}
      />
    );
  }
  if (mode === 'restore') {
    return <RestoreBackup onDone={() => setMode('home')} />;
  }
  const last = history[0];
  return (
    <ScrollView contentContainerStyle={styles.page} testID="backup-screen">
      <Text style={styles.title}>Backup & restore</Text>
      <Text style={styles.body} testID="backup-last">
        {last
          ? `Last backup: ${formatDate(last.atMs)}, ${formatSize(last.bytes)}.${
              last.excludedEntries > 0
                ? ` Incomplete: ${last.excludedEntries} ${
                    last.excludedEntries === 1 ? 'entry was' : 'entries were'
                  } left out.`
                : ''
            }`
          : 'No backup yet.'}
      </Text>
      <Text style={styles.muted}>
        A backup is an encrypted snapshot you save where you choose. It is not
        automatic sync: newer entries need a new backup. Your PIN, biometrics,
        and Private AI Node pairing are not included.
      </Text>
      <View style={styles.actions}>
        <PrimaryButton
          label="Create backup"
          onPress={() => setMode('create')}
          testID="backup-create"
        />
        <PrimaryButton
          label="Restore backup"
          onPress={() => setMode('restore')}
          secondary
          testID="backup-restore"
        />
      </View>
    </ScrollView>
  );
}

type CreateStep =
  | { k: 'estimating' }
  | { k: 'damaged'; entries: DamagedEntry[]; typed: string }
  | { k: 'choose' }
  | { k: 'password'; first: string; second: string; error?: string }
  | { k: 'showKey'; words: string[] }
  | {
      k: 'challenge';
      words: string[];
      positions: number[];
      answers: string[];
    }
  | { k: 'working'; phase: string }
  | { k: 'ready'; bytes: number }
  | { k: 'done'; bytes: number; name?: string }
  | { k: 'failed'; message: string };

function CreateBackup({
  onDone,
  onSaved,
}: {
  onDone(): void;
  onSaved(item: BackupHistoryItem): void;
}) {
  const backup = useBackup()!;
  const { expectSystemUi } = useAppLock();
  const [step, setStep] = useState<CreateStep>({ k: 'estimating' });
  // Entries the user explicitly chose to leave out, with their labels.
  const [excluded, setExcluded] = useState<DamagedEntry[]>([]);
  const [keyNote, setKeyNote] = useState<string>();

  useEffect(() => {
    backup.estimate().then(
      estimate =>
        setStep(
          estimate.status === 'damaged'
            ? { k: 'damaged', entries: estimate.entries, typed: '' }
            : estimate.status === 'ready'
            ? { k: 'choose' }
            : {
                k: 'failed',
                message:
                  estimate.status === 'failed'
                    ? describe(estimate.code)
                    : 'Cancelled.',
              },
        ),
      () => setStep({ k: 'failed', message: describe('') }),
    );
  }, [backup]);

  const prepare = async (kind: 'password' | 'recoveryKey', secret: string) => {
    setStep({ k: 'working', phase: 'Encrypting and checking your backup…' });
    const result = await backup.prepare(
      kind,
      secret,
      excluded.map(entry => entry.entryId),
    );
    if (result.status === 'ready') {
      setStep({ k: 'ready', bytes: result.bytes });
    } else if (result.status === 'damaged') {
      setStep({ k: 'damaged', entries: result.entries, typed: '' });
    } else {
      setStep({
        k: 'failed',
        message:
          result.status === 'failed'
            ? describe(result.code)
            : 'Cancelled. Your journal has not been changed.',
      });
    }
  };

  const save = async () => {
    const atMs = Date.now();
    setStep({ k: 'working', phase: 'Choose where to save the backup…' });
    // The system picker pauses the app: hold the lock grace (ADR-017).
    const release = expectSystemUi();
    let saved;
    try {
      saved = await backup.save(suggestedFileName(atMs, excluded.length > 0));
    } finally {
      release();
    }
    if (saved.status === 'complete') {
      onSaved({ atMs, bytes: saved.bytes, excludedEntries: excluded.length });
      setStep({ k: 'done', bytes: saved.bytes, name: saved.name });
    } else if (saved.status === 'cancelled') {
      setStep({ k: 'ready', bytes: 0 });
    } else {
      setStep({
        k: 'failed',
        message: `${describe(saved.code)}${
          saved.destinationRemoved === false
            ? ' The partly written file could not be removed; delete it yourself.'
            : ''
        }`,
      });
    }
  };

  const leave = () => {
    backup.discard().catch(() => undefined);
    onDone();
  };

  switch (step.k) {
    case 'estimating':
    case 'working':
      return (
        <Page testID="backup-working">
          <Text style={styles.body}>
            {step.k === 'working' ? step.phase : 'Checking your journal…'}
          </Text>
          <PrimaryButton
            label="Cancel"
            onPress={() => {
              backup.cancel();
              leave();
            }}
            secondary
            testID="backup-cancel"
          />
        </Page>
      );
    case 'damaged': {
      const ready = step.typed === SKIP_WORD;
      return (
        <Page testID="backup-damaged">
          <Text style={styles.title}>Some recordings can’t be read</Text>
          <Text style={styles.body}>
            The backup stopped. These entries have a recording that can no
            longer be read in full. Nothing in your journal was changed.
          </Text>
          {step.entries.map(entry => (
            <Text
              key={entry.entryId}
              style={styles.item}
              testID={`backup-damaged-${entry.entryId}`}
            >
              {formatDate(entry.createdAtMs)}
              {entry.title ? ` · ${entry.title}` : ''} · recording
            </Text>
          ))}
          <Text style={styles.body}>
            You can back up everything else. The backup will be marked
            incomplete. Type {SKIP_WORD} to continue without these entries.
          </Text>
          <TextInput
            accessibilityLabel={`Type ${SKIP_WORD} to confirm`}
            autoCapitalize="characters"
            onChangeText={typed => setStep({ ...step, typed })}
            style={styles.input}
            testID="backup-skip-input"
            value={step.typed}
          />
          <PrimaryButton
            disabled={!ready}
            label="Back up without these entries"
            onPress={() => {
              setExcluded(previous => [
                ...previous,
                ...step.entries.filter(
                  entry =>
                    !previous.some(kept => kept.entryId === entry.entryId),
                ),
              ]);
              setStep({ k: 'choose' });
            }}
            testID="backup-skip-confirm"
          />
          <PrimaryButton
            label="Cancel"
            onPress={leave}
            secondary
            testID="backup-cancel"
          />
        </Page>
      );
    }
    case 'choose':
      return (
        <Page testID="backup-choose">
          <Text style={styles.title}>Protect your backup</Text>
          <Text style={styles.body}>
            Audio Journal cannot recover a lost backup password or recovery key.
            Your app PIN is not used.
          </Text>
          <PrimaryButton
            label="Use a recovery key (recommended)"
            onPress={async () =>
              setStep({
                k: 'showKey',
                words: await backup.generateRecoveryKey(),
              })
            }
            testID="backup-use-key"
          />
          <PrimaryButton
            label="Use a password"
            onPress={() => setStep({ k: 'password', first: '', second: '' })}
            secondary
            testID="backup-use-password"
          />
        </Page>
      );
    case 'password':
      return (
        <Page testID="backup-password">
          <Text style={styles.body}>
            At least 12 characters. A long passphrase of several words is best;
            meeting the minimum does not make a password strong.
          </Text>
          <TextInput
            accessibilityLabel="Backup password"
            onChangeText={first => setStep({ ...step, first })}
            secureTextEntry
            style={styles.input}
            testID="backup-password-1"
            value={step.first}
          />
          <TextInput
            accessibilityLabel="Repeat the backup password"
            onChangeText={second => setStep({ ...step, second })}
            secureTextEntry
            style={styles.input}
            testID="backup-password-2"
            value={step.second}
          />
          {step.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {step.error}
            </Text>
          ) : null}
          <PrimaryButton
            label="Create backup"
            onPress={() =>
              step.first !== step.second
                ? setStep({ ...step, error: 'The passwords do not match.' })
                : [...step.first.normalize('NFC')].length < 12
                ? setStep({ ...step, error: failureCopy.WEAK_PASSWORD })
                : prepare('password', step.first)
            }
            testID="backup-password-continue"
          />
        </Page>
      );
    case 'showKey':
      return (
        <Page testID="backup-show-key">
          <Text style={styles.title}>Your recovery key</Text>
          <Text style={styles.body}>
            Write these 24 words down, in order, and keep them somewhere safe.
            Anyone with them can open your backup.
          </Text>
          {keyNote ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {keyNote}
            </Text>
          ) : null}
          <View style={styles.words}>
            {step.words.map((word, index) => (
              <Text
                key={index}
                style={styles.word}
                testID={`backup-word-${index + 1}`}
              >
                {index + 1}. {word}
              </Text>
            ))}
          </View>
          <PrimaryButton
            label="I have written it down"
            onPress={() => {
              setKeyNote(undefined);
              setStep({
                k: 'challenge',
                words: step.words,
                positions: pickChallenge(count => backup.randomBytes(count)),
                answers: ['', '', ''],
              });
            }}
            testID="backup-key-written"
          />
        </Page>
      );
    case 'challenge':
      return (
        <Page testID="backup-challenge">
          <Text style={styles.body}>
            To check, type the words at these positions.
          </Text>
          {step.positions.map((position, index) => (
            <TextInput
              key={position}
              accessibilityLabel={`Word ${position + 1}`}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={value => {
                const answers = [...step.answers];
                answers[index] = value;
                setStep({ ...step, answers });
              }}
              placeholder={`Word ${position + 1}`}
              style={styles.input}
              testID={`backup-challenge-${index}`}
              value={step.answers[index]}
            />
          ))}
          <PrimaryButton
            label="Continue"
            onPress={() => {
              if (checkChallenge(step.words, step.positions, step.answers)) {
                prepare('recoveryKey', step.words.join(' '));
              } else {
                // Back to the words for another look (owner decision).
                setKeyNote(
                  'Those words did not match. Check your copy of the recovery key.',
                );
                setStep({ k: 'showKey', words: step.words });
              }
            }}
            testID="backup-challenge-continue"
          />
        </Page>
      );
    case 'ready':
      return (
        <Page testID="backup-ready">
          <Text style={styles.body}>
            Your encrypted backup is ready and checked. Choose where to save it.
          </Text>
          <PrimaryButton
            label="Choose where to save"
            onPress={save}
            testID="backup-save"
          />
          <PrimaryButton
            label="Cancel"
            onPress={leave}
            secondary
            testID="backup-cancel"
          />
        </Page>
      );
    case 'done':
      return (
        <Page testID="backup-done">
          <Text style={styles.title}>
            {excluded.length > 0 ? 'Incomplete backup saved' : 'Backup saved'}
          </Text>
          <Text style={styles.body}>
            {step.name ? `${step.name} · ` : ''}
            {formatSize(step.bytes)}. It was checked after saving.
          </Text>
          {excluded.length > 0 ? (
            <>
              <Text style={styles.body} testID="backup-incomplete">
                This backup is incomplete: {excluded.length}{' '}
                {excluded.length === 1 ? 'entry was' : 'entries were'} left out
                because a recording could not be read. The file itself does not
                say so, so keep its name.
              </Text>
              {excluded.map(entry => (
                <Text key={entry.entryId} style={styles.item}>
                  {formatDate(entry.createdAtMs)}
                  {entry.title ? ` · ${entry.title}` : ''}
                </Text>
              ))}
            </>
          ) : null}
          <PrimaryButton
            label="Done"
            onPress={onDone}
            testID="backup-done-close"
          />
        </Page>
      );
    case 'failed':
      return (
        <Page testID="backup-failed">
          <Text accessibilityRole="alert" style={styles.error}>
            {step.message}
          </Text>
          <PrimaryButton label="Close" onPress={leave} testID="backup-close" />
        </Page>
      );
  }
}

type RestoreStep =
  | { k: 'checking' }
  | { k: 'notEmpty' }
  | { k: 'intro'; rows: number; files: number }
  | {
      k: 'secret';
      picked: Extract<PickedArchive, { status: 'picked' }>;
      secret: string;
      error?: string;
    }
  | { k: 'working'; phase: string }
  | { k: 'preview'; opened: Extract<OpenedArchive, { status: 'opened' }> }
  | { k: 'pin'; pin: string; error?: string }
  | { k: 'failed'; message: string };

function RestoreBackup({ onDone }: { onDone(): void }) {
  const backup = useBackup()!;
  const { expectSystemUi, lock } = useAppLock();
  const [step, setStep] = useState<RestoreStep>({ k: 'checking' });

  useEffect(() => {
    backup.restoreTarget().then(
      counts => {
        const assessed = assessRestoreTarget(counts);
        setStep(
          assessed.allowed
            ? { k: 'intro', ...assessed.discard }
            : { k: 'notEmpty' },
        );
      },
      () => setStep({ k: 'failed', message: describe('') }),
    );
  }, [backup]);

  const leave = () => {
    backup.abandon().catch(() => undefined);
    onDone();
  };

  const fail = (code: string) =>
    setStep({ k: 'failed', message: describe(code) });

  switch (step.k) {
    case 'checking':
    case 'working':
      return (
        <Page testID="restore-working">
          <Text style={styles.body}>
            {step.k === 'working' ? step.phase : 'Checking this journal…'}
          </Text>
          <PrimaryButton
            label="Cancel"
            onPress={leave}
            secondary
            testID="restore-cancel"
          />
        </Page>
      );
    case 'notEmpty':
      return (
        <Page testID="restore-not-empty">
          <Text style={styles.body}>{failureCopy.JOURNAL_NOT_EMPTY}</Text>
          <Text style={styles.muted}>
            This journal already has entries. Restore replaces a journal only
            when it is empty, so nothing you wrote here could be lost.
          </Text>
          <PrimaryButton
            label="Close"
            onPress={onDone}
            testID="restore-close"
          />
        </Page>
      );
    case 'intro':
      return (
        <Page testID="restore-intro">
          <Text style={styles.title}>Restore a backup</Text>
          <Text style={styles.body}>
            Choose a backup file. You’ll need its password or recovery key.
          </Text>
          {step.rows + step.files > 0 ? (
            <Text style={styles.body} testID="restore-discard">
              Restoring removes {step.rows} hidden{' '}
              {step.rows === 1 ? 'record' : 'records'} and {step.files} leftover{' '}
              {step.files === 1 ? 'file' : 'files'} from earlier attempts on
              this device. They contain nothing you can see in your journal.
            </Text>
          ) : null}
          <PrimaryButton
            label="Choose backup file"
            onPress={async () => {
              setStep({ k: 'working', phase: 'Choose your backup file…' });
              const release = expectSystemUi();
              let picked;
              try {
                picked = await backup.pickArchive();
              } finally {
                release();
              }
              if (picked.status === 'picked') {
                setStep({ k: 'secret', picked, secret: '' });
              } else if (picked.status === 'cancelled') {
                setStep(step);
              } else {
                fail(picked.code);
              }
            }}
            testID="restore-pick"
          />
          <PrimaryButton
            label="Cancel"
            onPress={leave}
            secondary
            testID="restore-cancel"
          />
        </Page>
      );
    case 'secret':
      return (
        <Page testID="restore-secret">
          <Text style={styles.body}>
            {step.picked.secretKind === 'password'
              ? 'Enter the backup password.'
              : 'Enter the 24-word recovery key.'}
          </Text>
          <TextInput
            accessibilityLabel={
              step.picked.secretKind === 'password'
                ? 'Backup password'
                : 'Recovery key'
            }
            autoCapitalize="none"
            autoCorrect={false}
            multiline={step.picked.secretKind === 'recoveryKey'}
            onChangeText={secret => setStep({ ...step, secret })}
            secureTextEntry={step.picked.secretKind === 'password'}
            style={styles.input}
            testID="restore-secret-input"
            value={step.secret}
          />
          {step.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {step.error}
            </Text>
          ) : null}
          <PrimaryButton
            label="Open backup"
            onPress={async () => {
              const current = step;
              setStep({
                k: 'working',
                phase: 'Opening and checking the backup…',
              });
              const opened = await backup.openArchive(current.secret);
              if (opened.status === 'opened') {
                setStep({ k: 'preview', opened });
              } else if (opened.status === 'failed') {
                setStep({
                  ...current,
                  secret: '',
                  error: describe(opened.code, false),
                });
              } else {
                leave();
              }
            }}
            testID="restore-open"
          />
        </Page>
      );
    case 'preview':
      return (
        <Page testID="restore-preview">
          <Text style={styles.title}>
            Backup from {formatDate(step.opened.createdAtMs)}
          </Text>
          <Text style={styles.body} testID="restore-counts">
            {counted(step.opened.entries, 'entry', 'entries')} ·{' '}
            {step.opened.recordings === 0
              ? 'no recordings'
              : `${counted(
                  step.opened.recordings,
                  'recording',
                  'recordings',
                )} · ${formatSize(step.opened.pcmBytes)} of audio`}
            . Needs {formatSize(step.opened.requiredBytes)} free.
          </Text>
          <PrimaryButton
            label="Restore this backup"
            onPress={async () => {
              setStep({
                k: 'working',
                phase: 'Restoring into a safe staging area…',
              });
              const staged = await backup.stage();
              if (staged.status === 'staged') {
                setStep({ k: 'pin', pin: '' });
              } else if (staged.status === 'failed') {
                fail(staged.code);
              } else {
                leave();
              }
            }}
            testID="restore-confirm"
          />
          <PrimaryButton
            label="Cancel"
            onPress={leave}
            secondary
            testID="restore-cancel"
          />
        </Page>
      );
    case 'pin':
      return (
        <Page testID="restore-pin">
          <Text style={styles.body}>
            Enter your current PIN to replace this journal with the backup. It
            will protect the restored journal. Biometric unlock will be off
            until you turn it on again.
          </Text>
          <TextInput
            accessibilityLabel="Current PIN"
            keyboardType="number-pad"
            onChangeText={pin => setStep({ ...step, pin })}
            secureTextEntry
            style={styles.input}
            testID="restore-pin-input"
            value={step.pin}
          />
          {step.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {step.error}
            </Text>
          ) : null}
          <PrimaryButton
            label="Restore"
            onPress={async () => {
              const pin = step.pin;
              setStep({
                k: 'working',
                phase: 'Activating the restored journal…',
              });
              const result = await backup.activate(pin);
              if ('result' in result) {
                switch (result.result) {
                  case 'activated':
                    // Lock now; a normal unlock opens the restored journal.
                    lock();
                    return;
                  case 'wrong_pin':
                    setStep({
                      k: 'pin',
                      pin: '',
                      error: 'That PIN is not correct.',
                    });
                    return;
                  case 'refused':
                    setStep({
                      k: 'pin',
                      pin: '',
                      error: `Too many attempts. Try again in ${waitText(
                        result.retryAt,
                        Date.now(),
                      )}.`,
                    });
                    return;
                  default:
                    fail('');
                    return;
                }
              }
              if (result.status === 'failed') {
                fail(result.code);
              } else {
                leave();
              }
            }}
            testID="restore-activate"
          />
          <PrimaryButton
            label="Cancel"
            onPress={leave}
            secondary
            testID="restore-cancel"
          />
        </Page>
      );
    case 'failed':
      return (
        <Page testID="restore-failed">
          <Text accessibilityRole="alert" style={styles.error}>
            {step.message}
          </Text>
          <PrimaryButton label="Close" onPress={leave} testID="restore-close" />
        </Page>
      );
  }
}

function Page({
  children,
  testID,
}: React.PropsWithChildren<{ testID: string }>) {
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.background, gap: 12, padding: 24 },
  title: { color: colors.ink, fontSize: 20, fontWeight: '700' },
  body: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  item: { color: colors.ink, fontSize: 14, paddingVertical: 2 },
  error: { color: colors.error, fontSize: 15 },
  actions: { gap: 12, marginTop: 12 },
  input: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 16,
    padding: 12,
  },
  words: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  word: { color: colors.ink, fontSize: 15, minWidth: 140 },
});
