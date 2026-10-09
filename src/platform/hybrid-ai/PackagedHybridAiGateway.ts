import { createHybridAI, HybridAIError } from '@hybrid-ai/react-native';

import type {
  HybridAiGateway,
  HybridAiInitialization,
} from './HybridAiGateway';

const SDK_PACKAGE_VERSION = '0.1.0-m4';

/** Uses only the package's public TypeScript API. */
export class PackagedHybridAiGateway implements HybridAiGateway {
  async initialize(): Promise<HybridAiInitialization> {
    try {
      const hybridAI = await createHybridAI({ pairing: true });
      const capabilities = await hybridAI.capabilities();
      return {
        state: 'ready',
        capabilityCount: capabilities.length,
        packageVersion: SDK_PACKAGE_VERSION,
      };
    } catch (error) {
      return {
        state: 'unavailable',
        code:
          error instanceof HybridAIError
            ? error.code
            : 'SDK_INITIALIZATION_FAILED',
        packageVersion: SDK_PACKAGE_VERSION,
      };
    }
  }
}
