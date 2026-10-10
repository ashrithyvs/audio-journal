// Hostile-vector recipes (§9.12): byte-level mutations of a valid archive.
// Recipes keep vectors.json small and are trivial to apply on any platform.

import { HEADER_BYTES, SEGMENT_BYTES, TAG_BYTES } from './ajb1.mjs';

export const BLOCK_BYTES = SEGMENT_BYTES + TAG_BYTES;

export function applyMutation(base, mutation, lookup) {
  const file = Buffer.from(base);
  const blocks = () => {
    const out = [];
    for (let at = HEADER_BYTES; at < file.length; at += BLOCK_BYTES) {
      out.push(file.subarray(at, Math.min(file.length, at + BLOCK_BYTES)));
    }
    return out;
  };
  const rejoin = parts =>
    Buffer.concat([file.subarray(0, HEADER_BYTES), ...parts]);
  switch (mutation.op) {
    case 'truncate':
      return file.subarray(0, mutation.length);
    case 'append':
      return Buffer.concat([file, Buffer.from(mutation.hex, 'hex')]);
    case 'xor':
      Buffer.from(mutation.hex, 'hex').forEach((byte, index) => {
        file[mutation.offset + index] ^= byte; // eslint-disable-line no-bitwise -- a bit flip
      });
      return file;
    case 'set':
      Buffer.from(mutation.hex, 'hex').copy(file, mutation.offset);
      return file;
    case 'swapBlocks': {
      const parts = blocks();
      [parts[mutation.a], parts[mutation.b]] = [
        parts[mutation.b],
        parts[mutation.a],
      ];
      return rejoin(parts);
    }
    case 'duplicateBlock': {
      const parts = blocks();
      parts[mutation.to] = parts[mutation.from];
      return rejoin(parts);
    }
    case 'dropBlock': {
      const parts = blocks();
      parts.splice(mutation.index, 1);
      return rejoin(parts);
    }
    case 'spliceBlock': {
      const parts = blocks();
      const other = lookup(mutation.fromVector);
      const start = HEADER_BYTES + mutation.fromIndex * BLOCK_BYTES;
      parts[mutation.to] = other.subarray(start, start + BLOCK_BYTES);
      return rejoin(parts);
    }
    default:
      throw new Error(`unknown mutation ${mutation.op}`);
  }
}
