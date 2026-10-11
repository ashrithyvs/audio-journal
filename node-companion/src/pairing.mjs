// Pairing and trust (SDK ADR-022, LLD §8), written from the published
// specification and checked against the published vectors
// (hybridAi/tests/vectors/pairing/v1, read only). Primitives come from
// node:crypto (OpenSSL): HKDF-SHA-256, HMAC-SHA-256, SHA-256, and constant-time
// comparison. Nothing here is copied from the SDK or its reference node.

import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonical, JsonError, parseStrict } from './json.mjs';

export const SUITE = 'hai-pair-v1-p256-sha256';
export const NODE_SUITES = [SUITE];
const SALT = 'hybrid-ai/pair/v1';
const CTX = {
  start: 'hybrid-ai/pair/v1/start',
  node: 'hybrid-ai/pair/v1/node',
  sas: 'hybrid-ai/pair/v1/sas',
  confirm: 'hybrid-ai/pair/v1/confirm',
  paired: 'hybrid-ai/pair/v1/paired',
};
export const MAX_PAIRINGS = 64;
export const CONFIRM_TIMEOUT_MS = 120_000;
const B64U43 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SUITE_TOKEN = /^[a-z0-9-]{1,40}$/;

const b64u = bytes => Buffer.from(bytes).toString('base64url');
const hash = text => b64u(createHash('sha256').update(text, 'utf8').digest());

export class PairingError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status) => {
  throw new PairingError(code, status);
};

// ------------------------------------------------------------- crypto

export function keySchedule(secret) {
  const ikm = Buffer.from(secret, 'base64url');
  const expand = info =>
    Buffer.from(
      hkdfSync('sha256', ikm, Buffer.from(SALT), Buffer.from(info), 32),
    );
  return {
    device: expand(`${SALT}/device`),
    node: expand(`${SALT}/node`),
    sas: expand(`${SALT}/sas`),
  };
}

export const mac = (key, transcript) =>
  b64u(
    createHmac('sha256', key).update(canonical(transcript), 'utf8').digest(),
  );

