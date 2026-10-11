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
import {
  useJournal,
  useTranscriptionStatus,
} from '../application/JournalContext';
import type { RecordingRecord } from '../domain/entry';
import {
  formatDayHeading,
  formatDuration,
  formatRange,
  formatTimeOfDay,
} from '../domain/format';
import { localDayKey } from '../domain/timeline';
import type { TranscriptLine } from '../domain/transcript';
import {
  RepositoryError,
  type JournalEntryDetail,
} from '../ports/JournalRepository';
import type { PlaybackEvent } from '../ports/PlaybackService';
import type { SourceRef } from '../../organize/domain/contract';
import { writtenUnits } from '../../organize/domain/request';
import { OrganizePanel } from '../../organize/ui/OrganizePanel';
import { journalStyles } from './journalStyles';

// Entry detail (UX §6): the original audio or written text is primary; the
// transcript follows and can be corrected without changing the recording
// (AJ-FR-004, AJ-FR-012). Corrections are labelled as the user's edits.

type Load =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'failed' }
  | { phase: 'ready'; detail: JournalEntryDetail };

export function EntryDetailScreen({
  entryId,
  source,
  onOpenSource,
}: {
  entryId: string;
  /** A cited source to show, from an organized item (UX §7, AJ-FR-025). */
  source?: SourceRef;
  onOpenSource?(source: SourceRef): void;
}) {
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

      {source && source.entryId === entry.id ? (
        <CitedSource
          source={source}
          detail={load.detail}
          recording={recording}
        />
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
        <View
          style={journalStyles.section}
          testID={`transcript-kind-${transcript.kind}`}
        >
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Transcript
          </Text>
          {transcript.kind === 'empty' ? (
            <Text style={journalStyles.muted} testID="transcript-empty">
              No speech was found in this recording.
            </Text>
          ) : transcript.kind === 'none' ? (
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
              {transcript.lines.map((line, position) => (
                <TranscriptRow
                  cited={
                    source?.entryId === entry.id &&
                    source.unitId === line.segmentId
                  }
                  key={line.originSegmentId}
                  editable={transcript.kind === 'final'}
                  line={line}
                  position={position}
                />
              ))}
            </>
          )}
          {transcript.kind === 'final' || transcript.kind === 'empty' ? null : (
            <TranscriptAction recording={recording} />
          )}
        </View>
      ) : null}
      {entry.status === 'ready' ? (
        <OrganizePanel entryId={entry.id} onOpenSource={onOpenSource} />
      ) : null}
    </ScrollView>
  );
}

