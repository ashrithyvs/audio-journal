import type {
  AppRoutingPolicy,
  CapabilitySummary,
  CapabilityUpdate,
  DiscoveryCandidate,
  DiscoveryUpdate,
  ExecutionTarget,
  HybridAiFailure,
  HybridAiInitialization,
  NodeLinkStatus,
  PairedNodeRecord,
  PairingCodeSummary,
  PairingUpdate,
} from '../../../platform/hybrid-ai/HybridAiGateway';
import type { AnalysisCheck } from './analysisResult';
import {
  NODE_LINK_CODES,
  type LinkFailureMark,
} from './connectionPresentation';

export type SdkState =
  // AJ-FR-035: the SDK is not started until the journal is first unlocked.
  | { phase: 'idle' }
  | { phase: 'initializing'; startedAt: number }
  | {
      phase: 'ready';
      capabilityCount: number;
      localModels: 'loaded' | 'unavailable' | 'not_configured';
    }
  | { phase: 'unavailable'; code: string };

export interface DiscoveryState {
  phase: 'idle' | 'searching' | 'stopped' | 'failed';
  candidates: DiscoveryCandidate[];
  failure?: HybridAiFailure;
  startedAt?: number;
}

export type PairingState =
  | { phase: 'idle' }
  | { phase: 'inspecting' }
  | { phase: 'ready'; summary: PairingCodeSummary }
  | { phase: 'pairing'; startedAt: number; summary?: PairingCodeSummary }
  | {
      phase: 'confirming';
      startedAt: number;
      nodeName: string;
      verificationCode: string;
      decision?: { choice: 'confirm' | 'reject'; at: number };
    }
  | { phase: 'paired'; node: PairedNodeRecord }
  | { phase: 'failed'; failure: HybridAiFailure }
  | { phase: 'cancelled' };

export interface LinkState {
  status: NodeLinkStatus;
  operation: 'idle' | 'connecting' | 'forgetting';
  operationStartedAt?: number;
  failure?: HybridAiFailure;
  notice?: 'forgotten_confirmed' | 'forgotten_unconfirmed';
  /**
   * The node's last request or connection failure in this session
   * (AJ3-REV-001/003); cleared by authenticated contact or recovery.
   */
  mark?: LinkFailureMark;
}

/** The node a link failure concerns: the active one, else the status's. */
function markFor(
  state: PrivateNodeState,
  failure: HybridAiFailure | undefined,
): LinkFailureMark | undefined {
  if (!failure || !NODE_LINK_CODES.has(failure.code)) {
    return undefined;
  }
  const nodeId =
    state.paired.find(node => node.active)?.nodeId ?? state.link.status.nodeId;
  return nodeId ? { nodeId, code: failure.code } : undefined;
}

interface RequestBase {
  requestId: string;
  execution: ExecutionTarget;
  events: number;
  startedAt: number;
  firstEventMs?: number;
}

export type RequestState =
  | { phase: 'idle' }
  | ({ phase: 'running' } & RequestBase)
  | ({
      phase: 'completed';
      target: 'local' | 'node';
      routingReason: string;
      totalMs: number;
      check: AnalysisCheck;
    } & RequestBase)
  | ({
      phase: 'failed';
      failure: HybridAiFailure;
      totalMs: number;
    } & RequestBase)
  | ({ phase: 'cancelled'; totalMs: number } & RequestBase);

/** Development baselines only (milliseconds); never production budgets. */
export interface Timings {
  sdkInitMs?: number;
  discoveryFirstMs?: number;
  discoverySettledMs?: number;
  pairingToCodeMs?: number;
  pairingTotalMs?: number;
  confirmToPairedMs?: number;
  reconnectMs?: number;
  firstEventMs?: number;
  firstResponseMs?: number;
}

export interface PrivateNodeState {
  sdk: SdkState;
  policy: AppRoutingPolicy;
  capabilities: CapabilitySummary[];
  paired: PairedNodeRecord[];
  link: LinkState;
  discovery: DiscoveryState;
  pairing: PairingState;
  request: RequestState;
  timings: Timings;
}

