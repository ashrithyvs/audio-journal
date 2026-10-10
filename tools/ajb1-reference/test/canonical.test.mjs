import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalize,
  parseCanonical,
  parseNdjson,
  serializeNdjson,
} from '../lib/canonicalJson.mjs';

const reason = fn => {
  try {
    fn();
  } catch (error) {
    return error.reason;
  }
  return 'accepted';
};

test('serializes with sorted keys, no whitespace, and JCS string escapes', () => {
  const [DEL, LS, BEL] = [0x7f, 0x2028, 0x07].map(c => String.fromCodePoint(c));
  const E_ACUTE = String.fromCodePoint(0xe9);
  const text = `a/b${DEL}${LS}${BEL}"\\\n`;
  assert.equal(
    canonicalize({ b: 1, a: ['x', true], [E_ACUTE]: text }),
    `{"a":["x",true],"b":1,"${E_ACUTE}":"a/b${DEL}${LS}\\u0007\\"\\\\\\n"}`,
  );
  // UTF-16 code unit order: U+1F600 is D83D DE00, so it sorts before U+FF61.
  const [EMOJI, HALFWIDTH] = [0x1f600, 0xff61].map(c =>
    String.fromCodePoint(c),
  );
  assert.equal(
    canonicalize({ [HALFWIDTH]: 2, [EMOJI]: 1 }),
    `{"${EMOJI}":1,"${HALFWIDTH}":2}`,
  );
});

test('rejects values outside the profile', () => {
  for (const value of [
    null,
    -1,
    1.5,
    2 ** 53,
    -0,
    undefined,
    { a: null },
    '\ud800',
  ]) {
    assert.notEqual(
      reason(() => canonicalize(value)),
      'accepted',
      String(value),
    );
  }
});

test('strict decoding accepts only exact canonical bytes', () => {
  assert.deepEqual(parseCanonical('{"a":1,"b":[true,"x"]}'), {
    a: 1,
    b: [true, 'x'],
  });
  const cases = {
    '{"a":1,"a":2}': 'DUPLICATE_KEY',
    '{"b":1,"a":2}': 'NON_CANONICAL',
    '{"a": 1}': 'SYNTAX',
    '{"a":01}': 'SYNTAX',
    '{"a":1.0}': 'NUMBER_OUT_OF_PROFILE',
    '{"a":1e3}': 'NUMBER_OUT_OF_PROFILE',
    '{"a":-1}': 'NUMBER_OUT_OF_PROFILE',
    '{"a":null}': 'NULL_NOT_ALLOWED',
    '{"a":"\\/"}': 'NON_CANONICAL',
    '{"a":"\\u00e9"}': 'NON_CANONICAL',
    '{"a":"\\ud800"}': 'LONE_SURROGATE',
    '{"a":"\u0001"}': 'UNESCAPED_CONTROL',
    '{"a":1} ': 'TRAILING_DATA',
    '{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{}}}}}}}}}}': 'TOO_DEEP',
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.equal(
      reason(() => parseCanonical(text)),
      expected,
      text,
    );
  }
});

test('duplicate keys are rejected even when nested', () => {
  assert.equal(
    reason(() => parseCanonical('{"a":{"x":1,"x":1}}')),
    'DUPLICATE_KEY',
  );
});

test('NDJSON needs one LF per record and nothing else', () => {
  const text = serializeNdjson([{ t: 'a' }, { t: 'b' }]);
  assert.equal(text, '{"t":"a"}\n{"t":"b"}\n');
  assert.deepEqual(
    [...parseNdjson(text, { maxLineBytes: 100 })].map(item => item.value.t),
    ['a', 'b'],
  );
  assert.deepEqual([...parseNdjson('', { maxLineBytes: 100 })], []);
  const bad = {
    '{"t":"a"}': 'MISSING_FINAL_LF',
    '{"t":"a"}\n\n': 'EMPTY_LINE',
    '{"t":"a"}\r\n': 'TRAILING_DATA',
    '["a"]\n': 'RECORD_NOT_OBJECT',
    [`{"t":"${'x'.repeat(200)}"}\n`]: 'LINE_TOO_LONG',
  };
  for (const [input, expected] of Object.entries(bad)) {
    assert.equal(
      reason(() => [...parseNdjson(input, { maxLineBytes: 100 })]),
      expected,
      JSON.stringify(input),
    );
  }
});
