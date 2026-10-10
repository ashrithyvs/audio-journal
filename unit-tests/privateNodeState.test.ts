import {
  initialPrivateNodeState,
  privateNodeReducer,
  type PrivateNodeAction,
  type PrivateNodeState,
} from '../src/features/private-node/domain/privateNodeState';
import { NODE_ID, pairedRecord } from '../test/FakeHybridAiGateway';

const run = (actions: PrivateNodeAction[], from = initialPrivateNodeState) =>
  actions.reduce<PrivateNodeState>(privateNodeReducer, from);

const ready = run([
  { type: 'SDK_INIT_STARTED', at: 100 },
  {
    type: 'SDK_INIT_FINISHED',
    at: 160,
    result: { state: 'ready', capabilityCount: 2, packageVersion: '0.1.0-m5' },
  },
]);

const summary = {
  nodeId: NODE_ID,
  nodeName: 'Study PC',
  expiresAt: 2_000_000_000,
  endpointCount: 1,
};

describe('SDK initialization', () => {
  it('starts idle until the app asks for it (AJ-FR-035)', () => {
    expect(initialPrivateNodeState.sdk.phase).toBe('idle');
  });

  it('records ready state and init duration', () => {
    expect(ready.sdk).toEqual({
      phase: 'ready',
      capabilityCount: 2,
      localModels: 'not_configured',
    });
    expect(ready.timings.sdkInitMs).toBe(60);
  });

  it('records an unavailable SDK by code and allows a retry', () => {
    const failed = run([
      { type: 'SDK_INIT_STARTED', at: 0 },
      {
        type: 'SDK_INIT_FINISHED',
        at: 5,
        result: {
          state: 'unavailable',
          code: 'SDK_INITIALIZATION_FAILED',
          packageVersion: '0.1.0-m5',
        },
      },
    ]);
    expect(failed.sdk).toEqual({
      phase: 'unavailable',
      code: 'SDK_INITIALIZATION_FAILED',
    });
    expect(failed.timings.sdkInitMs).toBeUndefined();
    expect(run([{ type: 'SDK_INIT_STARTED', at: 9 }], failed).sdk.phase).toBe(
      'initializing',
    );
  });
});

describe('discovery', () => {
  const candidate = {
    nodeId: NODE_ID,
    instanceName: 'Study PC',
    endpointCount: 1,
    protocols: ['1.0'],
    pairingOpen: true,
  };

  it('collects, updates, and loses candidates with settle timings', () => {
    const state = run(
      [
        { type: 'DISCOVERY_STARTED', at: 1_000 },
        {
          type: 'DISCOVERY_UPDATE',
          at: 1_200,
          update: { type: 'found', candidate },
        },
        {
          type: 'DISCOVERY_UPDATE',
          at: 1_500,
          update: {
            type: 'updated',
            candidate: { ...candidate, pairingOpen: false },
          },
        },
      ],
      ready,
    );
    expect(state.discovery.candidates).toEqual([
      { ...candidate, pairingOpen: false },
    ]);
    expect(state.timings).toMatchObject({
      discoveryFirstMs: 200,
      discoverySettledMs: 500,
    });
    const lost = run(
      [
        {
          type: 'DISCOVERY_UPDATE',
          at: 2_000,
          update: { type: 'lost', nodeId: NODE_ID },
        },
      ],
      state,
    );
    expect(lost.discovery.candidates).toEqual([]);
    expect(lost.timings.discoverySettledMs).toBe(1_000);
  });

  it('keeps a typed failure and ignores events after it', () => {
    const failed = run(
      [
        { type: 'DISCOVERY_STARTED', at: 0 },
        {
          type: 'DISCOVERY_UPDATE',
          at: 1,
          update: {
            type: 'failed',
            failure: { code: 'DISCOVERY_PERMISSION_DENIED' },
          },
        },
        {
          type: 'DISCOVERY_UPDATE',
          at: 2,
          update: { type: 'found', candidate },
        },
      ],
      ready,
    );
    expect(failed.discovery).toMatchObject({
      phase: 'failed',
      failure: { code: 'DISCOVERY_PERMISSION_DENIED' },
      candidates: [],
    });
  });
});

