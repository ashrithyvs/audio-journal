import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { useJournal } from '../application/JournalContext';
import type { RecordingRecord } from '../domain/entry';
import {
  formatDayHeading,
  formatDuration,
  formatTimeOfDay,
} from '../domain/format';
import { localDayKey } from '../domain/timeline';
import type { TranscriptLine } from '../domain/transcript';
import {
  RepositoryError,
  type JournalEntryDetail,
} from '../ports/JournalRepository';
import type { PlaybackEvent } from '../ports/PlaybackService';
import { journalStyles } from './journalStyles';

// Entry detail (UX §6): the original audio or written text is primary; the
// transcript follows and can be corrected without changing the recording
// (AJ-FR-004, AJ-FR-012). Corrections are labelled as the user's edits.

type Load =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'failed' }
  | { phase: 'ready'; detail: JournalEntryDetail };

export function EntryDetailScreen({ entryId }: { entryId: string }) {
  const { journal, revision } = useJournal();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });

  useEffect(() => {
    let active = true;
    journal.getEntry(entryId).then(
      detail => {
        if (active) {
          setLoad(detail ? { phase: 'ready', detail } : { phase: 'missing' });
        }
      },
      () => active && setLoad({ phase: 'failed' }),
    );
    return () => {
      active = false;
    };
  }, [entryId, journal, revision]);

  if (load.phase !== 'ready') {
    return (
      <View
        style={[journalStyles.page, journalStyles.content]}
        testID="entry-detail"
      >
        <Text style={journalStyles.muted}>
          {load.phase === 'loading'
            ? 'Opening entry…'
            : load.phase === 'missing'
            ? 'This entry is no longer available.'
            : 'This entry could not be opened right now. Nothing was changed.'}
        </Text>
      </View>
    );
  }

  const { entry, recording, transcript } = load.detail;
  return (
    <ScrollView
      contentContainerStyle={journalStyles.content}
      keyboardShouldPersistTaps="handled"
      style={journalStyles.page}
      testID="entry-detail"
    >
      <Text style={journalStyles.kicker}>
        {formatDayHeading(localDayKey(entry.createdAt)).toUpperCase()}
      </Text>
      <Text style={journalStyles.meta}>{formatTimeOfDay(entry.createdAt)}</Text>
      {entry.title ? (
        <Text style={journalStyles.title}>{entry.title}</Text>
      ) : null}
      {entry.status === 'recovery_required' ? (
        <View
          accessibilityRole="alert"
          style={journalStyles.notice}
          testID="entry-recovery"
        >
          <Text style={styles.noticeTitle}>This entry needs attention</Text>
          <Text style={journalStyles.muted}>{recordingNotice(recording)}</Text>
        </View>
      ) : null}

      {entry.kind === 'written' ? (
        <Text
          selectable
          style={[journalStyles.body, styles.source]}
          testID="entry-source-text"
        >
          {entry.sourceText}
        </Text>
      ) : (
        <RecordingSource recording={recording} />
      )}

      {entry.kind === 'voice' ? (
        <View style={journalStyles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Transcript
          </Text>
          {transcript.kind === 'none' ? (
            <Text style={journalStyles.muted} testID="transcript-none">
              No transcript yet. The recording is safe; a transcript can be
              created later.
            </Text>
          ) : (
            <>
              {transcript.kind === 'provisional' ? (
                <Text
                  style={journalStyles.muted}
                  testID="transcript-provisional"
                >
                  Live draft. It is replaced when the full on-device pass
                  finishes.
                </Text>
              ) : null}
              {transcript.lines.map(line => (
                <TranscriptRow
                  key={line.originSegmentId}
                  editable={transcript.kind === 'final'}
                  line={line}
                />
              ))}
            </>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

function recordingNotice(recording?: RecordingRecord): string {
  switch (recording?.state) {
    case 'recoverable':
      return `Recording was interrupted. ${formatDuration(
        recording.durationMs,
      )} of audio captured before that point is safe on this device.`;
    case 'failed':
      return 'No audio could be saved for this recording.';
    default:
      return 'The saved recording could not be fully verified. It has not been changed or deleted.';
  }
}

function RecordingSource({ recording }: { recording?: RecordingRecord }) {
  const { playback } = useJournal();
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      playback?.stop().catch(() => undefined);
    },
    [playback],
  );

  const onEvent = useCallback((event: PlaybackEvent) => {
    if (!mounted.current) {
      return;
    }
    if (event.type === 'position') {
      setPositionMs(event.positionMs);
    } else {
      setPlaying(false);
      setFailed(event.type === 'failed');
    }
  }, []);

  if (!recording) {
    return null;
  }
  const playable =
    recording.state === 'ready' || recording.state === 'recoverable';
  const toggle = async () => {
    if (!playback) {
      return;
    }
    if (playing) {
      await playback.pause();
      setPlaying(false);
    } else {
      setFailed(false);
      setPlaying(true);
      await playback.play(recording.id, { startMs: positionMs }, onEvent);
    }
  };

  return (
    <View style={journalStyles.notice} testID="entry-recording">
      <Text style={journalStyles.meta}>
        Voice · {formatDuration(recording.durationMs)} · Saved on this device
      </Text>
      {playback && playable ? (
        <View style={journalStyles.row}>
          <PrimaryButton
            label={playing ? 'Pause' : 'Play'}
            onPress={toggle}
            testID="entry-play"
          />
          <Text
            style={[journalStyles.meta, styles.position]}
            testID="entry-position"
          >
            {formatDuration(positionMs)} /{' '}
            {formatDuration(recording.durationMs)}
          </Text>
        </View>
      ) : null}
      {failed ? (
        <Text accessibilityRole="alert" style={journalStyles.error}>
          The recording could not be played. It has not been changed.
        </Text>
      ) : null}
    </View>
  );
}

function TranscriptRow({
  line,
  editable,
}: {
  line: TranscriptLine;
  editable: boolean;
}) {
  const { transcripts, now, changed } = useJournal();
  const [draft, setDraft] = useState<string>();
  const [message, setMessage] = useState<string>();

  const save = async () => {
    if (draft === undefined) {
      return;
    }
    try {
      await transcripts.correct(line.segmentId, draft, now());
      setDraft(undefined);
      setMessage(undefined);
      changed();
    } catch (error) {
      const reason = error instanceof RepositoryError ? error.reason : '';
      if (reason === 'UNCHANGED') {
        setDraft(undefined);
      } else {
        setMessage(
          error instanceof RepositoryError && error.code === 'CONFLICT'
            ? 'This line changed since you opened it. Reopen the entry and try again.'
            : 'The correction could not be saved. The transcript is unchanged.',
        );
      }
    }
  };

  return (
    <View style={styles.line} testID={`transcript-line-${line.ordinal}`}>
      <Text style={journalStyles.meta}>{formatDuration(line.startMs)}</Text>
      {draft === undefined ? (
        <Pressable
          accessibilityHint={editable ? 'Opens a correction field' : undefined}
          accessibilityRole={editable ? 'button' : 'text'}
          disabled={!editable}
          onPress={() => setDraft(line.text)}
          testID={`transcript-text-${line.ordinal}`}
        >
          <Text style={journalStyles.body}>{line.text}</Text>
        </Pressable>
      ) : (
        <>
          <TextInput
            accessibilityLabel="Corrected transcript line"
            autoFocus
            multiline
            onChangeText={setDraft}
            style={journalStyles.input}
            testID={`transcript-edit-${line.ordinal}`}
            value={draft}
          />
          <View style={journalStyles.row}>
            <PrimaryButton
              label="Save correction"
              onPress={save}
              testID={`transcript-save-${line.ordinal}`}
            />
            <PrimaryButton
              label="Cancel"
              onPress={() => {
                setDraft(undefined);
                setMessage(undefined);
              }}
              secondary
            />
          </View>
        </>
      )}
      {line.state === 'corrected' ? (
        <View style={journalStyles.tag}>
          <Text style={journalStyles.tagText}>Edited by you</Text>
        </View>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={journalStyles.error}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  source: { marginTop: 20 },
  sectionTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
  },
  noticeTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  line: { paddingVertical: 10 },
  position: { alignSelf: 'center' },
});
