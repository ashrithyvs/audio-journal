// Starts the Audio Journal node companion (node-companion/, ADR-018) as an
// external process for device suites and exposes its loopback operator API.
// The app reaches it only through the packaged Hybrid AI SDK, over
// `adb reverse` to 127.0.0.1.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { adb } from '../../android/lib/device.mjs';

const BIN = path.resolve(
  import.meta.dirname,
  '../../../node-companion/bin/aj-companion.mjs',
);

export async function startCompanion({
  name = 'AJ Companion',
  stateDir,
  port = 0,
  stageDelayMs = 0,
  padResults = false,
} = {}) {
  const state =
    stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aj2-companion-'));
  const args = [
    BIN,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--admin-port',
    '0',
    '--state-dir',
    state,
    '--name',
    name,
    '--stage-delay-ms',
    String(stageDelayMs),
  ];
  if (padResults) args.push('--test-pad-results');
  if (port) args.push('--endpoint', `127.0.0.1:${port}`);
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The companion logs codes, counts, and durations only (contract §10);
  // suites keep the whole log to prove it.
  const log = [];
  child.stderr.on('data', chunk => log.push(String(chunk)));
  child.on('exit', (code, signal) =>
    log.push(`EXIT code=${code} signal=${signal}\n`),
  );
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('companion did not start')),
      15_000,
    );
    child.stdout.on('data', chunk => {
      const match = /READY (\d+) (\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), adminPort: Number(match[2]) });
      }
    });
    child.on('exit', code => reject(new Error(`companion exited ${code}`)));
  });
  const { adminToken } = JSON.parse(
    fs.readFileSync(path.join(state, 'admin.json'), 'utf8'),
  );
  adb('reverse', `tcp:${ready.port}`, `tcp:${ready.port}`);
  const admin = async (method, route, body) => {
    const response = await fetch(
      `http://127.0.0.1:${ready.adminPort}${route}`,
      {
        method,
        headers: {
          authorization: `Bearer ${adminToken}`,
          connection: 'close',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  };
  let lastPending;
  return {
    ...ready,
    stateDir: state,
    log,
    async bootstrap(lifetimeSeconds = 120) {
      const { body } = await admin('POST', '/admin/bootstrap', {
        lifetimeSeconds,
        endpoints: [{ host: '127.0.0.1', port: ready.port }],
      });
      return body;
    },
    /** The pending ceremony in the shape the shared pairing helper reads. */
    async pending() {
      const { body } = await admin('GET', '/admin/pending');
      lastPending = body.pending?.at(-1);
      return lastPending
        ? { ...lastPending, verificationCode: lastPending.code }
        : undefined;
    },
    async approve() {
      return admin('POST', '/admin/decision', {
        pairingId: lastPending.pairingId,
        decision: 'approve',
      });
    },
    async pairings() {
      return (await admin('GET', '/admin/pairings')).body.pairings;
    },
    async stats() {
      return (await admin('GET', '/admin/stats')).body;
    },
    async handshakes() {
      return (await admin('GET', '/admin/handshakes')).body.handshakes;
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise(resolve => child.once('exit', resolve));
      }
      try {
        adb('reverse', '--remove', `tcp:${ready.port}`);
      } catch {
        // already removed
      }
    },
  };
}
