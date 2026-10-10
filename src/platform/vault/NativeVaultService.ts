import NativeAudioJournalVault, {
  type Spec,
} from '../../native/NativeAudioJournalVault';
import type {
  BiometricUnlockResult,
  PinUnlockResult,
  VaultService,
  VaultStatus,
} from '../../features/app-lock/ports/VaultService';

// VaultService over the native vault (ADR-017). Results are parsed and
// checked against the port's closed result sets; anything else fails closed.

const PIN_RESULTS = ['unlocked', 'wrong_pin', 'refused', 'unavailable'];
const BIOMETRIC_RESULTS = [
  'unlocked',
  'failed',
  'cancelled',
  'not_available',
  'invalidated',
];
const STATES = ['unconfigured', 'locked', 'unlocked', 'unavailable'];

function parse<T extends { result?: string; state?: string }>(
  raw: string,
  allowed: readonly string[],
  key: 'result' | 'state',
): T {
  const value = JSON.parse(raw) as T;
  if (!allowed.includes(String(value[key]))) {
    throw new Error('VAULT_PROTOCOL');
  }
  return value;
}

export class NativeVaultService implements VaultService {
  constructor(
    private readonly native: Spec | null | undefined = NativeAudioJournalVault,
  ) {}

  private get vault(): Spec {
    if (!this.native) {
      throw new Error('LOCK_KEY_UNAVAILABLE');
    }
    return this.native;
  }

  async status(): Promise<VaultStatus> {
    if (!this.native) {
      return { state: 'unavailable' };
    }
    return parse<VaultStatus>(await this.native.status(), STATES, 'state');
  }

  setupPin(pin: string) {
    return this.vault.setupPin(pin);
  }

  async unlockWithPin(pin: string): Promise<PinUnlockResult> {
    return parse(await this.vault.unlockWithPin(pin), PIN_RESULTS, 'result');
  }

  async unlockWithBiometric(): Promise<BiometricUnlockResult> {
    return parse(
      await this.vault.unlockWithBiometric(),
      BIOMETRIC_RESULTS,
      'result',
    );
  }

  async enableBiometric(): Promise<BiometricUnlockResult> {
    return parse(
      await this.vault.enableBiometric(),
      BIOMETRIC_RESULTS,
      'result',
    );
  }

  disableBiometric() {
    return this.vault.disableBiometric();
  }

  async changePin(
    currentPin: string,
    nextPin: string,
  ): Promise<PinUnlockResult> {
    return parse(
      await this.vault.changePin(currentPin, nextPin),
      PIN_RESULTS,
      'result',
    );
  }

  lock() {
    return this.vault.lock();
  }

  erase(confirmation: 'ERASE') {
    return this.vault.erase(confirmation);
  }
}
