import type { HybridAiFailure } from '../../../platform/hybrid-ai/HybridAiGateway';

// Maps public SDK error codes to user-appropriate copy and one recovery action.
// SDK messages are never shown or kept, since they may echo payload data
// (LLD §11). Unknown codes from a newer SDK degrade to a generic retry.

export type RecoveryAction =
  | 'retry'
  | 'new_code'
  | 'forget_and_repair'
  | 'pair'
  | 'open_settings'
  | 'review_policy'
  | 'none';

export interface FailurePresentation {
  code: string;
  title: string;
  message: string;
  action: RecoveryAction;
}

const NODE_UNAVAILABLE_COPY =
  'Your journal is safe on this device. Try again when your Private AI Node is available.';

const table: Record<string, Omit<FailurePresentation, 'code'>> = {
  DISCOVERY_PERMISSION_DENIED: {
    title: 'Local network access is off',
    message:
      'Allow local network access to find nodes nearby. You can still pair with the code shown on your node.',
    action: 'open_settings',
  },
  DISCOVERY_FAILED: {
    title: 'Couldn’t search nearby',
    message:
      'Searching the local network failed. You can still pair with a code.',
    action: 'retry',
  },
  PAIRING_BOOTSTRAP_INVALID: {
    title: 'That isn’t a valid pairing code',
    message: 'Copy the whole code shown on your Private AI Node and try again.',
    action: 'new_code',
  },
  PAIRING_BOOTSTRAP_EXPIRED: {
    title: 'This pairing code has expired',
    message: 'Show a new pairing code on your Private AI Node and try again.',
    action: 'new_code',
  },
  PAIRING_SESSION_UNAVAILABLE: {
    title: 'The node isn’t accepting this code',
    message:
      'This code was already used or the node closed pairing. Show a new code on your node.',
    action: 'new_code',
  },
  PAIRING_AUTHENTICATION_FAILED: {
    title: 'The node’s identity couldn’t be verified',
    message:
      'Pairing stopped to protect your journal. Use a new code shown on your own node.',
    action: 'new_code',
  },
  PAIRING_REJECTED: {
    title: 'Pairing was declined',
    message:
      'Nothing was paired. Start again with a new code if you meant to pair.',
    action: 'new_code',
  },
  PAIRING_INVALID_STATE: {
    title: 'Pairing was interrupted',
    message: 'Nothing was paired. Start again with a new code.',
    action: 'new_code',
  },
  NODE_TRUST_REVOKED: {
    title: 'This node no longer trusts this device',
    message: 'Forget the node here, then pair again with a new code.',
    action: 'forget_and_repair',
  },
  NODE_AUTHENTICATION_FAILED: {
    title: 'The node couldn’t prove its identity',
    message:
      'The connection was refused because the node didn’t present the key you paired with.',
    action: 'retry',
  },
  NODE_UNAVAILABLE: {
    title: 'Private AI Node unavailable',
    message: NODE_UNAVAILABLE_COPY,
    action: 'retry',
  },
  NODE_NOT_PAIRED: {
    title: 'No Private AI Node is paired',
    message: 'Pair a node with the code shown on it.',
    action: 'pair',
  },
  CREDENTIAL_UNAVAILABLE: {
    title: 'This device’s pairing key is unavailable',
    message: 'Forget the node here, then pair again with a new code.',
    action: 'forget_and_repair',
  },
  CREDENTIAL_STORAGE_FAILED: {
    title: 'The pairing couldn’t be saved',
    message: 'Nothing was paired. Try again with a new code.',
    action: 'new_code',
  },
  CREDENTIAL_ROTATION_FAILED: {
    title: 'Couldn’t refresh this device’s key',
    message: 'The current pairing still works. Try again later.',
    action: 'retry',
  },
  PROTOCOL_INCOMPATIBLE: {
    title: 'This node needs an update',
    message: 'The node uses a protocol this app doesn’t support.',
    action: 'none',
  },
  CANCELLED: {
    title: 'Cancelled',
    message: 'Nothing was changed.',
    action: 'retry',
  },
  DEADLINE_EXCEEDED: {
    title: 'This took too long',
    message: 'The request stopped at its deadline. Nothing was changed.',
    action: 'retry',
  },
  POLICY_DENIED: {
    title: 'Blocked by your AI settings',
    message: 'Your routing settings don’t allow this request.',
    action: 'review_policy',
  },
  CAPABILITY_NOT_FOUND: {
    title: 'This feature isn’t available',
    message: 'Neither this device nor your node offers it.',
    action: 'none',
  },
  LOCAL_CAPABILITY_UNAVAILABLE: {
    title: 'Not available on this device',
    message: 'This feature can’t run on this device right now.',
    action: 'retry',
  },
  NODE_CAPABILITY_UNAVAILABLE: {
    title: 'Not available on your node',
    message: 'Your Private AI Node doesn’t offer this feature right now.',
    action: 'retry',
  },
  SDK_INITIALIZATION_FAILED: {
    title: 'Private AI is unavailable',
    message:
      'Your journal works normally. AI features are unavailable for now.',
    action: 'retry',
  },
  INVALID_RESULT: {
    title: 'The result wasn’t usable',
    message: 'The response didn’t match the expected format and was discarded.',
    action: 'retry',
  },
};

const nodeReasonCopy: Record<string, Omit<FailurePresentation, 'code'>> = {
  node_policy_disabled: {
    title: 'Private AI Node use is off',
    message: 'Turn on “Use Private AI Node” to run this on your node.',
    action: 'review_policy',
  },
  node_not_paired: table.NODE_NOT_PAIRED,
  node_unauthenticated: table.NODE_AUTHENTICATION_FAILED,
  node_unreachable: table.NODE_UNAVAILABLE,
  node_protocol_incompatible: table.PROTOCOL_INCOMPATIBLE,
  node_capability_stale: {
    title: 'Your node is refreshing',
    message: 'Your node’s features are being checked again. Try again shortly.',
    action: 'retry',
  },
};

const generic: Omit<FailurePresentation, 'code'> = {
  title: 'Something went wrong',
  message: 'Nothing was changed. Try again.',
  action: 'retry',
};

export function presentFailure(failure: HybridAiFailure): FailurePresentation {
  if (failure.code === 'NO_ELIGIBLE_TARGET') {
    const byNode = failure.nodeReason && nodeReasonCopy[failure.nodeReason];
    return {
      code: failure.code,
      ...(byNode || {
        title: 'Nowhere to run this',
        message:
          'Neither this device nor a paired node can run this request right now.',
        action: 'retry' as const,
      }),
    };
  }
  return { code: failure.code, ...(table[failure.code] ?? generic) };
}
