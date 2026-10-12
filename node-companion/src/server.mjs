// The companion's HTTPS/WSS node endpoint (SDK ADR-021, ADR-022) and its
// loopback operator API. Interoperability choices the SDK documents do not
// fix are standard HTTP/1.1 practice: 201 for a new job and 200 for an
// idempotent replay, an explicit Content-Length on every response (never
// chunked), and RFC 6455 framing.

import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import { INPUT_CAP, SCHEMAS } from './contract.mjs';
import { JobStore, WireError } from './jobs.mjs';
import { canonical, JsonError, parseStrict } from './json.mjs';
import { PairingError, PairingService, parseBody } from './pairing.mjs';
import { checkHandshake, serverOptions } from './tlsProfile.mjs';
import { accept } from './ws.mjs';

const MAX_BODY = 65_536;
const JOB_PATH = /^\/v1\/jobs\/([a-f0-9]{32})$/;
const EVENTS_PATH = /^\/v1\/jobs\/([a-f0-9]{32})\/events$/;

export const DESCRIPTOR = {
  id: 'journal.organize',
  version: '1.0.0',
  inputSchema: SCHEMAS.input,
  outputSchema: SCHEMAS.output,
  streaming: true,
  maximumInputBytes: INPUT_CAP,
  preferred: 'node',
};
const REVISION = `aj-organize-1.0.0-${createHash('sha256')
  .update(canonical(DESCRIPTOR))
  .digest('hex')
  .slice(0, 16)}`;

function send(res, status, body) {
  const text = body === undefined ? '' : canonical(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text, 'utf8'),
    'cache-control': 'no-store',
  });
  res.end(text);
}
const error = (res, status, code, message) =>
  send(res, status, { code, message: message || code });

/**
 * Reads a body up to `limit` bytes. A larger body is drained (up to 1 MiB,
 * then the connection is dropped) and answered 413, so the client gets a
 * response rather than a reset.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1_048_576) req.destroy();
      else if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () =>
      size > limit
        ? reject(
            new WireError(413, 'SCHEMA_VALIDATION_FAILED', 'Body too large'),
          )
        : resolve(Buffer.concat(chunks)),
    );
    req.on('error', reject);
  });
}

/** A small token bucket for unauthenticated pairing calls, per address. */
function rateLimiter({ perMinute = 20 } = {}) {
  const buckets = new Map();
  return address => {
    const now = Date.now();
    const b = buckets.get(address) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(
      perMinute,
      b.tokens + ((now - b.at) / 60_000) * perMinute,
    );
    b.at = now;
    buckets.set(address, b);
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / perMinute) * 60_000);
    b.tokens -= 1;
    return 0;
  };
}

/**
 * Starts the node. Returns {port, adminPort, adminToken, close, pairing,
 * jobs, handshakes}.
 */
