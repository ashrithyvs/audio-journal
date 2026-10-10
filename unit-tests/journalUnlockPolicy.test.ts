import {
  freshAttemptState,
  lockoutDurationMs,
  rebaseOnClockRollback,
  recordFailure,
  recordSuccess,
  unlockAvailability,
  type UnlockAttemptState,
} from '../src/features/journal/domain/unlockPolicy';

const fail = (count: number, at = 1_000): UnlockAttemptState => {
  let state = freshAttemptState;
  for (let index = 0; index < count; index += 1) {
    state = recordFailure(state, at);
  }
  return state;
};

describe('PIN attempt policy (ADR-017)', () => {
  it('allows four failures without delay', () => {
    expect([0, 1, 2, 3, 4].map(lockoutDurationMs)).toEqual([0, 0, 0, 0, 0]);
    expect(unlockAvailability(fail(4), 1_000)).toEqual({ allowed: true });
  });

  it('refuses for 30 s after the fifth failure, doubling up to one hour', () => {
    expect([5, 6, 7, 8, 9, 10, 11, 12, 50].map(lockoutDurationMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
      3_600_000,
    ]);
  });

  it('reports the retry time and then allows exactly one more attempt', () => {
    const state = fail(5, 1_000);
    expect(unlockAvailability(state, 1_000)).toEqual({
      allowed: false,
      retryAt: 31_000,
      remainingMs: 30_000,
    });
    expect(unlockAvailability(state, 30_999)).toMatchObject({ allowed: false });
    expect(unlockAvailability(state, 31_000)).toEqual({ allowed: true });
    const sixth = recordFailure(state, 31_000);
    expect(unlockAvailability(sixth, 31_000)).toMatchObject({
      allowed: false,
      remainingMs: 60_000,
    });
  });

  it('resets on success', () => {
    expect(recordSuccess()).toEqual({ consecutiveFailures: 0 });
    expect(unlockAvailability(recordSuccess(), 0)).toEqual({ allowed: true });
  });

  it('never shortens a lockout when the clock moves backwards', () => {
    const state = fail(6, 1_000_000);
    const behind = unlockAvailability(state, 500_000);
    expect(behind).toEqual({
      allowed: false,
      retryAt: 560_000,
      remainingMs: 60_000,
    });
    // Rebasing bounds a genuine clock reset to one window.
    const rebased = rebaseOnClockRollback(state, 500_000);
    expect(rebased.lastFailureAt).toBe(500_000);
    expect(unlockAvailability(rebased, 560_000)).toEqual({ allowed: true });
    expect(rebaseOnClockRollback(state, 2_000_000)).toBe(state);
  });

  it('survives a restart because it is pure persisted state', () => {
    const persisted = JSON.parse(JSON.stringify(fail(7, 5_000)));
    expect(unlockAvailability(persisted, 5_000)).toMatchObject({
      allowed: false,
      remainingMs: 120_000,
    });
  });
});