/** Starts, follows, or retries the on-device final pass (ADR-017). */
function TranscriptAction({ recording }: { recording?: RecordingRecord }) {
  const { transcription } = useJournal();
  const status = useTranscriptionStatus(recording?.id);
  if (!transcription || recording?.state !== 'ready') {
    return null;
  }
  if (status?.phase === 'queued' || status?.phase === 'running') {
    return (
      <View style={journalStyles.row} testID="transcript-running">
        <Text style={[journalStyles.muted, styles.grow]}>
          Making the transcript on this device…
        </Text>
        <PrimaryButton
          label="Cancel"
          onPress={() => transcription.cancel(recording.id)}
          secondary
          testID="transcript-cancel"
        />
      </View>
    );
  }
  return (
    <View testID="transcript-action">
      {status?.phase === 'failed' ? (
        <Text
          accessibilityRole="alert"
          style={journalStyles.error}
          testID="transcript-failed"
        >
          {status.reason === 'SOURCE_DAMAGED'
            ? 'The recording could not be read in full, so no transcript was made. The recording has not been changed.'
            : 'The transcript could not be made. The recording is safe.'}
        </Text>
      ) : null}
      <PrimaryButton
        label={status?.phase === 'failed' ? 'Try again' : 'Transcribe'}
        onPress={() =>
          transcription.request(recording.id, recording.durationMs)
        }
        testID="transcript-start"
      />
    </View>
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
    } else if (event.type === 'paused') {
      // Paused by the user, by losing audio focus, or by leaving the app.
      setPositionMs(event.positionMs);
      setPlaying(false);
    } else {
      setPlaying(false);
      setFailed(event.type === 'failed');
      if (event.type === 'ended') {
        setPositionMs(0); // the next Play starts from the beginning
      }
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
      {recording.finishReason === 'recovered' ? (
        <Text style={journalStyles.muted} testID="entry-recovered">
          Recording was interrupted; everything captured up to then was saved.
        </Text>
      ) : null}
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

/**
 * The source an organized item cites (contract §3.1): its excerpt, and for a
 * voice entry the exact audio range, played on its own (UX §7).
 */
function CitedSource({
  source,
  detail,
  recording,
}: {
  source: SourceRef;
  detail: JournalEntryDetail;
  recording?: RecordingRecord;
}) {
  const { playback } = useJournal();
  const [state, setState] = useState<'idle' | 'playing' | 'ended' | 'failed'>(
    'idle',
  );
  const [positionMs, setPositionMs] = useState<number>();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      playback?.stop().catch(() => undefined);
    },
    [playback],
  );

  const line = detail.transcript.lines.find(l => l.segmentId === source.unitId);
  const unitText =
    detail.entry.kind === 'voice'
      ? line?.text
      : writtenUnitText(detail.entry.sourceText, source.unitId);
  const excerpt = unitText?.slice(source.charStart, source.charEnd);
  const audio =
    source.audioStartMs !== undefined && source.audioEndMs !== undefined
      ? { startMs: source.audioStartMs, endMs: source.audioEndMs }
      : undefined;

  const play = async () => {
    if (!playback || !recording || !audio) {
      return;
    }
    setState('playing');
    await playback.play(recording.id, audio, event => {
      if (!mounted.current) {
        return;
      }
      if (event.type === 'position' || event.type === 'paused') {
        setPositionMs(event.positionMs);
      }
      if (event.type === 'paused') setState('idle');
      if (event.type === 'ended') setState('ended');
      if (event.type === 'failed') setState('failed');
    });
  };

  return (
    <View style={journalStyles.notice} testID="cited-source">
      <Text style={styles.noticeTitle}>Cited source</Text>
      {audio ? (
        <Text style={journalStyles.meta} testID="cited-range">
          {formatRange(audio.startMs, audio.endMs)}
        </Text>
      ) : null}
      {excerpt ? (
        <Text style={journalStyles.body} testID="cited-text">
          {excerpt}
        </Text>
      ) : (
        <Text style={journalStyles.muted} testID="cited-missing">
          This source is no longer in the current transcript.
        </Text>
      )}
      {audio && playback && recording?.state === 'ready' ? (
        <View style={journalStyles.row}>
          <PrimaryButton
            label={state === 'playing' ? 'Playing…' : 'Play this part'}
            disabled={state === 'playing'}
            onPress={() => {
              play();
            }}
            testID="cited-play"
          />
          <Text
            style={[journalStyles.meta, styles.position]}
            testID="cited-state"
          >
            {state === 'ended'
              ? 'Played'
              : state === 'failed'
              ? 'Could not play'
              : positionMs !== undefined
              ? formatDuration(positionMs)
              : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** A written unit's text: the paragraph `w<n>` as the request split it. */
function writtenUnitText(
  sourceText: string | undefined,
  unitId: string,
): string | undefined {
  const match = /^w(\d+)$/.exec(unitId);
  return match
    ? writtenUnits(sourceText ?? '')[Number(match[1])]?.text
    : undefined;
}

function TranscriptRow({
  line,
  editable,
  position,
  cited = false,
}: {
  line: TranscriptLine;
  editable: boolean;
  /** The line an organized item cites: highlighted. */
  cited?: boolean;
  /** Display order; provisional rows repeat engine ordinals per window. */
  position: number;
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
    <View
      accessibilityState={{ selected: cited }}
      style={[styles.line, cited && styles.cited]}
      testID={cited ? 'transcript-cited' : `transcript-line-${position}`}
    >
      <Text style={journalStyles.meta}>{formatDuration(line.startMs)}</Text>
      {draft === undefined ? (
        <Pressable
          accessibilityHint={editable ? 'Opens a correction field' : undefined}
          accessibilityRole={editable ? 'button' : 'text'}
          disabled={!editable}
          onPress={() => setDraft(line.text)}
          testID={`transcript-text-${position}`}
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
            testID={`transcript-edit-${position}`}
            value={draft}
          />
          <View style={journalStyles.row}>
            <PrimaryButton
              label="Save correction"
              onPress={save}
              testID={`transcript-save-${position}`}
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
  cited: {
    backgroundColor: colors.surface,
    borderLeftColor: colors.moss,
    borderLeftWidth: 3,
    paddingLeft: 10,
  },
  position: { alignSelf: 'center' },
  grow: { alignSelf: 'center', flex: 1 },
});
