import React, { type PropsWithChildren, type ReactElement } from 'react';
import { act, render } from '@testing-library/react-native';

import {
  JournalProvider,
  type JournalServices,
} from '../../src/features/journal/application/JournalContext';
import type {
  PlaybackEvent,
  PlaybackService,
} from '../../src/features/journal/ports/PlaybackService';
import type {
  LiveTranscriber,
  RecordingTranscriber,
} from '../../src/features/journal/ports/RecordingTranscriber';
import { openJournal } from '../sqlite/journalFixtures';
import { FakeRecordingService } from './FakeRecordingService';

export class FakePlaybackService implements PlaybackService {
  calls: string[] = [];
  listener?: (event: PlaybackEvent) => void;

  async play(
    recordingId: string,
    range: { startMs: number; endMs?: number },
    onEvent: (event: PlaybackEvent) => void,
  ) {
    this.calls.push(`play ${recordingId} ${range.startMs}`);
    this.listener = onEvent;
  }

  async pause() {
    this.calls.push('pause');
  }

  async stop() {
    this.calls.push('stop');
  }
}

/**
 * Journal screens over real SQLite and the scripted recorder. Seed through
 * `context` first, then `render`; the provider is a wrapper, so `rerender`
 * keeps it.
 */
export async function journalHarness(
  options: {
    playback?: PlaybackService;
    transcriber?: RecordingTranscriber;
    live?: LiveTranscriber;
    clock?: () => number;
  } = {},
) {
  const context = await openJournal();
  const recorder = new FakeRecordingService();
  const services: JournalServices = {
    journal: context.journal,
    transcripts: context.transcripts,
    recorder,
    playback: options.playback,
    transcriber: options.transcriber,
    live: options.live,
    ids: context.ids,
    now: options.clock ?? (() => 1_760_000_000_000),
  };
  function Wrapper({ children }: PropsWithChildren) {
    return <JournalProvider services={services}>{children}</JournalProvider>;
  }
  return {
    context,
    recorder,
    services,
    render: (element: ReactElement) => render(element, { wrapper: Wrapper }),
    close: () => context.db.close(),
  };
}

/** Lets repository promises and state updates settle inside act(). */
export async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
