import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { useJournal } from '../../journal/application/JournalContext';
import { journalStyles } from '../../journal/ui/journalStyles';
import { useOrganize } from '../application/OrganizeContext';
import {
  useNewestDerivations,
  useScopeStates,
} from '../application/useOrganized';
import type { SourceRef } from '../domain/contract';
import { isoDate, localDate } from '../domain/dueDates';
import { deviceContext } from '../domain/request';
import {
  dueLabel,
  GROUP_TITLES,
  TASK_GROUPS,
  taskGroup,
  type TaskGroup,
} from '../domain/tasks';
import type {
  DerivedTask,
  StoredDerivation,
  TaskState,
} from '../ports/DerivationRepository';
import { STALE_LABEL } from './DerivationCard';
import { SourceLink } from './organizeShared';

// The Tasks view (UX §7, ADR-020): tasks of the newest revision of every
// scope, grouped by due date against today's local date. A task can be
// marked done, dismissed, or restored; its text is not editable in v1. A task
// whose source changed is marked, never hidden.

interface TaskRow {
  task: DerivedTask;
  derivation: StoredDerivation;
  source?: SourceRef;
  entryAt?: number;
  stale: boolean;
}

/** Today's ISO date in the device's time zone. */
function today(now: number): string {
  const local = localDate(now, deviceContext().timeZone);
  return local
    ? isoDate(Date.UTC(local.y, local.m - 1, local.d))
    : isoDate(now);
}

export function TasksScreen({
  onOpenSource,
}: {
  onOpenSource(source: SourceRef): void;
}) {
  const organize = useOrganize();
  const { now, changed } = useJournal();
  const load = useNewestDerivations();
  const derivations = load.phase === 'ready' ? load.value : [];
  const states = useScopeStates(derivations);
  const day = today(now());

  const groups = new Map<TaskGroup, TaskRow[]>(
    TASK_GROUPS.map(group => [group, []]),
  );
  for (const derivation of derivations) {
    const state = states.get(derivation.id);
    for (const task of derivation.tasks) {
      const source = derivation.output.tasks?.[task.ordinal]?.sources[0];
      groups.get(taskGroup(task.state, task.dueDate, day))!.push({
        task,
        derivation,
        source,
        entryAt: source && state?.entries.get(source.entryId)?.entry.createdAt,
        stale: state?.staleness.items.has(`task:${task.ordinal}`) ?? false,
      });
    }
  }
  for (const rows of groups.values()) {
    rows.sort(
      (a, b) =>
        (a.task.dueDate ?? '9999').localeCompare(b.task.dueDate ?? '9999') ||
        b.derivation.createdAt - a.derivation.createdAt ||
        a.task.ordinal - b.task.ordinal,
    );
  }

  const transition = (task: DerivedTask, state: TaskState) => {
    organize?.derivations
      .setTaskState(task.id, state, now())
      .then(changed, () => undefined);
  };
  const total = derivations.reduce((n, d) => n + d.tasks.length, 0);

  return (
    <ScrollView
      contentContainerStyle={journalStyles.content}
      style={journalStyles.page}
      testID="tasks-screen"
    >
      <Text style={journalStyles.kicker}>TASKS</Text>
      <Text style={journalStyles.title}>Tasks</Text>
      {load.phase === 'failed' ? (
        <Text style={journalStyles.error} testID="tasks-failed">
          Tasks could not be opened right now.
        </Text>
      ) : load.phase === 'ready' && total === 0 ? (
        <Text style={[journalStyles.muted, styles.gap]} testID="tasks-empty">
          No tasks yet. Organize an entry to find its tasks; each keeps a link
          to its source.
        </Text>
      ) : null}
      {TASK_GROUPS.map(group => {
        const rows = groups.get(group)!;
        if (rows.length === 0) {
          return null;
        }
        return (
          <View
            key={group}
            style={styles.group}
            testID={`tasks-group-${group}`}
          >
            <Text accessibilityRole="header" style={styles.groupTitle}>
              {`${GROUP_TITLES[group]} · ${rows.length}`}
            </Text>
            {rows.map((row, i) => {
              const id = `task-${group}-${i}`;
              const open = row.task.state === 'open';
              return (
                <View key={row.task.id} style={styles.row} testID={id}>
                  <Text
                    style={[journalStyles.body, !open && styles.closed]}
                    testID={`${id}-text`}
                  >
                    {row.task.text}
                  </Text>
                  <Text style={journalStyles.meta} testID={`${id}-meta`}>
                    {[
                      row.task.area === 'unsorted'
                        ? undefined
                        : row.task.area === 'work'
                        ? 'Work'
                        : 'Personal',
                      row.task.dueDate
                        ? dueLabel(row.task.dueDate, day)
                        : undefined,
                      row.task.predecessorTaskId
                        ? 'kept from earlier'
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {row.stale ? (
                    <Text style={styles.stale} testID={`${id}-stale`}>
                      {STALE_LABEL}
                    </Text>
                  ) : null}
                  <SourceLink
                    source={row.source}
                    entryAt={row.entryAt}
                    onOpen={onOpenSource}
                    testID={`${id}-source`}
                  />
                  <View style={journalStyles.row}>
                    {open ? (
                      <>
                        <PrimaryButton
                          label="Done"
                          onPress={() => transition(row.task, 'done')}
                          secondary
                          testID={`${id}-done`}
                        />
                        <PrimaryButton
                          label="Dismiss"
                          onPress={() => transition(row.task, 'dismissed')}
                          secondary
                          testID={`${id}-dismiss`}
                        />
                      </>
                    ) : (
                      <PrimaryButton
                        label="Restore"
                        onPress={() => transition(row.task, 'open')}
                        secondary
                        testID={`${id}-restore`}
                      />
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  gap: { marginTop: 8 },
  group: { marginTop: 20 },
  groupTitle: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  row: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  closed: { color: colors.muted, textDecorationLine: 'line-through' },
  stale: { color: '#7A4E12', fontSize: 13, fontWeight: '700', marginTop: 2 },
});
