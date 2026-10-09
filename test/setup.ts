jest.mock(
  '@hybrid-ai/react-native',
  () => ({
    createHybridAI: jest.fn(async () => ({ capabilities: async () => [] })),
    HybridAIError: class HybridAIError extends Error {},
  }),
  { virtual: true },
);

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('react-native-screens', () => ({
  enableScreens: jest.fn(),
  Screen: require('react-native').View,
  ScreenContainer: require('react-native').View,
  ScreenStack: require('react-native').View,
  ScreenStackHeaderConfig: require('react-native').View,
  ScreenStackHeaderSubview: require('react-native').View,
  shouldUseActivityState: false,
}));
