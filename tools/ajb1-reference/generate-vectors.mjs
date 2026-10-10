// Generates (or, with --check, verifies) the AJB1 v1 vectors in
// schemas/ajb1/v1/. Every vector is checked against the reference reader
// before anything is written, so expectations are executable.
//
//   node generate-vectors.mjs          write vectors
//   node generate-vectors.mjs --check  regenerate in memory; compare bytes

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Ajb1Error,
  buildPlaintext,
  HEADER_BYTES,
  LIMITS,
  PROVISIONAL_KDF_POLICY,
  readArchive,
  SECRET_PASSWORD,
  SECRET_RECOVERY_KEY,
  SECTION,
  SEGMENT_BYTES,
  sealStream,
  buildHeader,
  writeArchive,
} from './lib/ajb1.mjs';
import { argon2id } from './lib/argon2.mjs';
import { applyMutation, BLOCK_BYTES } from './lib/mutations.mjs';
import { canonicalize } from './lib/canonicalJson.mjs';
import {
  CREATED_AT_MS,
  localId,
  pcmFor,
  randomInputs,
  stream,
  voiceFixture,
  writtenFixture,
} from './lib/fixtures.mjs';
import {
  decodeRecoveryKey,
  encodeRecoveryKey,
  passwordBytes,
  WORDLIST_ID,
  WORDLIST_SHA256,
} from './lib/recoveryKey.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../schemas/ajb1/v1');
const CHECK = process.argv.includes('--check');
const KDF = PROVISIONAL_KDF_POLICY.floor;
const hex = buffer => Buffer.from(buffer).toString('hex');
const sha256 = data => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------
// Secrets

const PASSWORD_A = 'correct horse battery staple ✓';
const PASSWORD_NFD = 'Pa\u0308sswo\u0308rd fu\u0308r Tagebu\u0308cher';
const RECOVERY_ENTROPY = stream('recovery-key', 32);
const SECRETS = {
  'password-a': { kind: 'password', input: PASSWORD_A },
  'password-nfd': { kind: 'password', input: PASSWORD_NFD },
  'recovery-c': {
    kind: 'recoveryKey',
    input: encodeRecoveryKey(RECOVERY_ENTROPY),
  },
  'password-wrong': {
    kind: 'password',
    input: 'correct horse battery stapler',
  },
  'recovery-wrong': {
    kind: 'recoveryKey',
    input: encodeRecoveryKey(stream('recovery-key-other', 32)),
  },
};

function secretBytes(name) {
  const secret = SECRETS[name];
  if (secret.kind === 'password') {
    const checked = passwordBytes(secret.input);
    if (!checked.ok)
      throw new Error(`fixture password ${name}: ${checked.reason}`);
    return { bytes: checked.bytes, kind: SECRET_PASSWORD };
  }
  const decoded = decodeRecoveryKey(secret.input);
  if (!decoded.ok) throw new Error(`fixture recovery key ${name}`);
  return { bytes: decoded.entropy, kind: SECRET_RECOVERY_KEY };
}

const kekCache = new Map();
function kekFor(secretName, salt) {
  const key = `${secretName}:${hex(salt)}`;
  if (!kekCache.has(key)) {
    kekCache.set(key, argon2id(secretBytes(secretName).bytes, salt, KDF));
  }
  return kekCache.get(key);
}

// ---------------------------------------------------------------------------
// Valid vectors

