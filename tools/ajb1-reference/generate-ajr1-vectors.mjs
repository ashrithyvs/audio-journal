// Generates (or, with --check, verifies) AJR1 vectors in schemas/ajr1/v1/.
// Inputs are SHA-256 counter streams (lib/fixtures.mjs `stream`), so another
// implementation can rebuild every file byte for byte. The Kotlin codec's
// JVM test (Ajr1VectorsTest) reproduces and reads these files.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodedInfo,
  encodeHeader,
  fileKey,
  scan,
  sealFrame,
} from './lib/ajr1.mjs';
import { localId, stream } from './lib/fixtures.mjs';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../schemas/ajr1/v1',
);
const CHECK = process.argv.includes('--check');
const hex = buffer => Buffer.from(buffer).toString('hex');
const sha256 = data => createHash('sha256').update(data).digest('hex');

const ROOT = stream('ajr1:recording-root-key', 32);
const ID_A = localId('rec', 'ajr1-a');
const ID_B = localId('rec', 'ajr1-b');
const PREFIX = stream('ajr1:nonce-prefix', 4);
const pcm = (label, bytes) => stream(`ajr1:pcm:${label}`, bytes);

function build({ id, saltLabel, frames }) {
  const salt = stream(`ajr1:salt:${saltLabel}`, 16);
  const header = encodeHeader(salt, PREFIX);
  const key = fileKey(ROOT, salt, id);
  const parts = [header];
  for (const { index, pcmLabel, bytes } of frames) {
    parts.push(sealFrame(key, header, id, index, pcm(pcmLabel, bytes)));
  }
  return { file: Buffer.concat(parts), salt, key };
}

const basicFrames = [0, 1, 2, 3].map(index => ({
  index,
  pcmLabel: `chunk-${index}`,
  bytes: index === 3 ? 1_000 : 3_200,
}));

const SPECS = [
  { name: 'basic', id: ID_A, saltLabel: 's1', frames: basicFrames },
  // Same salt and nonce prefix as basic, different recording: different key.
  {
    name: 'same-prefix-other-recording',
    id: ID_B,
    saltLabel: 's1',
    frames: basicFrames.slice(0, 1),
  },
  // Same recording ID, new salt (a recreated file): different key.
  {
    name: 'same-recording-new-salt',
    id: ID_A,
    saltLabel: 's2',
    frames: basicFrames.slice(0, 1),
  },
  {
    name: 'gaps',
    id: ID_A,
    saltLabel: 's3',
    frames: [0, 7, 8].map(index => ({
      index,
      pcmLabel: `gap-${index}`,
      bytes: 640,
    })),
  },
];

function generate() {
  const files = new Map();
  const json = {
    format: 'AJR1',
    version: 1,
    status: 'Decided design (owner 2026-10-10); vectors for implementation.',
    randomness: 'stream(label, n) as in schemas/ajb1/v1/vectors.json',
    keyLabel: 'audio-journal/ajr1/recording-key/v1',
    recordingRootKeyHex: hex(ROOT),
    noncePrefixHex: hex(PREFIX),
    valid: [],
    readCases: [],
  };
  const built = new Map();
  for (const spec of SPECS) {
    const { file, salt, key } = build(spec);
    built.set(spec.name, file);
    const result = scan(file, ROOT, spec.id);
    if (result.stop !== null || result.trailingBytes !== 0) {
      throw new Error(`${spec.name}: reference scan failed`);
    }
    const path = `${spec.name}.ajr`;
    files.set(path, file);
    json.valid.push({
      name: spec.name,
      file: path,
      sha256: sha256(file),
      recordingId: spec.id,
      saltHex: hex(salt),
      encodedInfoHex: hex(encodedInfo(spec.id)),
      fileKeyHex: hex(key),
      frames: spec.frames.map(f => ({
        index: f.index,
        pcm: `stream("ajr1:pcm:${f.pcmLabel}", ${f.bytes})`,
        pcmSha256: sha256(pcm(f.pcmLabel, f.bytes)),
      })),
      expect: {
        indices: result.indices,
        pcmSha256: result.pcmSha256,
        resumeIndex: result.resumeIndex,
      },
    });
  }

  // Read cases: what a reader must report for damaged or hostile files.
  const basic = built.get('basic');
  const salt1 = stream('ajr1:salt:s1', 16);
  const header1 = basic.subarray(0, 64);
  const key1 = fileKey(ROOT, salt1, ID_A);
  const torn = sealFrame(key1, header1, ID_A, 4, pcm('chunk-4', 3_200));
  const reads = [
    ['torn-tail', Buffer.concat([basic, torn.subarray(0, 30)]), ID_A],
    ['torn-frame-header', Buffer.concat([basic, torn.subarray(0, 10)]), ID_A],
    ['wrong-recording-id', basic, ID_B],
    [
      'index-order',
      Buffer.concat([
        header1,
        ...[0, 2, 1].map(i =>
          sealFrame(key1, header1, ID_A, i, pcm(`order-${i}`, 640)),
        ),
      ]),
      ID_A,
    ],
    [
      // Frame 7 of a file with the same recording ID but another salt: order
      // holds (7 > 3) and authentication must fail.
      'spliced-from-recreated-file',
      Buffer.concat([
        basic,
        built.get('gaps').subarray(64 + 668, 64 + 2 * 668),
      ]),
      ID_A,
    ],
  ];
  for (const [name, file, id] of reads) {
    const result = scan(file, ROOT, id);
    const path = `read-${name}.ajr`;
    files.set(path, file);
    json.readCases.push({
      name,
      file: path,
      sha256: sha256(file),
      readAs: id,
      expect: {
        indices: result.indices,
        stop: result.stop,
        trailingBytes: result.trailingBytes,
        resumeIndex: result.resumeIndex,
      },
    });
  }
  const expected = {
    'torn-tail': ['TORN', 5],
    'torn-frame-header': ['TORN', 5],
    'wrong-recording-id': ['AUTH_FAILED', 1],
    'index-order': ['INDEX_ORDER', 4],
    'spliced-from-recreated-file': ['AUTH_FAILED', 8],
  };
  for (const item of json.readCases) {
    const [stop, resume] = expected[item.name];
    if (item.expect.stop !== stop || item.expect.resumeIndex !== resume) {
      throw new Error(
        `${item.name}: got ${item.expect.stop}/${item.expect.resumeIndex}`,
      );
    }
  }
  files.set('vectors.json', Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
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
  mkdirSync(OUT, { recursive: true });
  for (const [path, bytes] of files) {
    writeFileSync(join(OUT, path), bytes);
  }
  process.stdout.write(`wrote ${files.size} files to ${OUT}\n`);
}
