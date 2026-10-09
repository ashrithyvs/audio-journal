import React from 'react';
import { render } from '@testing-library/react-native';

import { AppRoot } from '../src/app/AppRoot';
import { makeTestServices } from '../test/makeTestServices';

it('opens a clean install inside the private lock shell', async () => {
  const view = await render(<AppRoot services={makeTestServices()} />);
  expect(await view.findByText('Create your private space')).toBeTruthy();
  expect(view.queryByText('Diary')).toBeNull();
});