/** A voice fixture whose plaintext is exactly one segment long. */
function boundaryFixture() {
  const target = SEGMENT_BYTES;
  const base = writtenFixture();
  const entryId = localId('ent', 'boundary-voice');
  const recordingId = localId('rec', 'boundary-recording');
  // PCM sizes are even, so the title length also varies to fix parity.
  const recordsFor = (durationMs, pcmBytes, pcmSha256, title) => [
    ...base.records,
    {
      t: 'entry',
      id: entryId,
      kind: 'voice',
      status: 'ready',
      createdAtMs: CREATED_AT_MS - 10_000,
      updatedAtMs: CREATED_AT_MS - 5_000,
      title,
    },
    {
      t: 'recording',
      id: recordingId,
      entryId,
      state: 'ready',
      startedAtMs: CREATED_AT_MS - 10_000,
      endedAtMs: CREATED_AT_MS - 5_000,
      durationMs,
      pcmBytes,
      pcmSha256,
      finishReason: 'user',
    },
  ];
  // Size candidates without generating audio: the plaintext length is the
  // length with an empty PCM body plus pcmBytes (the digest has fixed width).
  const empty = new Map([[recordingId, Buffer.alloc(0)]]);
  for (const title of ['Boundary', 'Boundary!']) {
    for (let durationMs = 32_000; durationMs < 33_500; durationMs += 1) {
      for (let delta = -32; delta <= 32; delta += 2) {
        const pcmBytes = durationMs * 32 + delta;
        const { plaintext } = buildPlaintext({
          records: recordsFor(durationMs, pcmBytes, 'a'.repeat(64), title),
          pcm: empty,
          createdAtMs: CREATED_AT_MS,
        });
        if (plaintext.length + pcmBytes === target) {
          const audio = pcmFor('boundary-recording', pcmBytes);
          return {
            records: recordsFor(durationMs, pcmBytes, sha256(audio), title),
            pcm: new Map([[recordingId, audio]]),
            pcmLabels: new Map([[recordingId, 'boundary-recording']]),
          };
        }
      }
    }
  }
  throw new Error('no boundary fixture found');
}

const VALID = [
  {
    name: 'empty-journal',
    secret: 'password-a',
    fixture: () => ({ records: [], pcm: new Map(), pcmLabels: new Map() }),
  },
  { name: 'written-unicode', secret: 'password-nfd', fixture: writtenFixture },
  { name: 'voice-multisegment', secret: 'recovery-c', fixture: voiceFixture },
  {
    name: 'exact-segment-boundary',
    secret: 'password-a',
    fixture: boundaryFixture,
  },
];

function buildValid(spec) {
  const fixture = spec.fixture();
  const random = randomInputs(spec.name);
  const { plaintext, manifest, recordsText } = buildPlaintext({
    ...fixture,
    createdAtMs: CREATED_AT_MS,
  });
  const secret = secretBytes(spec.secret);
  const kek = kekFor(spec.secret, random.salt);
  const file = writeArchive({
    plaintext,
    secretBytes: secret.bytes,
    secretKind: secret.kind,
    kdf: KDF,
    random,
    kek,
  });
  return {
    ...spec,
    fixture,
    random,
    plaintext,
    manifest,
    recordsText,
    file,
    kek,
    secretKind: secret.kind,
  };
}

// ---------------------------------------------------------------------------
// Hostile vectors

const BLOCK = BLOCK_BYTES;

const u16 = value => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return hex(out);
};
const u32 = value => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return hex(out);
};

