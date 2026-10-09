import {
  type AppRoutingPolicy,
  type CapabilityRequest,
  type CapabilitySummary,
  type CapabilityUpdate,
  type DiscoveryUpdate,
  type HybridAiFailure,
  type HybridAiGateway,
  HybridAiGatewayError,
  type HybridAiInitialization,
  type NodeLinkStatus,
  type PairedNodeRecord,
  type PairingCodeSummary,
  type PairingUpdate,
  type RunAudit,
} from '../src/platform/hybrid-ai/HybridAiGateway';

export const NODE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const VALID_CODE = 'hybrid-ai-pair:valid';
export const EXPIRED_CODE = 'hybrid-ai-pair:expired';

export const pairedRecord = (
  overrides: Partial<PairedNodeRecord> = {},
): PairedNodeRecord => ({
  nodeId: NODE_ID,
  nodeName: 'Study PC',
  active: true,
  state: 'paired',
  pairedAt: 1_760_000_000,
  ...overrides,
});

const nodeCapability: CapabilitySummary = {
  id: 'document.analyze',
  version: '1.0.0',
  targets: ['node'],
  nodeStale: false,
};

/**
 * Scriptable test double of the app-owned HybridAiGateway port. It models the
 * public SDK contract (typed codes, one terminal event) without SDK internals.
 */
export class FakeHybridAiGateway implements HybridAiGateway {
  readonly packageVersion = '0.1.0-m5';
  readonly calls: string[] = [];
  initResult: HybridAiInitialization = {
    state: 'ready',
    capabilityCount: 0,
    packageVersion: '0.1.0-m5',
  };
  policy?: AppRoutingPolicy;
  linkStatus: NodeLinkStatus = { state: 'none' };
  paired: PairedNodeRecord[] = [];
  connectFailure?: HybridAiFailure;
  forgetConfirmed = true;
  discoveryFailure?: HybridAiFailure;
  private discoveryListener?: (update: DiscoveryUpdate) => void;
  private pairingListener?: (update: PairingUpdate) => void;
  private runs = new Map<
    string,
    { listener: (update: CapabilityUpdate) => void; done(): void }
  >();

  async initialize(policy: AppRoutingPolicy) {
    this.calls.push('initialize');
    this.policy = policy;
    return this.initResult;
  }

  setPolicy(policy: AppRoutingPolicy) {
    this.calls.push('setPolicy');
    this.policy = policy;
  }

  async capabilities() {
    return this.linkStatus.state === 'connected' ? [nodeCapability] : [];
  }

  async status() {
    return this.linkStatus;
  }

  async pairedNodes() {
    return this.paired;
  }

  startDiscovery(onUpdate: (update: DiscoveryUpdate) => void) {
    this.calls.push('startDiscovery');
    this.discoveryListener = onUpdate;
    if (this.discoveryFailure) {
      const failure = this.discoveryFailure;
      Promise.resolve().then(() => onUpdate({ type: 'failed', failure }));
    }
    return {
      stop: async () => {
        this.calls.push('stopDiscovery');
        if (this.discoveryListener === onUpdate) {
          this.discoveryListener = undefined;
        }
      },
    };
  }

  emitDiscovery(update: DiscoveryUpdate) {
    this.discoveryListener?.(update);
  }

  get discovering() {
    return this.discoveryListener !== undefined;
  }

  async inspectPairingCode(code: string): Promise<PairingCodeSummary> {
    this.calls.push('inspectPairingCode');
    if (code === EXPIRED_CODE) {
      throw new HybridAiGatewayError({ code: 'PAIRING_BOOTSTRAP_EXPIRED' });
    }
    if (code !== VALID_CODE) {
      throw new HybridAiGatewayError({ code: 'PAIRING_BOOTSTRAP_INVALID' });
    }
    return {
      nodeId: NODE_ID,
      nodeName: 'Study PC',
      expiresAt: Date.now() / 1000 + 120,
      endpointCount: 1,
    };
  }

  lastPairingCode?: string;
  pair(
    code: string,
    _deviceName: string,
    onUpdate: (u: PairingUpdate) => void,
  ) {
    this.calls.push('pair');
    this.lastPairingCode = code;
    this.pairingListener = onUpdate;
    return {
      confirm: async () => {
        this.calls.push('confirmPairing');
      },
      reject: async () => {
        this.calls.push('rejectPairing');
        this.emitPairing({
          type: 'failed',
          failure: { code: 'PAIRING_REJECTED' },
        });
      },
      cancel: async () => {
        this.calls.push('cancelPairing');
        this.emitPairing({ type: 'cancelled' });
      },
    };
  }

  emitPairing(update: PairingUpdate) {
    const listener = this.pairingListener;
    if (
      update.type === 'paired' ||
      update.type === 'failed' ||
      update.type === 'cancelled'
    ) {
      this.pairingListener = undefined;
      if (update.type === 'paired') {
        this.paired = [
          ...this.paired.map(node => ({ ...node, active: false })),
          update.node,
        ];
      }
    }
    listener?.(update);
  }

  async connect() {
    this.calls.push('connect');
    if (this.connectFailure) {
      const failure = this.connectFailure;
      if (failure.code === 'NODE_TRUST_REVOKED') {
        this.linkStatus = { state: 'revoked', nodeId: NODE_ID };
      }
      throw new HybridAiGatewayError(failure);
    }
    this.linkStatus = { state: 'connected', nodeId: NODE_ID };
  }

  async setActive(nodeId: string) {
    this.calls.push('setActive');
    this.paired = this.paired.map(node => ({
      ...node,
      active: node.nodeId === nodeId,
    }));
  }

  async forget(nodeId: string) {
    this.calls.push('forget');
    this.paired = this.paired.filter(node => node.nodeId !== nodeId);
    this.linkStatus = { state: 'none' };
    return { nodeRevocationConfirmed: this.forgetConfirmed };
  }

  lastRequest?: CapabilityRequest;
  run(request: CapabilityRequest, onUpdate: (u: CapabilityUpdate) => void) {
    this.calls.push(`run:${request.execution}`);
    this.lastRequest = request;
    return new Promise<RunAudit>(resolve => {
      this.runs.set(request.requestId, {
        listener: onUpdate,
        done: () =>
          resolve({ events: 1, terminalEvents: 1, outOfOrder: false }),
      });
    });
  }

  emitRun(update: CapabilityUpdate) {
    for (const [requestId, run] of this.runs) {
      run.listener(update);
      if (
        update.type === 'completed' ||
        update.type === 'failed' ||
        update.type === 'cancelled'
      ) {
        this.runs.delete(requestId);
        run.done();
      }
    }
  }

  get running() {
    return this.runs.size;
  }

  cancel(requestId: string) {
    this.calls.push('cancel');
    if (this.runs.has(requestId)) {
      this.emitRun({ type: 'cancelled' });
    }
  }
}