export type PrivateNodeAction =
  | { type: 'SDK_INIT_STARTED'; at: number }
  | { type: 'SDK_INIT_FINISHED'; result: HybridAiInitialization; at: number }
  | { type: 'POLICY_CHANGED'; policy: AppRoutingPolicy }
  | {
      type: 'SNAPSHOT';
      status: NodeLinkStatus;
      paired: PairedNodeRecord[];
      capabilities?: CapabilitySummary[];
    }
  | { type: 'STATUS'; status: NodeLinkStatus }
  | { type: 'CONNECT_STARTED'; at: number }
  | { type: 'CONNECT_FINISHED'; at: number; failure?: HybridAiFailure }
  | { type: 'FORGET_STARTED'; at: number }
  | {
      type: 'FORGET_FINISHED';
      nodeId: string;
      confirmed?: boolean;
      failure?: HybridAiFailure;
    }
  | { type: 'DISCOVERY_STARTED'; at: number }
  | { type: 'DISCOVERY_UPDATE'; update: DiscoveryUpdate; at: number }
  | { type: 'DISCOVERY_STOPPED' }
  | { type: 'PAIRING_INSPECT_STARTED' }
  | { type: 'PAIRING_INSPECTED'; summary: PairingCodeSummary }
  | { type: 'PAIRING_INSPECT_FAILED'; failure: HybridAiFailure }
  | { type: 'PAIRING_STARTED'; at: number }
  | { type: 'PAIRING_UPDATE'; update: PairingUpdate; at: number }
  | { type: 'PAIRING_DECISION'; choice: 'confirm' | 'reject'; at: number }
  | { type: 'PAIRING_RESET' }
  | {
      type: 'REQUEST_STARTED';
      requestId: string;
      execution: ExecutionTarget;
      at: number;
    }
  | {
      type: 'REQUEST_UPDATE';
      requestId: string;
      update: CapabilityUpdate;
      at: number;
      check?: AnalysisCheck;
    }
  | { type: 'REQUEST_RESET' }
  | { type: 'LOCKED' };

export const defaultRoutingPolicy: AppRoutingPolicy = {
  allowLocal: true,
  allowNode: true,
};

export const initialPrivateNodeState: PrivateNodeState = {
  sdk: { phase: 'idle' },
  policy: defaultRoutingPolicy,
  capabilities: [],
  paired: [],
  link: { status: { state: 'none' }, operation: 'idle' },
  discovery: { phase: 'idle', candidates: [] },
  pairing: { phase: 'idle' },
  request: { phase: 'idle' },
  timings: {},
};

const pairingActive = (pairing: PairingState) =>
  pairing.phase === 'inspecting' ||
  pairing.phase === 'pairing' ||
  pairing.phase === 'confirming';

function reduceDiscovery(
  state: PrivateNodeState,
  update: DiscoveryUpdate,
  at: number,
): PrivateNodeState {
  const { discovery } = state;
  if (discovery.phase !== 'searching') {
    return state;
  }
  const elapsed = at - (discovery.startedAt ?? at);
  switch (update.type) {
    case 'found':
    case 'updated': {
      const exists = discovery.candidates.some(
        candidate => candidate.nodeId === update.candidate.nodeId,
      );
      const candidates = exists
        ? discovery.candidates.map(candidate =>
            candidate.nodeId === update.candidate.nodeId
              ? update.candidate
              : candidate,
          )
        : [...discovery.candidates, update.candidate];
      return {
        ...state,
        discovery: { ...discovery, candidates },
        timings: {
          ...state.timings,
          discoveryFirstMs: state.timings.discoveryFirstMs ?? elapsed,
          discoverySettledMs: elapsed,
        },
      };
    }
    case 'lost':
      return {
        ...state,
        discovery: {
          ...discovery,
          candidates: discovery.candidates.filter(
            candidate => candidate.nodeId !== update.nodeId,
          ),
        },
        timings: { ...state.timings, discoverySettledMs: elapsed },
      };
    case 'stopped':
      return { ...state, discovery: { ...discovery, phase: 'stopped' } };
    case 'failed':
      return {
        ...state,
        discovery: { ...discovery, phase: 'failed', failure: update.failure },
      };
  }
}

