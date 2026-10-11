// Stable local identifiers (AJ-FR-005). IDs are opaque, lower-case, and
// path-safe, so a recording ID can name its file and a restored archive can be
// validated without escaping. They carry no time or device information.

export type IdPrefix =
  | 'ent'
  | 'rec'
  | 'seg'
  /** journal.organize@1 derivations, their tasks, and source references (AJ-2). */
  | 'drv'
  | 'tsk'
  | 'src';

export type RandomBytes = (length: number) => Uint8Array;

export interface IdSource {
  next(prefix: IdPrefix): string;
}

// Crockford base32, lower-case: no i, l, o, or u.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_PATTERN = /^(ent|rec|seg|drv|tsk|src)_[0-9a-hjkmnp-tv-z]{26}$/;

/** 128 random bits as 26 base32 characters, behind a typed prefix. */
/* eslint-disable no-bitwise -- base32 encoding is bit packing. */
export function newLocalId(prefix: IdPrefix, randomBytes: RandomBytes): string {
  const bytes = randomBytes(16);
  if (bytes.length !== 16) {
    throw new Error('random source returned the wrong length');
  }
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  out += ALPHABET[(buffer << (5 - bits)) & 31];
  return `${prefix}_${out}`;
}
/* eslint-enable no-bitwise */

export function isLocalId(value: unknown, prefix?: IdPrefix): value is string {
  return (
    typeof value === 'string' &&
    ID_PATTERN.test(value) &&
    (prefix === undefined || value.startsWith(`${prefix}_`))
  );
}

export function createIdSource(randomBytes: RandomBytes): IdSource {
  return { next: prefix => newLocalId(prefix, randomBytes) };
}

/** The only recording path shape the app writes or accepts back. */
export function recordingRelativePath(recordingId: string): string {
  if (!isLocalId(recordingId, 'rec')) {
    throw new Error('invalid recording ID');
  }
  return `recordings/${recordingId}.ajr`;
}

export function isRecordingRelativePath(path: unknown): path is string {
  if (typeof path !== 'string') {
    return false;
  }
  const match = /^recordings\/(rec_[0-9a-z]{26})\.ajr$/.exec(path);
  return match !== null && isLocalId(match[1], 'rec');
}
