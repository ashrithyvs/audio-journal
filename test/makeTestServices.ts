import type { AppServices } from '../src/app/AppServices';
import type { PrivateNodeOptions } from '../src/features/private-node/application/PrivateNodeContext';
import { FakeHybridAiGateway } from './FakeHybridAiGateway';
import { FakeVaultService, type FakeBiometric } from './FakeVaultService';
import { FakeRecordingService } from './journal/FakeRecordingService';
import { openJournal } from './sqlite/journalFixtures';

export function makeTestServices({
  configuredPin,
  biometricResult = 'unavailable',
  hybridAI = new FakeHybridAiGateway(),
  vault = new FakeVaultService(configuredPin, biometricResult),
  privateNode,
}: {
  configuredPin?: string;
  biometricResult?: FakeBiometric;
  hybridAI?: FakeHybridAiGateway;
  vault?: FakeVaultService;
  privateNode?: PrivateNodeOptions;
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
      return {
        services: {
          journal: context.journal,
          transcripts: context.transcripts,
          recorder,
          ids: context.ids,
        },
        close: async () => undefined,
      };
    },
  };
}
