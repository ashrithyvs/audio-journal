import type { RestoreTargetCounts } from '../../src/features/backup/domain/restoreTarget';
import type {
  Activation,
  BackupEstimate,
  BackupService,
  OpenedArchive,
  PickedArchive,
  PreparedBackup,
  SavedBackup,
  SecretKind,
} from '../../src/features/backup/ports/BackupService';

/** Scriptable native backup codec; it holds no journal content. */
export class FakeBackupService implements BackupService {
  calls: string[] = [];
  estimateResult: BackupEstimate = {
    status: 'ready',
    entries: 2,
    recordings: 1,
    segments: 3,
    pcmBytes: 64_000,
    archiveBytes: 70_000,
    freeBytes: 1e9,
  };
  /** Results for successive prepare() calls; the last one repeats. */
  prepareResults: PreparedBackup[] = [
    { status: 'ready', bytes: 70_000, excluded: 0, entries: 2, recordings: 1 },
  ];
  saveResult: SavedBackup = {
    status: 'complete',
    bytes: 70_000,
    name: 'AudioJournal.ajbackup',
  };
  /** Runs while the system picker would be open. */
  duringPicker?: () => Promise<void>;
  words = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);
  /** Challenge positions 5, 11, 20 (0-based) from the "CSPRNG". */
  randomBytes = (count: number) =>
    Uint8Array.from({ length: count }, (_, i) => [5, 11, 20][i % 3]);
  target: RestoreTargetCounts = {
    readyEntries: 0,
    needsAttentionEntries: 0,
    playableRecordings: 0,
    hiddenRows: 0,
    leftoverFiles: 0,
  };
  picked: PickedArchive = {
    status: 'picked',
    bytes: 70_000,
    secretKind: 'password',
    name: 'AudioJournal.ajbackup',
  };
  openResults: OpenedArchive[] = [
    {
      status: 'opened',
      createdAtMs: 1_760_000_000_000,
      entries: 4,
      recordings: 2,
      segments: 9,
      pcmBytes: 2_000_000,
      requiredBytes: 600_000_000,
    },
  ];
  activations: Activation[] = [{ result: 'activated' }];
  secrets: string[] = [];

  private next<T>(queue: T[]): T {
    return queue.length > 1 ? queue.shift()! : queue[0];
  }

  async estimate() {
    this.calls.push('estimate');
    return this.estimateResult;
  }

  async generateRecoveryKey() {
    this.calls.push('generateRecoveryKey');
    return this.words;
  }

  async prepare(kind: SecretKind, secret: string, exclude: readonly string[]) {
    this.calls.push(`prepare ${kind} [${exclude.join(',')}]`);
    this.secrets.push(secret);
    return this.next(this.prepareResults);
  }

  async save(name: string) {
    this.calls.push(`save ${name}`);
    await this.duringPicker?.();
    return this.saveResult;
  }

  cancel() {
    this.calls.push('cancel');
  }

  async discard() {
    this.calls.push('discard');
  }

  async restoreTarget() {
    this.calls.push('restoreTarget');
    return this.target;
  }

  async pickArchive() {
    this.calls.push('pickArchive');
    await this.duringPicker?.();
    return this.picked;
  }

  async openArchive(secret: string) {
    this.calls.push('openArchive');
    this.secrets.push(secret);
    return this.next(this.openResults);
  }

  async stage() {
    this.calls.push('stage');
    return { status: 'staged' as const };
  }

  async activate(pin: string) {
    this.calls.push(`activate ${pin.length}`);
    return this.next(this.activations);
  }

  async abandon() {
    this.calls.push('abandon');
  }
}
