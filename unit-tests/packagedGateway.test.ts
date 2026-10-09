import {
  createHybridAI,
  type ExecutionEvent,
  HybridAIError,
  type PairingEvent,
} from '@hybrid-ai/react-native';

import type {
  CapabilityUpdate,
  PairingUpdate,
} from '../src/platform/hybrid-ai/HybridAiGateway';
import { PackagedHybridAiGateway } from '../src/platform/hybrid-ai/PackagedHybridAiGateway';

const create = createHybridAI as jest.MockedFunction<typeof createHybridAI>;

async function* events<T>(items: T[], error?: unknown): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
  if (error) {
    throw error;
  }
}

function fakeSdk(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: jest.fn(async () => []),
    setPolicy: jest.fn(),
    cancel: jest.fn(),
    stream: jest.fn(),
    node: {
      status: jest.fn(async () => ({ state: 'connected', nodeId: 'n1' })),
      pair: jest.fn(),
      startDiscovery: jest.fn(),
      connect: jest.fn(async () => {}),
    },
    ...overrides,
  };
}

const event = (
  type: ExecutionEvent['type'],
  data: ExecutionEvent['data'] = {},
) => ({
  sequence: 1,
  type,
  requestId: 'r1',
  data,
});

const request = {
  capability: 'document.analyze',
  version: '1',
  input: { document: 'x' },
  execution: 'auto' as const,
  timeoutMs: 1_000,
  requestId: 'r1',
};

afterEach(() => create.mockReset());

