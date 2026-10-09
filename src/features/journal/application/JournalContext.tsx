import React, {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
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
import { CaptureController, type CaptureSnapshot } from './CaptureController';

// Journal services for the unlocked app. The repositories exist only after the
// vault opens the database, so the provider is mounted inside the unlocked
// tree and unmounted on lock. Screens see ports, never storage adapters.

export interface JournalServices {
  journal: JournalRepository;
  transcripts: TranscriptRepository;
  recorder: RecordingService;
  /** Absent until the native player exists; the UI then hides playback. */
  playback?: PlaybackService;
  ids: IdSource;
  now?: () => number;
}

interface JournalContextValue {
  journal: JournalRepository;
  transcripts: TranscriptRepository;
  capture: CaptureController;
  playback?: PlaybackService;
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
  const capture = useMemo(
    () =>
      new CaptureController({
        journal: services.journal,
        recorder: services.recorder,
        ids: services.ids,
        now,
      }),
    [now, services.ids, services.journal, services.recorder],
  );
  const changed = useCallback(() => setRevision(value => value + 1), []);
  const value = useMemo(
    () => ({
      journal: services.journal,
      transcripts: services.transcripts,
      capture,
      playback: services.playback,
      ids: services.ids,
      now,
      revision,
      changed,
    }),
    [capture, changed, now, revision, services],
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

export function useCapture(): CaptureSnapshot & {
  controller: CaptureController;
} {
  const { capture } = useJournal();
  const snapshot = useSyncExternalStore(capture.subscribe, capture.getSnapshot);
  return { ...snapshot, controller: capture };
}
