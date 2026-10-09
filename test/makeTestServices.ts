import type { AppServices } from '../src/app/AppServices';
import type { BiometricResult } from '../src/features/app-lock/ports/BiometricAuthenticator';
import type { LockCredentialStore } from '../src/features/app-lock/ports/LockCredentialStore';

export function makeTestServices({
  configuredPin,
  biometricResult = 'unavailable',
}: {
  configuredPin?: string;
  biometricResult?: BiometricResult;
} = {}): AppServices {
  let pin = configuredPin;
  const credentials: LockCredentialStore = {
    status: async () => (pin === undefined ? 'unconfigured' : 'configured'),
    enroll: async value => {
      pin = value;
    },
    verify: async value => value === pin,
  };

  return {
    appLock: {
      credentials,
      biometrics: {
        availability: async () => ({
          available: biometricResult !== 'unavailable',
          enabled: biometricResult !== 'unavailable',
        }),
        authenticate: async () => biometricResult,
      },
    },
    hybridAI: {
      initialize: async () => ({
        state: 'ready',
        capabilityCount: 0,
        packageVersion: '0.1.0-m4',
      }),
    },
  };
}