it('initializes once with pairing enabled and the app policy', async () => {
  const sdk = fakeSdk();
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  const policy = { allowLocal: false, allowNode: true };
  const [first, second] = await Promise.all([
    gateway.initialize(policy),
    gateway.initialize(policy),
  ]);
  expect(first).toEqual(second);
  expect(first).toEqual({
    state: 'ready',
    capabilityCount: 0,
    packageVersion: '0.1.0-m5',
    localModels: 'not_configured',
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith({ pairing: true, policy });
});

it('loads the app model directory and keeps node features if it is rejected', async () => {
  const sdk = fakeSdk();
  create
    .mockRejectedValueOnce(
      new HybridAIError('LOCAL_CAPABILITY_UNAVAILABLE', ''),
    )
    .mockResolvedValueOnce(sdk as never);
  const gateway = new PackagedHybridAiGateway('/data/models');
  const policy = { allowLocal: true, allowNode: true };
  expect(await gateway.initialize(policy)).toMatchObject({
    state: 'ready',
    localModels: 'unavailable',
  });
  expect(create.mock.calls).toEqual([
    [{ pairing: true, policy, modelDirectory: '/data/models' }],
    [{ pairing: true, policy }],
  ]);
  create.mockReset();
  create.mockResolvedValueOnce(sdk as never);
  expect(
    await new PackagedHybridAiGateway('/data/models').initialize(policy),
  ).toMatchObject({
    localModels: 'loaded',
  });
});

it('audits raw terminal counts and event ordering', async () => {
  const sdk = fakeSdk({
    stream: jest.fn(() =>
      events([
        { ...event('accepted'), sequence: 2 },
        { ...event('completed', { output: {} }), sequence: 1 },
        { ...event('failed', { code: 'EXECUTION_FAILED' }), sequence: 3 },
      ]),
    ),
  });
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  await gateway.initialize({ allowLocal: true, allowNode: true });
  const updates: CapabilityUpdate[] = [];
  const audit = await gateway.run(request, update => updates.push(update));
  expect(audit).toEqual({ events: 3, terminalEvents: 2, outOfOrder: true });
  expect(updates.map(update => update.type)).toEqual(['accepted', 'completed']);
});

it('reports an initialization failure by public code and allows retry', async () => {
  create.mockRejectedValueOnce(
    new HybridAIError('CREDENTIAL_UNAVAILABLE', 'secret detail'),
  );
  const gateway = new PackagedHybridAiGateway();
  const policy = { allowLocal: true, allowNode: true };
  expect(await gateway.initialize(policy)).toEqual({
    state: 'unavailable',
    code: 'CREDENTIAL_UNAVAILABLE',
    packageVersion: '0.1.0-m5',
  });
  create.mockResolvedValueOnce(fakeSdk() as never);
  expect((await gateway.initialize(policy)).state).toBe('ready');
});

it('maps typed SDK errors and never keeps their messages', async () => {
  const sdk = fakeSdk();
  sdk.node.connect = jest.fn(async () => {
    throw new HybridAIError('NODE_TRUST_REVOKED', 'payload text');
  });
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  await gateway.initialize({ allowLocal: true, allowNode: true });
  await expect(gateway.connect(1_000)).rejects.toMatchObject({
    failure: { code: 'NODE_TRUST_REVOKED' },
    message: 'NODE_TRUST_REVOKED',
  });
});

it('maps a completed stream with target and routing reason', async () => {
  const sdk = fakeSdk({
    stream: jest.fn(() =>
      events([
        event('accepted'),
        event('partial', { delta: {} }),
        event('completed', {
          output: { summary: 's', topics: [] },
          target: 'node',
          routingReason: 'explicit_node',
        }),
      ]),
    ),
  });
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  await gateway.initialize({ allowLocal: true, allowNode: true });
  const updates: CapabilityUpdate[] = [];
  await gateway.run(request, update => updates.push(update));
  expect(updates.map(update => update.type)).toEqual([
    'accepted',
    'partial',
    'completed',
  ]);
  expect(updates[2]).toMatchObject({
    target: 'node',
    routingReason: 'explicit_node',
  });
  expect(sdk.stream).toHaveBeenCalledWith(request);
});

it('carries structured reasons on failure and maps unknown reasons safely', async () => {
  const sdk = fakeSdk({
    stream: jest.fn(() =>
      events([
        event('failed', {
          code: 'NO_ELIGIBLE_TARGET',
          message: 'should not be kept',
          nodeReason: 'node_unreachable',
          localReason: 'from_a_newer_core',
        }),
      ]),
    ),
  });
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  await gateway.initialize({ allowLocal: true, allowNode: true });
  const updates: CapabilityUpdate[] = [];
  await gateway.run(request, update => updates.push(update));
  expect(updates).toEqual([
    {
      type: 'failed',
      failure: {
        code: 'NO_ELIGIBLE_TARGET',
        nodeReason: 'node_unreachable',
        localReason: 'unknown',
      },
    },
  ]);
});

it('delivers exactly one terminal even when the stream throws or ends early', async () => {
  const sdk = fakeSdk({
    stream: jest
      .fn()
      .mockImplementationOnce(() =>
        events([event('accepted')], new HybridAIError('NODE_UNAVAILABLE', '')),
      )
      .mockImplementationOnce(() => events([event('accepted')]))
      .mockImplementationOnce(() =>
        events([event('cancelled'), event('completed', { output: {} })]),
      ),
  });
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  await gateway.initialize({ allowLocal: true, allowNode: true });
  const collect = async () => {
    const updates: CapabilityUpdate[] = [];
    await gateway.run(request, update => updates.push(update));
    return updates.map(update =>
      update.type === 'failed' ? update.failure.code : update.type,
    );
  };
  expect(await collect()).toEqual(['accepted', 'NODE_UNAVAILABLE']);
  expect(await collect()).toEqual(['accepted', 'EXECUTION_FAILED']);
  expect(await collect()).toEqual(['cancelled']);
});

it('maps a pairing ceremony and its single terminal', async () => {
  const pairingEvents: PairingEvent[] = [
    { type: 'state', state: 'BOOTSTRAP_SCANNED' },
    {
      type: 'confirmationRequired',
      nodeName: 'Study PC',
      verificationCode: '123456',
    },
    {
      type: 'paired',
      node: {
        nodeId: 'n1',
        nodeName: 'Study PC',
        pairingId: 'p1',
        active: true,
        state: 'paired',
        pairedAt: 1,
        rotation: { device: 'none', node: 'none' },
      },
    },
  ];
  const session = Object.assign(events(pairingEvents), {
    confirm: jest.fn(async () => {}),
    reject: jest.fn(async () => {}),
    cancel: jest.fn(async () => {}),
  });
  const sdk = fakeSdk();
  sdk.node.pair = jest.fn(() => session);
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  await gateway.initialize({ allowLocal: true, allowNode: true });
  const updates: PairingUpdate[] = [];
  const ceremony = gateway.pair(
    'hybrid-ai-pair:x',
    'Audio Journal (Android)',
    update => updates.push(update),
  );
  await ceremony.confirm();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sdk.node.pair).toHaveBeenCalledWith('hybrid-ai-pair:x', {
    deviceName: 'Audio Journal (Android)',
    activate: true,
  });
  expect(updates.map(update => update.type)).toEqual([
    'state',
    'confirmationRequired',
    'paired',
  ]);
  // The pairing record exposes no pairing ID or rotation material to the app.
  expect(updates[2]).toEqual({
    type: 'paired',
    node: {
      nodeId: 'n1',
      nodeName: 'Study PC',
      active: true,
      state: 'paired',
      pairedAt: 1,
    },
  });
});

it('turns a synchronous pairing argument error into a failed update', async () => {
  const sdk = fakeSdk();
  sdk.node.pair = jest.fn(() => {
    throw new HybridAIError('INVALID_ARGUMENT', 'bad deadline');
  });
  create.mockResolvedValue(sdk as never);
  const gateway = new PackagedHybridAiGateway();
  await gateway.initialize({ allowLocal: true, allowNode: true });
  const updates: PairingUpdate[] = [];
  gateway.pair('x', 'd', update => updates.push(update));
  await Promise.resolve();
  expect(updates).toEqual([
    { type: 'failed', failure: { code: 'INVALID_ARGUMENT' } },
  ]);
});

it('fails operations before initialization with a typed code', async () => {
  const gateway = new PackagedHybridAiGateway();
  await expect(gateway.status()).rejects.toMatchObject({
    failure: { code: 'SDK_NOT_INITIALIZED' },
  });
});
