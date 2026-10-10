import {
  createIdSource,
  isLocalId,
  isRecordingRelativePath,
  newLocalId,
  recordingRelativePath,
} from '../src/features/journal/domain/ids';
import { sequentialIds } from '../test/sqlite/journalFixtures';

const bytes = (fill: number) => () => new Uint8Array(16).fill(fill);

describe('local IDs (AJ-FR-005)', () => {
  it('encodes 128 bits as 26 Crockford base32 characters', () => {
    expect(newLocalId('ent', bytes(0))).toBe(`ent_${'0'.repeat(26)}`);
    const max = newLocalId('rec', bytes(0xff));
    expect(max).toBe(`rec_${'z'.repeat(25)}w`);
    expect(isLocalId(max, 'rec')).toBe(true);
  });

  it('rejects malformed, ambiguous-letter, and wrong-prefix IDs', () => {
    expect(isLocalId(`ent_${'0'.repeat(25)}`)).toBe(false);
    expect(isLocalId(`ent_${'0'.repeat(25)}i`)).toBe(false);
    expect(isLocalId(`ENT_${'0'.repeat(26)}`)).toBe(false);
    expect(isLocalId(`ent_${'0'.repeat(26)}`, 'rec')).toBe(false);
    expect(isLocalId(42)).toBe(false);
  });

  it('refuses a random source that returns the wrong length', () => {
    expect(() => newLocalId('seg', () => new Uint8Array(8))).toThrow();
  });

  it('produces unique IDs from a sequential test source', () => {
    const source = sequentialIds();
    const seen = new Set(
      Array.from({ length: 5_000 }, () => source.next('seg')),
    );
    expect(seen.size).toBe(5_000);
    expect([...seen].every(id => isLocalId(id, 'seg'))).toBe(true);
  });

  it('derives the only accepted recording path from the ID', () => {
    const id = createIdSource(bytes(7)).next('rec');
    const path = recordingRelativePath(id);
    expect(path).toBe(`recordings/${id}.ajr`);
    expect(isRecordingRelativePath(path)).toBe(true);
    for (const hostile of [
      `recordings/../${id}.ajr`,
      `/recordings/${id}.ajr`,
      `recordings/${id}.AJR`,
      `recordings/${id}.ajr/`,
      `recordings\\${id}.ajr`,
      `recordings/${id.replace('rec_', 'ent_')}.ajr`,
    ]) {
      expect(isRecordingRelativePath(hostile)).toBe(false);
    }
    expect(() => recordingRelativePath('../etc/passwd')).toThrow();
  });
});
