// Argon2 (RFC 9106), version 0x13, types d (0), i (1), and id (2). This is an
// independent host implementation used only to generate and check AJB1
// vectors; the app uses the pinned native libargon2 (ADR-017). Lanes run
// sequentially, which gives the same output as parallel execution.
/* eslint-disable no-bitwise -- a hash function is bit manipulation. */

import { blake2b } from './blake2b.mjs';

export const ARGON2D = 0;
export const ARGON2I = 1;
export const ARGON2ID = 2;
const VERSION = 0x13;
const SYNC_POINTS = 4;
const BLOCK_WORDS = 256; // 128 64-bit words as 32-bit (low, high) pairs.

const le32 = value => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
};

/** Variable-length hash H' (RFC 9106 §3.3). */
function hashLong(outLength, input) {
  if (outLength <= 64) {
    return blake2b([le32(outLength), input], outLength);
  }
  const blocks = Math.ceil(outLength / 32) - 2;
  const out = Buffer.alloc(outLength);
  let v = blake2b([le32(outLength), input], 64);
  v.copy(out, 0, 0, 32);
  for (let index = 1; index < blocks; index += 1) {
    v = blake2b([v], 64);
    v.copy(out, index * 32, 0, 32);
  }
  const rest = outLength - 32 * blocks;
  blake2b([v], rest).copy(out, blocks * 32);
  return out;
}

// 64-bit words are (low, high) 32-bit pairs at [2i, 2i + 1]. The hot path
// (G, P, and block compression) allocates nothing: a derivation runs it
// millions of times.