describe('pairing ceremony', () => {
  const confirming = run(
    [
      { type: 'PAIRING_INSPECT_STARTED' },
      { type: 'PAIRING_INSPECTED', summary },
      { type: 'PAIRING_STARTED', at: 10_000 },
      {
        type: 'PAIRING_UPDATE',
        at: 10_100,
        update: { type: 'state', state: 'BOOTSTRAP_SCANNED' },
      },
      {
        type: 'PAIRING_UPDATE',
        at: 10_300,
        update: {
          type: 'confirmationRequired',
          nodeName: 'Study PC',
          verificationCode: '123456',
        },
      },
    ],
    ready,
  );

  it('requires the verification code before pairing', () => {
    expect(confirming.pairing).toMatchObject({
      phase: 'confirming',
      verificationCode: '123456',
    });
    expect(confirming.timings.pairingToCodeMs).toBe(300);
  });

  it('records the decision once and completes pairing as active', () => {
    const paired = run(
      [
        { type: 'PAIRING_DECISION', choice: 'confirm', at: 11_000 },
        { type: 'PAIRING_DECISION', choice: 'reject', at: 11_001 },
        {
          type: 'PAIRING_UPDATE',
          at: 11_250,
          update: { type: 'paired', node: pairedRecord() },
        },
      ],
      {
        ...confirming,
        paired: [pairedRecord({ nodeId: 'other', active: true })],
      },
    );
    expect(paired.pairing.phase).toBe('paired');
    expect(paired.paired.map(node => [node.nodeId, node.active])).toEqual([
      ['other', false],
      [NODE_ID, true],
    ]);
    expect(paired.timings).toMatchObject({
      confirmToPairedMs: 250,
      pairingTotalMs: 1_250,
    });
  });

  it('ends with a typed failure or cancellation', () => {
    expect(
      run(
        [
          {
            type: 'PAIRING_UPDATE',
            at: 1,
            update: { type: 'failed', failure: { code: 'PAIRING_REJECTED' } },
          },
        ],
        confirming,
      ).pairing,
    ).toEqual({ phase: 'failed', failure: { code: 'PAIRING_REJECTED' } });
    expect(
      run(
        [{ type: 'PAIRING_UPDATE', at: 1, update: { type: 'cancelled' } }],
        confirming,
      ).pairing,
    ).toEqual({ phase: 'cancelled' });
  });

  it('rejects an expired code at inspection', () => {
    const expired = run(
      [
        { type: 'PAIRING_INSPECT_STARTED' },
        {
          type: 'PAIRING_INSPECT_FAILED',
          failure: { code: 'PAIRING_BOOTSTRAP_EXPIRED' },
        },
        { type: 'PAIRING_STARTED', at: 1 },
      ],
      ready,
    );
    expect(expired.pairing).toEqual({
      phase: 'failed',
      failure: { code: 'PAIRING_BOOTSTRAP_EXPIRED' },
    });
  });

  it('ignores ceremony events when no ceremony is running', () => {
    expect(
      run(
        [
          {
            type: 'PAIRING_UPDATE',
            at: 1,
            update: { type: 'paired', node: pairedRecord() },
          },
        ],
        ready,
      ).paired,
    ).toEqual([]);
  });
});

describe('lock lifecycle', () => {
  it('cancels attended flows but keeps trust and connection state', () => {
    const busy = run(
      [
        {
          type: 'SNAPSHOT',
          status: { state: 'connected', nodeId: NODE_ID },
          paired: [pairedRecord()],
        },
        { type: 'DISCOVERY_STARTED', at: 0 },
        { type: 'PAIRING_INSPECT_STARTED' },
        { type: 'PAIRING_INSPECTED', summary },
      ],
      ready,
    );
    const locked = run([{ type: 'LOCKED' }], busy);
    expect(locked.discovery.phase).toBe('stopped');
    expect(locked.pairing).toEqual({ phase: 'cancelled' });
    expect(locked.paired).toEqual([pairedRecord()]);
    expect(locked.link.status.state).toBe('connected');
  });
});

describe('connection and forget', () => {
  it('records secure reconnect duration or a typed failure', () => {
    const connected = run(
      [
        { type: 'CONNECT_STARTED', at: 0 },
        { type: 'CONNECT_STARTED', at: 5 },
        { type: 'CONNECT_FINISHED', at: 40 },
      ],
      ready,
    );
    expect(connected.timings.reconnectMs).toBe(40);
    const revoked = run(
      [
        { type: 'CONNECT_STARTED', at: 0 },
        {
          type: 'CONNECT_FINISHED',
          at: 9,
          failure: { code: 'NODE_TRUST_REVOKED' },
        },
      ],
      ready,
    );
    expect(revoked.link).toMatchObject({
      operation: 'idle',
      failure: { code: 'NODE_TRUST_REVOKED' },
    });
  });

  it('removes a forgotten node and reports whether the node confirmed', () => {
    const forgotten = run(
      [
        {
          type: 'SNAPSHOT',
          status: { state: 'connected', nodeId: NODE_ID },
          paired: [pairedRecord()],
        },
        { type: 'FORGET_STARTED', at: 0 },
        { type: 'FORGET_FINISHED', nodeId: NODE_ID, confirmed: false },
      ],
      ready,
    );
    expect(forgotten.paired).toEqual([]);
    expect(forgotten.link).toEqual({
      status: { state: 'none' },
      operation: 'idle',
      notice: 'forgotten_unconfirmed',
    });
  });

  it('keeps the pairing when forget fails', () => {
    const kept = run(
      [
        {
          type: 'SNAPSHOT',
          status: { state: 'none' },
          paired: [pairedRecord()],
        },
        { type: 'FORGET_STARTED', at: 0 },
        {
          type: 'FORGET_FINISHED',
          nodeId: NODE_ID,
          failure: { code: 'CREDENTIAL_UNAVAILABLE' },
        },
      ],
      ready,
    );
    expect(kept.paired).toHaveLength(1);
    expect(kept.link.failure).toEqual({ code: 'CREDENTIAL_UNAVAILABLE' });
  });
});

