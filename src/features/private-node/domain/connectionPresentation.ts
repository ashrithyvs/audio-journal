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
}

export function presentConnection(
  state: NodeConnectionState,
  activeNode: PairedNodeRecord | undefined,
  connecting: boolean,
): ConnectionPresentation {
  if (!activeNode) {
    return {
      label: 'No node paired',
      detail:
        'Your journal works fully on this device. Pair a Private AI Node to organize entries on your own computer.',
      tone: 'neutral',
      canReconnect: false,
    };
  }
  if (activeNode.state === 'revoked' || state === 'revoked') {
    return {
      label: 'Trust revoked',
      detail:
        'This node no longer trusts this device. Forget it, then pair again.',
      tone: 'danger',
      canReconnect: false,
    };
  }
  if (activeNode.state === 'credential_unavailable') {
    return {
      label: 'Pairing key unavailable',
      detail:
        'This device’s key for the node is unavailable. Forget it, then pair again.',
      tone: 'danger',
      canReconnect: false,
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
