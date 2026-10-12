import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { formatEntryMoment, formatRange } from '../../journal/domain/format';
import { journalStyles } from '../../journal/ui/journalStyles';
import type {
  OrganizeController,
  OrganizeOutcome,
  OrganizeSnapshot,
  PreparedRequest,
} from '../application/OrganizeController';
import type { OrganizeKind, SourceRef } from '../domain/contract';
import { omissionNotice } from '../domain/presentation';
import type { RefusalReason } from '../domain/request';
import type { StoredDerivation } from '../ports/DerivationRepository';

// Pieces shared by the entry panel and the Organized view (UX §7): labels,
// source links, the consent sheet, and one organize run's status. Derived
// text is shown as plain text only (security §7).

export const STAGE_LABELS: Record<string, string> = {
  received: 'Received by your node',
  segmenting: 'Reading your entries',
  extracting: 'Finding tasks and ideas',
  checking: 'Checking the result',
};

export const KIND_LABELS: Record<OrganizeKind, [string, string]> = {
  summary: ['summary', 'summary'],
  sections: ['section', 'sections'],
  tasks: ['task', 'tasks'],
  ideas: ['idea', 'ideas'],
  people: ['person', 'people'],
  projects: ['project', 'projects'],
};

export const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`;

export function refusalText(reason: RefusalReason): string {
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

export function outcomeText(outcome: OrganizeOutcome): string {
  switch (outcome.kind) {
    case 'stored':
      return omissionNotice(outcome.derivation.output)
        ? 'Organized, but the result is partial: some lower-ranked items were omitted. Your entry is unchanged.'
        : 'Organized. Your entry is unchanged.';
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

export function counted(output: StoredDerivation['output']): string {
  const parts: string[] = [];
  if (output.tasks) parts.push(plural(output.tasks.length, KIND_LABELS.tasks));
  if (output.ideas) parts.push(plural(output.ideas.length, KIND_LABELS.ideas));
  if (output.people)
    parts.push(plural(output.people.length, KIND_LABELS.people));
  if (output.projects)
    parts.push(plural(output.projects.length, KIND_LABELS.projects));
  return parts.join(' · ');
}

/** The cited excerpt's label: its audio range, or its paragraph. */
export function sourceLabel(source: SourceRef, entryAt?: number): string {
  const at = entryAt === undefined ? '' : ` · ${formatEntryMoment(entryAt)}`;
  if (source.audioStartMs !== undefined && source.audioEndMs !== undefined) {
    return `Source${at} · ${formatRange(
      source.audioStartMs,
      source.audioEndMs,
    )}`;
  }
  const paragraph = /^w(\d+)$/.exec(source.unitId);
  return paragraph
    ? `Source${at} · paragraph ${Number(paragraph[1]) + 1}`
    : `Source${at}`;
}

export function SourceLink({
  source,
  entryAt,
  onOpen,
  testID,
}: {
  source?: SourceRef;
  /** The cited entry's creation time, shown in the label when known. */
  entryAt?: number;
  onOpen?(source: SourceRef): void;
  testID: string;
}) {
  if (!source || !onOpen) {
    return null;
  }
  return (
    <Pressable
      accessibilityHint="Opens the cited part of the entry"
      accessibilityRole="link"
      onPress={() => onOpen(source)}
      testID={testID}
    >
      <Text style={styles.source}>{sourceLabel(source, entryAt)}</Text>
    </Pressable>
  );
}

export function ConsentSheet({
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

/** One organize run's status: preparing, consent, running, or its outcome. */
export function RunStatus({
  view,
  controller,
  nodeName,
}: {
  view: OrganizeSnapshot;
  controller: OrganizeController;
  nodeName: string;
}) {
  return (
    <>
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
          nodeName={nodeName}
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
    </>
  );
}

export const styles = StyleSheet.create({
  heading: { color: colors.ink, fontFamily: 'serif', fontSize: 20 },
  block: { marginTop: 8 },
  gap: { marginTop: 8 },
  source: {
    color: colors.moss,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
});
