import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAppLock } from '../../features/app-lock/application/AppLockContext';
import { PrimaryButton } from '../../features/app-lock/ui/PrimaryButton';
import { usePrivateNode } from '../../features/private-node/application/PrivateNodeContext';
import { presentConnection } from '../../features/private-node/domain/connectionPresentation';
import { SDK_PACKAGE_VERSION } from '../../platform/hybrid-ai/PackagedHybridAiGateway';
import { colors } from '../../theme/colors';

export function SettingsScreen({
  onOpenNode,
  onOpenDiagnostics,
}: {
  onOpenNode(): void;
  onOpenDiagnostics(): void;
}) {
  const { lock, state: lockState, setBiometricEnabled } = useAppLock();
  const { state, focus } = usePrivateNode();
  const { sdk } = state;
  const sdkStatus =
    sdk.phase === 'ready'
      ? `Ready · ${sdk.capabilityCount} capabilities`
      : sdk.phase === 'unavailable'
      ? `Unavailable · ${sdk.code}`
      : 'Initializing…';
  const connection = presentConnection(
    state.link.status.state,
    focus,
    state.link.operation === 'connecting',
    state.link.mark,
  );

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Settings</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Private AI Node</Text>
        <Text style={styles.value} testID="settings-node-state">
          {connection.label}
        </Text>
        <View style={styles.action}>
          <PrimaryButton
            label="Manage Private AI Node"
            onPress={onOpenNode}
            testID="open-private-node"
          />
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Hybrid AI SDK</Text>
        <Text style={styles.value} testID="settings-sdk-state">
          {sdkStatus}
        </Text>
        <Text style={styles.meta}>Public package {SDK_PACKAGE_VERSION}</Text>
        <View style={styles.action}>
          <PrimaryButton
            label="Developer diagnostics"
            secondary
            onPress={onOpenDiagnostics}
            testID="open-diagnostics"
          />
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>App lock</Text>
        <Text style={styles.meta}>
          Your PIN unlocks an encrypted vault on this device. There is no
          account and no way to recover a forgotten PIN.
        </Text>
        {lockState.notice === 'biometric_invalidated' ? (
          <Text style={styles.meta} testID="biometric-invalidated">
            Biometric unlock was turned off because your device biometrics
            changed. You can turn it on again.
          </Text>
        ) : null}
        {lockState.biometricAvailable ? (
          <View style={styles.action}>
            <PrimaryButton
              label={
                lockState.biometricEnabled
                  ? 'Turn off biometric unlock'
                  : 'Turn on biometric unlock'
              }
              onPress={() => setBiometricEnabled(!lockState.biometricEnabled)}
              secondary
              testID="toggle-biometric"
            />
          </View>
        ) : null}
        <View style={styles.action}>
          <PrimaryButton label="Lock now" onPress={lock} testID="lock-now" />
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
