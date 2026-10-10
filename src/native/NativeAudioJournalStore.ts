import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// App-owned encrypted journal database (ADR-017): SQLCipher keyed natively
// with the vault's HKDF database key, which never reaches JavaScript.
// Parameters and rows cross as JSON; values are strings, integers, or null.
// Errors reject with a code (STORE_LOCKED, SQL_CONSTRAINT, SQL_ERROR) and a
// message that names the failing constraint or trigger, never bound values.
export interface Spec extends TurboModule {
  /** Opens the journal; requires an unlocked vault. Idempotent. */
  readonly open: () => Promise<void>;
  readonly close: () => Promise<void>;
  /** Returns the number of changed rows. */
  readonly run: (sql: string, paramsJson: string) => Promise<number>;
  /** Returns a JSON array of row objects. */
  readonly all: (sql: string, paramsJson: string) => Promise<string>;
  readonly begin: () => Promise<void>;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
  /** CSPRNG bytes as lower-case hex, for local IDs (not key material). */
  readonly randomBytesHex: (count: number) => string;
}

export default TurboModuleRegistry.get<Spec>('AudioJournalStore');
