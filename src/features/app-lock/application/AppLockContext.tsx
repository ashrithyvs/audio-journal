import React, {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import { AppState } from 'react-native';

import {
  appLockReducer,
  initialAppLockState,
  type AppLockState,
} from '../domain/AppLockState';
import { validateScaffoldPin } from '../domain/pinPolicy';
import type { BiometricAuthenticator } from '../ports/BiometricAuthenticator';
import type { LockCredentialStore } from '../ports/LockCredentialStore';

export interface AppLockServices {
  credentials: LockCredentialStore;
  biometrics: BiometricAuthenticator;
}

interface AppLockContextValue {
  state: AppLockState;
  configure(pin: string, confirmation: string): Promise<boolean>;
  unlockWithPin(pin: string): Promise<boolean>;
  unlockWithBiometrics(): Promise<boolean>;
  lock(): void;
}

const AppLockContext = createContext<AppLockContextValue | undefined>(
  undefined,
);

export function AppLockProvider({
  children,
  services,
}: PropsWithChildren<{ services: AppLockServices }>) {
  const [state, dispatch] = useReducer(appLockReducer, initialAppLockState);

  useEffect(() => {
    let live = true;
    Promise.all([
      services.credentials.status(),
      services.biometrics.availability(),
    ])
      .then(([credentialStatus, biometric]) => {
        if (!live) {
          return;
        }
        if (credentialStatus === 'unavailable') {
          dispatch({
            type: 'FAIL_CLOSED',
            message: 'Secure lock storage is unavailable.',
          });
          return;
        }
        dispatch({
          type: 'BOOTSTRAPPED',
          configured: credentialStatus === 'configured',
          biometricAvailable: biometric.available,
          biometricEnabled: biometric.enabled,
        });
      })
      .catch(() => {
        if (live) {
          dispatch({
            type: 'FAIL_CLOSED',
            message: 'The app lock could not be opened safely.',
          });
        }
      });
    return () => {
      live = false;
    };
  }, [services]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active') {
        dispatch({ type: 'LOCK' });
      }
    });
    return () => subscription.remove();
  }, []);

  const configure = useCallback(
    async (pin: string, confirmation: string) => {
      const validation = validateScaffoldPin(pin);
      if (!validation.valid) {
        dispatch({
          type: 'AUTH_FAILED',
          message: validation.message ?? 'Invalid PIN.',
        });
        return false;
      }
      if (pin !== confirmation) {
        dispatch({ type: 'AUTH_FAILED', message: 'PINs do not match.' });
        return false;
      }
      try {
        await services.credentials.enroll(pin);
        dispatch({ type: 'UNLOCKED' });
        return true;
      } catch {
        dispatch({
          type: 'FAIL_CLOSED',
          message: 'The PIN could not be saved safely.',
        });
        return false;
      }
    },
    [services],
  );

  const unlockWithPin = useCallback(
    async (pin: string) => {
      dispatch({ type: 'BEGIN_UNLOCK' });
      try {
        const verified = await services.credentials.verify(pin);
        dispatch(
          verified
            ? { type: 'UNLOCKED' }
            : { type: 'AUTH_FAILED', message: 'That PIN is not correct.' },
        );
        return verified;
      } catch {
        dispatch({
          type: 'FAIL_CLOSED',
          message: 'The PIN could not be checked safely.',
        });
        return false;
      }
    },
    [services],
  );

  const unlockWithBiometrics = useCallback(async () => {
    dispatch({ type: 'BEGIN_UNLOCK' });
    try {
      const result = await services.biometrics.authenticate();
      if (result === 'success') {
        dispatch({ type: 'UNLOCKED' });
        return true;
      }
      dispatch({
        type: 'AUTH_FAILED',
        message:
          result === 'cancelled'
            ? 'Biometric unlock was cancelled. Use your PIN.'
            : 'Biometric unlock is unavailable. Use your PIN.',
      });
      return false;
    } catch {
      dispatch({
        type: 'AUTH_FAILED',
        message: 'Biometric unlock failed. Use your PIN.',
      });
      return false;
    }
  }, [services]);

  const lock = useCallback(() => dispatch({ type: 'LOCK' }), []);
  const value = useMemo(
    () => ({ state, configure, unlockWithPin, unlockWithBiometrics, lock }),
    [configure, lock, state, unlockWithBiometrics, unlockWithPin],
  );

  return (
    <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>
  );
}

export function useAppLock(): AppLockContextValue {
  const value = useContext(AppLockContext);
  if (!value) {
    throw new Error('useAppLock must be used inside AppLockProvider');
  }
  return value;
}
