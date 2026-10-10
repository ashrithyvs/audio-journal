import { act, fireEvent } from '@testing-library/react-native';

import type { CapabilityUpdate } from '../src/platform/hybrid-ai/HybridAiGateway';
import { FakeHybridAiGateway, pairedRecord } from '../test/FakeHybridAiGateway';
import {
  flush,
  openDiagnostics,
  openNodeScreen,
  renderUnlocked,
} from '../test/renderApp';

// UX §7.1: a node result is authenticated contact. The status shows
// Connected at once, even while the SDK still reports its last connect
// result (SDK-AJ-2), and one catch-up connect lets the SDK agree. The
// request is never retried, and the catch-up waits out the debounce rather
// than being lost to it. The debounce is shortened to DEBOUNCE_MS here
// (5 s in the app); waits are real.

const DEBOUNCE_MS = 300;
type View = Awaited<ReturnType<typeof renderUnlocked>>['view'];

const nodeResult: CapabilityUpdate = {
  type: 'completed',
  target: 'node',
  routingReason: 'policy',
  output: { summary: 'ok', topics: [] },
};
const unavailable: CapabilityUpdate = {
  type: 'failed',
  failure: { code: 'NODE_UNAVAILABLE' },
};

const connects = (gateway: FakeHybridAiGateway) =>
  gateway.calls.filter(call => call === 'connect').length;
const runs = (gateway: FakeHybridAiGateway) =>
  gateway.calls.filter(call => call.startsWith('run:')).length;

async function wait(ms: number) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
  await flush();
}

async function renderPaired() {
  const gateway = new FakeHybridAiGateway();
  gateway.paired = [pairedRecord()];
  const { view } = await renderUnlocked(gateway, {
    reconcileDebounceMs: DEBOUNCE_MS,
  });
  return { view, gateway };
}

async function request(
  view: View,
  gateway: FakeHybridAiGateway,
  target: 'node' | 'auto',
  update: CapabilityUpdate,
) {
  await openDiagnostics(view);
  await fireEvent.press(view.getByTestId(`diag-target-${target}`));
  await fireEvent.press(view.getByTestId('diag-run'));
  await act(async () => {
    gateway.emitRun(update);
  });
  await flush();
}

async function status(view: View) {
  await openNodeScreen(view);
  return view.getByTestId('node-connection-state');
}

/** The node went down: a request failed and the reconciling connect failed. */
async function nodeDown() {
  const { view, gateway } = await renderPaired();
  gateway.connectFailure = { code: 'NODE_UNAVAILABLE' };
  await request(view, gateway, 'node', unavailable);
  expect(await status(view)).toHaveTextContent('Unavailable');
  expect(view.getByTestId('link-failure')).toBeTruthy();
  return { view, gateway };
}

it('shows Connected at once after a node result, then catches the SDK up once', async () => {
  const { view, gateway } = await nodeDown();
  // The node is back; the SDK still reports its failed connect.
  gateway.connectFailure = undefined;
  const before = connects(gateway);
  await request(view, gateway, 'node', nodeResult);
  expect(gateway.linkStatus.state).toBe('unavailable');
  expect(await status(view)).toHaveTextContent('Connected');
  expect(view.queryByTestId('link-failure')).toBeNull();
  expect(view.queryAllByText('Reconnect')).toHaveLength(0);
  // The failure's reconcile ran moments ago: the catch-up waits, not drops.
  expect(connects(gateway)).toBe(before);
  await wait(DEBOUNCE_MS + 100);
  expect(connects(gateway)).toBe(before + 1);
  expect(gateway.linkStatus.state).toBe('connected');
  // Exactly once, and the request was never retried.
  await wait(DEBOUNCE_MS * 3);
  expect(connects(gateway)).toBe(before + 1);
  expect(runs(gateway)).toBe(2);
  expect(await status(view)).toHaveTextContent('Connected');
});

it('coalesces several node results into one catch-up', async () => {
  const { view, gateway } = await nodeDown();
  gateway.connectFailure = undefined;
  const before = connects(gateway);
  await request(view, gateway, 'node', nodeResult);
  await request(view, gateway, 'node', nodeResult);
  await request(view, gateway, 'node', nodeResult);
  await wait(DEBOUNCE_MS * 3);
  expect(connects(gateway)).toBe(before + 1);
  expect(runs(gateway)).toBe(4);
});

it('leaves the node status alone after a local completion', async () => {
  const { view, gateway } = await nodeDown();
  const before = connects(gateway);
  await request(view, gateway, 'auto', { ...nodeResult, target: 'local' });
  await wait(DEBOUNCE_MS * 2);
  expect(connects(gateway)).toBe(before);
  expect(await status(view)).toHaveTextContent('Unavailable');
  expect(view.getByTestId('link-failure')).toBeTruthy();
});

it('shows a failed catch-up as the newer failure, without retrying it', async () => {
  const { view, gateway } = await nodeDown();
  gateway.connectFailure = undefined;
  await request(view, gateway, 'node', nodeResult);
  // The node goes away again before the catch-up runs.
  gateway.connectFailure = { code: 'NODE_UNAVAILABLE' };
  const before = connects(gateway);
  await wait(DEBOUNCE_MS + 100);
  expect(connects(gateway)).toBe(before + 1);
  expect(await status(view)).toHaveTextContent('Unavailable');
  expect(view.getByTestId('link-failure')).toBeTruthy();
  expect(view.queryAllByText('Reconnect')).toHaveLength(1);
  await wait(DEBOUNCE_MS * 3);
  expect(connects(gateway)).toBe(before + 1);
});

it('needs no catch-up when the SDK already reports connected', async () => {
  const { view, gateway } = await renderPaired();
  const before = connects(gateway);
  await request(view, gateway, 'node', nodeResult);
  await wait(DEBOUNCE_MS * 2);
  expect(connects(gateway)).toBe(before);
});
