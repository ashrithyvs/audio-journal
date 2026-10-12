import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { formatTimeOfDay } from '../../journal/domain/format';
import type { JournalEntryDetail } from '../../journal/ports/JournalRepository';
import { journalStyles } from '../../journal/ui/journalStyles';
import type { SourceRef } from '../domain/contract';
import { localDate } from '../domain/dueDates';
import { omissionNotice } from '../domain/presentation';
import { deviceContext } from '../domain/request';
import type { Staleness } from '../domain/staleness';
import { formatCalendarDate } from '../domain/tasks';
import type { StoredDerivation } from '../ports/DerivationRepository';
import { SourceLink } from './organizeShared';

// One organized result (UX §7, ADR-020): its scope, completeness, and every
// item with its source link. A stale item is marked, never hidden. Derived
// text is plain text only (security §7) and is not editable in v1.

export const STALE_LABEL = 'Source changed since organized';

interface Row {
  key: string;
  text: string;
  sources: SourceRef[];
  note?: string;
}

function rows(derivation: StoredDerivation): Array<[string, Row[]]> {
  const { output } = derivation;
  const groups: Array<[string, Row[]]> = [];
  for (const section of output.sections ?? []) {
    groups.push([
      section.area === 'work' ? 'Work' : 'Personal',
      section.items.map((item, i) => ({
        key: `${section.area}:${i}`,
        text: item.text,
        sources: item.sources,
      })),
    ]);
  }
  if (output.tasks?.length) {
    groups.push([
      'Tasks',
      output.tasks.map((task, i) => ({
        key: `task:${i}`,
        text: task.text,
        sources: task.sources,
        note: task.due ? `Due ${formatCalendarDate(task.due.date)}` : undefined,
      })),
    ]);
  }
  const named: Array<
    [
      string,
      string,
      { name?: string; text?: string; sources: SourceRef[] }[] | undefined,
    ]
  > = [
    ['Ideas', 'idea', output.ideas],
    ['People', 'person', output.people],
    ['Projects', 'project', output.projects],
  ];
  for (const [title, kind, list] of named) {
    if (list?.length) {
      groups.push([
        title,
        list.map((item, i) => ({
          key: `${kind}:${i}`,
          text: item.text ?? item.name ?? '',
          sources: item.sources,
        })),
      ]);
    }
  }
  return groups;
}

const tid = (prefix: string, key: string) =>
  `${prefix}-${key.replace(':', '-')}`;

export function DerivationCard({
  derivation,
  testID,
  staleness,
  entries,
  onOpenSource,
  onOpenHistory,
  onReorganize,
  reorganizeDisabled = false,
  footer,
}: {
  derivation: StoredDerivation;
  testID: string;
  staleness?: Staleness;
  entries?: ReadonlyMap<string, JournalEntryDetail | null>;
  onOpenSource?(source: SourceRef): void;
  onOpenHistory?(): void;
  onReorganize?(): void;
  reorganizeDisabled?: boolean;
  /** An organize run for this scope, shown under the card. */
  footer?: ReactNode;
}) {
  const { output } = derivation;
  const stale = (key: string) => staleness?.items.has(key) ?? false;
  const entryAt = (source?: SourceRef) =>
    source && entries?.get(source.entryId)?.entry.createdAt;
  const dates = derivation.entryIds
    .map(id => entries?.get(id)?.entry.createdAt)
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b);
  const scope =
    derivation.entryIds.length === 1
      ? '1 entry'
      : `${derivation.entryIds.length} entries`;
  const first = dates.length
    ? localDate(dates[0], deviceContext().timeZone)
    : null;
  const when = first
    ? ` · ${formatCalendarDate(
        `${first.y}-${String(first.m).padStart(2, '0')}-${String(
          first.d,
        ).padStart(2, '0')}`,
      )}`
    : '';
  const partial = omissionNotice(output);

  return (
    <View style={styles.card} testID={testID}>
      <Text style={journalStyles.meta} testID={`${testID}-scope`}>
        {`${scope}${when} · revision ${
          derivation.revision
        } · organized at ${formatTimeOfDay(derivation.createdAt)}`}
      </Text>
      {staleness?.stale ? (
        <View style={styles.banner} testID={`${testID}-stale`}>
          <Text style={journalStyles.body}>
            Some sources changed since this was organized. Marked items may no
            longer match your entries.
          </Text>
          {onReorganize ? (
            <View style={journalStyles.row}>
              <PrimaryButton
                label="Reorganize"
                disabled={reorganizeDisabled}
                onPress={onReorganize}
                secondary
                testID={`${testID}-reorganize`}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {partial ? (
        <Text
          accessibilityRole="alert"
          style={[journalStyles.body, styles.gap]}
          testID={`${testID}-partial`}
        >
          {partial}
        </Text>
      ) : null}
      {output.summary ? (
        <View style={styles.gap}>
          <Text style={journalStyles.body} testID={`${testID}-summary`}>
            {output.summary.text}
          </Text>
          {stale('summary') ? (
            <Text style={styles.stale} testID={`${testID}-stale-summary`}>
              {STALE_LABEL}
            </Text>
          ) : null}
          <SourceLink
            source={output.summary.sources[0]}
            entryAt={entryAt(output.summary.sources[0])}
            onOpen={onOpenSource}
            testID={`${testID}-source-summary`}
          />
        </View>
      ) : null}
      {rows(derivation).map(([title, items]) => (
        <View key={title} style={styles.group}>
          <Text style={styles.groupTitle}>{title}</Text>
          {items.map(row => (
            <View key={row.key} style={styles.item}>
              <Text
                style={journalStyles.body}
                testID={tid(`${testID}-item`, row.key)}
              >
                {`• ${row.text}`}
              </Text>
              {row.note ? (
                <Text style={journalStyles.meta}>{row.note}</Text>
              ) : null}
              {stale(row.key) ? (
                <Text
                  style={styles.stale}
                  testID={tid(`${testID}-stale`, row.key)}
                >
                  {STALE_LABEL}
                </Text>
              ) : null}
              <SourceLink
                source={row.sources[0]}
                entryAt={entryAt(row.sources[0])}
                onOpen={onOpenSource}
                testID={tid(`${testID}-source`, row.key)}
              />
            </View>
          ))}
        </View>
      ))}
      {onOpenHistory && derivation.revision > 1 ? (
        <View style={journalStyles.row}>
          <PrimaryButton
            label={`History · ${derivation.revision} revisions`}
            onPress={onOpenHistory}
            secondary
            testID={`${testID}-history`}
          />
        </View>
      ) : null}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 16,
    padding: 14,
  },
  banner: {
    backgroundColor: '#F1E1C9',
    borderRadius: 10,
    marginTop: 10,
    padding: 10,
  },
  stale: {
    color: '#7A4E12',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  gap: { marginTop: 10 },
  group: { marginTop: 14 },
  groupTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  item: { marginTop: 6 },
});
