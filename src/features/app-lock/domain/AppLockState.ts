export type AppLockPhase =
  | 'checking'
  | 'unconfigured'
  | 'locked'
  | 'unlocking'
  | 'unlocked';

export interface AppLockState {
  phase: AppLockPhase;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  error?: string;
  /** Set while the ADR-017 attempt policy refuses PIN attempts. */
  retryAt?: number;
  /** Enrollment changed: the biometric copy was removed; PIN still works. */
  notice?: 'biometric_invalidated';
}

export type AppLockAction =
  | {
      type: 'BOOTSTRAPPED';
      configured: boolean;
      biometricAvailable: boolean;
      biometricEnabled: boolean;
      retryAt?: number;
      notice?: 'biometric_invalidated';
    }
  | { type: 'BEGIN_UNLOCK' }
  | { type: 'UNLOCKED' }
  | { type: 'AUTH_FAILED'; message: string; retryAt?: number }
  | { type: 'BIOMETRIC_INVALIDATED' }
  | { type: 'BIOMETRIC_CHANGED'; enabled: boolean }
  | { type: 'ERASED' }
  | { type: 'LOCK' }
  | { type: 'FAIL_CLOSED'; message: string };

export const initialAppLockState: AppLockState = {
  phase: 'checking',
  biometricAvailable: false,
  biometricEnabled: false,
};

export function appLockReducer(
  state: AppLockState,
  action: AppLockAction,
): AppLockState {
  switch (action.type) {
    case 'BOOTSTRAPPED':
      return {
        phase: action.configured ? 'locked' : 'unconfigured',
        biometricAvailable: action.biometricAvailable,
        biometricEnabled: action.configured && action.biometricEnabled,
        retryAt: action.retryAt,
        notice: action.notice,
      };
    case 'BEGIN_UNLOCK':
      if (state.phase !== 'locked') {
        return state;
      }
      return { ...state, phase: 'unlocking', error: undefined };
    case 'UNLOCKED':
      if (state.phase !== 'unlocking' && state.phase !== 'unconfigured') {
        return state;
      }
      return {
        ...state,
        phase: 'unlocked',
        error: undefined,
        retryAt: undefined,
      };
    case 'AUTH_FAILED':
      return {
        ...state,
        phase: state.phase === 'unconfigured' ? 'unconfigured' : 'locked',
        error: action.message,
        retryAt: action.retryAt,
      };
    case 'BIOMETRIC_CHANGED':
      return state.phase === 'unlocked'
        ? { ...state, biometricEnabled: action.enabled, notice: undefined }
        : state;
    case 'ERASED':
      // Back to first-run setup; nothing of the old journal remains reachable.
      return {
        phase: 'unconfigured',
        biometricAvailable: state.biometricAvailable,
        biometricEnabled: false,
      };
    case 'BIOMETRIC_INVALIDATED':
      // PIN fallback stays; biometric unlock is off until re-enabled.
      return {
        ...state,
        biometricEnabled: false,
        notice: 'biometric_invalidated',
      };
    case 'LOCK':
      return state.phase === 'unconfigured' || state.phase === 'checking'
        ? state
        : { ...state, phase: 'locked', error: undefined };
    case 'FAIL_CLOSED':
      return { ...state, phase: 'locked', error: action.message };
  }
}
