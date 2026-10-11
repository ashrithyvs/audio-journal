// Pairing against the SDK's published ADR-022 vectors, read only from the
// SDK repository ($HYBRID_AI_SDK_REPO, default ../../hybridAi). Only the
// node-side cases apply; device-side cases test the SDK, not a node.
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonical } from '../src/json.mjs';
import {
  keySchedule,
  mac,
  nodeConfirm,
  nodeStart,
  NODE_SUITES,
  pairedResponse,
  PairingError,
  parseBody,
  transcripts,
  verificationCode,
} from '../src/pairing.mjs';

const SDK =
  process.env.HYBRID_AI_SDK_REPO ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'hybridAi',
  );
const V = name =>
  JSON.parse(
    readFileSync(join(SDK, 'tests', 'vectors', 'pairing', 'v1', name), 'utf8'),
  );
const b64 = buf => Buffer.from(buf).toString('base64url');

const outcome = fn => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof PairingError) return { ok: false, error: error.code };
    throw error;
  }
};

test('key schedule: RFC 5869 and the pairing schedule', () => {
  const ks = V('key-schedule.json');
  for (const c of ks.rfc5869) {
    const okm = hkdfSync(
      'sha256',
      Buffer.from(c.ikmHex, 'hex'),
      Buffer.from(c.saltHex, 'hex'),
      Buffer.from(c.infoHex, 'hex'),
      c.length,
    );
    assert.equal(Buffer.from(okm).toString('hex'), c.okmHex, c.id);
  }
  for (const c of ks.cases) {
    const keys = keySchedule(c.secret);
    assert.equal(b64(keys.device), c.expect['hybrid-ai/pair/v1/device'], c.id);
    assert.equal(b64(keys.node), c.expect['hybrid-ai/pair/v1/node'], c.id);
    assert.equal(b64(keys.sas), c.expect['hybrid-ai/pair/v1/sas'], c.id);
  }
});

test('canonical JSON for the values a node canonicalizes', () => {
  for (const c of V('canonical.json').cases) {
    if (!c.expect.ok || !('canonical' in c.expect)) continue;
    assert.equal(canonical(c.value), c.expect.canonical, c.id);
  }
});

test('ceremonies: transcripts, proofs, code, and node responses', () => {
  for (const p of V('transcript.json').positive) {
    const keys = keySchedule(p.bootstrap.secret);
    const e = p.expect;
    if (e.keys) assert.equal(b64(keys.device), e.keys.device, p.id);
    const session = { bootstrap: p.bootstrap, consumed: false };
    const { response, pending } = nodeStart(
      session,
      p.startRequest,
      p.tlsClientKey,
      {
        pairingId: p.startResponse.pairingId,
        nodeNonce: p.startResponse.nodeNonce,
        confirmTimeoutMs: p.startResponse.confirmTimeoutMs,
      },
    );
    assert.deepEqual(response, p.startResponse, `${p.id} start response`);
    const t = transcripts(p.bootstrap, p.startRequest, p.startResponse);
    if (e.t1) assert.equal(canonical(t.t1), e.t1, `${p.id} T1`);
    if (e.t1Hash) assert.equal(t.t1h, e.t1Hash, `${p.id} T1 hash`);
    if (e.t2) assert.equal(canonical(t.t2), e.t2, `${p.id} T2`);
    if (e.verificationCode)
      assert.equal(
        verificationCode(keys.sas, t.t1h, t.t2h),
        e.verificationCode,
        `${p.id} code`,
      );
    if (e.deviceProof)
      assert.equal(
        mac(keys.device, t.t1),
        e.deviceProof,
        `${p.id} device proof`,
      );
    if (!p.confirmRequest) continue;
    const decision = nodeConfirm(pending, p.confirmRequest, p.tlsClientKey);
    assert.equal(decision, p.confirmRequest.decision, p.id);
    if (p.confirmResponse?.state === 'paired') {
      assert.deepEqual(
        pairedResponse(pending, p.bootstrap.nodeId),
        p.confirmResponse,
        `${p.id} confirm response`,
      );
    }
  }
});

