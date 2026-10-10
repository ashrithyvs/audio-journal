import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  buildPlaintext,
  openStream,
  parsePlaintext,
  PROVISIONAL_KDF_POLICY,
  SECRET_PASSWORD,
  writeArchive,
} from '../lib/ajb1.mjs';
import { randomInputs, voiceFixture } from '../lib/fixtures.mjs';
import {
  Cancelled,
  cleanupStale,
  exportArchive,
  restoreArchive,
} from '../lib/procedure.mjs';

// The KEK is supplied directly (no KDF work); the header still carries the
// provisional floor parameters so restore prechecks pass.
const kdf = PROVISIONAL_KDF_POLICY.floor;
const CANARY = 'PLAINTEXT-CANARY-5521';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ajb1-procedure-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function journal() {
  const fixture = voiceFixture({ longMs: 40_000 }); // spans two segments
  fixture.records[0] = { ...fixture.records[0], sourceText: `Diary ${CANARY}` };
  return buildPlaintext({ ...fixture, createdAtMs: 1 });
}

const verifier = kek => bytes => parsePlaintext(openStream(bytes, kek), { domainSchemaVersion: 1 });

/** Every file under `root` (recursively), with its bytes. */
function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [[path, readFileSync(path)]];
  });
}

function assertNoPlaintext(root, pcmSample) {
  for (const [path, bytes] of files(root)) {
    assert.equal(bytes.includes(Buffer.from(CANARY)), false, `canary in ${path}`);
    assert.equal(bytes.includes(pcmSample), false, `PCM in ${path}`);
  }
}

function setup() {
  const { plaintext } = journal();
  const kek = randomBytes(32);
  const random = randomInputs('procedure');
  const pcmSample = voiceFixture({ longMs: 40_000 }).pcm.values().next().value.subarray(5_000, 5_064);
  const pieces = [];
  for (let at = 0; at < plaintext.length; at += 70_000) {
    pieces.push(plaintext.subarray(at, at + 70_000));
  }
  return { plaintext, kek, random, pieces, pcmSample };
}

test('streamed export equals the reference writer and verifies', () => {
  const { plaintext, kek, random, pieces } = setup();
  const destination = join(dir, 'out', 'backup.ajbackup');
  mkdirSync(join(dir, 'out'));
  const result = exportArchive({
    pieces, kek, kdf, secretKind: SECRET_PASSWORD, random,
    cacheDir: join(dir, 'cache'), destination, verify: verifier(kek),
  });
  assert.deepEqual(result, { status: 'complete' });
  const reference = writeArchive({ plaintext, secretKind: SECRET_PASSWORD, kdf, random, kek });
  assert.ok(readFileSync(destination).equals(reference));
  assert.deepEqual(readdirSync(join(dir, 'cache')), []);
});

test('cancelling export at every phase leaves no temporary or partial output', () => {
  const { kek, random, pieces, pcmSample } = setup();
  for (const phase of ['start', 'header', 'segments', 'written', 'verified', 'copied']) {
    const cacheDir = join(dir, `cache-${phase}`);
    const outDir = join(dir, `out-${phase}`);
    mkdirSync(outDir);
    const destination = join(outDir, 'backup.ajbackup');
    const result = exportArchive({
      pieces, kek, kdf, secretKind: SECRET_PASSWORD, random, cacheDir, destination,
      verify: verifier(kek),
      checkpoint: at => {
        // At every phase, nothing on disk holds plaintext.
        assertNoPlaintext(cacheDir, pcmSample);
        assertNoPlaintext(outDir, pcmSample);
        if (at === phase) throw new Cancelled(at);
      },
    });
    assert.deepEqual(result, { status: 'cancelled', phase });
    assert.deepEqual(readdirSync(cacheDir), [], phase);
    assert.deepEqual(readdirSync(outDir), [], phase);
  }
});

