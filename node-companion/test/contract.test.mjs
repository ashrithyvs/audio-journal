// The companion's validation against every journal.organize@1 vector
// (schemas/journal/v1). Cases are read as bytes, exactly as the wire would
// carry them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INPUT_CAP,
  OUTPUT_CAP,
  partialOk,
  resultViolation,
  validateInput,
} from '../src/contract.mjs';
import { byteLength, canonical } from '../src/json.mjs';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'journal',
  'v1',
);
const read = name => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
const fixtures = read('vectors/fixtures.json');
const inputs = read('vectors/inputs.json');
const results = read('vectors/results.json');
const events = read('vectors/events.json');
const manifest = read('vectors.json');

const inputBytes = c => Buffer.from(c.inputText ?? canonical(c.input), 'utf8');
const resultBytes = c =>
  c.resultBase64
    ? Buffer.from(c.resultBase64, 'base64')
    : Buffer.from(c.resultText ?? canonical(c.result), 'utf8');

test('budget matches the manifest', () => {
  assert.equal(INPUT_CAP, manifest.budget.inputCap);
  assert.equal(OUTPUT_CAP, manifest.budget.outputCap);
});

test('every input case reaches its verdict', () => {
  for (const c of inputs) {
    let got;
    try {
      validateInput(inputBytes(c));
      got = { valid: true };
    } catch (error) {
      got = { valid: false, code: error.code };
    }
    assert.deepEqual(got, c.expect, c.name);
  }
  assert.equal(inputs.length, manifest.counts.inputs);
});

test('every result case reaches its verdict and sub-code', () => {
  for (const c of results) {
    const code = resultViolation(resultBytes(c), fixtures[c.fixture]);
    assert.deepEqual(
      code ? { valid: false, code } : { valid: true },
      c.expect,
      c.name,
    );
  }
  assert.equal(results.length, manifest.counts.results);
});

test('the exact caps are inclusive', () => {
  assert.equal(byteLength(fixtures.max), INPUT_CAP);
  const max = results.find(c => c.name === 'valid-maxOutput');
  assert.equal(byteLength(max.result), OUTPUT_CAP);
});

test('partials: counts only, requested kinds only', () => {
  for (const c of events) {
    const input = fixtures[c.fixture ?? 'mixed'];
    let ok = 0;
    let ignored = 0;
    let done = false;
    for (const e of c.events) {
      if (done) break;
      if (e.type === 'partial') {
        if (partialOk(e.delta, input)) ok += 1;
        else ignored += 1;
      }
      if (['completed', 'failed', 'cancelled'].includes(e.type)) done = true;
    }
    assert.equal(ok, c.expect.partials, c.name);
    assert.equal(ignored, c.expect.ignoredPartials ?? 0, c.name);
  }
});
