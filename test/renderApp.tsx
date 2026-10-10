import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

import { AppRoot } from '../src/app/AppRoot';
import { FakeHybridAiGateway } from './FakeHybridAiGateway';
import { makeTestServices } from './makeTestServices';

export const PIN = '482915';
export const DIARY_COPY = 'What do you want to remember?';

type View = Awaited<ReturnType<typeof render>>;

/** Bottom tabs are addressed by label; screen titles reuse the same words. */
export function tab(view: View, name: string) {
  return view.getByLabelText(new RegExp(`^${name}, tab`));
}

/** Renders the app with a configured PIN and unlocks it. */
export async function renderUnlocked(gateway = new FakeHybridAiGateway()) {
  const view = await render(
    <AppRoot
      services={makeTestServices({ configuredPin: PIN, hybridAI: gateway })}
    />,
  );
  await fireEvent.changeText(await view.findByTestId('unlock-pin'), PIN);
  await fireEvent.press(view.getByText('Unlock'));
  await view.findByText(DIARY_COPY);
  // The journal opens and the timeline loads asynchronously after unlock.
  await flush();
  return { view, gateway };
}

export async function openNodeScreen(view: View) {
  await fireEvent.press(tab(view, 'Settings'));
  await fireEvent.press(await view.findByTestId('open-private-node'));
  await view.findByTestId('node-status-card');
}

export async function openDiagnostics(view: View) {
  await fireEvent.press(tab(view, 'Settings'));
  await fireEvent.press(await view.findByTestId('open-diagnostics'));
  await view.findByTestId('diag-request-card');
}

/** Lets pending promise callbacks (fake SDK events) settle inside act(). */
export async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
