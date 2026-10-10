import type { Spec } from '../../native/NativeAudioJournalBackup';
import type { RestoreTargetCounts } from '../../features/backup/domain/restoreTarget';
import type {
  Activation,
  BackupEstimate,
  BackupService,
  OpenedArchive,
  PickedArchive,
  PreparedBackup,
  SavedBackup,
  SecretKind,
} from '../../features/backup/ports/BackupService';

const parse = <T>(json: string): T => JSON.parse(json) as T;

/**
 * The native AJB1 codec (ADR-017). Secrets cross the bridge only as the
 * user typed them; derived keys, journal content, and PCM never do.
 */
export class NativeBackupService implements BackupService {
  constructor(
    private readonly native: Spec,
    private readonly random: (count: number) => Uint8Array,
  ) {}

  async estimate() {
    return parse<BackupEstimate>(await this.native.estimateBackup());
  }

  async generateRecoveryKey() {
    return (await this.native.generateRecoveryKey()).split(' ');
  }

  randomBytes(count: number) {
    return this.random(count);
  }

  async prepare(
    kind: SecretKind,
    secret: string,
    excludeEntryIds: readonly string[],
  ) {
    return parse<PreparedBackup>(
      await this.native.prepareBackup(
        kind,
        secret,
        JSON.stringify(excludeEntryIds),
      ),
    );
  }

  async save(suggestedName: string) {
    return parse<SavedBackup>(await this.native.saveBackup(suggestedName));
  }

  cancel() {
    this.native.cancelBackup();
  }

  discard() {
    return this.native.discardBackup();
  }

  async restoreTarget() {
    return parse<RestoreTargetCounts>(await this.native.restoreTarget());
  }

  async pickArchive() {
    return parse<PickedArchive>(await this.native.pickArchive());
  }

  async openArchive(secret: string) {
    return parse<OpenedArchive>(await this.native.openArchive(secret));
  }

  async stage() {
    return parse<Awaited<ReturnType<BackupService['stage']>>>(
      await this.native.stageRestore(),
    );
  }

  async activate(pin: string) {
    return parse<Activation>(await this.native.activateRestore(pin));
  }

  abandon() {
    return this.native.abandonRestore();
  }
}
