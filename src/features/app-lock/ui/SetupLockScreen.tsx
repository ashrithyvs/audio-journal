import React, { useState } from 'react';
import { Text } from 'react-native';

import { colors } from '../../../theme/colors';
import { useAppLock } from '../application/AppLockContext';
import { LockLayout } from './LockLayout';
import { PinField } from './PinField';
import { PrimaryButton } from './PrimaryButton';

export function SetupLockScreen() {
  const { configure, state } = useAppLock();
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');

  return (
    <LockLayout
      title="Create your private space"
      description="Choose a PIN to protect this device. No account or internet connection is required."
    >
      <PinField
        label="Create PIN"
        value={pin}
        onChangeText={setPin}
        testID="pin"
      />
      <PinField
        label="Confirm PIN"
        value={confirmation}
        onChangeText={setConfirmation}
        testID="pin-confirmation"
      />
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {state.error}
        </Text>
      ) : null}
      <PrimaryButton
        label="Protect my journal"
        onPress={() => configure(pin, confirmation)}
      />
      <Text style={styles.prototypeNote}>
        AJ-0 uses a temporary in-memory verifier. Persistent secure storage and
        recovery behavior arrive only after the security design is approved.
      </Text>
    </LockLayout>
  );
}

const styles = {
  prototypeNote: { color: colors.muted, fontSize: 12, lineHeight: 18 },
};
