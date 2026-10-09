const project = (displayName, directory) => ({
  displayName,
  preset: '@react-native/jest-preset',
  rootDir: __dirname,
  testMatch: [`<rootDir>/${directory}/**/*.test.{ts,tsx}`],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((@)?react-native|@react-native(-community)?|@react-navigation)/)',
  ],
});

module.exports = {
  projects: [
    project('unit', 'unit-tests'),
    project('smoke', 'smoke-tests'),
    project('integration', 'integration-tests'),
    project('performance', 'performance-tests'),
  ],
};