// Mutations of a small base (written-unicode) and the 3-segment base.
const W = 'written-unicode';
const V = 'voice-multisegment';
const MUTATIONS = [
  ['empty-file', W, { op: 'truncate', length: 0 }, 'NOT_AJB1', 'header'],
  ['bad-magic', W, { op: 'xor', offset: 0, hex: '01' }, 'NOT_AJB1', 'header'],
  ['short-header', W, { op: 'truncate', length: 100 }, 'TRUNCATED', 'header'],
  [
    'format-version-2',
    W,
    { op: 'set', offset: 8, hex: u16(2) },
    'UNSUPPORTED_VERSION',
    'header',
  ],
  [
    'header-length-129',
    W,
    { op: 'set', offset: 10, hex: u16(129) },
    'MALFORMED_HEADER',
    'header',
  ],
  [
    'reserved-15-nonzero',
    W,
    { op: 'set', offset: 15, hex: '01' },
    'MALFORMED_HEADER',
    'header',
  ],
  [
    'reserved-tail-nonzero',
    W,
    { op: 'set', offset: 127, hex: '01' },
    'MALFORMED_HEADER',
    'header',
  ],
  [
    'aead-id-2',
    W,
    { op: 'set', offset: 40, hex: '02' },
    'MALFORMED_HEADER',
    'header',
  ],
  [
    'secret-kind-3',
    W,
    { op: 'set', offset: 41, hex: '03' },
    'MALFORMED_HEADER',
    'header',
  ],
  [
    'segment-length-64k',
    W,
    { op: 'set', offset: 44, hex: u32(65_536) },
    'MALFORMED_HEADER',
    'header',
  ],
  [
    'domain-schema-0',
    W,
    { op: 'set', offset: 42, hex: u16(0) },
    'MALFORMED_HEADER',
    'header',
  ],
  [
    'domain-schema-2-unsupported',
    W,
    { op: 'set', offset: 42, hex: u16(2) },
    'UNSUPPORTED_SCHEMA',
    'header',
  ],
  [
    'kdf-algorithm-2',
    W,
    { op: 'set', offset: 12, hex: '02' },
    'UNSUPPORTED_KDF',
    'header',
  ],
  [
    'kdf-version-0x10',
    W,
    { op: 'set', offset: 13, hex: '10' },
    'UNSUPPORTED_KDF',
    'header',
  ],
  [
    'kdf-memory-above-ceiling',
    W,
    { op: 'set', offset: 16, hex: u32(0xffffffff) },
    'KDF_PARAMS_REJECTED',
    'header',
  ],
  [
    'kdf-memory-below-floor',
    W,
    { op: 'set', offset: 16, hex: u32(8) },
    'KDF_PARAMS_REJECTED',
    'header',
  ],
  [
    'kdf-time-above-ceiling',
    W,
    { op: 'set', offset: 20, hex: u32(1_000) },
    'KDF_PARAMS_REJECTED',
    'header',
  ],
  [
    'kdf-time-zero',
    W,
    { op: 'set', offset: 20, hex: u32(0) },
    'KDF_PARAMS_REJECTED',
    'header',
  ],
  [
    'kdf-parallelism-zero',
    W,
    { op: 'set', offset: 14, hex: '00' },
    'KDF_PARAMS_REJECTED',
    'header',
  ],
  [
    'kdf-parallelism-above-ceiling',
    W,
    { op: 'set', offset: 14, hex: '40' },
    'KDF_PARAMS_REJECTED',
    'header',
  ],
  [
    'final-block-shorter-than-tag',
    V,
    { op: 'truncate', length: HEADER_BYTES + 2 * BLOCK + 10 },
    'TRUNCATED',
    'header',
  ],
  [
    'final-segment-dropped',
    V,
    { op: 'dropBlock', index: 2 },
    'TRUNCATED',
    'header',
  ],
  [
    'salt-flipped',
    W,
    { op: 'xor', offset: 24, hex: '80' },
    'AUTH_FAILED',
    'unwrap',
  ],
  [
    'wrap-nonce-flipped',
    W,
    { op: 'xor', offset: 52, hex: '01' },
    'AUTH_FAILED',
    'unwrap',
  ],
  [
    'wrapped-dek-flipped',
    W,
    { op: 'xor', offset: 64, hex: '01' },
    'AUTH_FAILED',
    'unwrap',
  ],
  [
    'wrap-tag-flipped',
    W,
    { op: 'xor', offset: 111, hex: '01' },
    'AUTH_FAILED',
    'unwrap',
  ],
  [
    'stream-nonce-prefix-flipped',
    W,
    { op: 'xor', offset: 48, hex: '01' },
    'AUTH_FAILED',
    'unwrap',
  ],
  [
    'ciphertext-bit-flipped',
    V,
    { op: 'xor', offset: HEADER_BYTES + BLOCK + 1_000, hex: '01' },
    'AUTH_FAILED',
    'segment',
  ],
  [
    'segments-swapped',
    V,
    { op: 'swapBlocks', a: 0, b: 1 },
    'AUTH_FAILED',
    'segment',
  ],
  [
    'segment-duplicated',
    V,
    { op: 'duplicateBlock', from: 0, to: 1 },
    'AUTH_FAILED',
    'segment',
  ],
  [
    'middle-segment-dropped',
    V,
    { op: 'dropBlock', index: 1 },
    'AUTH_FAILED',
    'segment',
  ],
  [
    'truncated-mid-segment',
    V,
    { op: 'truncate', length: 'BASE-100' },
    'AUTH_FAILED',
    'segment',
  ],
  [
    'trailing-bytes',
    V,
    { op: 'append', hex: '00'.repeat(20) },
    'AUTH_FAILED',
    'segment',
  ],
  [
    'segment-spliced-from-other-archive',
    V,
    {
      op: 'spliceBlock',
      fromVector: 'voice-multisegment-same-secret',
      fromIndex: 1,
      to: 1,
    },
    'AUTH_FAILED',
    'segment',
  ],
];

