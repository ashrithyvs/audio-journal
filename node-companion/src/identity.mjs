// The node's persistent identity (SDK ADR-022): a 32-hex node ID and a P-256
// key with a self-signed X.509 certificate. The certificate is built by the
// pinned @peculiar/x509 library over Node's WebCrypto; the companion writes
// no DER by hand. The key file is created with mode 0600.

import {
  createHash,
  createPublicKey,
  randomBytes,
  webcrypto,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// @peculiar/x509 resolves its algorithms through tsyringe, which needs the
// Reflect metadata polyfill loaded first.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);

export const b64u = bytes => Buffer.from(bytes).toString('base64url');

/** base64url SHA-256 of a certificate's DER SubjectPublicKeyInfo (43 chars). */
export function spkiPin(certificate) {
  const spki = createPublicKey(certificate).export({
    type: 'spki',
    format: 'der',
  });
  return b64u(createHash('sha256').update(spki).digest());
}

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Loads the identity from `stateDir`, creating it on first use. */
export async function loadIdentity(
  stateDir,
  { name = 'Audio Journal companion' } = {},
) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const nodeFile = join(stateDir, 'node.json');
  const keyFile = join(stateDir, 'node-key.pem');
  const certFile = join(stateDir, 'node-cert.pem');
  if (!existsSync(nodeFile)) {
    const keys = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const now = new Date();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString('hex'),
      name: 'CN=Audio Journal companion',
      notBefore: new Date(now.getTime() - 60_000),
      notAfter: new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      keys,
      extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
    });
    const pkcs8 = Buffer.from(
      await webcrypto.subtle.exportKey('pkcs8', keys.privateKey),
    ).toString('base64');
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8
      .match(/.{1,64}/g)
      .join('\n')}\n-----END PRIVATE KEY-----\n`;
    writePrivate(keyFile, keyPem);
    writeFileSync(certFile, cert.toString('pem'));
    writePrivate(
      nodeFile,
      `${JSON.stringify(
        { nodeId: randomBytes(16).toString('hex'), nodeName: name },
        null,
        2,
      )}\n`,
    );
  }
  const node = JSON.parse(readFileSync(nodeFile, 'utf8'));
  const key = readFileSync(keyFile, 'utf8');
  const cert = readFileSync(certFile, 'utf8');
  return {
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    key,
    cert,
    nodeKey: spkiPin(cert),
    stateDir,
  };
}
