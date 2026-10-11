// The frozen TLS profile (SDK ADR-022) against real handshakes: TLS 1.3;
// TLS 1.2 only with ECDHE-ECDSA AEAD and Extended Master Secret; a TLS 1.2
// session without EMS, or with any other suite, is refused.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { loadIdentity } from '../src/identity.mjs';
import { checkHandshake, serverOptions } from '../src/tlsProfile.mjs';

// OpenSSL's SSL_OP_NO_EXTENDED_MASTER_SECRET (not exported by node:crypto).
const SSL_OP_NO_EXTENDED_MASTER_SECRET = 0x1;

async function server() {
  const node = await loadIdentity(mkdtempSync(join(tmpdir(), 'aj-node-')));
  const seen = [];
  const s = tls.createServer(serverOptions(node), socket => {
    const evidence = checkHandshake(socket);
    seen.push(evidence);
    if (!evidence.accepted) {
      socket.destroy();
      return;
    }
    socket.end('ok');
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { s, seen, port: s.address().port };
}

function connect(port, client, options) {
  return new Promise(resolve => {
    const c = tls.connect({
      host: '127.0.0.1',
      port,
      key: client.key,
      cert: client.cert,
      rejectUnauthorized: false,
      ...options,
    });
    let data = '';
    let error = null;
    c.on('data', d => (data += d));
    c.on('error', e => (error = e.code ?? e.message));
    c.on('close', () => resolve({ data, error }));
  });
}

test('the profile accepts TLS 1.3 and TLS 1.2 with EMS, and refuses the rest', async t => {
  const { s, seen, port } = await server();
  t.after(() => s.close());
  const client = await loadIdentity(mkdtempSync(join(tmpdir(), 'aj-dev-')), {
    name: 'device',
  });

  const v13 = await connect(port, client, {});
  assert.equal(v13.data, 'ok');
  assert.equal(seen.at(-1).protocol, 'TLSv1.3');

  for (const cipher of [
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
  ]) {
    const v12 = await connect(port, client, {
      maxVersion: 'TLSv1.2',
      ciphers: cipher,
    });
    assert.equal(v12.data, 'ok', cipher);
    assert.deepEqual(
      {
        protocol: seen.at(-1).protocol,
        ems: seen.at(-1).ems,
        accepted: seen.at(-1).accepted,
      },
      { protocol: 'TLSv1.2', ems: true, accepted: true },
    );
    assert.ok(seen.at(-1).clientPin);
  }

  const noEms = await connect(port, client, {
    maxVersion: 'TLSv1.2',
    ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256',
    secureOptions: SSL_OP_NO_EXTENDED_MASTER_SECRET,
  });
  assert.equal(noEms.data, '');
  assert.deepEqual(
    {
      protocol: seen.at(-1).protocol,
      ems: seen.at(-1).ems,
      accepted: seen.at(-1).accepted,
    },
    { protocol: 'TLSv1.2', ems: false, accepted: false },
  );

  const handshakesBefore = seen.length;
  const rsaOnly = await connect(port, client, {
    maxVersion: 'TLSv1.2',
    ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:AES128-SHA',
  });
  assert.equal(rsaOnly.data, '');
  assert.ok(rsaOnly.error);
  assert.equal(seen.length, handshakesBefore); // no handshake completed

  const tls11 = await connect(port, client, {
    minVersion: 'TLSv1',
    maxVersion: 'TLSv1.1',
  });
  assert.equal(tls11.data, '');
});
