import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  Ajb1Error,
  buildPlaintext,
  readArchive,
  SECRET_PASSWORD,
  writeArchive,
} from '../lib/ajb1.mjs';
import {
  randomInputs,
  voiceFixture,
  writtenFixture,
} from '../lib/fixtures.mjs';
import { applyMutation } from '../lib/mutations.mjs';

// Cheap KDF parameters keep these unit tests fast; the vectors use the
// provisional floor.
const kdf = { m: 64, t: 1, p: 1 };
const policy = {
  floor: { m: 8, t: 1, p: 1 },
  ceiling: { m: 1024, t: 4, p: 4 },
};
const secret = Buffer.from('correct horse battery staple', 'utf8');

function archive(fixture, label = 'unit') {
  const { plaintext, recordsText } = buildPlaintext({
    ...fixture,
    createdAtMs: 1,
  });
  const file = writeArchive({
    plaintext,
    secretBytes: secret,
    secretKind: SECRET_PASSWORD,
    kdf,
    random: randomInputs(label),
  });
  return { file, recordsText };
}

const read = (file, extra = {}) =>
  readArchive(file, {
    secretBytes: secret,
    secretKind: SECRET_PASSWORD,
    policy,
    ...extra,
  });

const codeOf = fn => {
  try {
    fn();
  } catch (error) {
    if (error instanceof Ajb1Error) return `${error.code}/${error.stage}`;
    throw error;
  }
  return 'accepted';
};

test('round-trips records exactly and PCM byte for byte', () => {
  const fixture = voiceFixture({ longMs: 40_000 });
  const { file, recordsText } = archive(fixture);
  const result = read(file);
  assert.ok(result.recordsText.equals(recordsText));
  for (const [id, pcm] of fixture.pcm) {
    assert.ok(result.pcm.get(id).equals(pcm), id);
  }
  assert.equal(result.manifest.records.counts.transcriptSegment, 6);
});

test('a different secret or a tampered byte fails authentication', () => {
  const { file } = archive(writtenFixture());
  assert.equal(
    codeOf(() =>
      read(file, { secretBytes: Buffer.from('another password here') }),
    ),
    'AUTH_FAILED/unwrap',
  );
  const tampered = applyMutation(file, {
    op: 'xor',
    offset: file.length - 1,
    hex: '01',
  });
  assert.equal(
    codeOf(() => read(tampered)),
    'AUTH_FAILED/segment',
  );
});

test('KDF bounds are enforced before any KDF work', () => {
  const { file } = archive(writtenFixture());
  const strict = {
    floor: { m: 19_456, t: 2, p: 1 },
    ceiling: { m: 65_536, t: 4, p: 4 },
  };
  assert.equal(
    codeOf(() => read(file, { policy: strict })),
    'KDF_PARAMS_REJECTED/header',
  );
});

test('the same inputs always produce the same archive', () => {
  assert.ok(
    archive(writtenFixture(), 'x').file.equals(
      archive(writtenFixture(), 'x').file,
    ),
  );
  assert.ok(
    !archive(writtenFixture(), 'x').file.equals(
      archive(writtenFixture(), 'y').file,
    ),
  );
});

test('committed vectors regenerate byte for byte and meet every expectation', () => {
  const script = fileURLToPath(
    new URL('../generate-vectors.mjs', import.meta.url),
  );
  const run = spawnSync(process.execPath, [script, '--check'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, / 0 mismatches/);
});
