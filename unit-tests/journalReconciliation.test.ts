import {
  AJR1_FORMAT,
  type RecordingRecord,
  type RecordingState,
} from '../src/features/journal/domain/entry';
import { recordingRelativePath } from '../src/features/journal/domain/ids';
import {
  planReconciliation,
  type RecordingFileScan,
} from '../src/features/journal/domain/reconciliation';
import { SHA_A, sequentialIds } from '../test/sqlite/journalFixtures';

const ids = sequentialIds();

function row(state: RecordingState, sealedChunks = 3): RecordingRecord {
  const id = ids.next('rec');
  return {
    id,
    entryId: ids.next('ent'),
    relativePath: recordingRelativePath(id),
    state,
    format: AJR1_FORMAT,
    startedAt: 0,
    durationMs: sealedChunks * 1_000,
    sealedChunks,
    byteCount: 0,
  };
}

function scan(
  recording: RecordingRecord,
  chunks: number,
  extra: Partial<RecordingFileScan> = {},
): RecordingFileScan {
  return {
    relativePath: recording.relativePath,
    headerValid: true,
    authenticatedChunks: chunks,
    authenticatedMs: chunks * 1_000,
    trailingBytes: 0,
    byteCount: chunks * 32_028,
    contentSha256: SHA_A,
    ...extra,
  };
}

describe('startup reconciliation (LLD §9)', () => {
  it('keeps a crashed capture recoverable and drops only the torn tail', () => {
    const recording = row('recording', 2);
    expect(
      planReconciliation(
        [recording],
        [scan(recording, 4, { trailingBytes: 900 })],
      ),
    ).toEqual([
      {
        type: 'mark_recoverable',
        recordingId: recording.id,
        entryId: recording.entryId,
        durationMs: 4_000,
        sealedChunks: 4,
        dropTornTail: true,
      },
    ]);
  });

  it('promotes a finishing recording whose every chunk authenticates', () => {
    const recording = row('finalizing', 3);
    expect(planReconciliation([recording], [scan(recording, 3)])).toEqual([
      {
        type: 'promote',
        recordingId: recording.id,
        entryId: recording.entryId,
        durationMs: 3_000,
        sealedChunks: 3,
        byteCount: 3 * 32_028,
        contentSha256: SHA_A,
      },
    ]);
  });

  it('does not promote without a digest or with a torn tail', () => {
    const noDigest = row('finalizing', 3);
    const torn = row('finalizing', 3);
    const actions = planReconciliation(
      [noDigest, torn],
      [
        scan(noDigest, 3, { contentSha256: undefined }),
        scan(torn, 3, { trailingBytes: 10 }),
      ],
    );
    expect(actions.map(action => action.type)).toEqual([
      'mark_recoverable',
      'mark_recoverable',
    ]);
  });

  it('marks captures with no authenticated audio as failed', () => {
    const missing = row('preparing', 0);
    const badHeader = row('paused');
    const empty = row('recording');
    const actions = planReconciliation(
      [missing, badHeader, empty],
      [scan(badHeader, 0, { headerValid: false }), scan(empty, 0)],
    );
    expect(
      actions.map(action => action.type === 'mark_failed' && action.cause),
    ).toEqual(['FILE_MISSING', 'HEADER_INVALID', 'NO_AUDIO']);
  });

  it('surfaces damage to finalized source instead of hiding it', () => {
    const gone = row('ready');
    const header = row('ready');
    const short = row('ready', 5);
    const tail = row('ready', 2);
    const fine = row('ready', 2);
    const causes = planReconciliation(
      [gone, header, short, tail, fine],
      [
        scan(header, 3, { headerValid: false }),
        scan(short, 4),
        scan(tail, 2, { trailingBytes: 1 }),
        scan(fine, 2),
      ],
    ).map(action => action.type === 'flag_source_damaged' && action.cause);
    expect(causes).toEqual([
      'FILE_MISSING',
      'HEADER_INVALID',
      'CHUNKS_MISSING',
      'TRAILING_DATA',
    ]);
  });

  it('quarantines unknown and unsafe files and never deletes', () => {
    const orphan = ids.next('rec');
    const actions = planReconciliation(
      [],
      [
        scan(row('ready'), 1, { relativePath: recordingRelativePath(orphan) }),
        scan(row('ready'), 1, { relativePath: 'recordings/../vault.bin' }),
      ],
    );
    expect(actions).toEqual([
      {
        type: 'quarantine_file',
        relativePath: 'recordings/../vault.bin',
        cause: 'UNSAFE_NAME',
      },
      {
        type: 'quarantine_file',
        relativePath: recordingRelativePath(orphan),
        cause: 'UNKNOWN_FILE',
      },
    ]);
    expect(JSON.stringify(actions)).not.toMatch(/delete/i);
  });

  it('leaves recoverable and failed rows for the user', () => {
    const recoverable = row('recoverable');
    const failed = row('failed');
    expect(
      planReconciliation(
        [recoverable, failed],
        [scan(recoverable, 3), scan(failed, 0)],
      ),
    ).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const rows = [row('recording'), row('paused'), row('finalizing')];
    const files = rows.map(recording => scan(recording, 2));
    expect(
      planReconciliation([...rows].reverse(), [...files].reverse()),
    ).toEqual(planReconciliation(rows, files));
  });
});
