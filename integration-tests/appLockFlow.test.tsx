import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { AppRoot } from '../src/app/AppRoot';
import { makeTestServices } from '../test/makeTestServices';

it('configures a PIN, enters the journal, and locks again', async () => {
  const view = await render(<AppRoot services={makeTestServices()} />);

  await fireEvent.changeText(await view.findByTestId('pin'), '482915');
  await fireEvent.changeText(view.getByTestId('pin-confirmation'), '482915');
  await fireEvent.press(view.getByText('Protect my journal'));

  expect(await view.findByText('What do you want to remember?')).toBeTruthy();
  await fireEvent.press(view.getByText('Settings'));
  await fireEvent.press(await view.findByText('Lock now'));
  expect(await view.findByText('Welcome back')).toBeTruthy();
});

it('keeps PIN fallback available after biometric cancellation', async () => {
  const view = await render(
    <AppRoot
      services={makeTestServices({
        configuredPin: '482915',
        biometricResult: 'cancelled',
      })}
    />,
  );

  expect(await view.findByText('Welcome back')).toBeTruthy();
  await fireEvent.press(await view.findByText('Use biometrics'));
  expect(
    await view.findByText('Biometric unlock was cancelled. Use your PIN.'),
  ).toBeTruthy();
  expect(view.getByLabelText('PIN')).toBeTruthy();
});

it('offers biometric unlock right after first-run setup, without a restart', async () => {
  const view = await render(
    <AppRoot services={makeTestServices({ biometricResult: 'success' })} />,
  );

  await fireEvent.changeText(await view.findByTestId('pin'), '482915');
  await fireEvent.changeText(view.getByTestId('pin-confirmation'), '482915');
  await fireEvent.press(view.getByText('Protect my journal'));

  expect(await view.findByText('What do you want to remember?')).toBeTruthy();
  await fireEvent.press(view.getByText('Settings'));
  expect(await view.findByText('Turn on biometric unlock')).toBeTruthy();
});