function reducePairing(
  state: PrivateNodeState,
  update: PairingUpdate,
  at: number,
): PrivateNodeState {
  const { pairing } = state;
  if (pairing.phase !== 'pairing' && pairing.phase !== 'confirming') {
    return state;
  }
  switch (update.type) {
    case 'state':
      return state;
    case 'confirmationRequired':
      return {
        ...state,
        pairing: {
          phase: 'confirming',
          startedAt: pairing.startedAt,
          nodeName: update.nodeName,
          verificationCode: update.verificationCode,
        },
        timings: {
          ...state.timings,
          pairingToCodeMs: at - pairing.startedAt,
        },
      };
    case 'paired':
      return {
        ...state,
        pairing: { phase: 'paired', node: update.node },
        paired: [
          ...state.paired
            .filter(node => node.nodeId !== update.node.nodeId)
            .map(node =>
              update.node.active ? { ...node, active: false } : node,
            ),
          update.node,
        ],
        link: {
          ...state.link,
          failure: undefined,
          notice: undefined,
          mark: undefined,
        },
        timings: {
          ...state.timings,
          pairingTotalMs: at - pairing.startedAt,
          confirmToPairedMs:
            pairing.phase === 'confirming' && pairing.decision
              ? at - pairing.decision.at
              : undefined,
        },
      };
    case 'failed':
      return {
        ...state,
        pairing: { phase: 'failed', failure: update.failure },
      };
    case 'cancelled':
      return { ...state, pairing: { phase: 'cancelled' } };
  }
}

function reduceRequest(
  state: PrivateNodeState,
  action: Extract<PrivateNodeAction, { type: 'REQUEST_UPDATE' }>,
): PrivateNodeState {
  const { request } = state;
  if (request.phase !== 'running' || request.requestId !== action.requestId) {
    return state;
  }
  const elapsed = action.at - request.startedAt;
  const base = {
    requestId: request.requestId,
    execution: request.execution,
    startedAt: request.startedAt,
    events: request.events + 1,
    firstEventMs: request.firstEventMs ?? elapsed,
  };
  const timings = {
    ...state.timings,
    firstEventMs: state.timings.firstEventMs ?? base.firstEventMs,
  };
  const { update } = action;
  switch (update.type) {
    case 'completed': {
      const check = action.check ?? { valid: false };
      return {
        ...state,
        // Only a node completion is authenticated contact with the node.
        link:
          update.target === 'node'
            ? { ...state.link, mark: undefined }
            : state.link,
        request: {
          phase: 'completed',
          ...base,
          target: update.target,
          routingReason: update.routingReason,
          totalMs: elapsed,
          check,
        },
        timings: {
          ...timings,
          firstResponseMs: timings.firstResponseMs ?? elapsed,
        },
      };
    }
    case 'failed':
      return {
        ...state,
        request: {
          phase: 'failed',
          ...base,
          failure: update.failure,
          totalMs: elapsed,
        },
        link: {
          ...state.link,
          mark: markFor(state, update.failure) ?? state.link.mark,
        },
        timings,
      };
    case 'cancelled':
      return {
        ...state,
        request: { phase: 'cancelled', ...base, totalMs: elapsed },
        timings,
      };
    default:
      return { ...state, request: { phase: 'running', ...base }, timings };
  }
}

