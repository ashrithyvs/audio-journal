import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { argon2, ARGON2D, ARGON2I, ARGON2ID } from '../lib/argon2.mjs';
import { blake2b } from '../lib/blake2b.mjs';

test('BLAKE2b matches RFC 7693 and node:crypto blake2b512', () => {
  assert.equal(
    blake2b([Buffer.from('abc')]).toString('hex'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
      '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );
  for (const length of [0, 1, 127, 128, 129, 255, 256, 1000]) {
    const data = randomBytes(length);
    assert.deepEqual(
      blake2b([data]),
      createHash('blake2b512').update(data).digest(),
      `length ${length}`,
    );
  }
});

// RFC 9106 §5 test vectors: m = 32 KiB, t = 3, p = 4, 32-byte tag.
const rfc = {
  password: Buffer.alloc(32, 0x01),
  salt: Buffer.alloc(16, 0x02),
  secret: Buffer.alloc(8, 0x03),
  ad: Buffer.alloc(12, 0x04),
  m: 32,
  t: 3,
  p: 4,
};

test('Argon2d matches RFC 9106 §5.1', () => {
  assert.equal(
    argon2({ ...rfc, type: ARGON2D }).toString('hex'),
    '512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb',
  );
});

test('Argon2i matches RFC 9106 §5.2', () => {
  assert.equal(
    argon2({ ...rfc, type: ARGON2I }).toString('hex'),
    'c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8',
  );
});

test('Argon2id matches RFC 9106 §5.3', () => {
  assert.equal(
    argon2({ ...rfc, type: ARGON2ID }).toString('hex'),
    '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
  );
});

test('Argon2 rejects invalid parameters', () => {
  assert.throws(() => argon2({ ...rfc, m: 31 }));
  assert.throws(() => argon2({ ...rfc, t: 0 }));
  assert.throws(() => argon2({ ...rfc, p: 0 }));
});
