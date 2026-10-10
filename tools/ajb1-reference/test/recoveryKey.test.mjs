import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  decodeRecoveryKey,
  encodeRecoveryKey,
  passwordBytes,
  WORDS,
} from '../lib/recoveryKey.mjs';

test('the pinned wordlist has 2,048 unique words', () => {
  assert.equal(WORDS.length, 2048);
  assert.equal(new Set(WORDS).size, 2048);
});

test('matches published BIP-39 24-word answers', () => {
  assert.equal(
    encodeRecoveryKey(Buffer.alloc(32, 0x00)),
    `${'abandon '.repeat(23)}art`,
  );
  assert.equal(
    encodeRecoveryKey(Buffer.alloc(32, 0x7f)),
    'legal winner thank year wave sausage worth useful legal winner thank year ' +
      'wave sausage worth useful legal winner thank year wave sausage worth title',
  );
  assert.equal(
    encodeRecoveryKey(Buffer.alloc(32, 0xff)),
    `${'zoo '.repeat(23)}vote`,
  );
});

test('round-trips random entropy and tolerates case and spacing', () => {
  for (let index = 0; index < 50; index += 1) {
    const entropy = randomBytes(32);
    const words = encodeRecoveryKey(entropy);
    assert.deepEqual(decodeRecoveryKey(words).entropy, entropy);
    const messy = `\n ${words.toUpperCase().split(' ').join('  \t')} `;
    assert.deepEqual(decodeRecoveryKey(messy).entropy, entropy);
  }
});

test('reports typed reasons without echoing input', () => {
  const words = encodeRecoveryKey(Buffer.alloc(32, 0x42)).split(' ');
  assert.deepEqual(decodeRecoveryKey(words.slice(1).join(' ')), {
    ok: false,
    reason: 'WORD_COUNT',
  });
  assert.deepEqual(
    decodeRecoveryKey(['abandonx', ...words.slice(1)].join(' ')),
    {
      ok: false,
      reason: 'UNKNOWN_WORD',
      position: 0,
    },
  );
  const swapped = [...words];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.equal(decodeRecoveryKey(swapped.join(' ')).reason, 'CHECKSUM');
});

test('passwords are NFC-normalized UTF-8 with a 12-code-point floor', () => {
  const nfd = 'Pa\u0308sswo\u0308rd fu\u0308r Tagebu\u0308cher';
  assert.deepEqual(
    passwordBytes(nfd).bytes,
    passwordBytes(nfd.normalize('NFC')).bytes,
  );
  assert.equal(passwordBytes('elevenchars').reason, 'WEAK_PASSWORD');
  assert.equal(passwordBytes('\u{1F600}'.repeat(12)).ok, true);
  assert.equal(passwordBytes('x'.repeat(1025)).reason, 'TOO_LONG');
});
