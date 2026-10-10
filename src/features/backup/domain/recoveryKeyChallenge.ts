// Recovery-key confirmation (ADR-017, owner decision 2026-10-10;
// backup-and-restore.md §2). After the 24 words are shown and hidden again,
// the user types the words at three distinct positions chosen with the
// platform CSPRNG. Nothing here logs or stores the words or the answers.

export const RECOVERY_KEY_WORD_COUNT = 24;
export const CHALLENGE_WORDS = 3;

/**
 * Three distinct positions (0-based, ascending). Bytes at or above 240 are
 * rejected so every position is equally likely (240 = 10 x 24).
 */
export function pickChallenge(
  randomBytes: (count: number) => Uint8Array,
  words = RECOVERY_KEY_WORD_COUNT,
  count = CHALLENGE_WORDS,
): number[] {
  const limit = 256 - (256 % words);
  const chosen = new Set<number>();
  while (chosen.size < count) {
    for (const byte of randomBytes(count)) {
      if (byte < limit && chosen.size < count) {
        chosen.add(byte % words);
      }
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

/** §9.7 decoding leniency only: surrounding whitespace and ASCII case. */
const normalize = (word: string) =>
  word.trim().replace(/[A-Z]/g, letter => letter.toLowerCase());

/** True only when every answer is the word at its position, in order. */
export function checkChallenge(
  phrase: readonly string[],
  positions: readonly number[],
  answers: readonly string[],
): boolean {
  return (
    answers.length === positions.length &&
    positions.every(
      (position, index) =>
        phrase[position] !== undefined &&
        normalize(answers[index]) === phrase[position],
    )
  );
}
