// Conservative task-state carry-over on a reorganize (ADR-020). A task of the
// new revision takes the state of a task of the scope's previous revision
// only when all of these hold:
// - the normalized texts are equal;
// - their first sources cite the same entry;
// - a source of each is related through the same immutable unit (same
//   unitId and unitSha256), or through an explicit transcript correction
//   lineage (the new segment descends from the old one), with overlapping
//   cited character ranges;
// - the match is one-to-one, with exactly one candidate on each side.
// Pairs are taken in stable rank order. Nothing else carries.

import { normalizedText, type SourceRef } from './contract';
import type { TaskState } from '../ports/DerivationRepository';

export interface PreviousTask {
  id: string;
  ordinal: number;
  text: string;
  state: TaskState;
  stateChangedAt?: number;
  sources: readonly SourceRef[];
}

export interface NextTask {
  ordinal: number;
  text: string;
  sources: readonly SourceRef[];
}

/**
 * The segment a correction row supersedes, or undefined for an engine
 * segment or a written unit (`supersedes_segment_id`).
 */
export type Supersedes = (segmentId: string) => string | undefined;

/** Whether `descendant` is `ancestor` or a later correction of it. */
function descends(
  descendant: string,
  ancestor: string,
  supersedes: Supersedes,
): boolean {
  let at: string | undefined = descendant;
  for (let steps = 0; at !== undefined && steps < 10_000; steps += 1) {
    if (at === ancestor) {
      return true;
    }
    at = supersedes(at);
  }
  return false;
}

function related(
  previous: SourceRef,
  next: SourceRef,
  supersedes: Supersedes,
): boolean {
  if (previous.entryId !== next.entryId) {
    return false;
  }
  const overlap =
    previous.charStart < next.charEnd && next.charStart < previous.charEnd;
  if (!overlap) {
    return false;
  }
  if (previous.unitId === next.unitId) {
    // The same immutable unit: a changed digest is not proven related.
    return previous.unitSha256 === next.unitSha256;
  }
  return descends(next.unitId, previous.unitId, supersedes);
}

function candidate(
  previous: PreviousTask,
  next: NextTask,
  supersedes: Supersedes,
): boolean {
  if (normalizedText(previous.text) !== normalizedText(next.text)) {
    return false;
  }
  if (previous.sources[0]?.entryId !== next.sources[0]?.entryId) {
    return false;
  }
  return previous.sources.some(p =>
    next.sources.some(n => related(p, n, supersedes)),
  );
}

/**
 * For each new task ordinal that carries, its predecessor. Ambiguous tasks
 * (several candidates on either side) and unmatched tasks are absent and
 * start open.
 */
export function matchCarryOver(
  previous: readonly PreviousTask[],
  next: readonly NextTask[],
  supersedes: Supersedes,
): Map<number, PreviousTask> {
  const byRank = [...next].sort((a, b) => a.ordinal - b.ordinal);
  const forNext = new Map<number, PreviousTask[]>();
  const forPrevious = new Map<string, NextTask[]>();
  for (const n of byRank) {
    for (const p of previous) {
      if (candidate(p, n, supersedes)) {
        forNext.set(n.ordinal, [...(forNext.get(n.ordinal) ?? []), p]);
        forPrevious.set(p.id, [...(forPrevious.get(p.id) ?? []), n]);
      }
    }
  }
  const matches = new Map<number, PreviousTask>();
  for (const n of byRank) {
    const candidates = forNext.get(n.ordinal) ?? [];
    if (candidates.length !== 1) {
      continue;
    }
    const [p] = candidates;
    if ((forPrevious.get(p.id) ?? []).length === 1) {
      matches.set(n.ordinal, p);
    }
  }
  return matches;
}
