import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { colors } from '../../theme/colors';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';
import { JournalNavigator } from './JournalNavigator';
import { SettingsNavigator } from './SettingsNavigator';

export type MainTabParamList = {
  Diary: undefined;
  Organized: undefined;
  Tasks: undefined;
  Settings: undefined;
};

const Tabs = createBottomTabNavigator<MainTabParamList>();

export function MainNavigator() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.moss,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="Diary" component={JournalNavigator} />
      <Tabs.Screen name="Organized">
        {() => (
          <PlaceholderScreen
            title="Organized"
            description="Optional views over your journal will appear here only when you ask."
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen name="Tasks">
        {() => (
          <PlaceholderScreen
            title="Tasks"
            description="Every derived task will retain an exact link to its source."
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen name="Settings" component={SettingsNavigator} />
    </Tabs.Navigator>
  );
}
