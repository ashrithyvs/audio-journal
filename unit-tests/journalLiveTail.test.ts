import { liveTail } from '../src/features/journal/domain/format';

// UX §5: the recording screen shows only the latest live words.

it('keeps short live text whole', () => {
  expect(liveTail('Dear diary, today')).toBe('Dear diary, today');
  expect(liveTail('x'.repeat(200))).toBe('x'.repeat(200));
});

it('shows the end of long live text, cut at a word, after an ellipsis', () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const tail = liveTail(words);
  expect(tail.startsWith('…')).toBe(true);
  expect(tail.length).toBeLessThanOrEqual(201);
  expect(tail.endsWith('word79')).toBe(true);
  expect(tail.slice(1)).toMatch(/^word\d+ /);
  expect(words.endsWith(tail.slice(1))).toBe(true);
});

it('falls back to a hard cut when there is no space', () => {
  expect(liveTail('y'.repeat(500), 10)).toBe(`…${'y'.repeat(10)}`);
});
