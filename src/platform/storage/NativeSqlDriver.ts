import NativeAudioJournalStore, {
  type Spec,
} from '../../native/NativeAudioJournalStore';
import { SerialSqlDatabase, type SqlDriver } from './SerialSqlDatabase';
import type { SqlRow } from './SqlDatabase';

// Production driver: the native SQLCipher store. Serialization and
// transactions come from SerialSqlDatabase, as in tests.

export function nativeSqlDriver(store: Spec): SqlDriver {
  return {
    run: async (sql, params) => ({
      changes: await store.run(sql, JSON.stringify(params)),
    }),
    all: async (sql, params) =>
      JSON.parse(await store.all(sql, JSON.stringify(params))) as SqlRow[],
    begin: () => store.begin(),
    commit: () => store.commit(),
    rollback: () => store.rollback(),
    close: () => store.close(),
  };
}

/** Opens the encrypted journal; the vault must already be unlocked. */
export async function openNativeJournalDatabase(
  store: Spec | null | undefined = NativeAudioJournalStore,
): Promise<SerialSqlDatabase> {
  if (!store) {
    throw new Error('STORE_UNAVAILABLE');
  }
  await store.open();
  return new SerialSqlDatabase(nativeSqlDriver(store));
}
