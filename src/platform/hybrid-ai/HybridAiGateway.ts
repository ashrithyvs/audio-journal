// App-side port over the packaged Hybrid AI public API. Screens and feature
// state depend only on these types; the packaged adapter maps SDK values and
// errors into them (LLD §1, §7).

export type ExecutionTarget = 'local' | 'node' | 'auto';

/** Application-owned routing policy. It only restricts SDK routing. */
export interface AppRoutingPolicy {
  allowLocal: boolean;
  allowNode: boolean;
}

/** A typed SDK failure. `code` is a public SDK error code; messages are never kept. */
export interface HybridAiFailure {
  code: string;
  localReason?: string;
  nodeReason?: string;
}

export class HybridAiGatewayError extends Error {
  constructor(readonly failure: HybridAiFailure) {
    super(failure.code);
    this.name = 'HybridAiGatewayError';
  }
}

/** Whether the app-provided local model directory loaded into the SDK. */
export type LocalModelState = 'loaded' | 'unavailable' | 'not_configured';

export type HybridAiInitialization =
  | {
      state: 'ready';
      capabilityCount: number;
      packageVersion: string;
      localModels?: LocalModelState;
    }
  | { state: 'unavailable'; code: string; packageVersion: string };

export interface CapabilitySummary {
  id: string;
  version: string;
  targets: Array<'local' | 'node'>;
  nodeStale: boolean;
}

export type NodeConnectionState =
  | 'none'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'authentication_failed'
  | 'revoked'
  | 'unavailable';

export interface NodeLinkStatus {
  state: NodeConnectionState;
  nodeId?: string;
}

export interface PairedNodeRecord {
  nodeId: string;
  nodeName: string;
  active: boolean;
  state: 'paired' | 'revoked' | 'credential_unavailable' | 'forgetting';
  pairedAt: number;
}

/** An untrusted LAN discovery hint. It never implies pairing or trust. */
export interface DiscoveryCandidate {
  nodeId: string;
  instanceName: string;
  endpointCount: number;
  protocols: string[];
  pairingOpen: boolean;
}

export type DiscoveryUpdate =
  | { type: 'found' | 'updated'; candidate: DiscoveryCandidate }
  | { type: 'lost'; nodeId: string }
  | { type: 'stopped' }
  | { type: 'failed'; failure: HybridAiFailure };

export interface DiscoveryHandle {
  stop(): Promise<void>;
}

export interface PairingCodeSummary {
  nodeId: string;
  nodeName: string;
  /** Unix time in seconds, as carried by the pairing code. */
  expiresAt: number;
  endpointCount: number;
}

export type PairingUpdate =
  | { type: 'state'; state: string }
  | { type: 'confirmationRequired'; nodeName: string; verificationCode: string }
  | { type: 'paired'; node: PairedNodeRecord }
  | { type: 'failed'; failure: HybridAiFailure }
  | { type: 'cancelled' };

export interface PairingCeremony {
  confirm(): Promise<void>;
  reject(): Promise<void>;
  cancel(): Promise<void>;
}

export interface CapabilityRequest {
  capability: string;
  version: string;
  input: unknown;
  execution: ExecutionTarget;
  timeoutMs: number;
  requestId: string;
}

export type CapabilityUpdate =
  | { type: 'accepted' | 'progress' | 'partial' }
  | {
      type: 'completed';
      output: unknown;
      target: 'local' | 'node';
      routingReason: string;
    }
  | { type: 'failed'; failure: HybridAiFailure }
  | { type: 'cancelled' };

/** What the SDK stream actually emitted, before the adapter's terminal guard. */
export interface RunAudit {
  events: number;
  terminalEvents: number;
  /** Event sequence numbers were not strictly increasing. */
  outOfOrder: boolean;
}

export interface HybridAiGateway {
  readonly packageVersion: string;
  initialize(policy: AppRoutingPolicy): Promise<HybridAiInitialization>;
  setPolicy(policy: AppRoutingPolicy): void;
  capabilities(): Promise<CapabilitySummary[]>;
  status(): Promise<NodeLinkStatus>;
  pairedNodes(): Promise<PairedNodeRecord[]>;
  startDiscovery(onUpdate: (update: DiscoveryUpdate) => void): DiscoveryHandle;
  inspectPairingCode(code: string): Promise<PairingCodeSummary>;
  pair(
    code: string,
    deviceName: string,
    onUpdate: (update: PairingUpdate) => void,
  ): PairingCeremony;
  connect(deadlineMs: number): Promise<void>;
  setActive(nodeId: string): Promise<void>;
  forget(nodeId: string): Promise<{ nodeRevocationConfirmed: boolean }>;
  /**
   * Streams one request; delivers exactly one terminal update and resolves
   * with a raw audit of what the SDK emitted.
   */
  run(
    request: CapabilityRequest,
    onUpdate: (update: CapabilityUpdate) => void,
  ): Promise<RunAudit>;
  cancel(requestId: string): void;
}
