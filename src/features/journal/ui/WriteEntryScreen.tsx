import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from '../../../theme/colors';
import { PrimaryButton } from '../../app-lock/ui/PrimaryButton';
import { useJournal } from '../application/JournalContext';
import {
  ENTRY_LIMITS,
  validateTitle,
  validateWrittenText,
} from '../domain/entry';
import { journalStyles } from './journalStyles';

// Written entry (AJ-FR-001): saved exactly as typed, offline, with no
// categorization or AI step (ADR-003). A failed save keeps the text.

export function WriteEntryScreen({
  onSaved,
  onCancel,
}: {
  onSaved(entryId: string): void;
  onCancel(): void;
}) {
  const { journal, ids, now, changed } = useJournal();
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const checkedText = validateWrittenText(text);
    const checkedTitle = validateTitle(title);
    if (!checkedText.ok) {
      setMessage(
        checkedText.reason === 'EMPTY'
          ? 'Write something to save.'
          : 'This entry is too long to save as one entry.',
      );
      return;
    }
    if (!checkedTitle.ok) {
      setMessage(
        `Titles can be up to ${ENTRY_LIMITS.maxTitleChars} characters.`,
      );
      return;
    }
    setSaving(true);
    setMessage(undefined);
    try {
      const entry = await journal.createWritten({
        id: ids.next('ent'),
        text: checkedText.text,
        title: checkedTitle.title,
        createdAt: now(),
      });
      changed();
      onSaved(entry.id);
    } catch {
      setMessage('This entry could not be saved. Your text is still here.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={journalStyles.content}
      keyboardShouldPersistTaps="handled"
      style={journalStyles.page}
      testID="write-screen"
    >
      <Text style={journalStyles.kicker}>WRITE</Text>
      <TextInput
        accessibilityLabel="Title (optional)"
        maxLength={ENTRY_LIMITS.maxTitleChars}
        onChangeText={setTitle}
        placeholder="Title (optional)"
        placeholderTextColor={colors.muted}
        style={journalStyles.input}
        testID="write-title"
        value={title}
      />
      <TextInput
        accessibilityLabel="Entry text"
        multiline
        onChangeText={setText}
        placeholder="What do you want to remember?"
        placeholderTextColor={colors.muted}
        style={[journalStyles.input, styles.textArea]}
        testID="write-text"
        textAlignVertical="top"
        value={text}
      />
      {message ? (
        <Text
          accessibilityRole="alert"
          style={journalStyles.error}
          testID="write-message"
        >
          {message}
        </Text>
      ) : null}
      <View style={journalStyles.row}>
        <PrimaryButton
          disabled={saving}
          label={saving ? 'Saving…' : 'Save entry'}
          onPress={save}
          testID="write-save"
        />
        <PrimaryButton
          label="Cancel"
          onPress={onCancel}
          secondary
          testID="write-cancel"
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({ textArea: { minHeight: 220 } });
