import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import {
  useCapture,
  useJournal,
  useLiveTranscript,
} from '../application/JournalContext';
import { formatDuration } from '../domain/format';
import {
  isTerminal,
  type RecordingSessionState,
} from '../domain/recordingSession';
import { journalStyles } from './journalStyles';

// Recording (UX §5, visual-design §6): time, level, live text, and controls.
// No categories, AI status, or model names while the user speaks. Live text
// is a provisional draft from the on-device engine; capture never waits for
// it, and the full pass after Finish replaces it (ADR-017).

export function RecordingScreen({
  autoStart = true,
  onDone,
  onOpenEntry,
  onWriteInstead,
}: {
  autoStart?: boolean;
  onDone(): void;
  onOpenEntry(entryId: string): void;
  onWriteInstead(): void;
}) {
  const { changed } = useJournal();
  const { session, level, controller } = useCapture();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (
      autoStart &&
      !started.current &&
      session.phase === 'idle' &&
      !session.refusal
    ) {
      started.current = true;
      controller.start().catch(() => undefined);
    }
  }, [autoStart, controller, session]);

  const terminal = isTerminal(session);
  useEffect(() => {
    if (terminal) {
      changed();
    }
  }, [changed, terminal]);

  const close = () => {
    controller.acknowledge();
    onDone();
  };

  const capturing = session.phase === 'recording' || session.phase === 'paused';
  return (
    <ScrollView
      contentContainerStyle={journalStyles.content}
      style={journalStyles.page}
      testID="recording-screen"
    >
      <Text style={journalStyles.kicker}>
        {session.phase === 'recording' ? 'RECORDING' : 'VOICE ENTRY'}
      </Text>
      <Text
        accessibilityRole="timer"
        style={journalStyles.timer}
        testID="recording-timer"
      >
        {formatDuration('capturedMs' in session ? session.capturedMs : 0)}
      </Text>
      {capturing ? (
        <View
          accessibilityLabel={`Input level ${Math.round(level * 100)} percent`}
          style={styles.meterTrack}
          testID="recording-level"
        >
          <View
            style={[styles.meterFill, { width: `${Math.round(level * 100)}%` }]}
          />
        </View>
      ) : null}
      <Text
        accessibilityLiveRegion="polite"
        style={[journalStyles.muted, styles.status]}
        testID="recording-status"
      >
        {statusLine(session)}
      </Text>

      {capturing ? <LiveText recordingId={session.recordingId} /> : null}

      {capturing && !confirmDiscard ? (
        <View style={journalStyles.row}>
          {session.phase === 'recording' ? (
            <PrimaryButton
              label="Pause"
              onPress={() => controller.pause()}
              testID="recording-pause"
            />
          ) : (
            <PrimaryButton
              label="Resume"
              onPress={() => controller.resume()}
              testID="recording-resume"
            />
          )}
          <PrimaryButton
            label="Finish"
            onPress={() => controller.finish()}
            secondary
            testID="recording-finish"
          />
          <PrimaryButton
            label="Discard"
            onPress={() => setConfirmDiscard(true)}
            secondary
            testID="recording-discard"
          />
        </View>
      ) : null}

      {capturing && confirmDiscard ? (
        <View
          accessibilityRole="alert"
          style={journalStyles.notice}
          testID="discard-confirm"
        >
          <Text style={styles.warning}>
            Discard this recording? This can't be undone.
          </Text>
          <View style={journalStyles.row}>
            <PrimaryButton
              label="Discard recording"
              onPress={() => {
                setConfirmDiscard(false);
                controller.discard(true).catch(() => undefined);
              }}
              testID="discard-confirm-yes"
            />
            <PrimaryButton
              label="Keep recording"
              onPress={() => setConfirmDiscard(false)}
              secondary
              testID="discard-confirm-no"
            />
          </View>
        </View>
      ) : null}

      {session.phase === 'idle' && session.refusal === 'MICROPHONE_DENIED' ? (
        <View style={journalStyles.row}>
          <PrimaryButton
            label="Write instead"
            onPress={() => {
              controller.acknowledge();
              onWriteInstead();
            }}
            testID="recording-write-instead"
          />
        </View>
      ) : null}

      {terminal || (session.phase === 'idle' && session.refusal) ? (
        <View style={journalStyles.row}>
          {session.phase === 'ready' || session.phase === 'recoverable' ? (
            <PrimaryButton
              label="Open entry"
              onPress={() => {
                const entryId = session.entryId;
                controller.acknowledge();
                onOpenEntry(entryId);
              }}
              testID="recording-open-entry"
            />
          ) : null}
          <PrimaryButton
            label="Done"
            onPress={close}
            secondary
            testID="recording-done"
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

export function statusLine(session: RecordingSessionState): string {
  switch (session.phase) {
    case 'idle':
      switch (session.refusal) {
        case 'STORAGE_EXHAUSTED':
          return 'There is not enough free space to record safely. Free up space and try again.';
        case 'MICROPHONE_DENIED':
          return 'Microphone access is off. You can still write an entry.';
        case 'RECORDER_UNAVAILABLE':
          return 'The recorder is not available right now. Nothing was recorded.';
        default:
          return 'Ready to record.';
      }
    case 'preparing':
      return 'Getting ready…';
    case 'recording':
      return 'Recording · Saved on this device';
    case 'paused':
      return session.reason === 'audio_focus_lost'
        ? 'Paused for a call or another app. Resume when you are ready.'
        : session.reason === 'backgrounded'
        ? 'Paused while Audio Journal was in the background.'
        : 'Paused.';
    case 'finalizing':
      return session.reason === 'storage_low'
        ? 'Storage is almost full, so the recording is being saved now.'
        : session.reason === 'duration_limit'
        ? 'Recordings are limited to 60 minutes, so this one is being saved now.'
        : 'Saving…';
    case 'ready':
      return `Saved on this device · ${formatDuration(session.capturedMs)}`;
    case 'recoverable':
      return `Recording was interrupted. ${formatDuration(
        session.capturedMs,
      )} of audio is safe on this device.`;
    case 'failed':
      return session.cause === 'EMPTY_RECORDING'
        ? 'Nothing was recorded.'
        : 'No audio could be saved for this recording.';
    case 'discarded':
      return 'Recording discarded.';
  }
}

// visual-design.md "Record" token; the shared theme has no record color yet.
const RECORD = '#C85D43';

function LiveText({ recordingId }: { recordingId: string }) {
  const live = useLiveTranscript();
  const lines = live?.recordingId === recordingId ? live.lines : [];
  return (
    <View style={journalStyles.notice} testID="live-transcript">
      {lines.length > 0 ? (
        <Text
          accessibilityLiveRegion="polite"
          style={journalStyles.body}
          testID="live-transcript-text"
        >
          {lines.map(line => line.text).join(' ')}
        </Text>
      ) : (
        <Text style={journalStyles.muted}>
          {live
            ? 'Live text appears here after a few seconds. Your recording does not depend on it.'
            : 'Live text is not available here. Your recording does not depend on it, and a transcript can be made after you finish.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  meterTrack: {
    backgroundColor: colors.border,
    borderRadius: 999,
    height: 8,
    marginTop: 16,
    overflow: 'hidden',
  },
  meterFill: { backgroundColor: RECORD, height: 8 },
  status: { marginTop: 12 },
  warning: { color: colors.ink, fontSize: 15, fontWeight: '700' },
});