describe('link failure after recovery (AJ-3 report F3)', () => {
  const failedConnect = run(
    [
      {
        type: 'SNAPSHOT',
        status: { state: 'unavailable', nodeId: NODE_ID },
        paired: [pairedRecord()],
      },
      { type: 'CONNECT_STARTED', at: 0 },
      {
        type: 'CONNECT_FINISHED',
        at: 9,
        failure: { code: 'NODE_UNAVAILABLE' },
      },
    ],
    ready,
  );

  it('clears the failed connect once the SDK reconnects by itself', () => {
    expect(failedConnect.link.failure).toEqual({ code: 'NODE_UNAVAILABLE' });
    const recovered = run(
      [
        { type: 'STATUS', status: { state: 'reconnecting', nodeId: NODE_ID } },
        { type: 'STATUS', status: { state: 'connected', nodeId: NODE_ID } },
      ],
      failedConnect,
    );
    expect(recovered.link.mark).toBeUndefined();
    expect(recovered.link.failure).toBeUndefined();
  });

  it('keeps it while the only "connected" seen is stale', () => {
    const stale = run(
      [{ type: 'STATUS', status: { state: 'connected', nodeId: NODE_ID } }],
      run(
        [
          {
            type: 'SNAPSHOT',
            status: { state: 'connected', nodeId: NODE_ID },
            paired: [pairedRecord()],
          },
          { type: 'CONNECT_STARTED', at: 0 },
          {
            type: 'CONNECT_FINISHED',
            at: 9,
            failure: { code: 'NODE_UNAVAILABLE' },
          },
        ],
        ready,
      ),
    );
    expect(stale.link.failure).toEqual({ code: 'NODE_UNAVAILABLE' });
    expect(stale.link.mark).toBeDefined();
  });

  it('keeps a failed forget, which no contact resolves', () => {
    const kept = run(
      [
        { type: 'FORGET_STARTED', at: 20 },
        {
          type: 'FORGET_FINISHED',
          nodeId: NODE_ID,
          failure: { code: 'CREDENTIAL_UNAVAILABLE' },
        },
        { type: 'STATUS', status: { state: 'reconnecting', nodeId: NODE_ID } },
        { type: 'STATUS', status: { state: 'connected', nodeId: NODE_ID } },
      ],
      failedConnect,
    );
    expect(kept.link.failure).toEqual({ code: 'CREDENTIAL_UNAVAILABLE' });
  });
});

describe('capability request', () => {
  const running = run(
    [
      {
        type: 'REQUEST_STARTED',
        requestId: 'r1',
        execution: 'auto',
        at: 1_000,
      },
    ],
    ready,
  );

  it('completes with target, routing reason, and first-event timing', () => {
    const done = run(
      [
        {
          type: 'REQUEST_UPDATE',
          requestId: 'r1',
          at: 1_030,
          update: { type: 'accepted' },
        },
        {
          type: 'REQUEST_UPDATE',
          requestId: 'r1',
          at: 1_050,
          update: { type: 'progress' },
        },
        {
          type: 'REQUEST_UPDATE',
          requestId: 'r1',
          at: 1_090,
          update: {
            type: 'completed',
            output: {},
            target: 'node',
            routingReason: 'only_eligible_node',
          },
          check: { valid: true, summaryLength: 5, topicCount: 1 },
        },
      ],
      running,
    );
    expect(done.request).toMatchObject({
      phase: 'completed',
      target: 'node',
      routingReason: 'only_eligible_node',
      events: 3,
      firstEventMs: 30,
      totalMs: 90,
    });
    expect(done.timings).toMatchObject({
      firstEventMs: 30,
      firstResponseMs: 90,
    });
  });

  it('ignores updates for another request and refuses concurrent starts', () => {
    const state = run(
      [
        {
          type: 'REQUEST_UPDATE',
          requestId: 'other',
          at: 1_001,
          update: { type: 'cancelled' },
        },
        {
          type: 'REQUEST_STARTED',
          requestId: 'r2',
          execution: 'node',
          at: 1_002,
        },
        { type: 'REQUEST_RESET' },
      ],
      running,
    );
    expect(state.request).toMatchObject({ phase: 'running', requestId: 'r1' });
  });

  it('keeps typed failure reasons and cancellation', () => {
    const failed = run(
      [
        {
          type: 'REQUEST_UPDATE',
          requestId: 'r1',
          at: 1_010,
          update: {
            type: 'failed',
            failure: {
              code: 'NO_ELIGIBLE_TARGET',
              nodeReason: 'node_unreachable',
              localReason: 'local_not_advertised',
            },
          },
        },
      ],
      running,
    );
    expect(failed.request).toMatchObject({
      phase: 'failed',
      failure: { code: 'NO_ELIGIBLE_TARGET', nodeReason: 'node_unreachable' },
    });
    expect(
      run(
        [
          {
            type: 'REQUEST_UPDATE',
            requestId: 'r1',
            at: 1_005,
            update: { type: 'cancelled' },
          },
        ],
        running,
      ).request.phase,
    ).toBe('cancelled');
  });
});

