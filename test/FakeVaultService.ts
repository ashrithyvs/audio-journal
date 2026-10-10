import type {
  BiometricState,
  BiometricUnlockResult,
  PinUnlockResult,
  VaultService,
  VaultStatus,
} from '../src/features/app-lock/ports/VaultService';
import {
  freshAttemptState,
  recordFailure,
  recordSuccess,
  unlockAvailability,
  type UnlockAttemptState,
} from '../src/features/journal/domain/unlockPolicy';

export type FakeBiometric =
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'unavailable'
  | 'invalidated';

/**
 * In-memory VaultService with the native vault's outcomes and the shared
 * ADR-017 attempt policy. Holds a plain PIN: tests only.
 */
export class FakeVaultService implements VaultService {
  private pin?: string;
  private unlocked = false;
  private attempts: UnlockAttemptState = freshAttemptState;
  private biometric: BiometricState;
  calls: string[] = [];

  constructor(
    configuredPin?: string,
    private readonly biometricOutcome: FakeBiometric = 'unavailable',
    private readonly now: () => number = Date.now,
  ) {
    this.pin = configuredPin;
    this.biometric =
      biometricOutcome === 'unavailable'
        ? 'not_available'
        : configuredPin === undefined
        ? 'off'
        : 'on';
  }

  async status(): Promise<VaultStatus> {
    if (this.pin === undefined) {
      return { state: 'unconfigured' };
    }
    if (this.unlocked) {
      return { state: 'unlocked', biometric: this.biometric };
    }
    const availability = unlockAvailability(this.attempts, this.now());
    return {
      state: 'locked',
      biometric: this.biometric,
      ...(availability.allowed ? {} : { retryAt: availability.retryAt }),
    };
  }

  async setupPin(pin: string) {
    this.calls.push('setupPin');
    if (this.pin !== undefined) {
      throw new Error('already configured');
    }
    this.pin = pin;
    this.unlocked = true;
  }

  async unlockWithPin(pin: string): Promise<PinUnlockResult> {
    this.calls.push('unlockWithPin');
    if (this.pin === undefined) {
      return { result: 'unavailable' };
    }
    const availability = unlockAvailability(this.attempts, this.now());
    if (!availability.allowed) {
      return { result: 'refused', retryAt: availability.retryAt };
    }
    if (pin !== this.pin) {
      this.attempts = recordFailure(this.attempts, this.now());
      const after = unlockAvailability(this.attempts, this.now());
      return after.allowed
        ? { result: 'wrong_pin' }
        : { result: 'wrong_pin', retryAt: after.retryAt };
    }
    this.attempts = recordSuccess();
    this.unlocked = true;
    return { result: 'unlocked' };
  }

  async unlockWithBiometric(): Promise<BiometricUnlockResult> {
    this.calls.push('unlockWithBiometric');
    switch (this.biometricOutcome) {
      case 'success':
        this.unlocked = true;
        return { result: 'unlocked' };
      case 'invalidated':
        this.biometric = 'invalidated';
        return { result: 'invalidated' };
      case 'unavailable':
        return { result: 'not_available' };
      default:
        return { result: this.biometricOutcome };
    }
  }

  async enableBiometric(): Promise<BiometricUnlockResult> {
    this.biometric = 'on';
    return { result: 'unlocked' };
  }

  async disableBiometric() {
    this.biometric = 'off';
  }

  async changePin(currentPin: string, nextPin: string) {
    const outcome = await this.unlockWithPin(currentPin);
    if (outcome.result === 'unlocked') {
      this.pin = nextPin;
    }
    return outcome;
  }

  async lock() {
    this.calls.push('lock');
    this.unlocked = false;
  }

  async erase() {
    this.pin = undefined;
    this.unlocked = false;
    this.attempts = freshAttemptState;
  }
}
