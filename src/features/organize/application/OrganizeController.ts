import type {
  CapabilityUpdate,
  HybridAiGateway,
} from '../../../platform/hybrid-ai/HybridAiGateway';
import type { JournalEntryDetail } from '../../journal/ports/JournalRepository';
import {
  CAPABILITY,
  KINDS,
  ORGANIZE_TIMEOUT_MS,
  partialOk,
  resultViolation,
  type OrganizeInput,
  type OrganizeKind,
  type ResultCode,
} from '../domain/contract';
import {
  buildOrganizeRequest,
  type Exclusion,
  type OrganizeCrypto,
  type RefusalReason,
} from '../domain/request';
import type {
  DerivationRepository,
  StoredDerivation,
} from '../ports/DerivationRepository';

// One journal.organize@1 run (docs/journal-organize.md §4–§7): build the
// request, ask consent, stream it through the public SDK port with execution
// 'node', validate the terminal result, and store it atomically. Any failure,
// cancellation, or invalid result stores nothing and changes no source.

const STAGES = new Set(['received', 'segmenting', 'extracting', 'checking']);

export type OrganizeOutcome =
  | { kind: 'stored'; derivation: StoredDerivation }
  | { kind: 'duplicate'; derivation: StoredDerivation }
  /** INVALID_RESULT with its local diagnostic sub-code (§6). */
  | { kind: 'invalid'; subCode: ResultCode }
  /** A public SDK code, or STORAGE_FAILED when the save itself failed. */
  | { kind: 'failed'; code: string }
  | { kind: 'cancelled' };

export interface PreparedRequest {
  included: string[];
  excluded: Exclusion[];
  units: number;
  bytes: number;
  kinds: OrganizeKind[];
}

export type OrganizeSnapshot =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | {
      phase: 'refused';
      reason: RefusalReason;
      excluded: Exclusion[];
      entryId?: string;
    }
  /** The identical request is already stored; nothing is sent (§9). */
  | { phase: 'existing'; derivation: StoredDerivation; excluded: Exclusion[] }
  | { phase: 'consent'; request: PreparedRequest }
  | {
      phase: 'running';
      stage?: string;
      fraction?: number;
      counts: Partial<Record<OrganizeKind, number>>;
      cancelling: boolean;
    }
  | {
      phase: 'done';
      outcome: OrganizeOutcome;
      partials: number;
      ignoredPartials: number;
    };

export interface NodeRunReport {
  /** A completion came from the node: authenticated contact (UX §7.1). */
  nodeResult: boolean;
  failureCode?: string;
}

export interface OrganizeDependencies {
  gateway: Pick<HybridAiGateway, 'run' | 'cancel'>;
  derivations: DerivationRepository;
  loadEntry: (entryId: string) => Promise<JournalEntryDetail | null>;
  crypto: OrganizeCrypto;
  /** CSPRNG bytes as lower-case hex. */
  randomHex: (bytes: number) => string;
  now: () => number;
  /** Feeds the private-node status hooks, so link state stays truthful. */
  onNodeRun?: (report: NodeRunReport) => void;
  context?: { locale: string; timeZone: string };
}

type Terminal =
  | { type: 'completed'; output: unknown; target: 'local' | 'node' }
  | { type: 'failed'; code: string }
  | { type: 'cancelled' };

