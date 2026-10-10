import React, {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { AppState } from 'react-native';

import {
  appLockReducer,
  initialAppLockState,
  type AppLockState,
} from '../domain/AppLockState';
import { validateScaffoldPin } from '../domain/pinPolicy';
import type { VaultService } from '../ports/VaultService';

export interface AppLockServices {
  vault: VaultService;
  now?: () => number;
}

interface AppLockContextValue {
  state: AppLockState;
  configure(pin: string, confirmation: string): Promise<boolean>;
  unlockWithPin(pin: string): Promise<boolean>;
  unlockWithBiometrics(): Promise<boolean>;
  setBiometricEnabled(enabled: boolean): Promise<boolean>;
  /** Forgotten PIN (ADR-017): irreversible; needs the typed word ERASE. */
  eraseJournal(confirmation: string): Promise<boolean>;
  lock(): void;
  /**
   * Call just before opening the app's own system UI (permission dialog,
   * document picker). Until the app is active again, leaving the foreground
   * does not lock, for at most [SYSTEM_UI_GRACE_MS] from now. Returns a
   * release to call when that UI has closed.
   */
  expectSystemUi(): () => void;
}

/**
 * The longest the app's own system UI may keep it in the background without
 * locking (ADR-017, owner decision 2026-10-10). Any other background locks at once.
 */
export const SYSTEM_UI_GRACE_MS = 120_000;

const AppLockContext = createContext<AppLockContextValue | undefined>(
  undefined,
);

/** Coarse wait text ("30 s", "2 min", "1 h") for the attempt policy. */
export function waitText(retryAt: number, now: number): string {
  const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
  if (seconds < 90) {
    return `${seconds} s`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

export function AppLockProvider({
  children,
  services,
}: PropsWithChildren<{ services: AppLockServices }>) {
  const [state, dispatch] = useReducer(appLockReducer, initialAppLockState);
  const { vault } = services;
  const now = services.now ?? Date.now;

  useEffect(() => {
    let live = true;
    vault
      .status()
      .then(status => {
        if (!live) {
          return;
        }
        if (status.state === 'unavailable') {
          dispatch({
            type: 'FAIL_CLOSED',
            message: 'Secure lock storage is unavailable.',
          });
          return;
        }
        const biometric =
          status.state === 'unconfigured' ? 'not_available' : status.biometric;
        dispatch({
          type: 'BOOTSTRAPPED',
          configured: status.state !== 'unconfigured',
          biometricAvailable: biometric !== 'not_available',
          biometricEnabled: biometric === 'on',
          retryAt: status.state === 'locked' ? status.retryAt : undefined,
          notice:
            biometric === 'invalidated' ? 'biometric_invalidated' : undefined,
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
  }, [vault]);

  const lock = useCallback(() => {
    dispatch({ type: 'LOCK' });
    // Zeroes the master key and closes the journal database natively.
    vault.lock().catch(() => undefined);
  }, [vault]);

  // A registered expectation of the app's own system UI, and whether the app
  // is currently away from the foreground.
  const grace = useRef<{
    until: number;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const away = useRef(false);

  const endGrace = useCallback(() => {
    if (grace.current?.timer) {
      clearTimeout(grace.current.timer);
    }
    grace.current = null;
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        away.current = false;
        endGrace();
        return;
      }
      away.current = true;
      const current = grace.current;
      const remaining = current ? current.until - now() : 0;
      if (current && remaining > 0) {
        // The app's own dialog or picker: lock only if it outlasts the grace.
        current.timer ??= setTimeout(() => {
          endGrace();
          lock();
        }, remaining);
        return;
      }
      endGrace();
      lock();
    });
    return () => {
      subscription.remove();
      endGrace();
    };
  }, [endGrace, lock, now]);

  const expectSystemUi = useCallback(() => {
    endGrace();
    const token = { until: now() + SYSTEM_UI_GRACE_MS };
    grace.current = token;
    return () => {
      if (grace.current !== token) {
        return;
      }
      endGrace();
      if (away.current) {
        lock();
      }
    };
  }, [endGrace, lock, now]);

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
        await vault.setupPin(pin);
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
    [vault],
  );

  const unlockWithPin = useCallback(
    async (pin: string) => {
      dispatch({ type: 'BEGIN_UNLOCK' });
      try {
        const outcome = await vault.unlockWithPin(pin);
        switch (outcome.result) {
          case 'unlocked':
            dispatch({ type: 'UNLOCKED' });
            return true;
          case 'wrong_pin':
            dispatch({
              type: 'AUTH_FAILED',
              message: outcome.retryAt
                ? `That PIN is not correct. Try again in ${waitText(
                    outcome.retryAt,
                    now(),
                  )}.`
                : 'That PIN is not correct.',
              retryAt: outcome.retryAt,
            });
            return false;
          case 'refused':
            dispatch({
              type: 'AUTH_FAILED',
              message: `Too many incorrect PINs. Try again in ${waitText(
                outcome.retryAt,
                now(),
              )}.`,
              retryAt: outcome.retryAt,
            });
            return false;
          case 'unavailable':
            dispatch({
              type: 'FAIL_CLOSED',
              message: 'Secure lock storage is unavailable.',
            });
            return false;
        }
      } catch {
        dispatch({
          type: 'FAIL_CLOSED',
          message: 'The PIN could not be checked safely.',
        });
        return false;
      }
    },
    [now, vault],
  );

  const unlockWithBiometrics = useCallback(async () => {
    dispatch({ type: 'BEGIN_UNLOCK' });
    try {
      const outcome = await vault.unlockWithBiometric();
      if (outcome.result === 'unlocked') {
        dispatch({ type: 'UNLOCKED' });
        return true;
      }
      if (outcome.result === 'invalidated') {
        dispatch({ type: 'BIOMETRIC_INVALIDATED' });
      }
      const messages = {
        cancelled: 'Biometric unlock was cancelled. Use your PIN.',
        invalidated:
          'Your device biometrics changed, so biometric unlock was turned off. Use your PIN.',
        failed: 'Biometric unlock failed. Use your PIN.',
        not_available: 'Biometric unlock is unavailable. Use your PIN.',
      };
      dispatch({ type: 'AUTH_FAILED', message: messages[outcome.result] });
      return false;
    } catch {
      dispatch({
        type: 'AUTH_FAILED',
        message: 'Biometric unlock failed. Use your PIN.',
      });
      return false;
    }
  }, [vault]);

  const setBiometricEnabled = useCallback(
    async (enabled: boolean) => {
      try {
        if (enabled) {
          const outcome = await vault.enableBiometric();
          if (outcome.result !== 'unlocked') {
            return false;
          }
        } else {
          await vault.disableBiometric();
        }
        dispatch({ type: 'BIOMETRIC_CHANGED', enabled });
        return true;
      } catch {
        return false;
      }
    },
    [vault],
  );

  const eraseJournal = useCallback(
    async (confirmation: string) => {
      if (confirmation !== 'ERASE') {
        return false;
      }
      try {
        await vault.erase('ERASE');
        dispatch({ type: 'ERASED' });
        return true;
      } catch {
        dispatch({
          type: 'FAIL_CLOSED',
          message: 'The journal could not be erased. Nothing was unlocked.',
        });
        return false;
      }
    },
    [vault],
  );

  const value = useMemo(
    () => ({
      state,
      configure,
      unlockWithPin,
      unlockWithBiometrics,
      setBiometricEnabled,
      eraseJournal,
      lock,
      expectSystemUi,
    }),
    [
      configure,
      eraseJournal,
      expectSystemUi,
      lock,
      setBiometricEnabled,
      state,
      unlockWithBiometrics,
      unlockWithPin,
    ],
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
