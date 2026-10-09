// Audio Journal navigation helpers shared by the Android device suites.
import * as d from './device.mjs';

export const PIN = '482915';

export async function setupPin() {
  await d.typeInto({ id: 'pin' }, PIN);
  await d.typeInto({ id: 'pin-confirmation' }, PIN);
  await d.hideKeyboard();
  await d.tap({ text: 'Protect my journal' });
  await d.waitFor({ text: 'Settings' });
}

export async function unlockIfNeeded() {
  d.ensureForeground();
  const { selector } = await d.waitForAny([
    { id: 'unlock-pin' },
    { id: 'pin' },
    { text: 'Settings' },
  ]);
  if (selector.id === 'unlock-pin') {
    await d.typeInto({ id: 'unlock-pin' }, PIN);
    await d.hideKeyboard();
    await d.tap({ text: 'Unlock' });
    await d.waitFor({ text: 'Settings' });
  } else if (selector.id === 'pin') {
    await setupPin();
  }
}

export async function openSettingsHome() {
  await unlockIfNeeded();
  await d.tap({ text: 'Settings' });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (d.find(d.dump(), { id: 'open-private-node' })) return;
    d.back();
    await d.sleep(500);
    await d.tap({ text: 'Settings' });
  }
  await d.waitFor({ id: 'open-private-node' });
}

export async function openLoadLab() {
  if (d.find(d.dump(), { id: 'load-status' })) return;
  await openSettingsHome();
  await d.tap({ id: 'open-diagnostics' });
  await d.tap({ id: 'open-load-lab' });
  await d.waitFor({ id: 'load-status' });
}

export async function pairWithNode(node, { lifetimeSeconds = 300 } = {}) {
  await openSettingsHome();
  await d.tap({ id: 'open-private-node' });
  await d.waitFor({ id: 'node-status-card' });
  const pairButton = d.find(d.dump(), { id: 'pair-node' })
    ? { id: 'pair-node' }
    : { text: 'Pair another node' };
  await d.tap(pairButton);
  const { qr } = await node.bootstrap(lifetimeSeconds);
  await d.typeInto({ id: 'pairing-code-input' }, qr);
  d.shell('input', 'keyevent', 'KEYCODE_ENTER');
  await d.tap({ id: 'begin-pairing' });
  await d.waitFor({ id: 'verification-code' }, { timeoutMs: 30_000 });
  const appCode = d.textOf({ id: 'verification-code' });
  const pending = await node.pending();
  if (!pending || pending.verificationCode !== appCode) {
    throw new Error(
      `verification codes differ: app ${appCode} node ${pending?.verificationCode}`,
    );
  }
  await node.approve();
  await d.tap({ id: 'confirm-code' });
  await d.waitFor({ id: 'pairing-done' }, { timeoutMs: 30_000 });
  await d.tap({ id: 'pairing-done' });
}
