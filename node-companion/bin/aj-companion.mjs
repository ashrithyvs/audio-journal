#!/usr/bin/env node
// Audio Journal Private Node companion (ADR-018, ADR-019).
//
//   aj-companion serve [--host 0.0.0.0] [--port 38443] [--state-dir DIR]
//                      [--name NAME] [--endpoint HOST:PORT ...] [--admin-port N]
//   aj-companion pair  [--admin http://127.0.0.1:N] [--lifetime 120]
//   aj-companion pairings | revoke <pairingId>
//
// `serve` prints `READY <port> <adminPort>` and writes the operator token to
// <state-dir>/admin.json (mode 0600). It logs only codes, counts, durations,
// and TLS handshake facts, never journal content.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { loadIdentity } from '../src/identity.mjs';
import { startCompanion } from '../src/server.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', default: '38443' },
    'state-dir': {
      type: 'string',
      default: join(homedir(), '.audio-journal-companion'),
    },
    name: { type: 'string', default: 'Audio Journal companion' },
    endpoint: { type: 'string', multiple: true },
    'admin-port': { type: 'string', default: '0' },
    lifetime: { type: 'string', default: '120' },
    'stage-delay-ms': { type: 'string', default: '0' },
    // Test-only: results grown to the exact output cap (src/testPad.mjs).
    'test-pad-results': { type: 'boolean', default: false },
  },
});
const command = positionals[0] ?? 'serve';
const stateDir = values['state-dir'];

function lanEndpoints(port) {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal)
        out.push({ host: a.address, port });
  }
  return out.slice(0, 4);
}

async function admin(path, method = 'GET', body) {
  const { adminPort, adminToken } = JSON.parse(
    readFileSync(join(stateDir, 'admin.json'), 'utf8'),
  );
  const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

if (command === 'serve') {
  const identity = await loadIdentity(stateDir, { name: values.name });
  const port = Number(values.port);
  const endpoints = values.endpoint?.map(e => {
    const i = e.lastIndexOf(':');
    return { host: e.slice(0, i), port: Number(e.slice(i + 1)) };
  });
  const node = await startCompanion(identity, {
    host: values.host,
    port,
    adminPort: Number(values['admin-port']),
    endpoints: endpoints ?? (port ? lanEndpoints(port) : undefined),
    stageDelayMs: Number(values['stage-delay-ms']),
    padResults: values['test-pad-results'],
    log: entry =>
      process.stderr.write(
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      ),
  });
  const file = join(stateDir, 'admin.json');
  writeFileSync(
    file,
    `${JSON.stringify({
      adminPort: node.adminPort,
      adminToken: node.adminToken,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  process.stdout.write(`READY ${node.port} ${node.adminPort}\n`);
  process.stdout.write(`node ${identity.nodeId} key ${identity.nodeKey}\n`);
  const stop = () => node.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (command === 'pair') {
  const { qr, expiresAt } = await admin('/admin/bootstrap', 'POST', {
    lifetimeSeconds: Number(values.lifetime),
  });
  process.stdout.write(
    `Pairing code (enter it in Audio Journal → Settings → Private AI Node):\n\n${qr}\n\nValid until ${new Date(
      expiresAt * 1000,
    ).toLocaleTimeString()}.\nWaiting for the device…\n`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (let i = 0; i < Number(values.lifetime) * 2 + 240; i += 1) {
    const { pending } = await admin('/admin/pending');
    if (pending.length) {
      const p = pending[0];
      const answer = await rl.question(
        `Device "${p.deviceName}" shows code ${p.code}. Same code on the device? [y/N] `,
      );
      const decision =
        answer.trim().toLowerCase() === 'y' ? 'approve' : 'reject';
      await admin('/admin/decision', 'POST', {
        pairingId: p.pairingId,
        decision,
      });
      process.stdout.write(
        decision === 'approve' ? 'Paired.\n' : 'Rejected.\n',
      );
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  rl.close();
} else if (command === 'pairings') {
  process.stdout.write(
    `${JSON.stringify(await admin('/admin/pairings'), null, 2)}\n`,
  );
} else if (command === 'revoke') {
  process.stdout.write(
    `${JSON.stringify(
      await admin(`/admin/pairings/${positionals[1]}`, 'DELETE'),
    )}\n`,
  );
} else {
  process.stderr.write(`unknown command ${command}\n`);
  process.exitCode = 2;
}
