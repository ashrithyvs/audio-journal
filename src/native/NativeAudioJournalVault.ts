import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// App-owned vault (ADR-017). The master key, Argon2id output, and purpose keys
// stay native. Results are JSON objects shaped like the VaultService port's
// result types; they carry outcomes only, never key or biometric material.
export interface Spec extends TurboModule {
  readonly status: () => Promise<string>;
  readonly setupPin: (pin: string) => Promise<void>;
  readonly unlockWithPin: (pin: string) => Promise<string>;
  readonly unlockWithBiometric: () => Promise<string>;
  readonly enableBiometric: () => Promise<string>;
  readonly disableBiometric: () => Promise<void>;
  readonly changePin: (currentPin: string, nextPin: string) => Promise<string>;
  readonly lock: () => Promise<void>;
  readonly erase: (confirmation: string) => Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('AudioJournalVault');
