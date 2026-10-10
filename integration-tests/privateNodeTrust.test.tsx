import { act, fireEvent } from '@testing-library/react-native';

import {
  FakeHybridAiGateway,
  NODE_ID,
  pairedRecord,
} from '../test/FakeHybridAiGateway';
import {
  DIARY_COPY,
  flush,
  openDiagnostics,
  openNodeScreen,
  renderUnlocked,
  tab,
} from '../test/renderApp';

// AJ3-REV-001/003: the node status after a request fails on the link. The
// fake follows the SDK: a request failure persists nothing; a connect or
// refresh persists revocation and deactivates the record.

const OTHER_ID = 'ffeeddccbbaa99887766554433221100';
type View = Awaited<ReturnType<typeof renderUnlocked>>['view'];

async function failNodeRequest(
  view: View,
  gateway: FakeHybridAiGateway,
  code: string,
) {
  await openDiagnostics(view);
  await fireEvent.press(view.getByTestId('diag-target-node'));
  await fireEvent.press(view.getByTestId('diag-run'));
  await act(async () => {
    gateway.emitRun({ type: 'failed', failure: { code } });
  });
  await flush();
}

const connects = (gateway: FakeHybridAiGateway) =>
  gateway.calls.filter(call => call === 'connect').length;

it('shows revoked trust after a refused request, then recovers by forgetting and pairing again', async () => {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  const { view } = await renderUnlocked(gateway);
  expect(connects(gateway)).toBe(1);
  gateway.nodeSide.set(NODE_ID, 'revoked'); // the node removes this device

  await failNodeRequest(view, gateway, 'NODE_TRUST_REVOKED');
  // One reconciling connect lets the SDK persist the revocation.
  expect(connects(gateway)).toBe(2);
  expect(gateway.paired).toEqual([
    expect.objectContaining({
      nodeId: NODE_ID,
      state: 'revoked',
      active: false,
    }),
  ]);
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Trust revoked',
  );
  expect(view.getByText('Affected node')).toBeTruthy();
  expect(view.queryByText('Connected')).toBeNull();
  expect(view.queryByTestId('reconnect')).toBeNull();
  expect(view.queryByTestId('link-failure')).toBeNull();

  await fireEvent.press(view.getByTestId('forget-and-repair'));
  expect(await view.findByTestId('pairing-code-input')).toBeTruthy();
  expect(gateway.paired).toEqual([]);
});

it('shows a key that is unavailable after a refused request', async () => {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  const { view } = await renderUnlocked(gateway);
  gateway.nodeSide.set(NODE_ID, 'credential_unavailable');
  await failNodeRequest(view, gateway, 'CREDENTIAL_UNAVAILABLE');
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Pairing key unavailable',
  );
  expect(view.getByTestId('forget-and-repair')).toBeTruthy();
});

it('still shows the revoked node after a restart, not "No node paired"', async () => {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [
    pairedRecord({ active: false, state: 'revoked' }),
    pairedRecord({ nodeId: OTHER_ID, nodeName: 'Spare', active: false }),
  ];
  const { view } = await renderUnlocked(gateway);
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Trust revoked',
  );
  expect(view.queryByText('No node paired')).toBeNull();
  await fireEvent.press(view.getByTestId('forget-and-repair'));
  await view.findByTestId('pairing-code-input');
  // Exactly the revoked node was forgotten; the spare is kept.
  expect(gateway.paired.map(node => node.nodeId)).toEqual([OTHER_ID]);
});

it('never picks one of several failed nodes: each gets its own recovery', async () => {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [
    pairedRecord({ active: false, state: 'revoked' }),
    pairedRecord({
      nodeId: OTHER_ID,
      nodeName: 'Laptop',
      active: false,
      state: 'credential_unavailable',
    }),
  ];
  const { view } = await renderUnlocked(gateway);
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Trust revoked',
  );
  expect(view.queryByTestId('forget-and-repair')).toBeNull();
  await fireEvent.press(view.getByTestId('forget-and-repair-ffeeddcc'));
  await view.findByTestId('pairing-code-input');
  expect(gateway.paired.map(node => node.nodeId)).toEqual([NODE_ID]);
});

it('shows Unavailable at once, reconciles once without a retry storm, and recovers', async () => {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  const { view } = await renderUnlocked(gateway);
  gateway.connectFailure = { code: 'NODE_UNAVAILABLE' };

  await failNodeRequest(view, gateway, 'NODE_UNAVAILABLE');
  await failNodeRequest(view, gateway, 'NODE_UNAVAILABLE');
  // Two failed requests, one reconciling connect, and no request retried.
  expect(connects(gateway)).toBe(2);
  expect(gateway.calls.filter(call => call.startsWith('run:'))).toHaveLength(2);
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Unavailable',
  );

  // The journal stays fully usable offline.
  await fireEvent.press(tab(view, 'Diary'));
  expect(await view.findByText(DIARY_COPY)).toBeTruthy();

  // The node is back: an explicit reconnect is authenticated contact.
  gateway.connectFailure = undefined;
  await fireEvent.press(tab(view, 'Settings'));
  await view.findByTestId('node-status-card');
  await fireEvent.press(view.getByTestId('reconnect'));
  expect(await view.findByText('Connected')).toBeTruthy();
});

it('clears a stale failure after the next successful node request', async () => {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  const { view } = await renderUnlocked(gateway);
  await failNodeRequest(view, gateway, 'NODE_UNAVAILABLE');
  // The reconciling connect succeeded (the node was only briefly away).
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Connected',
  );

  gateway.connectFailure = { code: 'NODE_UNAVAILABLE' };
  gateway.linkStatus = { state: 'connected', nodeId: NODE_ID };
  await failNodeRequest(view, gateway, 'NODE_AUTHENTICATION_FAILED');
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Identity check failed',
  );
  await openDiagnostics(view);
  await fireEvent.press(view.getByTestId('diag-run'));
  await act(async () => {
    gateway.emitRun({
      type: 'completed',
      target: 'node',
      routingReason: 'policy',
      output: { summary: 'ok', topics: [] },
    });
  });
  await openNodeScreen(view);
  expect(view.getByTestId('node-connection-state')).toHaveTextContent(
    'Connected',
  );
});