test('a failed verification removes the output and reports failure', () => {
  const { kek, random, pieces } = setup();
  const outDir = join(dir, 'out');
  mkdirSync(outDir);
  const result = exportArchive({
    pieces, kek, kdf, secretKind: SECRET_PASSWORD, random,
    cacheDir: join(dir, 'cache'), destination: join(outDir, 'backup.ajbackup'),
    verify: () => {
      throw Object.assign(new Error('verify'), { code: 'AUTH_FAILED' });
    },
  });
  assert.deepEqual(result, { status: 'failed', code: 'AUTH_FAILED' });
  assert.deepEqual(readdirSync(join(dir, 'cache')), []);
  assert.deepEqual(readdirSync(outDir), []);
});

test('restore stages ciphertext only and activates atomically', () => {
  const { plaintext, kek, random, pcmSample } = setup();
  const file = writeArchive({ plaintext, secretKind: SECRET_PASSWORD, kdf, random, kek });
  const stagingRoot = join(dir, 'staging');
  const vaultDir = join(dir, 'vault');
  const result = restoreArchive({
    file, kek, stagingRoot, vaultDir,
    checkpoint: () => assertNoPlaintext(stagingRoot, pcmSample),
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(readdirSync(stagingRoot), []);
  assert.equal(readdirSync(vaultDir).length, 3); // records + 2 recordings
  assertNoPlaintext(vaultDir, pcmSample);
});

test('cancelling or failing restore at any phase leaves the empty journal unchanged', () => {
  const { plaintext, kek, random } = setup();
  const file = writeArchive({ plaintext, secretKind: SECRET_PASSWORD, kdf, random, kek });
  for (const phase of ['start', 'prechecked', 'authenticated', 'records', 'recordings', 'activate']) {
    const stagingRoot = join(dir, `staging-root-${phase}`);
    const vaultDir = join(dir, `vault-${phase}`);
    const result = restoreArchive({
      file, kek, stagingRoot, vaultDir,
      checkpoint: at => {
        if (at === phase) throw new Cancelled(at);
      },
    });
    assert.deepEqual(result, { status: 'cancelled', phase });
    assert.equal(existsSync(vaultDir), false, phase);
    assert.deepEqual(existsSync(stagingRoot) ? readdirSync(stagingRoot) : [], [], phase);
  }
  // A tampered archive fails authentication with nothing staged.
  const tampered = Buffer.from(file);
  tampered[tampered.length - 1] ^= 1;
  const stagingRoot = join(dir, 'staging-tampered');
  assert.deepEqual(
    restoreArchive({ file: tampered, kek, stagingRoot, vaultDir: join(dir, 'vault-t') }),
    { status: 'failed', code: 'AUTH_FAILED' },
  );
  assert.deepEqual(readdirSync(stagingRoot), []);
  // Restore never targets a non-empty journal (v0.1).
  const occupied = join(dir, 'occupied');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'journal.db'), 'x');
  assert.deepEqual(
    restoreArchive({ file, kek, stagingRoot: join(dir, 's2'), vaultDir: occupied }),
    { status: 'failed', code: 'VAULT_NOT_EMPTY' },
  );
});

test('restore refuses before any KDF work when storage is short', () => {
  const { plaintext, kek, random } = setup();
  const file = writeArchive({ plaintext, secretKind: SECRET_PASSWORD, kdf, random, kek });
  assert.deepEqual(
    restoreArchive({
      file, kek, stagingRoot: join(dir, 'st'), vaultDir: join(dir, 'v'),
      context: { availableBytes: file.length },
    }),
    { status: 'failed', code: 'INSUFFICIENT_STORAGE' },
  );
});

test('startup cleanup removes leftovers from a killed process, nothing else', () => {
  const cacheDir = join(dir, 'cache');
  const stagingRoot = join(dir, 'staging');
  mkdirSync(cacheDir);
  mkdirSync(join(stagingRoot, `staging-${'a'.repeat(32)}`), { recursive: true });
  writeFileSync(join(cacheDir, `ajb1-${'b'.repeat(32)}.part`), 'ciphertext');
  writeFileSync(join(cacheDir, 'unrelated.txt'), 'keep');
  assert.deepEqual(cleanupStale(cacheDir, stagingRoot).sort(), [
    `ajb1-${'b'.repeat(32)}.part`,
    `staging-${'a'.repeat(32)}`,
  ]);
  assert.deepEqual(readdirSync(cacheDir), ['unrelated.txt']);
  assert.deepEqual(readdirSync(stagingRoot), []);
});