export class OrganizeController {
  private snapshot: OrganizeSnapshot = { phase: 'idle' };
  /** The entries the current snapshot is about; empty when idle. */
  scope: readonly string[] = [];
  private readonly listeners = new Set<() => void>();
  private pending?: { input: OrganizeInput; inputSha256: string };
  private requestId?: string;
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: OrganizeDependencies) {}

  getSnapshot = (): OrganizeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: OrganizeSnapshot) {
    if (this.disposed) {
      return;
    }
    this.snapshot = next;
    this.listeners.forEach(listener => listener());
  }

  /** Builds the request for whole entries and asks for consent (§2, §9). */
  async prepare(
    entryIds: readonly string[],
    kinds: readonly OrganizeKind[] = KINDS,
  ): Promise<void> {
    if (
      this.snapshot.phase === 'running' ||
      this.snapshot.phase === 'preparing'
    ) {
      return;
    }
    const generation = (this.generation += 1);
    this.pending = undefined;
    this.scope = [...entryIds];
    this.set({ phase: 'preparing' });
    try {
      const details: JournalEntryDetail[] = [];
      const missing: Exclusion[] = [];
      for (const entryId of entryIds) {
        const detail = await this.deps.loadEntry(entryId);
        if (detail) details.push(detail);
        else missing.push({ entryId, reason: 'not_ready' });
      }
      const keyHex = await this.deps.derivations.requestKeySecret(() =>
        this.deps.randomHex(32),
      );
      const built = buildOrganizeRequest({
        selection: details,
        keyHex,
        crypto: this.deps.crypto,
        kinds,
        context: this.deps.context,
      });
      if (generation !== this.generation) {
        return;
      }
      if (!built.ok) {
        this.set({
          phase: 'refused',
          reason: built.reason,
          excluded: [...missing, ...built.excluded],
          entryId: built.entryId,
        });
        return;
      }
      const excluded = [...missing, ...built.excluded];
      const existing = await this.deps.derivations.findByRequestKey(
        built.input.requestKey,
      );
      if (generation !== this.generation) {
        return;
      }
      if (existing) {
        this.set({ phase: 'existing', derivation: existing, excluded });
        return;
      }
      this.pending = { input: built.input, inputSha256: built.inputSha256 };
      this.set({
        phase: 'consent',
        request: {
          included: built.included,
          excluded,
          units: built.units,
          bytes: built.bytes,
          kinds: built.input.kinds,
        },
      });
    } catch {
      if (generation === this.generation) {
        this.set({
          phase: 'done',
          outcome: { kind: 'failed', code: 'STORAGE_FAILED' },
          partials: 0,
          ignoredPartials: 0,
        });
      }
    }
  }

  /** Sends the consented request through the SDK (§1: node only, 60 s). */
  async confirm(): Promise<void> {
    const pending = this.pending;
    if (this.snapshot.phase !== 'consent' || !pending) {
      return;
    }
    this.pending = undefined;
    const generation = (this.generation += 1);
    const requestId = `org-${this.deps.randomHex(8)}`;
    this.requestId = requestId;
    let terminal: Terminal | undefined;
    let partials = 0;
    let ignoredPartials = 0;
    let running: Extract<OrganizeSnapshot, { phase: 'running' }> = {
      phase: 'running',
      counts: {},
      cancelling: false,
    };
    this.set(running);
    const onUpdate = (update: CapabilityUpdate) => {
      // §4: events after the terminal are ignored.
      if (terminal || generation !== this.generation) {
        return;
      }
      switch (update.type) {
        case 'accepted':
          return;
        case 'progress':
          if (
            update.stage !== undefined &&
            STAGES.has(update.stage) &&
            (update.fraction === undefined ||
              (Number.isFinite(update.fraction) &&
                update.fraction >= 0 &&
                update.fraction <= 1))
          ) {
            running = {
              ...running,
              stage: update.stage,
              fraction: update.fraction,
            };
            this.set(running);
          }
          return;
        case 'partial':
          // Counts only, requested kinds only; never stored (§4).
          if (partialOk(update.delta, pending.input)) {
            partials += 1;
            running = { ...running, counts: { ...update.delta.counts } };
            this.set(running);
          } else {
            ignoredPartials += 1;
          }
          return;
        case 'completed':
          terminal = {
            type: 'completed',
            output: update.output,
            target: update.target,
          };
          return;
        case 'failed':
          terminal = { type: 'failed', code: update.failure.code };
          return;
        case 'cancelled':
          terminal = { type: 'cancelled' };
      }
    };
    try {
      await this.deps.gateway.run(
        {
          capability: CAPABILITY.id,
          version: CAPABILITY.version,
          input: pending.input,
          execution: 'node',
          timeoutMs: ORGANIZE_TIMEOUT_MS,
          requestId,
        },
        onUpdate,
      );
    } catch {
      terminal ??= { type: 'failed', code: 'EXECUTION_FAILED' };
    }
    if (this.requestId === requestId) {
      this.requestId = undefined;
    }
    const end: Terminal = terminal ?? {
      type: 'failed',
      code: 'EXECUTION_FAILED',
    };
    this.deps.onNodeRun?.({
      nodeResult: end.type === 'completed' && end.target === 'node',
      failureCode: end.type === 'failed' ? end.code : undefined,
    });
    if (this.disposed || generation !== this.generation) {
      return;
    }
    const outcome = await this.settle(end, pending);
    this.set({ phase: 'done', outcome, partials, ignoredPartials });
  }

  private async settle(
    end: Terminal,
    pending: { input: OrganizeInput; inputSha256: string },
  ): Promise<OrganizeOutcome> {
    if (end.type === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (end.type === 'failed') {
      return { kind: 'failed', code: end.code };
    }
    if (end.target !== 'node') {
      // Requested with execution 'node'; any other target is not this contract.
      return { kind: 'failed', code: 'EXECUTION_FAILED' };
    }
    const subCode = resultViolation(
      end.output,
      pending.input,
      pending.inputSha256,
    );
    if (subCode) {
      return { kind: 'invalid', subCode };
    }
    try {
      const { derivation, duplicate } =
        await this.deps.derivations.saveValidated({
          input: pending.input,
          inputSha256: pending.inputSha256,
          output: end.output as never,
          createdAt: this.deps.now(),
        });
      return duplicate
        ? { kind: 'duplicate', derivation }
        : { kind: 'stored', derivation };
    } catch {
      return { kind: 'failed', code: 'STORAGE_FAILED' };
    }
  }

  /** Cancels a run (the terminal arrives through the SDK) or drops consent. */
  cancel(): void {
    if (this.snapshot.phase === 'running' && this.requestId) {
      this.set({ ...this.snapshot, cancelling: true });
      this.deps.gateway.cancel(this.requestId);
    } else if (this.snapshot.phase !== 'running') {
      this.reset();
    }
  }

  reset(): void {
    if (this.snapshot.phase === 'running') {
      return;
    }
    this.generation += 1;
    this.pending = undefined;
    this.scope = [];
    this.set({ phase: 'idle' });
  }

  /** Locking unmounts the journal: a running organize is cancelled (§5). */
  dispose(): void {
    if (this.requestId) {
      this.deps.gateway.cancel(this.requestId);
    }
    this.disposed = true;
    this.listeners.clear();
  }
}
