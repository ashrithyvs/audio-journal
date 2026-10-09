import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors } from '../../../theme/colors';

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        pressed && !secondary && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.label, secondary && styles.secondaryLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.moss,
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
  },
  pressed: { backgroundColor: colors.mossPressed },
  secondary: {
    backgroundColor: 'transparent',
    borderColor: colors.moss,
    borderWidth: 1,
  },
  disabled: { opacity: 0.5 },
  label: { color: colors.white, fontSize: 16, fontWeight: '700' },
  secondaryLabel: { color: colors.moss },
});
