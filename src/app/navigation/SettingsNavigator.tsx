import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { BackupScreen } from '../../features/backup/ui/BackupScreen';
import { LoadLabScreen } from '../../features/load-lab/ui/LoadLabScreen';
import { DiagnosticsScreen } from '../../features/private-node/ui/DiagnosticsScreen';
import { PairNodeScreen } from '../../features/private-node/ui/PairNodeScreen';
import { PrivateNodeScreen } from '../../features/private-node/ui/PrivateNodeScreen';
import { colors } from '../../theme/colors';
import { SettingsScreen } from '../screens/SettingsScreen';

export type SettingsStackParamList = {
  SettingsHome: undefined;
  PrivateNode: undefined;
  PairNode: undefined;
  Diagnostics: undefined;
  LoadLab: undefined;
  Backup: undefined;
};

const Stack = createNativeStackNavigator<SettingsStackParamList>();

export function SettingsNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.moss,
        headerTitleStyle: { color: colors.ink },
      }}
    >
      <Stack.Screen name="SettingsHome" options={{ headerShown: false }}>
        {({ navigation }) => (
          <SettingsScreen
            onOpenNode={() => navigation.navigate('PrivateNode')}
            onOpenDiagnostics={() => navigation.navigate('Diagnostics')}
            onOpenBackup={() => navigation.navigate('Backup')}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="PrivateNode" options={{ title: 'Private AI Node' }}>
        {({ navigation }) => (
          <PrivateNodeScreen onPair={() => navigation.navigate('PairNode')} />
        )}
      </Stack.Screen>
      <Stack.Screen name="PairNode" options={{ title: 'Pair a node' }}>
        {({ navigation }) => (
          <PairNodeScreen onDone={() => navigation.goBack()} />
        )}
      </Stack.Screen>
      <Stack.Screen
        name="Diagnostics"
        options={{ title: 'Developer diagnostics' }}
      >
        {({ navigation }) => (
          <DiagnosticsScreen
            onOpenLoadLab={() => navigation.navigate('LoadLab')}
          />
        )}
      </Stack.Screen>
      <Stack.Screen
        name="Backup"
        component={BackupScreen}
        options={{ title: 'Backup & restore' }}
      />
      <Stack.Screen
        name="LoadLab"
        component={LoadLabScreen}
        options={{ title: 'Load lab' }}
      />
    </Stack.Navigator>
  );
}
