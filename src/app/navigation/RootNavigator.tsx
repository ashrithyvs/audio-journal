import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';

import { useAppLock } from '../../features/app-lock/application/AppLockContext';
import { SetupLockScreen } from '../../features/app-lock/ui/SetupLockScreen';
import { UnlockScreen } from '../../features/app-lock/ui/UnlockScreen';
import { colors } from '../../theme/colors';
import { MainNavigator } from './MainNavigator';

export function RootNavigator() {
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

  return (
    <NavigationContainer>
      <MainNavigator />
    </NavigationContainer>
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
