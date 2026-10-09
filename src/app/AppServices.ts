import { UnavailableBiometricAuthenticator } from '../features/app-lock/adapters/UnavailableBiometricAuthenticator';
import { VolatileCredentialStore } from '../features/app-lock/adapters/VolatileCredentialStore';
import type { AppLockServices } from '../features/app-lock/application/AppLockContext';
import type { HybridAiGateway } from '../platform/hybrid-ai/HybridAiGateway';
import { PackagedHybridAiGateway } from '../platform/hybrid-ai/PackagedHybridAiGateway';

export interface AppServices {
  appLock: AppLockServices;
  hybridAI: HybridAiGateway;
}

const credentials = new VolatileCredentialStore();

export const defaultAppServices: AppServices = {
  appLock: {
    credentials,
    biometrics: new UnavailableBiometricAuthenticator(),
  },
  hybridAI: new PackagedHybridAiGateway(),
};
