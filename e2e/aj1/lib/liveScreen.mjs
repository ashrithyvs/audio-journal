// AJ-1 selectors for screens that never idle. The shared driver's dump()
// waits for a second with no accessibility events, so a recording timer or a
// playback position that ticks every second hides the whole screen from it.
// These helpers read the hierarchy through tools/LiveDump.java instead, and
// reuse the shared driver's selector matching. The tool is built from source
// on first use (JDK 17 javac and the SDK's d8) into the OS temp directory.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adb,
  describe,
  find,
  screenSummary,
  shell,
  sleep,
} from '../../android/lib/device.mjs';

const SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tools',
  'LiveDump.java',
);
const DEVICE_JAR = '/data/local/tmp/aj1-livedump.jar';
let pushed = false;

function sdk() {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!home) throw new Error('ANDROID_HOME is not set');
  const highest = list =>
    list.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  const platform = highest(
    readdirSync(join(home, 'platforms')).filter(name =>
      existsSync(join(home, 'platforms', name, 'android.jar')),
    ),
  );
  const tools = highest(readdirSync(join(home, 'build-tools')));
  return {
    androidJar: join(home, 'platforms', platform, 'android.jar'),
    d8: join(home, 'build-tools', tools, 'd8'),
  };
}

function build() {
  const source = readFileSync(SOURCE);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `aj1-livedump-${hash}`);
  const jar = join(dir, 'livedump.jar');
  if (existsSync(jar)) return jar;
  const { androidJar, d8 } = sdk();
  const javaBin = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin')
    : undefined;
  const javac = javaBin ? join(javaBin, 'javac') : 'javac';
  // d8 is a shell wrapper that runs `java` from PATH.
  const quiet = {
    stdio: 'pipe',
    env: javaBin
      ? { ...process.env, PATH: `${javaBin}:${process.env.PATH}` }
      : process.env,
  };
  mkdirSync(join(dir, 'classes'), { recursive: true });
  execFileSync(
    javac,
    [
      '-source',
      '8',
      '-target',
      '8',
      '-nowarn',
      '-Xlint:-options',
      '-cp',
      androidJar,
      '-d',
      join(dir, 'classes'),
      SOURCE,
    ],
    quiet,
  );
  execFileSync(
    d8,
    [
      '--min-api',
      '26',
      '--lib',
      androidJar,
      '--output',
      jar,
      join(dir, 'classes', 'LiveDump.class'),
    ],
    quiet,
  );
  return jar;
}

function decode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** The foreground window's nodes, in the shared driver's shape. */
export function liveDump() {
  if (!pushed) {
    adb('push', build(), DEVICE_JAR);
    pushed = true;
  }
  let xml = '';
  try {
    xml = adb(
      'exec-out',
      `CLASSPATH=${DEVICE_JAR} app_process /system/bin LiveDump`,
    );
  } catch {
    return [];
  }
  const nodes = [];
  for (const match of xml.matchAll(/<node ([^>]*?)>/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = decode(attr[2]);
    }
    const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(
      attrs.bounds ?? '',
    );
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

export async function liveWaitForAny(selectors, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let nodes = [];
  while (Date.now() < deadline) {
    nodes = liveDump();
    for (const selector of selectors) {
      const node = find(nodes, selector);
      if (node) return { selector, node };
    }
    await sleep(300);
  }
  throw new Error(
    `none found: ${selectors
      .map(describe)
      .join(', ')}\non screen: ${screenSummary(nodes)}`,
  );
}

export async function liveWaitFor(selector, options) {
  return (await liveWaitForAny([selector], options)).node;
}

export async function liveTap(selector, options) {
  const node = await liveWaitFor(selector, options);
  if (!node.enabled) throw new Error(`disabled: ${describe(selector)}`);
  const [x1, y1, x2, y2] = node.bounds;
  shell(
    'input',
    'tap',
    String(Math.round((x1 + x2) / 2)),
    String(Math.round((y1 + y2) / 2)),
  );
  await sleep(300);
}

export function liveTextOf(selector) {
  return find(liveDump(), selector)?.text;
}

/**
 * Waits for the open entry's final pass to settle. The transcript section
 * names its kind; a live draft ("provisional") is not a result.
 */
export async function waitForFinalPass({ timeoutMs = 300_000 } = {}) {
  const { selector } = await liveWaitForAny(
    [
      { id: 'transcript-kind-final' },
      { id: 'transcript-kind-empty' },
      { id: 'transcript-failed' },
    ],
    { timeoutMs },
  );
  return selector.id.replace(/^transcript-(kind-)?/, '');
}
