import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAppLock } from '../../features/app-lock/application/AppLockContext';
import { PrimaryButton } from '../../features/app-lock/ui/PrimaryButton';
import { colors } from '../../theme/colors';
import { useAppRuntime } from '../AppRuntimeContext';

export function SettingsScreen() {
  const { lock } = useAppLock();
  const runtime = useAppRuntime();
  const sdkStatus =
    runtime.state === 'initializing'
      ? 'Initializing…'
      : runtime.state === 'ready'
      ? `Ready · ${runtime.capabilityCount} capabilities`
      : `Unavailable · ${runtime.code}`;
  const sdkVersion =
    runtime.state === 'initializing' ? '0.1.0-m4' : runtime.packageVersion;

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Settings</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Hybrid AI SDK</Text>
        <Text style={styles.value}>{sdkStatus}</Text>
        <Text style={styles.meta}>Public package {sdkVersion}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>App lock</Text>
        <Text style={styles.meta}>
          AJ-0 uses volatile credentials until the security ADR is accepted.
        </Text>
        <View style={styles.action}>
          <PrimaryButton label="Lock now" onPress={lock} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background, padding: 24 },
  title: {
    color: colors.ink,
    fontFamily: 'serif',
    fontSize: 38,
    marginBottom: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 16,
    padding: 18,
  },
  label: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  value: { color: colors.moss, fontSize: 15, marginTop: 8 },
  meta: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  action: { marginTop: 16 },
});
