import type {
  BiometricAuthenticator,
  BiometricAvailability,
  BiometricResult,
} from '../ports/BiometricAuthenticator';

export class UnavailableBiometricAuthenticator
  implements BiometricAuthenticator
{
  async availability(): Promise<BiometricAvailability> {
    return { available: false, enabled: false };
  }

  async authenticate(): Promise<BiometricResult> {
    return 'unavailable';
  }
}
