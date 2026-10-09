import React, { useMemo } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';

import { AppLockProvider } from '../features/app-lock/application/AppLockContext';
import { colors } from '../theme/colors';
import { AppRuntimeProvider } from './AppRuntimeContext';
import { defaultAppServices, type AppServices } from './AppServices';
import { RootNavigator } from './navigation/RootNavigator';
import { PrivacyCurtain } from './PrivacyCurtain';

enableScreens();

export function AppRoot({ services }: { services?: AppServices }) {
  const appServices = useMemo(() => services ?? defaultAppServices, [services]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AppLockProvider services={appServices.appLock}>
        <AppRuntimeProvider hybridAI={appServices.hybridAI}>
          <View style={styles.root}>
            <RootNavigator />
            <PrivacyCurtain />
          </View>
        </AppRuntimeProvider>
      </AppLockProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.background, flex: 1 },
});
