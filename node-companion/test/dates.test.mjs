// Due dates (contract §3.3, amendment A2): the companion's derivation against
// every hand-written vector, and the engine's conservative choice of phrase.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveDue, findDue } from '../src/dates.mjs';

const cases = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'schemas',
      'journal',
      'v1',
      'vectors',
      'due-dates.json',
    ),
    'utf8',
  ),
);

test('every due-date vector reaches its literal expectation', () => {
  assert.ok(cases.length >= 60);
  for (const c of cases) {
    const got = deriveDue(
      c.text,
      c.charStart,
      c.charEnd,
      c.createdAt,
      c.timeZone,
    );
    assert.deepEqual(
      got,
      c.expect.valid ? { date: c.expect.date, rule: c.expect.rule } : null,
      c.name,
    );
  }
});

test('the engine dates a sentence only with exactly one accepted phrase', () => {
  const at = '2026-10-17T08:00:00.000Z'; // Saturday in UTC
  const due = text => findDue(text, 0, text.length, at, 'UTC');
  assert.deepEqual(due('Send the invoice by Friday.'), {
    date: '2026-10-23',
    rule: 'due.weekday',
    start: 20,
    end: 26,
  });
  for (const text of [
    'Plan the review for next Friday.', // qualified
    'Call Priya on Monday or Tuesday.', // two dates
    'Pay rent on Friday at 5pm.', // a time as well
    'I may call the bank tomorrow.', // "may" is also a month word
    'Renew the permit on 14/10.', // numeric
    'Finish it this weekend.', // not an accepted phrase
  ])
    assert.equal(due(text), null, text);
});
