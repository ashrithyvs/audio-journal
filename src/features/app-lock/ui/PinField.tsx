import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from '../../../theme/colors';

export function PinField({
  label,
  value,
  onChangeText,
  testID,
}: {
  label: string;
  value: string;
  onChangeText(value: string): void;
  testID: string;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoComplete="off"
        importantForAutofill="no"
        keyboardType="number-pad"
        maxLength={12}
        onChangeText={onChangeText}
        secureTextEntry
        style={styles.input}
        testID={testID}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 7,
  },
  input: {
    minHeight: 52,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: 22,
    letterSpacing: 8,
    paddingHorizontal: 16,
  },
});