describe('link failure marks (AJ3-REV-001/003)', () => {
  const connected = run(
    [
      {
        type: 'SNAPSHOT',
        status: { state: 'connected', nodeId: NODE_ID },
        paired: [pairedRecord()],
      },
      {
        type: 'REQUEST_STARTED',
        requestId: 'r1',
        execution: 'node',
        at: 1_000,
      },
    ],
    ready,
  );
  const failed = (code: string) =>
    run(
      [
        {
          type: 'REQUEST_UPDATE',
          requestId: 'r1',
          at: 1_100,
          update: { type: 'failed', failure: { code } },
        },
      ],
      connected,
    );

  it('marks the active node when a request fails on the link', () => {
    expect(failed('NODE_TRUST_REVOKED').link.mark).toEqual({
      nodeId: NODE_ID,
      code: 'NODE_TRUST_REVOKED',
      sawDisconnect: false, // the SDK still says "connected" (stale)
    });
    // A request-level failure says nothing about the link.
    expect(failed('INVALID_INPUT').link.mark).toBeUndefined();
  });

  it('clears only on authenticated contact or recovery', () => {
    const marked = failed('NODE_UNAVAILABLE');
    const restarted = (target: 'node' | 'local') =>
      run(
        [
          {
            type: 'REQUEST_STARTED',
            requestId: 'r2',
            execution: 'auto',
            at: 2_000,
          },
          {
            type: 'REQUEST_UPDATE',
            requestId: 'r2',
            at: 2_100,
            update: {
              type: 'completed',
              target,
              routingReason: 'policy',
              output: { summary: 's', topics: [] },
            },
          },
        ],
        marked,
      );
    expect(restarted('local').link.mark).toBeDefined();
    expect(restarted('node').link.mark).toBeUndefined();
    const reconnected = run(
      [
        { type: 'CONNECT_STARTED', at: 3_000 },
        { type: 'CONNECT_FINISHED', at: 3_100 },
      ],
      marked,
    );
    expect(reconnected.link.mark).toBeUndefined();
    const forgotten = run(
      [
        { type: 'FORGET_STARTED', at: 3_000 },
        { type: 'FORGET_FINISHED', nodeId: NODE_ID, confirmed: true },
      ],
      marked,
    );
    expect(forgotten.link.mark).toBeUndefined();
  });

  it('remembers exactly which node the SDK reports as revoked', () => {
    const revoked = run(
      [
        {
          type: 'SNAPSHOT',
          status: { state: 'revoked', nodeId: NODE_ID },
          paired: [pairedRecord({ active: false, state: 'revoked' })],
        },
      ],
      ready,
    );
    expect(revoked.link.mark).toMatchObject({
      nodeId: NODE_ID,
      code: 'NODE_TRUST_REVOKED',
    });
  });

  it('ignores a stale "connected" but clears on a fresh reconnect by the SDK', () => {
    const snapshot = (
      state: 'connected' | 'unavailable',
    ): PrivateNodeAction => ({
      type: 'SNAPSHOT',
      status: { state, nodeId: NODE_ID },
      paired: [pairedRecord()],
    });
    const marked = failed('NODE_UNAVAILABLE');
    // Polling keeps reading the stale status: the failure stays shown.
    expect(run([snapshot('connected')], marked).link.mark).toBeDefined();
    // The reconciling connect failed, then the network came back and the
    // SDK reconnected by itself (no Reconnect tap).
    const recovered = run(
      [snapshot('unavailable'), snapshot('connected')],
      marked,
    );
    expect(recovered.link.mark).toBeUndefined();
  });
});