/** Plaintext built from raw parts, for content-level attacks. */
function rawPlaintext(parts) {
  return Buffer.concat(
    parts.map(({ kind, body, reserved = [0, 0, 0], length }) => {
      const head = Buffer.alloc(12);
      head[0] = kind;
      head[1] = reserved[0];
      head[2] = reserved[1];
      head[3] = reserved[2];
      head.writeBigUInt64BE(BigInt(length ?? body.length), 4);
      return Buffer.concat([head, body]);
    }),
  );
}

/**
 * Content vectors: well-sealed archives whose plaintext is wrong. They reuse
 * the base vector's random inputs so one KDF result serves all of them; a
 * real writer never reuses a DEK or nonces.
 */
function contentVectors(base) {
  const manifestOf = (manifest, records) => ({
    ...manifest,
    records: {
      ...manifest.records,
      bytes: records.length,
      sha256: sha256(records),
    },
  });
  const sectionsFor = ({
    manifest = base.manifest,
    manifestText,
    records = base.recordsText,
    extra = [],
    end = true,
    recordings = [],
  }) => {
    const parts = [
      {
        kind: SECTION.MANIFEST,
        body: Buffer.from(manifestText ?? canonicalize(manifest), 'utf8'),
      },
      { kind: SECTION.RECORDS, body: Buffer.from(records) },
      ...recordings,
      ...extra,
    ];
    if (end) parts.push({ kind: SECTION.END, body: Buffer.alloc(0) });
    return rawPlaintext(parts);
  };
  const records = base.recordsText.toString('utf8');
  const lines = records.trimEnd().split('\n');
  const withRecords = text => {
    const bytes = Buffer.from(text, 'utf8');
    return sectionsFor({
      manifest: manifestOf(base.manifest, bytes),
      records: bytes,
    });
  };
  const replaceFirst = (from, to) => withRecords(records.replace(from, to));
  const firstEntry = JSON.parse(lines[0]);
  return [
    [
      'manifest-unknown-field',
      sectionsFor({ manifest: { ...base.manifest, comment: 'x' } }),
      'MALFORMED_MANIFEST',
      'manifest',
    ],
    [
      'manifest-duplicate-key',
      sectionsFor({
        manifestText: canonicalize(base.manifest).replace(
          '{',
          '{"format":"AJB1",',
        ),
      }),
      'NON_CANONICAL_JSON',
      'manifest',
    ],
    [
      'manifest-whitespace',
      sectionsFor({
        manifestText: canonicalize(base.manifest).replace(':', ': '),
      }),
      'NON_CANONICAL_JSON',
      'manifest',
    ],
    [
      'manifest-key-order',
      sectionsFor({
        manifestText: JSON.stringify({ format: 'AJB1', ...base.manifest }),
      }),
      'NON_CANONICAL_JSON',
      'manifest',
    ],
    [
      'manifest-schema-mismatch',
      sectionsFor({ manifest: { ...base.manifest, domainSchemaVersion: 2 } }),
      'MALFORMED_MANIFEST',
      'manifest',
    ],
    [
      'manifest-too-large',
      rawPlaintext([
        {
          kind: SECTION.MANIFEST,
          body: Buffer.alloc(0),
          length: LIMITS.maxManifestBytes + 1,
        },
      ]),
      'LIMIT_EXCEEDED',
      'manifest',
    ],
    [
      'manifest-entry-count-over-limit',
      sectionsFor({
        manifest: {
          ...base.manifest,
          records: {
            ...base.manifest.records,
            counts: {
              ...base.manifest.records.counts,
              entry: LIMITS.maxEntries + 1,
            },
          },
        },
      }),
      'LIMIT_EXCEEDED',
      'manifest',
    ],
    [
      'manifest-first-violated',
      rawPlaintext([{ kind: SECTION.RECORDS, body: base.recordsText }]),
      'MALFORMED_SECTION',
      'sections',
    ],
    [
      'records-length-mismatch',
      sectionsFor({
        manifest: {
          ...base.manifest,
          records: {
            ...base.manifest.records,
            bytes: base.recordsText.length + 1,
          },
        },
      }),
      'COUNT_MISMATCH',
      'records',
    ],
    [
      'records-digest-mismatch',
      sectionsFor({
        manifest: {
          ...base.manifest,
          records: { ...base.manifest.records, sha256: '0'.repeat(64) },
        },
      }),
      'DIGEST_MISMATCH',
      'records',
    ],
    [
      'record-duplicate-key',
      replaceFirst('{"createdAtMs"', '{"t":"entry","createdAtMs"'),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-crlf',
      withRecords(records.replace('\n', '\r\n')),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-bom',
      withRecords(`\ufeff${records}`),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-empty-line',
      withRecords(records.replace('\n', '\n\n')),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-null-value',
      replaceFirst('"title":"Morning pages"', '"title":null'),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-fraction',
      replaceFirst(
        `"createdAtMs":${firstEntry.createdAtMs}`,
        `"createdAtMs":${firstEntry.createdAtMs}.5`,
      ),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-lone-surrogate',
      replaceFirst('Morning pages', 'Morning \\ud800pages'),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-escaped-slash',
      replaceFirst('Morning pages', 'Morning\\/pages'),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-missing-final-lf',
      withRecords(records.slice(0, -1)),
      'NON_CANONICAL_JSON',
      'records',
    ],
    [
      'record-unknown-type',
      replaceFirst('"t":"entry"', '"t":"note"'),
      'INVALID_RECORD',
      'records',
    ],
    [
      'record-unknown-field',
      replaceFirst('"status":"ready"', '"status":"ready","statusNote":"x"'),
      'INVALID_RECORD',
      'records',
    ],
    [
      'record-bad-enum',
      replaceFirst('"status":"ready"', '"status":"draft"'),
      'INVALID_RECORD',
      'records',
    ],
    [
      'records-out-of-order',
      withRecords(`${lines[1]}\n${lines[0]}\n`),
      'INVALID_RECORD',
      'records',
    ],
    [
      'record-duplicate-id',
      withRecords(`${lines[0]}\n${lines[0]}\n`),
      'DUPLICATE_ID',
      'records',
    ],
    [
      'record-count-mismatch',
      sectionsFor({
        manifest: {
          ...base.manifest,
          records: {
            ...base.manifest.records,
            counts: { ...base.manifest.records.counts, entry: 1 },
            lines: 1,
          },
        },
      }),
      'COUNT_MISMATCH',
      'records',
    ],
    [
      'end-missing',
      sectionsFor({ end: false }),
      'MALFORMED_SECTION',
      'sections',
    ],
    [
      'data-after-end',
      Buffer.concat([sectionsFor({}), Buffer.from([0])]),
      'MALFORMED_SECTION',
      'sections',
    ],
    [
      'unknown-section-kind',
      sectionsFor({ extra: [{ kind: 9, body: Buffer.alloc(0) }] }),
      'MALFORMED_SECTION',
      'sections',
    ],
    [
      'section-reserved-nonzero',
      rawPlaintext([
        {
          kind: SECTION.MANIFEST,
          body: Buffer.from(canonicalize(base.manifest)),
          reserved: [0, 1, 0],
        },
      ]),
      'MALFORMED_SECTION',
      'sections',
    ],
  ];
}

