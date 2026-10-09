import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { useJournal } from '../application/JournalContext';
import {
  formatDayHeading,
  formatDuration,
  formatTimeOfDay,
} from '../domain/format';
import { groupTimeline, type TimelineEntry } from '../domain/timeline';
import { journalStyles } from './journalStyles';

// Diary timeline (UX §2/§7, visual-design §6): raw entries newest first, with
// quiet metadata. Unorganized entries look exactly like organized ones.

export const TIMELINE_PAGE = 50;

type LoadState = 'loading' | 'ready' | 'failed';

export function DiaryScreen({
  onRecord,
  onWrite,
  onOpenEntry,
}: {
  onRecord(): void;
  onWrite(): void;
  onOpenEntry(entryId: string): void;
}) {
  const { journal, revision } = useJournal();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [hasOlder, setHasOlder] = useState(false);

  useEffect(() => {
    let active = true;
    journal.listTimeline({ limit: TIMELINE_PAGE }).then(
      page => {
        if (active) {
          setEntries(page);
          setHasOlder(page.length === TIMELINE_PAGE);
          setLoad('ready');
        }
      },
      () => active && setLoad('failed'),
    );
    return () => {
      active = false;
    };
  }, [journal, revision]);

  const loadOlder = useCallback(async () => {
    const last = entries[entries.length - 1];
    if (!last) {
      return;
    }
    try {
      const page = await journal.listTimeline({
        limit: TIMELINE_PAGE,
        before: { createdAt: last.createdAt, id: last.id },
      });
      setEntries(current => [...current, ...page]);
      setHasOlder(page.length === TIMELINE_PAGE);
    } catch {
      setLoad('failed');
    }
  }, [entries, journal]);

  const sections = groupTimeline(entries).map(section => ({
    title: formatDayHeading(section.dayKey),
    key: section.dayKey,
    data: section.entries,
  }));

  return (
    <SectionList
      contentContainerStyle={journalStyles.content}
      style={journalStyles.page}
      testID="diary-screen"
      sections={sections}
      keyExtractor={item => item.id}
      stickySectionHeadersEnabled={false}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={
        <View>
          <Text style={journalStyles.kicker}>DIARY</Text>
          <Text style={journalStyles.title}>What do you want to remember?</Text>
          <View style={journalStyles.row}>
            <PrimaryButton
              label="Record"
              onPress={onRecord}
              testID="diary-record"
            />
            <PrimaryButton
              label="Write"
              onPress={onWrite}
              secondary
              testID="diary-write"
            />
          </View>
          {load === 'failed' ? (
            <Text accessibilityRole="alert" style={journalStyles.error}>
              Your entries could not be loaded right now. Nothing was changed.
            </Text>
          ) : null}
          {load === 'ready' && entries.length === 0 ? (
            <Text
              style={[journalStyles.muted, styles.empty]}
              testID="diary-empty"
            >
              Nothing here yet. Record or write your first entry; it stays on
              this device.
            </Text>
          ) : null}
        </View>
      }
      renderSectionHeader={({ section }) => (
        <Text accessibilityRole="header" style={journalStyles.dayHeading}>
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => (
        <EntryRow entry={item} onPress={() => onOpenEntry(item.id)} />
      )}
      ListFooterComponent={
        hasOlder ? (
          <View style={styles.footer}>
            <PrimaryButton
              label="Show older entries"
              onPress={loadOlder}
              secondary
              testID="diary-older"
            />
          </View>
        ) : undefined
      }
    />
  );
}

function Separator() {
  return <View style={journalStyles.separator} />;
}

function EntryRow({
  entry,
  onPress,
}: {
  entry: TimelineEntry;
  onPress(): void;
}) {
  const kind =
    entry.kind === 'voice'
      ? `Voice · ${formatDuration(entry.durationMs ?? 0)}`
      : 'Written';
  const time = formatTimeOfDay(entry.createdAt);
  return (
    <Pressable
      accessibilityLabel={`${kind} entry, ${time}${
        entry.status === 'recovery_required' ? ', needs attention' : ''
      }`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.entry, pressed && styles.pressed]}
      testID={`entry-row-${entry.id}`}
    >
      <Text style={journalStyles.meta}>
        {time} · {kind}
      </Text>
      {entry.title ? (
        <Text style={styles.entryTitle}>{entry.title}</Text>
      ) : null}
      {entry.excerpt ? (
        <Text numberOfLines={2} style={journalStyles.muted}>
          {entry.excerpt}
        </Text>
      ) : null}
      {entry.status === 'recovery_required' ? (
        <View style={journalStyles.tag}>
          <Text style={journalStyles.tagText}>Needs attention</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: 24 },
  entry: { paddingVertical: 14 },
  pressed: { backgroundColor: colors.surface },
  entryTitle: {
    color: colors.ink,
    fontFamily: 'serif',
    fontSize: 18,
    marginTop: 4,
  },
  footer: { marginTop: 20 },
});
