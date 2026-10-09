import React from 'react';
import { render } from '@testing-library/react-native';

import { PrivacyCurtain } from '../src/app/PrivacyCurtain';

it('obscures content when the lifecycle requires it', async () => {
  const view = await render(<PrivacyCurtain forced />);
  expect(view.getByTestId('privacy-curtain')).toBeTruthy();
  expect(view.getByText('Private content hidden')).toBeTruthy();
});

it('does not cover the active app', async () => {
  const view = await render(<PrivacyCurtain forced={false} />);
  expect(view.queryByTestId('privacy-curtain')).toBeNull();
});
