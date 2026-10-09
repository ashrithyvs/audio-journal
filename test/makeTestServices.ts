import type { AppServices } from '../src/app/AppServices';
import type { BiometricResult } from '../src/features/app-lock/ports/BiometricAuthenticator';
import type { LockCredentialStore } from '../src/features/app-lock/ports/LockCredentialStore';
import { FakeHybridAiGateway } from './FakeHybridAiGateway';

export function makeTestServices({
  configuredPin,
  biometricResult = 'unavailable',
  hybridAI = new FakeHybridAiGateway(),
}: {
  configuredPin?: string;
  biometricResult?: BiometricResult;
  hybridAI?: FakeHybridAiGateway;
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
    hybridAI,
    privateNode: { pollIntervalMs: 0 },
  };
}
