import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { useAppLock } from '../application/AppLockContext';
import { LockLayout } from './LockLayout';
import { PinField } from './PinField';
import { PrimaryButton } from './PrimaryButton';

export function UnlockScreen() {
  const { state, unlockWithBiometrics, unlockWithPin } = useAppLock();
  const [pin, setPin] = useState('');
  const [erasing, setErasing] = useState(false);

  if (erasing) {
    return <EraseJournal onCancel={() => setErasing(false)} />;
  }

  return (
    <LockLayout
      title="Welcome back"
      description="Unlock to open your private journal."
    >
      <PinField
        label="PIN"
        value={pin}
        onChangeText={setPin}
        testID="unlock-pin"
      />
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      <PrimaryButton
        disabled={state.phase === 'unlocking'}
        label={state.phase === 'unlocking' ? 'Unlocking…' : 'Unlock'}
        onPress={() => unlockWithPin(pin)}
      />
      {state.biometricAvailable && state.biometricEnabled ? (
        <PrimaryButton
          label="Use biometrics"
          onPress={() => unlockWithBiometrics()}
          secondary
        />
      ) : null}
      <PrimaryButton
        label="Forgot your PIN?"
        onPress={() => setErasing(true)}
        secondary
        testID="forgot-pin"
      />
    </LockLayout>
  );
}

/**
 * Forgotten PIN (ADR-017): there is no recovery, only Erase journal. It states
 * exactly what is lost and needs the typed word ERASE. It does not claim
 * block-level or cryptographic erasure.
 */
function EraseJournal({ onCancel }: { onCancel(): void }) {
  const { eraseJournal } = useAppLock();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <LockLayout
      title="Erase journal"
      description="Your PIN cannot be recovered: there is no account and no reset email."
    >
      <Text style={styles.body}>
        Erasing removes every entry, recording, transcript, and your PIN from
        this app on this device. Audio Journal cannot bring them back. A backup
        file you saved elsewhere is not affected and can be restored after you
        set a new PIN.
      </Text>
      <Text style={styles.label}>Type ERASE to confirm</Text>
      <TextInput
        accessibilityLabel="Type ERASE to confirm"
        autoCapitalize="characters"
        autoCorrect={false}
        onChangeText={setTyped}
        style={styles.input}
        testID="erase-confirmation"
        value={typed}
      />
      <View style={styles.actions}>
        <PrimaryButton
          disabled={typed !== 'ERASE' || busy}
          label={busy ? 'Erasing…' : 'Erase journal'}
          onPress={async () => {
            setBusy(true);
            await eraseJournal(typed);
            setBusy(false);
          }}
          testID="erase-confirm"
        />
        <PrimaryButton label="Keep my journal" onPress={onCancel} secondary />
      </View>
    </LockLayout>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.error },
  body: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '700', marginTop: 8 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 17,
    padding: 14,
  },
  actions: { gap: 10 },
});