export function privateNodeReducer(
  state: PrivateNodeState,
  action: PrivateNodeAction,
): PrivateNodeState {
  switch (action.type) {
    case 'SDK_INIT_STARTED':
      return state.sdk.phase === 'idle' || state.sdk.phase === 'unavailable'
        ? { ...state, sdk: { phase: 'initializing', startedAt: action.at } }
        : state;
    case 'SDK_INIT_FINISHED': {
      if (state.sdk.phase !== 'initializing') {
        return state;
      }
      const sdk: SdkState =
        action.result.state === 'ready'
          ? {
              phase: 'ready',
              capabilityCount: action.result.capabilityCount,
              localModels: action.result.localModels ?? 'not_configured',
            }
          : { phase: 'unavailable', code: action.result.code };
      return {
        ...state,
        sdk,
        timings: {
          ...state.timings,
          sdkInitMs:
            sdk.phase === 'ready'
              ? action.at - state.sdk.startedAt
              : state.timings.sdkInitMs,
        },
      };
    }
    case 'POLICY_CHANGED':
      return { ...state, policy: action.policy };
    case 'SNAPSHOT':
      return {
        ...state,
        paired: action.paired,
        capabilities: action.capabilities ?? state.capabilities,
        link: {
          ...state.link,
          status: action.status,
          // The SDK reports which node revoked trust; remember it exactly.
          mark:
            action.status.state === 'revoked' && action.status.nodeId
              ? { nodeId: action.status.nodeId, code: 'NODE_TRUST_REVOKED' }
              : state.link.mark,
        },
      };
    case 'STATUS':
      return { ...state, link: { ...state.link, status: action.status } };
    case 'CONNECT_STARTED':
      return state.link.operation === 'idle'
        ? {
            ...state,
            link: {
              ...state.link,
              operation: 'connecting',
              operationStartedAt: action.at,
              failure: undefined,
              notice: undefined,
            },
          }
        : state;
    case 'CONNECT_FINISHED': {
      if (state.link.operation !== 'connecting') {
        return state;
      }
      const elapsed = action.at - (state.link.operationStartedAt ?? action.at);
      return {
        ...state,
        link: {
          ...state.link,
          operation: 'idle',
          operationStartedAt: undefined,
          failure: action.failure,
          // Success is authenticated contact; a link failure marks the node.
          mark: action.failure
            ? markFor(state, action.failure) ?? state.link.mark
            : undefined,
        },
        timings: action.failure
          ? state.timings
          : { ...state.timings, reconnectMs: elapsed },
      };
    }
    case 'FORGET_STARTED':
      return state.link.operation === 'idle'
        ? {
            ...state,
            link: {
              ...state.link,
              operation: 'forgetting',
              operationStartedAt: action.at,
              failure: undefined,
              notice: undefined,
            },
          }
        : state;
    case 'FORGET_FINISHED':
      if (state.link.operation !== 'forgetting') {
        return state;
      }
      if (action.failure) {
        return {
          ...state,
          link: { ...state.link, operation: 'idle', failure: action.failure },
        };
      }
      return {
        ...state,
        paired: state.paired.filter(node => node.nodeId !== action.nodeId),
        link: {
          status:
            state.link.status.nodeId === action.nodeId
              ? { state: 'none' }
              : state.link.status,
          mark:
            state.link.mark?.nodeId === action.nodeId
              ? undefined
              : state.link.mark,
          operation: 'idle',
          notice: action.confirmed
            ? 'forgotten_confirmed'
            : 'forgotten_unconfirmed',
        },
      };
    case 'DISCOVERY_STARTED':
      return {
        ...state,
        discovery: { phase: 'searching', candidates: [], startedAt: action.at },
        timings: {
          ...state.timings,
          discoveryFirstMs: undefined,
          discoverySettledMs: undefined,
        },
      };
    case 'DISCOVERY_UPDATE':
      return reduceDiscovery(state, action.update, action.at);
    case 'DISCOVERY_STOPPED':
      return state.discovery.phase === 'searching'
        ? { ...state, discovery: { ...state.discovery, phase: 'stopped' } }
        : state;
    case 'PAIRING_INSPECT_STARTED':
      return pairingActive(state.pairing)
        ? state
        : { ...state, pairing: { phase: 'inspecting' } };
    case 'PAIRING_INSPECTED':
      return state.pairing.phase === 'inspecting'
        ? { ...state, pairing: { phase: 'ready', summary: action.summary } }
        : state;
    case 'PAIRING_INSPECT_FAILED':
      return state.pairing.phase === 'inspecting'
        ? { ...state, pairing: { phase: 'failed', failure: action.failure } }
        : state;
    case 'PAIRING_STARTED':
      return state.pairing.phase === 'ready'
        ? {
            ...state,
            pairing: {
              phase: 'pairing',
              startedAt: action.at,
              summary: state.pairing.summary,
            },
            timings: {
              ...state.timings,
              pairingToCodeMs: undefined,
              pairingTotalMs: undefined,
              confirmToPairedMs: undefined,
            },
          }
        : state;
    case 'PAIRING_UPDATE':
      return reducePairing(state, action.update, action.at);
    case 'PAIRING_DECISION':
      return state.pairing.phase === 'confirming' && !state.pairing.decision
        ? {
            ...state,
            pairing: {
              ...state.pairing,
              decision: { choice: action.choice, at: action.at },
            },
          }
        : state;
    case 'PAIRING_RESET':
      return { ...state, pairing: { phase: 'idle' } };
    case 'REQUEST_STARTED':
      return state.request.phase === 'running'
        ? state
        : {
            ...state,
            request: {
              phase: 'running',
              requestId: action.requestId,
              execution: action.execution,
              events: 0,
              startedAt: action.at,
            },
          };
    case 'REQUEST_UPDATE':
      return reduceRequest(state, action);
    case 'REQUEST_RESET':
      return state.request.phase === 'running'
        ? state
        : { ...state, request: { phase: 'idle' } };
    case 'LOCKED':
      // Locking ends every user-attended flow; trust and connection state stay.
      return {
        ...state,
        discovery:
          state.discovery.phase === 'searching'
            ? { ...state.discovery, phase: 'stopped' }
            : state.discovery,
        // The pairing code is dropped too, so a ceremony is never left pending.
        pairing:
          pairingActive(state.pairing) || state.pairing.phase === 'ready'
            ? { phase: 'cancelled' }
            : state.pairing,
      };
  }
}
