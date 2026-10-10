import {
  AJR1_FORMAT,
  type RecordingRecord,
  type RecordingState,
} from '../src/features/journal/domain/entry';
import { recordingRelativePath } from '../src/features/journal/domain/ids';
import {
  planReconciliation,
  type AuthenticatedFileScan,
  type HeaderFileScan,
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
    byteCount: bytesFor(sealedChunks),
  };
}

/** AJR1 file length for whole 1-second chunks (LLD §5.1). */
function bytesFor(chunks: number) {
  return 64 + chunks * 32_028;
}

function scan(
  recording: RecordingRecord,
  chunks: number,
  extra: Partial<AuthenticatedFileScan> = {},
): AuthenticatedFileScan {
  return {
    relativePath: recording.relativePath,
    check: 'authenticated',
    headerValid: true,
    fileBytes: bytesFor(chunks) + (extra.trailingBytes ?? 0),
    authenticatedChunks: chunks,
    authenticatedMs: chunks * 1_000,
    trailingBytes: 0,
    tail: extra.trailingBytes ? 'torn' : 'none',
    byteCount: bytesFor(chunks),
    contentSha256: SHA_A,
    ...extra,
  };
}

function header(
  recording: RecordingRecord,
  fileBytes: number,
  headerValid = true,
): HeaderFileScan {
  return {
    relativePath: recording.relativePath,
    check: 'header',
    headerValid,
    fileBytes,
  };
}

describe('startup reconciliation (LLD §9)', () => {
  it('keeps a crashed capture: drops only the torn frame and promotes the rest', () => {
    const recording = row('recording', 2);
    expect(
      planReconciliation(
        [recording],
        [scan(recording, 4, { trailingBytes: 900 })],
      ),
    ).toEqual([
      {
        type: 'promote',
        recordingId: recording.id,
        entryId: recording.entryId,
        durationMs: 4_000,
        sealedChunks: 4,
        byteCount: bytesFor(4),
        contentSha256: SHA_A,
        dropTornTail: true,
      },
    ]);
  });

  it('promotes finishing and lock-interrupted captures whose chunks authenticate', () => {
    const finishing = row('finalizing', 3);
    const paused = row('paused', 2);
    const actions = planReconciliation(
      [finishing, paused],
      [scan(finishing, 3), scan(paused, 2)],
    );
    expect(actions).toEqual([
      {
        type: 'promote',
        recordingId: finishing.id,
        entryId: finishing.entryId,
        durationMs: 3_000,
        sealedChunks: 3,
        byteCount: bytesFor(3),
        contentSha256: SHA_A,
        dropTornTail: false,
      },
      expect.objectContaining({
        type: 'promote',
        recordingId: paused.id,
        dropTornTail: false,
      }),
    ]);
  });

  it('keeps damaged or incomplete captures for the user without cutting bytes', () => {
    const damaged = row('recording', 2);
    const missing = row('paused', 5); // five chunks were reported sealed
    const noDigest = row('finalizing', 3);
    const actions = planReconciliation(
      [damaged, missing, noDigest],
      [
        scan(damaged, 2, {
          trailingBytes: 64_000,
          tail: 'damaged',
          contentSha256: undefined,
        }),
        scan(missing, 3),
        scan(noDigest, 3, { contentSha256: undefined }),
      ],
    );
    expect(actions).toEqual(
      [damaged, missing, noDigest].map(recording =>
        expect.objectContaining({
          type: 'mark_recoverable',
          recordingId: recording.id,
          dropTornTail: false,
        }),
      ),
    );
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
    const badHeader = row('ready');
    const short = row('ready', 5);
    const tail = row('ready', 2);
    const fine = row('ready', 2);
    const causes = planReconciliation(
      [gone, badHeader, short, tail, fine],
      [
        scan(badHeader, 3, { headerValid: false }),
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

  it('checks finalized recordings by header and exact length only', () => {
    const fine = row('ready', 4);
    const short = row('ready', 4);
    const long = row('ready', 4);
    const invalid = row('ready', 4);
    const causes = planReconciliation(
      [fine, short, long, invalid],
      [
        header(fine, fine.byteCount),
        header(short, fine.byteCount - 1),
        header(long, fine.byteCount + 28),
        header(invalid, fine.byteCount, false),
      ],
    ).map(action => action.type === 'flag_source_damaged' && action.cause);
    expect(causes).toEqual([
      'CHUNKS_MISSING',
      'TRAILING_DATA',
      'HEADER_INVALID',
    ]);
  });

  it('decides nothing about an unfinished capture it could not authenticate', () => {
    const recording = row('recording', 2);
    expect(
      planReconciliation([recording], [header(recording, bytesFor(2) + 9)]),
    ).toEqual([]);
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
