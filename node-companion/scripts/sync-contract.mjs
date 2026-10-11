// Copies the pinned journal.organize@1 schemas from schemas/journal/v1 into
// contract/, so the companion can be deployed on its own. --check fails if a
// copy differs from the repository's source of truth or from the digest the
// vector manifest records.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '..', 'schemas', 'journal', 'v1');
const TARGET = join(HERE, '..', 'contract');
const FILES = [
  'organize-input.schema.json',
  'organize-output.schema.json',
  'organize-partial.schema.json',
];
const check = process.argv.includes('--check');
const manifest = JSON.parse(readFileSync(join(SOURCE, 'vectors.json'), 'utf8'));
let bad = 0;
mkdirSync(TARGET, { recursive: true });
for (const name of FILES) {
  const source = readFileSync(join(SOURCE, name));
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== manifest.files[name]) {
    bad += 1;
    process.stdout.write(`manifest digest differs: ${name}\n`);
  }
  if (check) {
    let copy = Buffer.alloc(0);
    try {
      copy = readFileSync(join(TARGET, name));
    } catch {
      // missing
    }
    if (!copy.equals(source)) {
      bad += 1;
      process.stdout.write(`out of date: contract/${name}\n`);
    }
  } else {
    writeFileSync(join(TARGET, name), source);
  }
}
process.stdout.write(
  `${check ? 'checked' : 'synced'} ${
    FILES.length
  } schema files, ${bad} problems\n`,
);
if (bad) process.exitCode = 1;
