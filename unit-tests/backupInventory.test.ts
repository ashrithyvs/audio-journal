import {
  ARCHIVE_LIMITS,
  validateArchiveInventory,
  type ArchiveInventory,
  type InventoryContext,
} from '../src/features/backup/domain/archiveInventory';
import { recordingRelativePath } from '../src/features/journal/domain/ids';
import { SHA_A, sequentialIds } from '../test/sqlite/journalFixtures';

const ids = sequentialIds(9);
const context: InventoryContext = {
  supportedFormatVersions: [1],
  maxSchemaVersion: 1,
  availableBytes: 10 * 1024 ** 3,
  reserveBytes: 64 * 1024 ** 2,
};

function archive(): ArchiveInventory {
  const voice = ids.next('ent');
  const written = ids.next('ent');
  const recording = ids.next('rec');
  return {
    formatVersion: 1,
    schemaVersion: 1,
    entries: [
      { id: voice, kind: 'voice', recordingId: recording },
      { id: written, kind: 'written' },
    ],
    recordings: [
      {
        id: recording,
        entryId: voice,
        path: recordingRelativePath(recording),
        durationMs: 2_500,
        bytes: 80_000,
        sha256: SHA_A,
      },
    ],
  };
}

const check = (inventory: ArchiveInventory, ctx = context) =>
  validateArchiveInventory(inventory, ctx);

describe('archive inventory validation (backup-and-restore §6)', () => {
  it('accepts a consistent inventory and totals recording bytes', () => {
    expect(check(archive())).toEqual({ ok: true, recordingBytes: 80_000 });
  });

  it('rejects unsupported format and schema versions (downgrade/upgrade)', () => {
    expect(check({ ...archive(), formatVersion: 2 })).toMatchObject({
      reason: 'UNSUPPORTED_VERSION',
    });
    expect(check({ ...archive(), schemaVersion: 2 })).toMatchObject({
      reason: 'UNSUPPORTED_VERSION',
    });
    expect(check({ ...archive(), schemaVersion: 0 })).toMatchObject({
      reason: 'UNSUPPORTED_VERSION',
    });
  });

  it.each([
    '../recordings/x.ajr',
    'recordings/../../vault.bin',
    '/data/recordings/x.ajr',
    'recordings/REC_X.ajr',
  ])('rejects the unsafe path %s', path => {
    const inventory = archive();
    const recordings = [{ ...inventory.recordings[0], path }];
    expect(check({ ...inventory, recordings })).toMatchObject({
      ok: false,
      reason: 'UNSAFE_PATH',
    });
  });

  it('rejects a path that names a different recording than its ID', () => {
    const inventory = archive();
    const recordings = [
      {
        ...inventory.recordings[0],
        path: recordingRelativePath(ids.next('rec')),
      },
    ];
    expect(check({ ...inventory, recordings })).toMatchObject({
      reason: 'UNSAFE_PATH',
    });
  });

  it('rejects duplicate entry and recording IDs', () => {
    const inventory = archive();
    expect(
      check({
        ...inventory,
        entries: [...inventory.entries, inventory.entries[1]],
      }),
    ).toMatchObject({ reason: 'DUPLICATE_ID', index: 2 });
    expect(
      check({
        ...inventory,
        recordings: [...inventory.recordings, inventory.recordings[0]],
      }),
    ).toMatchObject({ reason: 'DUPLICATE_ID', index: 1 });
  });

  it('rejects invented or malformed IDs', () => {
    const inventory = archive();
    expect(
      check({ ...inventory, entries: [{ id: 'ent_1', kind: 'written' }] }),
    ).toMatchObject({ reason: 'INVALID_ID' });
    expect(
      check({
        ...inventory,
        entries: [
          {
            id: inventory.entries[1].id,
            kind: 'written',
            recordingId: inventory.recordings[0].id,
          },
        ],
      }),
    ).toMatchObject({ reason: 'INVALID_ID' });
  });

  it('rejects dangling references in both directions', () => {
    const inventory = archive();
    expect(check({ ...inventory, recordings: [] })).toMatchObject({
      reason: 'DANGLING_REFERENCE',
    });
    expect(
      check({
        ...inventory,
        recordings: [
          { ...inventory.recordings[0], entryId: inventory.entries[1].id },
        ],
      }),
    ).toMatchObject({ reason: 'DANGLING_REFERENCE' });
  });

  it('rejects inconsistent or oversized recordings', () => {
    const inventory = archive();
    const withRecording = (patch: object) => ({
      ...inventory,
      recordings: [{ ...inventory.recordings[0], ...patch }],
    });
    expect(check(withRecording({ bytes: 80_034 }))).toMatchObject({
      reason: 'INVALID_RECORDING',
    });
    expect(check(withRecording({ bytes: 80_031 }))).toMatchObject({
      reason: 'INVALID_RECORDING',
    });
    expect(
      check(withRecording({ bytes: 80_032, durationMs: 2_501 })),
    ).toMatchObject({
      ok: true,
    });
    expect(check(withRecording({ sha256: 'nothex' }))).toMatchObject({
      reason: 'INVALID_RECORDING',
    });
    expect(check(withRecording({ durationMs: -1, bytes: 0 }))).toMatchObject({
      reason: 'INVALID_RECORDING',
    });
    expect(
      check(withRecording({ bytes: ARCHIVE_LIMITS.maxRecordingBytes + 2 })),
    ).toMatchObject({ reason: 'LIMIT_EXCEEDED' });
  });

  it('rejects excessive counts before walking them', () => {
    const inventory = archive();
    const entries = new Array(ARCHIVE_LIMITS.maxEntries + 1).fill(
      inventory.entries[1],
    );
    expect(check({ ...inventory, entries })).toEqual({
      ok: false,
      reason: 'LIMIT_EXCEEDED',
      index: undefined,
    });
  });

  it('rejects a restore that does not fit with its staging reserve', () => {
    expect(
      check(archive(), {
        ...context,
        availableBytes: context.reserveBytes + 79_999,
      }),
    ).toMatchObject({ reason: 'INSUFFICIENT_STORAGE' });
  });
});
