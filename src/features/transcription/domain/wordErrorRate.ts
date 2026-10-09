// WER/CER scoring, kept identical to e2e/speech/lib/metrics.mjs so in-app and
// host results can be cross-checked. The normalizer removes formatting only.

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

export function numberToWords(value: number): string {
  if (value < 20) return ONES[value];
  if (value < 100)
    return `${TENS[Math.floor(value / 10)]}${
      value % 10 ? ` ${ONES[value % 10]}` : ''
    }`;
  if (value < 1000) {
    const rest = value % 100;
    return `${ONES[Math.floor(value / 100)]} hundred${
      rest ? ` ${numberToWords(rest)}` : ''
    }`;
  }
  if (value < 1_000_000) {
    const rest = value % 1000;
    return `${numberToWords(Math.floor(value / 1000))} thousand${
      rest ? ` ${numberToWords(rest)}` : ''
    }`;
  }
  return String(value);
}

const ABBREVIATIONS = new Map([
  ['mr', 'mister'],
  ['mrs', 'missus'],
  ['dr', 'doctor'],
  ['st', 'saint'],
  ['ok', 'okay'],
]);

export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/\d+/g, digits => ` ${numberToWords(Number(digits))} `)
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .map(word => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .map(word => ABBREVIATIONS.get(word) ?? word)
    .join(' ');
}

export interface EditCounts {
  substitutions: number;
  deletions: number;
  insertions: number;
  errors: number;
}

export function align<T>(reference: T[], hypothesis: T[]): EditCounts {
  const cols = hypothesis.length + 1;
  const cost = new Uint32Array((reference.length + 1) * cols);
  for (let i = 0; i <= reference.length; i += 1) cost[i * cols] = i;
  for (let j = 0; j < cols; j += 1) cost[j] = j;
  for (let i = 1; i <= reference.length; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      cost[i * cols + j] = Math.min(
        cost[(i - 1) * cols + j - 1] + same,
        cost[(i - 1) * cols + j] + 1,
        cost[i * cols + j - 1] + 1,
      );
    }
  }
  let i = reference.length;
  let j = hypothesis.length;
  const counts = { substitutions: 0, deletions: 0, insertions: 0, errors: 0 };
  while (i > 0 || j > 0) {
    const here = cost[i * cols + j];
    const same = i > 0 && j > 0 && reference[i - 1] === hypothesis[j - 1];
    if (
      i > 0 &&
      j > 0 &&
      here === cost[(i - 1) * cols + j - 1] + (same ? 0 : 1)
    ) {
      if (!same) counts.substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === cost[(i - 1) * cols + j] + 1) {
      counts.deletions += 1;
      i -= 1;
    } else {
      counts.insertions += 1;
      j -= 1;
    }
  }
  counts.errors = counts.substitutions + counts.deletions + counts.insertions;
  return counts;
}

export interface TranscriptScore {
  referenceWords: number;
  referenceChars: number;
  word: EditCounts;
  char: EditCounts;
  wer: number;
  cer: number;
}

export function scoreTranscript(
  referenceText: string,
  hypothesisText: string,
): TranscriptScore {
  const reference = normalizeTranscript(referenceText);
  const hypothesis = normalizeTranscript(hypothesisText);
  const words = (text: string) => text.split(' ').filter(Boolean);
  const word = align(words(reference), words(hypothesis));
  const char = align(
    [...reference.replace(/ /g, '')],
    [...hypothesis.replace(/ /g, '')],
  );
  const referenceWords = words(reference).length;
  const referenceChars = reference.replace(/ /g, '').length;
  return {
    referenceWords,
    referenceChars,
    word,
    char,
    wer: referenceWords ? word.errors / referenceWords : hypothesis ? 1 : 0,
    cer: referenceChars ? char.errors / referenceChars : hypothesis ? 1 : 0,
  };
}