/** High 32 bits of the 64-bit product of two 32-bit values. */
function mulHi32(a, b) {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  return (a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
}

/** w[a] = w[a] + w[b] + 2 * lo(w[a]) * lo(w[b]) (the BlaMka multiply). */
function fBlaMka(w, a, b) {
  const ia = 2 * a;
  const ib = 2 * b;
  const al = w[ia];
  const bl = w[ib];
  const productLow = Math.imul(al, bl) >>> 0;
  const productHigh = mulHi32(al, bl);
  const doubledLow = (productLow << 1) >>> 0;
  const doubledHigh = ((productHigh << 1) | (productLow >>> 31)) >>> 0;
  const sum = al + bl;
  const low = (sum >>> 0) + doubledLow;
  w[ia + 1] =
    w[ia + 1] +
    w[ib + 1] +
    doubledHigh +
    (sum > 0xffffffff ? 1 : 0) +
    (low > 0xffffffff ? 1 : 0);
  w[ia] = low;
}

/** w[d] = rotr64(w[d] ^ w[a], n). */
function xorRotr(w, d, a, n) {
  const id = 2 * d;
  const ia = 2 * a;
  const lo = w[id] ^ w[ia];
  const hi = w[id + 1] ^ w[ia + 1];
  if (n === 32) {
    w[id] = hi;
    w[id + 1] = lo;
  } else if (n < 32) {
    w[id] = (lo >>> n) | (hi << (32 - n));
    w[id + 1] = (hi >>> n) | (lo << (32 - n));
  } else {
    const k = n - 32;
    w[id] = (hi >>> k) | (lo << (32 - k));
    w[id + 1] = (lo >>> k) | (hi << (32 - k));
  }
}

function gb(w, a, b, c, d) {
  fBlaMka(w, a, b);
  xorRotr(w, d, a, 32);
  fBlaMka(w, c, d);
  xorRotr(w, b, c, 24);
  fBlaMka(w, a, b);
  xorRotr(w, d, a, 16);
  fBlaMka(w, c, d);
  xorRotr(w, b, c, 63);
}

/** Permutation P over 16 words given by their indices in the block. */
function permute(w, i) {
  gb(w, i[0], i[4], i[8], i[12]);
  gb(w, i[1], i[5], i[9], i[13]);
  gb(w, i[2], i[6], i[10], i[14]);
  gb(w, i[3], i[7], i[11], i[15]);
  gb(w, i[0], i[5], i[10], i[15]);
  gb(w, i[1], i[6], i[11], i[12]);
  gb(w, i[2], i[7], i[8], i[13]);
  gb(w, i[3], i[4], i[9], i[14]);
}

const ROWS = Array.from(
  { length: 8 },
  (_, r) => new Int32Array(Array.from({ length: 16 }, (__, k) => 16 * r + k)),
);
// Column c: 64-bit words (2c, 2c + 1) of each of the 8 rows.
const COLUMNS = Array.from(
  { length: 8 },
  (_, c) =>
    new Int32Array(
      Array.from({ length: 16 }, (__, k) => 16 * (k >> 1) + 2 * c + (k & 1)),
    ),
);

const R = new Uint32Array(BLOCK_WORDS);
const Q = new Uint32Array(BLOCK_WORDS);

/** G(X, Y) (RFC 9106 §3.5), XORed into `out` when `xorInto` is set. */
function compressBlocks(out, x, y, xorInto) {
  for (let i = 0; i < BLOCK_WORDS; i += 1) {
    R[i] = x[i] ^ y[i];
  }
  Q.set(R);
  for (let index = 0; index < 8; index += 1) {
    permute(Q, ROWS[index]);
  }
  for (let index = 0; index < 8; index += 1) {
    permute(Q, COLUMNS[index]);
  }
  if (xorInto) {
    for (let i = 0; i < BLOCK_WORDS; i += 1) {
      out[i] ^= Q[i] ^ R[i];
    }
  } else {
    for (let i = 0; i < BLOCK_WORDS; i += 1) {
      out[i] = Q[i] ^ R[i];
    }
  }
}

const ZERO_BLOCK = new Uint32Array(BLOCK_WORDS);

function blockFromBytes(bytes) {
  const block = new Uint32Array(BLOCK_WORDS);
  for (let i = 0; i < BLOCK_WORDS; i += 1) {
    block[i] = bytes.readUInt32LE(4 * i);
  }
  return block;
}

/**
 * Argon2 tag. `password`, `salt`, `secret`, and `ad` are byte arrays; `m` is
 * memory in KiB, `t` passes, `p` lanes, `type` 0/1/2.
 */
export function argon2({
  type = ARGON2ID,
  password,
  salt,
  secret = Buffer.alloc(0),
  ad = Buffer.alloc(0),
  m,
  t,
  p,
  tagLength = 32,
}) {
  if (!(p >= 1 && t >= 1 && m >= 8 * p && tagLength >= 4)) {
    throw new RangeError('invalid Argon2 parameters');
  }
  const bytes = value => Buffer.from(value);
  const h0 = blake2b(
    [
      le32(p),
      le32(tagLength),
      le32(m),
      le32(t),
      le32(VERSION),
      le32(type),
      le32(password.length),
      bytes(password),
      le32(salt.length),
      bytes(salt),
      le32(secret.length),
      bytes(secret),
      le32(ad.length),
      bytes(ad),
    ],
    64,
  );

  const segmentLength = Math.floor(m / (SYNC_POINTS * p));
  const laneLength = segmentLength * SYNC_POINTS;
  const memory = Array.from({ length: p * laneLength }, () => null);
  const at = (lane, index) => memory[lane * laneLength + index];

  for (let lane = 0; lane < p; lane += 1) {
    for (let index = 0; index < 2; index += 1) {
      memory[lane * laneLength + index] = blockFromBytes(
        hashLong(1024, Buffer.concat([h0, le32(index), le32(lane)])),
      );
    }
  }

  for (let pass = 0; pass < t; pass += 1) {
    for (let slice = 0; slice < SYNC_POINTS; slice += 1) {
      for (let lane = 0; lane < p; lane += 1) {
        const independent =
          type === ARGON2I ||
          (type === ARGON2ID && pass === 0 && slice < SYNC_POINTS / 2);
        let addresses;
        const input = new Uint32Array(BLOCK_WORDS);
        if (independent) {
          input[0] = pass;
          input[2] = lane;
          input[4] = slice;
          input[6] = p * laneLength; // m', the total number of blocks
          input[8] = t;
          input[10] = type;
        }
        const nextAddresses = () => {
          input[12] = (input[12] + 1) >>> 0;
          const tmp = new Uint32Array(BLOCK_WORDS);
          compressBlocks(tmp, ZERO_BLOCK, input, false);
          addresses = new Uint32Array(BLOCK_WORDS);
          compressBlocks(addresses, ZERO_BLOCK, tmp, false);
        };
        const start = pass === 0 && slice === 0 ? 2 : 0;
        if (independent && start === 2) {
          nextAddresses();
        }
        for (let offset = start; offset < segmentLength; offset += 1) {
          const index = slice * segmentLength + offset;
          const previous = index === 0 ? laneLength - 1 : index - 1;
          let j1;
          let j2;
          if (independent) {
            if (offset % 128 === 0) {
              nextAddresses();
            }
            j1 = addresses[2 * (offset % 128)];
            j2 = addresses[2 * (offset % 128) + 1];
          } else {
            const prev = at(lane, previous);
            j1 = prev[0];
            j2 = prev[1];
          }
          const refLane = pass === 0 && slice === 0 ? lane : j2 % p;
          const sameLane = refLane === lane;
          // Reference area (RFC 9106 §3.4.1.1).
          let area;
          if (pass === 0) {
            area =
              slice === 0
                ? offset - 1
                : sameLane
                ? slice * segmentLength + offset - 1
                : slice * segmentLength - (offset === 0 ? 1 : 0);
          } else {
            area = sameLane
              ? laneLength - segmentLength + offset - 1
              : laneLength - segmentLength - (offset === 0 ? 1 : 0);
          }
          // x = J1^2 / 2^32; y = area * x / 2^32; z = area - 1 - y.
          const x = mulHi32(j1, j1);
          const y = mulHi32(area >>> 0, x);
          const relative = area - 1 - y;
          const startPosition =
            pass === 0 || slice === SYNC_POINTS - 1
              ? 0
              : (slice + 1) * segmentLength;
          const refIndex = (startPosition + relative) % laneLength;
          const target = memory[lane * laneLength + index];
          const reference = at(refLane, refIndex);
          if (pass === 0 || !target) {
            const block = new Uint32Array(BLOCK_WORDS);
            compressBlocks(block, at(lane, previous), reference, false);
            memory[lane * laneLength + index] = block;
          } else {
            // Version 0x13: XOR the new block into the existing one.
            compressBlocks(target, at(lane, previous), reference, true);
          }
        }
      }
    }
  }

  const final = new Uint32Array(at(0, laneLength - 1));
  for (let lane = 1; lane < p; lane += 1) {
    const block = at(lane, laneLength - 1);
    for (let i = 0; i < BLOCK_WORDS; i += 1) {
      final[i] ^= block[i];
    }
  }
  const finalBytes = Buffer.alloc(1024);
  for (let i = 0; i < BLOCK_WORDS; i += 1) {
    finalBytes.writeUInt32LE(final[i] >>> 0, 4 * i);
  }
  return hashLong(tagLength, finalBytes);
}

/** Argon2id with AJB1 usage: no secret or associated data, 32-byte tag. */
export function argon2id(password, salt, { m, t, p }) {
  return argon2({ type: ARGON2ID, password, salt, m, t, p, tagLength: 32 });
}
