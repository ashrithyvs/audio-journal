// AJR1 recording container, reference implementation for vectors (ADR-017 as
// amended 2026-10-10; LLD §5.1). Independent of the app's Kotlin codec: it
// uses node:crypto's HKDF and AES-GCM.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
} from 'node:crypto';

export const HEADER_BYTES = 64;
export const FRAME_HEADER_BYTES = 12;
export const TAG_BYTES = 16;
export const MAX_CHUNK_BYTES = 32_000;
export const MAX_INDEX = 2 ** 48 - 1;
export const KEY_LABEL = 'audio-journal/ajr1/recording-key/v1';
const MAGIC = Buffer.from('AJR1', 'ascii');
const ID_RE = /^rec_[0-9a-hjkmnp-tv-z]{26}$/;

export function encodeHeader(salt, noncePrefix) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(HEADER_BYTES, 6);
  header.writeUInt32BE(16_000, 8);
  header[12] = 1; // mono
  header[13] = 1; // s16le
  salt.copy(header, 16);
  noncePrefix.copy(header, 32);
  header.writeUInt32BE(MAX_CHUNK_BYTES, 36);
  return header;
}

export function encodedInfo(recordingId) {
  if (!ID_RE.test(recordingId)) {
    throw new Error('AJR1_RECORDING_ID');
  }
  const label = Buffer.from(KEY_LABEL, 'ascii');
  const id = Buffer.from(recordingId, 'ascii');
  const out = Buffer.alloc(2 + label.length + 2 + id.length);
  out.writeUInt16BE(label.length, 0);
  label.copy(out, 2);
  out.writeUInt16BE(id.length, 2 + label.length);
  id.copy(out, 4 + label.length);
  return out;
}

export function fileKey(recordingRootKey, salt, recordingId) {
  return Buffer.from(
    hkdfSync('sha256', recordingRootKey, salt, encodedInfo(recordingId), 32),
  );
}

const u64 = value => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
};

function aad(header, recordingId, index, length) {
  const id = Buffer.from(recordingId, 'ascii');
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(length);
  return Buffer.concat([
    createHash('sha256').update(header).digest(),
    Buffer.from([id.length]),
    id,
    u64(index),
    lengthBytes,
  ]);
}

export function sealFrame(key, header, recordingId, index, pcm) {
  if (!(Number.isSafeInteger(index) && index >= 0 && index <= MAX_INDEX)) {
    throw new Error('AJR1_INDEX_OVERFLOW');
  }
  if (pcm.length < 2 || pcm.length > MAX_CHUNK_BYTES || pcm.length % 2) {
    throw new Error('AJR1_CHUNK_LENGTH');
  }
  const nonce = Buffer.concat([header.subarray(32, 36), u64(index)]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(header, recordingId, index, pcm.length));
  const sealed = Buffer.concat([
    cipher.update(pcm),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const head = Buffer.alloc(FRAME_HEADER_BYTES);
  head.writeBigUInt64BE(BigInt(index), 0);
  head.writeUInt32BE(pcm.length, 8);
  return Buffer.concat([head, sealed]);
}

/** Same stop reasons and resume rule as the Kotlin codec. */
export function scan(file, recordingRootKey, recordingId) {
  const header = file.subarray(0, HEADER_BYTES);
  const key = fileKey(recordingRootKey, header.subarray(16, 32), recordingId);
  const indices = [];
  const digest = createHash('sha256');
  let at = HEADER_BYTES;
  let stop = null;
  let tornIndex = null;
  let last = null;
  while (at < file.length) {
    const remaining = file.length - at;
    tornIndex = remaining >= 8 ? Number(file.readBigUInt64BE(at)) : null;
    if (remaining < FRAME_HEADER_BYTES) {
      stop = 'TORN';
      break;
    }
    const index = Number(file.readBigUInt64BE(at));
    const length = file.readUInt32BE(at + 8);
    if (index > MAX_INDEX) {
      stop = 'INDEX_OVERFLOW';
      break;
    }
    if (last !== null && index <= last) {
      stop = 'INDEX_ORDER';
      break;
    }
    if (length < 2 || length > MAX_CHUNK_BYTES || length % 2) {
      stop = 'CHUNK_LENGTH';
      break;
    }
    const end = at + FRAME_HEADER_BYTES + length + TAG_BYTES;
    if (end > file.length) {
      stop = 'TORN';
      break;
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.concat([header.subarray(32, 36), u64(index)]),
      );
      decipher.setAAD(aad(header, recordingId, index, length));
      decipher.setAuthTag(file.subarray(end - TAG_BYTES, end));
      digest.update(
        Buffer.concat([
          decipher.update(
            file.subarray(at + FRAME_HEADER_BYTES, end - TAG_BYTES),
          ),
          decipher.final(),
        ]),
      );
    } catch {
      stop = 'AUTH_FAILED';
      break;
    }
    indices.push(index);
    last = index;
    at = end;
    tornIndex = null;
  }
  const trailingBytes = file.length - at;
  const base = last ?? -1;
  const resumeIndex =
    trailingBytes > 0
      ? Math.max(
          base + 2,
          (tornIndex !== null && tornIndex <= MAX_INDEX ? tornIndex : -1) + 1,
        )
      : base + 1;
  return {
    indices,
    stop,
    validEnd: at,
    trailingBytes,
    tornIndex,
    resumeIndex,
    pcmSha256: digest.digest('hex'),
  };
}