test('node-side tamper cases fail with the published code', () => {
  const t = V('transcript.json');
  const base = t.positive[0];
  let checked = 0;
  for (const n of t.negative) {
    if (n.verifier === 'node-start') {
      const session = { bootstrap: n.session.bootstrap, consumed: false };
      const got = outcome(() =>
        nodeStart(session, n.request, n.tlsClientKey, {
          pairingId: n.session.pairingId,
          nodeNonce: n.session.nodeNonce,
          confirmTimeoutMs: n.session.confirmTimeoutMs,
        }),
      );
      assert.deepEqual(
        { ok: got.ok, error: got.error },
        { ok: n.expect.ok, error: n.expect.error },
        n.id,
      );
      assert.equal(
        session.consumed,
        n.expect.sessionConsumed,
        `${n.id} consumption`,
      );
      checked += 1;
    } else if (n.verifier === 'node-confirm') {
      const { pending } = nodeStart(
        { bootstrap: n.session.bootstrap, consumed: false },
        base.startRequest,
        base.tlsClientKey,
        {
          pairingId: base.startResponse.pairingId,
          nodeNonce: n.session.nodeNonce,
          confirmTimeoutMs: n.session.confirmTimeoutMs,
        },
      );
      const got = outcome(() =>
        nodeConfirm(pending, n.request, n.tlsClientKey),
      );
      assert.deepEqual(
        { ok: got.ok, error: got.error },
        { ok: n.expect.ok, error: n.expect.error },
        n.id,
      );
      checked += 1;
    }
  }
  assert.equal(checked, 12);
});

test('suite negotiation (node)', () => {
  for (const c of V('negotiation.json').node) {
    const session = {
      bootstrap: { sessionId: 'a'.repeat(32), suites: c.nodeSuites },
      consumed: false,
    };
    const got = outcome(() =>
      nodeStart(
        session,
        {
          sessionId: 'a'.repeat(32),
          deviceSuites: c.deviceSuites,
          suite: c.suite,
          deviceKey: 'x',
        },
        'y',
        {},
      ),
    );
    // Past suite selection the next check is the device key: any error but
    // PAIRING_UNSUPPORTED means negotiation passed.
    const passed = got.ok || got.error !== 'PAIRING_UNSUPPORTED';
    assert.equal(passed, c.expect.ok, c.id);
  }
});

test('session freshness (node): monotonic lifetime and single use', () => {
  for (const c of V('freshness.json').node) {
    const live = c.elapsedMonotonicSeconds < c.lifetimeSeconds;
    const got = outcome(() =>
      nodeStart(
        {
          bootstrap: { sessionId: 'a'.repeat(32), suites: NODE_SUITES },
          consumed: c.consumed,
        },
        {
          sessionId: 'a'.repeat(32),
          deviceSuites: NODE_SUITES,
          suite: NODE_SUITES[0],
          deviceKey: 'x',
        },
        'y',
        {
          live,
        },
      ),
    );
    const ok = got.ok || got.error !== 'PAIRING_SESSION_UNAVAILABLE';
    assert.equal(ok, c.expect.ok, c.id);
  }
});

test('strict wire parsing of start and confirm bodies', () => {
  const w = V('wire.json');
  let checked = 0;
  for (const c of w.cases) {
    const kind = {
      'start-request.schema.json': 'start',
      'confirm-request.schema.json': 'confirm',
    }[c.schema];
    if (!kind) continue;
    const bytes = c.bodyHex
      ? Buffer.from(c.bodyHex, 'hex')
      : Buffer.from(c.body, 'utf8');
    const got = outcome(() => parseBody(bytes, kind));
    assert.equal(got.ok, c.expect.ok, c.id);
    checked += 1;
  }
  assert.ok(checked >= 19);
});
