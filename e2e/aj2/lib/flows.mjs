// Audio Journal organize flows shared by the AJ-2 device suites: write an
// entry, run organize through the consent sheet, and read the outcome.
import { performance } from 'node:perf_hooks';

import { openSettingsHome, unlockIfNeeded } from '../../android/lib/app.mjs';
import * as d from '../../android/lib/device.mjs';

/** Writes an entry through the Write screen and opens its detail. */
export async function writeEntry({ title, text }) {
  await unlockIfNeeded();
  // Switching tabs returns to the Diary stack as it was left (often an
  // entry); tapping the focused tab again pops it to the timeline.
  await d.tap({ text: 'Diary' });
  for (let i = 0; i < 3 && !d.find(d.dump(), { id: 'diary-write' }); i += 1) {
    await d.tap({ text: 'Diary' });
    await d.sleep(500);
  }
  await d.tap({ id: 'diary-write' });
  await d.waitFor({ id: 'write-text' });
  if (title) await d.typeInto({ id: 'write-title' }, title);
  if (!(await d.pasteInto({ id: 'write-text' }, text))) {
    throw new Error(`entry text did not paste (${text.length} chars)`);
  }
  await d.hideKeyboard();
  await d.tap({ id: 'write-save' });
  await d.waitFor({ id: 'entry-detail' }, { timeoutMs: 30_000 });
  await reachPanel();
}

/**
 * Brings the Organize panel, which ends the entry page, on screen. A long
 * entry is many screens tall, so this flings rather than steps.
 */
export async function reachPanel() {
  for (let fling = 0; fling < 80; fling += 1) {
    const nodes = d.dump();
    const panel =
      d.find(nodes, { id: 'organize-start' }) ??
      d.find(nodes, { id: 'organize-done' });
    if (panel) return;
    d.shell('input', 'swipe', '540', '1900', '540', '300', '60');
    await d.sleep(250);
  }
  throw new Error('the Organize panel was not reached');
}

const OUTCOMES = [
  'organize-stored',
  'organize-duplicate',
  'organize-existing',
  'organize-invalid',
  'organize-failed',
  'organize-cancelled',
  'organize-refused',
];

async function outcome(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const nodes = d.dump();
    const found = OUTCOMES.find(id => d.find(nodes, { id }));
    if (found) return found.replace('organize-', '');
    if (!d.find(nodes, { id: 'organize-running' })) {
      // Off-screen nodes are absent from the hierarchy: the outcome may be
      // just below the fold, where the panel ends the page.
      d.shell('input', 'swipe', '540', '1500', '540', '900', '300');
    }
    await d.sleep(500);
  }
  throw new Error('no organize outcome');
}

/** Starts an organize on the open entry and answers the consent sheet. */
export async function organize({ consent = 'confirm', onRunning } = {}) {
  await reachPanel();
  await d.tap({ id: 'organize-start' });
  const { selector } = await d.waitForAny(
    [
      { id: 'organize-consent' },
      { id: 'organize-existing' },
      { id: 'organize-refused' },
    ],
    { timeoutMs: 30_000 },
  );
  if (selector.id !== 'organize-consent')
    return { result: selector.id.replace('organize-', '') };
  const consentText = d.snapshot();
  if (consent === 'decline') {
    await d.tap({ id: 'organize-decline' });
    return { result: 'declined', consentText };
  }
  const started = performance.now();
  await d.tap({ id: 'organize-confirm' });
  if (onRunning) {
    await d.findScrolling({ id: 'organize-running' }, { timeoutMs: 30_000 });
    await onRunning();
  }
  const result = await outcome();
  return {
    result,
    consentText,
    ms: Math.round(performance.now() - started),
    ui: d.snapshot(),
  };
}

export async function done() {
  await d.tap({ id: 'organize-done' });
}

export async function connectionLabel() {
  await openSettingsHome();
  await d.tap({ id: 'open-private-node' });
  await d.waitFor({ id: 'node-status-card' });
  await d.scrollToTop();
  return d.snapshot();
}
