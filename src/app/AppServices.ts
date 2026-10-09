import { UnavailableBiometricAuthenticator } from '../features/app-lock/adapters/UnavailableBiometricAuthenticator';
import { VolatileCredentialStore } from '../features/app-lock/adapters/VolatileCredentialStore';
import type { AppLockServices } from '../features/app-lock/application/AppLockContext';
import type { PrivateNodeOptions } from '../features/private-node/application/PrivateNodeContext';
import type { HybridAiGateway } from '../platform/hybrid-ai/HybridAiGateway';
import { PackagedHybridAiGateway } from '../platform/hybrid-ai/PackagedHybridAiGateway';

export interface AppServices {
  appLock: AppLockServices;
  hybridAI: HybridAiGateway;
  privateNode?: PrivateNodeOptions;
}

/**
 * Production services. `modelDirectory` comes from the Android launch props:
 * the app-provisioned Hybrid AI local model directory (ADR-016).
 */
export function createDefaultAppServices(modelDirectory?: string): AppServices {
  return {
    appLock: {
      credentials: new VolatileCredentialStore(),
      biometrics: new UnavailableBiometricAuthenticator(),
    },
    hybridAI: new PackagedHybridAiGateway(modelDirectory),
  };
}
