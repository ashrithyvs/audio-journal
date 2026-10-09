import React, { type PropsWithChildren } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';

export function LockLayout({
  title,
  description,
  children,
}: PropsWithChildren<{ title: string; description: string }>) {
  return (
    <View style={styles.page} testID="lock-shell">
      <View accessible accessibilityRole="header">
        <Text style={styles.eyebrow}>AUDIO JOURNAL</Text>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <View style={styles.form}>{children}</View>
      <Text style={styles.privacy}>
        No account. No public cloud. Your journal stays private.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 48,
    backgroundColor: colors.background,
  },
  eyebrow: {
    color: colors.moss,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 14,
  },
  title: {
    color: colors.ink,
    fontFamily: 'serif',
    fontSize: 38,
    lineHeight: 44,
    marginBottom: 12,
  },
  description: {
    color: colors.muted,
    fontSize: 17,
    lineHeight: 25,
  },
  form: { marginTop: 34, gap: 14 },
  privacy: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 32,
  },
});
