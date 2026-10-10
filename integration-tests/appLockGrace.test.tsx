import React from 'react';
import { AppState, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

import {
  AppLockProvider,
  SYSTEM_UI_GRACE_MS,
  useAppLock,
} from '../src/features/app-lock/application/AppLockContext';
import { FakeVaultService } from '../test/FakeVaultService';

// Lock grace for system UI the app opens itself (ADR-017, owner decision
// 2026-10-10): a permission dialog or document picker may keep the app in the
// background for at most two minutes without locking; nothing else may.

const PIN = '482915';
let listeners: Array<(state: string) => void> = [];
let clock = 0;
let spy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  listeners = [];
  clock = 1_000_000;
  spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: string) => void,
  ) => {
    listeners.push(listener);
    return { remove: () => undefined };
  }) as never);
});

afterEach(() => {
  spy.mockRestore();
  jest.useRealTimers();
});

let api: ReturnType<typeof useAppLock> | undefined;

function Probe() {
  api = useAppLock();
  return <Text testID="phase">{api.state.phase}</Text>;
}

async function unlocked() {
  const vault = new FakeVaultService(PIN);
  const view = await render(
    <AppLockProvider services={{ vault, now: () => clock }}>
      <Probe />
    </AppLockProvider>,
  );
  await act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });
  await act(async () => {
    await api!.unlockWithPin(PIN);
  });
  expect(view.getByTestId('phase')).toHaveTextContent('unlocked');
  return { view, vault };
}

const appState = async (state: string) =>
  act(async () => {
    listeners.forEach(listener => listener(state));
  });

const advance = async (ms: number) =>
  act(async () => {
    clock += ms;
    await jest.advanceTimersByTimeAsync(ms);
  });

it('locks at once when the app leaves the foreground on its own', async () => {
  const { view } = await unlocked();
  await appState('background');
  expect(view.getByTestId('phase')).toHaveTextContent('locked');
});

it('does not lock while its own system UI is open, then locks after two minutes', async () => {
  const { view } = await unlocked();
  api!.expectSystemUi();
  await appState('background');
  expect(view.getByTestId('phase')).toHaveTextContent('unlocked');
  await advance(SYSTEM_UI_GRACE_MS - 1);
  expect(view.getByTestId('phase')).toHaveTextContent('unlocked');
  await advance(1);
  expect(view.getByTestId('phase')).toHaveTextContent('locked');
  expect(SYSTEM_UI_GRACE_MS).toBe(120_000);
});

it('ends the grace when the app returns; a later background locks at once', async () => {
  const { view } = await unlocked();
  api!.expectSystemUi();
  await appState('background');
  await appState('active');
  expect(view.getByTestId('phase')).toHaveTextContent('unlocked');
  await appState('background');
  expect(view.getByTestId('phase')).toHaveTextContent('locked');
});

it('locks at once when the grace is released while the app is away', async () => {
  const { view } = await unlocked();
  const release = api!.expectSystemUi();
  await appState('background');
  await act(async () => release());
  expect(view.getByTestId('phase')).toHaveTextContent('locked');
});

it('does not extend the grace past two minutes from when it was requested', async () => {
  const { view } = await unlocked();
  api!.expectSystemUi();
  await advance(SYSTEM_UI_GRACE_MS - 1_000);
  await appState('background');
  await advance(1_000);
  expect(view.getByTestId('phase')).toHaveTextContent('locked');
});

it('a released grace is spent: the next background locks at once', async () => {
  const { view } = await unlocked();
  const release = api!.expectSystemUi();
  release();
  await appState('background');
  expect(view.getByTestId('phase')).toHaveTextContent('locked');
});
