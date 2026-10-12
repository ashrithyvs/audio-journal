#!/usr/bin/env node
// Privacy scan over AJ-2 evidence: every log, console summary, boot log, and
// logcat capture under the given roots must be free of the journal text the
// suites wrote, the test PIN, pairing payloads, and private keys. Each suite
// already scans its own logs; this checks whole runs.
//
// Before scanning, a self-test plants one line per rule in a temporary log,
// scans it with the same code, requires every rule to fire, and removes it.
// The output records the canonical roots and every file scanned, so the
// counts are reproducible.
//
//   node e2e/aj2/privacy-scan.mjs <evidence-root> [...] > result.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PIN } from '../android/lib/app.mjs';

// Distinctive phrases written by the suites: functional (organize-e2e),
// voice, Organized and Tasks, the API 26/28 smoke, and the performance
// fixtures. Whole phrases, matched case-insensitively: single words occur
// inside system identifiers.
const PHRASES = [
  'kestrel budget',
  'kestrel team',
  'heron dentist',
  'plover trip',
  'lapwing report',
  'osprey morning',
  'birthday dinner',
  'fellow americans',
  'pay the rent',
  'call the bank tomorrow',
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
  'weekend reading club for the neighbourhood',
  'dry cleaning',
];
// Bounded or structural rules.
const PATTERNS = [
  // A fixture name, as a whole word with its capital.
  ['fixture name Priya', /\bPriya\b/],
  // organize-e2e's generated over-cap filler (`longParagraph`).
  [
    'over-cap filler',
    /Entry \w+ line \d+ records an ordinary detail of the day/i,
  ],
  ['test PIN', new RegExp(`(^|[^0-9])${PIN}([^0-9]|$)`)],
  ['pairing payload', /hybrid-ai-pair:/i],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const SCANNED = /\.log$|^logcat.*\.txt$/;
// Host-side harness console summaries can quote on-screen text in their own
// failure messages (test-tool output). They are scanned and reported, but
// kept apart from app, device, companion, and boot logs.
const kindOf = file =>
  file.endsWith('.console.log') ? 'harness-console' : 'device-node-boot';

function listFiles(roots) {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SCANNED.test(entry.name)) files.push(full);
    }
  };
  roots.forEach(walk);
  return files.sort();
}

function scan(roots) {
  const files = listFiles(roots);
  let bytes = 0;
  const findings = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    bytes += Buffer.byteLength(text);
    const lower = text.toLowerCase();
    for (const phrase of PHRASES) {
      if (lower.includes(phrase))
        findings.push({ file, kind: kindOf(file), match: phrase });
    }
    for (const [label, pattern] of PATTERNS) {
      for (const line of text.split('\n')) {
        if (pattern.test(line))
          findings.push({
            file,
            kind: kindOf(file),
            match: label,
            line: line.slice(0, 160),
          });
      }
    }
  }
  return { files, bytes, findings };
}

/** Plants one line per rule, requires each to be found, then cleans up. */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aj2-privacy-selftest-'));
  try {
    const lines = [
      ...PHRASES.map(p => `ReactNativeJS: ${p.toUpperCase()}`),
      'I need to send the budget to Priya by Friday.',
      'Entry plover line 17 records an ordinary detail of the day.',
      `unlock with ${PIN} now`,
      'clip hybrid-ai-pair:AAAA',
      '-----BEGIN EC PRIVATE KEY-----',
    ];
    fs.writeFileSync(path.join(dir, 'planted.log'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'clean.log'), 'Priyanka privacy 4829150\n');
    const { findings } = scan([dir]);
    const found = new Set(findings.map(f => f.match));
    const rules = [...PHRASES, ...PATTERNS.map(([label]) => label)];
    const missed = rules.filter(rule => !found.has(rule));
    const falsePositives = findings.filter(f => f.file.endsWith('clean.log'));
    fs.rmSync(dir, { recursive: true, force: true });
    const plantedRemoved = !fs.existsSync(dir);
    return {
      passed:
        missed.length === 0 && falsePositives.length === 0 && plantedRemoved,
      rules: rules.length,
      missed,
      falsePositives: falsePositives.length,
      plantedRemoved,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const roots = process.argv.slice(2).map(root => fs.realpathSync(root));
if (roots.length === 0) throw new Error('usage: privacy-scan.mjs <dir> [...]');
const test = selfTest();
const result = test.passed
  ? scan(roots)
  : { files: [], bytes: 0, findings: [] };
process.stdout.write(
  `${JSON.stringify(
    {
      scannedAt: new Date().toISOString(),
      roots,
      selfTest: test,
      rules: { phrases: PHRASES.length, patterns: PATTERNS.length },
      fileCount: result.files.length,
      filesByKind: {
        'device-node-boot': result.files.filter(
          f => kindOf(f) === 'device-node-boot',
        ).length,
        'harness-console': result.files.filter(
          f => kindOf(f) === 'harness-console',
        ).length,
      },
      bytes: result.bytes,
      findingsByKind: {
        'device-node-boot': result.findings.filter(
          f => f.kind === 'device-node-boot',
        ).length,
        'harness-console': result.findings.filter(
          f => f.kind === 'harness-console',
        ).length,
      },
      findings: result.findings,
      files: result.files,
    },
    null,
    2,
  )}\n`,
);
process.exitCode = test.passed && result.findings.length === 0 ? 0 : 1;
