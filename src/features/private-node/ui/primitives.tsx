import React, { type PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../../theme/colors';
import type { FailurePresentation } from '../domain/errorPresentation';
import type { Tone } from '../domain/connectionPresentation';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';

export function Page({
  children,
  testID,
}: PropsWithChildren<{ testID?: string }>) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      style={styles.page}
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

export function Card({
  children,
  testID,
}: PropsWithChildren<{ testID?: string }>) {
  return (
    <View style={styles.card} testID={testID}>
      {children}
    </View>
  );
}

export function Heading({ children }: PropsWithChildren) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Label({ children }: PropsWithChildren) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Body({ children }: PropsWithChildren) {
  return <Text style={styles.body}>{children}</Text>;
}

export function Gap() {
  return <View style={styles.gap} />;
}

const toneColors: Record<Tone, { background: string; text: string }> = {
  good: { background: '#DDE8DC', text: colors.moss },
  pending: { background: '#ECE6D3', text: '#6B5A2B' },
  neutral: { background: '#E8E4DA', text: colors.muted },
  warning: { background: '#F1E1C9', text: '#7A4E12' },
  danger: { background: '#F2D9D5', text: colors.error },
};

/** Status with text, not color alone (accessibility requirement). */
export function Pill({
  label,
  tone,
  testID,
}: {
  label: string;
  tone: Tone;
  testID?: string;
}) {
  return (
    <View
      style={[styles.pill, { backgroundColor: toneColors[tone].background }]}
      testID={testID}
    >
      <Text style={[styles.pillText, { color: toneColors[tone].text }]}>
        {label}
      </Text>
    </View>
  );
}

export function FailureNotice({
  presentation,
  actionLabel,
  onAction,
  testID,
}: {
  presentation: FailurePresentation;
  actionLabel?: string;
  onAction?(): void;
  testID?: string;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={styles.failure}
      testID={testID}
    >
      <Text style={styles.failureTitle}>{presentation.title}</Text>
      <Text style={styles.body}>{presentation.message}</Text>
      <Text style={styles.code}>Code: {presentation.code}</Text>
      {actionLabel && onAction ? (
        <View style={styles.action}>
          <PrimaryButton label={actionLabel} onPress={onAction} secondary />
        </View>
      ) : null}
    </View>
  );
}

export const shared = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: { marginTop: 14 },
});

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 48 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 16,
    padding: 18,
  },
  heading: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 12,
    textTransform: 'uppercase',
  },
  body: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 6 },
  gap: { height: 12 },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: { fontSize: 13, fontWeight: '700' },
  failure: {
    backgroundColor: '#FBEFEC',
    borderColor: '#E8C3BD',
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 12,
    padding: 14,
  },
  failureTitle: { color: colors.error, fontSize: 15, fontWeight: '700' },
  code: { color: colors.muted, fontSize: 12, marginTop: 8 },
  action: { marginTop: 12 },
});
