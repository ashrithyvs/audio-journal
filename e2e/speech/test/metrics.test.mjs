import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregate,
  align,
  normalize,
  numberToWords,
  percentiles,
  scoreUtterance,
} from '../lib/metrics.mjs';

test('normalizes formatting into the LibriSpeech convention', () => {
  assert.equal(
    normalize("Mr. Quilter's 2 dogs, [BLANK_AUDIO] 1,500 ways!"),
    "mister quilter's two dogs one thousand five hundred ways",
  );
  assert.equal(normalize('MISTER QUILTER’S'), "mister quilter's");
  assert.equal(numberToWords(42), 'forty two');
  assert.equal(numberToWords(1906), 'one thousand nine hundred six');
});

test('counts substitutions, deletions, and insertions', () => {
  assert.deepEqual(align(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']), {
    substitutions: 1,
    deletions: 0,
    insertions: 1,
    errors: 2,
  });
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'c']), {
    substitutions: 0,
    deletions: 1,
    insertions: 0,
    errors: 1,
  });
  assert.deepEqual(align([], ['x']), {
    substitutions: 0,
    deletions: 0,
    insertions: 1,
    errors: 1,
  });
});

test('scores an utterance with WER and CER', () => {
  const score = scoreUtterance(
    'THE CAT SAT ON THE MAT',
    'The cat sat on a mat.',
  );
  assert.equal(score.referenceWords, 6);
  assert.equal(score.word.errors, 1);
  assert.ok(Math.abs(score.wer - 1 / 6) < 1e-9);
  assert.equal(scoreUtterance('HELLO', 'hello').exact, true);
  assert.equal(scoreUtterance('HELLO WORLD', '').wer, 1);
});

test('computes corpus WER from totals, not the mean of file WERs', () => {
  const file = (ref, hyp, durationSec, inferenceMs) => ({
    status: 'ok',
    durationSec,
    inferenceMs,
    wallMs: inferenceMs,
    score: scoreUtterance(ref, hyp),
  });
  const result = aggregate([
    file('A B C D E F G H I J', 'A B C D E F G H I J', 10, 1000),
    file('X', 'Y', 1, 100),
    { status: 'failed', durationSec: 5 },
  ]);
  assert.equal(result.wer, Math.round((1 / 11) * 10_000) / 10_000);
  assert.equal(result.failed, 1);
  assert.equal(result.realTimeFactor, 0.1);
  assert.deepEqual(percentiles([3, 1, 2]), {
    n: 3,
    p50: 2,
    p90: 3,
    p95: 3,
    p99: 3,
    max: 3,
    mean: 2,
  });
});
