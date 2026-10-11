// A test device for the companion: a client certificate, pinned TLS to the
// node key, the device side of the pairing ceremony, JSON requests, and a raw
// RFC 6455 reader for job events.

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

import { loadIdentity, spkiPin } from '../src/identity.mjs';
import { canonical } from '../src/json.mjs';
import {
  keySchedule,
  mac,
  SUITE,
  transcripts,
  verificationCode,
} from '../src/pairing.mjs';

export async function makeDevice(
  node,
  { name = 'Test device', tlsOptions = {} } = {},
) {
  const id = await loadIdentity(mkdtempSync(join(tmpdir(), 'aj-device-')), {
    name,
  });
  const pinned = (_host, cert) =>
    spkiPin(
      `-----BEGIN CERTIFICATE-----\n${cert.raw.toString(
        'base64',
      )}\n-----END CERTIFICATE-----\n`,
    ) === node.nodeKey
      ? undefined
      : new Error('node pin mismatch');
  const base = {
    host: '127.0.0.1',
    port: node.port,
    key: id.key,
    cert: id.cert,
    rejectUnauthorized: false,
    checkServerIdentity: pinned,
    ...tlsOptions,
  };

  function request(method, path, body, { raw } = {}) {
    return new Promise((resolve, reject) => {
      const data =
        raw ??
        (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
      const req = https.request(
        {
          ...base,
          method,
          path,
          agent: false,
          headers: data
            ? {
                'content-type': 'application/json',
                'content-length': data.length,
              }
            : {},
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: text ? JSON.parse(text) : undefined,
              bytes: Buffer.concat(chunks),
            });
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** Runs the ceremony; `operator(code)` returns 'approve' or 'reject'. */
  async function pair(service, endpoints, operator = () => 'approve') {
    const { qr } = service.issue({ endpoints });
    const bootstrap = JSON.parse(
      Buffer.from(qr.slice('hybrid-ai-pair:'.length), 'base64url').toString(
        'utf8',
      ),
    );
    const keys = keySchedule(bootstrap.secret);
    const start = {
      v: 1,
      sessionId: bootstrap.sessionId,
      suite: SUITE,
      deviceSuites: [SUITE],
      deviceNonce: randomBytes(32).toString('base64url'),
      deviceName: name,
      deviceKey: id.nodeKey,
    };
    start.proof = mac(keys.device, transcripts(bootstrap, start, {}).t1);
    const started = await request('POST', '/v1/pairing/start', start);
    if (started.status !== 200) return { started };
    const t = transcripts(bootstrap, start, started.body);
    if (mac(keys.node, t.t2) !== started.body.proof)
      throw new Error('node proof mismatch');
    const code = verificationCode(keys.sas, t.t1h, t.t2h);
    const confirm = {
      v: 1,
      pairingId: started.body.pairingId,
      decision: 'accept',
    };
    confirm.proof = mac(keys.device, {
      ctx: 'hybrid-ai/pair/v1/confirm',
      decision: 'accept',
      t1: t.t1h,
      t2: t.t2h,
    });
    const confirming = request('POST', '/v1/pairing/confirm', confirm);
    let pending;
    for (let i = 0; i < 100 && !pending; i += 1) {
      pending = service
        .pendingList()
        .find(p => p.pairingId === started.body.pairingId);
      if (!pending) await new Promise(r => setTimeout(r, 10));
    }
    service.decide(
      started.body.pairingId,
      pending && pending.code === code ? operator(code) : 'reject',
    );
    const confirmed = await confirming;
    return { started, confirmed, code, nodeCode: pending?.code, bootstrap };
  }

  /** Reads one job's events until the server closes the stream. */
  function events(jobId, afterSequence = 0) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(base, () => {
        const key = randomBytes(16).toString('base64');
        socket.write(
          `GET /v1/jobs/${jobId}/events?afterSequence=${afterSequence} HTTP/1.1\r\nHost: node\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let buffer = Buffer.alloc(0);
      let upgraded = false;
      const out = { status: null, frames: [], events: [], closeCode: null };
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = buffer.subarray(0, end).toString();
          out.status = Number(head.split(' ')[1]);
          buffer = buffer.subarray(end + 4);
          if (out.status !== 101) {
            out.body = buffer.toString();
            socket.end();
            return;
          }
          upgraded = true;
        }
        for (;;) {
          if (buffer.length < 2) return;
          const opcode = buffer[0] & 0x0f;
          const fin = (buffer[0] & 0x80) !== 0;
          const masked = (buffer[1] & 0x80) !== 0;
          let len = buffer[1] & 0x7f;
          let at = 2;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            at = 4;
          } else if (len === 127) {
            reject(new Error('64-bit frame length from the node'));
            return;
          }
          if (buffer.length < at + len) return;
          const payload = buffer.subarray(at, at + len);
          buffer = buffer.subarray(at + len);
          out.frames.push({ opcode, fin, masked, length: len });
          if (opcode === 1)
            out.events.push(JSON.parse(payload.toString('utf8')));
          if (opcode === 8)
            out.closeCode =
              payload.length >= 2 ? payload.readUInt16BE(0) : null;
        }
      });
      socket.on('close', () => resolve(out));
      socket.on('error', reject);
    });
  }

  return { id, request, pair, events, pin: id.nodeKey };
}

export const job = (input, overrides = {}) => ({
  requestId: `org-${randomBytes(6).toString('hex')}`,
  idempotencyKey: randomBytes(16).toString('hex'),
  capability: { id: 'journal.organize', version: '1.0.0' },
  input,
  deadlineMs: 60_000,
  stream: true,
  ...overrides,
});

export { canonical };
