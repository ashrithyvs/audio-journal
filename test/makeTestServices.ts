import type { AppServices } from '../src/app/AppServices';
import type { PlaybackService } from '../src/features/journal/ports/PlaybackService';
import type { PrivateNodeOptions } from '../src/features/private-node/application/PrivateNodeContext';
import { SqliteDerivationRepository } from '../src/platform/storage/SqliteDerivationRepository';
import { FakeHybridAiGateway } from './FakeHybridAiGateway';
import { FakeVaultService, type FakeBiometric } from './FakeVaultService';
import { FakeRecordingService } from './journal/FakeRecordingService';
import { testOrganizeCrypto, testRandomHex } from './organizeCrypto';
import { openJournal } from './sqlite/journalFixtures';

export type TestJournal = Awaited<ReturnType<typeof openJournal>>;

export function makeTestServices({
  configuredPin,
  biometricResult = 'unavailable',
  hybridAI = new FakeHybridAiGateway(),
  vault = new FakeVaultService(configuredPin, biometricResult),
  privateNode,
  onJournal,
  playback,
  now,
}: {
  configuredPin?: string;
  biometricResult?: FakeBiometric;
  hybridAI?: FakeHybridAiGateway;
  vault?: FakeVaultService;
  privateNode?: PrivateNodeOptions;
  /** Lets a test inspect or seed the journal before the app shows it. */
  onJournal?: (journal: TestJournal) => void | Promise<void>;
  playback?: PlaybackService;
  /** The journal's clock (task grouping, transitions); Date.now by default. */
  now?: () => number;
} = {}): AppServices {
  // One in-memory journal per test app: it survives lock and unlock, as the
  // encrypted database does on a device. Closing on lock is a no-op here.
  let journal: ReturnType<typeof openJournal> | undefined;
  const recorder = new FakeRecordingService();
  return {
    appLock: { vault },
    hybridAI,
    privateNode: { pollIntervalMs: 0, ...privateNode },
    openJournal: async () => {
      journal ??= openJournal();
      const context = await journal;
      await onJournal?.(context);
      return {
        services: {
          journal: context.journal,
          transcripts: context.transcripts,
          recorder,
          playback,
          ids: context.ids,
          now,
        },
        organize: {
          derivations: new SqliteDerivationRepository(context.db, context.ids),
          crypto: testOrganizeCrypto,
          randomHex: testRandomHex,
        },
        close: async () => undefined,
      };
    },
  };
}
