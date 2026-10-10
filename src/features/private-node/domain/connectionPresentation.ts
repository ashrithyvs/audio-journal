import type {
  NodeConnectionState,
  PairedNodeRecord,
} from '../../../platform/hybrid-ai/HybridAiGateway';

export type Tone = 'good' | 'pending' | 'neutral' | 'warning' | 'danger';

export interface ConnectionPresentation {
  label: string;
  detail: string;
  tone: Tone;
  /** Whether the user can usefully ask for a secure reconnect now. */
  canReconnect: boolean;
  /** The node that "Forget and pair again" acts on, when trust has failed. */
  repairNodeId?: string;
}

/**
 * A node's last request or connection failure seen in this session
 * (AJ3-REV-001/003). It overrides a stale "Connected" until a later
 * successful authenticated contact or an explicit recovery clears it.
 */
export interface LinkFailureMark {
  nodeId: string;
  code: string;
}

/** Failure codes that describe the node link rather than one request. */
export const NODE_LINK_CODES: ReadonlySet<string> = new Set([
  'NODE_UNAVAILABLE',
  'NODE_TRUST_REVOKED',
  'NODE_AUTHENTICATION_FAILED',
  'CREDENTIAL_UNAVAILABLE',
]);

type TrustProblem = 'revoked' | 'credential_unavailable';

function trustProblem(
  node: PairedNodeRecord,
  mark: LinkFailureMark | undefined,
): TrustProblem | undefined {
  if (node.state === 'revoked' || node.state === 'credential_unavailable') {
    return node.state;
  }
  if (mark?.nodeId === node.nodeId) {
    if (mark.code === 'NODE_TRUST_REVOKED') {
      return 'revoked';
    }
    if (mark.code === 'CREDENTIAL_UNAVAILABLE') {
      return 'credential_unavailable';
    }
  }
  return undefined;
}

export interface StatusFocus {
  /** The node the status card describes, if exactly one applies. */
  node?: PairedNodeRecord;
  /** Every stored node whose trust failed; each needs forget and pair again. */
  untrusted: PairedNodeRecord[];
  pairedCount: number;
}

/**
 * Which node the status card is about. The SDK deactivates a record whose
 * trust failed, so after a revocation there may be no active node:
 *
 * - the active node, when there is one;
 * - otherwise the exact node whose failure this session saw;
 * - otherwise the only stored record whose trust failed (after a restart).
 *
 * With several such records and no failure seen, none is chosen: each is
 * listed with its own recovery action.
 */
export function focusStatus(
  paired: readonly PairedNodeRecord[],
  mark: LinkFailureMark | undefined,
): StatusFocus {
  const untrusted = paired.filter(node => trustProblem(node, mark));
  const base = { untrusted, pairedCount: paired.length };
  const active = paired.find(node => node.active);
  if (active) {
    return { node: active, ...base };
  }
  const marked = mark
    ? untrusted.find(node => node.nodeId === mark.nodeId)
    : undefined;
  if (marked) {
    return { node: marked, ...base };
  }
  return untrusted.length === 1 ? { node: untrusted[0], ...base } : base;
}

export function presentConnection(
  state: NodeConnectionState,
  focus: StatusFocus,
  connecting: boolean,
  mark?: LinkFailureMark,
): ConnectionPresentation {
  const { node } = focus;
  if (!node) {
    if (focus.untrusted.length > 1) {
      return {
        label: 'Trust revoked',
        detail:
          'Several paired nodes no longer accept this device. Forget each one below, then pair again.',
        tone: 'danger',
        canReconnect: false,
      };
    }
    return focus.pairedCount > 0
      ? {
          label: 'No active node',
          detail:
            'Your journal works fully on this device. Choose a paired node below, or pair a new one.',
          tone: 'neutral',
          canReconnect: false,
        }
      : {
          label: 'No node paired',
          detail:
            'Your journal works fully on this device. Pair a Private AI Node to organize entries on your own computer.',
          tone: 'neutral',
          canReconnect: false,
        };
  }
  const problem =
    trustProblem(node, mark) ??
    (state === 'revoked' ? ('revoked' as const) : undefined);
  if (problem === 'revoked') {
    return {
      label: 'Trust revoked',
      detail:
        'This node no longer trusts this device. Forget it, then pair again.',
      tone: 'danger',
      canReconnect: false,
      repairNodeId: node.nodeId,
    };
  }
  if (problem === 'credential_unavailable') {
    return {
      label: 'Pairing key unavailable',
      detail:
        'This device’s key for the node is unavailable. Forget it, then pair again.',
      tone: 'danger',
      canReconnect: false,
      repairNodeId: node.nodeId,
    };
  }
  if (connecting || state === 'connecting') {
    return {
      label: 'Connecting securely…',
      detail: 'Checking that the node presents the key you paired with.',
      tone: 'pending',
      canReconnect: false,
    };
  }
  // A failed request is direct evidence that a shown "Connected" is stale.
  if (mark?.nodeId === node.nodeId) {
    if (mark.code === 'NODE_UNAVAILABLE') {
      state = 'unavailable';
    } else if (mark.code === 'NODE_AUTHENTICATION_FAILED') {
      state = 'authentication_failed';
    }
  }
  switch (state) {
    case 'connected':
      return {
        label: 'Connected',
        detail: 'Verified with the key you paired with.',
        tone: 'good',
        canReconnect: false,
      };
    case 'reconnecting':
      return {
        label: 'Reconnecting…',
        detail: 'The connection dropped. Your journal is safe on this device.',
        tone: 'pending',
        canReconnect: true,
      };
    case 'authentication_failed':
      return {
        label: 'Identity check failed',
        detail:
          'The node didn’t present the key you paired with, so nothing was sent.',
        tone: 'danger',
        canReconnect: true,
      };
    case 'unavailable':
      return {
        label: 'Unavailable',
        detail:
          'Your journal is safe on this device. Try again when the node is on.',
        tone: 'warning',
        canReconnect: true,
      };
    default:
      return {
        label: 'Not connected',
        detail: 'Paired, but not connected right now.',
        tone: 'neutral',
        canReconnect: true,
      };
  }
}
