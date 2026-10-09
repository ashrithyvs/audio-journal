// Keep the packaged SDK's real public tables and error type; only the factory
// that reaches the native TurboModule is replaced. Tests that exercise the
// packaged adapter install their own factory.
jest.mock('@hybrid-ai/react-native', () => ({
  ...jest.requireActual('@hybrid-ai/react-native'),
  createHybridAI: jest.fn(async () => {
    throw new Error('native SDK is not available in Jest');
  }),
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('react-native-screens', () => ({
  ...jest.requireActual('react-native-screens'),
  enableScreens: jest.fn(),
}));
