// Pins the aj.rules engine's output for every contract fixture
// (test/golden/engine.json). --check rebuilds and compares byte for byte, so
// any change in engine behaviour is deliberate and reviewed.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE, organize } from '../src/engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(
    join(
      HERE,
      '..',
      '..',
      'schemas',
      'journal',
      'v1',
      'vectors',
      'fixtures.json',
    ),
    'utf8',
  ),
);
const golden = {
  engine: ENGINE,
  cases: Object.entries(fixtures).map(([fixture, input]) => ({
    fixture,
    result: organize(input),
  })),
};
const text = `${JSON.stringify(golden, null, 2)}\n`;
const file = join(HERE, '..', 'test', 'golden', 'engine.json');
if (process.argv.includes('--check')) {
  const same = readFileSync(file, 'utf8') === text;
  process.stdout.write(
    `engine golden: ${golden.cases.length} fixtures, ${
      same ? 'unchanged' : 'CHANGED'
    }\n`,
  );
  if (!same) process.exitCode = 1;
} else {
  writeFileSync(file, text);
  process.stdout.write(
    `engine golden: wrote ${golden.cases.length} fixtures\n`,
  );
}
