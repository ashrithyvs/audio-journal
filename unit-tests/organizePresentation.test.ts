import type { OrganizeOutput } from '../src/features/organize/domain/contract';
import { omissionNotice } from '../src/features/organize/domain/presentation';

// Contract §3.2: a partial result is always disclosed, with its counts.

const base = {
  contract: 'journal.organize@1',
  requestKey: `org_${'0'.repeat(26)}`,
  inputSha256: '0'.repeat(64),
  engine: { id: 'aj.rules', version: '1.0.0' },
} as const;

it('says nothing about a complete result', () => {
  expect(omissionNotice({ ...base, completeness: 'complete' })).toBeUndefined();
});

it('names every omitted kind with its count', () => {
  const output: OrganizeOutput = {
    ...base,
    completeness: 'partial',
    omitted: { projects: 1, tasks: 3, sections: 2, ideas: 1 },
  };
  expect(omissionNotice(output)).toBe(
    'This result is partial. Some lower-ranked items were omitted to fit: ' +
      '2 Work or Personal items, 3 tasks, 1 idea, 1 project.',
  );
});
