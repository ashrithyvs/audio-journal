import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { EntryDetailScreen } from '../../features/journal/ui/EntryDetailScreen';
import type { SourceRef } from '../../features/organize/domain/contract';
import {
  OrganizedHistoryScreen,
  OrganizedScreen,
} from '../../features/organize/ui/OrganizedScreen';
import { TasksScreen } from '../../features/organize/ui/TasksScreen';
import { colors } from '../../theme/colors';

// Organized and Tasks tabs (UX §7, ADR-020). Each opens cited sources in its
// own stack, on the entry screen, so Back returns to the list.

type EntryParams = { entryId: string; source?: SourceRef };

export type OrganizedStackParamList = {
  OrganizedHome: undefined;
  History: { scopeKey: string };
  Entry: EntryParams;
};

export type TasksStackParamList = {
  TasksHome: undefined;
  Entry: EntryParams;
};

const Organized = createNativeStackNavigator<OrganizedStackParamList>();
const Tasks = createNativeStackNavigator<TasksStackParamList>();

const screenOptions = {
  contentStyle: { backgroundColor: colors.background },
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.moss,
  headerTitleStyle: { color: colors.ink },
};

export function OrganizedNavigator() {
  return (
    <Organized.Navigator screenOptions={screenOptions}>
      <Organized.Screen name="OrganizedHome" options={{ headerShown: false }}>
        {({ navigation }) => (
          <OrganizedScreen
            onOpenSource={source =>
              navigation.push('Entry', { entryId: source.entryId, source })
            }
            onOpenHistory={scopeKey => navigation.push('History', { scopeKey })}
          />
        )}
      </Organized.Screen>
      <Organized.Screen name="History" options={{ title: 'History' }}>
        {({ route, navigation }) => (
          <OrganizedHistoryScreen
            scopeKey={route.params.scopeKey}
            onOpenSource={source =>
              navigation.push('Entry', { entryId: source.entryId, source })
            }
          />
        )}
      </Organized.Screen>
      <Organized.Screen name="Entry" options={{ title: 'Source' }}>
        {({ route, navigation }) => (
          <EntryDetailScreen
            entryId={route.params.entryId}
            source={route.params.source}
            onOpenSource={source =>
              navigation.push('Entry', { entryId: source.entryId, source })
            }
          />
        )}
      </Organized.Screen>
    </Organized.Navigator>
  );
}

export function TasksNavigator() {
  return (
    <Tasks.Navigator screenOptions={screenOptions}>
      <Tasks.Screen name="TasksHome" options={{ headerShown: false }}>
        {({ navigation }) => (
          <TasksScreen
            onOpenSource={source =>
              navigation.push('Entry', { entryId: source.entryId, source })
            }
          />
        )}
      </Tasks.Screen>
      <Tasks.Screen name="Entry" options={{ title: 'Source' }}>
        {({ route, navigation }) => (
          <EntryDetailScreen
            entryId={route.params.entryId}
            source={route.params.source}
            onOpenSource={source =>
              navigation.push('Entry', { entryId: source.entryId, source })
            }
          />
        )}
      </Tasks.Screen>
    </Tasks.Navigator>
  );
}
