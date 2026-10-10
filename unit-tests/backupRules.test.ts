import {
  CHALLENGE_WORDS,
  checkChallenge,
  pickChallenge,
} from '../src/features/backup/domain/recoveryKeyChallenge';
import { assessRestoreTarget } from '../src/features/backup/domain/restoreTarget';
import {
  appendHistory,
  parseHistory,
  suggestedFileName,
} from '../src/features/backup/domain/backupHistory';

// Owner decisions of 2026-10-10 (ADR-017; backup-and-restore.md §2).

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i}`);

/** A scripted byte source; production passes the native CSPRNG. */
function bytes(...values: number[]) {
  const queue = [...values];
  return (count: number) =>
    Uint8Array.from({ length: count }, () => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('random source exhausted');
      }
      return next;
    });
}

describe('recovery-key confirmation', () => {
  it('picks three distinct positions, in ascending order', () => {
    // 3 and 27 both map to position 3; 250 is rejected (it would bias).
    expect(pickChallenge(bytes(20, 3, 27, 250, 9, 0))).toEqual([3, 9, 20]);
    expect(CHALLENGE_WORDS).toBe(3);
  });

  it('is spread over every position for an unbiased source', () => {
    const seen = new Set<number>();
    let next = 0;
    const counter = (count: number) =>
      Uint8Array.from({ length: count }, () => next++ % 240);
    for (let round = 0; round < 40; round += 1) {
      pickChallenge(counter).forEach(position => seen.add(position));
    }
    expect(seen.size).toBe(24);
  });

  it('needs the exact words at those positions, in order', () => {
    const positions = [3, 9, 20];
    expect(
      checkChallenge(PHRASE, positions, ['word3', 'word9', 'word20']),
    ).toBe(true);
    // Only the BIP-39 decoding leniency (§9.7): surrounding space, ASCII case.
    expect(
      checkChallenge(PHRASE, positions, [' WORD3', 'word9 ', 'Word20']),
    ).toBe(true);
    expect(
      checkChallenge(PHRASE, positions, ['word9', 'word3', 'word20']),
    ).toBe(false);
    expect(checkChallenge(PHRASE, positions, ['word3', 'word9'])).toBe(false);
    expect(checkChallenge(PHRASE, positions, ['word3', 'word9', 'wor20'])).toBe(
      false,
    );
  });
});

describe('restore target ("empty journal")', () => {
  const empty = {
    readyEntries: 0,
    needsAttentionEntries: 0,
    playableRecordings: 0,
    hiddenRows: 0,
    leftoverFiles: 0,
  };

  it('allows an empty journal and counts what activation will discard', () => {
    expect(assessRestoreTarget(empty)).toEqual({
      allowed: true,
      discard: { rows: 0, files: 0 },
    });
    expect(
      assessRestoreTarget({ ...empty, hiddenRows: 3, leftoverFiles: 1 }),
    ).toEqual({ allowed: true, discard: { rows: 3, files: 1 } });
  });

  it('refuses whenever there is visible journal content', () => {
    for (const visible of [
      { readyEntries: 1 },
      { needsAttentionEntries: 1 },
      { playableRecordings: 1 },
    ]) {
      expect(assessRestoreTarget({ ...empty, ...visible })).toEqual({
        allowed: false,
        reason: 'JOURNAL_NOT_EMPTY',
      });
    }
  });
});

describe('local backup history and file name (AJ1-DEC-001, option B)', () => {
  it('keeps counts only, newest first, at most ten', () => {
    let history = parseHistory(undefined);
    for (let i = 0; i < 12; i += 1) {
      history = appendHistory(history, {
        atMs: i,
        bytes: 10,
        excludedEntries: i % 2,
      });
    }
    expect(history).toHaveLength(10);
    expect(history[0]).toEqual({ atMs: 11, bytes: 10, excludedEntries: 1 });
    // Anything else in stored history is dropped when read.
    expect(
      parseHistory(
        '[{"atMs":1,"bytes":2,"excludedEntries":0,"title":"x"},{"atMs":-1}]',
      ),
    ).toEqual([{ atMs: 1, bytes: 2, excludedEntries: 0 }]);
    expect(parseHistory('not json')).toEqual([]);
  });

  it('names the file by local time and marks an incomplete backup', () => {
    const at = new Date(2026, 9, 10, 7, 5).getTime();
    expect(suggestedFileName(at, false)).toBe(
      'AudioJournal-2026-10-10-0705.ajbackup',
    );
    expect(suggestedFileName(at, true)).toBe(
      'AudioJournal-2026-10-10-0705-incomplete.ajbackup',
    );
  });
});
