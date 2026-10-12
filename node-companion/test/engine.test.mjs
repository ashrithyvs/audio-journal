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

// Amendment A1 (contract §3.2): nothing is left out silently. The kept items
// are the highest-ranked prefix (first occurrence), the rest are counted.

import { OUTPUT_CAP, sha256 } from '../src/contract.mjs';
import { byteLength } from '../src/json.mjs';

/** One written entry whose paragraphs are the given sentences. */
function writtenInput(sentences, kinds) {
  const units = [];
  let offset = 0;
  for (const [i, text] of sentences.entries()) {
    units.push({ unitId: `w${i}`, text, sha256: sha256(text), offset });
    offset += text.length + 2;
  }
  return {
    contract: 'journal.organize@1',
    requestKey: `org_${'0'.repeat(26)}`,
    locale: 'en-IN',
    timeZone: 'Asia/Kolkata',
    kinds,
    entries: [
      {
        entryId: `ent_${'1'.repeat(26)}`,
        kind: 'written',
        createdAt: '2026-10-11T08:00:00.000Z',
        units,
      },
    ],
  };
}

test('more than 50 tasks: the 50 highest-ranked are kept and the rest counted', () => {
  const input = writtenInput(
    Array.from({ length: 64 }, (_, i) => `I need to call supplier ${i + 1}.`),
    ['tasks'],
  );
  const out = organize(input);
  assert.equal(resultViolation(out, input), null);
  assert.equal(out.completeness, 'partial');
  assert.deepEqual(out.omitted, { tasks: 14 });
  assert.deepEqual(
    out.tasks.map(t => t.text),
    Array.from({ length: 50 }, (_, i) => `Call supplier ${i + 1}.`),
  );
});

test('over the output budget: lowest-ranked items are dropped, counted, and marked', () => {
  const pad = ' about the quarterly vendor review'.repeat(11);
  const input = writtenInput(
    Array.from(
      { length: 50 },
      (_, i) => `I need to email partner ${i + 1}${pad} for item ${i + 1}.`,
    ),
    ['sections', 'tasks'],
  );
  const out = organize(input);
  assert.equal(resultViolation(out, input), null);
  assert.ok(byteLength(out) <= OUTPUT_CAP);
  assert.equal(out.completeness, 'partial');
  const kept = out.tasks.length + out.sections.flatMap(s => s.items).length;
  const dropped = Object.values(out.omitted).reduce((a, b) => a + b, 0);
  assert.ok(dropped > 0);
  // Every task and Work item was found; kept + omitted accounts for all.
  assert.equal(kept + dropped, 100);
  // The kept items are the highest-ranked prefix of each list, in rank
  // order: the dropped one is the last Work item.
  assert.deepEqual(out.omitted, { sections: 1 });
  out.tasks.forEach((t, i) =>
    assert.match(t.text, new RegExp(`^Email partner ${i + 1} `)),
  );
  out.sections[0].items.forEach((item, i) =>
    assert.match(item.text, new RegExp(`partner ${i + 1} `)),
  );
  assert.equal(out.sections[0].items.length, 49);
});

test('a result within every bound is complete and carries no omitted counts', () => {
  for (const name of Object.keys(fixtures)) {
    const out = organize(fixtures[name]);
    assert.deepEqual(
      [name, out.completeness, 'omitted' in out],
      [name, 'complete', false],
    );
  }
});
