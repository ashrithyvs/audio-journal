import type {
  CredentialStatus,
  LockCredentialStore,
} from '../ports/LockCredentialStore';

/**
 * AJ-0-only process-memory verifier. It intentionally provides no persistence
 * or production security claim. Replace it after the lock/key ADR is accepted.
 */
export class VolatileCredentialStore implements LockCredentialStore {
  private verifier?: number;

  async status(): Promise<CredentialStatus> {
    return this.verifier === undefined ? 'unconfigured' : 'configured';
  }

  async enroll(pin: string): Promise<void> {
    this.verifier = scaffoldVerifier(pin);
  }

  async verify(pin: string): Promise<boolean> {
    return (
      this.verifier !== undefined && this.verifier === scaffoldVerifier(pin)
    );
  }
}

// Non-cryptographic by design and never used outside this volatile AJ-0 adapter.
function scaffoldVerifier(value: string): number {
  let result = 17;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) % 2_147_483_647;
  }
  return result;
}
