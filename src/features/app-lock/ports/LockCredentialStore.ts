export type CredentialStatus = 'configured' | 'unconfigured' | 'unavailable';

export interface LockCredentialStore {
  status(): Promise<CredentialStatus>;
  enroll(pin: string): Promise<void>;
  verify(pin: string): Promise<boolean>;
}
