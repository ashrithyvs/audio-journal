// The test-only result padding (serve --test-pad-results): exactly the output
// cap, still valid under every §6 rule, and the whole completed message at
// exactly 61,440 bytes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MESSAGE_CAP, OUTPUT_CAP, resultViolation } from '../src/contract.mjs';
import { organize } from '../src/engine.mjs';
import { byteLength } from '../src/json.mjs';
import { padToCap } from '../src/testPad.mjs';

const fixtures = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
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

test('pads every fixture that asks for ideas to exactly the cap', () => {
  for (const [name, input] of Object.entries(fixtures)) {
    const output = organize(input);
    const padded = padToCap(output, input);
    if (!input.kinds.includes('ideas')) {
      assert.equal(padded, output, name);
      continue;
    }
    assert.equal(byteLength(padded), OUTPUT_CAP, name);
    assert.equal(resultViolation(padded, input), null, name);
    assert.equal(
      byteLength({ data: { output: padded }, sequence: 64, type: 'completed' }),
      MESSAGE_CAP,
      name,
    );
    // The engine's own items are untouched; only ideas were added.
    assert.deepEqual(
      { ...padded, ideas: output.ideas },
      { ...output, ideas: output.ideas },
      name,
    );
  }
});
