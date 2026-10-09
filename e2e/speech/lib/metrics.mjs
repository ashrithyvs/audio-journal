// Speech-recognition accuracy and performance collectors.
//
// WER/CER use Levenshtein alignment after a documented normalizer that maps
// both reference and hypothesis into the LibriSpeech convention (upper-case
// words, no punctuation, numbers and common abbreviations spelled out). The
// normalizer only removes formatting differences; it never edits word choice.

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

export function numberToWords(value) {
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

export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [BLANK_AUDIO], (music) annotations
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/\d+/g, digits => ` ${numberToWords(Number(digits))} `)
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .map(word => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .map(word => ABBREVIATIONS.get(word) ?? word)
    .join(' ');
}

/** Edit distance with substitution/deletion/insertion counts. */
export function align(reference, hypothesis) {
  const rows = reference.length + 1;
  const cols = hypothesis.length + 1;
  const cost = new Uint32Array(rows * cols);
  for (let i = 0; i < rows; i += 1) cost[i * cols] = i;
  for (let j = 0; j < cols; j += 1) cost[j] = j;
  for (let i = 1; i < rows; i += 1) {
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
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    const here = cost[i * cols + j];
    if (
      i > 0 &&
      j > 0 &&
      here ===
        cost[(i - 1) * cols + j - 1] +
          (reference[i - 1] === hypothesis[j - 1] ? 0 : 1)
    ) {
      if (reference[i - 1] !== hypothesis[j - 1]) substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === cost[(i - 1) * cols + j] + 1) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }
  return {
    substitutions,
    deletions,
    insertions,
    errors: substitutions + deletions + insertions,
  };
}

export function scoreUtterance(referenceText, hypothesisText) {
  const reference = normalize(referenceText);
  const hypothesis = normalize(hypothesisText);
  const words = align(
    reference.split(' ').filter(Boolean),
    hypothesis.split(' ').filter(Boolean),
  );
  const chars = align(
    [...reference.replace(/ /g, '')],
    [...hypothesis.replace(/ /g, '')],
  );
  const referenceWords = reference ? reference.split(' ').length : 0;
  const referenceChars = reference.replace(/ /g, '').length;
  return {
    referenceWords,
    referenceChars,
    word: words,
    char: chars,
    wer: referenceWords ? words.errors / referenceWords : hypothesis ? 1 : 0,
    cer: referenceChars ? chars.errors / referenceChars : hypothesis ? 1 : 0,
    exact: reference === hypothesis,
  };
}

export function percentiles(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = fraction =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    ];
  const round = value => Math.round(value * 1000) / 1000;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

/**
 * Corpus metrics: WER = total word errors / total reference words (not the
 * mean of per-file WERs), plus latency and real-time-factor distributions.
 */
export function aggregate(results) {
  const ok = results.filter(result => result.status === 'ok');
  const sum = key => ok.reduce((total, result) => total + key(result), 0);
  const words = sum(result => result.score.referenceWords);
  const chars = sum(result => result.score.referenceChars);
  const audioSec = sum(result => result.durationSec);
  const inferenceSec = sum(result => result.inferenceMs / 1000);
  return {
    files: results.length,
    failed: results.length - ok.length,
    audioMinutes: Math.round((audioSec / 60) * 100) / 100,
    wer: words
      ? Math.round((sum(r => r.score.word.errors) / words) * 10_000) / 10_000
      : undefined,
    cer: chars
      ? Math.round((sum(r => r.score.char.errors) / chars) * 10_000) / 10_000
      : undefined,
    substitutions: sum(r => r.score.word.substitutions),
    deletions: sum(r => r.score.word.deletions),
    insertions: sum(r => r.score.word.insertions),
    referenceWords: words,
    exactMatchRate: ok.length
      ? Math.round((ok.filter(r => r.score.exact).length / ok.length) * 1000) /
        1000
      : undefined,
    realTimeFactor: audioSec
      ? Math.round((inferenceSec / audioSec) * 1000) / 1000
      : undefined,
    perFileWer: percentiles(ok.map(r => r.score.wer)),
    inferenceMs: percentiles(ok.map(r => r.inferenceMs)),
    wallMs: percentiles(ok.map(r => r.wallMs)),
    rtf: percentiles(ok.map(r => r.inferenceMs / 1000 / r.durationSec)),
    peakRssKb: percentiles(ok.flatMap(r => (r.peakRssKb ? [r.peakRssKb] : []))),
  };
}

export function groupBy(results, key) {
  const groups = {};
  for (const result of results) (groups[key(result)] ??= []).push(result);
  return Object.fromEntries(
    Object.entries(groups).map(([name, list]) => [name, aggregate(list)]),
  );
}
