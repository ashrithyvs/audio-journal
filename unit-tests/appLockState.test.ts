import {
  appLockReducer,
  initialAppLockState,
} from '../src/features/app-lock/domain/AppLockState';
import { validateScaffoldPin } from '../src/features/app-lock/domain/pinPolicy';

describe('app lock state machine', () => {
  it('starts fail-closed while credential state is checked', () => {
    expect(initialAppLockState.phase).toBe('checking');
  });

  it('allows only a configured lock to become unlocked', () => {
    const locked = appLockReducer(initialAppLockState, {
      type: 'BOOTSTRAPPED',
      configured: true,
      biometricAvailable: false,
      biometricEnabled: false,
    });
    const unlocking = appLockReducer(locked, { type: 'BEGIN_UNLOCK' });
    const unlocked = appLockReducer(unlocking, { type: 'UNLOCKED' });
    expect([locked.phase, unlocking.phase, unlocked.phase]).toEqual([
      'locked',
      'unlocking',
      'unlocked',
    ]);
  });

  it('returns to the locked shell after an authentication failure', () => {
    const failed = appLockReducer(
      { ...initialAppLockState, phase: 'unlocking' },
      { type: 'AUTH_FAILED', message: 'No match' },
    );
    expect(failed).toMatchObject({ phase: 'locked', error: 'No match' });
  });

  it('keeps first-run setup available after invalid input', () => {
    const failed = appLockReducer(
      { ...initialAppLockState, phase: 'unconfigured' },
      { type: 'AUTH_FAILED', message: 'Invalid PIN' },
    );
    expect(failed).toMatchObject({
      phase: 'unconfigured',
      error: 'Invalid PIN',
    });
  });

  it('locks an unlocked session on lifecycle change', () => {
    expect(
      appLockReducer(
        { ...initialAppLockState, phase: 'unlocked' },
        { type: 'LOCK' },
      ).phase,
    ).toBe('locked');
  });
});

describe('AJ-0 PIN interaction policy', () => {
  it.each(['', '12345', '1234567890123', 'secret'])('rejects %p', pin => {
    expect(validateScaffoldPin(pin).valid).toBe(false);
  });

  it('accepts a bounded numeric PIN for the scaffold', () => {
    expect(validateScaffoldPin('482915').valid).toBe(true);
  });
});
