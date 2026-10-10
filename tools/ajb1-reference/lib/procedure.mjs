// AJB1 export and restore procedures (§9.10), reference version: streaming,
// cancellable at every phase, and cleaning up after itself. It shows the
// required file behaviour (temporary and staging files hold ciphertext only,
// and cancellation leaves no trace) for the platform codecs to match.

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  buildHeader,
  HEADER_BYTES,
  openStream,
  parsePlaintext,
  precheck,
  SEGMENT_BYTES,
  TAG_BYTES,
} from './ajb1.mjs';

export class Cancelled extends Error {
  constructor(phase) {
    super(`cancelled at ${phase}`);
    this.phase = phase;
  }
}

const u64 = value => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
};

function seal(dek, prefix, headerHash, index, final, chunk) {
  const cipher = createCipheriv('aes-256-gcm', dek, Buffer.concat([prefix, u64(index)]));
  cipher.setAAD(Buffer.concat([headerHash, u64(index), Buffer.from([final ? 1 : 0])]));
  return Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Streams `pieces` (plaintext Buffers, e.g. sections) into an archive at
 * `destination`, via an app-private `.part` file in `cacheDir`. At most one
 * segment of plaintext is in memory. `checkpoint(phase)` may throw Cancelled.
 */
export function exportArchive({
  pieces,
  kek,
  kdf,
  secretKind,
  random,
  cacheDir,
  destination,
  checkpoint = () => {},
  verify,
}) {
  mkdirSync(cacheDir, { recursive: true });
  const temp = join(cacheDir, `ajb1-${randomBytes(16).toString('hex')}.part`);
  let createdDestination = false;
  try {
    checkpoint('start');
    const header = buildHeader(
      { kdf, salt: random.salt, secretKind, domainSchemaVersion: 1, noncePrefix: random.noncePrefix, wrapNonce: random.wrapNonce },
      kek,
      random.dek,
    );
    const headerHash = createHash('sha256').update(header).digest();
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, header);
      checkpoint('header');
      let buffer = Buffer.alloc(0);
      let index = 0;
      for (const piece of pieces) {
        buffer = Buffer.concat([buffer, piece]);
        while (buffer.length > SEGMENT_BYTES) {
          writeSync(fd, seal(random.dek, random.noncePrefix, headerHash, index, false, buffer.subarray(0, SEGMENT_BYTES)));
          buffer = buffer.subarray(SEGMENT_BYTES);
          index += 1;
          checkpoint('segments');
        }
      }
      // A stream that fills the last segment exactly still ends with an
      // empty final segment (§9.3).
      if (buffer.length === SEGMENT_BYTES) {
        writeSync(fd, seal(random.dek, random.noncePrefix, headerHash, index, false, buffer));
        buffer = Buffer.alloc(0);
        index += 1;
      }
      writeSync(fd, seal(random.dek, random.noncePrefix, headerHash, index, true, buffer));
    } finally {
      closeSync(fd);
    }
    checkpoint('written');
    verify(readFileSync(temp)); // reopen and authenticate everything
    checkpoint('verified');
    // The user-chosen destination: written beside it, then renamed in.
    const writing = `${destination}.writing`;
    createdDestination = true;
    writeSyncFile(writing, readFileSync(temp));
    checkpoint('copied');
    renameSync(writing, destination);
    verify(readFileSync(destination)); // success only after the destination verifies
    unlinkSync(temp);
    return { status: 'complete' };
  } catch (error) {
    rmSync(temp, { force: true });
    if (createdDestination) {
      rmSync(`${destination}.writing`, { force: true });
      rmSync(destination, { force: true });
    }
    if (error instanceof Cancelled) {
      return { status: 'cancelled', phase: error.phase };
    }
    return { status: 'failed', code: error.code ?? 'EXPORT_FAILED' };
  }
}

function writeSyncFile(path, bytes) {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Startup cleanup after process death: unreadable leftovers are removed. */
export function cleanupStale(cacheDir, stagingRoot) {
  const removed = [];
  for (const dir of [cacheDir, stagingRoot]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^ajb1-[0-9a-f]{32}\.part$/.test(name) || /^staging-[0-9a-f]{32}$/.test(name)) {
        rmSync(join(dir, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
  }
  return removed;
}

/**
 * Restores into `stagingRoot/staging-<random>` and activates by renaming it
 * to `vaultDir` only after everything verified. Staged objects are
 * re-encrypted under a fresh staging key (standing in for the new vault's
 * keys), so no staging file ever holds plaintext.
 */
export function restoreArchive({ file, kek, stagingRoot, vaultDir, context = {}, checkpoint = () => {} }) {
  const staging = join(stagingRoot, `staging-${randomBytes(16).toString('hex')}`);
  try {
    checkpoint('start');
    if (existsSync(vaultDir) && readdirSync(vaultDir).length > 0) {
      return { status: 'failed', code: 'VAULT_NOT_EMPTY' };
    }
    const pre = precheck(file, { purpose: 'restore', ...context });
    checkpoint('prechecked');
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagingKey = randomBytes(32);
    const plaintext = openStream(file, kek);
    checkpoint('authenticated');
    const { manifest, recordsText, pcm } = parsePlaintext(plaintext, {
      domainSchemaVersion: pre.domainSchemaVersion,
    });
    const stage = (name, bytes) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', stagingKey, nonce);
      writeSyncFile(join(staging, name), Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]));
    };
    stage('records.enc', recordsText);
    checkpoint('records');
    for (const [id, samples] of pcm) {
      stage(`${id}.enc`, samples);
      checkpoint('recordings');
    }
    checkpoint('activate');
    rmSync(vaultDir, { recursive: true, force: true });
    renameSync(staging, vaultDir); // atomic on one filesystem
    stagingKey.fill(0);
    return { status: 'complete', manifest };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof Cancelled) {
      return { status: 'cancelled', phase: error.phase };
    }
    return { status: 'failed', code: error.code ?? 'RESTORE_FAILED' };
  }
}

export const BLOCK_BYTES = SEGMENT_BYTES + TAG_BYTES;
export { HEADER_BYTES };
