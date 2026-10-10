import React, {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { IdSource } from '../domain/ids';
import type {
  JournalRepository,
  TranscriptRepository,
} from '../ports/JournalRepository';
import type { PlaybackService } from '../ports/PlaybackService';
import type { RecordingService } from '../ports/RecordingService';
import type {
  LiveTranscriber,
  RecordingTranscriber,
} from '../ports/RecordingTranscriber';
import { CaptureController, type CaptureSnapshot } from './CaptureController';
import {
  LiveTranscriptController,
  type LiveSnapshot,
} from './LiveTranscriptController';
import {
  TranscriptionController,
  type TranscriptionStatus,
} from './TranscriptionController';

// Journal services for the unlocked app. The repositories exist only after the
// vault opens the database, so the provider is mounted inside the unlocked
// tree and unmounted on lock. Screens see ports, never storage adapters.

export interface JournalServices {
  journal: JournalRepository;
  transcripts: TranscriptRepository;
  recorder: RecordingService;
  /** Absent until the native player exists; the UI then hides playback. */
  playback?: PlaybackService;
  /** Absent without an on-device engine; the UI then offers no transcript. */
  transcriber?: RecordingTranscriber;
  /** Live provisional text; absent without an on-device engine. */
  live?: LiveTranscriber;
  ids: IdSource;
  now?: () => number;
}

interface JournalContextValue {
  journal: JournalRepository;
  transcripts: TranscriptRepository;
  capture: CaptureController;
  playback?: PlaybackService;
  transcription?: TranscriptionController;
  live?: LiveTranscriptController;
  ids: IdSource;
  now: () => number;
  /** Increments after any write so lists reload. */
  revision: number;
  changed(): void;
}

const JournalContext = createContext<JournalContextValue | undefined>(
  undefined,
);

export function JournalProvider({
  services,
  children,
}: PropsWithChildren<{ services: JournalServices }>) {
  const [revision, setRevision] = useState(0);
  const now = useMemo(() => services.now ?? Date.now, [services.now]);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  const transcription = useMemo(
    () =>
      services.transcriber
        ? new TranscriptionController({
            transcriber: services.transcriber,
            transcripts: services.transcripts,
            now,
            onSaved: changed,
          })
        : undefined,
    [changed, now, services.transcriber, services.transcripts],
  );
  useEffect(() => () => transcription?.dispose(), [transcription]);
  // After each unlock, recordings still without a full pass are queued
  // (LLD §9 step 5 policy, owner decision 2026-10-10).
  useEffect(() => {
    if (!transcription) {
      return;
    }
    services.transcripts
      .awaitingFinalPass()
      .then(waiting =>
        waiting.forEach(({ recordingId, durationMs }) =>
          transcription.request(recordingId, durationMs, 'automatic'),
        ),
      )
      .catch(() => undefined);
  }, [services.transcripts, transcription]);
  // Set below; the capture's onSaved runs long after both exist.
  const liveRef = useRef<LiveTranscriptController | undefined>(undefined);
  const capture = useMemo(
    () =>
      new CaptureController({
        journal: services.journal,
        recorder: services.recorder,
        ids: services.ids,
        now,
        // A saved capture gets its final pass once live text is stored;
        // capture itself never waits on either.
        onSaved: (recordingId, durationMs) => {
          (liveRef.current?.stop() ?? Promise.resolve()).then(() =>
            transcription?.request(recordingId, durationMs, 'automatic'),
          );
        },
      }),
    [now, services.ids, services.journal, services.recorder, transcription],
  );
  const live = useMemo(
    () =>
      services.live
        ? new LiveTranscriptController({
            live: services.live,
            transcripts: services.transcripts,
            ids: services.ids,
            now,
            capturedMs: () => {
              const session = capture.getSnapshot().session;
              return 'capturedMs' in session ? session.capturedMs : 0;
            },
          })
        : undefined,
    [capture, now, services.ids, services.live, services.transcripts],
  );
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  // Live text follows the capture: on while recording or paused, off after.
  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const follow = () => {
      const session = capture.getSnapshot().session;
      if (session.phase === 'recording' || session.phase === 'paused') {
        live.start(session.recordingId).catch(() => undefined);
      } else {
        live.stop().catch(() => undefined);
      }
    };
    const unsubscribe = capture.subscribe(follow);
    return () => {
      unsubscribe();
      live.stop().catch(() => undefined);
    };
  }, [capture, live]);
  const value = useMemo(
    () => ({
      journal: services.journal,
      transcripts: services.transcripts,
      capture,
      playback: services.playback,
      transcription,
      live,
      ids: services.ids,
      now,
      revision,
      changed,
    }),
    [capture, changed, live, now, revision, services, transcription],
  );
  return (
    <JournalContext.Provider value={value}>{children}</JournalContext.Provider>
  );
}

export function useJournal(): JournalContextValue {
  const value = useContext(JournalContext);
  if (!value) {
    throw new Error('useJournal must be used inside JournalProvider');
  }
  return value;
}

const noSubscription = () => () => undefined;
const noLive: LiveSnapshot = { lines: [] };

/** Live provisional lines of the current (or last) capture. */
export function useLiveTranscript(): LiveSnapshot | undefined {
  const { live } = useJournal();
  const snapshot = useSyncExternalStore(
    live?.subscribe ?? noSubscription,
    live?.getSnapshot ?? (() => noLive),
  );
  return live ? snapshot : undefined;
}

const noTranscriptions: ReadonlyMap<string, TranscriptionStatus> = new Map();

/** The final-pass status of one recording, if any is queued, running, or ended badly. */
export function useTranscriptionStatus(
  recordingId: string | undefined,
): TranscriptionStatus | undefined {
  const { transcription } = useJournal();
  const statuses = useSyncExternalStore(
    transcription?.subscribe ?? noSubscription,
    transcription?.getSnapshot ?? (() => noTranscriptions),
  );
  return recordingId ? statuses.get(recordingId) : undefined;
}

export function useCapture(): CaptureSnapshot & {
  controller: CaptureController;
} {
  const { capture } = useJournal();
  const snapshot = useSyncExternalStore(capture.subscribe, capture.getSnapshot);
  return { ...snapshot, controller: capture };
}
