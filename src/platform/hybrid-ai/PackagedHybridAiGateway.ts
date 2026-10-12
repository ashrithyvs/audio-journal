import {
  createHybridAI,
  type HybridAI,
  HybridAIError,
  routingReasonOf,
} from '@hybrid-ai/react-native';

import {
  type AppRoutingPolicy,
  type CapabilityRequest,
  type CapabilitySummary,
  type CapabilityUpdate,
  type DiscoveryHandle,
  type DiscoveryUpdate,
  type HybridAiFailure,
  type HybridAiGateway,
  HybridAiGatewayError,
  type HybridAiInitialization,
  type LocalModelState,
  type NodeLinkStatus,
  type PairedNodeRecord,
  type PairingCeremony,
  type PairingCodeSummary,
  type PairingUpdate,
  type RunAudit,
} from './HybridAiGateway';

/** Pinned packaged SDK (`0.1.0-m5`, built from accepted SDK commit `c4b302e`); a unit test checks the installed package. */
export const SDK_PACKAGE_VERSION = '0.1.0-m5';

function failureOf(error: unknown, fallbackCode: string): HybridAiFailure {
  if (error instanceof HybridAiGatewayError) {
    return error.failure;
  }
  if (error instanceof HybridAIError) {
    return {
      code: error.code,
      localReason: error.localReason,
      nodeReason: error.nodeReason,
    };
  }
  return { code: fallbackCode };
}

async function guarded<T>(
  fallbackCode: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new HybridAiGatewayError(failureOf(error, fallbackCode));
  }
}

/** Uses only the package's public TypeScript API. */
export class PackagedHybridAiGateway implements HybridAiGateway {
  readonly packageVersion = SDK_PACKAGE_VERSION;
  private sdk?: HybridAI;
  private starting?: Promise<HybridAiInitialization>;

  /** `modelDirectory` is the app-provisioned local model directory, if any. */
  constructor(private readonly modelDirectory?: string) {}

  initialize(policy: AppRoutingPolicy): Promise<HybridAiInitialization> {
    this.starting ??= this.create(policy);
    return this.starting;
  }

  private async create(
    policy: AppRoutingPolicy,
  ): Promise<HybridAiInitialization> {
    try {
      let localModels: LocalModelState = 'not_configured';
      if (this.modelDirectory) {
        try {
          this.sdk = await createHybridAI({
            pairing: true,
            policy,
            modelDirectory: this.modelDirectory,
          });
          localModels = 'loaded';
        } catch (error) {
          // A rejected model directory must not take node features down.
          if (
            !(error instanceof HybridAIError) ||
            error.code !== 'LOCAL_CAPABILITY_UNAVAILABLE'
          ) {
            throw error;
          }
          localModels = 'unavailable';
        }
      }
      this.sdk ??= await createHybridAI({ pairing: true, policy });
      const capabilities = await this.sdk.capabilities();
      return {
        state: 'ready',
        capabilityCount: capabilities.length,
        packageVersion: SDK_PACKAGE_VERSION,
        localModels,
      };
    } catch (error) {
      // A failed start may be retried by a later call.
      this.starting = undefined;
      return {
        state: 'unavailable',
        code: failureOf(error, 'SDK_INITIALIZATION_FAILED').code,
        packageVersion: SDK_PACKAGE_VERSION,
      };
    }
  }

  private get ready(): HybridAI {
    if (!this.sdk) {
      throw new HybridAiGatewayError({ code: 'SDK_NOT_INITIALIZED' });
    }
    return this.sdk;
  }

  setPolicy(policy: AppRoutingPolicy): void {
    try {
      this.ready.setPolicy(policy);
    } catch (error) {
      throw new HybridAiGatewayError(failureOf(error, 'POLICY_DENIED'));
    }
  }

  capabilities(): Promise<CapabilitySummary[]> {
    return guarded('EXECUTION_FAILED', () => this.ready.capabilities());
  }

  status(): Promise<NodeLinkStatus> {
    return guarded('NODE_UNAVAILABLE', async () => {
      const status = await this.ready.node.status();
      return { state: status.state, nodeId: status.nodeId };
    });
  }

  pairedNodes(): Promise<PairedNodeRecord[]> {
    return guarded('CREDENTIAL_UNAVAILABLE', async () =>
      (await this.ready.node.pairedNodes()).map(node => ({
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        active: node.active,
        state: node.state,
        pairedAt: node.pairedAt,
      })),
    );
  }

  startDiscovery(onUpdate: (update: DiscoveryUpdate) => void): DiscoveryHandle {
    let session: ReturnType<HybridAI['node']['startDiscovery']>;
    try {
      session = this.ready.node.startDiscovery();
    } catch (error) {
      onUpdate({
        type: 'failed',
        failure: failureOf(error, 'DISCOVERY_FAILED'),
      });
      return { stop: async () => {} };
    }
    (async () => {
      try {
        for await (const event of session) {
          if (event.type === 'found' || event.type === 'updated') {
            const { node } = event;
            onUpdate({
              type: event.type,
              candidate: {
                nodeId: node.nodeId,
                instanceName: node.instanceName,
                endpointCount: node.endpointCount,
                protocols: node.protocols,
                pairingOpen: node.pairingOpen,
              },
            });
          } else if (event.type === 'lost') {
            onUpdate({ type: 'lost', nodeId: event.nodeId });
          } else if (event.type === 'failed') {
            onUpdate({
              type: 'failed',
              failure: failureOf(event.error, 'DISCOVERY_FAILED'),
            });
            return;
          } else {
            onUpdate({ type: 'stopped' });
            return;
          }
        }
        onUpdate({ type: 'stopped' });
      } catch (error) {
        onUpdate({
          type: 'failed',
          failure: failureOf(error, 'DISCOVERY_FAILED'),
        });
      }
    })();
    return { stop: () => session.stop() };
  }

