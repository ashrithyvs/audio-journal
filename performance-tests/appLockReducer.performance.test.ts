import { performance } from 'node:perf_hooks';

import {
  appLockReducer,
  type AppLockState,
} from '../src/features/app-lock/domain/AppLockState';

it('keeps lock-state transitions negligible at AJ-0 scale', () => {
  const samples: number[] = [];
  let state: AppLockState = {
    phase: 'locked',
    biometricAvailable: true,
    biometricEnabled: true,
  };

  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    const unlocking = appLockReducer(state, { type: 'BEGIN_UNLOCK' });
    const unlocked = appLockReducer(unlocking, { type: 'UNLOCKED' });
    state = appLockReducer(unlocked, { type: 'LOCK' });
    samples.push(performance.now() - started);
  }

  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  expect(p95).toBeLessThan(1);
});
