// Computed staleness (ADR-020): whether a derivation's citations still
// describe the entries as they are now. Nothing here is stored. A stale item
// is marked, never hidden, and its originally cited source stays reachable.

import type { JournalEntryDetail } from '../../journal/ports/JournalRepository';
import type { OrganizeOutput, SourceRef } from './contract';
import { writtenUnits } from './request';

/** What a cited entry looks like now. */
export interface CurrentEntry {
  ready: boolean;
  /** Voice: the current transcript's segment IDs (correction heads). */
  segments?: ReadonlySet<string>;
  /** Written: each unit's digest, re-split from the current text (§2). */
  writtenDigests?: ReadonlyMap<string, string>;
}

export function currentEntry(
  detail: JournalEntryDetail | null,
  sha256Hex: (text: string) => string,
): CurrentEntry {
  if (!detail || detail.entry.status !== 'ready') {
    return { ready: false };
  }
  if (detail.entry.kind === 'voice') {
    const final = detail.transcript.kind === 'final';
    return {
      ready: true,
      segments: new Set(
        final ? detail.transcript.lines.map(line => line.segmentId) : [],
      ),
    };
  }
  return {
    ready: true,
    writtenDigests: new Map(
      writtenUnits(detail.entry.sourceText ?? '').map((unit, i) => [
        `w${i}`,
        sha256Hex(unit.text),
      ]),
    ),
  };
}

/** A reference whose cited unit is no longer the entry's current text. */
export function referenceStale(
  ref: SourceRef,
  current: ReadonlyMap<string, CurrentEntry>,
): boolean {
  const entry = current.get(ref.entryId);
  if (!entry || !entry.ready) {
    return true;
  }
  if (entry.segments) {
    return !entry.segments.has(ref.unitId);
  }
  return entry.writtenDigests?.get(ref.unitId) !== ref.unitSha256;
}

export interface Staleness {
  /** Any item is stale. */
  stale: boolean;
  /** Keys of stale items: `summary`, `work:3`, `task:0`, `idea:2`, … */
  items: ReadonlySet<string>;
}

/** The stale items of a result (a task's due-date source counts too). */
export function staleness(
  output: OrganizeOutput,
  current: ReadonlyMap<string, CurrentEntry>,
): Staleness {
  const items = new Set<string>();
  const check = (key: string, refs: readonly SourceRef[]) => {
    if (refs.some(ref => referenceStale(ref, current))) {
      items.add(key);
    }
  };
  if (output.summary) {
    check('summary', output.summary.sources);
  }
  for (const section of output.sections ?? []) {
    section.items.forEach((item, i) =>
      check(`${section.area}:${i}`, item.sources),
    );
  }
  output.tasks?.forEach((task, i) =>
    check(
      `task:${i}`,
      task.due ? [...task.sources, task.due.source] : task.sources,
    ),
  );
  output.ideas?.forEach((item, i) => check(`idea:${i}`, item.sources));
  output.people?.forEach((item, i) => check(`person:${i}`, item.sources));
  output.projects?.forEach((item, i) => check(`project:${i}`, item.sources));
  return { stale: items.size > 0, items };
}
