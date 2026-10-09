import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../../theme/colors';

export function PlaceholderScreen({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <View style={styles.page}>
      <Text style={styles.date}>TODAY</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.description}>{description}</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>AJ-0 foundation</Text>
        <Text style={styles.cardCopy}>
          Journal content arrives in AJ-1. This screen verifies the navigation
          and privacy shell.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background, padding: 24 },
  date: {
    color: colors.moss,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
  },
  title: {
    color: colors.ink,
    fontFamily: 'serif',
    fontSize: 38,
    marginTop: 10,
  },
  description: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 8,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 32,
    padding: 20,
  },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  cardCopy: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 8 },
});
