import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { useJournal } from '../../journal/application/JournalContext';
import { journalStyles } from '../../journal/ui/journalStyles';
import { usePrivateNode } from '../../private-node/application/PrivateNodeContext';
import {
  useOrganize,
  useOrganizeSnapshot,
} from '../application/OrganizeContext';
import type { SourceRef } from '../domain/contract';
import { omissionNotice } from '../domain/presentation';
import type { StoredDerivation } from '../ports/DerivationRepository';
import { counted, RunStatus, SourceLink, styles } from './organizeShared';

// The organize surface on entry detail (UX §7): consent before every run,
// progress with counts only, cancel, and the latest result's summary. The
// Organized and Tasks views show every scope. Derived text is shown as
// plain text only (security §7).

function DerivationSummary({
  derivation,
  onOpenSource,
}: {
  derivation: StoredDerivation;
  onOpenSource?(source: SourceRef): void;
}) {
  const { output } = derivation;
  return (
    <View style={styles.block} testID="organize-result">
      <Text style={journalStyles.meta}>
        {`Organized by your Private AI Node · revision ${derivation.revision}`}
      </Text>
      {output.summary ? (
        <>
          <Text
            style={[journalStyles.body, styles.gap]}
            testID="organize-summary"
          >
            {output.summary.text}
          </Text>
          <SourceLink
            source={output.summary.sources[0]}
            onOpen={onOpenSource}
            testID="organize-summary-source"
          />
        </>
      ) : null}
      <Text style={[journalStyles.muted, styles.gap]} testID="organize-counts">
        {counted(output)}
      </Text>
      {omissionNotice(output) ? (
        <Text
          accessibilityRole="alert"
          style={[journalStyles.body, styles.gap]}
          testID="organize-partial"
        >
          {omissionNotice(output)}
        </Text>
      ) : null}
      {derivation.tasks.map(task => (
        <View key={task.id}>
          <Text
            style={[journalStyles.body, styles.gap]}
            testID={`organize-task-${task.ordinal}`}
          >
            {`• ${task.text}`}
          </Text>
          <SourceLink
            source={output.tasks?.[task.ordinal]?.sources[0]}
            onOpen={onOpenSource}
            testID={`organize-task-${task.ordinal}-source`}
          />
        </View>
      ))}
    </View>
  );
}

/** Present only where the app provides organize (inside the open journal). */
export function OrganizePanel({
  entryId,
  onOpenSource,
}: {
  entryId: string;
  /** Opens the entry at a cited source (contract §3.1, UX §7). */
  onOpenSource?(source: SourceRef): void;
}) {
  const organize = useOrganize();
  return organize ? (
    <Panel entryId={entryId} organize={organize} onOpenSource={onOpenSource} />
  ) : null;
}

function Panel({
  entryId,
  organize,
  onOpenSource,
}: {
  entryId: string;
  organize: NonNullable<ReturnType<typeof useOrganize>>;
  onOpenSource?(source: SourceRef): void;
}) {
  const snapshot = useOrganizeSnapshot(organize.controller);
  const { state, activeNode } = usePrivateNode();
  const { revision } = useJournal();
  const [latest, setLatest] = useState<StoredDerivation>();

  useEffect(() => {
    let active = true;
    organize.derivations.latestForEntry(entryId).then(
      found => active && setLatest(found),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [entryId, organize, revision]);

  const { controller } = organize;
  const mine = controller.scope.includes(entryId);
  const view = mine ? snapshot : { phase: 'idle' as const };
  const ready = state.sdk.phase === 'ready' && activeNode !== undefined;
  // One organize at a time: a run for another entry keeps this one waiting.
  const elsewhere =
    !mine && (snapshot.phase === 'running' || snapshot.phase === 'preparing');

  return (
    <View style={journalStyles.section} testID="organize-panel">
      <Text accessibilityRole="header" style={styles.heading}>
        Organize
      </Text>
      {latest ? (
        <DerivationSummary derivation={latest} onOpenSource={onOpenSource} />
      ) : null}

      {view.phase === 'idle' ? (
        <>
          {!ready ? (
            <Text
              style={[journalStyles.muted, styles.gap]}
              testID="organize-unavailable"
            >
              Pair a Private AI Node in Settings to organize entries.
            </Text>
          ) : elsewhere ? (
            <Text
              style={[journalStyles.muted, styles.gap]}
              testID="organize-busy"
            >
              Another entry is being organized. Try again when it finishes.
            </Text>
          ) : null}
          <View style={journalStyles.row}>
            <PrimaryButton
              label={latest ? 'Organize again' : 'Organize with my node'}
              disabled={!ready || elsewhere}
              onPress={() => {
                // The run reports through the snapshot, never the handler.
                controller.prepare([entryId]);
              }}
              secondary
              testID="organize-start"
            />
          </View>
        </>
      ) : null}

      <RunStatus
        view={view}
        controller={controller}
        nodeName={activeNode?.nodeName ?? 'your node'}
      />
    </View>
  );
}
