import { useEffect, useState } from 'react';

import { useJournal } from '../../journal/application/JournalContext';
import type { JournalEntryDetail } from '../../journal/ports/JournalRepository';
import {
  currentEntry,
  staleness,
  type CurrentEntry,
  type Staleness,
} from '../domain/staleness';
import type { StoredDerivation } from '../ports/DerivationRepository';
import { useOrganize } from './OrganizeContext';

// Data for the Organized and Tasks views (ADR-020). Everything reloads after
// any journal write (`revision`): a stored result, a task transition, or a
// transcript correction that may make a result stale.

export type Load<T> =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; value: T };

function useLoad<T>(
  load: (() => Promise<T>) | undefined,
  deps: readonly unknown[],
): Load<T> {
  const [state, setState] = useState<Load<T>>({ phase: 'loading' });
  useEffect(() => {
    let active = true;
    if (!load) {
      setState({ phase: 'failed' });
      return;
    }
    load().then(
      value => active && setState({ phase: 'ready', value }),
      () => active && setState({ phase: 'failed' }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are explicit.
  }, deps);
  return state;
}

/** The newest revision of every scope, newest first. */
export function useNewestDerivations(): Load<StoredDerivation[]> {
  const organize = useOrganize();
  const { revision } = useJournal();
  return useLoad(
    organize ? () => organize.derivations.newestPerScope() : undefined,
    [organize, revision],
  );
}

/** Every revision of one scope, newest first. */
export function useScopeHistory(scopeKey: string): Load<StoredDerivation[]> {
  const organize = useOrganize();
  const { revision } = useJournal();
  return useLoad(
    organize ? () => organize.derivations.history(scopeKey) : undefined,
    [organize, revision, scopeKey],
  );
}

export interface ScopeState {
  /** Each cited entry as it is now; null when it no longer exists. */
  entries: ReadonlyMap<string, JournalEntryDetail | null>;
  staleness: Staleness;
}

/**
 * The current state of the derivations' cited entries and each derivation's
 * computed staleness (never stored).
 */
export function useScopeStates(
  derivations: readonly StoredDerivation[],
): ReadonlyMap<string, ScopeState> {
  const organize = useOrganize();
  const { journal, revision } = useJournal();
  const [states, setStates] = useState<ReadonlyMap<string, ScopeState>>(
    new Map(),
  );
  const key = derivations.map(d => d.id).join(',');
  useEffect(() => {
    let active = true;
    if (!organize) {
      return;
    }
    (async () => {
      const ids = [...new Set(derivations.flatMap(d => cited(d)))];
      const details = new Map<string, JournalEntryDetail | null>();
      for (const id of ids) {
        details.set(id, await journal.getEntry(id).catch(() => null));
      }
      const current = new Map<string, CurrentEntry>(
        ids.map(id => [
          id,
          currentEntry(
            details.get(id) ?? null,
            organize.services.crypto.sha256Hex,
          ),
        ]),
      );
      const next = new Map<string, ScopeState>();
      for (const d of derivations) {
        next.set(d.id, {
          entries: new Map(cited(d).map(id => [id, details.get(id) ?? null])),
          staleness: staleness(d.output, current),
        });
      }
      if (active) {
        setStates(next);
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by ids.
  }, [key, journal, organize, revision]);
  return states;
}

/** The entries a derivation cites: its scope as stored, in request order. */
function cited(derivation: StoredDerivation): string[] {
  const fromOutput = new Set<string>();
  const add = (refs: readonly { entryId: string }[] | undefined) =>
    refs?.forEach(ref => fromOutput.add(ref.entryId));
  const { output } = derivation;
  add(output.summary?.sources);
  output.sections?.forEach(s => s.items.forEach(i => add(i.sources)));
  for (const list of [
    output.tasks,
    output.ideas,
    output.people,
    output.projects,
  ]) {
    list?.forEach(item => add(item.sources));
  }
  output.tasks?.forEach(t => t.due && add([t.due.source]));
  return [...new Set([...derivation.entryIds, ...fromOutput])];
}
