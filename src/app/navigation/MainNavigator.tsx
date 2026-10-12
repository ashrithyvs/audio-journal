import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { colors } from '../../theme/colors';
import { JournalNavigator } from './JournalNavigator';
import { OrganizedNavigator, TasksNavigator } from './OrganizedNavigators';
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
      <Tabs.Screen name="Organized" component={OrganizedNavigator} />
      <Tabs.Screen name="Tasks" component={TasksNavigator} />
      <Tabs.Screen name="Settings" component={SettingsNavigator} />
    </Tabs.Navigator>
  );
}
