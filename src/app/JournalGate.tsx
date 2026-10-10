import React, { type PropsWithChildren, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { JournalProvider } from '../features/journal/application/JournalContext';
import { colors } from '../theme/colors';
import type { OpenedJournal } from './openJournal';

/**
 * Mounted only while unlocked. Opens the journal after each unlock and closes
 * it when the app locks (the tree unmounts). If opening or migrating fails,
 * nothing was changed and the user is told so.
 */
export function JournalGate({
  openJournal,
  children,
}: PropsWithChildren<{ openJournal: () => Promise<OpenedJournal> }>) {
  const [opened, setOpened] = useState<OpenedJournal | 'failed'>();

  useEffect(() => {
    let live = true;
    let handle: OpenedJournal | undefined;
    openJournal().then(
      journal => {
        handle = journal;
        if (live) {
          setOpened(journal);
        } else {
          journal.close().catch(() => undefined);
        }
      },
      () => live && setOpened('failed'),
    );
    return () => {
      live = false;
      handle?.close().catch(() => undefined);
    };
  }, [openJournal]);

  if (opened === 'failed') {
    return (
      <View
        accessibilityRole="alert"
        style={styles.center}
        testID="journal-open-failed"
      >
        <Text style={styles.title}>Your journal could not be opened</Text>
        <Text style={styles.body}>
          Nothing was changed or deleted. Lock the app and try again.
        </Text>
      </View>
    );
  }
  if (!opened) {
    return (
      <View accessibilityLabel="Opening your journal" style={styles.center}>
        <ActivityIndicator color={colors.moss} size="large" />
      </View>
    );
  }
  return (
    <JournalProvider services={opened.services}>{children}</JournalProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  body: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
    textAlign: 'center',
  },
});
