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
}

export type AppLockAction =
  | {
      type: 'BOOTSTRAPPED';
      configured: boolean;
      biometricAvailable: boolean;
      biometricEnabled: boolean;
    }
  | { type: 'BEGIN_UNLOCK' }
  | { type: 'UNLOCKED' }
  | { type: 'AUTH_FAILED'; message: string }
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
      return { ...state, phase: 'unlocked', error: undefined };
    case 'AUTH_FAILED':
      return {
        ...state,
        phase: state.phase === 'unconfigured' ? 'unconfigured' : 'locked',
        error: action.message,
      };
    case 'LOCK':
      return state.phase === 'unconfigured' || state.phase === 'checking'
        ? state
        : { ...state, phase: 'locked', error: undefined };
    case 'FAIL_CLOSED':
      return { ...state, phase: 'locked', error: action.message };
  }
}
