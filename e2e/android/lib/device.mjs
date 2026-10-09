// Minimal deterministic Android driver over adb + uiautomator. No third-party
// framework: selectors are React Native testIDs (exposed as resource-id) or
// exact visible text. FLAG_SECURE blocks screenshots, so evidence is the UI
// hierarchy text, which this module can also save.
import { execFileSync } from 'node:child_process';

export const PACKAGE = 'com.audiojournal';

export function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
}

export function shell(...args) {
  return adb('shell', ...args);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export { sleep };

function decode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

export function dump() {
  let xml = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      shell('rm', '-f', '/sdcard/aj-ui.xml');
      // A blinking cursor or spinner keeps the UI from idling; uiautomator then
      // may write nothing. Retry until a hierarchy with app content appears.
      shell('uiautomator', 'dump', '/sdcard/aj-ui.xml');
      xml = shell('cat', '/sdcard/aj-ui.xml');
      if (xml.includes('<hierarchy') && xml.includes('android:id/content'))
        break;
    } catch {
      xml = '';
    }
  }
  const nodes = [];
  for (const match of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = decode(attr[2]);
    }
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    nodes.push({
      text: attrs.text ?? '',
      id: attrs['resource-id'] ?? '',
      desc: attrs['content-desc'] ?? '',
      enabled: attrs.enabled !== 'false',
      checked: attrs.checked === 'true',
      bounds: bounds ? bounds.slice(1).map(Number) : undefined,
    });
  }
  return nodes;
}

function matches(node, selector) {
  if (selector.id !== undefined && node.id !== selector.id) return false;
  if (selector.text !== undefined && node.text !== selector.text) return false;
  if (selector.textMatches && !selector.textMatches.test(node.text))
    return false;
  if (selector.desc !== undefined && node.desc !== selector.desc) return false;
  return true;
}

export function describe(selector) {
  return JSON.stringify(selector, (_k, v) =>
    v instanceof RegExp ? String(v) : v,
  );
}

export function find(nodes, selector) {
  return nodes.find(node => matches(node, selector) && node.bounds);
}

export async function waitFor(
  selector,
  { timeoutMs = 20_000, absent = false } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let nodes = [];
  while (Date.now() < deadline) {
    nodes = dump();
    const node = find(nodes, selector);
    if (absent ? !node : node) return node ?? true;
    await sleep(400);
  }
  const visible = nodes
    .map(node => node.text)
    .filter(Boolean)
    .join(' | ');
  throw new Error(
    `${absent ? 'still present' : 'not found'}: ${describe(
      selector,
    )}\nvisible: ${visible}`,
  );
}

export async function waitForAny(selectors, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let nodes = [];
  while (Date.now() < deadline) {
    nodes = dump();
    for (const selector of selectors) {
      const node = find(nodes, selector);
      if (node) return { selector, node };
    }
    await sleep(400);
  }
  throw new Error(
    `none found: ${selectors.map(describe).join(', ')}\nvisible: ${nodes
      .map(node => node.text)
      .filter(Boolean)
      .join(' | ')}`,
  );
}

function center(node) {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

let screenHeight;
function displayHeight() {
  screenHeight ??= Number(/x(\d+)\s*$/.exec(shell('wm', 'size').trim())[1]);
  return screenHeight;
}

export async function scrollTo(selector, { maxSwipes = 10 } = {}) {
  const height = displayHeight();
  const [low, high] = [height * 0.3, height * 0.7].map(Math.round);
  for (let swipe = 0; swipe <= maxSwipes; swipe += 1) {
    const nodes = dump();
    if (nodes.length === 0) {
      await sleep(300);
      continue;
    }
    const node = find(nodes, selector);
    if (node) {
      const [, y1, , y2] = node.bounds;
      if (y2 > y1 && y1 >= 0 && y2 <= height) return node;
      const up = y1 < 0;
      shell(
        'input',
        'swipe',
        '540',
        String(up ? low : high),
        '540',
        String(up ? high : low),
        '300',
      );
    } else {
      shell('input', 'swipe', '540', String(high), '540', String(low), '300');
    }
    await sleep(500);
  }
  throw new Error(`could not scroll to ${describe(selector)}`);
}

export async function tap(selector, { timeoutMs = 20_000 } = {}) {
  // The target may be rendered off-screen in a ScrollView: scroll as we wait.
  const deadline = Date.now() + timeoutMs;
  let node;
  while (!node) {
    try {
      node = await scrollTo(selector, { maxSwipes: 4 });
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `not found: ${describe(selector)}\nvisible: ${visibleText().join(
            ' | ',
          )}`,
        );
      }
      await sleep(400);
    }
  }
  const [x, y] = center(node);
  shell('input', 'tap', String(x), String(y));
  await sleep(300);
}

