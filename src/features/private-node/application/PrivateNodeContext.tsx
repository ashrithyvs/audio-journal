import React, {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { Platform } from 'react-native';

import type {
  AppRoutingPolicy,
  DiscoveryHandle,
  ExecutionTarget,
  HybridAiGateway,
  NodeLinkStatus,
  PairedNodeRecord,
  PairingCeremony,
} from '../../../platform/hybrid-ai/HybridAiGateway';
import { HybridAiGatewayError } from '../../../platform/hybrid-ai/HybridAiGateway';
import { useAppLock } from '../../app-lock/application/AppLockContext';
import {
  ANALYZE_CAPABILITY,
  checkAnalysisOutput,
} from '../domain/analysisResult';
import {
  assessCandidates,
  type CandidateView,
} from '../domain/candidatePresentation';
import {
  focusStatus,
  NODE_LINK_CODES,
  type StatusFocus,
} from '../domain/connectionPresentation';
import {
  initialPrivateNodeState,
  privateNodeReducer,
  type PrivateNodeState,
} from '../domain/privateNodeState';

export const CONNECT_DEADLINE_MS = 15_000;
/** At most one link reconciliation per this interval after failed requests. */
export const RECONCILE_DEBOUNCE_MS = 5_000;
const DEVICE_NAME = `Audio Journal (${
  Platform.OS === 'ios' ? 'iOS' : 'Android'
})`;

export interface PrivateNodeOptions {
  /** Status refresh period while unlocked; 0 disables polling. */
  pollIntervalMs?: number;
  now?: () => number;
}

export interface RunRequestInput {
  text: string;
  execution: ExecutionTarget;
  timeoutMs: number;
}

interface PrivateNodeContextValue {
  state: PrivateNodeState;
  /** The app's SDK port, for developer tooling such as the load lab. */
  gateway: HybridAiGateway;
  candidates: CandidateView[];
  activeNode?: PairedNodeRecord;
  /** The node the status describes, including a deactivated revoked one. */
  focus: StatusFocus;
  retryInitialization(): void;
  setPolicy(policy: AppRoutingPolicy): void;
  refresh(): Promise<unknown>;
  startDiscovery(): void;
  stopDiscovery(): void;
  inspectCode(code: string): Promise<void>;
  beginPairing(): void;
  confirmPairing(): void;
  rejectPairing(): void;
  cancelPairing(): void;
  resetPairing(): void;
  reconnect(): Promise<void>;
  makeActive(nodeId: string): Promise<void>;
  forget(nodeId: string): Promise<void>;
  runRequest(input: RunRequestInput): Promise<void>;
  cancelRequest(): void;
  resetRequest(): void;
}

const PrivateNodeContext = createContext<PrivateNodeContextValue | undefined>(
  undefined,
);

const failureOf = (error: unknown, code: string) =>
  error instanceof HybridAiGatewayError ? error.failure : { code };

const defaultNow = () => globalThis.performance?.now?.() ?? Date.now();
let requestCounter = 0;

export function PrivateNodeProvider({
  children,
  gateway,
  options,
}: PropsWithChildren<{
  gateway: HybridAiGateway;
  options?: PrivateNodeOptions;
}>) {
  const { state: lock } = useAppLock();
  const [state, dispatch] = useReducer(
    privateNodeReducer,
    initialPrivateNodeState,
  );
  const now = options?.now ?? defaultNow;
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
  const unlocked = lock.phase === 'unlocked';

  const latest = useRef(state);
  latest.current = state;
  const discovery = useRef<DiscoveryHandle | undefined>(undefined);
  const ceremony = useRef<PairingCeremony | undefined>(undefined);
  const pairingCode = useRef<string | undefined>(undefined);
  const requestId = useRef<string | undefined>(undefined);
  // Refs, not render state, guard async flows so back-to-back calls are safe.
  const sdkReadyRef = useRef(false);
  const linkBusy = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<
    (Pick<PrivateNodeState, 'paired'> & { status: NodeLinkStatus }) | undefined
  > => {
    if (!sdkReadyRef.current) {
      return undefined;
    }
    try {
      const [status, paired, capabilities] = await Promise.all([
        gateway.status(),
        gateway.pairedNodes(),
        gateway.capabilities(),
      ]);
      if (live.current) {
        dispatch({ type: 'SNAPSHOT', status, paired, capabilities });
      }
      return { status, paired };
    } catch {
      // Keep the last snapshot; the next refresh or user action retries.
      return undefined;
    }
  }, [gateway]);

  const connect = useCallback(async () => {
    if (!sdkReadyRef.current || linkBusy.current) {
      return;
    }
    linkBusy.current = true;
    dispatch({ type: 'CONNECT_STARTED', at: now() });
    try {
      await gateway.connect(CONNECT_DEADLINE_MS);
      dispatch({ type: 'CONNECT_FINISHED', at: now() });
    } catch (error) {
      dispatch({
        type: 'CONNECT_FINISHED',
        at: now(),
        failure: failureOf(error, 'NODE_UNAVAILABLE'),
      });
    } finally {
      linkBusy.current = false;
    }
    await refresh();
  }, [gateway, now, refresh]);

  // Reconnect the active paired node when it is known but not connected.
  const reconnectIfPaired = useCallback(async () => {
    const snapshot = await refresh();
    const active = snapshot?.paired.find(
      node => node.active && node.state === 'paired',
    );
    if (
      active &&
      (snapshot?.status.state === 'none' ||
        snapshot?.status.state === 'unavailable')
    ) {
      await connect();
    }
  }, [connect, refresh]);

  const initialize = useCallback(async () => {
    dispatch({ type: 'SDK_INIT_STARTED', at: now() });
    const result = await gateway.initialize(latest.current.policy);
    dispatch({ type: 'SDK_INIT_FINISHED', result, at: now() });
    sdkReadyRef.current = result.state === 'ready';
    if (result.state === 'ready') {
      await reconnectIfPaired();
    }
  }, [gateway, now, reconnectIfPaired]);

  // AJ-FR-035: start the SDK only after the journal is unlocked.
  const wasUnlocked = useRef(false);
  useEffect(() => {
    if (unlocked && !wasUnlocked.current) {
      wasUnlocked.current = true;
      if (latest.current.sdk.phase === 'idle') {
        initialize();
      } else {
        reconnectIfPaired();
      }
    } else if (!unlocked && wasUnlocked.current) {
      wasUnlocked.current = false;
      // Locking ends attended flows. Trust and connection state are untouched.
      discovery.current?.stop();
      discovery.current = undefined;
      ceremony.current?.cancel().catch(() => {});
      ceremony.current = undefined;
      pairingCode.current = undefined;
      if (requestId.current) {
        gateway.cancel(requestId.current);
      }
      dispatch({ type: 'LOCKED' });
    }
  }, [gateway, initialize, reconnectIfPaired, unlocked]);

  const sdkReady = state.sdk.phase === 'ready';
  useEffect(() => {
    if (!unlocked || !sdkReady || pollIntervalMs <= 0) {
      return;
    }
    const timer = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(timer);
  }, [pollIntervalMs, refresh, sdkReady, unlocked]);

  const retryInitialization = useCallback(() => {
    if (unlocked && latest.current.sdk.phase === 'unavailable') {
      initialize();
    }
  }, [initialize, unlocked]);

  const setPolicy = useCallback(
    (policy: AppRoutingPolicy) => {
      if (sdkReadyRef.current) {
        try {
          gateway.setPolicy(policy);
        } catch {
          return;
        }
      }
      dispatch({ type: 'POLICY_CHANGED', policy });
    },
    [gateway],
  );

  const stopDiscovery = useCallback(() => {
    discovery.current?.stop();
    discovery.current = undefined;
    dispatch({ type: 'DISCOVERY_STOPPED' });
  }, []);

  const startDiscovery = useCallback(() => {
    if (!sdkReadyRef.current) {
      return;
    }
    discovery.current?.stop();
    dispatch({ type: 'DISCOVERY_STARTED', at: now() });
    const handle = gateway.startDiscovery(update => {
      if (!live.current) {
        return;
      }
      dispatch({ type: 'DISCOVERY_UPDATE', update, at: now() });
      if (
        (update.type === 'failed' || update.type === 'stopped') &&
        discovery.current === handle
      ) {
        discovery.current = undefined;
      }
    });
    discovery.current = handle;
  }, [gateway, now]);

  const inspectCode = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!sdkReadyRef.current || !trimmed) {
        return;
      }
      dispatch({ type: 'PAIRING_INSPECT_STARTED' });
      try {
        const summary = await gateway.inspectPairingCode(trimmed);
        pairingCode.current = trimmed;
        dispatch({ type: 'PAIRING_INSPECTED', summary });
      } catch (error) {
        pairingCode.current = undefined;
        dispatch({
          type: 'PAIRING_INSPECT_FAILED',
          failure: failureOf(error, 'PAIRING_BOOTSTRAP_INVALID'),
        });
      }
    },
    [gateway],
  );

  const beginPairing = useCallback(() => {
    const code = pairingCode.current;
    // The code is single-use and never retained once the ceremony starts.
    pairingCode.current = undefined;
    if (!code || latest.current.pairing.phase !== 'ready') {
      return;
    }
    dispatch({ type: 'PAIRING_STARTED', at: now() });
    const session = gateway.pair(code, DEVICE_NAME, update => {
      if (!live.current) {
        return;
      }
      dispatch({ type: 'PAIRING_UPDATE', update, at: now() });
      if (
        update.type === 'paired' ||
        update.type === 'failed' ||
        update.type === 'cancelled'
      ) {
        if (ceremony.current === session) {
          ceremony.current = undefined;
        }
        if (update.type === 'paired') {
          connect();
        }
      }
    });
    ceremony.current = session;
  }, [connect, gateway, now]);

  const decide = useCallback(
    (choice: 'confirm' | 'reject') => {
      const session = ceremony.current;
      if (!session || latest.current.pairing.phase !== 'confirming') {
        return;
      }
      dispatch({ type: 'PAIRING_DECISION', choice, at: now() });
      (choice === 'confirm' ? session.confirm() : session.reject()).catch(
        error =>
          dispatch({
            type: 'PAIRING_UPDATE',
            update: {
              type: 'failed',
              failure: failureOf(error, 'PAIRING_INVALID_STATE'),
            },
            at: now(),
          }),
      );
    },
    [now],
  );

  const cancelPairing = useCallback(() => {
    pairingCode.current = undefined;
    if (ceremony.current) {
      ceremony.current.cancel().catch(() => {});
    } else {
      dispatch({ type: 'PAIRING_RESET' });
    }
  }, []);

  const resetPairing = useCallback(() => {
    if (!ceremony.current) {
      pairingCode.current = undefined;
      dispatch({ type: 'PAIRING_RESET' });
    }
  }, []);

  const makeActive = useCallback(
    async (nodeId: string) => {
      try {
        await gateway.setActive(nodeId);
      } catch {
        await refresh();
        return;
      }
      await connect();
    },
    [connect, gateway, refresh],
  );

  const forget = useCallback(
    async (nodeId: string) => {
      if (!sdkReadyRef.current || linkBusy.current) {
        return;
      }
      linkBusy.current = true;
      dispatch({ type: 'FORGET_STARTED', at: now() });
      try {
        const result = await gateway.forget(nodeId);
        dispatch({
          type: 'FORGET_FINISHED',
          nodeId,
          confirmed: result.nodeRevocationConfirmed,
        });
      } catch (error) {
        dispatch({
          type: 'FORGET_FINISHED',
          nodeId,
          failure: failureOf(error, 'CREDENTIAL_UNAVAILABLE'),
        });
      } finally {
        linkBusy.current = false;
      }
      await refresh();
    },
    [gateway, now, refresh],
  );

  // AJ3-REV-001/003: after a node request fails on the link, at most one
  // connect() lets the SDK store the real state (unavailable, revoked, key
  // unavailable). Single-flight and debounced; the request is never retried.
  const lastReconcileAt = useRef(Number.NEGATIVE_INFINITY);
  const reconcileLink = useCallback(async () => {
    const at = now();
    if (
      linkBusy.current ||
      at - lastReconcileAt.current < RECONCILE_DEBOUNCE_MS
    ) {
      return;
    }
    lastReconcileAt.current = at;
    await connect();
  }, [connect, now]);

  const runRequest = useCallback(
    async ({ text, execution, timeoutMs }: RunRequestInput) => {
      if (!sdkReadyRef.current || requestId.current || !text.trim()) {
        return;
      }
      requestCounter += 1;
      const id = `aj3-${Date.now()}-${requestCounter}`;
      requestId.current = id;
      dispatch({
        type: 'REQUEST_STARTED',
        requestId: id,
        execution,
        at: now(),
      });
      let linkFailed = false;
      await gateway.run(
        {
          capability: ANALYZE_CAPABILITY.id,
          version: ANALYZE_CAPABILITY.version,
          input: { document: text },
          execution,
          timeoutMs,
          requestId: id,
        },
        update => {
          if (!live.current) {
            return;
          }
          if (
            update.type === 'failed' &&
            NODE_LINK_CODES.has(update.failure.code)
          ) {
            linkFailed = true;
          }
          dispatch({
            type: 'REQUEST_UPDATE',
            requestId: id,
            update,
            at: now(),
            check:
              update.type === 'completed'
                ? checkAnalysisOutput(update.output)
                : undefined,
          });
        },
      );
      if (requestId.current === id) {
        requestId.current = undefined;
      }
      if (linkFailed && live.current) {
        await reconcileLink();
      }
    },
    [gateway, now, reconcileLink],
  );

  const cancelRequest = useCallback(() => {
    if (requestId.current) {
      gateway.cancel(requestId.current);
    }
  }, [gateway]);

  const resetRequest = useCallback(
    () => dispatch({ type: 'REQUEST_RESET' }),
    [],
  );

  const candidates = useMemo(
    () => assessCandidates(state.discovery.candidates, state.paired),
    [state.discovery.candidates, state.paired],
  );
  const activeNode = state.paired.find(node => node.active);
  const focus = useMemo(
    () => focusStatus(state.paired, state.link.mark),
    [state.paired, state.link.mark],
  );

  const value = useMemo<PrivateNodeContextValue>(
    () => ({
      state,
      gateway,
      candidates,
      activeNode,
      focus,
      retryInitialization,
      setPolicy,
      refresh,
      startDiscovery,
      stopDiscovery,
      inspectCode,
      beginPairing,
      confirmPairing: () => decide('confirm'),
      rejectPairing: () => decide('reject'),
      cancelPairing,
      resetPairing,
      reconnect: connect,
      makeActive,
      forget,
      runRequest,
      cancelRequest,
      resetRequest,
    }),
    [
      activeNode,
      focus,
      beginPairing,
      cancelPairing,
      cancelRequest,
      candidates,
      connect,
      decide,
      forget,
      gateway,
      inspectCode,
      makeActive,
      refresh,
      resetPairing,
      resetRequest,
      retryInitialization,
      runRequest,
      setPolicy,
      startDiscovery,
      state,
      stopDiscovery,
    ],
  );

  return (
    <PrivateNodeContext.Provider value={value}>
      {children}
    </PrivateNodeContext.Provider>
  );
}

export function usePrivateNode(): PrivateNodeContextValue {
  const value = useContext(PrivateNodeContext);
  if (!value) {
    throw new Error('usePrivateNode must be used inside PrivateNodeProvider');
  }
  return value;
}
