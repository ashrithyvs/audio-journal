import { StyleSheet } from 'react-native';

import { colors } from '../../../theme/colors';

// Quiet Archive styles for journal screens (visual-design.md §2-4): serif only
// for dates and titles, tabular numbers for times, separators over cards.

export const journalStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 48 },
  kicker: {
    color: colors.moss,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
  },
  title: {
    color: colors.ink,
    fontFamily: 'serif',
    fontSize: 32,
    marginTop: 8,
  },
  dayHeading: {
    color: colors.ink,
    fontFamily: 'serif',
    fontSize: 20,
    marginBottom: 4,
    marginTop: 24,
  },
  body: { color: colors.ink, fontSize: 17, lineHeight: 26 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  meta: {
    color: colors.muted,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  timer: {
    color: colors.ink,
    fontSize: 48,
    fontVariant: ['tabular-nums'],
    fontWeight: '300',
    marginTop: 24,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  separator: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
  },
  section: { marginTop: 24 },
  notice: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 16,
    padding: 14,
  },
  error: { color: colors.error, fontSize: 14, lineHeight: 21, marginTop: 8 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 17,
    lineHeight: 24,
    marginTop: 12,
    padding: 14,
  },
  tag: {
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tagText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
});
