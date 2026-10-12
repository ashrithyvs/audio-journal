import React, {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import { useJournal } from '../../journal/application/JournalContext';
import { usePrivateNode } from '../../private-node/application/PrivateNodeContext';
import type { OrganizeCrypto } from '../domain/request';
import type { DerivationRepository } from '../ports/DerivationRepository';
import {
  OrganizeController,
  type NodeRunReport,
  type OrganizeSnapshot,
} from './OrganizeController';

// journal.organize@1 for the unlocked app. Mounted inside the journal, so it
// exists only while the database is open; unmounting on lock cancels a run.

export interface OrganizeServices {
  derivations: DerivationRepository;
  crypto: OrganizeCrypto;
  /** CSPRNG bytes as lower-case hex. */
  randomHex: (bytes: number) => string;
}

interface OrganizeContextValue {
  controller: OrganizeController;
  derivations: DerivationRepository;
  /** For the developer organize benchmark. */
  services: OrganizeServices;
}

const OrganizeContext = createContext<OrganizeContextValue | undefined>(
  undefined,
);

export function OrganizeProvider({
  services,
  children,
}: PropsWithChildren<{ services: OrganizeServices }>) {
  const { gateway, reportNodeRun } = usePrivateNode();
  const { journal, now, changed } = useJournal();
  // Read through refs: a new hook identity must not replace a running controller.
  const report = useRef(reportNodeRun);
  const onChanged = useRef(changed);
  useEffect(() => {
    report.current = reportNodeRun;
    onChanged.current = changed;
  }, [changed, reportNodeRun]);

  const controller = useMemo(
    () =>
      new OrganizeController({
        gateway,
        derivations: services.derivations,
        loadEntry: entryId => journal.getEntry(entryId),
        crypto: services.crypto,
        randomHex: services.randomHex,
        now,
        onNodeRun: (result: NodeRunReport) => report.current(result),
      }),
    [gateway, journal, now, services],
  );
  useEffect(() => () => controller.dispose(), [controller]);
  // A stored derivation is new data for screens that show one.
  useEffect(
    () =>
      controller.subscribe(() => {
        const snapshot = controller.getSnapshot();
        if (snapshot.phase === 'done' && snapshot.outcome.kind === 'stored') {
          onChanged.current();
        }
      }),
    [controller],
  );

  const value = useMemo(
    () => ({ controller, derivations: services.derivations, services }),
    [controller, services],
  );
  return (
    <OrganizeContext.Provider value={value}>
      {children}
    </OrganizeContext.Provider>
  );
}

/** Absent when the app was built without organize services. */
export function useOrganize(): OrganizeContextValue | undefined {
  return useContext(OrganizeContext);
}

const IDLE: OrganizeSnapshot = { phase: 'idle' };
const noSubscribe = () => () => undefined;

export function useOrganizeSnapshot(
  controller: OrganizeController | undefined,
): OrganizeSnapshot {
  return useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? (() => IDLE),
  );
}
