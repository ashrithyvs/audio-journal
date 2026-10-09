// ADR-017 PIN attempt policy: after 5 consecutive failures unlocking is
// refused for 30 s, doubling per further failure up to 1 h. The native vault
// keeps this state in its Keystore-sealed file; the rules live here so both
// platforms and the UI share one definition. It is independent of the KDF.

export const UNLOCK_POLICY = {
  freeFailures: 4,
  firstLockoutMs: 30_000,
  maxLockoutMs: 60 * 60 * 1000,
} as const;

export interface UnlockAttemptState {
  consecutiveFailures: number;
  /** Wall-clock time of the latest failure, if any. */
  lastFailureAt?: number;
}

export const freshAttemptState: UnlockAttemptState = { consecutiveFailures: 0 };

export function lockoutDurationMs(consecutiveFailures: number): number {
  const beyond = consecutiveFailures - UNLOCK_POLICY.freeFailures;
  if (beyond < 1) {
    return 0;
  }
  // 2^7 * 30 s already exceeds the cap; avoid computing huge powers.
  return Math.min(
    UNLOCK_POLICY.firstLockoutMs * 2 ** Math.min(beyond - 1, 8),
    UNLOCK_POLICY.maxLockoutMs,
  );
}

export type UnlockAvailability =
  | { allowed: true }
  | { allowed: false; retryAt: number; remainingMs: number };

/**
 * Whether a PIN attempt may run now. The KDF must not run while refused. A
 * clock set backwards past the last failure restarts the window from `now`
 * (see `rebaseOnClockRollback`), so moving the clock never shortens a lockout
 * and a real clock reset costs at most one window.
 */
export function unlockAvailability(
  state: UnlockAttemptState,
  now: number,
): UnlockAvailability {
  const duration = lockoutDurationMs(state.consecutiveFailures);
  if (duration === 0 || state.lastFailureAt === undefined) {
    return { allowed: true };
  }
  const from = now < state.lastFailureAt ? now : state.lastFailureAt;
  const retryAt = from + duration;
  return now >= retryAt
    ? { allowed: true }
    : { allowed: false, retryAt, remainingMs: retryAt - now };
}

/** Persisted by the vault when it sees the clock behind the last failure. */
export function rebaseOnClockRollback(
  state: UnlockAttemptState,
  now: number,
): UnlockAttemptState {
  return state.lastFailureAt !== undefined && now < state.lastFailureAt
    ? { ...state, lastFailureAt: now }
    : state;
}

export function recordFailure(
  state: UnlockAttemptState,
  now: number,
): UnlockAttemptState {
  return {
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: now,
  };
}

export function recordSuccess(): UnlockAttemptState {
  return freshAttemptState;
}
