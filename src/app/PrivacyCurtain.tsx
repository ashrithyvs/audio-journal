import React, { useEffect, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors } from '../theme/colors';

export function PrivacyCurtain({ forced }: { forced?: boolean }) {
  const [appState, setAppState] = useState<AppStateStatus>(
    () => (AppState.currentState ?? 'active') as AppStateStatus,
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  const lifecycleRequiresPrivacy =
    appState === 'inactive' || appState === 'background';
  if (!(forced ?? lifecycleRequiresPrivacy)) {
    return null;
  }

  return (
    <View
      accessibilityLabel="Journal content hidden"
      importantForAccessibility="yes"
      pointerEvents="auto"
      style={styles.curtain}
      testID="privacy-curtain"
    >
      <Text style={styles.title}>Audio Journal</Text>
      <Text style={styles.copy}>Private content hidden</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  curtain: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: colors.privacy,
    justifyContent: 'center',
    zIndex: 999,
  },
  title: { color: colors.white, fontFamily: 'serif', fontSize: 30 },
  copy: { color: '#BBC5BB', fontSize: 14, marginTop: 8 },
});
