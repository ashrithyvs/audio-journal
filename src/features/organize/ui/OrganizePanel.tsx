import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { useJournal } from '../../journal/application/JournalContext';
import { journalStyles } from '../../journal/ui/journalStyles';
import { usePrivateNode } from '../../private-node/application/PrivateNodeContext';
import {
  useOrganize,
  useOrganizeSnapshot,
} from '../application/OrganizeContext';
import type {
  OrganizeOutcome,
  PreparedRequest,
} from '../application/OrganizeController';
import type { OrganizeKind } from '../domain/contract';
import type { RefusalReason } from '../domain/request';
import type { StoredDerivation } from '../ports/DerivationRepository';

// The minimum organize surface (AJ-2.1, UX §7): consent before every run,
// progress with counts only, cancel, and the stored result's summary. The
// full Organized and Tasks views are the next stage. Derived text is shown as
// plain text only (security §7).

const STAGE_LABELS: Record<string, string> = {
  received: 'Received by your node',
  segmenting: 'Reading your entries',
  extracting: 'Finding tasks and ideas',
  checking: 'Checking the result',
};

const KIND_LABELS: Record<OrganizeKind, [string, string]> = {
  summary: ['summary', 'summary'],
  sections: ['section', 'sections'],
  tasks: ['task', 'tasks'],
  ideas: ['idea', 'ideas'],
  people: ['person', 'people'],
  projects: ['project', 'projects'],
};

