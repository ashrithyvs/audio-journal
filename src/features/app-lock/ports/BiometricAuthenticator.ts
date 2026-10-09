export interface BiometricAvailability {
  available: boolean;
  enabled: boolean;
}

export type BiometricResult =
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'unavailable';

export interface BiometricAuthenticator {
  availability(): Promise<BiometricAvailability>;
  authenticate(): Promise<BiometricResult>;
}
