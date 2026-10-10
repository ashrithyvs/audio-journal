// AJB1 recovery key (§9.7): 256 random bits shown as 24 words from the BIP-39
// English wordlist (MIT), with the BIP-39 checksum (first 8 bits of
// SHA-256(entropy)). Only the encoding is BIP-39: the KDF input is the raw
// 32-byte entropy, never a BIP-39 PBKDF2 seed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const WORDLIST_ID = 'bip39-english';
export const WORDLIST_SHA256 =
  '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';
export const RECOVERY_KEY_WORDS = 24;
export const RECOVERY_KEY_BYTES = 32;

const file = readFileSync(
  new URL('../wordlists/bip39-english.txt', import.meta.url),
);
if (createHash('sha256').update(file).digest('hex') !== WORDLIST_SHA256) {
  throw new Error('BIP-39 wordlist does not match its pinned SHA-256');
}
export const WORDS = file.toString('ascii').trimEnd().split('\n');
const INDEX = new Map(WORDS.map((word, index) => [word, index]));

function bitsOf(entropy) {
  const checksum = createHash('sha256').update(entropy).digest()[0];
  const bytes = Buffer.concat([entropy, Buffer.from([checksum])]);
  return [...bytes].map(byte => byte.toString(2).padStart(8, '0')).join('');
}

/** Canonical form: lower-case words joined by single ASCII spaces. */
export function encodeRecoveryKey(entropy) {
  if (entropy.length !== RECOVERY_KEY_BYTES) {
    throw new RangeError('a recovery key is 32 bytes of entropy');
  }
  const bits = bitsOf(entropy);
  const words = [];
  for (let index = 0; index < RECOVERY_KEY_WORDS; index += 1) {
    words.push(WORDS[parseInt(bits.slice(index * 11, index * 11 + 11), 2)]);
  }
  return words.join(' ');
}

/**
 * Accepts any surrounding whitespace, runs of whitespace between words, and
 * upper-case ASCII letters; everything else must be exact. Returns the
 * entropy or a typed reason (never echoing the input).
 */
export function decodeRecoveryKey(text) {
  const tokens = text
    .trim()
    .replace(/[A-Z]/g, letter => letter.toLowerCase())
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length !== RECOVERY_KEY_WORDS) {
    return { ok: false, reason: 'WORD_COUNT' };
  }
  let bits = '';
  for (const [position, token] of tokens.entries()) {
    const index = INDEX.get(token);
    if (index === undefined) {
      return { ok: false, reason: 'UNKNOWN_WORD', position };
    }
    bits += index.toString(2).padStart(11, '0');
  }
  const entropy = Buffer.alloc(RECOVERY_KEY_BYTES);
  for (let index = 0; index < RECOVERY_KEY_BYTES; index += 1) {
    entropy[index] = parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const checksum = createHash('sha256').update(entropy).digest()[0];
  if (parseInt(bits.slice(256), 2) !== checksum) {
    return { ok: false, reason: 'CHECKSUM' };
  }
  return { ok: true, entropy };
}

/** Password KDF input: NFC-normalized UTF-8 (§9.7). */
export function passwordBytes(password) {
  const normalized = password.normalize('NFC');
  const codePoints = [...normalized].length;
  const bytes = Buffer.from(normalized, 'utf8');
  if (codePoints < 12) {
    return { ok: false, reason: 'WEAK_PASSWORD' };
  }
  if (bytes.length > 1024) {
    return { ok: false, reason: 'TOO_LONG' };
  }
  return { ok: true, bytes };
}
