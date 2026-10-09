// Starts the SDK repository's paired-LAN reference node (ADR-022 test profile)
// as an external process and exposes its loopback operator API. Nothing here
// imports SDK code; the node is reached by the app only through the SDK.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { adb } from './device.mjs';

export const SDK_REPO =
  process.env.HYBRID_AI_SDK_REPO ??
  path.resolve(import.meta.dirname, '../../../../hybridAi');

export async function startNode({
  name = 'AJ Test Node',
  stateDir,
  port = 0,
  env = {},
} = {}) {
  const state = stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aj3-node-'));
  const child = spawn(
    process.execPath,
    [
      path.join(SDK_REPO, 'reference-node/src/paired.mjs'),
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
    ],
    {
      env: { ...process.env, HYBRID_AI_DEBUG: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log = [];
  child.stderr.on('data', chunk => log.push(String(chunk)));
  child.on('exit', (code, signal) =>
    log.push(`EXIT code=${code} signal=${signal}\n`),
  );
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('reference node did not start')),
      10_000,
    );
    child.stdout.on('data', chunk => {
      const match = /READY (\d+) (\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), adminPort: Number(match[2]) });
      }
    });
    child.on('exit', code =>
      reject(new Error(`reference node exited ${code}`)),
    );
  });
  adb('reverse', `tcp:${ready.port}`, `tcp:${ready.port}`);
  const admin = async (method, route, body) => {
    const request = () =>
      fetch(`http://127.0.0.1:${ready.adminPort}${route}`, {
        method,
        // Fresh connection per call: a reused keep-alive socket the server
        // already closed fails with UND_ERR_SOCKET.
        headers: {
          connection: 'close',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    let response;
    try {
      response = await request();
    } catch {
      response = await request();
    }
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  };
  return {
    ...ready,
    stateDir: state,
    log,
    admin,
    async bootstrap(lifetimeSeconds = 120) {
      return (await admin('POST', '/admin/bootstrap', { lifetimeSeconds }))
        .body;
    },
    async pending() {
      const result = await admin('GET', '/admin/pending');
      return result.status === 200 ? result.body : undefined;
    },
    async approve() {
      return admin('POST', '/admin/approve', {});
    },
    async pairings() {
      return (await admin('GET', '/admin/pairings')).body;
    },
    async nodeId() {
      return (await admin('GET', '/admin/state')).body.nodeId;
    },
    async revokeAll() {
      for (const pairing of await this.pairings()) {
        await admin('DELETE', `/admin/pairings/${pairing.pairingId}`);
      }
    },
    async dropConnections() {
      return admin('POST', '/admin/test/drop-connections');
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