export async function typeInto(selector, value) {
  await tap(selector);
  // `input text` needs spaces escaped; pairing codes are URL-safe base64.
  const chunks = value.match(/.{1,80}/g) ?? [];
  for (const chunk of chunks) {
    shell(
      'input',
      'text',
      `'${chunk.replace(/ /g, '%s').replace(/'/g, "'\\''")}'`,
    );
  }
  // Injected key events are asynchronous; wait until the field holds the value.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const node = find(dump(), selector);
    if (node && (node.text === value || node.text.length >= value.length))
      return;
    await sleep(300);
  }
  throw new Error(`text did not settle in ${describe(selector)}`);
}

export async function clearField(selector) {
  await tap(selector);
  shell('input', 'keyevent', 'KEYCODE_MOVE_END');
  for (let index = 0; index < 4; index += 1) {
    shell('input', 'keyevent', ...Array(80).fill('KEYCODE_DEL'));
  }
}

export function textOf(selector) {
  return find(dump(), selector)?.text;
}

export function visibleText() {
  return dump()
    .map(node => node.text)
    .filter(Boolean);
}

export function back() {
  shell('input', 'keyevent', 'KEYCODE_BACK');
}

export async function hideKeyboard() {
  // ESCAPE closes the IME without navigating back; wait for relayout.
  shell('input', 'keyevent', 'KEYCODE_ESCAPE');
  await sleep(800);
}

export function launch() {
  const output = shell('am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`);
  return Number(/TotalTime: (\d+)/.exec(output)?.[1] ?? NaN);
}

export function forceStop() {
  shell('am', 'force-stop', PACKAGE);
}

export function home() {
  shell('input', 'keyevent', 'KEYCODE_HOME');
}

export function apiLevel() {
  return Number(shell('getprop', 'ro.build.version.sdk').trim());
}

export function count(selector) {
  return dump().filter(node => matches(node, selector)).length;
}

export const NSD_FIXTURE = 'com.audiojournal.e2e.nsd';

/** Advertises test services via the external NSD fixture (public NsdManager). */
export function advertise(services) {
  const spec = services
    .map(
      ({ name, nodeId, port, txtvers = '1' }) =>
        `${name}|${nodeId}|${port}|${txtvers}`,
    )
    .join(';');
  shell(
    `am start -n ${NSD_FIXTURE}/.AdvertiseActivity --es services '${spec}'`,
  );
}

export function stopAdvertising() {
  shell(`am start -n ${NSD_FIXTURE}/.AdvertiseActivity --ez stop true`);
}

/** Text of every visible node, for evidence logs (FLAG_SECURE blocks screenshots). */
export function snapshot() {
  return visibleText()
    .filter(text => text !== '⏷')
    .join(' | ');
}

/** Scrolls until the node is on screen and returns its text, or undefined. */
export async function readText(selector, { maxSwipes = 6 } = {}) {
  try {
    return (await scrollTo(selector, { maxSwipes })).text;
  } catch {
    return undefined;
  }
}

export async function scrollToTop() {
  const height = displayHeight();
  for (let swipe = 0; swipe < 4; swipe += 1) {
    shell(
      'input',
      'swipe',
      '540',
      String(Math.round(height * 0.3)),
      '540',
      String(Math.round(height * 0.8)),
      '150',
    );
  }
  await sleep(400);
}

export function inForeground() {
  return (
    shell('dumpsys', 'window').includes(`mCurrentFocus=Window{`) &&
    /mCurrentFocus=Window\{[^}]*com\.audiojournal\//.test(
      shell('dumpsys', 'window'),
    )
  );
}

export function ensureForeground() {
  if (!inForeground()) launch();
}

/**
 * The AOSP keyboard asks for contacts access the first time a multiline field
 * is focused, covering the app. Deny it once, permanently, on the emulator.
 */
export function quietKeyboard() {
  for (const ime of ['com.android.inputmethod.latin']) {
    try {
      shell('pm', 'revoke', ime, 'android.permission.READ_CONTACTS');
      shell(
        'pm',
        'set-permission-flags',
        ime,
        'android.permission.READ_CONTACTS',
        'user-fixed',
      );
    } catch {
      // keyboard not installed on this image
    }
  }
}
