import React, {
  createContext,
  type PropsWithChildren,
  useContext,
} from 'react';

import type { BackupService } from '../ports/BackupService';

// The native backup service (ADR-017). Absent where the codec does not exist
// (iOS until it is built, and most tests); Settings then hides Backup.

const BackupContext = createContext<BackupService | undefined>(undefined);

export function BackupProvider({
  service,
  children,
}: PropsWithChildren<{ service?: BackupService }>) {
  return (
    <BackupContext.Provider value={service}>{children}</BackupContext.Provider>
  );
}

export function useBackup(): BackupService | undefined {
  return useContext(BackupContext);
}
