// Node names come from QR codes and LAN announcements. They are shown as
// untrusted data: control and bidi-override characters are removed, length is
// bounded, and the result is wrapped in a first-strong isolate so it cannot
// reorder surrounding text (SDK LLD §8.7 host guidance).

const FSI = '⁨';
const PDI = '⁩';
// C0/C1 controls, bidi embeddings/overrides/isolates, and zero-width marks.
// eslint-disable-next-line no-control-regex -- removing controls is the point.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁯﻿]/g;
const MAX_LENGTH = 48;

export function displayUntrustedName(name: string): string {
  const cleaned = name.replace(UNSAFE, '').trim();
  const bounded =
    cleaned.length > MAX_LENGTH
      ? `${cleaned.slice(0, MAX_LENGTH - 1)}…`
      : cleaned;
  return `${FSI}${bounded || 'Unnamed node'}${PDI}`;
}

/** Short non-secret node reference for diagnostics and spoof comparison. */
export function shortNodeId(nodeId: string): string {
  return nodeId.slice(0, 8);
}