const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`;

function refusalText(reason: RefusalReason): string {
  switch (reason) {
    case 'NOTHING_TO_ORGANIZE':
      return 'There is nothing to organize yet. A voice entry needs a finished transcript first.';
    case 'TOO_MANY_ENTRIES':
      return 'Choose at most 20 entries at a time.';
    case 'TOO_MANY_UNITS':
    case 'TOO_LARGE':
      return 'This is too long to send in one request. Nothing was sent or shortened.';
    case 'UNSENDABLE_TEXT':
      return 'This entry contains characters that cannot be sent. Nothing was sent.';
    default:
      return `This request could not be prepared (${reason}). Nothing was sent.`;
  }
}

function outcomeText(outcome: OrganizeOutcome): string {
  switch (outcome.kind) {
    case 'stored':
      return 'Organized. Your entry is unchanged.';
    case 'duplicate':
      return 'Already organized. Nothing new was saved.';
    case 'invalid':
      return 'The node returned a result that could not be used. Nothing was saved.';
    case 'cancelled':
      return 'Cancelled. Nothing was saved.';
    case 'failed':
      if (outcome.code === 'DEADLINE_EXCEEDED') {
        return 'Your node did not finish in time. Nothing was saved.';
      }
      if (outcome.code === 'STORAGE_FAILED') {
        return 'The result could not be saved. Nothing was changed.';
      }
      return `Organizing did not finish (${outcome.code}). Nothing was saved.`;
  }
}

function counted(output: StoredDerivation['output']): string {
  const parts: string[] = [];
  if (output.tasks) parts.push(plural(output.tasks.length, KIND_LABELS.tasks));
  if (output.ideas) parts.push(plural(output.ideas.length, KIND_LABELS.ideas));
  if (output.people)
    parts.push(plural(output.people.length, KIND_LABELS.people));
  if (output.projects)
    parts.push(plural(output.projects.length, KIND_LABELS.projects));
  return parts.join(' · ');
}

function DerivationSummary({ derivation }: { derivation: StoredDerivation }) {
  const { output } = derivation;
  return (
    <View style={styles.block} testID="organize-result">
      <Text style={journalStyles.meta}>
        {`Organized by your Private AI Node · revision ${derivation.revision}`}
      </Text>
      {output.summary ? (
        <Text
          style={[journalStyles.body, styles.gap]}
          testID="organize-summary"
        >
          {output.summary.text}
        </Text>
      ) : null}
      <Text style={[journalStyles.muted, styles.gap]} testID="organize-counts">
        {counted(output)}
      </Text>
      {derivation.tasks.map(task => (
        <Text
          key={task.id}
          style={[journalStyles.body, styles.gap]}
          testID={`organize-task-${task.ordinal}`}
        >
          {`• ${task.text}`}
        </Text>
      ))}
    </View>
  );
}

function ConsentSheet({
  request,
  nodeName,
  onSend,
  onDecline,
}: {
  request: PreparedRequest;
  nodeName: string;
  onSend(): void;
  onDecline(): void;
}) {
  const entries = request.included.length;
  return (
    <View
      accessibilityRole="alert"
      style={journalStyles.notice}
      testID="organize-consent"
    >
      <Text style={styles.heading}>Send text to your Private AI Node?</Text>
      <Text style={[journalStyles.muted, styles.gap]}>
        {`${entries === 1 ? 'This entry' : `${entries} entries`} (${plural(
          request.units,
          ['passage', 'passages'],
        )}, ${Math.ceil(
          request.bytes / 1024,
        )} KB of text) will be sent to “${nodeName}” to find a summary, tasks, ideas, people, and projects.`}
      </Text>
      <Text
        style={[journalStyles.muted, styles.gap]}
        testID="organize-consent-text-only"
      >
        Only the finished text is sent. Audio never leaves this phone, and your
        entry is not changed.
      </Text>
      {request.excluded.length > 0 ? (
        <Text
          style={[journalStyles.muted, styles.gap]}
          testID="organize-consent-excluded"
        >
          {`${plural(request.excluded.length, [
            'entry',
            'entries',
          ])} without finished text will not be sent.`}
        </Text>
      ) : null}
      <View style={journalStyles.row}>
        <PrimaryButton
          label="Send text"
          onPress={onSend}
          testID="organize-confirm"
        />
        <PrimaryButton
          label="Not now"
          onPress={onDecline}
          secondary
          testID="organize-decline"
        />
      </View>
    </View>
  );
}

/** Present only where the app provides organize (inside the open journal). */
export function OrganizePanel({ entryId }: { entryId: string }) {
  const organize = useOrganize();
  return organize ? <Panel entryId={entryId} organize={organize} /> : null;
}

function Panel({
  entryId,
  organize,
}: {
  entryId: string;
  organize: NonNullable<ReturnType<typeof useOrganize>>;
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
      {latest ? <DerivationSummary derivation={latest} /> : null}

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

      {view.phase === 'preparing' ? (
        <Text
          style={[journalStyles.muted, styles.gap]}
          testID="organize-preparing"
        >
          Preparing…
        </Text>
      ) : null}

      {view.phase === 'consent' ? (
        <ConsentSheet
          request={view.request}
          nodeName={activeNode?.nodeName ?? 'your node'}
          onSend={() => {
            controller.confirm();
          }}
          onDecline={() => controller.reset()}
        />
      ) : null}

      {view.phase === 'running' ? (
        <View style={journalStyles.notice} testID="organize-running">
          <Text style={journalStyles.body} testID="organize-stage">
            {view.cancelling
              ? 'Cancelling…'
              : view.stage
              ? STAGE_LABELS[view.stage]
              : 'Sending to your node…'}
          </Text>
          {view.fraction !== undefined ? (
            <Text style={journalStyles.meta}>{`${Math.round(
              view.fraction * 100,
            )}%`}</Text>
          ) : null}
          {Object.keys(view.counts).length > 0 ? (
            <Text
              style={[journalStyles.muted, styles.gap]}
              testID="organize-partial-counts"
            >
              {(Object.entries(view.counts) as [OrganizeKind, number][])
                .map(([kind, n]) => plural(n, KIND_LABELS[kind]))
                .join(' · ')}
            </Text>
          ) : null}
          <View style={journalStyles.row}>
            <PrimaryButton
              label="Cancel"
              disabled={view.cancelling}
              onPress={() => controller.cancel()}
              secondary
              testID="organize-cancel"
            />
          </View>
        </View>
      ) : null}

      {view.phase === 'refused' ||
      view.phase === 'existing' ||
      view.phase === 'done' ? (
        <View
          style={journalStyles.notice}
          testID={`organize-${
            view.phase === 'done' ? view.outcome.kind : view.phase
          }`}
        >
          <Text style={journalStyles.body}>
            {view.phase === 'refused'
              ? refusalText(view.reason)
              : view.phase === 'existing'
              ? 'This text was already organized. Nothing was sent.'
              : outcomeText(view.outcome)}
          </Text>
          <View style={journalStyles.row}>
            <PrimaryButton
              label="Done"
              onPress={() => controller.reset()}
              secondary
              testID="organize-done"
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { color: colors.ink, fontFamily: 'serif', fontSize: 20 },
  block: { marginTop: 8 },
  gap: { marginTop: 8 },
});
