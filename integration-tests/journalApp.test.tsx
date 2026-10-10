import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { AppRoot } from '../src/app/AppRoot';
import { waitText } from '../src/features/app-lock/application/AppLockContext';
import { FakeVaultService } from '../test/FakeVaultService';
import { makeTestServices } from '../test/makeTestServices';
import { DIARY_COPY, flush, PIN, tab } from '../test/renderApp';

// The unlocked app over the vault port and a real (in-memory) SQLite journal.

async function unlock(view: Awaited<ReturnType<typeof render>>, pin = PIN) {
  await fireEvent.changeText(await view.findByTestId('unlock-pin'), pin);
  await fireEvent.press(view.getByText('Unlock'));
  await flush();
}

it('writes an entry that survives lock and unlock', async () => {
  const services = makeTestServices({ configuredPin: PIN });
  const view = await render(<AppRoot services={services} />);
  await unlock(view);
  expect(await view.findByText(DIARY_COPY)).toBeTruthy();

  await fireEvent.press(view.getByTestId('diary-write'));
  await fireEvent.changeText(
    await view.findByTestId('write-text'),
    'Kept safe.',
  );
  await fireEvent.press(view.getByTestId('write-save'));
  expect(await view.findByTestId('entry-source-text')).toHaveTextContent(
    'Kept safe.',
  );

  await fireEvent.press(tab(view, 'Settings'));
  await fireEvent.press(await view.findByTestId('lock-now'));
  expect(await view.findByText('Welcome back')).toBeTruthy();
  expect(view.queryByText('Kept safe.')).toBeNull();

  await unlock(view);
  expect(await view.findByText('Kept safe.')).toBeTruthy();
});

it('locks the native vault whenever the app locks', async () => {
  const vault = new FakeVaultService(PIN);
  const view = await render(<AppRoot services={makeTestServices({ vault })} />);
  await unlock(view);
  await fireEvent.press(tab(view, 'Settings'));
  await fireEvent.press(await view.findByTestId('lock-now'));
  await flush();
  expect(vault.calls).toContain('lock');
});

it('explains the attempt-policy lockout and keeps refusing until retry time', async () => {
  let now = 1_000_000;
  const vault = new FakeVaultService(PIN, 'unavailable', () => now);
  const view = await render(
    <AppRoot
      services={{
        ...makeTestServices({ vault }),
        appLock: { vault, now: () => now },
      }}
    />,
  );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await unlock(view, '000000');
  }
  expect(view.getByText('That PIN is not correct.')).toBeTruthy();
  await unlock(view, '000000');
  expect(
    view.getByText('That PIN is not correct. Try again in 30 s.'),
  ).toBeTruthy();
  await unlock(view, PIN);
  expect(
    view.getByText('Too many incorrect PINs. Try again in 30 s.'),
  ).toBeTruthy();
  now += 30_000;
  await unlock(view, PIN);
  expect(await view.findByText(DIARY_COPY)).toBeTruthy();
});

it('turns biometrics off after an enrollment change and keeps the PIN path', async () => {
  const view = await render(
    <AppRoot
      services={makeTestServices({
        configuredPin: PIN,
        biometricResult: 'invalidated',
      })}
    />,
  );
  await fireEvent.press(await view.findByText('Use biometrics'));
  await flush();
  expect(
    view.getByText(
      'Your device biometrics changed, so biometric unlock was turned off. Use your PIN.',
    ),
  ).toBeTruthy();
  expect(view.queryByText('Use biometrics')).toBeNull();
  await unlock(view);
  expect(await view.findByText(DIARY_COPY)).toBeTruthy();
});

it('fails closed when the vault is unavailable', async () => {
  const vault = new FakeVaultService(PIN);
  vault.status = async () => ({ state: 'unavailable' });
  const view = await render(<AppRoot services={makeTestServices({ vault })} />);
  expect(
    await view.findByText('Secure lock storage is unavailable.'),
  ).toBeTruthy();
  expect(view.queryByText(DIARY_COPY)).toBeNull();
});

it('shows a recoverable error when the journal cannot be opened', async () => {
  const services = makeTestServices({ configuredPin: PIN });
  services.openJournal = async () => {
    throw new Error('MIGRATION_FAILED');
  };
  const view = await render(<AppRoot services={services} />);
  await unlock(view);
  expect(await view.findByTestId('journal-open-failed')).toBeTruthy();
});

it('formats coarse lockout waits', () => {
  expect([
    waitText(30_000, 0),
    waitText(89_000, 0),
    waitText(120_000, 0),
    waitText(3_600_000, 0),
    waitText(10, 0),
  ]).toEqual(['30 s', '89 s', '2 min', '60 min', '1 s']);
});

it('erases the journal only after typing ERASE, then starts fresh', async () => {
  const vault = new FakeVaultService(PIN);
  const view = await render(<AppRoot services={makeTestServices({ vault })} />);
  await fireEvent.press(await view.findByTestId('forgot-pin'));
  expect(view.getByText(/cannot bring them back/)).toBeTruthy();
  expect(view.queryByText(/cryptographic/i)).toBeNull();
  await fireEvent.changeText(view.getByTestId('erase-confirmation'), 'erase');
  expect(
    view.getByTestId('erase-confirm').props.accessibilityState,
  ).toMatchObject({
    disabled: true,
  });
  await fireEvent.changeText(view.getByTestId('erase-confirmation'), 'ERASE');
  await fireEvent.press(view.getByTestId('erase-confirm'));
  expect(await view.findByText('Create your private space')).toBeTruthy();
  expect(await vault.status()).toEqual({ state: 'unconfigured' });
});

it('turns biometric unlock on and off from Settings', async () => {
  const vault = new FakeVaultService(PIN, 'success');
  await vault.disableBiometric();
  const view = await render(<AppRoot services={makeTestServices({ vault })} />);
  await unlock(view);
  await fireEvent.press(tab(view, 'Settings'));
  await fireEvent.press(await view.findByText('Turn on biometric unlock'));
  expect(await view.findByText('Turn off biometric unlock')).toBeTruthy();
  await fireEvent.press(view.getByText('Turn off biometric unlock'));
  expect(await view.findByText('Turn on biometric unlock')).toBeTruthy();
});
