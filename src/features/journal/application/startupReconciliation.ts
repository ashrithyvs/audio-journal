import { NONTERMINAL_RECORDING_STATES } from '../domain/entry';
import {
  planReconciliation,
  type ReconciliationAction,
} from '../domain/reconciliation';
import type { JournalRepository } from '../ports/JournalRepository';
import type { RecordingService } from '../ports/RecordingService';

// Startup recovery (LLD §9 steps 3-4), run after unlock and migrations and
// before any capture. File operations come first because each is idempotent
// and loses nothing authenticated: truncating an unauthenticated tail, or
// moving an unknown file aside. A crash part-way leaves a state the next scan
// plans again. No AI work is resumed (LLD §9 step 5).

export interface ReconciliationSummary {
  promoted: number;
  recoverable: number;
  failed: number;
  damaged: number;
  quarantined: number;
}

export function summarize(
  actions: readonly ReconciliationAction[],
): ReconciliationSummary {
  const count = (type: ReconciliationAction['type']) =>
    actions.filter(action => action.type === type).length;
  return {
    promoted: count('promote'),
    recoverable: count('mark_recoverable'),
    failed: count('mark_failed'),
    damaged: count('flag_source_damaged'),
    quarantined: count('quarantine_file'),
  };
}

async function apply(
  journal: JournalRepository,
  recorder: RecordingService,
  actions: readonly ReconciliationAction[],
  now: () => number,
): Promise<void> {
  for (const action of actions) {
    if (
      (action.type === 'promote' || action.type === 'mark_recoverable') &&
      action.dropTornTail
    ) {
      await recorder.dropTornTail(action.recordingId, action.sealedChunks);
    } else if (action.type === 'quarantine_file') {
      await recorder.quarantine(action.relativePath);
    }
  }
  await journal.applyReconciliation(actions, now());
}

export async function reconcileRecordings(
  journal: JournalRepository,
  recorder: RecordingService,
  now: () => number,
): Promise<ReconciliationSummary> {
  const rows = await journal.recordingsForReconciliation();
  const unfinished = rows
    .filter(row => NONTERMINAL_RECORDING_STATES.includes(row.state))
    .map(row => row.id);
  const actions = planReconciliation(rows, await recorder.scan(unfinished));
  await apply(journal, recorder, actions, now);
  return summarize(actions);
}

/**
 * A capture that ended abnormally while the app was running. It is planned
 * like any unfinished capture: authenticated audio is kept as a ready
 * recording, and only damage needs attention (ADR-017, 2026-10-10).
 */
export async function reconcileAbnormalEnd(
  journal: JournalRepository,
  recorder: RecordingService,
  recordingId: string,
  now: () => number,
): Promise<void> {
  const row = (await journal.recordingsForReconciliation()).find(
    recording => recording.id === recordingId,
  );
  if (!row || !NONTERMINAL_RECORDING_STATES.includes(row.state)) {
    return;
  }
  const files = (await recorder.scan([recordingId])).filter(
    file => file.relativePath === row.relativePath,
  );
  await apply(journal, recorder, planReconciliation([row], files), now);
}
