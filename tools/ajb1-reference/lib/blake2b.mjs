// BLAKE2b (RFC 7693), unkeyed, with any output length from 1 to 64 bytes.
// 64-bit words are held as (low, high) 32-bit pairs. Argon2id needs variable
// output lengths, which node:crypto's fixed blake2b512 does not offer.
/* eslint-disable no-bitwise -- a hash function is bit manipulation. */

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372,
  0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

/** v[a] += v[b] + m (64-bit add on pairs at word indices a, b). */
function add64(v, a, b) {
  const lo = v[2 * a] + v[2 * b];
  v[2 * a + 1] =
    (v[2 * a + 1] + v[2 * b + 1] + (lo > 0xffffffff ? 1 : 0)) >>> 0;
  v[2 * a] = lo >>> 0;
}

function addMsg(v, a, m, i) {
  const lo = v[2 * a] + m[2 * i];
  v[2 * a + 1] =
    (v[2 * a + 1] + m[2 * i + 1] + (lo > 0xffffffff ? 1 : 0)) >>> 0;
  v[2 * a] = lo >>> 0;
}

/** v[d] = rotr64(v[d] ^ v[a], n). */
function xorRotr(v, d, a, n) {
  let lo = v[2 * d] ^ v[2 * a];
  let hi = v[2 * d + 1] ^ v[2 * a + 1];
  if (n === 32) {
    [lo, hi] = [hi, lo];
  } else if (n < 32) {
    [lo, hi] = [(lo >>> n) | (hi << (32 - n)), (hi >>> n) | (lo << (32 - n))];
  } else {
    const k = n - 32;
    [lo, hi] = [(hi >>> k) | (lo << (32 - k)), (lo >>> k) | (hi << (32 - k))];
  }
  v[2 * d] = lo >>> 0;
  v[2 * d + 1] = hi >>> 0;
}

function mix(v, m, a, b, c, d, x, y) {
  add64(v, a, b);
  addMsg(v, a, m, x);
  xorRotr(v, d, a, 32);
  add64(v, c, d);
  xorRotr(v, b, c, 24);
  add64(v, a, b);
  addMsg(v, a, m, y);
  xorRotr(v, d, a, 16);
  add64(v, c, d);
  xorRotr(v, b, c, 63);
}

function compress(h, block, counter, last) {
  const v = new Uint32Array(32);
  v.set(h, 0);
  v.set(IV, 16);
  // Byte counter: lengths here stay far below 2^53.
  v[24] ^= counter >>> 0;
  v[25] ^= Math.floor(counter / 0x100000000) >>> 0;
  if (last) {
    v[28] = ~v[28] >>> 0;
    v[29] = ~v[29] >>> 0;
  }
  const m = new Uint32Array(32);
  for (let i = 0; i < 32; i += 1) {
    m[i] =
      block[4 * i] |
      (block[4 * i + 1] << 8) |
      (block[4 * i + 2] << 16) |
      (block[4 * i + 3] << 24);
  }
  for (let round = 0; round < 12; round += 1) {
    const s = SIGMA[round % 10];
    mix(v, m, 0, 4, 8, 12, s[0], s[1]);
    mix(v, m, 1, 5, 9, 13, s[2], s[3]);
    mix(v, m, 2, 6, 10, 14, s[4], s[5]);
    mix(v, m, 3, 7, 11, 15, s[6], s[7]);
    mix(v, m, 0, 5, 10, 15, s[8], s[9]);
    mix(v, m, 1, 6, 11, 12, s[10], s[11]);
    mix(v, m, 2, 7, 8, 13, s[12], s[13]);
    mix(v, m, 3, 4, 9, 14, s[14], s[15]);
  }
  for (let i = 0; i < 16; i += 1) {
    h[i] = (h[i] ^ v[i] ^ v[i + 16]) >>> 0;
  }
}

/** BLAKE2b of the concatenated inputs with `outLength` bytes of output. */
export function blake2b(inputs, outLength = 64) {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) {
    throw new RangeError('BLAKE2b output length must be 1..64');
  }
  const data = Buffer.concat(inputs.map(part => Buffer.from(part)));
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010000 ^ outLength;
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let index = 0; index < blocks; index += 1) {
    const block = new Uint8Array(128);
    block.set(data.subarray(index * 128, index * 128 + 128));
    const last = index === blocks - 1;
    compress(h, block, last ? data.length : (index + 1) * 128, last);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i += 1) {
    out.writeUInt32LE(h[i], 4 * i);
  }
  return out.subarray(0, outLength);
}
