import { fireEvent } from '@testing-library/react-native';

import { FakeHybridAiGateway, pairedRecord } from '../test/FakeHybridAiGateway';
import { flush, renderUnlocked, tab } from '../test/renderApp';

// JS-level smoke of the AJ-3 surface. The packaged native SDK smoke (real
// TurboModule, reference node, one capability request) is the device suite in
// e2e/android/aj3-e2e.mjs.
it('starts the SDK after unlock and reports the pinned package', async () => {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  const { view } = await renderUnlocked(gateway);
  await flush();
  await fireEvent.press(tab(view, 'Settings'));
  expect(await view.findByText('Public package 0.1.0-m5')).toBeTruthy();
  expect(view.getByTestId('settings-sdk-state').props.children).toMatch(
    /^Ready/,
  );
  expect(view.getByTestId('settings-node-state').props.children).toBe(
    'Connected',
  );
});
