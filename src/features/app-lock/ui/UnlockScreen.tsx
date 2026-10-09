import React, { useState } from 'react';
import { Text } from 'react-native';

import { colors } from '../../../theme/colors';
import { useAppLock } from '../application/AppLockContext';
import { LockLayout } from './LockLayout';
import { PinField } from './PinField';
import { PrimaryButton } from './PrimaryButton';

export function UnlockScreen() {
  const { state, unlockWithBiometrics, unlockWithPin } = useAppLock();
  const [pin, setPin] = useState('');

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
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
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
    </LockLayout>
  );
}