  inspectPairingCode(code: string): Promise<PairingCodeSummary> {
    return guarded('PAIRING_BOOTSTRAP_INVALID', () =>
      this.ready.node.parseBootstrap(code),
    );
  }

  pair(
    code: string,
    deviceName: string,
    onUpdate: (update: PairingUpdate) => void,
  ): PairingCeremony {
    let session: ReturnType<HybridAI['node']['pair']>;
    try {
      session = this.ready.node.pair(code, { deviceName, activate: true });
    } catch (error) {
      const failure = failureOf(error, 'PAIRING_INVALID_STATE');
      Promise.resolve().then(() => onUpdate({ type: 'failed', failure }));
      const idle = async () => {};
      return { confirm: idle, reject: idle, cancel: idle };
    }
    let terminal = false;
    const deliver = (update: PairingUpdate) => {
      if (terminal) {
        return;
      }
      terminal =
        update.type === 'paired' ||
        update.type === 'failed' ||
        update.type === 'cancelled';
      onUpdate(update);
    };
    (async () => {
      try {
        for await (const event of session) {
          if (event.type === 'failed') {
            deliver({
              type: 'failed',
              failure: failureOf(event.error, 'PAIRING_INVALID_STATE'),
            });
          } else if (event.type === 'paired') {
            const { node } = event;
            deliver({
              type: 'paired',
              node: {
                nodeId: node.nodeId,
                nodeName: node.nodeName,
                active: node.active,
                state: node.state,
                pairedAt: node.pairedAt,
              },
            });
          } else {
            deliver(event);
          }
        }
      } catch (error) {
        deliver({
          type: 'failed',
          failure: failureOf(error, 'PAIRING_INVALID_STATE'),
        });
      }
      deliver({
        type: 'failed',
        failure: { code: 'PAIRING_INVALID_STATE' },
      });
    })();
    return {
      confirm: () => guarded('PAIRING_INVALID_STATE', () => session.confirm()),
      reject: () => guarded('PAIRING_INVALID_STATE', () => session.reject()),
      cancel: () => guarded('PAIRING_INVALID_STATE', () => session.cancel()),
    };
  }

  connect(deadlineMs: number): Promise<void> {
    return guarded('NODE_UNAVAILABLE', () =>
      this.ready.node.connect({ deadlineMs }),
    );
  }

  setActive(nodeId: string): Promise<void> {
    return guarded('NODE_NOT_PAIRED', () => this.ready.node.setActive(nodeId));
  }

  forget(nodeId: string): Promise<{ nodeRevocationConfirmed: boolean }> {
    return guarded('CREDENTIAL_UNAVAILABLE', () =>
      this.ready.node.forget(nodeId),
    );
  }

  async run(
    request: CapabilityRequest,
    onUpdate: (update: CapabilityUpdate) => void,
  ): Promise<RunAudit> {
    const audit: RunAudit = { events: 0, terminalEvents: 0, outOfOrder: false };
    let lastSequence = 0;
    let terminal = false;
    const deliver = (update: CapabilityUpdate) => {
      if (!terminal) {
        terminal =
          update.type === 'completed' ||
          update.type === 'failed' ||
          update.type === 'cancelled';
        onUpdate(update);
      }
    };
    try {
      for await (const event of this.ready.stream(request)) {
        audit.events += 1;
        if (event.sequence <= lastSequence) {
          audit.outOfOrder = true;
        }
        lastSequence = event.sequence;
        if (event.type === 'completed') {
          audit.terminalEvents += 1;
          deliver({
            type: 'completed',
            output: event.data.output,
            target: event.data.target ?? 'local',
            routingReason: routingReasonOf(event.data.routingReason),
          });
        } else if (event.type === 'failed') {
          audit.terminalEvents += 1;
          deliver({
            type: 'failed',
            failure: failureOf(
              new HybridAIError(
                event.data.code ?? 'EXECUTION_FAILED',
                '',
                event.data,
              ),
              'EXECUTION_FAILED',
            ),
          });
        } else if (event.type === 'cancelled') {
          audit.terminalEvents += 1;
          deliver({ type: 'cancelled' });
        } else if (event.type === 'progress') {
          deliver({
            type: 'progress',
            stage: event.data.stage,
            fraction: event.data.fraction,
          });
        } else if (event.type === 'partial') {
          deliver({ type: 'partial', delta: event.data.delta });
        } else {
          deliver({ type: event.type });
        }
      }
    } catch (error) {
      deliver({
        type: 'failed',
        failure: failureOf(error, 'EXECUTION_FAILED'),
      });
    }
    deliver({ type: 'failed', failure: { code: 'EXECUTION_FAILED' } });
    return audit;
  }

  cancel(requestId: string): void {
    this.sdk?.cancel(requestId);
  }
}
