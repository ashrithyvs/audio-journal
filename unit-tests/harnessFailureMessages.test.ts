import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Device-harness failure messages must not carry on-screen text, which can be
// journal content: they reach console logs and reports. They name element IDs
// through `screenSummary` instead. (A superseded AJ-2.1 run quoted screen text
// in a failure message; see AJ-2 progress §10.1.)

const root = path.join(__dirname, '..');
const harnessFiles = (() => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'build') walk(full);
      } else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  walk(path.join(root, 'e2e'));
  return files;
})();

it('interpolates no screen text into any harness string', () => {
  expect(harnessFiles.length).toBeGreaterThan(10);
  // `${…}` holding a UI snapshot, visible text, or a node text list.
  const forbidden =
    /\$\{[^}]*(snapshot\(|visibleText\(|\.ui\b|consentText|\.map\(\s*\w+\s*=>\s*\w+\.text\))/;
  const offenders: string[] = [];
  for (const file of harnessFiles) {
    const text = fs.readFileSync(file, 'utf8');
    if (
      forbidden.test(text.replace(/\n\s*/g, ' ')) ||
      /visible: \$\{/.test(text)
    ) {
      offenders.push(path.relative(root, file));
    }
  }
  expect(offenders).toEqual([]);
});

it('summarizes the screen by element IDs and withholds every text', () => {
  const script = `
    import { screenSummary } from './e2e/android/lib/device.mjs';
    process.stdout.write(screenSummary([
      { id: 'com.audiojournal:id/organize-refused', text: '' },
      { id: '', text: 'I need to send the kestrel budget to Priya by Friday.' },
      { id: 'com.audiojournal:id/entry-text', text: 'Water the plants.' },
    ]));`;
  const summary = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ANDROID_SERIAL: 'none' },
    },
  );
  expect(summary).toBe(
    'ids organize-refused, entry-text; 2 text nodes withheld',
  );
  expect(summary).not.toMatch(/kestrel|Priya|plants/i);
});
