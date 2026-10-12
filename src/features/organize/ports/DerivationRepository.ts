import type { OrganizeInput, OrganizeOutput } from '../domain/contract';

// Derivation storage (docs/journal-organize.md §7, LLD §4). Only results that
// passed contract §6 reach it, in one transaction; derivations and their
// references are immutable, and source entries are never written here.

export type TaskState = 'open' | 'done' | 'dismissed';

export interface DerivedTask {
  id: string;
  ordinal: number;
  text: string;
  area: 'work' | 'personal' | 'unsorted';
  state: TaskState;
  stateChangedAt?: number;
  /** ISO calendar date from the validated result (contract §3.3). */
  dueDate?: string;
  /** The previous revision's task whose state this one carried (ADR-020). */
  predecessorTaskId?: string;
}

export interface StoredDerivation {
  id: string;
  requestKey: string;
  /** The canonical selection identity (ADR-020, `scopeKeyOf`). */
  scopeKey: string;
  /** One higher than the latest derivation over exactly the same entries. */
  revision: number;
  createdAt: number;
  engine: { id: string; version: string };
  /** The scope, in request order. */
  entryIds: string[];
  output: OrganizeOutput;
  tasks: DerivedTask[];
}

export interface ValidatedResult {
  input: OrganizeInput;
  inputSha256: string;
  output: OrganizeOutput;
  createdAt: number;
}

export interface DerivationRepository {
  /**
   * The journal's request-key secret (contract §9), created on first use from
   * 32 random bytes as hex. Kept in the encrypted database, never in backups.
   */
  requestKeySecret(generateHex: () => string): Promise<string>;
  findByRequestKey(requestKey: string): Promise<StoredDerivation | undefined>;
  /**
   * Stores a validated result atomically. When its requestKey is already
   * stored, nothing is written and the stored derivation is returned.
   */
  saveValidated(
    result: ValidatedResult,
  ): Promise<{ derivation: StoredDerivation; duplicate: boolean }>;
  /** The newest derivation whose scope includes the entry. */
  latestForEntry(entryId: string): Promise<StoredDerivation | undefined>;
  /** The newest revision of every scope, newest first (ADR-020). */
  newestPerScope(): Promise<StoredDerivation[]>;
  /** Every revision of one scope, newest first. */
  history(scopeKey: string): Promise<StoredDerivation[]>;
  /** A task transition: done, dismissed, or restored to open. */
  setTaskState(taskId: string, state: TaskState, at: number): Promise<void>;
  /**
   * Benchmark only: performs saveValidated's writes in a transaction that
   * is always rolled back, so the organize performance suite can time
   * persistence without keeping anything.
   */
  rehearseSave?(result: ValidatedResult): Promise<void>;
}
