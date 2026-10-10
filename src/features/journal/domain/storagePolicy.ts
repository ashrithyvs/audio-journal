// ADR-017 recording limits, in MiB as the ADR states. These are frozen policy
// values, not measured performance budgets.

const MIB = 1024 * 1024;

/** AJR1 payload: 16 kHz, mono, 16-bit PCM. */
export const PCM_BYTES_PER_SECOND = 16_000 * 2;

export const RECORDING_LIMITS = {
  maxDurationMs: 60 * 60 * 1000,
  minFreeBytesToStart: 200 * MIB,
  autoFinishBelowFreeBytes: 50 * MIB,
} as const;

export type CaptureLimit = 'duration_limit' | 'storage_low';

export function canStartRecording(freeBytes: number): boolean {
  return (
    Number.isFinite(freeBytes) &&
    freeBytes >= RECORDING_LIMITS.minFreeBytesToStart
  );
}

/** Which limit, if any, forces an automatic Finish. Storage wins ties. */
export function captureLimitReached(
  freeBytes: number,
  capturedMs: number,
): CaptureLimit | null {
  if (
    !Number.isFinite(freeBytes) ||
    freeBytes < RECORDING_LIMITS.autoFinishBelowFreeBytes
  ) {
    return 'storage_low';
  }
  if (capturedMs >= RECORDING_LIMITS.maxDurationMs) {
    return 'duration_limit';
  }
  return null;
}

/** Plaintext PCM bytes for a duration; used for archive and space checks. */
export function pcmBytesFor(durationMs: number): number {
  return Math.ceil((durationMs * PCM_BYTES_PER_SECOND) / 1000);
}
