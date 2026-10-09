export interface PinValidation {
  valid: boolean;
  message?: string;
}

// This validates only the AJ-0 interaction contract. KDF, throttling and the
// final credential policy remain blocked on the security ADR.
export function validateScaffoldPin(pin: string): PinValidation {
  if (!/^\d{6,12}$/.test(pin)) {
    return { valid: false, message: 'Use 6 to 12 digits.' };
  }
  return { valid: true };
}