function sameMac(expected, given) {
  const a = Buffer.from(expected, 'base64url');
  const b = Buffer.from(typeof given === 'string' ? given : '', 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function transcripts(
  bootstrap,
  start,
  { pairingId, nodeNonce, confirmTimeoutMs },
) {
  const t1 = {
    ctx: CTX.start,
    deviceKey: start.deviceKey,
    deviceName: start.deviceName,
    deviceNonce: start.deviceNonce,
    deviceSuites: start.deviceSuites,
    expiresAt: bootstrap.expiresAt,
    issuedAt: bootstrap.issuedAt,
    nodeId: bootstrap.nodeId,
    nodeKey: bootstrap.nodeKey,
    nodeName: bootstrap.nodeName,
    sessionId: bootstrap.sessionId,
    suite: start.suite,
    suites: bootstrap.suites,
  };
  const t1h = hash(canonical(t1));
  const t2 =
    pairingId === undefined
      ? undefined
      : { ctx: CTX.node, confirmTimeoutMs, nodeNonce, pairingId, t1: t1h };
  const t2h = t2 && hash(canonical(t2));
  return { t1, t1h, t2, t2h };
}

/** Six-digit code: uint64_be(HMAC(K_sas, T3)[0..8]) mod 10^6. */
export function verificationCode(sasKey, t1h, t2h) {
  const digest = createHmac('sha256', sasKey)
    .update(canonical({ ctx: CTX.sas, t1: t1h, t2: t2h }), 'utf8')
    .digest();
  return String(digest.readBigUInt64BE(0) % 1_000_000n).padStart(6, '0');
}

// ------------------------------------------------------------- wire

/** Strict pairing body: at most 4096 bytes, depth 4, published shape. */
export function parseBody(bytes, kind) {
  if (bytes.length > 4096) fail('SCHEMA_VALIDATION_FAILED', 400);
  let body;
  try {
    body = parseStrict(bytes, { maxDepth: 4, integersOnly: true });
  } catch (error) {
    if (error instanceof JsonError) fail('SCHEMA_VALIDATION_FAILED', 400);
    throw error;
  }
  const keys =
    body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body)
      : null;
  const exact = list =>
    keys && keys.length === list.length && list.every(k => keys.includes(k));
  const ok =
    kind === 'start'
      ? exact([
          'v',
          'sessionId',
          'suite',
          'deviceSuites',
          'deviceNonce',
          'deviceName',
          'deviceKey',
          'proof',
        ]) &&
        body.v === 1 &&
        typeof body.sessionId === 'string' &&
        HEX32.test(body.sessionId) &&
        typeof body.suite === 'string' &&
        SUITE_TOKEN.test(body.suite) &&
        Array.isArray(body.deviceSuites) &&
        body.deviceSuites.length >= 1 &&
        body.deviceSuites.length <= 4 &&
        new Set(body.deviceSuites).size === body.deviceSuites.length &&
        body.deviceSuites.every(
          s => typeof s === 'string' && SUITE_TOKEN.test(s),
        ) &&
        typeof body.deviceNonce === 'string' &&
        B64U43.test(body.deviceNonce) &&
        typeof body.deviceName === 'string' &&
        body.deviceName.isWellFormed() &&
        [...body.deviceName].length >= 1 &&
        [...body.deviceName].length <= 64 &&
        !/[\u0000-\u001f\u007f]/.test(body.deviceName) &&
        typeof body.deviceKey === 'string' &&
        B64U43.test(body.deviceKey) &&
        typeof body.proof === 'string' &&
        B64U43.test(body.proof)
      : exact(['v', 'pairingId', 'decision', 'proof']) &&
        body.v === 1 &&
        typeof body.pairingId === 'string' &&
        HEX32.test(body.pairingId) &&
        (body.decision === 'accept' || body.decision === 'reject') &&
        typeof body.proof === 'string' &&
        B64U43.test(body.proof);
  if (!ok) fail('SCHEMA_VALIDATION_FAILED', 400);
  return body;
}

// ------------------------------------------------------------- node checks

/**
 * The node's /v1/pairing/start checks in their published order. Mutates
 * `session.consumed` exactly as the node must. Returns the response body.
 */
export function nodeStart(
  session,
  request,
  tlsClientKey,
  { pairingId, nodeNonce, confirmTimeoutMs, live = true },
) {
  if (
    !session ||
    !live ||
    session.consumed ||
    request.sessionId !== session.bootstrap.sessionId
  ) {
    fail('PAIRING_SESSION_UNAVAILABLE', 404);
  }
  session.consumed = true;
  // The first suite this session advertised that the device supports must be
  // the one it chose, and one this node implements (no downgrade).
  const selected = session.bootstrap.suites.find(s =>
    request.deviceSuites.includes(s),
  );
  if (
    !selected ||
    request.suite !== selected ||
    !NODE_SUITES.includes(selected)
  )
    fail('PAIRING_UNSUPPORTED', 400);
  if (request.deviceKey !== tlsClientKey) fail('PAIRING_PROOF_INVALID', 401);
  const keys = keySchedule(session.bootstrap.secret);
  const { t1, t1h, t2, t2h } = transcripts(session.bootstrap, request, {
    pairingId,
    nodeNonce,
    confirmTimeoutMs,
  });
  if (!sameMac(mac(keys.device, t1), request.proof))
    fail('PAIRING_PROOF_INVALID', 401);
  return {
    response: {
      v: 1,
      pairingId,
      nodeNonce,
      confirmTimeoutMs,
      state: 'confirmation_required',
      proof: mac(keys.node, t2),
    },
    pending: {
      pairingId,
      deviceKey: request.deviceKey,
      deviceName: request.deviceName,
      keys,
      t1h,
      t2h,
      code: verificationCode(keys.sas, t1h, t2h),
    },
  };
}

/** The node's /v1/pairing/confirm checks; returns the device's decision. */
export function nodeConfirm(pending, request, tlsClientKey) {
  if (!pending || request.pairingId !== pending.pairingId)
    fail('PAIRING_SESSION_UNAVAILABLE', 404);
  if (tlsClientKey !== pending.deviceKey) fail('PAIRING_PROOF_INVALID', 401);
  const t4 = {
    ctx: CTX.confirm,
    decision: request.decision,
    t1: pending.t1h,
    t2: pending.t2h,
  };
  if (!sameMac(mac(pending.keys.device, t4), request.proof))
    fail('PAIRING_PROOF_INVALID', 401);
  return request.decision;
}

export function pairedResponse(pending, nodeId) {
  const t5 = {
    ctx: CTX.paired,
    nodeId,
    pairingId: pending.pairingId,
    state: 'paired',
    t1: pending.t1h,
    t2: pending.t2h,
  };
  return {
    v: 1,
    pairingId: pending.pairingId,
    nodeId,
    state: 'paired',
    proof: mac(pending.keys.node, t5),
  };
}

// ------------------------------------------------------------- service

/**
 * One active QR session, pending confirmations, and the persisted pairing
 * table (mode 0600). Operators decide through `decide`.
 */
export class PairingService {
  constructor(
    identity,
    { now = () => Date.now(), monotonic = () => performance.now() } = {},
  ) {
    this.identity = identity;
    this.now = now;
    this.monotonic = monotonic;
    this.file = join(identity.stateDir, 'pairings.json');
    this.pairings = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : [];
    this.session = null;
    this.pending = new Map();
    this.onRevoke = () => {};
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.pairings, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, this.file);
  }

  /** Issues a QR session, replacing any earlier one. */
  issue({ endpoints, lifetimeSeconds = 120 }) {
    if (!(lifetimeSeconds >= 1 && lifetimeSeconds <= 300))
      throw new Error('lifetime must be 1..300 s');
    const issuedAt = Math.floor(this.now() / 1000);
    const bootstrap = {
      v: 1,
      nodeId: this.identity.nodeId,
      nodeName: this.identity.nodeName,
      nodeKey: this.identity.nodeKey,
      endpoints,
      sessionId: randomBytes(16).toString('hex'),
      secret: b64u(randomBytes(32)),
      issuedAt,
      expiresAt: issuedAt + lifetimeSeconds,
      suites: NODE_SUITES,
    };
    this.session = {
      bootstrap,
      issuedMono: this.monotonic(),
      lifetimeMs: lifetimeSeconds * 1000,
      consumed: false,
    };
    const qr = `hybrid-ai-pair:${b64u(
      Buffer.from(canonical(bootstrap), 'utf8'),
    )}`;
    if (qr.length > 1024)
      throw new Error('QR text over 1024 characters; use fewer endpoints');
    return { qr, expiresAt: bootstrap.expiresAt };
  }

  live() {
    return (
      !!this.session &&
      this.monotonic() - this.session.issuedMono < this.session.lifetimeMs
    );
  }

  authorize(pin) {
    return this.pairings.find(p => p.deviceKey === pin) ?? null;
  }

  start(request, tlsClientKey) {
    if (this.authorize(tlsClientKey)) fail('ROTATION_CONFLICT', 409);
    if (this.pairings.length >= MAX_PAIRINGS) fail('NODE_UNAVAILABLE', 503);
    const { response, pending } = nodeStart(
      this.session,
      request,
      tlsClientKey,
      {
        pairingId: randomBytes(16).toString('hex'),
        nodeNonce: b64u(randomBytes(32)),
        confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
        live: this.live(),
      },
    );
    this.pending.set(pending.pairingId, {
      ...pending,
      decision: null,
      waiters: [],
      deadline: this.monotonic() + CONFIRM_TIMEOUT_MS,
    });
    return response;
  }

  /** Long-polls the operator's decision; resolves to the response body. */
  confirm(request, tlsClientKey) {
    const pending = this.pending.get(request.pairingId);
    const decision = nodeConfirm(pending, request, tlsClientKey);
    if (decision === 'reject') {
      this.pending.delete(pending.pairingId);
      return Promise.resolve({
        v: 1,
        pairingId: pending.pairingId,
        nodeId: this.identity.nodeId,
        state: 'rejected',
      });
    }
    if (pending.decision) return Promise.resolve(this.answer(pending));
    return new Promise((resolve, reject) => {
      const wait = Math.max(0, pending.deadline - this.monotonic());
      const timer = setTimeout(() => {
        pending.waiters = pending.waiters.filter(w => w !== waiter);
        reject(new PairingError('PAIRING_CONFIRMATION_TIMEOUT', 408));
      }, wait);
      const waiter = () => {
        clearTimeout(timer);
        resolve(this.answer(pending));
      };
      pending.waiters.push(waiter);
    });
  }

  answer(pending) {
    if (pending.decision === 'reject') {
      return {
        v: 1,
        pairingId: pending.pairingId,
        nodeId: this.identity.nodeId,
        state: 'rejected',
      };
    }
    return pairedResponse(pending, this.identity.nodeId);
  }

  /** The operator's decision for a pending pairing, after comparing codes. */
  decide(pairingId, decision) {
    const pending = this.pending.get(pairingId);
    if (!pending || pending.decision) return false;
    pending.decision = decision === 'approve' ? 'approve' : 'reject';
    if (pending.decision === 'approve') {
      this.pairings.push({
        pairingId,
        deviceKey: pending.deviceKey,
        deviceName: pending.deviceName,
        pairedAt: Math.floor(this.now() / 1000),
      });
      this.save();
    }
    for (const waiter of pending.waiters.splice(0)) waiter();
    return true;
  }

  pendingList() {
    return [...this.pending.values()]
      .filter(p => !p.decision && p.deadline > this.monotonic())
      .map(p => ({
        pairingId: p.pairingId,
        deviceName: p.deviceName,
        code: p.code,
      }));
  }

  revoke(pairingId) {
    const record = this.pairings.find(p => p.pairingId === pairingId);
    if (!record) return null;
    this.pairings = this.pairings.filter(p => p !== record);
    this.save();
    this.onRevoke(record);
    return record;
  }
}
