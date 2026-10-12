import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { DiaryScreen } from '../../features/journal/ui/DiaryScreen';
import { EntryDetailScreen } from '../../features/journal/ui/EntryDetailScreen';
import type { SourceRef } from '../../features/organize/domain/contract';
import { RecordingScreen } from '../../features/journal/ui/RecordingScreen';
import { WriteEntryScreen } from '../../features/journal/ui/WriteEntryScreen';
import { colors } from '../../theme/colors';

export type JournalStackParamList = {
  DiaryHome: undefined;
  Write: undefined;
  Record: undefined;
  /** `source`: a cited source to show, opened from an organized item. */
  Entry: { entryId: string; source?: SourceRef };
};

const Stack = createNativeStackNavigator<JournalStackParamList>();

/** Diary tab: the timeline, then write, record, and entry detail (UX §2). */
export function JournalNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.moss,
        headerTitleStyle: { color: colors.ink },
      }}
    >
      <Stack.Screen name="DiaryHome" options={{ headerShown: false }}>
        {({ navigation }) => (
          <DiaryScreen
            onRecord={() => navigation.navigate('Record')}
            onWrite={() => navigation.navigate('Write')}
            onOpenEntry={entryId => navigation.navigate('Entry', { entryId })}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Write" options={{ title: 'Write' }}>
        {({ navigation }) => (
          <WriteEntryScreen
            onSaved={entryId => navigation.replace('Entry', { entryId })}
            onCancel={() => navigation.goBack()}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Record" options={{ title: 'Record' }}>
        {({ navigation }) => (
          <RecordingScreen
            onDone={() => navigation.goBack()}
            onOpenEntry={entryId => navigation.replace('Entry', { entryId })}
            onWriteInstead={() => navigation.replace('Write')}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Entry" options={{ title: 'Entry' }}>
        {({ route, navigation }) => (
          <EntryDetailScreen
            entryId={route.params.entryId}
            source={route.params.source}
            onOpenSource={source =>
              navigation.push('Entry', { entryId: source.entryId, source })
            }
          />
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}
