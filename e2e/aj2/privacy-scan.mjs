#!/usr/bin/env node
// Privacy scan over a whole AJ-2 evidence run: every device log and companion
// log under the given directories must be free of the journal text the suites
// wrote, the test PIN, pairing payloads, and private keys. Each suite already
// scans its own logs; this checks the complete run, including a continuous
// logcat capture that no suite clears.
//
//   node e2e/aj2/privacy-scan.mjs <evidence-dir> [...]
import fs from 'node:fs';
import path from 'node:path';

import { PIN } from '../android/lib/app.mjs';

// Distinctive phrases written by the suites (functional, voice, Organized and
// Tasks, performance fixtures). Whole phrases: single words occur inside
// system identifiers.
const PHRASES = [
  'kestrel budget',
  'heron dentist',
  'plover trip',
  'lapwing report',
  'osprey morning',
  'birthday dinner',
  'fellow americans',
  'pay the rent',
  'water the plants',
  'call the plumber',
  'the invoice by friday',
  'book the hall',
  'project atlas',
  'onboarding slides',
  'car insurance',
  'arjun about the trip',
  'harbor launch',
  'quieter office layout',
  'weekly status email',
  'dry cleaning',
];
const PATTERNS = [
  ['test PIN', new RegExp(`(^|[^0-9])${PIN}([^0-9]|$)`)],
  ['pairing payload', /hybrid-ai-pair:/i],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const roots = process.argv.slice(2);
if (roots.length === 0) throw new Error('usage: privacy-scan.mjs <dir> [...]');
const files = [];
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.log$|^logcat.*\.txt$/.test(entry.name)) files.push(full);
  }
};
roots.forEach(walk);

let bytes = 0;
const findings = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  bytes += text.length;
  const lower = text.toLowerCase();
  for (const phrase of PHRASES) {
    if (lower.includes(phrase)) findings.push({ file, match: phrase });
  }
  for (const [label, pattern] of PATTERNS) {
    for (const line of text.split('\n')) {
      if (pattern.test(line))
        findings.push({ file, match: label, line: line.slice(0, 160) });
    }
  }
}
process.stdout.write(
  `${JSON.stringify(
    { files: files.length, bytes, phrases: PHRASES.length, findings },
    null,
    2,
  )}\n`,
);
process.exitCode = findings.length ? 1 : 0;
