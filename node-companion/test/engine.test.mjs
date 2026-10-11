// The deterministic engine: pinned outputs, byte-identical reruns, and every
// output valid under contract §6 for its request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resultViolation } from '../src/contract.mjs';
import { ENGINE, organize } from '../src/engine.mjs';
import { canonical } from '../src/json.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(
    join(
      HERE,
      '..',
      '..',
      'schemas',
      'journal',
      'v1',
      'vectors',
      'fixtures.json',
    ),
    'utf8',
  ),
);
const golden = JSON.parse(
  readFileSync(join(HERE, 'golden', 'engine.json'), 'utf8'),
);

test('engine outputs match the pinned golden file', () => {
  assert.deepEqual(golden.engine, ENGINE);
  for (const { fixture, result } of golden.cases) {
    assert.equal(
      canonical(organize(fixtures[fixture])),
      canonical(result),
      fixture,
    );
  }
  assert.equal(golden.cases.length, Object.keys(fixtures).length);
});

test('reruns are byte-identical and every output is valid', () => {
  for (const [name, input] of Object.entries(fixtures)) {
    const a = canonical(organize(input));
    const b = canonical(organize(structuredClone(input)));
    assert.equal(a, b, name);
    assert.equal(resultViolation(Buffer.from(a), input), null, name);
  }
});

test('every voice citation carries the cited segment’s audio range', () => {
  for (const { fixture, result } of golden.cases) {
    const units = new Map(
      fixtures[fixture].entries.flatMap(e =>
        e.units.map(u => [u.unitId, { e, u }]),
      ),
    );
    const items = [
      result.summary,
      ...(result.sections ?? []).flatMap(s => s.items),
      ...['tasks', 'ideas', 'people', 'projects'].flatMap(k => result[k] ?? []),
    ].filter(Boolean);
    for (const item of items) {
      for (const s of item.sources) {
        const { e, u } = units.get(s.unitId);
        if (e.kind === 'voice')
          assert.deepEqual(
            [s.audioStartMs, s.audioEndMs],
            [u.startMs, u.endMs],
          );
        else assert.equal(s.audioStartMs, undefined);
      }
    }
  }
});