export async function startCompanion(
  identity,
  {
    host = '0.0.0.0',
    port = 0,
    adminPort = 0,
    endpoints,
    stageDelayMs = 0,
    padResults = false,
    log = () => {},
  } = {},
) {
  const pairing = new PairingService(identity);
  const jobs = new JobStore({ stageDelayMs, padResults, log });
  pairing.onRevoke = record => jobs.revokePairing(record.pairingId);
  const handshakes = [];
  const limited = rateLimiter();

  const server = createHttpsServer(serverOptions(identity));
  // Bytes on the wire (TLS records included), for performance runs.
  const wire = { read: 0, written: 0, live: new Set() };
  server.on('connection', raw => {
    wire.live.add(raw);
    raw.once('close', () => {
      wire.live.delete(raw);
      wire.read += raw.bytesRead;
      wire.written += raw.bytesWritten;
    });
  });
  server.on('secureConnection', socket => {
    const evidence = checkHandshake(socket);
    socket.ajHandshake = evidence;
    handshakes.push({ at: new Date().toISOString(), ...evidence });
    if (handshakes.length > 200) handshakes.shift();
    log({
      event: 'handshake',
      protocol: evidence.protocol,
      cipher: evidence.cipher,
      ems: evidence.ems,
      accepted: evidence.accepted,
    });
    if (!evidence.accepted) socket.destroy();
  });

  const authorized = socket => {
    const h = socket.ajHandshake;
    return h?.accepted && h.clientPin ? pairing.authorize(h.clientPin) : null;
  };

  server.on('request', async (req, res) => {
    const h = req.socket.ajHandshake;
    if (!h?.accepted) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'https://node');
    const path = url.pathname;
    try {
      if (path === '/v1/pairing/start' && req.method === 'POST') {
        const wait = limited(req.socket.remoteAddress);
        if (wait)
          return send(res, 429, {
            code: 'RATE_LIMITED',
            message: 'Too many pairing attempts',
            retryAfterMs: wait,
          });
        if (!h.clientPin)
          return error(
            res,
            401,
            'PAIRING_PROOF_INVALID',
            'A client certificate is required',
          );
        const body = parseBody(await readBody(req, 4096), 'start');
        return send(res, 200, pairing.start(body, h.clientPin));
      }
      if (path === '/v1/pairing/confirm' && req.method === 'POST') {
        const wait = limited(req.socket.remoteAddress);
        if (wait)
          return send(res, 429, {
            code: 'RATE_LIMITED',
            message: 'Too many pairing attempts',
            retryAfterMs: wait,
          });
        if (!h.clientPin)
          return error(
            res,
            401,
            'PAIRING_PROOF_INVALID',
            'A client certificate is required',
          );
        const body = parseBody(await readBody(req, 4096), 'confirm');
        return send(res, 200, await pairing.confirm(body, h.clientPin));
      }
      const record = authorized(req.socket);
      if (!record)
        return error(
          res,
          403,
          'DEVICE_NOT_PAIRED',
          'This device is not paired',
        );
      if (path === '/v1/info' && req.method === 'GET') {
        return send(res, 200, {
          nodeId: identity.nodeId,
          protocolVersion: '1.0',
          supportedVersions: ['1.0'],
          health: 'ok',
        });
      }
      if (path === '/v1/capabilities' && req.method === 'GET') {
        return send(res, 200, {
          revision: REVISION,
          capabilities: [DESCRIPTOR],
        });
      }
      if (path === '/v1/pairing/node-key' && req.method === 'GET') {
        return send(res, 200, {
          v: 1,
          nodeId: identity.nodeId,
          current: identity.nodeKey,
        });
      }
      if (path === '/v1/pairing/self' && req.method === 'DELETE') {
        pairing.revoke(record.pairingId);
        send(res, 200, { v: 1, pairingId: record.pairingId, state: 'revoked' });
        return;
      }
      if (path === '/v1/jobs' && req.method === 'POST') {
        let body;
        try {
          body = parseStrict(await readBody(req, MAX_BODY));
        } catch (e) {
          if (e instanceof JsonError)
            throw new WireError(
              400,
              'SCHEMA_VALIDATION_FAILED',
              'Malformed JSON',
            );
          throw e;
        }
        const { status, body: out } = jobs.submit(record.pairingId, body);
        return send(res, status, out);
      }
      const job = JOB_PATH.exec(path);
      if (job && req.method === 'GET')
        return send(res, 200, jobs.status(record.pairingId, job[1]));
      if (job && req.method === 'DELETE') {
        // Counts only (contract §10): evidence that a device's cancellation
        // reached the companion (SDK-AJ-5 closing tests).
        log({ event: 'job-cancel-request' });
        return send(res, 200, jobs.cancel(record.pairingId, job[1]));
      }
      return error(res, 404, 'NODE_UNAVAILABLE', 'No such resource');
    } catch (e) {
      if (e instanceof WireError || e instanceof PairingError)
        return error(res, e.status, e.code, e.message);
      log({ event: 'internal-error' });
      return error(res, 500, 'EXECUTION_FAILED', 'Internal error');
    }
  });

  server.on('upgrade', (req, socket) => {
    const h = socket.ajHandshake;
    const fail = (status, code) => {
      const body = canonical({ code, message: code });
      socket.end(
        `HTTP/1.1 ${status} Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(
          body,
        )}\r\nConnection: close\r\n\r\n${body}`,
      );
    };
    if (!h?.accepted) return socket.destroy();
    const record = authorized(socket);
    if (!record) return fail(403, 'DEVICE_NOT_PAIRED');
    const url = new URL(req.url, 'https://node');
    const m = EVENTS_PATH.exec(url.pathname);
    const after = url.searchParams.has('afterSequence')
      ? Number(url.searchParams.get('afterSequence'))
      : 0;
    if (!m || !Number.isInteger(after) || after < 0 || after > 64)
      return fail(404, 'NODE_UNAVAILABLE');
    try {
      jobs.find(record.pairingId, m[1]);
    } catch (e) {
      return fail(e.status ?? 404, e.code ?? 'JOB_NOT_RETAINED');
    }
    const conn = accept(req, socket);
    if (conn) jobs.subscribe(record.pairingId, m[1], after, conn);
  });

  await new Promise(resolve => server.listen(port, host, resolve));
  const bound = server.address().port;
  const qrEndpoints = endpoints ?? [{ host: '127.0.0.1', port: bound }];

  // Operator API: loopback only, bearer token.
  const adminToken = randomBytes(24).toString('base64url');
  const admin = createHttpServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${adminToken}`)
      return error(res, 401, 'UNAUTHORIZED');
    const url = new URL(req.url, 'http://admin');
    try {
      if (url.pathname === '/admin/bootstrap' && req.method === 'POST') {
        const body = parseStrict(
          (await readBody(req, 4096)).toString() || '{}',
        );
        return send(
          res,
          200,
          pairing.issue({
            endpoints: body.endpoints ?? qrEndpoints,
            lifetimeSeconds: body.lifetimeSeconds ?? 120,
          }),
        );
      }
      if (url.pathname === '/admin/pending' && req.method === 'GET')
        return send(res, 200, { pending: pairing.pendingList() });
      if (url.pathname === '/admin/decision' && req.method === 'POST') {
        const body = parseStrict(await readBody(req, 4096));
        return send(res, 200, {
          ok: pairing.decide(body.pairingId, body.decision),
        });
      }
      if (url.pathname === '/admin/pairings' && req.method === 'GET') {
        return send(res, 200, {
          pairings: pairing.pairings.map(
            ({ pairingId, deviceName, pairedAt }) => ({
              pairingId,
              deviceName,
              pairedAt,
            }),
          ),
        });
      }
      const revoke = /^\/admin\/pairings\/([0-9a-f]{32})$/.exec(url.pathname);
      if (revoke && req.method === 'DELETE')
        return send(res, 200, { revoked: !!pairing.revoke(revoke[1]) });
      if (url.pathname === '/admin/handshakes' && req.method === 'GET')
        return send(res, 200, { handshakes });
      if (url.pathname === '/admin/stats' && req.method === 'GET') {
        return send(res, 200, {
          jobs: jobs.jobs.size,
          idempotency: jobs.idempotency.size,
          replays: jobs.replays.size,
          pairings: pairing.pairings.length,
          // Process and wire counters for performance runs (counts only).
          process: (() => {
            const cpu = process.cpuUsage();
            return {
              cpuUserMs: Math.round(cpu.user / 1000),
              cpuSystemMs: Math.round(cpu.system / 1000),
              rssBytes: process.memoryUsage().rss,
              maxRssKb: process.resourceUsage().maxRSS,
            };
          })(),
          wire: {
            bytesRead:
              wire.read +
              [...wire.live].reduce((n, socket) => n + socket.bytesRead, 0),
            bytesWritten:
              wire.written +
              [...wire.live].reduce((n, socket) => n + socket.bytesWritten, 0),
          },
        });
      }
      return error(res, 404, 'NOT_FOUND');
    } catch (e) {
      return error(res, 400, 'BAD_REQUEST', e.message);
    }
  });
  await new Promise(resolve => admin.listen(adminPort, '127.0.0.1', resolve));

  return {
    port: bound,
    adminPort: admin.address().port,
    adminToken,
    pairing,
    jobs,
    handshakes,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => admin.close(() => resolve()));
      }),
  };
}
