import React, { useMemo } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';

import { AppLockProvider } from '../features/app-lock/application/AppLockContext';
import { PrivateNodeProvider } from '../features/private-node/application/PrivateNodeContext';
import { colors } from '../theme/colors';
import { createDefaultAppServices, type AppServices } from './AppServices';
import { RootNavigator } from './navigation/RootNavigator';
import { PrivacyCurtain } from './PrivacyCurtain';

enableScreens();

export function AppRoot({
  services,
  modelDirectory,
}: {
  services?: AppServices;
  /** Native launch prop: app-provisioned local model directory. */
  modelDirectory?: string;
}) {
  const appServices = useMemo(
    () => services ?? createDefaultAppServices(modelDirectory),
    [modelDirectory, services],
  );

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AppLockProvider services={appServices.appLock}>
        <PrivateNodeProvider
          gateway={appServices.hybridAI}
          options={appServices.privateNode}
        >
          <View style={styles.root}>
            <RootNavigator openJournal={appServices.openJournal} />
            <PrivacyCurtain />
          </View>
        </PrivateNodeProvider>
      </AppLockProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.background, flex: 1 },
});
