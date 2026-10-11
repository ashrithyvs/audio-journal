import { createHash, createHmac, randomBytes } from 'node:crypto';

import type { OrganizeCrypto } from '../src/features/organize/domain/request';

// Test digests with Node's crypto; the app uses the platform's (native store).

export const testOrganizeCrypto: OrganizeCrypto = {
  sha256Hex: text => createHash('sha256').update(text, 'utf8').digest('hex'),
  hmacSha256Hex: (keyHex, label, text) =>
    createHmac('sha256', Buffer.from(keyHex, 'hex'))
      .update(
        Buffer.concat([
          Buffer.from(label, 'utf8'),
          Buffer.from([0]),
          Buffer.from(text, 'utf8'),
        ]),
      )
      .digest('hex'),
};

export const testRandomHex = (count: number) =>
  randomBytes(count).toString('hex');
