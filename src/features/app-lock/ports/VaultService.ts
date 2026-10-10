// Vault port (ADR-017), which replaced the AJ-0 LockCredentialStore and
// BiometricAuthenticator scaffolds. The master key, KDF output, and purpose
// keys never cross into JavaScript; results carry only outcomes. The KDF and
// its parameters are native details recorded in the vault file, so this port
// does not change when they are frozen.

export type VaultStatus =
  | { state: 'unconfigured' }
  | {
      state: 'locked';
      biometric: BiometricState;
      /** Set while the attempt policy refuses PIN attempts. */
      retryAt?: number;
    }
  | { state: 'unlocked'; biometric: BiometricState }
  /** Keystore key gone or vault unreadable: fail closed (LOCK_KEY_UNAVAILABLE). */
  | { state: 'unavailable' };

export type BiometricState =
  | 'not_available'
  | 'off'
  | 'on'
  /** Enrollment changed: the biometric copy was deleted; PIN still works. */
  | 'invalidated';

export type PinUnlockResult =
  | { result: 'unlocked' }
  | { result: 'wrong_pin'; retryAt?: number }
  | { result: 'refused'; retryAt: number }
  | { result: 'unavailable' };

export type BiometricUnlockResult =
  | { result: 'unlocked' }
  | { result: 'failed' | 'cancelled' | 'not_available' }
  | { result: 'invalidated' };

export interface VaultService {
  status(): Promise<VaultStatus>;
  setupPin(pin: string): Promise<void>;
  unlockWithPin(pin: string): Promise<PinUnlockResult>;
  unlockWithBiometric(): Promise<BiometricUnlockResult>;
  /** Requires an unlocked vault; creates a fresh biometric key and MK copy. */
  enableBiometric(): Promise<BiometricUnlockResult>;
  disableBiometric(): Promise<void>;
  changePin(currentPin: string, nextPin: string): Promise<PinUnlockResult>;
  /** Zeroes MK and closes the database. */
  lock(): Promise<void>;
  /** Irreversible; the caller has collected typed confirmation. */
  erase(confirmation: 'ERASE'): Promise<void>;
}
