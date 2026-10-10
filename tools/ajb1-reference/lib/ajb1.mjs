// AJB1 container version 1, domain schema version 1: reference writer and
// strict reader (docs/backup-and-restore.md §9). This is executable
// specification for vectors, not app code. It holds whole archives in memory,
// which the app must never do.

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

import { argon2id } from './argon2.mjs';
import {
  canonicalize,
  CanonicalJsonError,
  parseCanonical,
  parseNdjson,
  serializeNdjson,
} from './canonicalJson.mjs';

export const MAGIC = Buffer.from([
  0x41, 0x4a, 0x42, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 128;
export const SEGMENT_BYTES = 1_048_576;
export const TAG_BYTES = 16;
export const KDF_ARGON2ID = 1;
export const KDF_VERSION = 0x13;
export const AEAD_AES_256_GCM = 1;
export const SECRET_PASSWORD = 1;
export const SECRET_RECOVERY_KEY = 2;
export const DOMAIN_SCHEMA_VERSION = 1;
export const SECTION = { MANIFEST: 1, RECORDS: 2, RECORDING: 3, END: 4 };
const ID_BYTES = 30;

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/** §9.8 v0.1 limits (proposed). */
export const LIMITS = {
  maxArchiveBytes: 34 * GiB,
  maxManifestBytes: 64 * KiB,
  maxRecordsBytes: 1 * GiB,
  maxLineBytes: 2 * MiB,
  maxEntries: 100_000,
  maxRecordings: 100_000,
  maxTranscriptSegments: 4_000_000,
  maxRecordingDurationMs: 3_600_000,
  maxRecordingPcmBytes: 115_200_032,
  maxTotalPcmBytes: 32 * GiB,
  restoreReserveBytes: 512 * MiB,
};

/** Provisional Argon2id floor/ceiling until the device benchmark (Open). */
export const PROVISIONAL_KDF_POLICY = {
  floor: { m: 19_456, t: 2, p: 1 },
  ceiling: { m: 1_048_576, t: 10, p: 4 },
};

export class Ajb1Error extends Error {
  constructor(code, stage, detail) {
    super(`${code} (${stage})${detail ? `: ${detail}` : ''}`);
    this.name = 'Ajb1Error';
    this.code = code;
    this.stage = stage;
    this.detail = detail;
  }
}

const reject = (code, stage, detail) => {
  throw new Ajb1Error(code, stage, detail);
};

const sha256 = data => createHash('sha256').update(data).digest('hex');
const u64 = value => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
};

function gcmSeal(key, nonce, aad, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function gcmOpen(key, nonce, aad, sealed) {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

const segmentNonce = (prefix, index) => Buffer.concat([prefix, u64(index)]);
const segmentAad = (headerHash, index, final) =>
  Buffer.concat([headerHash, u64(index), Buffer.from([final ? 1 : 0])]);

// ---------------------------------------------------------------------------
// Domain schema v1 records (§9.6)

const RECORD_TYPES = ['entry', 'recording', 'transcriptSegment'];
const ID_RE = {
  entry: /^ent_[0-9a-hjkmnp-tv-z]{26}$/,
  recording: /^rec_[0-9a-hjkmnp-tv-z]{26}$/,
  transcriptSegment: /^seg_[0-9a-hjkmnp-tv-z]{26}$/,
};
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const FIELDS = {
  entry: {
    required: ['t', 'id', 'kind', 'status', 'createdAtMs', 'updatedAtMs'],
    optional: ['title', 'sourceText'],
  },
  recording: {
    required: [
      't',
      'id',
      'entryId',
      'state',
      'startedAtMs',
      'durationMs',
      'pcmBytes',
      'pcmSha256',
    ],
    optional: ['endedAtMs', 'finishReason'],
  },
  transcriptSegment: {
    required: [
      't',
      'id',
      'entryId',
      'recordingId',
      'engineRevision',
      'ordinal',
      'startMs',
      'endMs',
      'text',
      'state',
      'source',
      'createdAtMs',
    ],
    optional: ['modelId', 'supersedesSegmentId'],
  },
};

const isInt = value => Number.isSafeInteger(value) && value >= 0;
const isStr = value => typeof value === 'string';

/** Field-level checks of one record; returns a reason or undefined. */
export function checkRecord(record) {
  const type = record.t;
  const fields = FIELDS[type];
  if (!fields) {
    return 'UNKNOWN_TYPE';
  }
  for (const key of Object.keys(record)) {
    if (!fields.required.includes(key) && !fields.optional.includes(key)) {
      return `UNKNOWN_FIELD:${key}`;
    }
  }
  for (const key of fields.required) {
    if (!(key in record)) {
      return `MISSING_FIELD:${key}`;
    }
  }
  if (!ID_RE[type].test(record.id)) {
    return 'BAD_ID';
  }
  if (type === 'entry') {
    const { kind, status, createdAtMs, updatedAtMs, title, sourceText } =
      record;
    if (!['voice', 'written'].includes(kind)) return 'BAD_KIND';
    if (!['ready', 'recovery_required'].includes(status)) return 'BAD_STATUS';
    if (
      !isInt(createdAtMs) ||
      !isInt(updatedAtMs) ||
      updatedAtMs < createdAtMs
    ) {
      return 'BAD_TIME';
    }
    if (
      title !== undefined &&
      (!isStr(title) ||
        title.length === 0 ||
        title.length > 200 ||
        title !== title.replace(/\s+/g, ' ').trim())
    ) {
      return 'BAD_TITLE';
    }
    if ((kind === 'written') !== (sourceText !== undefined))
      return 'BAD_SOURCE';
    if (
      sourceText !== undefined &&
      (!isStr(sourceText) ||
        sourceText.trim().length === 0 ||
        sourceText.length > 200_000)
    ) {
      return 'BAD_SOURCE';
    }
  } else if (type === 'recording') {
    const {
      entryId,
      state,
      startedAtMs,
      endedAtMs,
      durationMs,
      pcmBytes,
      pcmSha256,
      finishReason,
    } = record;
    if (!ID_RE.entry.test(entryId)) return 'BAD_REFERENCE';
    if (!['ready', 'recoverable'].includes(state)) return 'BAD_STATE';
    if (
      !isInt(startedAtMs) ||
      (endedAtMs !== undefined &&
        (!isInt(endedAtMs) || endedAtMs < startedAtMs))
    ) {
      return 'BAD_TIME';
    }
    if (
      state === 'ready' &&
      (endedAtMs === undefined || finishReason === undefined)
    ) {
      return 'READY_INCOMPLETE';
    }
    if (
      finishReason !== undefined &&
      !['user', 'duration_limit', 'storage_low', 'recovered'].includes(
        finishReason,
      )
    ) {
      return 'BAD_FINISH_REASON';
    }
    if (!isInt(durationMs) || durationMs > LIMITS.maxRecordingDurationMs)
      return 'BAD_DURATION';
    if (
      !isInt(pcmBytes) ||
      pcmBytes === 0 ||
      pcmBytes % 2 !== 0 ||
      pcmBytes > LIMITS.maxRecordingPcmBytes ||
      Math.abs(pcmBytes - durationMs * 32) > 32
    ) {
      return 'BAD_PCM_BYTES';
    }
    if (!SHA_RE.test(pcmSha256)) return 'BAD_DIGEST';
  } else {
    const r = record;
    if (!ID_RE.entry.test(r.entryId) || !ID_RE.recording.test(r.recordingId))
      return 'BAD_REFERENCE';
    if (
      ![r.engineRevision, r.ordinal, r.startMs, r.endMs, r.createdAtMs].every(
        isInt,
      )
    )
      return 'BAD_NUMBER';
    if (r.endMs < r.startMs) return 'BAD_RANGE';
    if (!isStr(r.text) || r.text.length > 4000) return 'BAD_TEXT';
    if (!['provisional', 'final', 'corrected'].includes(r.state))
      return 'BAD_STATE';
    if (!['engine', 'user'].includes(r.source)) return 'BAD_SOURCE';
    if ((r.state === 'corrected') !== (r.source === 'user'))
      return 'BAD_SOURCE';
    if ((r.state === 'corrected') !== (r.supersedesSegmentId !== undefined))
      return 'BAD_SUPERSEDES';
    if ((r.state === 'provisional') !== (r.engineRevision === 0))
      return 'BAD_REVISION';
    if ((r.state === 'final') !== (r.modelId !== undefined)) return 'BAD_MODEL';
    if (r.modelId !== undefined && !MODEL_ID_RE.test(r.modelId))
      return 'BAD_MODEL';
    if (
      r.supersedesSegmentId !== undefined &&
      !ID_RE.transcriptSegment.test(r.supersedesSegmentId)
    ) {
      return 'BAD_SUPERSEDES';
    }
  }
  return undefined;
}

/** Canonical record order (§9.6): by type, then by ID byte order. */
export function sortRecords(records) {
  return [...records].sort(
    (a, b) =>
      RECORD_TYPES.indexOf(a.t) - RECORD_TYPES.indexOf(b.t) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Cross-record checks once every record is read, before any PCM. */
function checkRelations(records) {
  const byType = {
    entry: new Map(),
    recording: new Map(),
    transcriptSegment: new Map(),
  };
  for (const record of records) {
    byType[record.t].set(record.id, record);
  }
  const recordingOfEntry = new Map();
  for (const recording of byType.recording.values()) {
    const entry = byType.entry.get(recording.entryId);
    if (!entry || entry.kind !== 'voice' || recordingOfEntry.has(entry.id)) {
      reject('DANGLING_REFERENCE', 'records', 'recording.entryId');
    }
    recordingOfEntry.set(entry.id, recording.id);
  }
  for (const entry of byType.entry.values()) {
    if (entry.kind === 'voice' && !recordingOfEntry.has(entry.id)) {
      reject('DANGLING_REFERENCE', 'records', 'voice entry without recording');
    }
  }
  const finalPass = new Set();
  const superseded = new Set();
  for (const segment of byType.transcriptSegment.values()) {
    const recording = byType.recording.get(segment.recordingId);
    if (!recording || recording.entryId !== segment.entryId) {
      reject('DANGLING_REFERENCE', 'records', 'segment.recordingId');
    }
    if (segment.endMs > recording.durationMs) {
      reject('INVALID_RECORD', 'records', 'segment beyond recording');
    }
    if (segment.engineRevision > 0) {
      finalPass.add(segment.recordingId);
    }
    if (segment.supersedesSegmentId) {
      const target = byType.transcriptSegment.get(segment.supersedesSegmentId);
      if (
        !target ||
        target.recordingId !== segment.recordingId ||
        target.engineRevision !== segment.engineRevision ||
        target.state === 'provisional' ||
        superseded.has(target.id)
      ) {
        reject('DANGLING_REFERENCE', 'records', 'segment.supersedesSegmentId');
      }
      superseded.add(target.id);
    }
  }
  for (const segment of byType.transcriptSegment.values()) {
    // Live text is exported only for recordings without a full pass.
    if (segment.state === 'provisional' && finalPass.has(segment.recordingId)) {
      reject('INVALID_RECORD', 'records', 'live text beside a full pass');
    }
  }
  return byType;
}

// ---------------------------------------------------------------------------
// Writer

function section(kind, body) {
  const head = Buffer.alloc(12);
  head[0] = kind;
  head.writeBigUInt64BE(BigInt(body.length), 4);
  return Buffer.concat([head, body]);
}

/** Canonical records, manifest, and section stream for a journal. */
export function buildPlaintext({
  records,
  pcm,
  createdAtMs,
  domainSchemaVersion = DOMAIN_SCHEMA_VERSION,
}) {
  const sorted = sortRecords(records);
  for (const record of sorted) {
    const reason = checkRecord(record);
    if (reason) {
      throw new Error(`fixture record invalid: ${reason}`);
    }
  }
  const recordsText = Buffer.from(serializeNdjson(sorted), 'utf8');
  const recordings = sorted.filter(record => record.t === 'recording');
  const counts = Object.fromEntries(
    RECORD_TYPES.map(type => [
      type,
      sorted.filter(record => record.t === type).length,
    ]),
  );
  const manifest = {
    createdAtMs,
    domainSchemaVersion,
    format: 'AJB1',
    formatVersion: FORMAT_VERSION,
    pcm: {
      bytes: recordings.reduce((sum, recording) => sum + recording.pcmBytes, 0),
      recordings: recordings.length,
    },
    records: {
      bytes: recordsText.length,
      counts,
      lines: sorted.length,
      sha256: sha256(recordsText),
    },
  };
  const parts = [
    section(SECTION.MANIFEST, Buffer.from(canonicalize(manifest), 'utf8')),
    section(SECTION.RECORDS, recordsText),
  ];
  for (const recording of recordings) {
    parts.push(
      section(
        SECTION.RECORDING,
        Buffer.concat([
          Buffer.from(recording.id, 'ascii'),
          pcm.get(recording.id),
        ]),
      ),
    );
  }
  parts.push(section(SECTION.END, Buffer.alloc(0)));
  return { plaintext: Buffer.concat(parts), manifest, recordsText };
}

export function buildHeader(
  { kdf, salt, secretKind, domainSchemaVersion, noncePrefix, wrapNonce },
  kek,
  dek,
) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt16BE(FORMAT_VERSION, 8);
  header.writeUInt16BE(HEADER_BYTES, 10);
  header[12] = KDF_ARGON2ID;
  header[13] = KDF_VERSION;
  header[14] = kdf.p;
  header.writeUInt32BE(kdf.m, 16);
  header.writeUInt32BE(kdf.t, 20);
  salt.copy(header, 24);
  header[40] = AEAD_AES_256_GCM;
  header[41] = secretKind;
  header.writeUInt16BE(domainSchemaVersion, 42);
  header.writeUInt32BE(SEGMENT_BYTES, 44);
  noncePrefix.copy(header, 48);
  wrapNonce.copy(header, 52);
  gcmSeal(kek, wrapNonce, header.subarray(0, 64), dek).copy(header, 64);
  return header;
}

/** Segments `plaintext`: full segments, then a final one of 0..L-1 bytes. */
export function sealStream(header, dek, noncePrefix, plaintext) {
  const headerHash = createHash('sha256').update(header).digest();
  const full = Math.floor(plaintext.length / SEGMENT_BYTES);
  const out = [header];
  for (let index = 0; index <= full; index += 1) {
    const final = index === full;
    const chunk = plaintext.subarray(
      index * SEGMENT_BYTES,
      final ? plaintext.length : (index + 1) * SEGMENT_BYTES,
    );
    out.push(
      gcmSeal(
        dek,
        segmentNonce(noncePrefix, index),
        segmentAad(headerHash, index, final),
        chunk,
      ),
    );
  }
  return Buffer.concat(out);
}

/**
 * Writes an archive. `random` supplies every random input so vectors are
 * reproducible; production code draws them from the platform CSPRNG.
 */
export function writeArchive({
  plaintext,
  secretBytes,
  secretKind,
  kdf,
  random,
  domainSchemaVersion = DOMAIN_SCHEMA_VERSION,
  kek,
}) {
  const derived = kek ?? argon2id(secretBytes, random.salt, kdf);
  const header = buildHeader(
    {
      kdf,
      salt: random.salt,
      secretKind,
      domainSchemaVersion,
      noncePrefix: random.noncePrefix,
      wrapNonce: random.wrapNonce,
    },
    derived,
    random.dek,
  );
  return sealStream(header, random.dek, random.noncePrefix, plaintext);
}

// ---------------------------------------------------------------------------
// Reader

/** Every check that needs no secret, in §9.10 order. */
export function precheck(
  file,
  {
    secretKind,
    policy = PROVISIONAL_KDF_POLICY,
    purpose = 'inspect',
    availableBytes = Infinity,
    maxDomainSchema = DOMAIN_SCHEMA_VERSION,
    limits = LIMITS,
  },
) {
  const stage = 'header';
  if (
    file.length < MAGIC.length ||
    !file.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    reject('NOT_AJB1', stage);
  }
  if (file.length < HEADER_BYTES + TAG_BYTES) reject('TRUNCATED', stage);
  if (file.length > limits.maxArchiveBytes)
    reject('LIMIT_EXCEEDED', stage, 'archive size');
  if (file.readUInt16BE(8) !== FORMAT_VERSION)
    reject('UNSUPPORTED_VERSION', stage);
  if (
    file.readUInt16BE(10) !== HEADER_BYTES ||
    file[15] !== 0 ||
    !file.subarray(112, 128).equals(Buffer.alloc(16)) ||
    file[40] !== AEAD_AES_256_GCM ||
    ![SECRET_PASSWORD, SECRET_RECOVERY_KEY].includes(file[41]) ||
    file.readUInt32BE(44) !== SEGMENT_BYTES ||
    file.readUInt16BE(42) === 0
  ) {
    reject('MALFORMED_HEADER', stage);
  }
  const domainSchemaVersion = file.readUInt16BE(42);
  if (domainSchemaVersion > maxDomainSchema)
    reject('UNSUPPORTED_SCHEMA', stage);
  if (file[12] !== KDF_ARGON2ID || file[13] !== KDF_VERSION)
    reject('UNSUPPORTED_KDF', stage);
  const kdf = {
    p: file[14],
    m: file.readUInt32BE(16),
    t: file.readUInt32BE(20),
  };
  const { floor, ceiling } = policy;
  if (
    kdf.m < floor.m ||
    kdf.m > ceiling.m ||
    kdf.t < floor.t ||
    kdf.t > ceiling.t ||
    kdf.p < floor.p ||
    kdf.p > ceiling.p ||
    kdf.m < 8 * kdf.p
  ) {
    reject('KDF_PARAMS_REJECTED', stage);
  }
  // Canonical layout: full blocks of L + 16, then a final block of 16..L+15.
  const body = file.length - HEADER_BYTES;
  const remainder = body % (SEGMENT_BYTES + TAG_BYTES);
  if (remainder < TAG_BYTES) reject('TRUNCATED', stage);
  if (
    purpose === 'restore' &&
    availableBytes < file.length + limits.restoreReserveBytes
  ) {
    reject('INSUFFICIENT_STORAGE', stage);
  }
  if (secretKind !== undefined && secretKind !== file[41])
    reject('SECRET_KIND_MISMATCH', stage);
  return {
    kdf,
    domainSchemaVersion,
    secretKind: file[41],
    segments: Math.floor(body / (SEGMENT_BYTES + TAG_BYTES)) + 1,
  };
}

/** Decrypts the stream; any tag failure is AUTH_FAILED (§9.2). */
export function openStream(file, kek) {
  const header = file.subarray(0, HEADER_BYTES);
  let dek;
  try {
    dek = gcmOpen(
      kek,
      header.subarray(52, 64),
      header.subarray(0, 64),
      header.subarray(64, 112),
    );
  } catch {
    reject('AUTH_FAILED', 'unwrap');
  }
  const headerHash = createHash('sha256').update(header).digest();
  const prefix = header.subarray(48, 52);
  const body = file.subarray(HEADER_BYTES);
  const block = SEGMENT_BYTES + TAG_BYTES;
  const count = Math.floor(body.length / block) + 1;
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const sealed = body.subarray(
      index * block,
      Math.min(body.length, (index + 1) * block),
    );
    try {
      parts.push(
        gcmOpen(
          dek,
          segmentNonce(prefix, index),
          segmentAad(headerHash, index, index === count - 1),
          sealed,
        ),
      );
    } catch {
      reject('AUTH_FAILED', 'segment', String(index));
    }
  }
  return Buffer.concat(parts);
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeJson(bytes, stage) {
  try {
    return utf8.decode(bytes);
  } catch {
    return reject('NON_CANONICAL_JSON', stage, 'invalid UTF-8');
  }
}

const MANIFEST_KEYS = [
  'createdAtMs',
  'domainSchemaVersion',
  'format',
  'formatVersion',
  'pcm',
  'records',
];

function checkManifest(manifest, domainSchemaVersion, limits) {
  const stage = 'manifest';
  const keysEqual = (object, keys) =>
    object &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    canonicalize(Object.keys(object).sort()) === canonicalize([...keys].sort());
  if (
    !keysEqual(manifest, MANIFEST_KEYS) ||
    !keysEqual(manifest.pcm, ['bytes', 'recordings']) ||
    !keysEqual(manifest.records, ['bytes', 'counts', 'lines', 'sha256']) ||
    !keysEqual(manifest.records.counts, RECORD_TYPES) ||
    manifest.format !== 'AJB1' ||
    manifest.formatVersion !== FORMAT_VERSION ||
    manifest.domainSchemaVersion !== domainSchemaVersion ||
    !isInt(manifest.createdAtMs) ||
    !SHA_RE.test(manifest.records.sha256) ||
    ![
      manifest.pcm.bytes,
      manifest.pcm.recordings,
      manifest.records.bytes,
      manifest.records.lines,
      ...Object.values(manifest.records.counts),
    ].every(isInt)
  ) {
    reject('MALFORMED_MANIFEST', stage);
  }
  const { counts } = manifest.records;
  if (
    counts.entry > limits.maxEntries ||
    counts.recording > limits.maxRecordings ||
    counts.transcriptSegment > limits.maxTranscriptSegments ||
    manifest.records.bytes > limits.maxRecordsBytes ||
    manifest.pcm.bytes > limits.maxTotalPcmBytes
  ) {
    reject('LIMIT_EXCEEDED', stage);
  }
  if (
    manifest.pcm.recordings !== counts.recording ||
    manifest.records.lines !==
      counts.entry + counts.recording + counts.transcriptSegment
  ) {
    reject('COUNT_MISMATCH', stage);
  }
}

/** Parses and validates the decrypted section stream (§9.3-9.6). */
export function parsePlaintext(
  plaintext,
  { domainSchemaVersion, limits = LIMITS },
) {
  let at = 0;
  const next = () => {
    if (plaintext.length - at < 12)
      reject('MALFORMED_SECTION', 'sections', 'short section header');
    const kind = plaintext[at];
    if (plaintext[at + 1] || plaintext[at + 2] || plaintext[at + 3]) {
      reject('MALFORMED_SECTION', 'sections', 'reserved bytes');
    }
    const length = plaintext.readBigUInt64BE(at + 4);
    return { kind, length, start: at + 12 };
  };
  const body = (head, max, stage) => {
    if (head.length > BigInt(max))
      reject('LIMIT_EXCEEDED', stage, 'section length');
    const end = head.start + Number(head.length);
    if (end > plaintext.length)
      reject('MALFORMED_SECTION', stage, 'section overruns stream');
    at = end;
    return plaintext.subarray(head.start, end);
  };

  let head = next();
  if (head.kind !== SECTION.MANIFEST)
    reject('MALFORMED_SECTION', 'sections', 'manifest first');
  let manifest;
  try {
    manifest = parseCanonical(
      decodeJson(body(head, limits.maxManifestBytes, 'manifest'), 'manifest'),
    );
  } catch (error) {
    if (error instanceof CanonicalJsonError)
      reject('NON_CANONICAL_JSON', 'manifest', error.reason);
    throw error;
  }
  checkManifest(manifest, domainSchemaVersion, limits);

  head = next();
  if (head.kind !== SECTION.RECORDS)
    reject('MALFORMED_SECTION', 'sections', 'records second');
  if (head.length !== BigInt(manifest.records.bytes))
    reject('COUNT_MISMATCH', 'records', 'records length');
  const recordsBytes = body(head, limits.maxRecordsBytes, 'records');
  if (sha256(recordsBytes) !== manifest.records.sha256)
    reject('DIGEST_MISMATCH', 'records');
  const records = [];
  const ids = new Set();
  try {
    for (const { value } of parseNdjson(decodeJson(recordsBytes, 'records'), {
      maxLineBytes: limits.maxLineBytes,
    })) {
      const reason = checkRecord(value);
      if (reason) reject('INVALID_RECORD', 'records', reason);
      if (ids.has(value.id))
        reject('DUPLICATE_ID', 'records', value.id.slice(0, 4));
      const previous = records[records.length - 1];
      if (previous && sortRecords([previous, value])[0] !== previous) {
        reject('INVALID_RECORD', 'records', 'NON_CANONICAL_ORDER');
      }
      ids.add(value.id);
      records.push(value);
    }
  } catch (error) {
    if (error instanceof CanonicalJsonError)
      reject('NON_CANONICAL_JSON', 'records', error.reason);
    throw error;
  }
  const counts = Object.fromEntries(
    RECORD_TYPES.map(type => [type, records.filter(r => r.t === type).length]),
  );
  if (canonicalize(counts) !== canonicalize(manifest.records.counts))
    reject('COUNT_MISMATCH', 'records');
  const byType = checkRelations(records);
  const recordings = [...byType.recording.values()];
  if (
    recordings.reduce((sum, r) => sum + r.pcmBytes, 0) !== manifest.pcm.bytes
  ) {
    reject('COUNT_MISMATCH', 'records', 'pcm bytes');
  }

  const pcm = new Map();
  for (const recording of recordings) {
    head = next();
    if (head.kind !== SECTION.RECORDING)
      reject('MALFORMED_SECTION', 'recordings', 'expected recording');
    if (head.length !== BigInt(ID_BYTES + recording.pcmBytes)) {
      reject('MALFORMED_SECTION', 'recordings', 'recording length');
    }
    const bytes = body(
      head,
      ID_BYTES + limits.maxRecordingPcmBytes,
      'recordings',
    );
    if (bytes.subarray(0, ID_BYTES).toString('latin1') !== recording.id) {
      reject('MALFORMED_SECTION', 'recordings', 'recording order');
    }
    const samples = bytes.subarray(ID_BYTES);
    if (sha256(samples) !== recording.pcmSha256)
      reject('DIGEST_MISMATCH', 'recordings');
    pcm.set(recording.id, samples);
  }
  head = next();
  if (head.kind !== SECTION.END || head.length !== 0n)
    reject('MALFORMED_SECTION', 'sections', 'expected end');
  if (head.start !== plaintext.length)
    reject('MALFORMED_SECTION', 'sections', 'data after end');
  return { manifest, records, recordsText: recordsBytes, pcm };
}

/** Full read: precheck, KDF, decrypt, parse. `kekCache` avoids repeated KDF in tests. */
export function readArchive(
  file,
  { secretBytes, secretKind, kekCache, ...context },
) {
  const pre = precheck(file, { secretKind, ...context });
  const salt = file.subarray(24, 40);
  const cacheKey =
    kekCache &&
    `${secretBytes.toString('hex')}:${salt.toString('hex')}:${pre.kdf.m}:${
      pre.kdf.t
    }:${pre.kdf.p}`;
  let kek = cacheKey && kekCache.get(cacheKey);
  if (!kek) {
    kek = argon2id(secretBytes, salt, pre.kdf);
    if (cacheKey) kekCache.set(cacheKey, kek);
  }
  const plaintext = openStream(file, kek);
  return parsePlaintext(plaintext, {
    domainSchemaVersion: pre.domainSchemaVersion,
    limits: context.limits,
  });
}
