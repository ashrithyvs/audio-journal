import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';

import { useAppLock } from '../../features/app-lock/application/AppLockContext';
import { SetupLockScreen } from '../../features/app-lock/ui/SetupLockScreen';
import { UnlockScreen } from '../../features/app-lock/ui/UnlockScreen';
import { colors } from '../../theme/colors';
import { JournalGate } from '../JournalGate';
import type { OpenedJournal } from '../openJournal';
import { MainNavigator } from './MainNavigator';

export function RootNavigator({
  openJournal,
}: {
  openJournal: () => Promise<OpenedJournal>;
}) {
  const { state } = useAppLock();

  if (state.phase === 'checking') {
    return (
      <View accessibilityLabel="Opening private journal" style={styles.loading}>
        <ActivityIndicator color={colors.moss} size="large" />
      </View>
    );
  }

  if (state.phase === 'unconfigured') {
    return <SetupLockScreen />;
  }

  if (state.phase !== 'unlocked') {
    return <UnlockScreen />;
  }

  // The journal exists only while unlocked; locking unmounts and closes it.
  return (
    <JournalGate openJournal={openJournal}>
      <NavigationContainer>
        <MainNavigator />
      </NavigationContainer>
    </JournalGate>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
});
