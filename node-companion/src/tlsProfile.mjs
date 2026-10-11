// The frozen paired-node TLS profile (SDK ADR-022, "TLS version rules"):
// TLS 1.3 wherever the client supports it; for Android API 26-28, TLS 1.2
// only with ECDHE-ECDSA AES-GCM or ChaCha20-Poly1305 suites and Extended
// Master Secret (RFC 7627). Node.js has no option that requires EMS, so, as
// ADR-022 publishes, the node reads the negotiated session's
// SSL_SESS_FLAG_EXTMS flag and refuses a TLS 1.2 session without it. The
// session's ASN.1 is read with the pinned asn1js library.
//
// Clients present a self-signed certificate; it is requested but not CA
// verified. Every protected request is authorized by the client key's pin
// against the pairing table instead.

import { constants } from 'node:crypto';

import * as asn1js from 'asn1js';

import { spkiPin } from './identity.mjs';

export const TLS12_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
].join(':');
export const TLS13_SUITES = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
].join(':');

/** Server options for node:https / node:tls. */
export function serverOptions(identity) {
  return {
    key: identity.key,
    cert: identity.cert,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: TLS12_CIPHERS,
    ciphersuites: TLS13_SUITES,
    ecdhCurve: 'X25519:P-256:P-384',
    honorCipherOrder: true,
    requestCert: true,
    rejectUnauthorized: false,
    // No session resumption: every connection is a full handshake whose
    // EMS state is checked.
    secureOptions: constants.SSL_OP_NO_TICKET,
    sessionTimeout: 1,
  };
}

const SSL_SESS_FLAG_EXTMS = 1n;

/**
 * Whether a serialized OpenSSL SSL_SESSION (tlsSocket.getSession()) records
 * Extended Master Secret: its optional [13] EXPLICIT `flags` integer.
 */
export function sessionHasEms(der) {
  if (!der || der.length === 0) return false;
  const parsed = asn1js.fromBER(new Uint8Array(der));
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence))
    return false;
  for (const item of parsed.result.valueBlock.value) {
    if (item.idBlock.tagClass === 3 && item.idBlock.tagNumber === 13) {
      const inner = item.valueBlock.value?.[0];
      if (!(inner instanceof asn1js.Integer)) return false;
      return (inner.toBigInt() & SSL_SESS_FLAG_EXTMS) === SSL_SESS_FLAG_EXTMS;
    }
  }
  return false;
}

/**
 * Checks one finished handshake against the profile; returns an evidence
 * record. `accepted: false` means the connection must be closed.
 */
export function checkHandshake(socket) {
  const protocol = socket.getProtocol();
  const cipher = socket.getCipher()?.standardName ?? socket.getCipher()?.name;
  let ems = null;
  let accepted = false;
  if (protocol === 'TLSv1.3') {
    accepted = true;
  } else if (protocol === 'TLSv1.2') {
    ems = sessionHasEms(socket.getSession());
    accepted =
      ems &&
      /^TLS_ECDHE_ECDSA_WITH_(AES_128_GCM_SHA256|AES_256_GCM_SHA384|CHACHA20_POLY1305_SHA256)$/.test(
        cipher ?? '',
      );
  }
  const peer = socket.getPeerX509Certificate?.();
  return {
    protocol,
    cipher,
    ems,
    accepted,
    clientPin: peer
      ? spkiPin(peer.publicKey.export({ type: 'spki', format: 'pem' }))
      : null,
  };
}