/** Voice-specific content vectors (recording sections and references). */
function voiceContentVectors(base) {
  const records = base.recordsText.toString('utf8');
  const recordingIds = base.fixture.records
    .filter(r => r.t === 'recording')
    .map(r => r.id)
    .sort();
  const recordingSection = (id, pcm) => ({
    kind: SECTION.RECORDING,
    body: Buffer.concat([Buffer.from(id, 'ascii'), pcm]),
  });
  const sections = (recordings, recordsText = base.recordsText) => {
    const bytes = Buffer.from(recordsText);
    const manifest = {
      ...base.manifest,
      records: {
        ...base.manifest.records,
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    };
    return rawPlaintext([
      { kind: SECTION.MANIFEST, body: Buffer.from(canonicalize(manifest)) },
      { kind: SECTION.RECORDS, body: bytes },
      ...recordings,
      { kind: SECTION.END, body: Buffer.alloc(0) },
    ]);
  };
  const pcm = id => base.fixture.pcm.get(id);
  const flipped = Buffer.from(pcm(recordingIds[1]));
  flipped[0] ^= 1;
  const [r0, r1] = recordingIds;
  const lines = records.trimEnd().split('\n');
  const recordingLine = lines.find(
    line => line.includes('"t":"recording"') && line.includes(r0),
  );
  const otherEntry = localId('ent', 'nonexistent');
  return [
    [
      'pcm-digest-mismatch',
      sections([recordingSection(r0, pcm(r0)), recordingSection(r1, flipped)]),
      'DIGEST_MISMATCH',
      'recordings',
    ],
    [
      'recording-sections-out-of-order',
      sections([recordingSection(r1, pcm(r1)), recordingSection(r0, pcm(r0))]),
      'MALFORMED_SECTION',
      'recordings',
    ],
    [
      'recording-length-mismatch',
      sections([
        recordingSection(r0, pcm(r0).subarray(2)),
        recordingSection(r1, pcm(r1)),
      ]),
      'MALFORMED_SECTION',
      'recordings',
    ],
    [
      'recording-dangling-entry',
      sections(
        [recordingSection(r0, pcm(r0)), recordingSection(r1, pcm(r1))],
        records.replace(
          recordingLine,
          recordingLine.replace(
            /"entryId":"ent_[0-9a-z]+"/,
            `"entryId":"${otherEntry}"`,
          ),
        ),
      ),
      'DANGLING_REFERENCE',
      'records',
    ],
  ];
}

// ---------------------------------------------------------------------------
// Assemble and verify

function expectOutcome(file, { secret, context = {} }, expected) {
  const { bytes, kind } = secretBytes(secret);
  try {
    const result = readArchive(file, {
      secretBytes: bytes,
      secretKind: kind,
      kekCache,
      ...context,
    });
    if (expected.ok !== true) {
      throw new Error(`expected ${expected.code}, archive was accepted`);
    }
    return result;
  } catch (error) {
    if (!(error instanceof Ajb1Error)) throw error;
    if (expected.code !== error.code || expected.stage !== error.stage) {
      throw new Error(
        `expected ${expected.code}/${expected.stage}, got ${error.code}/${
          error.stage
        } (${error.detail ?? ''})`,
      );
    }
    return undefined;
  }
}

function generate() {
  const files = new Map();
  const valid = VALID.map(buildValid);
  const byName = new Map(valid.map(vector => [vector.name, vector]));
  const voice = byName.get(V);
  // A second archive with the same secret but different random inputs.
  const sameSecret = (() => {
    const random = randomInputs('voice-multisegment-same-secret');
    const secret = secretBytes(voice.secret);
    return writeArchive({
      plaintext: voice.plaintext,
      secretBytes: secret.bytes,
      secretKind: secret.kind,
      kdf: KDF,
      random,
      kek: kekFor(voice.secret, random.salt),
    });
  })();
  const lookupFile = name =>
    name === 'voice-multisegment-same-secret'
      ? sameSecret
      : byName.get(name).file;

  const json = {
    format: 'AJB1',
    formatVersion: 1,
    domainSchemaVersion: 1,
    status:
      'Proposed; not frozen. KDF parameters are provisional until the lowest-supported-device benchmark.',
    generator: 'tools/ajb1-reference (independent of the app libargon2)',
    randomness:
      'stream(label, n) = SHA-256("ajb1-vectors-v1:" + label || u32be(counter)) concatenated',
    kdf: { algorithm: 'argon2id', version: 19, ...KDF },
    kdfPolicy: PROVISIONAL_KDF_POLICY,
    limits: LIMITS,
    wordlist: { id: WORDLIST_ID, sha256: WORDLIST_SHA256 },
    secrets: Object.fromEntries(
      Object.entries(SECRETS).map(([name, secret]) => [
        name,
        {
          kind: secret.kind,
          input: secret.input,
          kdfInputHex: hex(secretBytes(name).bytes),
        },
      ]),
    ),
    valid: [],
    hostile: [],
    recoveryKeys: { encode: [], decode: [] },
    passwords: [],
  };

  for (const vector of valid) {
    const file = `valid/${vector.name}.ajbackup`;
    const recordsFile = `valid/${vector.name}.records.ndjson`;
    files.set(file, vector.file);
    files.set(recordsFile, vector.recordsText);
    const result = expectOutcome(
      vector.file,
      { secret: vector.secret },
      { ok: true },
    );
    if (!result.recordsText.equals(vector.recordsText))
      throw new Error(`${vector.name}: records differ`);
    json.valid.push({
      name: vector.name,
      file,
      sha256: sha256(vector.file),
      bytes: vector.file.length,
      segments: Math.floor((vector.file.length - HEADER_BYTES) / BLOCK) + 1,
      secret: vector.secret,
      random: Object.fromEntries(
        Object.entries(vector.random).map(([key, value]) => [
          `${key}Hex`,
          hex(value),
        ]),
      ),
      kekHex: hex(vector.kek),
      createdAtMs: CREATED_AT_MS,
      expect: {
        ok: true,
        manifest: vector.manifest,
        recordsFile,
        recordsSha256: sha256(vector.recordsText),
        pcm: [...vector.fixture.pcm.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, pcm]) => ({
            id,
            bytes: pcm.length,
            sha256: sha256(pcm),
            source: `stream("pcm:${vector.fixture.pcmLabels.get(id)}", ${
              pcm.length
            })`,
          })),
      },
    });
  }

  for (const [name, baseName, rawMutation, code, stage] of MUTATIONS) {
    const base = lookupFile(baseName);
    // 'BASE-n' lengths are relative to the base archive's size.
    const mutation =
      typeof rawMutation.length === 'string'
        ? {
            ...rawMutation,
            length: base.length - Number(rawMutation.length.slice(5)),
          }
        : rawMutation;
    const file = applyMutation(base, mutation, lookupFile);
    const secret = byName.get(baseName).secret;
    expectOutcome(file, { secret }, { code, stage });
    json.hostile.push({
      name,
      base: baseName,
      mutation,
      secret,
      expect: { code, stage },
    });
  }
  json.hostile.push({
    name: 'segment-splice-source',
    note: 'Source archive for segment-spliced-from-other-archive: voice-multisegment plaintext and secret, random inputs from label "voice-multisegment-same-secret".',
    file: 'hostile/voice-multisegment-same-secret.ajbackup',
    sha256: sha256(sameSecret),
    expect: { ok: true },
  });
  files.set('hostile/voice-multisegment-same-secret.ajbackup', sameSecret);

  // Secret-level and context-level vectors on valid archives.
  const secretCases = [
    ['wrong-password', W, 'password-wrong', {}, 'AUTH_FAILED', 'unwrap'],
    ['wrong-recovery-key', V, 'recovery-wrong', {}, 'AUTH_FAILED', 'unwrap'],
    [
      'secret-kind-mismatch',
      V,
      'password-a',
      {},
      'SECRET_KIND_MISMATCH',
      'header',
    ],
    [
      'insufficient-storage-for-restore',
      W,
      'password-nfd',
      { purpose: 'restore', availableBytes: 1_024 },
      'INSUFFICIENT_STORAGE',
      'header',
    ],
  ];
  for (const [name, baseName, secret, context, code, stage] of secretCases) {
    expectOutcome(lookupFile(baseName), { secret, context }, { code, stage });
    json.hostile.push({
      name,
      base: baseName,
      mutation: null,
      secret,
      context,
      expect: { code, stage },
    });
  }

  const written = byName.get(W);
  const content = [
    ...contentVectors(written).map(item => [...item, written]),
    ...voiceContentVectors(byName.get('voice-multisegment')).map(item => [
      ...item,
      byName.get('voice-multisegment'),
    ]),
  ];
  for (const [name, plaintext, code, stage, base] of content) {
    const header = buildHeader(
      {
        kdf: KDF,
        salt: base.random.salt,
        secretKind: base.secretKind,
        domainSchemaVersion: 1,
        noncePrefix: base.random.noncePrefix,
        wrapNonce: base.random.wrapNonce,
      },
      base.kek,
      base.random.dek,
    );
    const file = sealStream(
      header,
      base.random.dek,
      base.random.noncePrefix,
      plaintext,
    );
    expectOutcome(file, { secret: base.secret }, { code, stage });
    const path = `hostile/${name}.ajbackup`;
    files.set(path, file);
    json.hostile.push({
      name,
      file: path,
      sha256: sha256(file),
      secret: base.secret,
      random: `same as ${base.name}`,
      expect: { code, stage },
    });
  }

  // Recovery-key text vectors (BIP-39 known answers plus decoding rules).
  for (const entropyHex of [
    '00'.repeat(32),
    '7f'.repeat(32),
    'ff'.repeat(32),
    hex(RECOVERY_ENTROPY),
  ]) {
    json.recoveryKeys.encode.push({
      entropyHex,
      words: encodeRecoveryKey(Buffer.from(entropyHex, 'hex')),
    });
  }
  const canonical = SECRETS['recovery-c'].input;
  const words = canonical.split(' ');
  const swapped = [...words];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  const decodeCases = [
    ['canonical', canonical],
    [
      'upper-case-and-extra-whitespace',
      `  ${words.map(w => w.toUpperCase()).join(' \t\n ')}  `,
    ],
    ['twenty-three-words', words.slice(1).join(' ')],
    ['unknown-word', ['abandonx', ...words.slice(1)].join(' ')],
    ['checksum-mismatch', swapped.join(' ')],
    [
      'non-ascii-letter',
      [words[0].replace('a', 'à'), ...words.slice(1)].join(' '),
    ],
  ];
  for (const [name, input] of decodeCases) {
    const decoded = decodeRecoveryKey(input);
    json.recoveryKeys.decode.push(
      decoded.ok
        ? { name, input, entropyHex: hex(decoded.entropy) }
        : {
            name,
            input,
            reason: decoded.reason,
            ...(decoded.position === undefined
              ? {}
              : { position: decoded.position }),
          },
    );
  }

  for (const [name, input] of [
    ['nfc-input', PASSWORD_NFD.normalize('NFC')],
    ['nfd-input-normalizes-to-nfc', PASSWORD_NFD],
    ['too-short', 'short pass'],
    ['too-long', 'x'.repeat(1_025)],
  ]) {
    const checked = passwordBytes(input);
    json.passwords.push(
      checked.ok
        ? { name, input, kdfInputHex: hex(checked.bytes) }
        : { name, input, reason: checked.reason },
    );
  }

  files.set(
    'vectors.json',
    Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf8'),
  );
  return files;
}

const files = generate();
if (CHECK) {
  let mismatches = 0;
  for (const [path, bytes] of files) {
    let existing;
    try {
      existing = readFileSync(join(OUT, path));
    } catch {
      existing = undefined;
    }
    if (!existing || !existing.equals(bytes)) {
      mismatches += 1;
      process.stdout.write(`MISMATCH ${path}\n`);
    }
  }
  process.stdout.write(
    `checked ${files.size} files, ${mismatches} mismatches\n`,
  );
  process.exitCode = mismatches ? 1 : 0;
} else {
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(OUT, path)), { recursive: true });
    writeFileSync(join(OUT, path), bytes);
  }
  process.stdout.write(`wrote ${files.size} files to ${OUT}\n`);
}
