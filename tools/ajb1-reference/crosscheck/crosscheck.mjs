// Cross-checks ../lib/argon2.mjs against the pinned reference libargon2
// (release 20190702, archive SHA-256 daf972a8...442c): the vector KEKs plus a
// spread of parameters. Usage:
//   node crosscheck.mjs <path to compiled argon2-hex driver>
// Build the driver from the verified archive with crosscheck.sh.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { argon2id } from '../lib/argon2.mjs';
import { stream } from '../lib/fixtures.mjs';

const driver = process.argv[2];
const vectors = JSON.parse(
  readFileSync(
    new URL('../../../schemas/ajb1/v1/vectors.json', import.meta.url),
  ),
);

const cases = [];
for (const vector of vectors.valid) {
  const secret = vectors.secrets[vector.secret];
  cases.push({
    name: `vector ${vector.name}`,
    password: Buffer.from(secret.kdfInputHex, 'hex'),
    salt: Buffer.from(vector.random.saltHex, 'hex'),
    ...vectors.kdf,
    expected: vector.kekHex,
  });
}
// The case VaultDeviceTest checks against the app's libargon2 build.
cases.push({
  name: 'device-test',
  password: Buffer.from('correct horse battery staple', 'utf8'),
  salt: Buffer.from(Array.from({ length: 16 }, (_, index) => index)),
  m: 19_456,
  t: 2,
  p: 1,
});
for (const [index, [m, t, p]] of [
  [8, 1, 1],
  [64, 1, 1],
  [64, 3, 2],
  [256, 2, 4],
  [1_000, 1, 3],
  [4_096, 4, 1],
].entries()) {
  cases.push({
    name: `params m=${m} t=${t} p=${p}`,
    password: stream(`crosscheck-password-${index}`, 7 + index * 5),
    salt: stream(`crosscheck-salt-${index}`, 16),
    m,
    t,
    p,
  });
}

const input = cases
  .map(
    c =>
      `${
        c.password.length ? c.password.toString('hex') : '-'
      } ${c.salt.toString('hex')} ${c.t} ${c.m} ${c.p} 32`,
  )
  .join('\n');
const run = spawnSync(driver, [], { input: `${input}\n`, encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr);
const reference = run.stdout.trim().split('\n');
assert.equal(reference.length, cases.length);

cases.forEach((c, index) => {
  const ours = argon2id(c.password, c.salt, {
    m: c.m,
    t: c.t,
    p: c.p,
  }).toString('hex');
  assert.equal(ours, reference[index], `${c.name}: JS differs from libargon2`);
  if (c.expected) {
    assert.equal(
      reference[index],
      c.expected,
      `${c.name}: libargon2 differs from vectors.json`,
    );
  }
  process.stdout.write(
    c.name === 'device-test'
      ? `DEVICE_TEST_TAG ${reference[index]}\n`
      : `ok ${c.name} ${reference[index].slice(0, 16)}...\n`,
  );
});
process.stdout.write(`${cases.length} cases: JS == reference libargon2\n`);
